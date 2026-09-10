/**
 * "The facilitator refuses to start work it cannot afford" (concept §1.5).
 *
 * `remaining` answers what is left; `wouldExceed` answers whether a spend fits and
 * — honouring `on_exceed` — whether the budget-gate hook must deny it.
 */
import { hostTokenCeiling, type RunBudget } from "./RunBudget.ts";
import { STAGE_TUNING_DEFAULTS } from "../schemas/stageTuning.ts";

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
  /**
   * True when the spend fits but crosses `warn_at_pct` of ONE ATTEMPT'S SHARE of
   * the scope's ceiling — `ceiling / attempts`, not the ceiling.
   *
   * Owner decision 2026-09-09, and it is what keeps the warning meaning what it
   * has always meant. Since gh #170 a phase ceiling HOLDS `attempts` (default 2)
   * of its stage, so measuring 80% against the raw ceiling would need roughly
   * twice the real spend on a run that never retries: the warning would arrive
   * after the money that was going to be spent had been, which is a warning that
   * has stopped being one. Dividing by `attempts` fires it at the same real
   * dollars as before the split.
   *
   * `exceeds`, `remaining` and `ceiling` are UNTOUCHED and still answer for the
   * whole phase — the refusal is about what the phase may spend, and the phase may
   * spend all of it. Only the advisory line moved.
   */
  readonly warns: boolean;
  /** The figure `warns` was measured against — `ceiling / attempts`. */
  readonly warnBasis: number;
}

/**
 * `attempts` is the STAGE's `attempts:` (`schemas/stageTuning.ts`) and is only
 * ever read for `warns` — see the field. Absent ⇒ the shipped default, which is
 * what every caller meant before the key existed.
 */
export function wouldExceed(
  budget: RunBudget,
  phaseId: string | null,
  estimate: number,
  attempts: number = STAGE_TUNING_DEFAULTS.attempts,
): BudgetDecision {
  const phase = phaseId === null ? undefined : budget.phases.find((p) => p.id === phaseId);
  const scope: BudgetScope = phase === undefined ? "run" : "phase";
  const ceiling = phase === undefined ? budget.ceiling_usd : phase.ceiling_usd;
  const spent = phase === undefined ? totalSpent(budget) : phase.spent_usd;
  const left = round(ceiling - spent);
  const exceeds = round(spent + estimate) > ceiling;
  // One attempt's share. `attempts` is clamped to at least 1 rather than trusted:
  // a 0 here would divide the basis to zero and warn on every run forever, and a
  // reader on a hot path does not get to throw.
  const warnBasis = round(ceiling / Math.max(1, attempts));
  const pct = warnBasis === 0 ? 100 : ((spent + estimate) / warnBasis) * 100;
  return {
    exceeds,
    blocked: exceeds && budget.on_exceed === "block",
    scope,
    phaseId: phase === undefined ? null : phase.id,
    remaining: left,
    ceiling,
    estimate,
    warns: !exceeds && pct >= budget.warn_at_pct,
    warnBasis,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * The same question in the OTHER currency (issue #22, owner decision 2026-09-01).
 *
 * Deliberately not a generalisation of `wouldExceed`: there is no exchange rate
 * between a metered dollar and a host token, so the two decisions share a shape
 * and nothing else. This one takes SPENT tokens only — no estimate term — because
 * what a stage will cost in host tokens is a number nobody in this process can
 * produce, and the decision was written against "accumulated declared `tokens:`
 * cross the budget", which is measurable.
 *
 * `blocked` requires the explicit opt-in: `on_host_tokens_exceed: block`.
 */
export interface HostTokenDecision {
  readonly over: boolean;
  /** `over` AND the operator opted in. The only case anything may deny. */
  readonly blocked: boolean;
  readonly scope: BudgetScope;
  readonly spent: number;
  readonly ceiling: number;
}

/** Null when this phase is not priced in host tokens — there is nothing to judge. */
export function wouldExceedHostTokens(
  budget: RunBudget,
  phaseId: string | null,
  spentTokens: number,
): HostTokenDecision | null {
  const ceiling = hostTokenCeiling(budget, phaseId);
  if (ceiling === null) return null;
  const phase = phaseId === null ? undefined : budget.phases.find((p) => p.id === phaseId);
  const over = ceiling > 0 && spentTokens > ceiling;
  return {
    over,
    blocked: over && budget.on_host_tokens_exceed === "block",
    scope: phase === undefined ? "run" : "phase",
    spent: spentTokens,
    ceiling,
  };
}
