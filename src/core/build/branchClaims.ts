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
  addDetachedWorktree, branchExists, currentBranch, dirtyEntries, operationInProgress, removeWorktree,
  repoDirOf, shaOf, stateDirPrefixes,
} from "./git.ts";
import {
  classifyDirty, namePaths, NAMED_PATHS, shellQuote, stashCommand, submodulePaths,
} from "./foreignWork.ts";
import type { NextMode } from "../facilitator/runNext.ts";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { EventType } from "../events/Event.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
import { isFinished } from "../run/RunFile.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { releaseRunEpics } from "./epicRelease.ts";
import type { EpicSummaryRow } from "./handoff.ts";
import { DodCommandRefused, runDodCommand } from "../../hooks/lib/story.ts";
import type { BuildRefusal, StoryOutcome } from "./outcome.ts";
import { WORKTREES, type PlannedEpic, type PlannedStory } from "./plan.ts";
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
  /** When this Build is entering, for the record a moved-aside leftover gets (gh #272). */
  readonly at: string;
  /** This run's own ledger: a leftover moved aside is written on it as well as on its owner's. */
  readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
  /**
   * The cheap-gate timeout for `resumedEpicClaimVerdict` (gh #347) — the same
   * figure every other DoD spawn in Build uses (`story.timeout_s * 1000`),
   * never a second number invented for this one check.
   */
  readonly timeoutMs: number;
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
 *
 * **A leftover is not a claim (gh #272).** Measured 2026-09-13: a cancelled run's
 * `epic/main-ci-green`, zero commits beyond `main`, refused the ordinary retry —
 * the same feature, id `…-2` — after $3.70 of what/how/plan. So before refusing,
 * this reads WHO owns the branch from the claims under `tldrx-work/`. An owner
 * whose run.yml is explicitly finished (`cancelled` / `done`) left it behind: it
 * is moved aside by `run cancel`'s rule (`build/epicRelease.ts`), recorded on
 * both runs, and this run cuts its own. An open owner, an unreadable one, and a
 * branch NO run claims keep the refusal verbatim — the last because #262's run,
 * killed between cutting the epic and recording the claim, must find its epic
 * where it left it on relaunch. Ownership is a RECORD, never "is a process
 * running": a run parked at a gate has no process and is still the owner.
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
    if (claimed.has(branch)) {
      // This run's OWN `build.epic_branch` already names it — the ordinary
      // shape of `tldrx run auto <runId>` resuming a dead attempt (gh #347).
      // `state.claimed` is THIS PROCESS's memory, empty here unless an earlier
      // story of the SAME invocation already verified (or itself just cut) the
      // branch — so a second story of one epic in one invocation is never
      // re-gated, only a genuine new process picking up an old claim is.
      // `--reuse-epic` is a human's own deliberate word and skips the gate
      // outright, exactly as it already adopts a FOREIGN branch outright.
      if (!state.claimed.has(branch) && !parts.reuseEpic) {
        const verdict = await resumedEpicClaimVerdict(parts, planned.story.repo, repoDir, branch);
        if (!verdict.ok) {
          return {
            lines: [
              `[tldrx] build: \`${branch}\` in ${planned.story.repo} is this run's own claim ` +
                `(\`build.epic_branch\`), but resuming it failed — ${verdict.note}.`,
              "  fix the branch by hand and relaunch, or run `tldrx next --reuse-epic` to adopt it "
                + "without the check.",
            ],
            error: `epic branch \`${branch}\` in ${planned.story.repo} is this run's own claim, `
              + `but ${verdict.note}`,
          };
        }
        parts.lines.push(
          `  · resumed \`${branch}\` in ${planned.story.repo} from ${verdict.sha}: `
            + `claim by this run ${parts.runId}, ${verdict.note}`,
        );
        parts.emit("epic.resumed", {
          repo: planned.story.repo, branch, run: parts.runId, sha: verdict.sha, typecheck: verdict.typecheck,
        });
      }
      state.claimed.add(branch);
      continue;
    }
    if (parts.reuseEpic) {
      state.claimed.add(branch);
      parts.lines.push(`  · adopting existing \`${branch}\` in ${planned.story.repo} (--reuse-epic)`);
      continue;
    }
    const verbatim = [
      `[tldrx] build: \`${branch}\` already exists in ${planned.story.repo} and run ${parts.runId} ` +
        "did not cut it — refusing to stack this run's commits onto someone else's epic.",
      "  either delete or rename that branch, or run `tldrx next --reuse-epic` to work on it deliberately.",
    ];
    // Four structurally different faults share these lines, and each gets its OWN
    // sentence (gh #297): a constant per branch made "a claimant is still open" and "the
    // leftover could not be moved" the same refusal, so a run whose foreign-epic
    // condition CHANGED shape between attempts — an open owner finishing, its branch
    // becoming a movable leftover — read as a refusal repeating and stopped relaunching.
    const about = `epic branch \`${branch}\` in ${planned.story.repo} was not created by this run`;
    // Whose is it? (gh #272) Read from the CLAIMS under tldrx-work/ — never from
    // "is a process running", because a run killed mid-Build or parked eight
    // hours at a gate has no process and is still the owner.
    const owners = epicClaimants(parts.root, branch, parts.runId);
    if (owners.unreadable.length > 0) {
      return {
        lines: [...verbatim, `  · ${owners.unreadable.join(", ")} could not be read, so who owns it is unknown`],
        error: `${about}; who owns it is unknown — unreadable claim(s): ${owners.unreadable.join(", ")}`,
      };
    }
    const open = owners.claimants.filter((store) => !isFinished(store.run.status));
    if (open.length > 0) {
      const named = open.map((store) => `${store.runId} (${store.run.status})`).join(", ");
      return {
        lines: [...verbatim, `  · claimed by run ${named}, which is still open`],
        error: `${about}; claimed by open run(s) ${named}`,
      };
    }
    const owner = owners.claimants[0];
    if (owner === undefined) {
      // No claim anywhere. A run killed between cutting the epic and recording
      // the claim (#262) leaves exactly this, and its relaunch must find its
      // epic where it left it — moving it aside would be worse than refusing.
      return {
        lines: [...verbatim, `  · no run under ${PROJECT_WORK_DIR}/ records cutting it, so it is nobody's leftover to move`],
        error: `${about}; no run records cutting it, so it is nobody's leftover to move`,
      };
    }
    // The owner's run.yml says it is finished: the branch is a leftover, not a
    // claim. Same rule as `run cancel` — delete an empty one, rename one that
    // carries commits — recorded on the owner and on this run.
    const status = owner.run.status;
    const released = await releaseRunEpics({
      root: parts.root, owner, actor: "facilitator", at: parts.at, via: "build",
      reason: `run ${parts.runId} needs the name and ${owner.runId} is ${status}`,
      only: { repo: planned.story.repo, branch },
      emitAlso: parts.emit,
    });
    const record = released.released[0];
    // Neither released nor kept: the branch went away between the two reads.
    // Nothing is in the way any more, so this run cuts its own as it would have.
    if (record === undefined && released.kept.length === 0) continue;
    if (record === undefined) {
      const why = released.kept[0]?.reason ?? "it could not be moved";
      return {
        lines: [
          `[tldrx] build: \`${branch}\` already exists in ${planned.story.repo}, left by run ${owner.runId} ` +
            `(${status}), and could not be moved aside — ${why}.`,
          verbatim[1] ?? "",
        ],
        error: `${about}; left by run ${owner.runId} (${status}) and could not be moved aside — ${why}`,
      };
    }
    state.released.push({ record, owner: owner.runId, ownerStatus: status });
    parts.lines.push(`  · \`${branch}\` in ${planned.story.repo} was left by run ${owner.runId} (${status}) — ${
      record.outcome === "deleted"
        ? `deleted: no commit beyond \`${record.base}\``
        : `renamed to \`${record.renamed_to ?? ""}\`: ${String(record.commits)} commit(s) beyond \`${record.base}\` survive there`
    }; this run cuts its own`);
  }
  return null;
}

/** What verifying a RESUMED epic claim (gh #347) found — never trusted silently. */
interface ResumedEpicClaimVerdict {
  readonly ok: boolean;
  /** Short sha `branch` resolves to, or `""` when it no longer resolves. */
  readonly sha: string;
  /** What ran, or why nothing did — said out loud either way. */
  readonly note: string;
  readonly typecheck: "ok" | "failed" | "absent";
}

/**
 * Verify a branch THIS run's own `run.yml` already claims, but that this
 * PROCESS did not itself just cut — owner decision, 2026-09-16 (gh #347).
 *
 * Two checks, both named in the record: (a) the branch head still resolves —
 * `shaOf` returning `""` is not a sha to resume from — and (b) the workspace's
 * OWN `typecheck` command, run in a throwaway DETACHED worktree of the branch
 * (`addDetachedWorktree`/`removeWorktree`, the same disposable-checkout idiom
 * `entryProbe.ts` uses for its own base-of-tree measurement), removed whether
 * it passes or not. Never a shared or persistent worktree: nothing else is
 * entitled to the branch just because this check looked at it.
 *
 * A repo with no `typecheck` role cannot be gated on one — absent-with-reason,
 * never assumed green — and the claim is honoured with that said out loud
 * rather than silently trusted the way it was before this existed.
 */
async function resumedEpicClaimVerdict(
  parts: ClaimParts,
  repo: string,
  repoDir: string,
  branch: string,
): Promise<ResumedEpicClaimVerdict> {
  const sha = await shaOf(repoDir, branch);
  if (sha === "") {
    return { ok: false, sha: "", note: `\`${branch}\` no longer resolves to a commit`, typecheck: "failed" };
  }
  const command = parts.workspace.commandRoles.get(repo)?.get("typecheck");
  if (command === undefined) {
    return { ok: true, sha, note: "typecheck: absent — repo declares no typecheck command", typecheck: "absent" };
  }
  const scratch = join(
    parts.root, PROJECT_FRAMEWORK_DIR, WORKTREES, repo,
    `_resume-${parts.runId}-${branch.replace(/[^a-zA-Z0-9_.-]/g, "-")}`,
  );
  try {
    mkdirSync(join(scratch, ".."), { recursive: true });
    await addDetachedWorktree(repoDir, scratch, branch);
    const result = await runDodCommand(command, scratch, parts.timeoutMs, parts.workspace.commands);
    if (result.exitCode !== 0 || result.timedOut) {
      return {
        ok: false, sha, typecheck: "failed",
        note: `typecheck: \`${command}\` ${result.timedOut ? "timed out" : `exited ${String(result.exitCode)}`}`
          + ` — ${result.tail}`,
      };
    }
    return { ok: true, sha, note: `typecheck ok (\`${command}\`)`, typecheck: "ok" };
  } catch (error) {
    const why = error instanceof DodCommandRefused || error instanceof Error ? error.message : String(error);
    return { ok: false, sha, note: `typecheck: could not run \`${command}\` — ${why}`, typecheck: "failed" };
  } finally {
    await removeWorktree(repoDir, scratch);
  }
}

/** Every OTHER run under `tldrx-work/` whose `build.epic_branch` claims `branch`, newest first. */
function epicClaimants(
  root: string,
  branch: string,
  exceptRunId: string,
): { readonly claimants: readonly RunStore[]; readonly unreadable: readonly string[] } {
  const claimants: RunStore[] = [];
  const unreadable: string[] = [];
  for (const dir of listRunDirs(root)) {
    if (basename(dir) === exceptRunId) continue;
    let store: RunStore;
    try {
      store = RunStore.open(dir);
    } catch {
      unreadable.push(`${PROJECT_WORK_DIR}/${basename(dir)}/run.yml`);
      continue;
    }
    if ((store.run.build?.epic_branch ?? []).includes(branch)) claimants.push(store);
  }
  return { claimants, unreadable };
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
        // The PATHS and whose story they belong to, not just the repo (gh #297). A run
        // comes back to the same repo, so a comparand that names only the repo calls two
        // different dirty trees — different files, different stories — the same refusal
        // and throws away the relaunches that would have outlived them.
        error: `repo \`${name}\` has uncommitted changes a pending story declares: `
          + verdict.overlapping.map((row) => `${row.entry.path} (${row.why})`).join("; "),
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
