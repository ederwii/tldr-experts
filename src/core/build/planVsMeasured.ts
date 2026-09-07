/**
 * What a story cost against the ceiling its spawn was given (#170 ask 4).
 *
 * ONE arithmetic, two feeders, and neither reads a price table: `tldrx cost
 * --stories` feeds it from `agent.spawned.max_budget_usd` and
 * `agent.result.cost_usd` (events only, so `cost.ts:3`'s "reads events.jsonl and
 * nothing else" stays true), and the Build handoff feeds it from the caps the
 * executor just used and the turns it just ran.
 *
 * IT IS A CEILING, NOT "THE PLAN'S SHARE", and the sentence says so. Measured:
 * `STORY_KEYS` is `version, id, epic, title, repo, status, depends_on, touches,
 * acceptance, test_plan, evidence` — no plan document carries a per-story dollar
 * figure at all. The figure a story is measured against is the one the executor
 * computed and handed the spawn. Calling it "the plan's share" would invent a
 * number no file holds, which is the whole failure #170 is about.
 *
 * Null when either side is absent, or the ceiling is not positive: a ratio over
 * a figure this cannot see is exactly the confident-zero this repo refuses.
 * A run inside its ceiling gets nothing — `measured` is the basis with nothing
 * to say, and a caveat on every header is a caveat nobody reads.
 */
import { round2 } from "./caps.ts";

/**
 * Measured over ceiling — the ONE division, with the ONE guard on it.
 *
 * Both the per-story row and the sentence below go through this. They used to
 * divide separately, each with its own `> 0` check, which is the drift AGENTS §7
 * names: the row and the sentence could disagree about what a ratio even is.
 * The sentence keeps its OWN extra refusals (a zero measurement, a ratio at or
 * under 1) on top of this; those are editorial, not arithmetic.
 */
export function ratioOf(ceilingUsd: number | null, measuredUsd: number | null): number | null {
  if (ceilingUsd === null || measuredUsd === null) return null;
  if (!(ceilingUsd > 0)) return null;
  return measuredUsd / ceilingUsd;
}

/** One decimal — the precision the text prints, so a JSON reader sees the same number. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function overShareSentence(
  ceilingUsd: number | null,
  measuredUsd: number | null,
  stories: number,
): string | null {
  const ratio = ratioOf(ceilingUsd, measuredUsd);
  if (ratio === null || measuredUsd === null || ceilingUsd === null) return null;
  if (!(measuredUsd > 0)) return null;
  if (ratio <= 1) return null;
  const over = stories === 1 ? "1 story" : `${String(stories)} stories`;
  // "SPAWN ceilings", not "ceiling": this sentence rides on a handoff header that
  // already says `$6.00 of $200.00 ceiling`, where the ceiling is the PHASE
  // budget. One load-bearing word meaning two things eleven characters apart is
  // the failure this change exists to stop, so the adjective is not optional.
  return `${over} measured $${round2(measuredUsd).toFixed(2)} against `
    + `$${round2(ceilingUsd).toFixed(2)} of spawn ceilings — ${ratio.toFixed(1)}x`;
}

/**
 * The sum, or null the moment a side is missing.
 *
 * An empty list is null too: a total over no stories is not a total, and both
 * feeders would otherwise hand `overShareSentence` a confident `0` ceiling.
 *
 * It lives HERE rather than beside either caller because both callers need it —
 * `phaseCost.ts` folds the clause into the handoff's note and `costView.ts`
 * totals the `--stories` table — and one derivation in a leaf is the house rule
 * (`AGENTS.md` §7) the alternative would have broken.
 */
export function sumOrNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}
