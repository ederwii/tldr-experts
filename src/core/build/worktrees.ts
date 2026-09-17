/**
 * The git side of a Build story: its worktree, its epic's worktree, the base
 * refresh before a dispatch, the commit of whatever the agent left behind, the
 * merge onto the epic, and the rescue of work that reached no ref (#129).
 *
 * Every path here carries the RUN ID, in the branch name and in the directory
 * name both. Measured 2026-08-29: four runs of one plan all cut `story/S1`, and
 * the fourth reused the third's LIVE epic worktree, so `git merge --no-ff` ran
 * inside a checkout of another run's epic branch while every rendered line named
 * the branch it thought it was on (issue #40).
 *
 * `EpicState` is the per-invocation memory that used to be three private maps on
 * `BuildSession`. It is owned by the executor and passed in, because
 * `buildExecutor`'s `withClaims` reads `claimed` on EVERY exit — including the
 * failure paths. A run that cut `epic/x` and then fell over still cut it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_FRAMEWORK_DIR, epicWorktreeName } from "../paths.ts";
import { epicWorktreeSlotOf, type BranchModel } from "../plan/branchModel.ts";
import type { EventType } from "../events/Event.ts";
import type { EpicReleaseNote } from "./handoff.ts";
import type { PlanStatus } from "../schemas/planCommon.ts";
import {
  abortOpenMerge, addWorktree, assertWorktreeOn, baseStateOf, commitAll, dirtyPaths, fastForward, firstLine, fullShaOf,
  git, headSha, isDirty, mergeNoFf, partitionDirty, pathAtRef, stateDirPrefixes,
  treesDiffer,
} from "./git.ts";
import type { RescuedWork, SerialWrite, StoryOutcome } from "./outcome.ts";
import { WORKTREES } from "./plan.ts";

/**
 * The epic-side state one Build invocation accumulates: which epic branches it
 * cut or adopted, which worktree each epic is checked out in, and what each
 * merge CARRIED. Owned by the executor and passed in; every field was a private
 * map on the session.
 */
export class EpicState {
  private readonly epicWorktrees = new Map<string, string>();
  /**
   * Per epic branch, the stories merged into it and what each merge CARRIED —
   * `0` for a branch that was already identical to the epic, `null` when an
   * earlier invocation did the merging.
   */
  private readonly merged = new Map<string, { id: string; carried: number | null }[]>();
  /** Epic branches this run cut or adopted; `runNext` writes them to run.yml. */
  readonly claimed = new Set<string>();
  /**
   * Of those, the ones whose claim is already ON DISK — written while this
   * invocation was still running, by `claimAtTheCut` (#262).
   *
   * Separate from `claimed` because the two answer different questions: `claimed`
   * is what the outcome carries out at the end, and this is what a process
   * starting after a SIGKILL would find. It exists to keep the write to ONE per
   * branch: `openStory` runs on every story, every attempt, and the claim is a
   * `run.yml` save.
   */
  private readonly recorded = new Set<string>();
  /**
   * Stale epics this invocation moved aside before cutting its own (gh #272) —
   * the handoff's Decisions bullets. Empty on every ordinary Build.
   */
  readonly released: EpicReleaseNote[] = [];
  /**
   * Epic branches on which at least one story's DoD ran SCOPED (#257) — the
   * only epics whose head owes a full run. An epic whose every story ran the
   * full list already proved the tree the old way, and runs nothing extra.
   */
  private readonly scopedRuns = new Set<string>();
  /** Epic branches whose head this invocation has already run the full list on. */
  private readonly headChecked = new Set<string>();

  /**
   * Claim `branch` for this run — in memory AND, through `record`, in `run.yml`
   * on disk before this returns (#262).
   *
   * `record` is `ctx.claimEpicBranch`, which saves; it is passed in rather than
   * read off a session, so this class keeps knowing nothing about the executor.
   * It fires ONCE per branch: the write is idempotent, but it is a file write,
   * and `openStory` reaches here on every story of every attempt.
   *
   * `recorded` is marked only AFTER `record` returns, so a write that threw is
   * retried by the next story rather than silently believed.
   */
  claimAtTheCut(branch: string, record: (branch: string) => void): void {
    this.claimed.add(branch);
    if (this.recorded.has(branch)) return;
    record(branch);
    this.recorded.add(branch);
  }

