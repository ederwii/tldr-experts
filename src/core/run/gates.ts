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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TldrxEvent } from "../events/Event.ts";
import { gateEvidenceRelPath } from "../text/evidence.ts";
import { runChecks, type CheckOutcome } from "./checks.ts";
import { loadWorkflowPreset, PresetError, type PlannedStage } from "./workflowPreset.ts";
import type { RunStore } from "./RunStore.ts";
import type { RunFile, RunGate, RunGateEvidence, RunPhase, RunStage } from "./RunFile.ts";

export class GateError extends Error {}

/**
 * The evidence an `agent` gate is closed over (design §A.5), handed to `approve`
 * already validated.
 *
 * `approve` does two things with it and neither is a judgement: it COPIES the
 * note into the run tree, where it is committed and auditable from a clone, and
 * it records the headline counts on the gate. Whether the note is any good was
 * settled before it got here — by `agentGate.ts` at `next`, or by
 * `approve --as-agent` at the CLI — because a validator that ran inside the
 * write path would be a second one, and the looser of two would win the argument
 * at exactly the moment a gate is being signed.
 */
export interface GateEvidenceInput {
  /** The note's bytes, verbatim. Copied, never rewritten. */
  readonly text: string;
  /** What goes on `gate.evidence`; `path` is `approve`'s to decide. */
  readonly record: Omit<RunGateEvidence, "path">;
}

export interface GateContext {
  readonly root: string;
  readonly actor: string;
  readonly at: string;
  readonly note: string;
  /** Present only when an `agent` policy is closing this gate. */
  readonly evidence?: GateEvidenceInput;
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
  /** Run-relative path of the committed evidence copy, when one was made. */
  readonly evidencePath: string | null;
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
      advancedTo: null, runDone: false, evidencePath: null,
    };
  }

  // The run-tree copy is written BEFORE the gate is signed, so a gate that says
  // it rests on evidence always has the evidence beside it. A failure to write it
  // throws, and nothing is approved.
  const evidence = ctx.evidence === undefined
    ? null
    : copyEvidence(store.runDir, entry.phase.id, entry.stage.id, ctx.evidence);

  const next = store.nextEntry();
  store.mutate((run) =>
    mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "done",
      ended_at: stage.ended_at ?? ctx.at,
      gate: {
        ...stage.gate,
        status: "approved",
        by: ctx.actor,
        at: ctx.at,
        note: ctx.note,
        ...(evidence === null ? {} : { evidence }),
      } satisfies RunGate,
    })),
  );
  if (next !== null) {
    store.mutate((run) => ({
      ...mapStage(run, next.phase.id, next.stage.id, (stage) => ({ ...stage, status: "ready" })),
      cursor: { phase: next.phase.id, stage: next.stage.id, task: null },
    }));
  }

  // `by` duplicates the envelope's `actor` on purpose: a reader of the event
  // stream asks "who signed this gate", and the answer belongs in the payload it
  // is reading, not in a field that also means "who ran the process". It is how
  // `by: auto` is told apart from a person who happens to be called auto — the
  // facilitator is the only caller that passes the AUTO_GATE_ACTOR.
  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.approved", ctx.actor, {
    phase: entry.phase.id,
    by: ctx.actor,
    note: ctx.note,
    checks: checks.map((c) => `${c.id}:${c.status}`),
    // Additive, and only on an agent-closed gate: the event stream carries `by`
    // already, and `by: fable` alone cannot tell a person from an agent that
    // happens to be called fable. The role and the path can.
    ...(evidence === null ? {} : { role: evidence.role, evidence: evidence.path }),
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
    evidencePath: evidence === null ? null : evidence.path,
  };
}

/**
 * Write `<phase>/gate-evidence/<stage>.md` and return the record that points at
 * it. The scratch note under `.agent/` stays exactly where the agent left it —
 * this is a copy, not a move, because a gitignored original is still the thing
 * the next `--prepare` cycle is allowed to overwrite.
 */
