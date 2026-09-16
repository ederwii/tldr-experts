/**
 * Whether a stage's unfinished stories are unfinished because the PROVIDER
 * parked them (gh #298), not because anything actually failed — and, if so,
 * when the provider's own clock says it clears (gh #367).
 *
 * `noteRateLimit` (`executors/build.ts`) writes exactly one `agent.rate_limited`
 * event per stage invocation when a warning actually withholds a story — it
 * carries `parked: <storyId>`. Two OTHER shapes of the same event type exist and
 * both must read as "nothing was withheld": `parked_absent: "nothing was left to
 * park…"` (the warning landed on the stage's last story) and, since gh #367,
 * `parked_absent: "below the …% park threshold…"` (the warning never parked at
 * all). Only the `parked` shape means a story is sitting `todo` for this reason.
 *
 * A raw "last `parked` event on this stage" reader is NOT enough (caught on
 * review, gh #367): `storiesCondition` (`autoGate.ts`) collapses every
 * unfinished story into the single `stories` id (#210), so a gate held by
 * `stories` alone says nothing about WHICH stories are unfinished or why. Two
 * failure shapes follow, and `currentRateLimitPark` below is what refuses both:
 *
 *   - **Wrong stories.** A park on S1 explains S1 (and, by the mechanism, every
 *     story AFTER it that the same invocation never got to dispatch — all of
 *     which stay plain `todo`). It explains nothing about an S2 that is
 *     `blocked` by a reviewer, a crash, or anything else a rate-limit frame
 *     cannot possibly be about. So the park counts only when EVERY currently
 *     unfinished story is a plain, never-attempted `todo` — one `blocked` (or
 *     any other non-`todo`) row anywhere in the set means a human has to look,
 *     exactly as before this file existed.
 *   - **Wrong attempt.** Events accumulate for the whole run; a park recorded
 *     on an EARLIER invocation of this stage is history, not the current
 *     park — an attempt that does not warn writes no new event at all. Scoped
 *     to events at or after this stage's own LATEST `stage.started`, so a stale
 *     park from a previous attempt is never read as live.
 *
 * ONE reader (AGENTS.md §7): `run auto`'s timed-resume (`runAuto.ts`) and `run
 * status`'s "held by stories" line (`waiting.ts`) both call
 * `currentRateLimitPark`, off the same predicate, so the two can never describe
 * a park differently.
 *
 * Tolerant like `lastStart.ts`'s `lastStageStartMode`, for the same reason: a
 * torn log, an unreadable run, or a stage with no recorded start (an old
 * `run.yml`, written before `stage.started` carried one) answers null — never a
 * guess, and never a resume this file cannot prove is safe.
 */
import { EventLog } from "../events/EventLog.ts";
import { storiesView } from "./runOutcome.ts";

export interface RateLimitPark {
  readonly status: string;
  readonly window: string | null;
  readonly utilization: number | null;
  /** Epoch SECONDS, as the provider stated it — null when it named none. */
  readonly resetsAt: number | null;
  /** The story id this event withheld. */
  readonly parked: string;
}

/**
 * The park BEHIND a stage's current `stories`-only refusal, or null.
 *
 * Null covers three different "not this" answers on purpose, none of them
 * distinguished further: no park was ever recorded for this stage, the one
 * recorded is from an earlier attempt, or it does not account for every story
 * this invocation still has unfinished. Every one of those is the same
 * instruction to a caller — treat this as an ordinary held gate, not a park.
 */
export function currentRateLimitPark(runDir: string, stageId: string): RateLimitPark | null {
  let events;
  try {
    events = EventLog.forRun(runDir).readAll().events;
  } catch {
    return null;
  }
  let stageStartIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.stage === stageId && event.type === "stage.started") {
      stageStartIndex = index;
      break;
    }
  }
  // No recorded start for this stage at all: nothing here can prove a park is
  // from the CURRENT attempt, so none is trusted (the safe direction).
  if (stageStartIndex === -1) return null;
  let park: RateLimitPark | null = null;
  for (let index = events.length - 1; index >= stageStartIndex; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== "agent.rate_limited" || event.stage !== stageId) continue;
    const payload = event.payload as Record<string, unknown>;
    const parked = payload.parked;
    // The two "nothing withheld" shapes carry `parked_absent`, not `parked` —
    // skip them rather than read a park where there is none.
    if (typeof parked !== "string" || parked === "") continue;
    park = {
      status: typeof payload.status === "string" ? payload.status : "",
      window: typeof payload.window === "string" ? payload.window : null,
      utilization: typeof payload.utilization === "number" ? payload.utilization : null,
      resetsAt: typeof payload.resets_at === "number" ? payload.resets_at : null,
      parked,
    };
    break;
  }
  if (park === null) return null;
  // Coverage: every unfinished story must be a plain `todo` — the shape every
  // story downstream of a park sits in, having never been dispatched. Anything
  // else (`blocked`, `review`, `in_progress`) is a story the park cannot
  // possibly be the reason for, and this stops being "the" explanation.
  const view = storiesView(runDir);
  if (view === null || view.unfinished.length === 0) return null;
  if (view.unfinished.some((story) => story.status !== "todo")) return null;
  return park;
}
