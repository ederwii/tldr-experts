/**
 * Which epic branch this run owns, and the two refusals that protect the tree it
 * is cut from.
 */
import type { WorkspaceContext } from "../../hooks/lib/workspace.ts";
import {
  branchModelFor, branchModelOfKind, detectEpicChain, epicBranchOf,
  type BranchModel, type BranchModelKind,
} from "../plan/branchModel.ts";
import { RunStore } from "../run/RunStore.ts";
import {
  branchExists, currentBranch, dirtyEntries, operationInProgress, repoDirOf, stateDirPrefixes,
} from "./git.ts";
import {
  classifyDirty, namePaths, NAMED_PATHS, shellQuote, stashCommand, submodulePaths,
} from "./foreignWork.ts";
import type { NextMode } from "../facilitator/runNext.ts";
import type { EpicSummaryRow } from "./handoff.ts";
import type { BuildRefusal, StoryOutcome } from "./outcome.ts";
import type { PlannedEpic, PlannedStory } from "./plan.ts";
import type { EpicState } from "./worktrees.ts";

/** What `build/branchClaims.ts` needs to claim, refuse or report an epic branch. */
export interface ClaimParts {
  readonly runId: string;
  readonly runDir: string;
  readonly root: string;
  readonly workspace: WorkspaceContext;
  readonly epics: ReadonlyMap<string, PlannedEpic>;
  readonly branchModel: BranchModel;
  readonly reuseEpic: boolean;
  readonly lines: string[];
}

/** `run.yml`'s whole `build:` block, or an empty one when the file will not open. */
export function buildOnFile(
  runDir: string,
): { epic_branch: readonly string[]; branch_model?: BranchModelKind } {
  try {
    return RunStore.open(runDir).run.build ?? { epic_branch: [] };
  } catch {
    return { epic_branch: [] };
  }
}

/**
 * One branch per epic, or ONE for the run — issue #57, owner decision (a).
 *
 * The chain is read from the SAME story front matter `validatePlan` reads, so
 * the branch the Plan gate announced is the branch this cuts. What can override
 * it is the run's own history, and only in the safe direction: a run that has
 * already recorded a model keeps it, and a run that cut branches before the key
 * existed is treated as `per-epic` rather than re-pointed at a branch that was
 * never cut.
 */
export function resolveBranchModel(
  runDir: string,
  runId: string,
  stories: ReadonlyMap<string, PlannedStory>,
): BranchModel {
  const epicOf = new Map<string, string>();
  const dependsOn = new Map<string, readonly string[]>();
  for (const [id, planned] of stories) {
    epicOf.set(id, planned.story.epic);
    dependsOn.set(id, planned.story.depends_on);
  }
  const chain = detectEpicChain(epicOf, dependsOn);
  const fromPlan = branchModelFor(runId, chain);

  const onFile = buildOnFile(runDir);
  if (onFile.branch_model !== undefined) {
    return { ...branchModelOfKind(onFile.branch_model, runId), chain };
  }
  if (onFile.epic_branch.length > 0) {
    // A run that entered Build before `branch_model` existed. Its stories are
    // already on branches it cut; re-deciding now would strand them.
    return { kind: "per-epic", integrationBranch: null, chain };
  }
  return fromPlan;
}

/**
 * An `epic/<slug>` that already exists and was NOT cut by this run.
 *
 * Story branches and worktrees now carry the run id, so they cannot collide.
 * The epic branch deliberately does not — an epic is the unit a team merges,
 * and `epic/260829-x-leaderboard` would be a worse name for it. So instead of
 * making collision impossible, this makes it DELIBERATE: a branch this run's
 * `build.epic_branch` does not claim is refused, and `--reuse-epic` is the word
 * that says "yes, stack on it". Measured 2026-08-29: four runs piled onto one
 * `epic/leaderboard` with nothing said.
 *
 * `commit` never asks: it continues a story whose epic was claimed at prepare.
 */
