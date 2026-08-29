/**
 * "The facilitator refuses to start work it cannot afford" (concept §1.5).
 *
 * `remaining` answers what is left; `wouldExceed` answers whether a spend fits and
 * — honouring `on_exceed` — whether the budget-gate hook must deny it.
 */
import type { RunBudget } from "./RunBudget.ts";

export function totalSpent(budget: RunBudget): number {
  return budget.phases.reduce((sum, p) => sum + p.spent_usd, 0);
}

/** What is left in `phaseId`, or in the run when the phase is unknown to the file. */
export function remaining(budget: RunBudget, phaseId?: string): number {
  if (phaseId !== undefined) {
    const phase = budget.phases.find((p) => p.id === phaseId);
    if (phase !== undefined) return round(phase.ceiling_usd - phase.spent_usd);
  }
  return round(budget.ceiling_usd - totalSpent(budget));
}

export type BudgetScope = "phase" | "run";

export interface BudgetDecision {
  /** `spent + estimate > ceiling` at the tightest scope that binds. */
  readonly exceeds: boolean;
  /** `exceeds` AND `on_exceed: block` — the only case the hook may deny. */
  readonly blocked: boolean;
  readonly scope: BudgetScope;
  /** The phase id checked, or null when only the run ceiling applied. */
  readonly phaseId: string | null;
  readonly remaining: number;
  readonly ceiling: number;
  readonly estimate: number;
  /** True when the spend fits but crosses `warn_at_pct` of the scope's ceiling. */
  readonly warns: boolean;
}

export function wouldExceed(budget: RunBudget, phaseId: string | null, estimate: number): BudgetDecision {
  const phase = phaseId === null ? undefined : budget.phases.find((p) => p.id === phaseId);
  const scope: BudgetScope = phase === undefined ? "run" : "phase";
  const ceiling = phase === undefined ? budget.ceiling_usd : phase.ceiling_usd;
  const spent = phase === undefined ? totalSpent(budget) : phase.spent_usd;
  const left = round(ceiling - spent);
  const exceeds = round(spent + estimate) > ceiling;
  const pct = ceiling === 0 ? 100 : ((spent + estimate) / ceiling) * 100;
  return {
    exceeds,
    blocked: exceeds && budget.on_exceed === "block",
    scope,
    phaseId: phase === undefined ? null : phase.id,
    remaining: left,
    ceiling,
    estimate,
    warns: !exceeds && pct >= budget.warn_at_pct,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
