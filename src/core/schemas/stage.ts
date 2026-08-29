/** Schema for `stages/<slug>/stage.yml` — the customizable stage library. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireNumber, requireRecord,
  requireString, result, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export const GATE_TYPES = ["human-approval", "checks-green", "none"] as const;
export type GateType = (typeof GATE_TYPES)[number];

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
