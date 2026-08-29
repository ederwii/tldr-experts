/**
 * `tldrx budget raise <phase> <usd>` — the one sanctioned edit to `budget.yml`.
 *
 * The ceiling is a refusal, not a warning (concept §1.5), so raising it is a
 * deliberate act with a record: the file is rewritten through the same emitter and
 * validator every other write uses, and the command says out loud whether the run
 * ceiling grew or the money simply moved.
 *
 * Two shapes:
 *   - `--take-from <phase>` moves the amount between phases. The run ceiling does
 *     not change, and the donor may not be cut below what it has already spent.
 *   - without it, the target's ceiling grows, and the run ceiling grows with it
 *     when Σ phase ceilings would otherwise break the §2.11 rule. The result says
 *     which happened, because "I raised a phase" and "I raised the whole run" are
 *     very different sentences to read back in a week.
 */
import type { RunBudget } from "./RunBudget.ts";
import { totalSpent } from "./wouldExceed.ts";

export class BudgetRaiseError extends Error {}

export interface RaiseRequest {
  readonly phaseId: string;
  readonly amountUsd: number;
  /** Phase to move the money out of, or null to grow the budget. */
  readonly takeFrom?: string | null;
}

export interface RaiseOutcome {
  readonly budget: RunBudget;
  readonly phaseId: string;
  readonly amountUsd: number;
  readonly takeFrom: string | null;
  readonly phaseCeilingBefore: number;
  readonly phaseCeilingAfter: number;
  readonly runCeilingBefore: number;
  readonly runCeilingAfter: number;
  /** True when the run ceiling had to grow to hold the new phase ceiling. */
  readonly runCeilingGrew: boolean;
}

export const MIN_RAISE_USD = 0.01;
/** A raise is a nudge, not a rewrite: anything larger wants a new run. */
export const MAX_RAISE_USD = 1000;

export function raiseBudget(budget: RunBudget, request: RaiseRequest): RaiseOutcome {
  const amount = round(request.amountUsd);
  if (!Number.isFinite(amount) || amount < MIN_RAISE_USD) {
    throw new BudgetRaiseError(`the amount must be at least ${money(MIN_RAISE_USD)}, got ${money(request.amountUsd)}`);
  }
  if (amount > MAX_RAISE_USD) {
    throw new BudgetRaiseError(`${money(amount)} exceeds the ${money(MAX_RAISE_USD)} cap for a single raise`);
  }
  const target = budget.phases.find((p) => p.id === request.phaseId);
  if (target === undefined) {
    throw new BudgetRaiseError(
      `no phase \`${request.phaseId}\` in budget.yml — it has ${budget.phases.map((p) => p.id).join(", ")}`,
    );
  }
  const takeFrom = request.takeFrom ?? null;
  if (takeFrom !== null && takeFrom === request.phaseId) {
    throw new BudgetRaiseError(`--take-from ${takeFrom} is the same phase — that moves nothing`);
  }

  let donor = null;
  if (takeFrom !== null) {
    donor = budget.phases.find((p) => p.id === takeFrom) ?? null;
    if (donor === null) {
      throw new BudgetRaiseError(
        `no phase \`${takeFrom}\` in budget.yml — it has ${budget.phases.map((p) => p.id).join(", ")}`,
      );
    }
    const left = round(donor.ceiling_usd - donor.spent_usd);
    if (amount > left) {
      throw new BudgetRaiseError(
        `${takeFrom} has only ${money(left)} unspent of its ${money(donor.ceiling_usd)} ceiling — ` +
          `taking ${money(amount)} would put its ceiling below what it has already spent`,
      );
    }
  }

  const phases = budget.phases.map((phase) => {
    if (phase.id === request.phaseId) return { ...phase, ceiling_usd: round(phase.ceiling_usd + amount) };
    if (donor !== null && phase.id === donor.id) return { ...phase, ceiling_usd: round(phase.ceiling_usd - amount) };
    return phase;
  });

  const sum = round(phases.reduce((total, p) => total + p.ceiling_usd, 0));
  // Spec §2.11: Σ phase ceilings ≤ ceiling_usd. A move keeps the sum; a raise does not.
  const runCeiling = sum > budget.ceiling_usd ? sum : budget.ceiling_usd;
  const next: RunBudget = { ...budget, ceiling_usd: runCeiling, phases };

  if (round(totalSpent(next)) > runCeiling) {
    throw new BudgetRaiseError("the run has already spent more than the resulting ceiling — raise the run ceiling first");
  }

  return {
    budget: next,
    phaseId: request.phaseId,
    amountUsd: amount,
    takeFrom,
    phaseCeilingBefore: target.ceiling_usd,
    phaseCeilingAfter: round(target.ceiling_usd + amount),
    runCeilingBefore: budget.ceiling_usd,
    runCeilingAfter: runCeiling,
    runCeilingGrew: runCeiling > budget.ceiling_usd,
  };
}

/** What the command prints. Says which of the two things happened, in words. */
export function describeRaise(outcome: RaiseOutcome): string {
  const head =
    `${outcome.phaseId} ceiling ${money(outcome.phaseCeilingBefore)} → ${money(outcome.phaseCeilingAfter)} ` +
    `(+${money(outcome.amountUsd)})`;
  if (outcome.takeFrom !== null) {
    return `${head}, moved from ${outcome.takeFrom}. Run ceiling unchanged at ${money(outcome.runCeilingAfter)}.`;
  }
  if (outcome.runCeilingGrew) {
    return `${head}. The run ceiling GREW to hold it: ${money(outcome.runCeilingBefore)} → ` +
      `${money(outcome.runCeilingAfter)}. Use --take-from <phase> to move the money instead of adding it.`;
  }
  return `${head}. The run ceiling still covers the phase ceilings, so it stays at ${money(outcome.runCeilingAfter)}.`;
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
