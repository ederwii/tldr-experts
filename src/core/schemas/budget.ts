/**
 * Schema for `tldrx-work/<run>/budget.yml`.
 * Budget is a first-class input (concept §1.5): a stage that cannot be afforded
 * is refused, not started and abandoned.
 */
import {
  asDocument, requireKeys, requireNumber, requireRecord, requireString,
  result, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export interface BudgetFile {
  readonly schema_version: number;
  readonly run: string;
  readonly ceiling_usd: number;
  readonly spent_usd: number;
  readonly per_phase_usd: Readonly<Record<string, number>>;
}

export function validateBudget(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, ["schema_version", "run", "ceiling_usd", "spent_usd", "per_phase_usd"], "", issues);
  requireString(doc.run, "run", issues);
  requireNumber(doc.ceiling_usd, "ceiling_usd", issues);
  requireNumber(doc.spent_usd, "spent_usd", issues);

  if (requireRecord(doc.per_phase_usd, "per_phase_usd", issues)) {
    for (const [key, value] of Object.entries(doc.per_phase_usd as Record<string, unknown>)) {
      requireNumber(value, `per_phase_usd.${key}`, issues);
    }
  }
  return result(issues);
}
