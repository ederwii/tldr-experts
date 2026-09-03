/**
 * What happened to one story — the record everything downstream renders from.
 *
 * The handoff, the review log, `run status` and the story's own `evidence:` are
 * four views of this one object, which is why it carries the raw results (exit
 * codes, conflict paths, the commit sha) rather than sentences about them.
 */
import type { PlanStatus } from "../schemas/planCommon.ts";

/**
 * What the reviewer said — and, for `error`, that it never got to say anything.
 *
 * `approve` and `changes` are VERDICTS: a person's judgement of the diff,
 * delivered. `n-a` is "no reviewer ran for this story". `error` is the fourth
 * case, and it exists because it used to be recorded as the second: a reviewer
 * that died mid-read — spawn failure, timeout, exhausted `--max-budget-usd` —
 * was written down as `changes`, which consumed the story's one requeue and sent
 * a fresh developer at code nobody had faulted. Measured 2026-08-30 on run
 * `260830-tenancy-identity-customers`: a $0.26 reviewer on a 39-file, +1879-line
 * diff exited with `Reached maximum budget ($0.26)` and the story was reported
 * as "the reviewer asked for changes".
 *
 * Fail-closed is right — an unfinished review is never an approval. Inventing the
 * verdict is not.
 *
 * `fixlist` is the fifth, and it is the one the OTHER four could not express: a
 * reviewer that signed and still has findings. Measured 2026-08-31 on story S5 of
 * `260830-tenancy-identity-customers` — every acceptance criterion met, zero
 * scope violations, and three real correctness/security defects the criteria
 * never covered. `approve` discards them; `changes` spends the story's one
 * requeue on a diff nobody faulted. So `fixlist` settles the story at `review`,
 * spends NO attempt, and is bounded at one round (`MAX_FIXLIST_ROUNDS`) — a free
 * round that could be taken twice is a story that never has to settle.
 */
export type Verdict = "approve" | "changes" | "n-a" | "error" | "fixlist";

export interface DodResult {
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** Last meaningful line of the combined output — the operator's first clue. */
  readonly tail: string;
}

/**
 * Work that was in the story worktree and in no ref, when the framework was
 * about to delete the worktree (#129).
 *
 * Measured live 2026-09-02 on run `260830-money-and-payments`: a DoD failed, the
 * story settled `blocked`, and `git worktree remove --force` took the developer's
 * fix with it. `blocked` is the state a human is most likely to want to inspect,
 * so the one path that must never destroy anything destroyed everything.
 *
 * Two shapes, and they are the two honest answers. `sha` set: the changes were
 * committed to the story branch first, and `git show <sha>` gets them back.
 * `sha` null: they could NOT be committed, `failure` says why, and the worktree
 * was kept rather than pruned — because a tree holding the only copy of somebody's
 * work is not the framework's to delete.
 */
export interface RescuedWork {
  /** The rescue commit, or null when none could be made. */
  readonly sha: string | null;
  /** The branch it landed on — the story branch. */
  readonly branch: string;
  /** Where the tree still is, when it was KEPT. Null once it has been pruned. */
  readonly worktree: string | null;
  /** Why nothing could be committed. Measured from git, never guessed. */
  readonly failure: string | null;
}

export interface StoryOutcome {
  readonly id: string;
  readonly title: string;
  readonly wave: string;
  readonly repo: string;
  readonly epic: string;
  readonly epicBranch: string;
  readonly branch: string;
  /**
   * `done`, `blocked`, or `review` when it is waiting for something more.
   *
   * `review` carries two different situations, told apart by `verdict`: a
   * `changes` verdict means the DEVELOPER is owed another attempt, and an `error`
   * means only the REVIEW is missing — the diff is merged and its DoD was green.
   */
  readonly status: PlanStatus;
  /** How many developer attempts this story took (1 or 2). */
  readonly attempts: number;
  readonly dod: readonly DodResult[];
  /**
   * DoD commands the story's plan DECLARES whose results could not be recovered
   * — set only on a row rebuilt from disk for a story an earlier `tldrx next`
   * settled, and only when `events.jsonl` holds no `check` for them.
   *
   * It exists so that an empty `dod` has two readings and the documents can tell
   * them apart. `dod: []` with this empty means the story declares no commands,
   * and "no Definition of Done ran" is true. `dod: []` with commands listed here
   * means results EXIST and this process could not read them — a different fact,
   * and rendering it as the first is the false claim #137 was filed for.
   */
  readonly dodUnrecovered?: readonly string[];
  readonly commit: string | null;
  readonly merged: boolean;
  /**
   * How many commits the story branch carried beyond the epic when it merged.
   *
   * `0` is a merge that moved NOTHING — `git merge` says "Already up to date"
   * and exits 0, and until 2026-08-30 the handoff rendered that as "merged".
   * On run `260830-tenancy-identity-customers` the Gate section read
   * "(S1, S3, S5, S4, S7 merged)" when only S1's merge carried a commit and the
   * other four branches were byte-identical to the epic.
   *
   * `null` means this invocation did not measure it — a story merged by an
   * earlier `tldrx next`, which is known to have merged and not known to have
   * carried nothing.
   */
  readonly carried: number | null;
  readonly conflicts: readonly string[];
  readonly verdict: Verdict;
  /**
   * What the DEVELOPER sub-agent died with, when it never delivered — a spawn
   * failure, a timeout, an exhausted `--max-budget-usd`. Null on every story
   * whose developer RAN, whatever it produced.
   *
   * This is the developer-side sibling of `verdict: "error"`, and it exists for
   * the same reason: on `260830-tenancy-identity-customers` five developers died
   * with `Reached maximum budget (…)` before writing a line, and each one was
   * recorded as a story `blocked` after a consumed attempt. A sub-agent that
   * never ran is not an attempt, and `verdict` stays `n-a` here because that is
   * the truth: no reviewer judged anything.
   */
  readonly developerError: string | null;
  readonly reviewSummary: string;
  readonly reviewFindings: readonly string[];
  /** Run-relative path of the review log — every Finding cites it. */
  readonly reviewRel: string;
  /** One line saying why, when the story did not reach `done`. */
  readonly reason: string | null;
  /**
   * Uncommitted work found in the worktree as the story settled — null on the
   * ordinary case, where `commitIfDirty` already put every byte on the branch.
   */
  readonly rescued: RescuedWork | null;
  readonly cost_usd: number;
}

/** What the executor records when the spawn layer had nothing else to say. */
export const DEVELOPER_FAILED = "the developer sub-agent failed";

/** True when the merge that put this story on its epic moved no commits. */
export function mergedNothing(outcome: Pick<StoryOutcome, "carried">): boolean {
  return outcome.carried === 0;
}

export function dodGreen(outcome: Pick<StoryOutcome, "dod">): boolean {
  return outcome.dod.length > 0 && outcome.dod.every((r) => r.exitCode === 0 && !r.timedOut);
}

/** One line for `run status` and the executor's stdout: `S1 done`, `S2 blocked`. */
export function describeOutcome(outcome: StoryOutcome): string {
  return `${outcome.id} ${outcome.status}`;
}
