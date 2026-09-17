/**
 * What Ctrl-C has to do besides stopping.
 *
 * The 2026-08-29 resumability audit's first finding: there was NO signal handler
 * on the run path. Ctrl-C during `tldrx next` left three things behind — a
 * detached `claude` still working and still billing, a `.lock` holding a pid that
 * no longer existed, and a stage stuck on `running` whose attempt appears nowhere
 * in `events.jsonl`, because the cost is only written after the spawn returns.
 * The files resumed; the process and the money did not.
 *
 * So an interrupt now does the four things a clean stop would have done:
 *
 *   1. kill the sub-agent's whole process tree      (`runtime/children.ts`)
 *   2. record a PARTIAL `agent.result` on the attempt that was killed
 *   3. release the run's `.lock` and demote `running` → `ready`
 *   4. exit 130
 *
 * Step 2 is the one that is easy to get wrong. The cost of a turn killed halfway
 * is UNKNOWN — the sub-agent never printed its total, and there is no honest
 * number to write. So the EVENT ENVELOPE carries `cost_usd: 0` (the schema
 * requires a number ≥ 0 there), but the task ROW in `run.yml` and the event
 * PAYLOAD both carry `cost_usd: null` + `metered: false` (gh #355 — a `0` there
 * used to pass silently and read as a measured $0.00 to `tallyOf`), with
 * `stopped_by: "signal"` on the payload besides. A reader that sees the payload
 * or the task row knows the attempt happened and knows its cost is not
 * knowable; a reader that only sums the envelope is not silently told it was
 * free.
 *
 * Everything here is SYNCHRONOUS and never throws. It runs inside a signal
 * handler, where an unhandled rejection is a hang and a throw is a lost run.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { RunStore } from "../run/RunStore.ts";
import { hasPreparedBundle } from "../run/prepared.ts";
import { startedHeadless } from "../run/lastStart.ts";
import { releaseLock } from "./Lock.ts";

/** What the CLI knows at the moment the signal landed. */
export interface InterruptContext {
  readonly signal: string;
  /** How many child process trees were killed. 0 ⇒ nothing was in flight. */
  readonly killed: number;
  readonly actor: string;
  readonly at: string;
}

export type InterruptHook = (context: InterruptContext) => readonly string[];

const hooks = new Set<InterruptHook>();

/** Register a hook and get its remover back. Call the remover in a `finally`. */
export function onInterrupt(hook: InterruptHook): () => void {
  hooks.add(hook);
  return () => { hooks.delete(hook); };
}