  noteScopedRun(epicBranch: string): void {
    this.scopedRuns.add(epicBranch);
  }

  hadScopedRun(epicBranch: string): boolean {
    return this.scopedRuns.has(epicBranch);
  }

  /** True the FIRST time only: the epic head is checked once per invocation. */
  claimHeadCheck(epicBranch: string): boolean {
    if (this.headChecked.has(epicBranch)) return false;
    this.headChecked.add(epicBranch);
    return true;
  }

  /**
   * Record that this story's branch went onto its epic, and WHAT the merge
   * moved: a count, or `null` when this invocation did not watch it happen.
   */
  noteMerged(epicBranch: string, storyId: string, carried: number | null): void {
    const list = this.merged.get(epicBranch) ?? [];
    const at = list.findIndex((row) => row.id === storyId);
    if (at === -1) list.push({ id: storyId, carried });
    else list[at] = { id: storyId, carried };
    this.merged.set(epicBranch, list);
  }

  /**
   * Every story known to sit on this epic branch, from BOTH sources (#137).
   *
   * `this.merged` is what this process merged, and it is the only source the Gate
   * section had. So a re-entered stage — every story already settled, nothing left
   * to merge — printed `(no story merged)` over an epic branch carrying two merge
   * commits, and that is the sentence a human reads before deciding what to ship.
   *
   * The second source is the outcomes themselves: a row rebuilt by `fromDisk`
   * carries `merged: true` for a story disk says is `done`, which in this pipeline
   * is a status only a merged story reaches. It carries `carried: null` with it,
   * so the row is reported as merged-but-not-re-measured rather than as either
   * kind of measurement. This process's own rows win on id — they are the ones
   * that HAVE a measurement.
   */
  mergesOnto(
    branch: string,
    outcomes: readonly StoryOutcome[],
  ): readonly { id: string; carried: number | null }[] {
    const rows = [...(this.merged.get(branch) ?? [])];
    const seen = new Set(rows.map((row) => row.id));
    for (const outcome of outcomes) {
      if (outcome.epicBranch !== branch || !outcome.merged || seen.has(outcome.id)) continue;
      seen.add(outcome.id);
      rows.push({ id: outcome.id, carried: outcome.carried });
    }
    return rows;
  }

  /** `repo:branch` -> the epic worktree this process opened for it. */
  worktreeFor(key: string): string | undefined {
    return this.epicWorktrees.get(key);
  }

  rememberWorktree(key: string, path: string): void {
    this.epicWorktrees.set(key, path);
  }
}

/**
 * The epic branch was cut and the claim could NOT be written (#262).
 *
 * Its own class so `buildExecutor` can fail the stage with the sentence below
 * instead of re-raising a `WorkspaceLockError` whose message is about a lock
 * file and says nothing about the branch now sitting in the repo unclaimed.
 */
export class EpicClaimError extends Error {}

/**
 * Why the claim could not be written, and what to do about it — never a bare
 * throw, and never silence.
 *
 * Swallowing this would be #262 happening again with the evidence deleted: the
 * branch is on disk, the record does not name it, and the operator finds out on
 * the relaunch that refuses it. So it travels — with the cause named (the write
 * that failed) and the cure named (both ways back in).
 */
export function epicClaimRefusal(
  branch: string,
  repo: string,
  runId: string,
  cause: unknown,
): EpicClaimError {
  const why = cause instanceof Error ? cause.message : String(cause);
  return new EpicClaimError(
    `cut \`${branch}\` in ${repo} but could not record the claim in run.yml: ${why}. ` +
      "The branch is in the repo and this run's record does not name it, so a process killed now " +
      `would be refused its own epic on the next \`tldrx run auto ${runId}\`. ` +
      "Let the other tldrx process finish (or remove the lock file it names if that process is gone) " +
      `and run \`tldrx run auto ${runId}\` again; \`tldrx next --reuse-epic ${runId}\` adopts the branch ` +
      "deliberately if the record was already lost.",
  );
}

/**
 * `.tldrx/worktrees/<repo>/<run>-<story>` — the run id is in the PATH too.
 *
 * Same collision, worse: the fourth run of one plan reused the third's LIVE
 * worktree, so two sub-agents were editing the same files at the same time
 * (2026-08-29 audit, §B). A path that names the run cannot be walked into.
 */
