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
 * all). Only the `parked` shape means a story is sitting `todo`/`blocked` for
 * this reason.
 *
 * ONE reader (AGENTS.md §7): `run auto`'s timed-resume (`runAuto.ts`) and `run
 * status`'s "held by stories" line (`waiting.ts`) both call this, off the same
 * event, so the two can never describe a park differently.
 *
 * Tolerant like `lastStart.ts`'s `lastStageStartMode`, for the same reason: a
 * torn log or an unreadable run answers null, never a guess.
 */
import { EventLog } from "../events/EventLog.ts";

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
 * The LAST `agent.rate_limited` event this stage recorded that actually
 * withheld a story, or null when none did (including when the log has no
 * `agent.rate_limited` event for this stage at all).
 */
export function lastRateLimitPark(runDir: string, stageId: string): RateLimitPark | null {
  let events;
  try {
    events = EventLog.forRun(runDir).readAll().events;
  } catch {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== "agent.rate_limited" || event.stage !== stageId) continue;
    const payload = event.payload as Record<string, unknown>;
    const parked = payload.parked;
    // The two "nothing withheld" shapes carry `parked_absent`, not `parked` —
    // skip them rather than read a park where there is none.
    if (typeof parked !== "string" || parked === "") continue;
    return {
      status: typeof payload.status === "string" ? payload.status : "",
      window: typeof payload.window === "string" ? payload.window : null,
      utilization: typeof payload.utilization === "number" ? payload.utilization : null,
      resetsAt: typeof payload.resets_at === "number" ? payload.resets_at : null,
      parked,
    };
  }
  return null;
}
