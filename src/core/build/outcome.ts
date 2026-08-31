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
 */
export type Verdict = "approve" | "changes" | "n-a" | "error";

export interface DodResult {
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** Last meaningful line of the combined output — the operator's first clue. */
  readonly tail: string;
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
