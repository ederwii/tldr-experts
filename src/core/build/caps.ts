/**
 * Every ceiling the Build phase hands a sub-agent, and the constants they are
 * derived from.
 *
 * One place, because the arithmetic here has a MIRROR: `budget/remainingWork.ts`
 * restates `MAX_ATTEMPTS`, `REVIEWER_SHARE`, `REVIEWER_FLOOR_USD` and
 * `developerPriceDivisor` on the budget-gate hook's hot path (so the hook does
 * not drag `spawnAgent` in), and `test/remaining-work.test.ts` pins the two
 * copies to each other. A ceiling derived twice in two files is how the brake and
 * the spend end up on different attempts.
 */
import { MAX_STORIES_PER_WAVE } from "../schemas/planCommon.ts";

/**
 * A story gets one developer attempt, plus one more if the reviewer asks for
 * changes. A second `changes` blocks it — a third try is an operator's decision,
 * not the framework's.
 */
export const MAX_ATTEMPTS = 2;

/**
 * `[assumption]` — the brief splits the stage budget "by story count", which is the
 * DEVELOPER's share; the reviewer needs its own and the spec never sizes one. A
 * quarter of a story's share reads a diff comfortably and cannot quietly double
 * the phase's cost.
 */
export const REVIEWER_SHARE = 0.25;

/**
 * The least a reviewer may be given, whatever the arithmetic says.
 *
 * Measured 2026-08-30, run `260830-tenancy-identity-customers`: the uniform split
 * handed the reviewer of a 39-file, +1879-line story $0.26, and it died mid-read
 * with `Reached maximum budget ($0.26)`. A reviewer that cannot finish reading
 * the diff approves nothing, blocks nothing and judges nothing — it converts the
 * developer's spend into a story stuck at `review`. A floor is the cheapest thing
 * that makes a review mean something, and it is deliberately traded against the
 * strict "every worst-case cap sums inside the stage ceiling" arithmetic below:
 * the worst case only materialises when reviewers keep asking for changes, and
 * `budget.yml`'s own gate is what actually stops a stage that runs out.
 */
export const REVIEWER_FLOOR_USD = 1.00;

/**
 * The divisor a PRICED story's per-attempt developer ceiling is derived with
 * (gh #91, 2026-09-02).
 *
 * `03-plan/budget.yml` prices a story at what Delivery measured the WORK to
 * cost. Until now the executor divided that by the worst case one story can be
 * asked for — `MAX_ATTEMPTS x (1 + REVIEWER_SHARE)` = 2.5 — before the first
 * attempt had run. Measured on run `260901-leaderboard-v2` (finding F-4): the
 * plan priced S2 at $2.10 of a $3.85 Build stage and the developer was
 * dispatched under $0.84. A deliberately-atomic large story starved on the one
 * attempt that mattered while trivial ones carried slack.
 *
 * Two attempts, two different things:
 *
 *  - **Attempt 1 is the pass the plan priced.** It gets `price / (1 +
 *    REVIEWER_SHARE)` — the whole price less the reviewer's derived quarter —
 *    so a story is dispatched at what Delivery said it was worth.
 *  - **Attempt 2 is a CONTINGENCY nobody priced.** It keeps the pre-#91 figure,
 *    `price / (MAX_ATTEMPTS x (1 + REVIEWER_SHARE))`. Handing it attempt 1's
 *    ceiling again would double the stage's worst case, which is the "Build 2.5x
 *    su fase" overrun `worstCaseShares` exists to stop.
 *
 * Why the second attempt is not the measured REMAINDER of the story's price,
 * which would be tighter still: the spend is recoverable (`agent.result` events
 * carry `key` = the story id and a row-level `cost_usd`), but the brake in
 * `budget/remainingWork.ts` mirrors this arithmetic on the budget-gate hook's
 * hot path and would have to read the same ledger to stay in step. It buys
 * nothing at the worst case — `0.8 + 0.4` either way — so the schedule is fixed
 * and the ledger stays unread.
 *
 * What this does NOT change: the reviewer's own share and its floor, the uniform
 * split an unpriced plan still gets, and `priceScale`, which keeps the sum of the
 * declared prices inside the stage ceiling. What it does change is the worst case
 * ONE priced story can be asked for: `0.8 x price` becomes `1.2 x price`. The
 * phase ceiling is metered once, at stage entry (`runNext.runExecutor` skips the
 * brake while a stage is `running`), so nothing re-checks the envelope between
 * two spawns of the same headless `runAll` — the same window `REVIEWER_FLOOR_USD`
 * already opens by design, and `remainingWork` still clamps the brake's estimate
 * to the stage's own price so it can never refuse more often than it used to.
 */
export function developerPriceDivisor(attempt: number): number {
  return attempt <= 1 ? 1 + REVIEWER_SHARE : MAX_ATTEMPTS * (1 + REVIEWER_SHARE);
}

/**
 * The default degree of parallelism inside a wave: one story at a time.
 *
 * Spec §5 decision (c) shipped v1 sequential, and this stays the default so a
 * workspace that says nothing keeps the behaviour it has been running.
 */
export const DEFAULT_PARALLEL = 1;

/**
 * Whatever this run may do at once inside a wave, clamped to something sane.
 *
 * The ceiling is `MAX_STORIES_PER_WAVE`, since a number above it can never be
 * reached; the floor is 1, because "0 lanes" is not a slower build, it is a
 * build that never starts.
 */
