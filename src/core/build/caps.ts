/**
 * Every ceiling the Build phase hands a sub-agent, and the constants they are
 * derived from.
 *
 * One place, because the arithmetic here has a MIRROR: `budget/remainingWork.ts`
 * restates `MAX_ATTEMPTS`, `REVIEWER_SHARE` and
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
 *
 * $2.00 since gh #307 (owner decision). $1.00 had been chosen because it looked
 * reasonable, and it sat BELOW the reviews that finish: across 44 measured
 * reviewer rows the most a completed review cost was $1.02, and a 3-story run
 * priced $8–$9 put every reviewer on the $1.00 floor, one of which died with
 * `Reached maximum budget ($1)` before reading the diff. The accepted
 * consequence: `reviewerUnderfunded` (gh #289) now refuses a review when the
 * stage has less than $2.00 left.
 */
export const REVIEWER_FLOOR_USD = 2.00;

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
 * on its cap whenever its real cost exceeds `max(price x scale x 3, $4.00)`** —
 * `scale` being `priceScale`, ≤ 1, the factor that fits the plan's summed prices
 * into the stage — and that is the number to check before raising this, not a
 * claim that the wall is gone. gh #281 measured what leaving the scale out of
 * this sentence cost: a $16.20 stage over a $114.00 plan capped a story priced
 * $14.00 at $5.97 where the sentence promised $42, and the refusal sent the
 * operator to raise the price — the one lever the scale absorbs exactly.
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
 * deliberately small multiple of the reviewer's own floor, and the
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
 * — `max(price × STORY_CAP_MULTIPLIER, STORY_CAP_FLOOR_USD)` (gh #277), where
 * `price` is the SCALED price `priceOf` hands in: the plan's figure × `priceScale`,
 * so a plan whose prices sum past the stage is capped at a fraction of what it
 * wrote (gh #281). `storyCapDerivation` writes that fraction down beside the
 * cap, because a cap whose inputs are not on the record sends a person to the
 * wrong lever.
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
  return Math.max(price * storyCapMultiplierOf(parts), clampedStoryFloorUsd(parts));
}

/** `story_cap_floor_usd`, clamped to the stage's own ceiling — `storyCeilingUsd`'s floor. */
export function clampedStoryFloorUsd(parts: CapParts): number {
  return parts.budgetUsd > 0
    ? Math.min(storyCapFloorOf(parts), parts.budgetUsd)
    : storyCapFloorOf(parts);
}

/**
 * The least a developer is ALREADY allowed to be spawned with on this attempt —
 * never a new number (gh #325).
 *
 * A priced story's cap is `storyCeilingUsd / divisor`, and that ceiling never
 * drops below `clampedStoryFloorUsd`, so the floor ÷ the same divisor is the
 * smallest priced cap `developerCap` can hand out. An unpriced story has no
 * floor at all: its uniform share IS the only cap it is ever spawned with. Either
 * way it is clamped by `developerCap` itself, so `per_agent_max_usd` / `--max-usd`
 * still win.
 */
export function developerFloorUsd(parts: CapParts, storyId: string, attempt = 1): number {
  const cap = developerCap(parts, storyId, attempt);
  if (priceOf(parts, storyId) === null) return cap;
  return Math.min(cap, round2(clampedStoryFloorUsd(parts) / developerAttemptDivisor(attempt, attemptsOf(parts))));
}

// --- a parallel wave's lanes (gh #325) ------------------------------------------

/** A lane of the same wave whose developer is dispatched and not yet finished. */
export interface WaveLaneReservation {
  readonly storyId: string;
  /** What that developer was spawned under — unmetered money it may still spend. */
  readonly capUsd: number;
}

/** What the wave knows at the instant lane k is about to be dispatched. DATA only. */
export interface WaveLaneState {
  readonly storyId: string;
  readonly attempt: number;
  /** Lanes of this fan-out still in half A. */
  readonly inFlight: readonly WaveLaneReservation[];
  /**
   * Stories of this fan-out whose half A finished heading for a review. Half B
   * — every reviewer — runs only after the WHOLE fan-out returns, so their review
   * money is still owed while later lanes are dispatched.
   */
  readonly awaitingReview: number;
}

export type WaveLaneFunding =
  | { readonly kind: "dispatch"; readonly capUsd: number }
  | { readonly kind: "defer"; readonly reason: string };

/**
 * The developer cap one lane of a parallel wave may be dispatched under (gh #325).
 *
 * Every other cap in this file reads the stage's METERED remainder, and every one
 * of them assumed serial dispatch: a second story was only supposed to see the
 * stage once the first had metered. Two lanes spawned in the same instant both
 * see the whole stage. Measured live: a $21.60 stage handed S1 $21.00 and S2
 * $16.50 in one wave, spend landed at $33.07, and S2's reviewer was refused on
 * "$0.00 left".
 *
 * So lane k is bounded by the metered remainder, LESS what the lanes already in
 * flight were handed (money they may still spend and nothing has counted yet),
 * LESS one `REVIEWER_FLOOR_USD` for every story of the fan-out whose review is
 * still ahead of it, lane k's own included — so every dispatched story's review
 * stays fundable. A lane never gets MORE than `developerCap`.
 *
 * Below `developerFloorUsd` — the least a developer is already allowed — the lane
 * is DEFERRED when another lane is in flight: that lane's finish replaces its
 * reservation with its metered spend, which is the only thing that can change the
 * answer. With nothing in flight nothing will be freed by waiting (`spentUsd` is
 * this invocation's), so the lane is dispatched exactly as the floor allows —
 * never deferred into a stall and never spawned under a turn's floor.
 *
 * `null` from `stageRemainderUsd` — a stage with no budget figure — bounds
 * nothing: a remainder invented for it would be the confident zero §7 forbids.
 */
export function waveLaneFunding(parts: CapParts, spentUsd: number, lane: WaveLaneState): WaveLaneFunding {
  const own = developerCap(parts, lane.storyId, lane.attempt);
  const remainder = stageRemainderUsd(parts, spentUsd);
  if (remainder === null) return { kind: "dispatch", capUsd: own };
  const reservedUsd = round2(lane.inFlight.reduce((sum, r) => sum + r.capUsd, 0));
  const stories = lane.inFlight.length + lane.awaitingReview + 1;
  const floorsUsd = round2(stories * REVIEWER_FLOOR_USD);
  const bound = round2(remainder - reservedUsd - floorsUsd);
  const floor = developerFloorUsd(parts, lane.storyId, lane.attempt);
  if (bound >= floor) return { kind: "dispatch", capUsd: Math.min(own, bound) };
  if (lane.inFlight.length === 0) return { kind: "dispatch", capUsd: floor };
  const ids = lane.inFlight.map((r) => r.storyId).join(", ");
  return {
    kind: "defer",
    reason: `${lane.storyId}: not dispatched beside ${ids} yet — the stage has ${usd(remainder)} left, `
      + `${usd(reservedUsd)} is reserved for the developer(s) already in flight (${ids}) and ${usd(floorsUsd)} `
      + `holds a reviewer floor for ${String(stories)} story(ies), which leaves ${bound < 0 ? `-${usd(-bound)}` : usd(bound)} where `
      + `${lane.storyId}'s developer may not be spawned under ${usd(floor)}; it waits for a lane to meter`,
  };
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

/** What a story-boundary budget park (gh #354) names, for the operator line and the ledger. */
export interface BudgetParkReason {
  /** What the stage still has, right now — `stageRemainderUsd`'s own figure. */
  readonly remainderUsd: number;
  /** The least the stage must hold to fund ANOTHER turn at all — see `budgetParkFor`. */
  readonly floorUsd: number;
}

/**
 * Is there too little left in the stage to fund ANOTHER turn at all (gh #354)?
 * Modeled on `reviewerUnderfunded`'s own shape, and on its own THRESHOLD too —
 * deliberately `REVIEWER_FLOOR_USD`, not `developerFloorUsd`.
 *
 * `developerFloorUsd` is the wrong number to park on: gh #277 clamps a priced
 * story's floor to the STAGE's own `budget_usd` on purpose ("the ceiling may
 * exceed the stage — the stage's own budget gate is what stops a stage that
 * runs out, and it meters real spend rather than a guess"), so a story priced
 * near or above the whole stage — an intended, TESTED shape
 * (`test/build-executor.test.ts`'s "leaderboard-v2" case: a $3.85 stage funding
 * a $6.30 ceiling) — would make this park fire on nearly every dispatch. A
 * park is not "this story's ideal cap exceeds what is left"; it is "this stage
 * cannot fund a turn worth attempting, of ANY size" — the exact question
 * `reviewerUnderfunded` already asks and answers against the SAME fixed floor,
 * because a developer turn is never worth less than what a reviewer needs to
 * read its diff.
 *
 * `waveLaneFunding` computes a DIFFERENT, per-story `bound < floor` predicate
 * but, with nothing in flight to free money by finishing, dispatches anyway —
 * a deliberate choice for THAT function (its own docstring: "never spawned
 * under a turn's floor"). This is a separate, earlier, coarser question a
 * caller asks BEFORE deciding whether to call `waveLaneFunding` (or, in the
 * serial path, before calling `buildHalf`) at all: is the stage now so short
 * that the next story should not be STARTED, full stop. Callers park a story
 * on this rather than dispatch it underfunded (see `BuildSession`'s
 * `budgetPark` field and the two call sites in `executors/build.ts`, gh #354).
 *
 * `null` — never a park — when the stage carries no budget figure to subtract
 * from (`stageRemainderUsd`'s own null case) or when the remainder still
 * covers the floor.
 */
export function budgetParkFor(parts: CapParts, spentUsd: number): BudgetParkReason | null {
  const remainderUsd = stageRemainderUsd(parts, spentUsd);
  if (remainderUsd === null) return null;
  if (remainderUsd >= REVIEWER_FLOOR_USD) return null;
  return { remainderUsd, floorUsd: REVIEWER_FLOOR_USD };
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
  const sum = plannedSumUsd(parts);
  return sum <= parts.budgetUsd ? 1 : parts.budgetUsd / sum;
}

/** Σ of every usable plan price — what `priceScale` fits into the stage. */
export function plannedSumUsd(parts: CapParts): number {
  let sum = 0;
  for (const price of parts.prices.values()) {
    if (Number.isFinite(price) && price > 0) sum += price;
  }
  return sum;
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

// --- what a cap was derived from (gh #281) ------------------------------------

/**
 * Every input one priced story's developer cap was derived from, so the number
 * can be shown WITH its formula rather than as a conclusion.
 *
 * Measured on a live unattended run (0.18.2, gh #281): an eight-story plan
 * priced at $114.00 into a $16.20 stage. S4, priced $14.00, died twice on a
 * $5.97 cap while the refusal told the operator that "a story that really costs
 * more than the plan guessed wants a higher price there". The operator raised
 * every price ×4 and the cap did not move by a cent — `priceScale` keeps the
 * plan's RATIO and fits its SUM into the stage, so a uniform raise is absorbed
 * exactly. The arithmetic is deliberate; a refusal that names the one lever it
 * cannot be moved by is not. Nothing here is a second derivation: every figure
 * is read back off the functions above.
 */
export interface StoryCapDerivation {
  readonly storyId: string;
  readonly attempt: number;
  /** The price as written in `03-plan/budget.yml`. */
  readonly planPriceUsd: number;
  /** Σ of every usable price in that file (`plannedSumUsd`). */
  readonly plannedSumUsd: number;
  /** The stage's own `budget_usd` (`CapParts.budgetUsd`). */
  readonly stageBudgetUsd: number;
  /** `priceScale` — 1 when the plan fits the stage, `stage / Σ` when it does not. */
  readonly scale: number;
  /** `planPriceUsd × scale` — what `priceOf` hands the arithmetic. */
  readonly scaledPriceUsd: number;
  readonly multiplier: number;
  /** The floor as clamped to the stage (`storyCeilingUsd`'s own). */
  readonly floorUsd: number;
  /** `storyCeilingUsd` — attempt 1's whole ceiling. */
  readonly ceilingUsd: number;
  /** `developerAttemptDivisor` — 1 on the priced pass, `attempts` on the contingency. */
  readonly divisor: number;
  /** `developerCap` — what the spawn was actually handed, per-agent clamp included. */
  readonly capUsd: number;
}

/** Null for a story the plan did not price — its cap is the uniform share. */
export function storyCapDerivation(
  parts: CapParts, storyId: string, attempt = 1,
): StoryCapDerivation | null {
  const scaled = priceOf(parts, storyId);
  if (scaled === null) return null;
  const planPriceUsd = parts.prices.get(storyId) as number;
  const floorUsd = clampedStoryFloorUsd(parts);
  return {
    storyId,
    attempt,
    planPriceUsd,
    plannedSumUsd: plannedSumUsd(parts),
    stageBudgetUsd: parts.budgetUsd,
    scale: priceScale(parts),
    scaledPriceUsd: scaled,
    multiplier: storyCapMultiplierOf(parts),
    floorUsd,
    ceilingUsd: storyCeilingUsd(parts, scaled),
    divisor: developerAttemptDivisor(attempt, attemptsOf(parts)),
    capUsd: developerCap(parts, storyId, attempt),
  };
}

/** `$5.97` — two decimals, because every figure here is money on a record. */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * `0.1421`, not `0.14`: four places, so a reader recomputing `$14.00 × scale ×
 * 3` lands on the cap that was printed and not on a number a dime away from it.
 */
function scaleOf(scale: number): string {
  return scale === 1 ? "1" : scale.toFixed(4);
}

/**
 * The formula with its inputs — `cap $5.97 = plan price $14.00 × stage scale
 * 0.1421 (stage budget_usd $16.20 over $114.00 of plan prices) × story_cap_multiplier
 * 3 = $5.97, above the floor $4.00` — never the conclusion alone.
 */
export function describeStoryCap(d: StoryCapDerivation): string {
  const multiplied = d.scaledPriceUsd * d.multiplier;
  const scaleNote = d.scale === 1
    ? ` (stage scale 1: ${usd(d.plannedSumUsd)} of plan prices fit the stage's ${usd(d.stageBudgetUsd)})`
    : ` (stage budget_usd ${usd(d.stageBudgetUsd)} over ${usd(d.plannedSumUsd)} of plan prices)`;
  const scaleTerm = d.scale === 1 ? "" : ` × stage scale ${scaleOf(d.scale)}${scaleNote}`;
  const ceiling = multiplied >= d.floorUsd
    ? `plan price ${usd(d.planPriceUsd)}${scaleTerm} × story_cap_multiplier ${String(d.multiplier)}`
      + ` = ${usd(multiplied)}${d.scale === 1 ? scaleNote : ""}, above the floor ${usd(d.floorUsd)}`
    : `story_cap_floor_usd ${usd(d.floorUsd)} (plan price ${usd(d.planPriceUsd)} × stage scale ${scaleOf(d.scale)}`
      + ` × story_cap_multiplier ${String(d.multiplier)} = ${usd(multiplied)} is below it)`;
  const perAttempt = round2(d.ceilingUsd / d.divisor);
  const contingency = d.divisor === 1
    ? ""
    : `; attempt ${String(d.attempt)} is the contingency and gets that ÷ ${String(d.divisor)} = ${usd(perAttempt)}`;
  const clamp = d.capUsd < perAttempt
    ? `; clamped to ${usd(d.capUsd)} by per_agent_max_usd / --max-usd`
    : "";
  return `cap ${usd(d.capUsd)} = ${ceiling}${contingency}${clamp}`;
}

/**
 * The one command that moves a cap the plan's prices cannot — `tldrx budget
 * raise <phase> <usd> --run <run> --stage <stage>` (gh #244), built by the
 * caller that knows the ids and passed in as DATA, the way `agentCap` is.
 */
export interface CapLever {
  readonly raiseCommand: (amountUsd: number) => string;
}

/**
 * Why a story's turn stopped when its own per-story cap, not the work, decided
 * it (gh #277) — and what the cap was derived from, so the lever named is one
 * that moves it (gh #281).
 *
 * The provider's sentence carries the dollar figure, so it is quoted verbatim
 * rather than paraphrased. Same shape and purpose as `permissionBlockReason`: a
 * CAUSE, not a verdict on the diff. Three cases, because three different levers:
 *
 *  - a SCALED plan: the price cannot move the cap while Σ prices > stage, so
 *    the stage's own `budget_usd` is named with the command that lifts the
 *    scale to 1, and `story_cap_multiplier:` beside it;
 *  - an unscaled plan: the price IS a lever, and the sentence says so (the
 *    pre-#281 wording, which was right exactly here);
 *  - an unpriced story: there is no price to raise; the uniform share is named
 *    off the stage's own money.
 */
export function capDeathReason(
  error: string, parts: CapParts, storyId: string, attempt: number, lever: CapLever,
): string {
  const head = `the developer died on its per-story cap — ${error}: `;
  const d = storyCapDerivation(parts, storyId, attempt);
  if (d === null) {
    const cap = developerCap(parts, storyId, attempt);
    return head
      + `this story has no price in \`03-plan/budget.yml\`, so its cap ${usd(cap)} is the uniform share of the `
      + `stage's budget_usd ${usd(parts.budgetUsd)} over ${String(Math.max(parts.storyCount, 1))} story(ies)`
      + ` × ${String(attemptsOf(parts))} attempt(s) × (1 + reviewer share ${String(reviewerShareOf(parts))})`
      + ` — the stage's own \`budget_usd\` is what moves it (\`${lever.raiseCommand(parts.budgetUsd)}\` doubles it)`;
  }
  const formula = describeStoryCap(d);
  if (d.scale === 1) {
    return head + formula
      + "; a story that really costs more than the plan guessed wants a higher price in `03-plan/budget.yml` "
      + "or a higher `story_cap_multiplier:` on the stage";
  }
  const short = shortBy(d.plannedSumUsd, d.stageBudgetUsd);
  return head + formula
    + "; the plan's price cannot move this cap while the plan is scaled — raising every price keeps the "
    + "ratio and the sum still exceeds the stage — so raise the stage's own `budget_usd` "
    + `(\`${lever.raiseCommand(short)}\` lifts the scale to 1) or \`story_cap_multiplier:\` on the stage`;
}

/**
 * The bar the PROACTIVE advisory speaks above (gh #302): `priceScale` strictly
 * below this — a plan asking for more than 2× what the stage holds.
 *
 * gh #281 shipped the advisory at any `scale < 1`, and a read-only sample of 30
 * priced run dirs then measured it firing on 8 of them — 27% overall, 54% in one
 * workspace — at severities as mild as 0.85, where the plan asks ~18% more than
 * the stage and usually finishes without one story reaching its scaled cap. A
 * line on every Build entry and every Plan gate for a case that mild is the
 * wallpaper that teaches an operator to skip the channel before the one time it
 * matters (the same sample's 0.095 tail, >10× the stage). 0.5 is where the
 * owner put the line: the overage has to be large enough that a story is
 * plausibly going to die on its cap before a spawn is interrupted to say so.
 *
 * It bounds the PROACTIVE channel only. `capDeathReason` — the reactive one —
 * has no threshold and must not grow one: a story that actually died on its cap
 * is told why at every scale, however mild.
 */
export const PLAN_OVER_STAGE_ADVISORY_SCALE = 0.5;

/**
 * The Plan-time advisory (gh #281): a plan whose prices sum past the Build
 * stage's `budget_usd` used to pass its gate without a word, and the operator
 * learned the scale from a dead developer. The gate still passes — the scale is
 * a deliberate tolerance, not a refusal — and this says what it will do, with
 * the factor and the command that undoes it.
 *
 * Null when the plan fits, and null for a MILD overage too (gh #302): the bar is
 * `PLAN_OVER_STAGE_ADVISORY_SCALE`, and the reason it exists is written there.
 */
export function planOverStageAdvisory(parts: CapParts, lever: CapLever): string | null {
  const scale = priceScale(parts);
  if (scale >= PLAN_OVER_STAGE_ADVISORY_SCALE) return null;
  const sum = plannedSumUsd(parts);
  const factor = (sum / parts.budgetUsd).toFixed(1);
  let largest: string | null = null;
  for (const [id, price] of parts.prices) {
    if (Number.isFinite(price) && price > 0 && (largest === null || price > (parts.prices.get(largest) ?? 0))) {
      largest = id;
    }
  }
  const example = largest === null ? null : storyCapDerivation(parts, largest);
  const worked = example === null
    ? ""
    : `: ${example.storyId} priced ${usd(example.planPriceUsd)} gets max(${usd(example.planPriceUsd)} × ${scaleOf(scale)}`
      + ` × ${String(example.multiplier)}, ${usd(example.floorUsd)}) = ${usd(example.capUsd)}`;
  return `advisory: 03-plan/budget.yml prices ${usd(sum)} of stories into a stage whose budget_usd is `
    + `${usd(parts.budgetUsd)} — ${factor}× what the stage holds — so every per-story cap is derived from `
    + `the plan price × ${scaleOf(scale)}, not the price as written${worked}. Raising the prices cannot lift a `
    + `cap while their sum exceeds the stage; \`${lever.raiseCommand(shortBy(sum, parts.budgetUsd))}\` `
    + "makes the stage hold the plan as priced, or raise `story_cap_multiplier:` on the stage";
}

/**
 * What a ceiling is short by, rounded UP to the cent.
 *
 * Rounding up matters: `remaining` is a float difference, and a raise that lands
 * a hundredth of a cent under the estimate refuses the stage a second time — the
 * exact shape of the pilot failure this command exists to end. Since gh #281 it
 * is also `Σ plan prices − stage`, the raise that lifts `priceScale` to exactly
 * 1 — a raise a hundredth short leaves every cap a hair under the price. Defined
 * HERE, the leaf, and re-exported by `budget/budgetView.ts` where every other
 * caller reads it: one rounding rule, not a plan-price sibling of it.
 */
export function shortBy(estimate: number, remaining: number): number {
  return Math.max(0.01, Math.ceil((estimate - remaining) * 100) / 100);
}