export function storyWorktreePath(
  root: string,
  repo: string,
  runId: string,
  storyId: string,
): string {
  return join(
    root, PROJECT_FRAMEWORK_DIR, WORKTREES,
    repo, `${runId}-${storyId}`,
  );
}

/** What `refreshStoryBase` needs to move — or refuse to move — a story branch. */
export interface RefreshParts {
  readonly storyId: string;
  readonly root: string;
  readonly workspaceRoot: string;
  readonly repoDir: string;
  readonly worktree: string;
  readonly branch: string;
  readonly epicBranch: string;
  readonly repo: string;
  readonly phaseId: string;
  readonly lines: string[];
  readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
}

/**
 * A story's branch, brought up to its epic's tip before a developer is
 * dispatched onto it — or the precise reason it was left exactly where it is.
 *
 * The live case, notes §11 on `260830-tenancy-identity-customers`: `story
 * reopen` keeps the branch by design, and S3's branch still sat at the S1-era
 * epic tip while the epic had since gained S2 and S5. S3's handlers needed S2's
 * contract, so a dispatch on that base would not have compiled. The host
 * fast-forwarded by hand before dispatching; this is that move, automated, and
 * only in the case where it is a move and not a decision.
 *
 * Three shapes, and only the first changes anything:
 *
 *   - **behind, and the worktree is clean** — the branch is an ancestor of the
 *     epic tip, so `git merge --ff-only` is the entire operation: no commit
 *     written, no history rewritten, and it refuses rather than inventing a
 *     merge. Measured atomic-or-nothing (see `fastForward`).
 *   - **diverged** — commits on both sides. Warn with both counts and both
 *     shas, change NOTHING, and let the dispatch proceed on the old base. This
 *     is the second live case: a dead spawn had left a partial commit on a
 *     stale base, no fast-forward was possible, and the host preserved the
 *     partial on a backup branch and re-pointed the story branch BY HAND. That
 *     is a decision — which of the two histories survives — and the framework
 *     does not get to make it. **Never a rebase**: rewriting a branch a
 *     developer already committed to is the class of move the
 *     run-id-in-branch-name fix exists to prevent (2026-08-29 audit §B).
 *   - **the worktree is dirty** — left alone whatever the topology says. A
 *     dirty tree is the operator's, not ours.
 *
 * An `up to date` branch is silent and emits nothing: this path is byte-for-byte
 * what it was before design §F.2 whenever there was nothing to say.
 */
