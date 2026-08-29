/** Schema for `stages/<slug>/stage.yml` — the customizable stage library. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireNumber, requireRecord,
  requireString, result, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export const GATE_TYPES = ["human-approval", "checks-green", "none"] as const;
export type GateType = (typeof GATE_TYPES)[number];

/**
 * `--effort <level>` on the Claude CLI — "Effort level for the current session".
 * The five values are the ones `claude --help` prints on this machine (read
 * 2026-08-29, verbatim: `low, medium, high, xhigh, max`); nothing else is
 * accepted, for the same reason `spawnAgent` refuses a flag nobody has seen in
 * `--help`.
 *
 * It is the cost lever `--max-budget-usd` is not: the budget flag STOPS a run
 * after the turn it is already in (measured: a 597 s training turn spent $5.15
 * against a $1.50 ceiling), so it cannot make a turn cheaper — only end it late.
 * Effort changes what the turn costs in the first place.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface StageGate {
  readonly type: GateType;
  readonly requires?: readonly string[];
}

export interface Stage {
  readonly name: string;
  readonly title: string;
  readonly phase: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly experts: readonly string[];
  readonly model: string;
  /** Optional; absent means the CLI's own default for the session. */
  readonly effort?: EffortLevel;
  readonly budget_usd: number;
  readonly gate: StageGate;
  readonly checks?: readonly string[];
}

export function validateStage(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(
    doc,
    ["name", "title", "phase", "inputs", "outputs", "experts", "model", "budget_usd", "gate"],
    "",
    issues,
  );
  requireString(doc.name, "name", issues);
  requireString(doc.title, "title", issues);
  requireNumber(doc.phase, "phase", issues);
  requireString(doc.model, "model", issues);
  requireNumber(doc.budget_usd, "budget_usd", issues);
  // Optional: `requireEnum` returns early on `undefined`, and `effort` is not in
  // the required-key list above.
  requireEnum(doc.effort, EFFORT_LEVELS, "effort", issues);
  requireArray(doc.inputs, "inputs", issues);
  requireArray(doc.outputs, "outputs", issues);
  requireArray(doc.experts, "experts", issues);

  if (requireRecord(doc.gate, "gate", issues)) {
    const gate = doc.gate as Record<string, unknown>;
    requireKeys(gate, ["type"], "gate", issues);
    requireEnum(gate.type, GATE_TYPES, "gate.type", issues);
  }
  return result(issues);
}
