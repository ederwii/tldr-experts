/**
 * Whether a stage's unfinished stories are unfinished because the STAGE'S OWN
 * MONEY ran short (gh #354), not because anything actually failed — modeled on
 * `rateLimitPark.ts`'s `currentRateLimitPark` (gh #298), which answers the same
 * question for a provider's quota warning. See that file's docstring for the
 * full reasoning; this repeats only what differs.
 *
 * `noteBudgetPark`'s park (`executors/build.ts`) writes exactly one
 * `budget.parked` event per stage invocation when the phase's remainder can no
 * longer fund even the FLOOR of another developer attempt — it carries
 * `parked: <storyId>`. The other shape, `parked_absent: "nothing was left to
 * park…"`, means the shortfall arrived with nothing left to withhold (the
 * stage's last story) and must read as "nothing was withheld".
 *
 * The SAME two failure shapes `currentRateLimitPark` refuses apply here
 * unchanged: a park that does not cover every currently unfinished story (one
 * `blocked` row anywhere in the set is a human's problem, not this park's), and
 * a park from an EARLIER invocation of this stage (scoped to events at or after
 * the stage's own latest `stage.started`).
 *
 * Deliberately NOT unified with `currentRateLimitPark` into one generic reader:
 * the two events carry different fields (a provider's `status`/`window`/
 * `utilization`/`resets_at` versus a phase's `remainder_usd`/`floor_usd`), and
 * their RESUME predicates differ in kind — one is a clock (`rateLimitReadyToResume`,
 * `runAuto.ts`), the other is a ledger balance (`budgetReadyToResume`,
 * `runAuto.ts`) — so the two readers would gain a shared skeleton and lose the
 * plain english of what each field means. Judgement call, stated here rather than
 * asserted silently (AGENTS.md §1).
 *
 * ONE reader (AGENTS.md §7): `run auto`'s money-resume (`runAuto.ts`) and `run
 * status`'s "held by stories" line (`waiting.ts`) both call
 * `currentBudgetPark`, off the same predicate, so the two can never describe a
 * park differently.
 */
import { EventLog } from "../events/EventLog.ts";
import { storiesView } from "./runOutcome.ts";

export interface BudgetPark {
  /** What the stage had left at the moment it parked. */
  readonly remainderUsd: number;
  /** The least a developer may be dispatched with — what the remainder fell short of. */
  readonly floorUsd: number;
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
export function currentBudgetPark(runDir: string, stageId: string): BudgetPark | null {
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
  if (stageStartIndex === -1) return null;
  let park: BudgetPark | null = null;
  for (let index = events.length - 1; index >= stageStartIndex; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== "budget.parked" || event.stage !== stageId) continue;
    const payload = event.payload as Record<string, unknown>;
    const parked = payload.parked;
    if (typeof parked !== "string" || parked === "") continue;
    if (typeof payload.remainder_usd !== "number" || typeof payload.floor_usd !== "number") continue;
    park = { remainderUsd: payload.remainder_usd, floorUsd: payload.floor_usd, parked };
    break;
  }
  if (park === null) return null;
  const view = storiesView(runDir);
  if (view === null || view.unfinished.length === 0) return null;
  if (view.unfinished.some((story) => story.status !== "todo")) return null;
  return park;
}