export async function refreshStoryBase(parts: RefreshParts): Promise<void> {
  const id = parts.storyId;
  const base = await baseStateOf(parts.repoDir, parts.branch, parts.epicBranch);
  // A branch git could not measure is left alone — the same inaction `current`
  // gets — but it is SAID when there is a branch to say it about (gh #273).
  // Silence here is right for the ordinary uncountable case, a story branch that
  // does not exist yet (`branchSha` is `""` then); it is wrong for a branch that
  // is there and whose position could not be read, because the dispatch below
  // then proceeds on a base nobody checked.
  if (base.uncounted !== null && base.branchSha !== "") {
    parts.lines.push(
      `  · ${id}: ${base.uncounted} — \`${parts.branch}\` was left exactly as it is, `
      + `and the dispatch below is on its current tip`,
    );
    return;
  }
  if (base.state === "current") return;

  const where = relative(parts.root, parts.worktree) || parts.worktree;
  if (base.state === "diverged") {
    parts.lines.push(
      `  · ${id}: \`${parts.branch}\` (${base.branchSha}) has DIVERGED from \`${parts.epicBranch}\` `
      + `(${base.baseSha}) — ${String(base.ahead)} commit(s) the epic lacks, `
      + `${String(base.behind)} the story lacks`,
      `  · ${id}: nothing was changed — tldrx never rebases a branch a developer has committed to. `
      + `In ${where}: \`git merge ${parts.epicBranch}\`, or preserve the divergent commit(s) on a backup `
      + `branch and re-point \`${parts.branch}\` at \`${parts.epicBranch}\` by hand`,
      `  · ${id}: the dispatch below is on the OLD base (${base.branchSha}), `
      + `${String(base.behind)} commit(s) behind \`${parts.epicBranch}\``,
    );
    return;
  }

  // A story worktree is its own checkout of the SAME repo, so in a
  // `root_is_repo` workspace it holds `tldrx-work/` and `.tldrx/` too. Neither
  // counts as the operator's dirt — the same split `commitIfDirty` makes, from
  // the same prefixes.
  const state = stateDirPrefixes(parts.workspaceRoot, parts.repoDir);
  const dirty = partitionDirty(await dirtyPaths(parts.worktree), state).product;
  if (dirty.length > 0) {
    parts.lines.push(
      `  · ${id}: \`${parts.branch}\` (${base.branchSha}) is ${String(base.behind)} commit(s) behind `
      + `\`${parts.epicBranch}\` (${base.baseSha}), but its worktree has ${String(dirty.length)} `
      + "uncommitted change(s) — left alone; a dirty tree is the operator's",
      `  · ${id}: ${dirty.slice(0, 5).join(", ")}`
      + `${dirty.length > 5 ? `, +${String(dirty.length - 5)} more` : ""} in ${where}`,
    );
    return;
  }

  const moved = await fastForward(parts.worktree, parts.epicBranch);
  if (!moved.ok) {
    // `--ff-only` is atomic-or-nothing, so there is nothing to repair: the
    // branch is still at `from` and the dispatch proceeds on it. What would be
    // wrong is a silent one.
    parts.lines.push(
      `  · ${id}: \`git merge --ff-only ${parts.epicBranch}\` failed in ${where} — `
      + `${firstLine(moved.stderr) || firstLine(moved.stdout) || `exit ${String(moved.exitCode)}`}`,
      `  · ${id}: \`${parts.branch}\` was left at ${base.branchSha}, `
      + `${String(base.behind)} commit(s) behind \`${parts.epicBranch}\``,
    );
    return;
  }
  parts.lines.push(
    `  · ${id}: fast-forwarded \`${parts.branch}\` to \`${parts.epicBranch}\` — `
    + `${String(base.behind)} commit(s), ${base.branchSha} → ${base.baseSha}`,
  );
  parts.emit("story.base_fastforwarded", {
    phase: parts.phaseId,
    story: id,
    repo: parts.repo,
    branch: parts.branch,
    base: parts.epicBranch,
    from: base.branchSha,
    to: base.baseSha,
    commits: base.behind,
  });
}

/** What `unreadableTouches` needs to ask git about a story's `touches:`. */
export interface TouchParts {
  readonly repoDir: string;
  readonly branch: string;
  readonly touches: readonly string[];
  readonly advisories: string[];
}

/**
 * Touched paths that exist in the repo but are NOT in the tree at the story's
 * branch, so the worktree cannot open them.
 *
 * A path that exists nowhere is left out: that one really is a file the story
 * creates, and the prompt already says so. The difference is the whole point —
 * "this story creates it" and "you were shown a quote of it and nothing more"
 * are opposite instructions, and `existsSync(worktree/path)` cannot tell them
 * apart.
 */
export async function unreadableTouches(parts: TouchParts): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  for (const path of parts.touches) {
    // A path that is nowhere in the repo is the ordinary "this story creates
    // it", and cheap to rule out before a git call.
    if (!existsSync(join(parts.repoDir, path))) continue;
    if (await pathAtRef(parts.repoDir, parts.branch, path)) continue;
    out.add(path);
    parts.advisories.push(
      `warning: input ${path} is not committed, so the story worktree cannot read it`,
    );
  }
  return out;
}

/** What `commitIfDirty` needs to write the developer's leftovers to a ref. */
export interface CommitParts {
  readonly storyId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repoDir: string;
  readonly worktree: string;
  readonly lines: string[];
}

export async function commitIfDirty(parts: CommitParts): Promise<string | null> {
  // A story worktree is its own checkout, but of the SAME repo — so when the
  // workspace root is the repo it holds `tldrx-work/` and `.tldrx/` too. Neither
  // the "is there anything to commit" question nor the commit itself may include
  // them: a run that swept its own state into a story commit would put the run
  // log inside the diff a reviewer reads.
  const state = stateDirPrefixes(parts.workspaceRoot, parts.repoDir);
  if (await isDirty(parts.worktree, state)) {
    const message = `feat(${parts.storyId}): ${parts.title}`;
    const committed = await commitAll(parts.worktree, message, state);
    if (!committed.ok) {
      parts.lines.push(
        `  · ${parts.storyId}: \`git commit\` failed — ` +
          `${firstLine(committed.stderr) || firstLine(committed.stdout)}`,
      );
      return null;
    }
  }
  const sha = await headSha(parts.worktree);
  return sha === "" ? null : sha;
}

