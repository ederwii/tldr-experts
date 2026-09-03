/**
 * How much of a scope's spend the files can actually see — counted once, worded
 * once (#103, #139).
 *
 * A turn driven by a host session is billed to that session, so tldrx records it
 * as `cost_usd: null` + `metered: false` and every sum treats it as contributing
 * nothing (`RunStore.rollUp`). That makes the total a LOWER BOUND rather than a
 * measurement, and a surface that prints the figure without saying so reports an
 * incomplete number as a complete one.
 *
 * This module exists because THREE surfaces have to say that: the dashboard's
 * spend model (#103), `tldrx budget show`, and the Build handoff's `Cost:` header
 * (#139). The first two already agreed; the third was silent, and fixing it in
 * place would have been how two spellings of one caveat get born. So the sentence
 * and the four-way `basis` that picks it live here, and the callers pass turns in
 * and print what comes back.
 *
 * Deliberately pure: no file is opened, no price is looked up, and no dollar
 * figure is synthesised for a turn that declared none. The whole point of #103 is
 * that the number a decision-maker reads must not be one this process invented.
 *
 * The dashboard's model imports the page renderer, so the executor cannot import
 * IT — that is the mechanical reason this is a module of its own and not an
 * export from `dashboard/model.ts`.
 */

/**
 * One turn, reduced to the three facts the basis depends on.
 *
 * `metered` is normalised by the caller: `run.yml` writes the field only when it
 * is `false`, so an absent one means metered — which is every task row written
 * before the field existed and every headless spawn.
 */
export interface SpendTurn {
  readonly costUsd: number | null;
  readonly metered: boolean;
  readonly tokens: number | null;
}

export interface SpendBasis {
  readonly totalTasks: number;
  /**
   * Turns that put nothing in the meter.
   *
   * The one judgement call in this file, and it is deliberately the WIDER
   * reading: `metered: false` OR a metered `cost_usd` of exactly `0`. The narrow
   * one — `metered` alone — saw 14 of the 30 costless turns on the audited run,
   * because a row written before `metered` existed reads as a metered zero. A
   * file that says `0.00` is not overruled here; it is counted.
   */
  readonly costlessTasks: number;
  /** Host tokens declared BY a costless turn — the only figure the dollars miss. */
  readonly costlessTokens: number;
  /** Costless turns that declared nothing at all: no dollars, no tokens. */
  readonly silentTasks: number;
  /** `measured` | `declared` | `partial` | `absent`. See `spendReason`. */
  readonly basis: string;
  /** `basis` as the sentence a person reads. Empty-safe, currency-free. */
  readonly reason: string;
}

/**
 * The basis of a scope's metered total, from its turns.
 *
 * `hostTokens` is the scope's declared tokens in full — a DIFFERENT currency,
 * never added to dollars, and read here only to say where they landed when none
 * of them landed on a costless turn.
 *
 * `subject` names the scope the sentence is about, so a stage-scoped surface does
 * not claim to be describing a run. It is the only thing that varies between the
 * callers; the wording does not.
 */
export function spendBasisOf(
  turns: readonly SpendTurn[],
  hostTokens: number,
  subject = "run",
): SpendBasis {
  const costless = turns.filter((turn) => !turn.metered || turn.costUsd === 0);
  const costlessTokens = costless.reduce((sum, turn) => sum + (turn.tokens ?? 0), 0);
  const silentTasks = costless.filter((turn) => turn.tokens === null).length;
  const total = turns.length;
  const count = costless.length;
  const basis = count === 0
    ? "measured"
    : silentTasks === 0
      ? "declared"
      : costlessTokens > 0 ? "partial" : "absent";
  return {
    totalTasks: total,
    costlessTasks: count,
    costlessTokens,
    silentTasks,
    basis,
    reason: spendReason(basis, total, count, silentTasks, hostTokens, subject),
  };
}

/**
 * `basis` as the sentence a person reads, in TURN COUNTS only.
 *
 * No dollars and no token totals in here, for two reasons. The model does not
 * format money — that rule is older than this field — and the dashboard prints
 * the token figure right beside this sentence, so repeating it would say the same
 * number twice in one row. The phrase "LOWER BOUND, not a total" is lifted
 * verbatim from `budgetView.ts`, which is what `tldrx budget show` prints for the
 * identical fact: three screens, one wording.
 */
export function spendReason(
  basis: string,
  total: number,
  costless: number,
  silent: number,
  hostTokens: number,
  subject = "run",
): string {
  const of = `${String(costless)} of ${String(total)} turns produced no dollars`;
  const metered = total - costless;
  if (basis === "measured") {
    return total === 0
      ? "no turn has run yet, so nothing is missing from the metered total"
      : `all ${String(total)} turns recorded a cost, so the metered total is a measurement `
        + "rather than a lower bound";
  }
  if (basis === "declared") {
    return `${of} and every one of them declared its host tokens instead, so the metered total `
      + "is a LOWER BOUND on the dollars";
  }
  if (basis === "partial") {
    return `${of}: ${String(costless - silent)} declared host tokens and ${String(silent)} declared `
      + "nothing at all, so the metered total is a LOWER BOUND, not a total";
  }
  // `absent`. The clause about where the tokens DID land is the audited run's
  // exact trap: 920,641 of them, every one on a turn that also carried dollars,
  // so the token figure on the page describes none of the turns this sentence is
  // about.
  return `${of} and none of them declared host tokens`
    + (hostTokens > 0 ? ` — every token this ${subject} declared sits on a turn that also carried dollars` : "")
    + ", so the metered total is a LOWER BOUND, not a total"
    + (metered > 0 ? `: it is what the other ${String(metered)} turns cost, not what the ${subject} cost` : "");
}