/** Run every hook. Never throws: one bad hook must not stop the others. */
export function runInterruptHooks(context: InterruptContext): readonly string[] {
  const lines: string[] = [];
  for (const hook of [...hooks]) {
    try {
      lines.push(...hook(context));
    } catch (error) {
      lines.push(`  (could not finish cleaning up: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines;
}

/** For tests: forget every hook. Nothing in `src/` calls this. */
export function clearInterruptHooks(): void {
  hooks.clear();
}

/**
 * Close out whatever `runDir` had in flight, and say what it did.
 *
 * Reads run.yml back off DISK rather than trusting an in-memory store: the
 * facilitator saved before it spawned (that is what put the stage on `running`),
 * so disk is the truth, and a handler holding a stale object would write the run
 * backwards.
 */
export function stopInFlightRun(runDir: string, context: InterruptContext): readonly string[] {
  const lines: string[] = [];
  let store: RunStore;
  try {
    store = RunStore.open(runDir);
  } catch {
    // A run we cannot read is a run we must not write. Drop the lock and stop.
    releaseLock(runDir);
    return [`  ${basename(runDir)}: run.yml could not be read; released the .lock and left the rest alone`];
  }

  const running: { phase: string; stage: string }[] = [];
  for (const phase of store.run.phases) {
    for (const stage of phase.stages) {
      if (stage.status === "running") running.push({ phase: phase.id, stage: stage.id });
    }
  }

  // A `--prepare` bundle nobody has committed is NOT an interrupted spawn: the
  // work is on disk waiting for a human, and demoting it to `ready` would hand
  // the next `tldrx next` a licence to re-run the stage. Leave it exactly where
  // it is — `waitingFor` reports it as `prepared` and says what to do.
  //
  // `killed === 0` plus a bundle is NOT enough to identify one, though (#246): a
  // headless spawn leaves the same `pending.json`, so a Ctrl-C that found no
  // child to kill — the child already dead, or never started — preserved an
  // interrupted headless stage as `running` forever. The ledger's last
  // `stage.started` says which mode opened the turn, and a headless one is closed
  // like any other. `startedHeadless` is false when the ledger does not say, so
  // an unreadable log keeps the pre-#246 behaviour.
  const preserved = context.killed === 0
    ? running.filter((entry) => hasPreparedBundle(runDir, entry.stage) && !startedHeadless(runDir, entry.stage))
    : [];
  const preservedIds = new Set(preserved.map((entry) => `${entry.phase}/${entry.stage}`));
  const toClose = running.filter((entry) => !preservedIds.has(`${entry.phase}/${entry.stage}`));

  for (const entry of toClose) {
    if (context.killed > 0) recordPartialResult(store, entry.phase, entry.stage, context, lines);
  }
  if (toClose.length > 0) {
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) =>
          stage.status === "running" && toClose.some((e) => e.phase === phase.id && e.stage === stage.id)
            ? { ...stage, status: "ready" as const }
            : stage),
      })),
    }));
    try {
      store.save();
      lines.push(`  ${store.runId}: demoted ${toClose.map((e) => `${e.phase}/${e.stage}`).join(", ")} to ready`);
    } catch (error) {
      lines.push(`  ${store.runId}: could not write run.yml (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  for (const entry of preserved) {
    lines.push(
      `  ${store.runId}: left ${entry.phase}/${entry.stage} running — its --prepare bundle is still waiting ` +
        `(\`tldrx next --commit ${store.runId}\`)`,
    );
  }

  if (existsSync(`${runDir}/.lock`)) {
    releaseLock(runDir);
    lines.push(`  ${store.runId}: released the .lock`);
  }
  return lines;
}

/**
 * One `agent.result` for the attempt that was killed, and a matching task row.
 *
 * The task id is taken from the last `agent.spawned` this stage recorded that has
 * no `agent.result` after it — that is, by construction, the turn we just killed.
 */
function recordPartialResult(
  store: RunStore,
  phaseId: string,
  stageId: string,
  context: InterruptContext,
  lines: string[],
): void {
  const taskId = openAttempt(store.runDir, phaseId, stageId);
  if (taskId === null) return;
  const error = `stopped by ${context.signal} — the sub-agent was killed mid-turn; its cost is not knowable`;

  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) => phase.id !== phaseId ? phase : ({
      ...phase,
      stages: phase.stages.map((stage) => stage.id !== stageId ? stage : ({
        ...stage,
        tasks: [...stage.tasks, {
          id: taskId,
          status: "failed" as const,
          expert: stage.expert,
          model: stage.model,
          // Not zero — unknown (gh #355). `null` + `metered: false` is the same
          // idiom every other unknown-cost turn in this codebase writes
          // (`executors/build.ts`'s `cost === null ? { metered: false } : {}`,
          // and `runNext.ts`'s orphaned-headless-turn row, gh #337) — the one
          // spelling `tallyOf`/`spendBasisOf` (`budget/spentFigure.ts`,
          // `budget/spendBasis.ts`) read as an honest LOWER BOUND rather than a
          // measured `$0.00`. A `0` here used to pass `RunFile.ts`'s validator
          // silently, because the validator's null↔metered:false rule has
          // nothing to say about a zero.
          cost_usd: null,
          metered: false,
          error,
          session_id: null,
          started_at: stage.started_at,
          ended_at: context.at,
          outputs: [],
        }],
      })),
    })),
  }));

  const event: TldrxEvent = {
    ts: context.at,
    run: store.runId,
    stage: stageId,
    type: "agent.result",
    actor: context.actor,
    cost_usd: 0,
    // `metered: false` alongside the existing `cost_usd: null`, gh #355: a
    // payload reader gets the named field every other unknown-cost payload
    // carries, not just a null value it has to already know to key off.
    payload: { phase: phaseId, task: taskId, cost_usd: null, metered: false, stopped_by: "signal", signal: context.signal },
  };
  const failure = EventLog.forRun(store.runDir).tryAppend(event);
  lines.push(failure === null
    ? `  ${store.runId}: recorded a partial agent.result for ${phaseId}/${stageId} ${taskId} (cost unknown)`
    : `  ${store.runId}: could not record the partial agent.result (${failure})`);
}

/**
 * The task id of the attempt that started and never finished, or null.
 *
 * Read off the ledger rather than run.yml because `agent.spawned` is appended
 * BEFORE the spawn and the task row is only written after it returns — which is
 * exactly the gap an interrupt falls into.
 */
function openAttempt(runDir: string, phase: string, stage: string): string | null {
  let spawned: string | null = null;
  for (const event of EventLog.forRun(runDir).readAll().events) {
    if (event.stage !== stage) continue;
    const payload = event.payload as { phase?: unknown; task?: unknown };
    if (typeof payload.phase === "string" && payload.phase !== phase) continue;
    if (event.type === "agent.spawned") spawned = typeof payload.task === "string" ? payload.task : null;
    else if (event.type === "agent.result" && spawned !== null && payload.task === spawned) spawned = null;
  }
  return spawned;
}