/** What `workSince` compares: the story tree against the tree the developer was handed. */
export interface WorkSinceParts {
  readonly workspaceRoot: string;
  readonly repoDir: string;
  readonly worktree: string;
  /** HEAD of the worktree BEFORE the developer was spawned. */
  readonly since: string;
}

/**
 * Did the developer do WORK — does the story tree, committed or not, differ from
 * the tree it was handed, outside the framework's own state dirs? (gh #271)
 *
 * Two comparisons, one answer: the branch tip's tree against `since`
 * (`treesDiffer`), and the working copy against the index (`isDirty`, which sees
 * untracked files too). Uncommitted work COUNTS, because that is what the normal
 * path already says — `runDod` runs before `commitIfDirty`, so a developer that
 * edits, is refused for its own verification command and never reaches its
 * commit is exactly the tree the DoD is there to measure. What does NOT count is
 * a proxy's false positive: an empty commit moves HEAD and changes nothing, and
 * a clean tree at the same HEAD is #261's untouched story. `null` from the tree
 * comparison — a sha that no longer resolves — is read as no work: a refusal is
 * blocked unless the work is PROVEN.
 */
export async function workSince(parts: WorkSinceParts): Promise<boolean> {
  const state = stateDirPrefixes(parts.workspaceRoot, parts.repoDir);
  if ((await treesDiffer(parts.worktree, parts.since, "HEAD", state)) === true) return true;
  return await isDirty(parts.worktree, state);
}

/** What an epic worktree is opened — or merged into — from, as data. */
export interface EpicWorktreeParts {
  readonly root: string;
  readonly runId: string;
  readonly repo: string;
  readonly repoDir: string;
  readonly epicId: string;
  readonly epicBranch: string;
  readonly branchModel: BranchModel;
  readonly defaultBranch: string;
}

/**
 * `.tldrx/worktrees/<repo>/_epic-<run>-<epic>` — the run id is in THIS path too.
 *
 * Same collision as the story worktree above, and worse in kind, because this
 * is the worktree a story MERGES in. Every plan names its first epic `E1`, so
 * `_epic-E1` was a path two runs both computed: the second run's `existsSync`
 * hit the first run's live worktree, `addWorktree` was skipped, and
 * `git merge --no-ff` ran inside a checkout of ANOTHER run's epic branch. It
 * never failed — `commitsBetween` and every handoff line render
 * `story.epicBranch`, so three stories reported "merged into
 * `epic/hardening-d1`" while the commits landed on a closed run's
 * `epic/d1-tenancy-identity-customers` and the run closed with an empty epic
 * (issue #40, measured 2026-08-31).
 *
 * Both halves are load-bearing. The path makes the collision impossible; the
 * `assertWorktreeOn` on EVERY reuse — the remembered path and the one found on
 * disk — makes it impossible to repeat SILENTLY. A mismatch refuses; it never
 * re-points the worktree and never merges anyway.
 */
export async function openEpicWorktree(state: EpicState, parts: EpicWorktreeParts): Promise<string> {
  const key = `${parts.repo}:${parts.epicBranch}`;
  const known = state.worktreeFor(key);
  if (known !== undefined && existsSync(known)) {
    await assertWorktreeOn(known, parts.epicBranch, "epic worktree");
    return known;
  }
  const path = join(
    parts.root, PROJECT_FRAMEWORK_DIR, WORKTREES,
    parts.repo,
    // Under the integration model every epic shares one branch, and git will
    // not check one branch out in two worktrees — so they share one slot too.
    epicWorktreeName(parts.runId, epicWorktreeSlotOf(parts.branchModel, parts.epicId)),
  );
  if (existsSync(path)) {
    await assertWorktreeOn(path, parts.epicBranch, "epic worktree");
  } else {
    mkdirSync(join(path, ".."), { recursive: true });
    const base = parts.defaultBranch;
    await addWorktree(parts.repoDir, path, parts.epicBranch, base);
  }
  state.rememberWorktree(key, path);
  return path;
}

