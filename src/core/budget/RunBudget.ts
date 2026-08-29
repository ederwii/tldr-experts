/** `tldrx-work/<run>/budget.yml` (spec §2.11) — the ceiling the facilitator refuses to exceed. */
import {
  asDocument, isRecord, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  result, type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";

export const ON_EXCEED = ["block", "warn"] as const;
export type OnExceed = (typeof ON_EXCEED)[number];

/** Spec §2.11 default. `[assumption]` documented there: emitted once per phase. */
export const DEFAULT_WARN_AT_PCT = 80;
export const MAX_PHASES = 5;

export interface BudgetPhase {
  readonly id: string;
  readonly ceiling_usd: number;
  readonly spent_usd: number;
}

export interface RunBudget {
  readonly version: number;
  readonly run: string;
  readonly ceiling_usd: number;
  readonly per_agent_max_usd: number;
  readonly warn_at_pct: number;
  readonly on_exceed: OnExceed;
  readonly phases: readonly BudgetPhase[];
}

export function validateRunBudget(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, ["version", "run", "ceiling_usd", "per_agent_max_usd", "on_exceed", "phases"], "", issues);
  if (doc.version !== undefined && doc.version !== 1) {
    issues.push({ path: "version", message: `unknown schema version ${String(doc.version)} (expected 1)` });
  }
  requireString(doc.run, "run", issues);
  requireNumber(doc.ceiling_usd, "ceiling_usd", issues);
  requireNumber(doc.per_agent_max_usd, "per_agent_max_usd", issues);
  requireEnum(doc.on_exceed, ON_EXCEED, "on_exceed", issues);
  if (doc.warn_at_pct !== undefined) {
    requireNumber(doc.warn_at_pct, "warn_at_pct", issues);
    const pct = doc.warn_at_pct;
    if (typeof pct === "number" && (pct < 1 || pct > 99)) {
      issues.push({ path: "warn_at_pct", message: "expected 1–99" });
    }
  }
  if (!requireArray(doc.phases, "phases", issues)) return result(issues);

  const phases = doc.phases as unknown[];
  if (phases.length > MAX_PHASES) {
    issues.push({ path: "phases", message: `${phases.length} phases exceeds the ${MAX_PHASES} cap` });
  }
  let sum = 0;
  phases.forEach((phase, i) => {
    const path = `phases[${i}]`;
    if (!isRecord(phase)) {
      issues.push({ path, message: "expected a mapping" });
      return;
    }
    requireKeys(phase, ["id", "ceiling_usd", "spent_usd"], path, issues);
    requireString(phase.id, `${path}.id`, issues);
    requireNumber(phase.ceiling_usd, `${path}.ceiling_usd`, issues);
    requireNumber(phase.spent_usd, `${path}.spent_usd`, issues);
    if (typeof phase.ceiling_usd === "number") sum += phase.ceiling_usd;
  });
  if (typeof doc.ceiling_usd === "number" && sum > doc.ceiling_usd + 1e-9) {
    issues.push({ path: "phases", message: `phase ceilings sum to ${sum} > ceiling_usd ${doc.ceiling_usd}` });
  }
  return result(issues);
}

export function asRunBudget(input: unknown): RunBudget {
  const doc = input as Partial<RunBudget> & { phases: BudgetPhase[] };
  return {
    version: doc.version ?? 1,
    run: doc.run ?? "",
    ceiling_usd: doc.ceiling_usd ?? 0,
    per_agent_max_usd: doc.per_agent_max_usd ?? 0,
    warn_at_pct: doc.warn_at_pct ?? DEFAULT_WARN_AT_PCT,
    on_exceed: doc.on_exceed ?? "block",
    phases: doc.phases ?? [],
  };
}
