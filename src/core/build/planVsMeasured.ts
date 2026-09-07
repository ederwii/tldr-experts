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

export function overShareSentence(
  ceilingUsd: number | null,
  measuredUsd: number | null,
  stories: number,
): string | null {
  if (ceilingUsd === null || measuredUsd === null) return null;
  if (!(ceilingUsd > 0) || !(measuredUsd > 0)) return null;
  const ratio = measuredUsd / ceilingUsd;
  if (ratio <= 1) return null;
  const over = stories === 1 ? "1 story" : `${String(stories)} stories`;
  return `${over} measured $${round2(measuredUsd).toFixed(2)} against the `
    + `$${round2(ceilingUsd).toFixed(2)} ceiling their spawns were given — ${ratio.toFixed(1)}x`;
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