export async function foreignEpicRefusal(
  state: EpicState,
  parts: ClaimParts,
  stories: readonly PlannedStory[],
): Promise<BuildRefusal | null> {
  const claimed = new Set(buildOnFile(parts.runDir).epic_branch);
  const seen = new Set<string>();
  for (const planned of stories) {
    const epic = parts.epics.get(planned.story.epic);
    if (epic === undefined) continue;
    const branch = epicBranchOf(parts.branchModel, epic.epic.branch);
    const key = `${planned.story.repo}:${branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const repoDir = repoDirOf(parts.workspace, planned.story.repo);
    if (!(await branchExists(repoDir, branch))) continue;   // we are about to cut it
    if (claimed.has(branch)) continue;                       // this run cut it earlier
    if (parts.reuseEpic) {
      state.claimed.add(branch);
      parts.lines.push(`  · adopting existing \`${branch}\` in ${planned.story.repo} (--reuse-epic)`);
      continue;
    }
    return {
      lines: [
        `[tldrx] build: \`${branch}\` already exists in ${planned.story.repo} and run ${parts.runId} ` +
          "did not cut it — refusing to stack this run's commits onto someone else's epic.",
        "  either delete or rename that branch, or run `tldrx next --reuse-epic` to work on it deliberately.",
      ],
      error: `epic branch \`${branch}\` was not created by this run`,
    };
  }
  return null;
}

/**
 * Spec §5, Build executor safety: what a repo's dirty tree does to a Build.
 *
 * **The reason, corrected 2026-09-06 (#164).** This used to say the refusal was
 * because `git worktree add` would carry the mess forward. It would not — a new
 * worktree is a fresh checkout and does not inherit an unstaged tree or an
 * index. The real reason is that the #41 base pre-flight runs the workspace's
 * gate commands IN THE REPO'S OWN CHECKOUT (`build/dodRunner.ts` —
 * deliberately, because that is the tree with the installed dependencies), so
 * uncommitted product changes there are silently INSIDE the measurement that
 * decides whether a story's red DoD is the story's fault or the base's.
 *
 * **The outcome, corrected 2026-09-09 (#164, the second half).** The measurement
 * above is protected by the tree being clean AT THE CUT, not by the operator's
 * work being committed. So the dirt is now classified rather than counted
 * (`build/foreignWork.ts`), and only one of the three verdicts still refuses:
 *
 *   - `own` — `tldrx-work/`, `.tldrx/`, `.agent/`. Never dirt, never stashed.
 *     Counting them made this command refuse the files it had just written itself
 *     (`run.yml`, `events.jsonl`, `.lock`, the freshly synthesised `04-build/`)
 *     and made a user's uncommitted answers a precondition of Build.
 *   - `overlapping` — inside a pending story's `touches:`, or a submodule.
 *     REFUSES, with the message below.
 *   - `foreign` — everything else. The engine sets it aside itself.
 *
 * This function decides; it writes nothing. The stash is the executor's to run,
 * because the executor is what can also give it back.
 *
 * A repo in the middle of a merge, a rebase, a cherry-pick or a bisect refuses
 * outright and is never stashed: that state has no clean undo, and a framework
 * that wrote into it would be making a mess nobody could name afterwards.
 */
export interface DirtyPlan {
  readonly refusal: BuildRefusal | null;
  /** How many framework state files the check ignored — a stdout line, as before. */
  readonly ignored: number;
  /** One entry per repo whose foreign work the caller should set aside. */
  readonly aside: readonly { readonly repo: string; readonly repoDir: string; readonly paths: readonly string[] }[];
}

/** Which command relaunches this run — the engine's verb, or the cursor's (#164). */
export function relaunchCommand(mode: NextMode, runId: string): string {
  return mode === "headless" ? `tldrx run auto ${runId}` : "tldrx next";
}

