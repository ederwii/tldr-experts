/**
 * `gates_policy: agent` — the gate an agent may close, and only when it can show
 * its work (design §A).
 *
 * The framework already knew two answers to "who closes a gate": a person waits,
 * the facilitator signs when seven measured conditions hold. Neither says *"an
 * agent checked it, showed its work, and is accountable for the check"* — so the
 * host that drove `260830-tenancy-identity-customers` on 2026-08-30 ran a defined
 * checklist at every gate and typed it into `approve --note "<free text>"`, where
 * nothing validated it and `replay` could not render it.
 *
 * An agent gate is **strictly stronger** than an auto gate, never a cheaper one:
 *
 *   1. every `auto` condition holds — all seven of `evaluateAutoGate`, unchanged,
 *      unweakened, including 2B's `boundary`;
 *   2. no budget event landed in this stage's window;
 *   3. a structured evidence note is present, parses, and its verdict is `sign`.
 *
 * (2) is deliberately an EVENT and not an arithmetic. Condition 3 of the auto
 * gate already compares spend against the ceiling; what it cannot see is that a
 * person *raised* the ceiling to let this stage through. A raise is a decision,
 * and a decision made to unblock a stage may not then be signed off by the
 * machine that was blocked.
 *
 * Everything else falls to a human, with the reason NAMED. Four of those
 * fallthroughs are the ones design §A.2 calls out — an open question, a budget
 * event, a boundary, and the note itself refusing — and they are separated from
 * the generic ones because each has a different thing for a person to do.
 *
 * This module measures and reports. It signs nothing: `approve` is the one door,
 * and `runNext` walks through it with the actor the note names.
 */
import { existsSync, readFileSync } from "node:fs";
import { validateEvidence, type EvidenceValidation } from "../text/evidence.ts";
import type { SrcContext } from "../text/srcToken.ts";
import type { TldrxEvent } from "../events/Event.ts";
import type { RunGateEvidence } from "./RunFile.ts";
import { evaluateAutoGate, type AutoGateCondition, type AutoGateInput } from "./autoGate.ts";

/**
 * Why a gate an `agent` policy could have closed fell to a person instead.
 *
 * The four design §A.2 names, plus the two that cover "any other auto condition"
 * and "the note is broken". A caller routes on the trigger; the operator reads
 * the detail.
 */
export const AGENT_GATE_TRIGGERS = [
  "questions", "budget-event", "boundary", "refusal", "condition", "evidence",
] as const;
export type AgentGateTrigger = (typeof AGENT_GATE_TRIGGERS)[number];

export interface AgentGateFallthrough {
  readonly trigger: AgentGateTrigger;
  readonly detail: string;
}

export interface AgentGateVerdict {
  /** True only when all seven conditions hold, no budget event, and the note signs. */
  readonly ok: boolean;
  /** The seven auto conditions, evaluated and reported whatever the outcome. */
  readonly conditions: readonly AutoGateCondition[];
  /** Every reason this fell to a human. Empty when `ok`. */
  readonly fallthroughs: readonly AgentGateFallthrough[];
  /** The note recorded on the gate: the seven conditions plus the note's counts. */
  readonly note: string;
  /** The one-line "why not", for the exit-4 report. Empty when `ok`. */
  readonly why: string;
  /** Who the note says checked it — the actor the gate records. Null when there is no readable note. */
  readonly actor: string | null;
  /** What goes on `run.yml`'s `gate.evidence`, minus the path `approve` decides. */
  readonly record: Omit<RunGateEvidence, "path"> | null;
  /** The note's own bytes, for the copy into the run tree. Null when unreadable. */
  readonly text: string | null;
  /** The validator's full verdict, or null when the file is not there at all. */
  readonly evidence: EvidenceValidation | null;
}

export interface AgentGateInput extends AutoGateInput {
  /** `<phase>/<stage>` at the cursor — what the note must be evidence FOR. */
  readonly gate: string;
  /** Absolute path of the note: `.agent/<stage>/evidence.md` unless overridden. */
  readonly evidencePath: string;
  /** The §2.8 resolver's context, so the note's bullets go through the same one. */
  readonly srcCtx: SrcContext;
  /** Every event in this run, in file order. */
  readonly events: readonly TldrxEvent[];
}

/** The event types that mean a person moved the money while this stage was running. */
export const BUDGET_DECISION_EVENTS: readonly string[] = ["budget.raised", "budget.blocked"];

