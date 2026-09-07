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
import { branchExists, currentBranch, dirtyPaths, partitionDirty, repoDirOf, stateDirPrefixes } from "./git.ts";
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
 * Spec §5, Build executor safety: a repo whose tree is dirty is refused BEFORE
 * anything is cut.
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
 * PRODUCT dirt only. `tldrx-work/` and `.tldrx/` are the framework's own state,
 * and in a `root_is_repo: true` workspace they sit inside the product repo — so
 * counting them made this command refuse the files it had just written itself
 * (`run.yml`, `events.jsonl`, `.lock`, the freshly synthesised `04-build/`), and
 * made a user's uncommitted answers a precondition of Build. Product dirt still
 * refuses, by the same rule and with the same two-command fix. Two things about the
 * message DID move: the count and the path list, which no longer include framework
 * state, and the `Why:` line, which now names the pre-flight rather than the
 * worktree it used to blame.
 *
 * The refusal prints the two literal commands, with this run's id in the stash
 * message, and does NOT stash anything itself: a framework-owned stash that a
 * crash mid-wave left behind would strand somebody's work in a place they did
 * not put it (the #129 shape). The operator's tree stays the operator's.
 */
export async function dirtyRepoRefusal(
  parts: Pick<ClaimParts, "root" | "workspace" | "runId">,
  stories: readonly PlannedStory[],
): Promise<{ readonly refusal: BuildRefusal | null; readonly ignored: number }> {
  const seen = new Set<string>();
  let ignored = 0;
  for (const planned of stories) {
    const name = planned.story.repo;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = repoDirOf(parts.workspace, name);
    const split = partitionDirty(await dirtyPaths(dir), stateDirPrefixes(parts.workspace.root, dir));
    ignored += split.state.length;
    const dirty = split.product;
    if (dirty.length === 0) continue;
    const branch = await currentBranch(dir);
    return { ignored, refusal: {
      lines: [
        `[tldrx] build: repo \`${name}\` has ${String(dirty.length)} uncommitted change(s) on ` +
          `\`${branch}\` — refusing to cut an epic branch from a dirty tree.`,
        `  ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? `, +${String(dirty.length - 5)} more` : ""}`,
        "  Why: the base pre-flight runs in this checkout, so uncommitted product changes here",
        "  land inside the measurement that decides whether a red DoD is the story's fault.",
        "  Commit them, or set them aside and take them back afterwards:",
        `    git -C ${dir} stash push -u -m "tldrx ${parts.runId} foreign work"`,
        "    tldrx next",
        `    git -C ${dir} stash pop`,
      ],
      error: `repo \`${name}\` has uncommitted changes`,
    } };
  }
  return { refusal: null, ignored };
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
