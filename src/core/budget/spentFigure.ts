/**
 * The one way a spent figure is written down when part of the work was unmetered.
 *
 * ## The defect this exists for
 *
 * Measured across 23 unattended runs on three real workspaces (week of
 * 2026-09-07): 45% of 845 task rows carry `cost_usd: null, metered: false` — the
 * in-session `--commit` path, where the host session was billed and nothing here
 * saw a dollar. Every sum treats those as contributing nothing, which is the only
 * honest arithmetic there is. But two of those runs then RENDERED `spent_usd:
 * 0.00` against a $3,000 ceiling after 30 stories, and another against $200 after
 * 9 — a bare `$0.00` that reads as thrift and was in fact a measurement nobody
 * took.
 *
 * `spendBasis.ts` already counts the turns and words the CAVEAT. What did not
 * exist was a rule for the FIGURE itself, so each surface printed
 * `$${n.toFixed(2)}` in its own words and three of them printed it with no
 * caveat at all. This module is that rule, and it is deliberately tiny: given a
 * dollar sum and how many turns went unmetered, it returns the string a person
 * should read. `spendBasis`'s sentence still explains WHY; this says what the
 * number IS.
 *
 * ## The three shapes
 *
 *   - every turn metered → `"$12.40"`. Unchanged, and that is the point: a run
 *     that really did measure its money keeps its plain figure and its plain
 *     progress bar. A caveat on every screen is a caveat nobody reads.
 *   - some metered, some not → `"≥ $12.40 (7 tasks unmetered)"`. The `≥` is the
 *     whole claim: the number is a floor, and the count says how much of the
 *     work it cannot see.
 *   - NOTHING metered → `"not measured: 9 in-session tasks, 0 metered"`. There is
 *     no floor worth printing here — `$0.00` is arithmetically true and
 *     communicatively false, and `≥ $0.00` is a floor that bounds nothing. So
 *     the figure is replaced by the fact.
 *
 * Pure and currency-free of everything but dollars: no file is opened, no price
 * is looked up, and no turn's cost is invented. Same discipline as
 * `spendBasis.ts`, and for the same reason (#103, #139).
 */

export interface SpentTally {
  /** The sum of what WAS metered. Always a lower bound when `unmetered > 0`. */
  readonly usd: number;
  /** Task rows recorded `metered: false` — the in-session turns. */
  readonly unmetered: number;
  /** Task rows that put a real figure in the sum. */
  readonly metered: number;
}

/** `lower-bound` the moment one turn went unmetered; `complete` otherwise. */
export const SPENT_BASES = ["lower-bound", "complete"] as const;
export type SpentBasis = (typeof SPENT_BASES)[number];

export function spentBasis(unmetered: number): SpentBasis {
  return unmetered > 0 ? "lower-bound" : "complete";
}

/**
 * The figure a person reads. See the three shapes in the header.
 *
 * `prefix` is the currency mark, so a renderer that has already written `$` into
 * its own markup does not get a second one. It defaults to `"$"` because every
 * caller but the dashboard wants exactly that.
 */
export function spentFigure(tally: SpentTally, prefix = "$"): string {
  const amount = `${prefix}${tally.usd.toFixed(2)}`;
  if (tally.unmetered === 0) return amount;
  if (tally.metered === 0) {
    return `not measured: ${String(tally.unmetered)} in-session `
      + `${tally.unmetered === 1 ? "task" : "tasks"}, 0 metered`;
  }
  return `≥ ${amount} (${String(tally.unmetered)} ${tally.unmetered === 1 ? "task" : "tasks"} unmetered)`;
}

/**
 * Count a run's turns, from the only two fields that decide it.
 *
 * `metered` is written to `run.yml` ONLY when false (`emitRunYaml`), so an absent
 * one means metered — every row written before the field existed, and every
 * headless spawn. Deliberately NARROWER than `spendBasisOf`'s `costlessTasks`,
 * which also counts a metered `$0.00`: this count is what `budget.yml`'s
 * `unmetered_tasks` records, and a field in a persisted file may only mean the
 * one thing its name says. The wider reading stays where it was, in the
 * dashboard's sentence, where it is explained in prose.
 */
export function tallyOf(
  tasks: readonly { readonly cost_usd: number | null; readonly metered?: boolean }[],
): SpentTally {
  let usd = 0;
  let unmetered = 0;
  for (const task of tasks) {
    if (task.metered === false) {
      unmetered += 1;
      continue;
    }
    usd += task.cost_usd ?? 0;
  }
  return { usd: Math.round(usd * 100) / 100, unmetered, metered: tasks.length - unmetered };
}

/**
 * The whole clause — figure, ceiling, and the join that works for both shapes.
 *
 * `"$12.40 spent of $25.00 ceiling"` reads correctly; `"not measured: 9
 * in-session tasks, 0 metered spent of $25.00 ceiling"` does not, because the
 * not-measured shape is a SENTENCE where the other two are amounts. A caveat
 * nobody can parse is a caveat nobody reads, which is the failure this whole
 * module exists to fix — so the join changes with the shape rather than the
 * sentence being bent to fit one grammar.
 *
 * `ceiling` arrives pre-formatted: two callers format money two ways (`toFixed`
 * and `replay`'s `money()`, which prints `$?` for a figure it does not have) and
 * neither is wrong. This composes; it does not decide currency.
 */
export function spentClause(tally: SpentTally, ceiling: string): string {
  return tally.unmetered > 0 && tally.metered === 0
    ? `${spentFigure(tally)} — the ceiling is ${ceiling}`
    : `${spentFigure(tally)} spent of ${ceiling} ceiling`;
}
