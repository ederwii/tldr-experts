/**
 * Ceiling that is PROVABLY unspendable, and how much of it a blocked phase may take (gh #314).
 *
 * Measured on a field run: `04-build` was refused $11.07 short (`$89.80` of remaining work,
 * `$78.73` left) while `01-what` had finished $16.25 under its ceiling and the run total had
 * $141 of room. `run auto` stopped, a person typed
 * `tldrx budget raise 04-build 12 --take-from 01-what`, and relaunched. The move was already
 * sanctioned — `--take-from` exists and is validated — and the money it moved was money no
 * stage could ever spend again. What was missing was anything that looked.
 *
 * This file LOOKS, and that is all it decides. A phase is a donor when every one of these
 * holds — each failure is named on `excluded`, never silently dropped:
 *
 *  1. it is not the phase being unblocked;
 *  2. it has at least one stage in `run.yml`, and EVERY stage is `done` or `skipped` and none
 *     is `stale` — `failed`, `pending`, `ready`, `running`, `awaiting_*`, `blocked` and
 *     `cancelled` all mean a stage may still run (or the run is over), and a stale stage is
 *     one an earlier revoked gate will send back through `next`. So a phase with a stage
 *     still to run (`05-watch` while Build is blocked) is never a donor, whatever it holds;
 *  3. it is priced in `metered-usd` — a `host-tokens` number is not dollars (spec §2.11);
 *  4. none of its task rows is unmetered — otherwise `spent_usd` is a LOWER BOUND and
 *     "ceiling minus spent" is an upper bound on what is unused, which is not a proof;
 *  5. it has at least a cent of `ceiling_usd − spent_usd` left.
 *
 * Donors give in run order, each at most what it has left, until the shortfall is covered.
 * If all of them together cannot cover it, NOTHING moves (`moves: []`) and `uncoveredUsd`
 * says by how much — a partial move would spend a person's decision and still refuse.
 *
 * Moves go through `raiseBudget` with `takeFrom` — the same validation `tldrx budget raise
 * --take-from` runs — so the run ceiling never grows and no donor is cut below its spend.
 * Takes DATA and returns DATA; the caller owns the store, the grant check and the event.
 */
import { economyFor, type RunBudget } from "./RunBudget.ts";
import { raiseBudget, type RaiseOutcome } from "./raiseBudget.ts";
import { tallyOf } from "./spentFigure.ts";
import type { RunFile } from "../run/RunFile.ts";

/**
 * The `source` a `budget.raised` carries when `run auto --rebalance-finished` wrote it — the
 * one spelling every reader keys on (the loop's stage line, the agent gate's attribution).
 */
export const REBALANCE_SOURCE = "run auto --rebalance-finished";

export interface RebalanceDonor {
  readonly phaseId: string;
  readonly unspentUsd: number;
}

export interface RebalanceExclusion {
  readonly phaseId: string;
  /** Why this phase gives nothing — a sentence, never a code. */
  readonly reason: string;
}

export interface RebalanceMove {
  readonly takeFrom: string;
  readonly amountUsd: number;
}

export interface RebalancePlan {
  readonly targetPhaseId: string;
  readonly shortUsd: number;
  readonly donors: readonly RebalanceDonor[];
  readonly excluded: readonly RebalanceExclusion[];
  /** Σ unspent over every donor. */
  readonly finishedUnspentUsd: number;
  /** Empty unless the donors cover the WHOLE shortfall. */
  readonly moves: readonly RebalanceMove[];
  /** `shortUsd − finishedUnspentUsd`, floored at 0. */
  readonly uncoveredUsd: number;
}

/** Stage statuses after which a stage will not run again on its own. */
const SETTLED = new Set<string>(["done", "skipped"]);

export function planRebalance(
  budget: RunBudget,
  run: Pick<RunFile, "phases">,
  targetPhaseId: string,
  shortUsd: number,
): RebalancePlan {
  const donors: RebalanceDonor[] = [];
  const excluded: RebalanceExclusion[] = [];
  for (const phase of budget.phases) {
    if (phase.id === targetPhaseId) continue;
    const reason = notADonor(budget, run, phase.id);
    if (reason !== null) {
      excluded.push({ phaseId: phase.id, reason });
      continue;
    }
    const unspent = round(phase.ceiling_usd - phase.spent_usd);
    if (unspent < 0.01) {
      excluded.push({ phaseId: phase.id, reason: `finished with no unspent ceiling ($${phase.spent_usd.toFixed(2)} of $${phase.ceiling_usd.toFixed(2)})` });
      continue;
    }
    donors.push({ phaseId: phase.id, unspentUsd: unspent });
  }

  const short = round(shortUsd);
  const finishedUnspentUsd = round(donors.reduce((sum, d) => sum + d.unspentUsd, 0));
  const uncoveredUsd = round(Math.max(0, short - finishedUnspentUsd));
  const moves: RebalanceMove[] = [];
  if (uncoveredUsd === 0 && short > 0) {
    let left = short;
    for (const donor of donors) {
      if (left <= 0) break;
      const take = round(Math.min(donor.unspentUsd, left));
      moves.push({ takeFrom: donor.phaseId, amountUsd: take });
      left = round(left - take);
    }
  }
  return { targetPhaseId, shortUsd: short, donors, excluded, finishedUnspentUsd, moves, uncoveredUsd };
}

/** Apply every move through `raiseBudget --take-from`. An uncovered plan returns the budget untouched. */
export function applyRebalance(
  budget: RunBudget,
  plan: RebalancePlan,
): { readonly budget: RunBudget; readonly outcomes: readonly RaiseOutcome[] } {
  let current = budget;
  const outcomes: RaiseOutcome[] = [];
  for (const move of plan.moves) {
    const outcome = raiseBudget(current, { phaseId: plan.targetPhaseId, amountUsd: move.amountUsd, takeFrom: move.takeFrom });
    outcomes.push(outcome);
    current = outcome.budget;
  }
  return { budget: current, outcomes };
}

/** One sentence for the refusal and the `budget.raised` note: where the unspent money is, or why there is none. */
export function describeRebalance(plan: RebalancePlan): string {
  if (plan.donors.length === 0) {
    return `no finished phase holds unspent ceiling`
      + (plan.excluded.length === 0 ? "" : ` (${plan.excluded.map((e) => `${e.phaseId}: ${e.reason}`).join("; ")})`);
  }
  const held = plan.donors.map((d) => `${d.phaseId} $${d.unspentUsd.toFixed(2)}`).join(", ");
  return `finished phase(s) hold $${plan.finishedUnspentUsd.toFixed(2)} unspent (${held})`;
}

function notADonor(budget: RunBudget, run: Pick<RunFile, "phases">, phaseId: string): string | null {
  const phase = run.phases.find((p) => p.id === phaseId);
  if (phase === undefined || phase.stages.length === 0) return "no stage of it in run.yml, so nothing proves it finished";
  const open = phase.stages.filter((s) => !SETTLED.has(s.status));
  if (open.length > 0) {
    return `not finished — ${open.map((s) => `${s.id} is ${s.status}`).join(", ")}`;
  }
  const stale = phase.stages.filter((s) => s.stale === true);
  if (stale.length > 0) return `not finished — ${stale.map((s) => s.id).join(", ")} is stale and will run again`;
  if (economyFor(budget, phaseId) !== "metered-usd") return "priced in host-tokens, which are not dollars";
  const unmetered = tallyOf(phase.stages.flatMap((s) => s.tasks)).unmetered;
  if (unmetered > 0) {
    return `${String(unmetered)} unmetered turn(s), so its spend is a lower bound and its unspent figure is not a proof`;
  }
  return null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
