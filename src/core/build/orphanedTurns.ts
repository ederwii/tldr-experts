/**
 * Which of a Build-executor stage's `agent.spawned` turns no `agent.result` has
 * answered yet — the story-level counterpart of `interrupt.ts`'s `openAttempt`
 * (that one joins by the `run.yml` task id a killed SIGINT/SIGTERM turn never
 * got as far as writing; this one joins by the `story` key a Build turn's
 * `agent.spawned`/`agent.result` pair carries instead, gh #337).
 *
 * Used ONLY by `demoteStaleRunning` (`facilitator/runNext.ts`), at the moment a
 * stale `.lock` (a dead pid) is found holding a Build-executor phase's stage
 * `running` — the one case a Build phase is EVER found `running` with nobody
 * home, since it is driven synchronously start to finish by this same process
 * and has no `--prepare`/host-write path of its own. Every open turn read here
 * is therefore genuinely orphaned: its `claude` child may still be running to
 * completion independently, exactly `#246`/`#337`'s field case, and the parent
 * that would have read its result line is the dead pid.
 *
 * `costView.ts`'s `storyLedger` computes the SAME open/lost pairing, but only
 * as an aggregate count reached AFTER a `closesAttempt` event (a fresh
 * `stage.started`, which the resumed invocation has not appended yet at the
 * point `demoteStaleRunning` runs) — it answers "how many turns is this story
 * missing for `tldrx cost`'s per-story ceiling view", not "which turns, right
 * now, so a task row can be written for each". Reading the ledger's raw events
 * once more here, scoped to one stage, is cheaper than reshaping `storyLedger`
 * to expose per-turn identity it has no other caller for.
 */
import { EventLog } from "../events/EventLog.ts";

export interface OpenBuildTurn {
  readonly story: string;
  readonly role: string | null;
  readonly model: string | null;
  /** The `agent.spawned` event's own timestamp — closer to the truth than the
   *  stage's `started_at`, which is shared by every story the stage ever ran. */
  readonly startedAt: string;
}

export function openBuildTurns(runDir: string, phaseId: string, stageId: string): readonly OpenBuildTurn[] {
  const open = new Map<string, OpenBuildTurn>();
  for (const event of EventLog.forRun(runDir).read()) {
    if (event.stage !== stageId) continue;
    const payload = event.payload as { phase?: unknown; story?: unknown; key?: unknown; role?: unknown; model?: unknown };
    if (typeof payload.phase === "string" && payload.phase !== phaseId) continue;
    if (event.type === "agent.spawned") {
      const story = typeof payload.story === "string" ? payload.story : null;
      if (story === null) continue;
      open.set(story, {
        story,
        role: typeof payload.role === "string" ? payload.role : null,
        model: typeof payload.model === "string" ? payload.model : null,
        startedAt: event.ts,
      });
    } else if (event.type === "agent.result") {
      const key = typeof payload.key === "string" ? payload.key : null;
      if (key !== null) open.delete(key);
    }
  }
  return [...open.values()];
}