export async function mergeIntoEpic(
  state: EpicState,
  parts: EpicWorktreeParts & {
    readonly storyBranch: string;
    readonly storyId: string;
    readonly storyTitle: string;
  },
): Promise<{ ok: boolean; conflicts: readonly string[]; detail: string }> {
  return await mergeNoFf(
    await openEpicWorktree(state, parts),
    parts.storyBranch,
    storyMergeSubject(parts.storyId, parts.storyTitle),
  );
}

/**
 * `merge(<story>): <title>` — the subject of a story LANDING on its epic, and
 * the one place it is spelled, because `storiesLandedSince` reads it back.
 */
export function storyMergeSubject(storyId: string, title: string): string {
  return `merge(${storyId}): ${title}`;
}

/** One story that landed on the epic, as its merge subject names it. */
export interface LandedStory {
  readonly id: string;
  readonly title: string;
}

/**
 * The stories that landed on `epicBranch` since `since` — the EPIC side of a
 * conflict (gh #286), read off the merge subjects `storyMergeSubject` wrote,
 * newest first. Empty when git could not answer or nothing matched, which the
 * caller renders as the epic sha instead: absent, with the reason, never guessed.
 */
export async function storiesLandedSince(
  repoDir: string, since: string, epicBranch: string,
): Promise<readonly LandedStory[]> {
  const logged = await git(["log", "--first-parent", "--merges", "--format=%s", `${since}..${epicBranch}`], repoDir);
  if (!logged.ok) return [];
  const landed: LandedStory[] = [];
  for (const line of logged.stdout.split("\n")) {
    const hit = /^merge\(([^)]+)\): (.*)$/.exec(line.trim());
    if (hit?.[1] !== undefined && !landed.some((s) => s.id === hit[1])) landed.push({ id: hit[1], title: hit[2] ?? "" });
  }
  return landed;
}

/** What `rescueUncommitted` needs, including the executor's ONE writer. */
export interface RescueParts {
  readonly storyId: string;
  readonly repo: string;
  readonly workspaceRoot: string;
  readonly repoDir: string;
  readonly worktree: string;
  readonly branch: string;
  readonly phaseId: string;
  readonly status: PlanStatus;
  readonly reason: string | null;
  readonly lines: string[];
  readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
  readonly write: SerialWrite;
}

/**
 * Get anything the worktree holds and no ref does onto the story branch, before
 * the worktree is deleted (#129).
 *
 * The invariant, and it has no exceptions in it: **the framework never deletes a
 * worktree holding changes that reached no ref.** Measured live 2026-09-02 on
 * run `260830-money-and-payments` (workspace W1) — a story's DoD failed, the
 * executor settled it `blocked`, and `git worktree remove --force` took the
 * developer's uncommitted fix with it. The work was gone: no branch, no stash,
 * no reflog, nothing to `git show`. `blocked` is precisely the state a human is
 * going to want to inspect, and it was the one state that destroyed the evidence.
 *
 * Commit-then-prune rather than never-prune, because "recoverable" has to mean
 * recoverable by SHA. A kept directory is recoverable only until somebody runs
 * `tldrx run close`, cleans a temp dir, or opens the next run; a commit on the
 * story branch is recoverable in a year. The message says `wip:` and names the
 * verdict, because this commit is not a story delivered and an audit trail that
 * implied otherwise would be #130 in a different file.
 *
 * Returns null when there was nothing to rescue — the ordinary case, since
 * `commitIfDirty` has already run on every path that reaches `done`.
 */
export async function rescueUncommitted(parts: RescueParts): Promise<RescuedWork | null> {
  const id = parts.storyId;
  // The framework's own state dirs are excluded from the question and from the
  // commit, exactly as `commitIfDirty` excludes them: a worktree of a repo that
  // IS the workspace root also holds `tldrx-work/`, and a rescue that swept the
  // run log into a commit would be a worse record than none.
  const state = stateDirPrefixes(parts.workspaceRoot, parts.repoDir);
  return await parts.write(async () => {
    if (!existsSync(parts.worktree)) return null;
    if (!(await isDirty(parts.worktree, state))) return null;
    const committed = await commitAll(
      parts.worktree,
      `wip(${id}): rescued from a story that settled \`${parts.status}\`\n\n`
      + `${parts.reason ?? "no reason was recorded"}\n\n`
      + "Committed by tldrx before its worktree was pruned, so the work reaches a ref.\n"
      + "Nothing reviewed this and nothing merged it (gh #129).",
      state,
    );
    const sha = committed.ok ? await headSha(parts.worktree) : "";
    if (sha === "") {
      const failure = firstLine(committed.stderr) || firstLine(committed.stdout)
        || "git wrote no commit and said nothing";
      parts.lines.push(
        `  · ${id}: its worktree holds changes that reached NO ref and could not be committed `
        + `(${failure}) — KEEPING ${parts.worktree} rather than deleting the only copy`,
      );
      return { sha: null, branch: parts.branch, worktree: parts.worktree, failure };
    }
    parts.lines.push(
      `  · ${id}: uncommitted work RESCUED to \`${parts.branch}\` as \`${sha}\` `
      + "before its worktree was pruned — `git show " + sha + "`",
    );
    parts.emit("story.work_rescued", {
      phase: parts.phaseId,
      story: id,
      repo: parts.repo,
      branch: parts.branch,
      sha,
      status: parts.status,
    });
    return { sha, branch: parts.branch, worktree: null, failure: null };
  });
}

