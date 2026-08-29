/** Schema for `workflows/<scope>.yml` — a scope is a workflow preset. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  result, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export const WORKFLOW_DEPTHS = ["minimal", "light", "standard", "deep"] as const;
export type WorkflowDepth = (typeof WORKFLOW_DEPTHS)[number];

export interface Workflow {
  readonly name: string;
  readonly description: string;
  readonly stages: readonly string[];
  readonly skips: readonly string[];
  readonly depth: WorkflowDepth;
  readonly default_budget_usd: number;
}

export function validateWorkflow(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, ["name", "description", "stages", "skips", "depth", "default_budget_usd"], "", issues);
  requireString(doc.name, "name", issues);
  requireString(doc.description, "description", issues);
  requireArray(doc.stages, "stages", issues);
  requireArray(doc.skips, "skips", issues);
  requireEnum(doc.depth, WORKFLOW_DEPTHS, "depth", issues);
  requireNumber(doc.default_budget_usd, "default_budget_usd", issues);
  return result(issues);
}
