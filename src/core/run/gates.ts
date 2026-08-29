/**
 * `tldrx approve` / `tldrx reject` — the human stop in the loop (spec §3, §5).
 *
 * Approve is not a rubber stamp: the stage's declared checks are re-run against
 * what is on disk right now, and a failure refuses the approval and names the
 * check. Reject is the cheap half — it records the note and sends the stage back
 * to `ready` so the next `next` re-runs it with the note as input.
 *
 * Both write through `RunStore`, so the cursor, phase statuses, run status and the
 * budget mirror stay derived rather than hand-maintained.
 */
import type { TldrxEvent } from "../events/Event.ts";
import { runChecks, type CheckOutcome } from "./checks.ts";
import { loadWorkflowPreset, PresetError, type PlannedStage } from "./workflowPreset.ts";
import type { RunStore } from "./RunStore.ts";
import type { RunFile, RunGate, RunPhase, RunStage } from "./RunFile.ts";

export class GateError extends Error {}

export interface GateContext {
  readonly root: string;
  readonly actor: string;
  readonly at: string;
  readonly note: string;
}

export interface ApproveOutcome {
  readonly ok: boolean;
  readonly stage: string;
  readonly phase: string;
  readonly checks: readonly CheckOutcome[];
  /** The first failing check, when `ok` is false and checks are why. */
  readonly failed: CheckOutcome | null;
  /** Where the cursor ended up, or null when the run is finished. */
  readonly advancedTo: { readonly phase: string; readonly stage: string } | null;
  readonly runDone: boolean;
}

export async function approve(store: RunStore, ctx: GateContext): Promise<ApproveOutcome> {
  const entry = requireGate(store, "approve");
  const planned = plannedStage(ctx.root, store.run, entry.stage.id);
  const checks = planned === null ? [] : await runChecks(planned.checks, {
    root: ctx.root,
    runDir: store.runDir,
    stage: planned,
  });

  for (const check of checks) {
    store.append(event(ctx.at, store.runId, entry.stage.id, check.status === "failed" ? "check.failed" : "check.passed", ctx.actor, {
      check: check.id,
      status: check.status,
      detail: check.detail,
    }));
  }
  const failed = checks.find((c) => c.status === "failed") ?? null;
  if (failed !== null) {
    return {
      ok: false, stage: entry.stage.id, phase: entry.phase.id, checks, failed,
      advancedTo: null, runDone: false,
    };
  }

  const next = store.nextEntry();
  store.mutate((run) =>
    mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "done",
      ended_at: stage.ended_at ?? ctx.at,
      gate: { ...stage.gate, status: "approved", by: ctx.actor, at: ctx.at, note: ctx.note } satisfies RunGate,
    })),
  );
  if (next !== null) {
    store.mutate((run) => ({
      ...mapStage(run, next.phase.id, next.stage.id, (stage) => ({ ...stage, status: "ready" })),
      cursor: { phase: next.phase.id, stage: next.stage.id, task: null },
    }));
  }

  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.approved", ctx.actor, {
    phase: entry.phase.id,
    note: ctx.note,
    checks: checks.map((c) => `${c.id}:${c.status}`),
  }));
  store.append(event(ctx.at, store.runId, entry.stage.id, "stage.done", ctx.actor, { phase: entry.phase.id }));
  store.save();

  const runDone = store.run.status === "done";
  if (runDone) {
    store.append(event(ctx.at, store.runId, null, "run.closed", ctx.actor, { reason: "every stage terminal" }));
  }
  return {
    ok: true, stage: entry.stage.id, phase: entry.phase.id, checks, failed: null,
    advancedTo: next === null ? null : { phase: next.phase.id, stage: next.stage.id },
    runDone,
  };
}

export interface RejectOutcome {
  readonly stage: string;
  readonly phase: string;
  readonly note: string;
}

export function reject(store: RunStore, ctx: GateContext): RejectOutcome {
  if (ctx.note.trim() === "") {
    throw new GateError("reject needs --note: a rejection without a reason is not actionable");
  }
  const entry = requireGate(store, "reject");
  store.mutate((run) =>
    mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "ready",
      gate: { ...stage.gate, status: "rejected", by: ctx.actor, at: ctx.at, note: ctx.note } satisfies RunGate,
    })),
  );
  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.rejected", ctx.actor, {
    phase: entry.phase.id,
    note: ctx.note,
  }));
  store.save();
  return { stage: entry.stage.id, phase: entry.phase.id, note: ctx.note };
}

// --- helpers ---------------------------------------------------------------

function requireGate(store: RunStore, verb: string): { phase: RunPhase; stage: RunStage } {
  const entry = store.cursorEntry();
  if (entry === null) {
    throw new GateError(`cursor ${store.run.cursor.phase}/${store.run.cursor.stage} does not resolve to a stage`);
  }
  if (entry.stage.status !== "awaiting_gate") {
    throw new GateError(
      `nothing to ${verb}: ${entry.phase.id}/${entry.stage.id} is \`${entry.stage.status}\`, not \`awaiting_gate\``,
    );
  }
  return entry;
}

function plannedStage(root: string, run: RunFile, stageId: string): PlannedStage | null {
  try {
    return loadWorkflowPreset(root, run.scope).stages.find((s) => s.id === stageId) ?? null;
  } catch (error) {
    if (error instanceof PresetError) return null;
    throw error;
  }
}

function mapStage(run: RunFile, phaseId: string, stageId: string, fn: (stage: RunStage) => RunStage): RunFile {
  return {
    ...run,
    phases: run.phases.map((phase) =>
      phase.id !== phaseId
        ? phase
        : { ...phase, stages: phase.stages.map((stage) => (stage.id === stageId ? fn(stage) : stage)) },
    ),
  };
}

function event(
  ts: string,
  run: string,
  stage: string | null,
  type: TldrxEvent["type"],
  actor: string,
  payload: Record<string, unknown>,
): TldrxEvent {
  return { ts, run, stage, type, actor, cost_usd: 0, payload };
}
