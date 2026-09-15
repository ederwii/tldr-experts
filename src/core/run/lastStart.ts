/**
 * Which MODE started this stage's last turn — the one fact that tells a killed
 * headless spawn apart from a `--prepare` bundle (gh #246).
 *
 * The two leave the SAME shape on disk. `runNext` writes the bundle
 * (`prompt.md` + `pending.json`) before it branches on the mode, so a headless
 * turn has a `pending.json` exactly as a prepared one does; kill the parent and
 * both end as stage `running` + a `.lock` holding a dead pid + a bundle. Readers
 * that looked only at those three called every one of them `prepared` and sent
 * the operator to `tldrx next --commit`, which the next line of code refuses
 * ("what is `ready`, not `running`") — status advice that the code cannot accept
 * is worse than none.
 *
 * `stage.started` already carries `mode`, has since it was first written, and is
 * the only durable record of which invocation opened the turn. So the answer is
 * read off the ledger rather than guessed from the filesystem. The LAST one wins:
 * a stage can be prepared, committed and later re-spawned headless, and it is the
 * most recent start that is the one hanging.
 *
 * Deliberately ONE implementation, in a leaf both `run/waiting.ts` (what the run
 * is waiting on) and `facilitator/interrupt.ts` (what Ctrl-C must not demote)
 * import — those two made the same wrong identification independently, which is
 * what a second copy of a derivation buys you.
 *
 * Reads one file and nothing else, tolerantly and silently: a torn line is
 * skipped (`readAll`, not `read` — this is a derivation, not a report), a missing
 * log is `null`, and `null` means "the ledger does not say", never "headless".
 * Every caller must keep its pre-#246 behaviour on `null`.
 */
import { EventLog } from "../events/EventLog.ts";

/** The `mode` of the newest `stage.started` for this stage, or null if none says. */
export function lastStageStartMode(runDir: string, stageId: string): string | null {
  const events = EventLog.forRun(runDir).readAll().events;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== "stage.started" || event.stage !== stageId) continue;
    const mode = (event.payload as { readonly mode?: unknown }).mode;
    return typeof mode === "string" && mode !== "" ? mode : null;
  }
  return null;
}

/**
 * Was this stage's last turn one the FRAMEWORK spawned?
 *
 * True only for a ledger that says so. A run whose log is missing, torn at that
 * line, or written before `mode` was recorded answers `false` and keeps the old
 * reading — an absent record is not evidence of a spawn.
 */
export function startedHeadless(runDir: string, stageId: string): boolean {
  return lastStageStartMode(runDir, stageId) === "headless";
}
