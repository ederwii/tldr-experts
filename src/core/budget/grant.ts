/**
 * Reconciling a CEILING against what the owner AUTHORIZED (#170).
 *
 * A separate leaf from `wouldExceed.ts` on purpose, and this header says so
 * because the two are one word apart: `wouldExceed` asks "may this run spend
 * more"; this asks "may this file hold this ceiling". They are two questions and
 * one function cannot answer both without losing the first.
 *
 * Absence is the LAX side, everywhere: no grant recorded means nothing is
 * reconciled and nothing is refused. `$0` is never inferred from silence — every
 * `budget.yml` on disk predates these keys, and reading their absence as an
 * authorization of nothing would refuse every raise on every one of them.
 *
 * Takes DATA and returns DATA: a `RunBudget`, a phase id and a number. No `ctx`,
 * no session, no store — the caller owns the file and the decision to write it.
 */
import type { OnGrantExceed, RunBudget } from "./RunBudget.ts";

export interface Grant {
  readonly usd: number;
  /** The fact the grant cites. A grant with no decision behind it is not recorded. */
  readonly factId: string;
  readonly level: "phase" | "run";
}

/**
 * The grant governing `phaseId`: the phase's own, else the run's, else null.
 *
 * Phase-then-run and never anything cleverer — the same precedence `economyFor`
 * uses one file over, for the same reason.
 *
 * A phase amount is only a grant when the RUN carries the fact id beside it:
 * `authorized_by` is written at the run level whatever `--phase` says, so a
 * phase number with no fact anywhere is a recorded figure that cites no
 * decision, and this returns null rather than letting it govern silently.
 */
export function grantFor(budget: RunBudget, phaseId?: string | null): Grant | null {
  if (phaseId !== undefined && phaseId !== null) {
    const phase = budget.phases.find((p) => p.id === phaseId);
    if (phase?.authorized_usd != null && budget.authorized_by !== null) {
      return { usd: phase.authorized_usd, factId: budget.authorized_by, level: "phase" };
    }
  }
  if (budget.authorized_usd === null || budget.authorized_by === null) return null;
  return { usd: budget.authorized_usd, factId: budget.authorized_by, level: "run" };
}

export interface GrantVerdict {
  readonly exceeds: boolean;
  /** True only when it exceeds AND the file says `block`. */
  readonly blocked: boolean;
  readonly grant: Grant | null;
  /** What to print. Null when there is no grant, because there is nothing to say. */
  readonly sentence: string | null;
}

/**
 * Whether `resultingCeilingUsd` is above the grant governing `phaseId`, and what
 * the file's policy says to do about it.
 *
 * The comparison carries the same `1e-9` slack `validateRunBudget`'s phase-sum
 * rule does: a ceiling that lands exactly on the grant is inside it, and float
 * arithmetic must not turn `$5.00` into a refusal.
 */
export function wouldExceedGrant(
  budget: RunBudget,
  phaseId: string | null,
  resultingCeilingUsd: number,
): GrantVerdict {
  const grant = grantFor(budget, phaseId);
  if (grant === null) {
    return { exceeds: false, blocked: false, grant: null, sentence: null };
  }
  const exceeds = resultingCeilingUsd > grant.usd + 1e-9;
  const policy: OnGrantExceed = budget.on_grant_exceed;
  if (!exceeds) return { exceeds: false, blocked: false, grant, sentence: null };
  return {
    exceeds: true,
    blocked: policy === "block",
    grant,
    sentence:
      `$${resultingCeilingUsd.toFixed(2)} is above the $${grant.usd.toFixed(2)} authorized `
      + `by ${grant.factId} (${grant.level} grant)`
      + (policy === "block" ? " — refused; raise the grant first, or record a new decision." : "."),
  };
}
