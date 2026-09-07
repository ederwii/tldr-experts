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
import type { PlanStatus } from "../schemas/planCommon.ts";
import {
  addWorktree, assertWorktreeOn, baseStateOf, commitAll, dirtyPaths, fastForward, firstLine, headSha,
  isDirty, mergeNoFf, partitionDirty, pathAtRef, stateDirPrefixes,
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
    `merge(${parts.storyId}): ${parts.storyTitle}`,
  );
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
 * run `260830-money-and-payments` (aparece-v2) — a story's DoD failed, the
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