function copyEvidence(
  runDir: string,
  phaseId: string,
  stageId: string,
  input: GateEvidenceInput,
): RunGateEvidence {
  const rel = gateEvidenceRelPath(phaseId, stageId);
  const absolute = join(runDir, ...rel.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, input.text, "utf8");
  return { path: rel, ...input.record };
}

export interface RejectOutcome {
  readonly stage: string;
  readonly phase: string;
  readonly note: string;
  /** The status the stage was in when it was rejected: `awaiting_gate` or `failed`. */
  readonly from: string;
}

/**
 * Two states may be rejected, and spec §5 names them both.
 *
 * `awaiting_gate` is the ordinary one. `failed` is the other half of the failure
 * path — "the operator's options are `next` (retry, re-spending), `reject --note`
 * (send the stage back to `ready` with the note fed into the next prompt)" — so
 * refusing a failed stage would leave the operator with retry as the only move.
 *
 * Both record the note in `gate.note` and append one `gate.rejected` event; the
 * event's `from` payload says which state it came out of. There is deliberately
 * no separate `stage.reset` event: one verb, one event, and the note lives in one
 * place for `next` to read back.
 */
const REJECTABLE: readonly string[] = ["awaiting_gate", "failed"];

export function reject(store: RunStore, ctx: GateContext): RejectOutcome {
  if (ctx.note.trim() === "") {
    throw new GateError("reject needs --note: a rejection without a reason is not actionable");
  }
  const entry = requireStatus(store, "reject", REJECTABLE);
  const from = entry.stage.status;
  store.mutate((run) =>
    mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "ready",
      ended_at: null,
      gate: { ...stage.gate, status: "rejected", by: ctx.actor, at: ctx.at, note: ctx.note } satisfies RunGate,
    })),
  );
  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.rejected", ctx.actor, {
    phase: entry.phase.id,
    note: ctx.note,
    from,
  }));
  store.save();
  return { stage: entry.stage.id, phase: entry.phase.id, note: ctx.note, from };
}

export interface RevokeOutcome {
  readonly stage: string;
  readonly phase: string;
  readonly note: string;
  /** Who had signed the gate being taken back — `auto` or a person. */
  readonly signedBy: string;
  /** When it was signed. */
  readonly signedAt: string | null;
  /** `<phase>/<stage>` of every later stage now marked stale. */
  readonly staled: readonly string[];
}

/**
 * `tldrx reject --stage <phase>/<stage>` — take an approval back.
 *
 * Before this, an approval was final. `approve()` moves the cursor in the same
 * transaction that signs the gate (`gates.ts:63-77`) and `reject` only ever looked
 * at the cursor, so the audit's probe — a wholly fabricated handoff that closed
 * its own auto gate — met `REJECT REFUSED: nothing to reject: 02-how/beta is
 * 'ready'`. A machine that can sign but cannot be overruled is not a gate.
 *
 * What it does, and deliberately does not do:
 *
 *   - the named stage goes back to `ready` with the note on its gate, and the
 *     CURSOR moves back to it, so the next `tldrx next` re-runs it with the note
 *     as input — identical to an ordinary rejection, one stage further back;
 *   - every LATER stage that had already run is marked `stale: true`. Its outputs
 *     stay on disk: they cost money, they are usually mostly right, and deleting
 *     a reviewer's work to make a flag true is worse than the flag. What changes
 *     is that nothing may treat them as current;
 *   - no cost is refunded and no task is deleted. Money spent stays on the record
 *     (spec §5).
 *
 * One `gate.revoked` event carries who signed the original, who took it back, and
 * what went stale.
 */