/** The subject of the epic merged INTO a story — `updateStoryBase` and a conflict turn both write it. */
function storySyncSubject(storyId: string, epicBranch: string): string {
  return `sync(${storyId}): \`${epicBranch}\` moved under this story before it merged back`;
}

/** What `updateStoryBase` needs to bring a story branch onto its epic's tip. */
export interface UpdateParts {
  readonly storyId: string;
  readonly repoDir: string;
  readonly worktree: string;
  readonly branch: string;
  readonly epicBranch: string;
}

/**
 * What became of the attempt — and `current` is the one that costs nothing.
 *
 * `why` on `current` is `null` for the ordinary "the epic has not moved", and a
 * sentence when the answer came from a merge that found nothing to do after a
 * count git could not take: "I looked and there was nothing" and "I could not
 * count, so I looked" are the same INACTION and not the same claim.
 */
export type StoryBaseUpdate =
  | { readonly kind: "current"; readonly why: string | null }
  | {
      readonly kind: "updated";
      readonly from: string;
      readonly to: string;
      /** Commits the epic carried that the story did not. `0` when git could not count. */
      readonly behind: number;
      readonly uncounted: string | null;
    }
  | { readonly kind: "blocked"; readonly conflicts: readonly string[]; readonly detail: string };

/**
 * A story branch brought up to its epic's tip immediately BEFORE it merges back
 * (gh #268).
 *
 * `refreshStoryBase` above answers the same question at the other end of the
 * story — before a developer is dispatched — and that is not enough, because the
 * epic moves in between: a wave runs its stories at `--parallel N` from one tip
 * and merges them one after another, so every story but the first merges from a
 * base that is already behind. Measured live 2026-09-13 (#268): a dependent
 * story whose DoD was green merged into an epic a sibling had moved, got
 * `CONFLICT (content)` in a handler and two of its tests, and settled `blocked`
 * with no rebase attempted and no reviewer run. A person fixed that by hand
 * three times in one week.
 *
 * **A merge, not a rebase, and that is not a preference.** Rewriting a branch a
 * developer has already committed to is the class of move the
 * run-id-in-branch-name fix exists to prevent (2026-08-29 audit §B) and the
 * reason `fastForward` says "never a rebase" two files up; the rescued-work
 * invariant (#129) is also a promise about shas that survive, and a rebase
 * abandons every one of them. `git merge --no-ff <epic>` in the story's own
 * worktree keeps the developer's commits reachable, and it makes the merge back
 * into the epic the trivial one it should have been.
 *
 * **Whether the epic moved is measured, and an unmeasurable answer is not a
 * "no".** `baseStateOf` is the one derivation for that question (§7), and the
 * count behind it returns `null` when git could not answer (#273). "Could not
 * count" is NOT "did not move", so it falls through to the merge — which is a
 * no-op exiting 0 when the branch really was current, and the DoD below is
 * charged on the HEAD SHA MOVING and on nothing else. That is the whole cost
 * rule: a story whose epic did not move pays nothing, whether or not git felt
 * like counting.
 *
 * **A conflict leaves nothing half-applied.** `mergeNoFf` runs `git merge
 * --abort` before it returns, so `blocked` here is a story whose worktree is
 * exactly where the developer left it and an epic that was never opened.
 */
