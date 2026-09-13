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
import { STAGE_TUNING_DEFAULTS } from "../schemas/stageTuning.ts";

/**
 * A story gets one developer attempt, plus one more if the reviewer asks for
 * changes. A second `changes` blocks it — a third try is an operator's decision,
 * not the framework's.
 *
 * The DEFAULT, since 2026-09-09: a stage may say `attempts: N` and every read
 * site below takes it from `CapParts` instead (`schemas/stageTuning.ts`).
 */
export const MAX_ATTEMPTS = STAGE_TUNING_DEFAULTS.attempts;

/**
 * `[assumption]` — the brief splits the stage budget "by story count", which is the
 * DEVELOPER's share; the reviewer needs its own and the spec never sizes one. A
 * quarter of a story's share reads a diff comfortably and cannot quietly double
 * the phase's cost.
 *
 * The DEFAULT: a stage may say `reviewer_share: N` (`schemas/stageTuning.ts`).
 */
export const REVIEWER_SHARE = STAGE_TUNING_DEFAULTS.reviewerShare;

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
 * What a story's PLANNED price is multiplied by to get the developer's ceiling
 * (gh #277).
 *
 * **This is a regression we shipped ourselves.** #264 made the executor actually
 * read `03-plan/budget.yml`'s per-story prices. Before it, nothing did: the
 * price was decorative and every story got the uniform stage share. From #264
 * on, the number the planner wrote — BEFORE it had read a line of the repo —
 * became the hard ceiling of the developer's turn, at `price / (1 +
 * REVIEWER_SHARE)` = 0.8 x price. Measured by the session running two live
 * unattended runs on 0.18.1 (their measurement, not this file's): stories died
 * mid-flight on caps a dollar or three wide, were parked `todo` having spent
 * real money, and both runs stalled with nothing delivered. The spread between
 * what a planner estimates and what a story costs is roughly an order of
 * magnitude wide (gh #277 carries the figures).
 *
 * So the price stops being read as a forecast of the spend and starts being read
 * as the ORDER OF MAGNITUDE of the work. `3` NARROWS the gap for the low and
 * middle of the range and does not close it: over the prices the planner writes
 * today ($1.20-$4.00), the ceiling lands at $4.00-$12.00, so a story that really
 * costs at the top of the observed spread still dies on it. **A story still dies
 * on its cap whenever its real cost exceeds `max(price x 3, $4.00)`** — that is
 * the number to check before raising this, not a claim that the wall is gone.
 * What carries the expensive end is the OTHER half of #277: a developer that
 * dies with work in its tree no longer parks the story, so the work is committed
 * and the DoD decides it rather than the money being lost. What neither half
 * covers — a stage that still reports `done` over a story that died — is #263,
 * explicitly out of scope here. `3` is chosen against that division of labour and
 * against keeping one story's worst case legible in the stage it sits in: at
 * `k = 3` a story can be asked for `3 x price` on the pass the plan priced and
 * `1.5 x price` on the contingency attempt, which the stage's own budget gate is
 * what bounds — not this arithmetic, which is now deliberately allowed to
 * over-run a single estimate. Under-spending here costs a dead story and
 * everything already paid for it; over-spending costs the difference, on work
 * that lands.
 *
 * A stage may say `story_cap_multiplier: N` and every read site takes it from
 * `CapParts` instead (`schemas/stageTuning.ts`).
 */
export const STORY_CAP_MULTIPLIER = STAGE_TUNING_DEFAULTS.storyCapMultiplier;

/**
 * The least a PRICED story's developer may be given, whatever the multiplied
 * price says (gh #277) — the developer-side sibling of `REVIEWER_FLOOR_USD`, and
 * it exists for the same reason.
 *
 * A multiplier alone does not save a story the planner priced at a few dimes:
 * `3 x $0.40` is still a turn that dies before it has read the repo. $4.00 is a
 * deliberately small multiple of the reviewer's own $1.00 floor, and the
 * justification is the asymmetry between the two roles: the reviewer reads one
 * diff, while the developer reads the repo, edits it, runs the story's DoD —
 * which is a whole test suite, minutes of it on a real repo — and commits.
 *
 * Like the reviewer's, this floor is traded against the "every worst-case cap
 * sums inside the stage ceiling" arithmetic on purpose; unlike the multiplied
 * price, it knows nothing about the stage it is in, so it is clamped to the
 * stage's own ceiling below. A stage may say `story_cap_floor_usd: N`.
 */
export const STORY_CAP_FLOOR_USD = STAGE_TUNING_DEFAULTS.storyCapFloorUsd;

/**
 * The divisor a PRICED story's per-attempt developer ceiling is derived with
 * (gh #91, 2026-09-02; re-derived by gh #277).
 *
 * `03-plan/budget.yml` prices a story at what Delivery measured the WORK to
 * cost. Until now the executor divided that by the worst case one story can be
 * asked for — `MAX_ATTEMPTS x (1 + REVIEWER_SHARE)` = 2.5 — before the first
 * attempt had run. Measured on run `260901-leaderboard-v2` (finding F-4): the
 * plan priced S2 at $2.10 of a $3.85 Build stage and the developer was
 * dispatched under $0.84. A deliberately-atomic large story starved on the one
 * attempt that mattered while trivial ones carried slack.
 *
 * Two attempts, two different things — the property #91 established, kept
 * verbatim over the ceiling #277 raised:
 *
 *  - **Attempt 1 is the pass the plan priced.** It gets the story's whole
 *    ceiling, `storyCeilingUsd`.
 *  - **Attempt 2 is a CONTINGENCY nobody priced.** It gets that divided by the
 *    stage's `attempts` — the same 2:1 ratio #91 left behind, since
 *    `MAX_ATTEMPTS x (1 + REVIEWER_SHARE)` over `(1 + REVIEWER_SHARE)` is
 *    exactly `attempts`. Handing it attempt 1's ceiling again would double the
 *    stage's worst case, which is the "Build 2.5x su fase" overrun
 *    `worstCaseShares` exists to stop.
 *
 * What #277 DID change in here: the reviewer's quarter is no longer carved out
 * of the developer's ceiling. It never funded the reviewer — `reviewerCap`
 * derives its own share from the price independently, and always did — so the
 * `(1 + REVIEWER_SHARE)` divisor was money taken off the developer and handed to
 * nobody. The reviewer's share is additive now, and visibly so.
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
export function developerAttemptDivisor(attempt: number, attempts: number = MAX_ATTEMPTS): number {
  return attempt <= 1 ? 1 : attempts;
}

/**
 * The LAST RESORT degree of parallelism inside a wave: one story at a time.
 *
 * Spec §5 decision (c) shipped v1 sequential. The framework's opinion now lives in
 * the shipped `stages/build/stage.yml` (`parallel: 2`), where an operator can read
 * it, argue with it and override it per workspace or per run. This constant is
 * what is left when every spelling is silent — a stage file that declares no
 * `parallel:` at all — and it stays 1, because the value nobody chose should be
 * the one that surprises nobody.
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
  /**
   * The stage's `attempts:` and `reviewer_share:`, RESOLVED
   * (`schemas/stageTuning.ts`). Passed as DATA rather than read off a constant
   * so the arithmetic here answers for the stage it is capping — the house rule
   * an extracted function follows. Absent ⇒ the shipped defaults, which is what
   * every call site meant before the keys existed.
   */
  readonly attempts?: number;
  readonly reviewerShare?: number;
  /**
   * The stage's `story_cap_multiplier:` and `story_cap_floor_usd:` (gh #277),
   * passed as DATA for the same reason the two above are. Absent ⇒ the shipped
   * defaults.
   */
  readonly storyCapMultiplier?: number;
  readonly storyCapFloorUsd?: number;
}

/** `parts.attempts`, or the default. One place, so no call site re-decides. */
export function attemptsOf(parts: CapParts): number {
  return parts.attempts ?? MAX_ATTEMPTS;
}

/** `parts.storyCapMultiplier`, or the default. */
export function storyCapMultiplierOf(parts: CapParts): number {
  return parts.storyCapMultiplier ?? STORY_CAP_MULTIPLIER;
}

/** `parts.storyCapFloorUsd`, or the default. */
export function storyCapFloorOf(parts: CapParts): number {
  return parts.storyCapFloorUsd ?? STORY_CAP_FLOOR_USD;
}

/** `parts.reviewerShare`, or the default. */
export function reviewerShareOf(parts: CapParts): number {
  return parts.reviewerShare ?? REVIEWER_SHARE;
}

/** The one `round2` — every other module imports this instead of redefining it. */
export function round2(n: number): number {
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
 * priced at $4.75 and the same $1.03 to the one priced at $0.75. The price now
 * buys `storyCeilingUsd` — `max(price × k, floor)` — of which attempt 1 gets the
 * whole and the contingency attempt after it gets a `attempts`-th (gh #91's
 * ratio, gh #277's ceiling).
 *
 * **A uniform share**, otherwise, exactly as before. Measured 2026-08-29: a
 * story's spend was `developer (1/N) + reviewer (0.25/N)` and the whole pipeline
 * could run TWICE, so N stories could charge 2.5x the stage ceiling — the
 * audit's "Build 2.5x su fase". Dividing by the worst case up front fixes that,
 * and a plan with no prices still gets it. #277 leaves this half alone: an
 * unpriced story's share is derived from the stage's own money, so there is no
 * estimate to be wrong about.
 */
export function developerCap(parts: CapParts, storyId?: string, attempt = 1): number {
  const price = priceOf(parts, storyId);
  if (price === null) return parts.agentCap(1 / worstCaseShares(parts));
  return parts.agentCap(shareOf(
    parts,
    storyCeilingUsd(parts, price) / developerAttemptDivisor(attempt, attemptsOf(parts)),
  ));
}

/**
 * What ONE priced story's developer may be asked for on the pass the plan priced
 * — `max(price × STORY_CAP_MULTIPLIER, STORY_CAP_FLOOR_USD)` (gh #277).
 *
 * Derived HERE, at dispatch, off the price as it sits on disk, and deliberately
 * NOT migrated into `budget.yml`: a run already in flight carries prices written
 * by an older planner, and deriving at dispatch is what covers those runs the
 * moment this is installed. A rewrite of the file would cover only runs planned
 * afterwards, and would destroy the planner's own number on the way.
 *
 * The floor is clamped to the stage's ceiling; the multiplied price is not. The
 * asymmetry is the point: the multiplied price is derived from a figure Delivery
 * wrote FOR THIS STAGE, so letting it over-run a single story's estimate is the
 * whole fix — the stage's budget gate is what stops a stage that runs out, and
 * it is metered against real spend rather than against a guess. The floor knows
 * nothing about the stage it landed in, so it never claims more than the stage
 * has.
 */
export function storyCeilingUsd(parts: CapParts, price: number): number {
  const floor = parts.budgetUsd > 0
    ? Math.min(storyCapFloorOf(parts), parts.budgetUsd)
    : storyCapFloorOf(parts);
  return Math.max(price * storyCapMultiplierOf(parts), floor);
}

/**
 * The reviewer's ceiling for ONE story: its derived quarter-share, never below
 * `REVIEWER_FLOOR_USD`, never above what the stage has left or what
 * `per_agent_max_usd` / `--max-usd` allow.
 *
 * The floor is the fix for the failure that produced this code: $0.26 cannot
 * read a 39-file diff, and a reviewer that runs out mid-read costs the whole
 * developer turn it was supposed to judge (`REVIEWER_FLOOR_USD`).
 *
 * The floor still YIELDS to the stage remainder here, and that is now a
 * deliberate division of labour rather than the hole gh #289 measured: what this
 * function answers is "what would this turn be capped at", which
 * `budget/remainingWork.ts` mirrors for the brake's estimate and
 * `seed/checkSeed.ts` quotes when nothing has been spent. Whether the turn is
 * WORTH SPAWNING at that cap is `reviewerUnderfunded`'s question, and the
 * executor asks it first — before the spawn, before a cent.
 */
export function reviewerCap(parts: CapParts, spentUsd: number, storyId?: string): number {
  const price = priceOf(parts, storyId);
  const share = reviewerShareOf(parts);
  const derived = price === null
    ? parts.agentCap(share / worstCaseShares(parts))
    : parts.agentCap(shareOf(parts, price * share / (attemptsOf(parts) * (1 + share))));
  const floor = Math.min(REVIEWER_FLOOR_USD, Math.max(parts.budgetUsd - spentUsd, 0));
  return round2(Math.min(Math.max(derived, floor), parts.maxBudgetUsd));
}

/**
 * What the stage has LEFT — `budget_usd` less what this invocation has spent —
 * or `null` when the stage carries no budget figure to subtract from.
 *
 * `null` is the `commitsBetween` contract, not a zero: a stage with
 * `budget_usd: 0` is a stage whose money nothing here can count, and a remainder
 * invented for it would be the confident zero §7 forbids. Every caller must
 * decide what to do with "I could not count", and the one below refuses to
 * refuse on it.
 */
export function stageRemainderUsd(parts: CapParts, spentUsd: number): number | null {
  if (!(parts.budgetUsd > 0)) return null;
  return Math.max(round2(parts.budgetUsd - spentUsd), 0);
}

/**
 * Is there too little left in the stage to fund a review at all (gh #289)?
 *
 * `REVIEWER_FLOOR_USD` was already the fix for this failure's earlier shape, and
 * it did not hold: `reviewerCap` takes the floor as
 * `min(REVIEWER_FLOOR_USD, remainder)`, so the floor YIELDS to whatever the
 * developer left behind and a nearly-exhausted stage buys a reviewer that cannot
 * read the diff. Measured on a live unattended run (0.19.0, `--budget 60`): a
 * developer spent 10.64 of its stage, the reviewer after it was handed $0.43,
 * died with `Reached maximum budget ($0.43)` before reading a line, and its
 * recorded `verdict: error` parked the story at `review` and blocked both
 * dependents — $17.23 of a $60 run, stopped.
 *
 * So the answer is not a bigger floor. A cap below the floor is a turn that
 * provably cannot finish, and paying for it spends money AND loses the story:
 * the executor refuses BEFORE the spawn and names the knob that moves the
 * ceiling (the stage's own `budget_usd` — see gh #244; the phase ceiling caps no
 * spawn). The arithmetic in `reviewerCap` is deliberately UNCHANGED: it is
 * mirrored in `budget/remainingWork.ts` on the budget gate's hot path, and the
 * brake's estimate must keep reading the same schedule the executor would have
 * spent under.
 */
export function reviewerUnderfunded(parts: CapParts, spentUsd: number): boolean {
  const left = stageRemainderUsd(parts, spentUsd);
  return left !== null && left < REVIEWER_FLOOR_USD;
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
  return Math.max(parts.storyCount, 1) * attemptsOf(parts) * (1 + reviewerShareOf(parts));
}