export async function evaluateAgentGate(input: AgentGateInput): Promise<AgentGateVerdict> {
  const auto = await evaluateAutoGate(input);
  const fallthroughs: AgentGateFallthrough[] = [];

  for (const condition of auto.conditions) {
    if (condition.ok) continue;
    // `questions` and `boundary` are named in their own right: an open question is
    // a decision nobody has made, and a boundary is work nobody scoped. Both are
    // things a person does something ABOUT, not merely a check that went red.
    const trigger: AgentGateTrigger =
      condition.id === "questions" ? "questions" : condition.id === "boundary" ? "boundary" : "condition";
    fallthroughs.push({ trigger, detail: `${condition.id}=${condition.detail}` });
  }

  const budget = budgetEventsInWindow(input.events, input.stage.started_at);
  if (budget.length > 0) {
    fallthroughs.push({
      trigger: "budget-event",
      detail: `${describeBudgetEvents(budget)} — a ceiling a person moved to let this stage through `
        + "is not a ceiling the machine that was blocked may then sign off against",
    });
  }

  const text = readOrNull(input.evidencePath);
  if (text === null) {
    fallthroughs.push({
      trigger: "evidence",
      detail: `no evidence note at ${input.evidencePath} — an agent gate is closed over one `
        + "(`tldrx gate template` writes the blank form)",
    });
    return verdict(auto.conditions, fallthroughs, agentNote(auto.conditions, null), null, null, text, null);
  }

  const evidence = validateEvidence(text, input.srcCtx, { gate: input.gate });
  // `verdict` is the kind that means "a person decides"; every other kind means
  // "this note is broken". Two different things for the operator to do, so two
  // different triggers and never one message covering both.
  const refusals = evidence.issues.filter((issue) => issue.kind === "verdict");
  const broken = evidence.issues.filter((issue) => issue.kind !== "verdict");
  for (const issue of refusals) fallthroughs.push({ trigger: "refusal", detail: issue.message });
  if (broken.length > 0) {
    fallthroughs.push({
      trigger: "evidence",
      detail: `the evidence note has ${String(broken.length)} problem(s): `
        + broken.map((issue) => issue.message).join("; "),
    });
  }

  const front = evidence.front;
  return verdict(
    auto.conditions,
    fallthroughs,
    agentNote(auto.conditions, evidence),
    front === null ? null : front.by,
    front === null ? null : {
      role: front.role,
      verdict: front.verdict,
      sampled: front.citations.sampled,
      of: front.citations.of,
      resolved: front.citations.resolved,
      refuted: front.citations.refuted,
      outside_surface: front.touches.outside_surface,
    },
    text,
    evidence,
  );
}

function verdict(
  conditions: readonly AutoGateCondition[],
  fallthroughs: readonly AgentGateFallthrough[],
  note: string,
  actor: string | null,
  record: Omit<RunGateEvidence, "path"> | null,
  text: string | null,
  evidence: EvidenceValidation | null,
): AgentGateVerdict {
  return {
    ok: fallthroughs.length === 0,
    conditions,
    fallthroughs,
    note,
    why: fallthroughs.map((f) => `${f.trigger}: ${f.detail}`).join("; "),
    actor,
    record,
    text,
    evidence,
  };
}

/**
 * `agent-gate: <the seven conditions>; evidence=<the note's own counts>`.
 *
 * Deliberately the `auto-gate:` line with one clause appended and the prefix
 * changed: nothing that reads `gate.note` today has to learn a new shape, and a
 * reader comparing an agent gate against an auto one is comparing like with like.
 */
export function agentNote(
  conditions: readonly AutoGateCondition[],
  evidence: EvidenceValidation | null,
): string {
  const measured = conditions.map((c) => `${c.id}=${c.detail}`).join("; ");
  const front = evidence?.front ?? null;
  if (front === null) return `agent-gate: ${measured}; evidence=none`;
  const c = front.citations;
  return `agent-gate: ${measured}; evidence=${front.verdict} by ${front.by}, `
    + `read ${String(front.read.length)} file(s), `
    + `sampled ${String(c.sampled)} of ${String(c.of)} citation(s) `
    + `(${String(c.resolved)} resolved, ${String(c.refuted)} refuted), `
    + `audited ${String(front.touches.audited)} touched path(s) `
    + `(${String(front.touches.outside_surface)} outside the surface), `
    + `diff vs stories ${front.diff_vs_stories}`;
}

/**
 * `budget.raised` / `budget.blocked` since the stage started.
 *
 * Filtered by TIME rather than by `stage:`, because a raise is appended at the
 * run level (`stage: null`) and a block is appended against a stage — the same
 * decision, recorded from two places, and an agent gate has to see both.
 *
 * A stage with no `started_at` is read as "the whole run", which can only make
 * this fall through more often, never less. A gate that closed because a
 * timestamp was missing would be the worst kind of pass.
 */
export function budgetEventsInWindow(
  events: readonly TldrxEvent[],
  startedAt: string | null,
): readonly TldrxEvent[] {
  return events.filter((event) => {
    if (!BUDGET_DECISION_EVENTS.includes(event.type)) return false;
    if (startedAt === null) return true;
    return event.ts >= startedAt;
  });
}

function describeBudgetEvents(events: readonly TldrxEvent[]): string {
  const named = events.map((event) => `${event.type} at ${event.ts}`).join(", ");
  return `${String(events.length)} budget event(s) in this stage's window (${named})`;
}

/** One line per reason, in the shape `next` prints its refusals in. */
export function describeAgentFallthroughs(
  fallthroughs: readonly AgentGateFallthrough[],
): readonly string[] {
  return fallthroughs.map((f) => `  ${f.trigger}: ${f.detail}`);
}

function readOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