export function revoke(store: RunStore, ctx: GateContext, target: string): RevokeOutcome {
  if (ctx.note.trim() === "") {
    throw new GateError("reject needs --note: a revocation without a reason is not actionable");
  }
  const entry = locate(store, target);
  if (entry.stage.gate.status !== "approved") {
    throw new GateError(
      `cannot revoke ${entry.phase.id}/${entry.stage.id}: its gate is \`${entry.stage.gate.status}\`, not ` +
        "`approved`. To send the CURRENT stage back, use `tldrx reject --note \"…\"` with no --stage.",
    );
  }
  const signedBy = entry.stage.gate.by ?? "unknown";
  const signedAt = entry.stage.gate.at;
  const later = stagesAfter(store.run, entry.phase.id, entry.stage.id)
    .filter((e) => e.stage.status !== "pending" || e.stage.tasks.length > 0)
    .map((e) => `${e.phase.id}/${e.stage.id}`);

  store.mutate((run) => {
    const reset = mapStage(run, entry.phase.id, entry.stage.id, (stage) => ({
      ...stage,
      status: "ready",
      ended_at: null,
      stale: undefined,
      gate: { ...stage.gate, status: "pending", by: null, at: null, note: ctx.note } satisfies RunGate,
    }));
    const stale = new Set(later);
    return {
      ...reset,
      phases: reset.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) =>
          stale.has(`${phase.id}/${stage.id}`) ? { ...stage, stale: true } : stage,
        ),
      })),
      cursor: { phase: entry.phase.id, stage: entry.stage.id, task: null },
    };
  });

  store.append(event(ctx.at, store.runId, entry.stage.id, "gate.revoked", ctx.actor, {
    phase: entry.phase.id,
    note: ctx.note,
    signed_by: signedBy,
    signed_at: signedAt,
    staled: later,
  }));
  store.save();
  return {
    stage: entry.stage.id, phase: entry.phase.id, note: ctx.note,
    signedBy, signedAt, staled: later,
  };
}

/** `<phase>/<stage>`, or a bare stage id when it is unambiguous. */
function locate(store: RunStore, target: string): { phase: RunPhase; stage: RunStage } {
  const all = flattenEntries(store.run);
  const slash = target.indexOf("/");
  if (slash > 0) {
    const phaseId = target.slice(0, slash);
    const stageId = target.slice(slash + 1);
    const found = all.find((e) => e.phase.id === phaseId && e.stage.id === stageId);
    if (found === undefined) {
      throw new GateError(`no stage ${target} in this run — it has ${describeStages(all)}`);
    }
    return found;
  }
  const matches = all.filter((e) => e.stage.id === target);
  const only = matches[0];
  if (only === undefined) {
    throw new GateError(`no stage \`${target}\` in this run — it has ${describeStages(all)}`);
  }
  if (matches.length > 1) {
    const named = matches.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ");
    throw new GateError(`\`${target}\` names ${matches.length} stages (${named}) — pass <phase>/<stage>`);
  }
  return only;
}

function describeStages(all: readonly { phase: RunPhase; stage: RunStage }[]): string {
  return all.map((e) => `${e.phase.id}/${e.stage.id}`).join(", ");
}

function flattenEntries(run: RunFile): readonly { phase: RunPhase; stage: RunStage }[] {
  const out: { phase: RunPhase; stage: RunStage }[] = [];
  for (const phase of run.phases) for (const stage of phase.stages) out.push({ phase, stage });
  return out;
}

/** Every stage after the named one, in execution order. */
function stagesAfter(
  run: RunFile,
  phaseId: string,
  stageId: string,
): readonly { phase: RunPhase; stage: RunStage }[] {
  const all = flattenEntries(run);
  const at = all.findIndex((e) => e.phase.id === phaseId && e.stage.id === stageId);
  return at === -1 ? [] : all.slice(at + 1);
}

// --- helpers ---------------------------------------------------------------

function requireGate(store: RunStore, verb: string): { phase: RunPhase; stage: RunStage } {
  return requireStatus(store, verb, ["awaiting_gate"]);
}

function requireStatus(
  store: RunStore,
  verb: string,
  allowed: readonly string[],
): { phase: RunPhase; stage: RunStage } {
  const entry = store.cursorEntry();
  if (entry === null) {
    throw new GateError(`cursor ${store.run.cursor.phase}/${store.run.cursor.stage} does not resolve to a stage`);
  }
  if (!allowed.includes(entry.stage.status)) {
    const wanted = allowed.map((status) => `\`${status}\``).join(" or ");
    throw new GateError(
      `nothing to ${verb}: ${entry.phase.id}/${entry.stage.id} is \`${entry.stage.status}\`, not ${wanted}`,
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
