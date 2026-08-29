/**
 * What happened to one story — the record everything downstream renders from.
 *
 * The handoff, the review log, `run status` and the story's own `evidence:` are
 * four views of this one object, which is why it carries the raw results (exit
 * codes, conflict paths, the commit sha) rather than sentences about them.
 */
import type { PlanStatus } from "../schemas/planCommon.ts";

export type Verdict = "approve" | "changes" | "n-a";

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
  /** `done`, `blocked`, or `review` when it is waiting for its second attempt. */
  readonly status: PlanStatus;
  /** How many developer attempts this story took (1 or 2). */
  readonly attempts: number;
  readonly dod: readonly DodResult[];
  readonly commit: string | null;
  readonly merged: boolean;
  readonly conflicts: readonly string[];
  readonly verdict: Verdict;
  readonly reviewSummary: string;
  readonly reviewFindings: readonly string[];
  /** Run-relative path of the review log — every Finding cites it. */
  readonly reviewRel: string;
  /** One line saying why, when the story did not reach `done`. */
  readonly reason: string | null;
  readonly cost_usd: number;
}

export function dodGreen(outcome: Pick<StoryOutcome, "dod">): boolean {
  return outcome.dod.length > 0 && outcome.dod.every((r) => r.exitCode === 0 && !r.timedOut);
}

/** One line for `run status` and the executor's stdout: `S1 done`, `S2 blocked`. */
export function describeOutcome(outcome: StoryOutcome): string {
  return `${outcome.id} ${outcome.status}`;
}
