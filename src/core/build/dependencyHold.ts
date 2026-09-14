/**
 * What a story does about a dependency that is not `done` when its wave comes up
 * (#260, #263, #280) — the ONE derivation the Build loop asks, and the one
 * sentence it records, so the writer and the reader of that sentence cannot
 * drift.
 *
 * Two kinds of hold, and the whole of #280 is that they were one. A dependency
 * that will NOT become `done` in this loop — `blocked`, or `todo` after its
 * developer died (#263) — BLOCKS the dependent: nothing fans out over code that
 * was never landed, and the row says why. A dependency at `review` or
 * `in_progress` is a story mid-pipeline in THIS loop: `pendingStories` offers it
 * again on the very next invocation, and one re-review or one fix round from now
 * it is `done`. A dependent that recorded a terminal `blocked` over it confused
 * "not yet" with "never" — measured on a live run, where two dependents sat
 * `blocked` behind a story that turned `done` two polls later, until a person
 * reopened them by hand. So that dependency is a WAIT: the dependent's row is
 * left untouched at `todo`, and the next invocation asks again.
 *
 * Everything here takes data and returns data (AGENTS.md §12): the loop owns the
 * statuses and the files, this file owns the rule and the words.
 */
import type { PlanStatus } from "../schemas/planCommon.ts";
import { WHY_NOT_DONE_HEADING } from "./review.ts";

/** One dependency that is not `done`, with the status it is at. */
export interface DependencyHold {
  readonly id: string;
  readonly status: PlanStatus;
}

/**
 * True when the dependency is mid-pipeline in this loop and will be offered
 * again by the next invocation — so the dependent should WAIT, not block.
 *
 * `review` and `in_progress` only. `todo` is deliberately NOT here: after its
 * wave has run, a `todo` dependency is one whose developer died before it did
 * anything (#263), and whether the loop offers it again is `--retry-failed`'s
 * decision, not this file's — the dependent blocks with the reason, and the
 * stale-hold rule below releases it the moment the dependency is `done`.
 */
export function dependencyIsPending(status: PlanStatus): boolean {
  return status === "review" || status === "in_progress";
}

/**
 * The hold that decides a story's fate, given every dependency that is not
 * `done` in `depends_on` order — or null when the list is empty.
 *
 * A terminal hold wins over a pending one, whatever the order: a story with one
 * dependency at `review` and another `blocked` is not waiting for anything, it
 * is blocked, and a reason that named the `review` one would send the reader
 * after the wrong story.
 */
export function decidingHold(holds: readonly DependencyHold[]): DependencyHold | null {
  return holds.find((hold) => !dependencyIsPending(hold.status)) ?? holds[0] ?? null;
}

/**
 * The one sentence a story BLOCKED by a dependency records as its reason (#260).
 *
 * The `blocked` case reads exactly as #260 specified it, not through a
 * status-substituting template that would say `dependency S7 is blocked`.
 */
export function dependencyHoldReason(held: DependencyHold): string {
  return held.status === "blocked"
    ? `dependency ${held.id} blocked`
    : `dependency ${held.id} is \`${held.status}\`, not \`done\``;
}

/**
 * The reason a story WAITING on a dependency is named with in `## Unknowns`
 * (#280) — the row has no outcome, so this is the sentence beside "scheduled
 * and never started, and is still `todo`".
 */
export function dependencyWaitReason(held: DependencyHold): string {
  return `it waits on dependency ${held.id}, which is \`${held.status}\` and is offered again by the next ` +
    `invocation; ${held.id} \`done\` is what releases it, and no reopen is owed`;
}

/** The operator line for a wait — one per pass, so the report says what it did not start and why. */
export function dependencyWaitLine(storyId: string, held: DependencyHold): string {
  return `  · ${storyId} waits on ${held.id}, which is \`${held.status}\` — left \`todo\`, not \`blocked\`: ` +
    `it is asked again once ${held.id} settles`;
}

/**
 * The dependency a recorded hold reason names, or null when the reason is not
 * a dependency hold — the reading half of `dependencyHoldReason`, and the ONE
 * place that sentence is turned back into an id (§7).
 *
 * Anchored at both ends on purpose: `dependency S1 blocked` is the whole reason,
 * and a reviewer's prose that happens to contain those words is a different
 * record with a different verdict.
 */
export function dependencyNamedByHold(reason: string): string | null {
  const found = /^dependency (\S+) (?:blocked|is `\w+`, not `done`)$/.exec(reason.trim());
  return found?.[1] ?? null;
}

/**
 * The dependency a story's review log says blocked it, or null when the log
 * records anything else (an attempt, a verdict, no reason at all).
 *
 * Read off `04-build/log/<id>.md`'s `## Why it is not done` — the record
 * `blockOnDependency` writes and the only one it writes that survives the
 * process: it emits no event (there was no attempt to close), and the handoff is
 * rewritten from the ledger on every invocation. This is what lets the NEXT
 * invocation tell a row it blocked itself, for a dependency that has since
 * landed, from a row a reviewer blocked with a verdict (#280).
 */
export function dependencyHoldOfLog(log: string): string | null {
  const lines = log.split("\n");
  const start = lines.indexOf(WHY_NOT_DONE_HEADING);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim()).filter((line) => line !== "");
  return body.length === 1 && body[0] !== undefined ? dependencyNamedByHold(body[0]) : null;
}