export async function updateStoryBase(parts: UpdateParts): Promise<StoryBaseUpdate> {
  const base = await baseStateOf(parts.repoDir, parts.branch, parts.epicBranch);
  if (base.state === "current" && base.uncounted === null) return { kind: "current", why: null };
  // The same assertion the epic worktree gets on every reuse, for the same
  // reason: this is about to write a merge commit, and a worktree that is not on
  // the branch it is named for would write it somewhere else (#40).
  await assertWorktreeOn(parts.worktree, parts.branch, "story worktree");
  const from = await headSha(parts.worktree);
  const merged = await mergeNoFf(
    parts.worktree,
    parts.epicBranch,
    // `sync(` and not `merge(`, deliberately: `merge(<story>): <title>` is the
    // subject of a STORY landing on the epic, and readers of `git log <epic>`
    // — a person, and `build-parallel.test.ts`'s merge-order assertion — take
    // that prefix to mean exactly that. This commit is the opposite direction.
    storySyncSubject(parts.storyId, parts.epicBranch),
  );
  if (!merged.ok) return { kind: "blocked", conflicts: merged.conflicts, detail: merged.detail };
  const to = await headSha(parts.worktree);
  // `git merge --no-ff` on a branch that already has the epic says "Already up
  // to date" and writes NO commit, so an unmoved HEAD is the measurement that
  // the epic had nothing for this story — including on the uncounted path,
  // where it is the only measurement there is.
  if (to === from || to === "") return { kind: "current", why: base.uncounted };
  return { kind: "updated", from, to, behind: base.behind, uncounted: base.uncounted };
}

/** What a conflict turn's dispatch found when it merged the epic in again (gh #286). */
export type ConflictTurnMerge =
  /** The merge stopped on these files and was LEFT in progress for the developer. */
  | { readonly kind: "conflicted"; readonly files: readonly string[]; readonly epicSha: string; readonly landed: readonly LandedStory[] }
  /** The epic merged in cleanly this time — there is nothing left to resolve. */
  | { readonly kind: "merged"; readonly epicSha: string; readonly landed: readonly LandedStory[] }
  /** git refused the merge for a reason that is not a conflict. */
  | { readonly kind: "failed"; readonly detail: string };

/**
 * gh #286: the merge a conflict turn is handed, redone at dispatch against the
 * epic's CURRENT tip and left open.
 *
 * Redone rather than kept: the conflicting settle aborted its merge (the tree
 * a person or a later run finds must never be half-applied, #268), and the epic
 * may have moved again since — resolving against the tip it has NOW is what
 * gives the resolution a chance to be the last one. A merge still open from a
 * developer that FAILED mid-turn is aborted first, for the same reason.
 */
export async function openConflictTurnMerge(parts: UpdateParts): Promise<ConflictTurnMerge> {
  await assertWorktreeOn(parts.worktree, parts.branch, "story worktree");
  await abortOpenMerge(parts.worktree);
  const since = await headSha(parts.worktree);
  const epicSha = await fullShaOf(parts.repoDir, parts.epicBranch);
  const landed = since === "" ? [] : await storiesLandedSince(parts.repoDir, since, parts.epicBranch);
  const merged = await mergeNoFf(
    parts.worktree,
    parts.epicBranch,
    storySyncSubject(parts.storyId, parts.epicBranch),
    true,
  );
  if (merged.ok) return { kind: "merged", epicSha, landed };
  if (merged.conflicts.length === 0) return { kind: "failed", detail: merged.detail };
  return { kind: "conflicted", files: merged.conflicts, epicSha, landed };
}

/**
 * The sentence a story blocked on a base it could not be brought up to is named
 * with — exported so tests assert the marker and not a word of English prose,
 * and so the operator line and the story's `reason:` cannot drift apart.
 *
 * It names the FILES, because "merge conflict" without them is the refusal that
 * sent three people to `git status` in a worktree the executor had already
 * cleaned up.
 */
export function staleBaseConflict(
  branch: string, epicBranch: string, conflicts: readonly string[], detail: string, where: string,
): string {
  const files = conflicts.length > 0 ? conflicts.join(", ") : detail;
  return `\`${epicBranch}\` moved since \`${branch}\` was cut, and bringing the story up to it `
    + `CONFLICTS in ${files} — nothing was merged and nothing is half-applied. `
    + `Resolve it in ${where} (\`git merge ${epicBranch}\`), then reopen the story`;
}