export function clampParallel(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PARALLEL;
  return Math.max(1, Math.min(MAX_STORIES_PER_WAVE, Math.trunc(requested)));
}

/** Everything a ceiling is derived from — the plan's prices and the stage's money. */
export interface CapParts {
  /** `03-plan/budget.yml`'s per-story prices, as `BuildPlan.prices`. */
  readonly prices: ReadonlyMap<string, number>;
  /** `BuildPlan.storyCount`. */
  readonly storyCount: number;
  /** The stage ceiling as scaled into `run.yml` (`ctx.budgetUsd`). */
  readonly budgetUsd: number;
  /** `min(stage share, per_agent_max_usd, --max-usd)` (`ctx.maxBudgetUsd`). */
  readonly maxBudgetUsd: number;
  /** `ctx.agentCap` — the executor's own capper, passed, never re-implemented. */
  readonly agentCap: (share?: number) => number;
}

/** Local, as in every other module here (nine files define their own — measured). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The developer's ceiling for ONE story.
 *
 * Two sources, in order.
 *
 * **The Plan's own price**, when `03-plan/budget.yml` gave this story one. That
 * file is Delivery pricing each story against the stage ceiling, and until
 * 2026-08-30 it was read by nothing: on
 * `260830-tenancy-identity-customers` the executor handed $1.03 to the story
 * priced at $4.75 and the same $1.03 to the one priced at $0.75. The price is
 * divided by `developerPriceDivisor(attempt)`: the whole price less the
 * reviewer's derived quarter on attempt 1 — the pass Delivery priced — and the
 * worst-case share `MAX_ATTEMPTS × (1 + REVIEWER_SHARE)` on the contingency
 * attempt after it (gh #91; before it, both attempts got the worst-case share
 * and a $2.10 story was dispatched under $0.84).
 *
 * **A uniform share**, otherwise, exactly as before. Measured 2026-08-29: a
 * story's spend was `developer (1/N) + reviewer (0.25/N)` and the whole pipeline
 * could run TWICE, so N stories could charge 2.5x the stage ceiling — the
 * audit's "Build 2.5x su fase". Dividing by the worst case up front fixes that,
 * and a plan with no prices still gets it.
 */
export function developerCap(parts: CapParts, storyId?: string, attempt = 1): number {
  const price = priceOf(parts, storyId);
  if (price === null) return parts.agentCap(1 / worstCaseShares(parts));
  return parts.agentCap(shareOf(parts, price / developerPriceDivisor(attempt)));
}

/**
 * The reviewer's ceiling for ONE story: its derived quarter-share, never below
 * `REVIEWER_FLOOR_USD`, never above what the stage has left or what
 * `per_agent_max_usd` / `--max-usd` allow.
 *
 * The floor is the fix for the failure that produced this code: $0.26 cannot
 * read a 39-file diff, and a reviewer that runs out mid-read costs the whole
 * developer turn it was supposed to judge (`REVIEWER_FLOOR_USD`).
 */
export function reviewerCap(parts: CapParts, spentUsd: number, storyId?: string): number {
  const price = priceOf(parts, storyId);
  const derived = price === null
    ? parts.agentCap(REVIEWER_SHARE / worstCaseShares(parts))
    : parts.agentCap(shareOf(parts, price * REVIEWER_SHARE / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE))));
  const floor = Math.min(REVIEWER_FLOOR_USD, Math.max(parts.budgetUsd - spentUsd, 0));
  return round2(Math.min(Math.max(derived, floor), parts.maxBudgetUsd));
}

/**
 * What the Plan priced this story at, scaled to fit the stage — or null when it
 * priced nothing, so the uniform share applies.
 */
export function priceOf(parts: CapParts, storyId: string | undefined): number | null {
  if (storyId === undefined) return null;
  const price = parts.prices.get(storyId);
  if (price === undefined || !Number.isFinite(price) || price <= 0) return null;
  return price * priceScale(parts);
}

/**
 * ≤ 1: what every declared price is multiplied by so the priced stories cannot
 * add up to more than the stage was given.
 *
 * A Plan that prices $22 of stories into an $18 stage is not refused — it is
 * scaled down proportionally, which keeps the RATIO Delivery decided (the
 * useful half) without letting the total escape the ceiling.
 */
export function priceScale(parts: CapParts): number {
  if (parts.budgetUsd <= 0) return 1;
  let sum = 0;
  for (const price of parts.prices.values()) {
    if (Number.isFinite(price) && price > 0) sum += price;
  }
  return sum <= parts.budgetUsd ? 1 : parts.budgetUsd / sum;
}

/** Dollars expressed as the fraction of the stage budget `agentCap` wants. */
export function shareOf(parts: CapParts, usd: number): number {
  return parts.budgetUsd <= 0 ? 1 : usd / parts.budgetUsd;
}

/**
 * How many developer-shares the phase can be asked for at worst:
 * `stories × attempts × (1 + REVIEWER_SHARE)`. Dividing by this makes the sum
 * of every uniform cap the executor can hand out ≤ the stage ceiling.
 */
export function worstCaseShares(parts: CapParts): number {
  return Math.max(parts.storyCount, 1) * MAX_ATTEMPTS * (1 + REVIEWER_SHARE);
}