export async function dirtyRepoRefusal(
  parts: Pick<ClaimParts, "root" | "workspace" | "runId"> & { readonly mode: NextMode },
  stories: readonly PlannedStory[],
): Promise<DirtyPlan> {
  const seen = new Set<string>();
  const aside: { repo: string; repoDir: string; paths: readonly string[] }[] = [];
  let ignored = 0;
  const refuse = (refusal: BuildRefusal): DirtyPlan => ({ refusal, ignored, aside: [] });
  for (const planned of stories) {
    const name = planned.story.repo;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = repoDirOf(parts.workspace, name);
    const entries = await dirtyEntries(dir);
    // The union of what EVERY pending story of this repo declared, not just this
    // one: the wave is what runs, and a path the third story will write is no
    // more the framework's to move than a path the first will.
    const touches = stories
      .filter((row) => row.story.repo === name)
      .flatMap((row) => [...row.story.touches]);
    const verdict = classifyDirty({
      entries,
      statePrefixes: stateDirPrefixes(parts.workspace.root, dir),
      touches,
      submodules: await submodulePaths(dir),
    });
    ignored += verdict.own.length;
    if (verdict.foreign.length === 0 && verdict.overlapping.length === 0) continue;

    const branch = await currentBranch(dir);
    const busy = await operationInProgress(dir);
    if (busy !== null) {
      return refuse({
        lines: [
          `[tldrx] build: repo \`${name}\` is in the middle of ${busy} on \`${branch}\` — refusing to cut `
            + "an epic branch, and refusing to stash anything into that state.",
          `  ${namePaths(entries.map((entry) => entry.entry))}`,
          `  Finish or abort ${busy} first, then run \`${relaunchCommand(parts.mode, parts.runId)}\`.`,
        ],
        error: `repo \`${name}\` is in the middle of ${busy}`,
      });
    }
    if (verdict.overlapping.length > 0) {
      const paths = verdict.overlapping.map((row) => row.entry.path);
      const setAside = verdict.foreign.map((entry) => entry.path);
      return refuse({
        lines: [
          `[tldrx] build: repo \`${name}\` has ${String(paths.length)} uncommitted change(s) on `
            + `\`${branch}\` that a pending story is about to write — refusing to cut an epic branch `
            + "from a dirty tree.",
          `  ${namePaths(verdict.overlapping.map((row) => row.entry.entry))}`,
          ...verdict.overlapping.slice(0, NAMED_PATHS).map((row) => `  · ${row.entry.path}: ${row.why}`),
          "  Why: the base pre-flight runs in this checkout, so uncommitted product changes here",
          "  land inside the measurement that decides whether a red DoD is the story's fault.",
          "  Commit them, or set exactly these paths aside and take them back afterwards:",
          `    ${stashCommand(dir, parts.runId, paths)}`,
          `    ${relaunchCommand(parts.mode, parts.runId)}`,
          `    git -C ${shellQuote(dir)} stash pop`,
          ...(setAside.length === 0
            ? []
            : [`  The other ${String(setAside.length)} change(s) here are nobody's story — `
              + "the engine would have set those aside and given them back itself."]),
        ],
        error: `repo \`${name}\` has uncommitted changes a pending story declares`,
      });
    }
    aside.push({ repo: name, repoDir: dir, paths: verdict.foreign.map((entry) => entry.path) });
  }
  return { refusal: null, ignored, aside };
}

export function epicRows(
  state: EpicState,
  parts: Pick<ClaimParts, "workspace" | "epics" | "branchModel"> & {
    readonly stories: ReadonlyMap<string, PlannedStory>;
  },
  outcomes: readonly StoryOutcome[],
): readonly EpicSummaryRow[] {
  const rows: EpicSummaryRow[] = [];
  for (const [id, epic] of parts.epics) {
    const branch = epicBranchOf(parts.branchModel, epic.epic.branch);
    // Attributed to the EPIC, not to the branch. Under `per-epic` the two are
    // the same set; under the integration model one branch carries every epic's
    // stories, and a row that claimed all of them for each epic would be false.
    const merges = state.mergesOnto(branch, outcomes)
      .filter((row) => parts.stories.get(row.id)?.story.epic === id);
    rows.push({
      id,
      branch,
      repos: epic.epic.repos,
      // A merge that moved nothing is not listed with the ones that did. The
      // Gate section is what a human reads before merging an epic by hand, and
      // "S3, S4, S5, S7 merged" over four identical branches is the sentence
      // this split exists to stop writing (2026-08-30).
      merged: merges.filter((row) => row.carried !== null && row.carried !== 0).map((row) => row.id),
      emptyMerges: merges.filter((row) => row.carried === 0).map((row) => row.id),
      // Merged, and this process did not watch it happen — see `mergedEarlier`.
      mergedEarlier: merges.filter((row) => row.carried === null).map((row) => row.id),
      defaultBranches: epic.epic.repos.map((repo) => parts.workspace.defaultBranches.get(repo) ?? "main"),
      rel: epic.rel,
    });
  }
  return rows;
}
