/**
 * What the Build stage still has to PAY FOR — as opposed to what it was priced at.
 *
 * ## The failure this exists for
 *
 * Measured 2026-08-30/31 on run `260830-tenancy-identity-customers`: the brake in
 * `runNext.budgetRefusal` compares the phase's remaining dollars against
 * `stage.budget_usd` — the stage's FULL static estimate, $18.00, the number the
 * Plan wrote before a single story had run. That number never shrinks. Five
 * stories later, with the entire remaining metered cost being a handful of
 * reviewer floors, the brake still demanded the whole $18 be affordable and
 * refused the stage twice ($9.69, then $2.32 of raises). The host moved money
 * that was never going to be spent, twice, to unblock work the run could already
 * afford.
 *
 * A stage estimate is the right question the FIRST time a stage runs. On every
 * cycle after that the right question is "what is left to do, and what will the
 * executor hand out for it".
 *
 * ## What this computes
 *
 * `Σ` over the stories that are still going to be dispatched, of exactly the caps
 * `build.ts` would hand out for them: the per-story prices from
 * `03-plan/budget.yml` run through the same scale/share arithmetic, the developer
 * and reviewer shares, `REVIEWER_FLOOR_USD`, and the attempts each story has left.
 *
 * Three sources, all already on disk and none of them a projection:
 *
 *  - `run/buildProgress.ts` — the story statuses, read from the story files;
 *  - `build/plan.ts loadPlanPrices` — the Plan's own per-story prices;
 *  - `events.jsonl` — how many review verdicts each story has already spent.
 *
 * ## Four rules, each with a reason
 *
 * **`done` costs nothing.** Obviously.
 *
 * **`blocked` costs nothing.** The executor hands a blocked story no cap: it is
 * out of attempts and only `tldrx story reopen` — a human decision — puts it back
 * in the queue. Counting money the framework cannot spend on its own is how the
 * static estimate got this wrong in the first place. A reopen legitimately raises
 * this number again, and the refusal message says blocked stories are excluded so
 * nobody reads a small figure as "the run is nearly finished".
 *
 * **A story at `review` has already paid its current developer turn.** Its diff
 * exists; what is outstanding is the verdict, and only a `changes` verdict buys
 * another developer turn. So it is charged one fewer developer share than it has
 * attempts.
 *
 * **The result is CLAMPED to the static estimate.** `REVIEWER_FLOOR_USD` breaks
 * the "every worst-case cap sums inside the stage ceiling" arithmetic by design
 * (see its comment in `build.ts`), so a naive Σ over many small stories can come
 * out ABOVE `stage.budget_usd`. A brake that got *tighter* by accident is a
 * regression dressed as a fix, so this is defined as a NARROWING of the existing
 * number and can only ever refuse less often, never more (design §E.4). The
 * unclamped figure is kept as `rawUsd` and said out loud when it bit.
 *
 * ## The economy label (design §E.2)
 *
 * Under `host-tokens` the developer turns are billed to the host session and this
 * process meters none of them, so their dollar cost is $0. The reviewer is NOT
 * zeroed: outside attended mode `reviewAndSettle` still spawns a metered reviewer,
 * and its floor is real money. Over-counting a reviewer that a host `--review`
 * cycle will not spawn is the safe direction; under-counting a spawn that will
 * happen is not.
 *
 * ## Why the constants are mirrored rather than imported
 *
 * `MAX_ATTEMPTS`, `REVIEWER_SHARE` and `REVIEWER_FLOOR_USD` live in
 * `facilitator/executors/build.ts`, which drags `spawnAgent`, `RunStore` and the
 * git seam in behind it. This module is loaded by the `budget-gate` PreToolUse
 * hook, which runs before every Bash call a session makes and must stay cheap.
 * The numbers are therefore restated here and `test/remaining-work.test.ts`
 * asserts they are identical to build.ts's — a duplication that is checked is a
 * different thing from one that is hoped about.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProgress, BUILD_PHASE, PLAN_DIR } from "../run/buildProgress.ts";
import { loadPlanPrices } from "../build/plan.ts";
import { looksLikeReviewerError } from "../build/review.ts";
import { DEFAULT_ECONOMY, type Economy } from "./RunBudget.ts";

/** Mirrors `build.ts`. See the module header for why, and the test that guards it. */
export const MAX_ATTEMPTS = 2;
/** Mirrors `build.ts`. */
export const REVIEWER_SHARE = 0.25;
/** Mirrors `build.ts`. */
export const REVIEWER_FLOOR_USD = 1.00;

/** How many stories the refusal message names before it starts counting. */
const NAMED_STORIES = 6;

export interface RemainingStory {
  readonly id: string;
  readonly status: string;
  /** Developer turns still to be dispatched for this story. */
  readonly developerTurns: number;
  /** Reviews still to be run for it. */
  readonly reviews: number;
  /** One developer cap, as `build.ts` would compute it. */
  readonly developerCapUsd: number;
  /** One reviewer cap, floor and all. */
  readonly reviewerCapUsd: number;
  readonly usd: number;
}

export interface RemainingWork {
  /**
   * `plan` — measured off the stories. `static` — there was no plan to measure,
   * so this is `stage.budget_usd` and the caller must behave exactly as it did
   * before this module existed.
   */
  readonly basis: "plan" | "static";
  /** The number the brake uses. Never above `staticUsd`. */
  readonly usd: number;
  /** The honest Σ, before the clamp. Equal to `usd` unless `clamped`. */
  readonly rawUsd: number;
  /** `stage.budget_usd` — what the brake compared against before. */
  readonly staticUsd: number;
  readonly clamped: boolean;
  readonly economy: Economy;
  /**
   * `attended_by: host` on the run this was measured for (issue #22, owner
   * decision 2026-09-01, policy (c)). Carried on the result because the developer
   * share is zeroed for the same REASON as under `host-tokens` — the host session
   * pays for those turns — and a reader told "$0.00 developer" is owed which of
   * the two facts put it there.
   */
  readonly attended: boolean;
  /** Only the stories that still cost something, richest first. */
  readonly stories: readonly RemainingStory[];
  readonly done: number;
  readonly total: number;
  /** Stories excluded because they are `blocked` — named, never silently dropped. */
  readonly blocked: readonly string[];
}

export interface RemainingWorkInput {
  readonly runDir: string;
  readonly phaseId: string;
  /** `stage.budget_usd` — the static estimate, and the ceiling on the answer. */
  readonly stageBudgetUsd: number;
  /** What this stage has already metered, for the reviewer floor's own clamp. */
  readonly stageSpentUsd: number;
  readonly perAgentMaxUsd: number;
  /** `--max-usd`, when the operator gave one. */
  readonly maxUsd?: number | null;
  readonly economy?: Economy;
  /**
   * `attended_by: host` — a host session drives this run and nothing here spawns
   * (issue #22 (c)). Absent means false, which is what every caller meant before
   * this field existed.
   *
   * Passed IN, exactly the way `economy` is, rather than read off `run.yml` here:
   * this module is loaded by the PreToolUse hook on a 50 ms budget and stays out
   * of `RunStore` on purpose.
   */
  readonly attended?: boolean;
}

/**
 * TOTAL, and null is not a return value: a stage with no plan — or a plan this
 * cannot read — gets `basis: "static"` carrying `stage.budget_usd`, so every
 * caller has one shape and the no-plan path stays byte-identical to what it was.
 *
 * Totality is load-bearing rather than tidy. Two of the three callers are places
 * a throw would be a disaster: the `budget-gate` PreToolUse hook (which runs
 * before every Bash command a session issues) and `tldrx next`'s own brake. And
 * the fallback is the SAFE direction — it is the number the brake used before
 * this existed, so an unreadable plan refuses exactly as often as it always did,
 * never less.
 */
export function remainingWork(input: RemainingWorkInput): RemainingWork {
  try {
    return measure(input);
  } catch {
    return staticOnly(input);
  }
}

function staticOnly(input: RemainingWorkInput): RemainingWork {
  return {
    basis: "static",
    usd: input.stageBudgetUsd,
    rawUsd: input.stageBudgetUsd,
    staticUsd: input.stageBudgetUsd,
    clamped: false,
    economy: input.economy ?? DEFAULT_ECONOMY,
    attended: input.attended === true,
    stories: [],
    done: 0,
    total: 0,
    blocked: [],
  };
}

function measure(input: RemainingWorkInput): RemainingWork {
  const economy = input.economy ?? DEFAULT_ECONOMY;
  // Attended ⇒ host economy for the DEVELOPER share (issue #22 (c)). The two were
  // independent, so an attended run on a `metered-usd` phase still counted turns
  // the host pays for — money this framework will never spend, over-estimated on
  // the brake and in `run estimate` alike. The reviewer floor is untouched for the
  // same reason `host-tokens` leaves it: outside attended mode it is real money,
  // and this is the safe direction when it is not.
  const hostPaysDeveloper = economy === "host-tokens" || input.attended === true;
  const fallback: RemainingWork = {
    basis: "static",
    usd: input.stageBudgetUsd,
    rawUsd: input.stageBudgetUsd,
    staticUsd: input.stageBudgetUsd,
    clamped: false,
    economy,
    attended: input.attended === true,
    stories: [],
    done: 0,
    total: 0,
    blocked: [],
  };
  // Outside Build there is no plan to have finished, exactly as `storiesCondition`
  // reasons about it — `03-plan/waves.yml` exists while the PLAN stage is still
  // gating, and every story is `todo` at that moment by design.
  if (input.phaseId !== BUILD_PHASE) return fallback;

  const progress = buildProgress(input.runDir);
  if (progress === null) return fallback;

  const all = progress.waves.flatMap((wave) => wave.stories);
  if (all.length === 0) return fallback;

  const ids = new Set(all.map((story) => story.id));
  // `loadPlanPrices` already refuses a `host-tokens`-priced file and already
  // narrows to stories this plan schedules; an implicit plan was priced by
  // nobody, so it is not asked.
  const prices = progress.implicit
    ? new Map<string, number>()
    : loadPlanPrices(join(input.runDir, PLAN_DIR), ids).prices;

  const verdicts = reviewVerdictsByStory(input.runDir);
  const caps = new CapMath(input, prices, all.length);

  const stories: RemainingStory[] = [];
  const blocked: string[] = [];
  let raw = 0;
  for (const story of all) {
    if (story.status === "done") continue;
    if (story.status === "blocked") {
      blocked.push(story.id);
      continue;
    }
    const attemptsLeft = Math.max(MAX_ATTEMPTS - (verdicts.get(story.id) ?? 0), 0);
    if (attemptsLeft === 0) continue;
    // The developer turn of the attempt now under review is already spent: the
    // diff is on the branch and only a `changes` verdict buys another one.
    const developerTurns = Math.max(attemptsLeft - (story.status === "review" ? 1 : 0), 0);
    const developerCapUsd = hostPaysDeveloper ? 0 : caps.developer(story.id);
    const reviewerCapUsd = caps.reviewer(story.id);
    const usd = round2(developerCapUsd * developerTurns + reviewerCapUsd * attemptsLeft);
    if (usd <= 0 && developerTurns === 0 && attemptsLeft === 0) continue;
    stories.push({
      id: story.id,
      status: story.status,
      developerTurns,
      reviews: attemptsLeft,
      developerCapUsd,
      reviewerCapUsd,
      usd,
    });
    raw = round2(raw + usd);
  }
  stories.sort((a, b) => b.usd - a.usd || a.id.localeCompare(b.id));

  const clamped = raw > input.stageBudgetUsd;
  return {
    basis: "plan",
    usd: clamped ? round2(input.stageBudgetUsd) : raw,
    rawUsd: raw,
    staticUsd: input.stageBudgetUsd,
    clamped,
    economy,
    attended: input.attended === true,
    stories,
    done: progress.done,
    total: progress.total,
    blocked,
  };
}

/**
 * `S4 dev $1.50 + reviewer $1.00 + S6 dev $0.50 ×2 + reviewer $1.00 ×2 = $5.00`
 *
 * The arithmetic, shown. An operator asked to move money is entitled to see what
 * the number is made of — the whole reason the old refusal was hard to argue with
 * is that `$18.00` cited nothing.
 */
export function renderRemainingWork(work: RemainingWork): string {
  if (work.basis === "static") return `stage estimate $${work.staticUsd.toFixed(2)}`;
  if (work.stories.length === 0) return `remaining work: nothing left to dispatch = $0.00`;
  const named = work.stories.slice(0, NAMED_STORIES).map((story) => {
    const parts: string[] = [];
    if (story.developerTurns > 0) {
      parts.push(`${story.id} dev $${story.developerCapUsd.toFixed(2)}${times(story.developerTurns)}`);
    }
    if (story.reviews > 0) {
      const label = story.developerTurns > 0 ? "reviewer" : `${story.id} reviewer`;
      parts.push(`${label} $${story.reviewerCapUsd.toFixed(2)}${times(story.reviews)}`);
    }
    return parts.join(" + ");
  });
  const rest = work.stories.length - named.length;
  const tail = rest > 0 ? ` + ${String(rest)} more` : "";
  return `remaining work: ${named.join(" + ")}${tail} = $${work.rawUsd.toFixed(2)}`;
}

/** The one line that explains a number smaller than the stage was priced at. */
export function remainingWorkContext(work: RemainingWork): string[] {
  if (work.basis === "static") return [];
  const lines = [
    `${String(work.done)} of ${String(work.total)} stories done; `
    + `the stage's static estimate is $${work.staticUsd.toFixed(2)}.`,
  ];
  if (work.blocked.length > 0) {
    lines.push(
      `${work.blocked.join(", ")} ${work.blocked.length === 1 ? "is" : "are"} blocked and cost $0.00 here — `
      + "the executor dispatches a blocked story only after `tldrx story reopen`, which would raise this.",
    );
  }
  if (work.clamped) {
    lines.push(
      `the caps sum to $${work.rawUsd.toFixed(2)}, above the stage's own $${work.staticUsd.toFixed(2)}; `
      + "capped at the static estimate so this brake can never refuse more often than it used to.",
    );
  }
  if (work.economy === "host-tokens" || work.attended) {
    const why = work.economy === "host-tokens"
      ? "this phase is priced in `host-tokens`"
      : "this run is attended_by: host";
    lines.push(
      `developer turns cost $0.00 here: ${why} and the host session pays `
      + "for them. The reviewer floors are still metered dollars.",
    );
  }
  return lines;
}

/** `` (once) or ` ×2`. */
function times(n: number): string {
  return n > 1 ? ` ×${String(n)}` : "";
}

/**
 * `build.ts`'s cap arithmetic, restated over data read off disk instead of over
 * an executor's live state. Every method mirrors the private one it is named
 * after; the shapes are deliberately identical so a diff between them is legible.
 */
class CapMath {
  private readonly scale: number;
  private readonly maxBudgetUsd: number;

  constructor(
    private readonly input: RemainingWorkInput,
    private readonly prices: ReadonlyMap<string, number>,
    private readonly storyCount: number,
  ) {
    let sum = 0;
    for (const price of prices.values()) {
      if (Number.isFinite(price) && price > 0) sum += price;
    }
    this.scale = input.stageBudgetUsd <= 0 || sum <= input.stageBudgetUsd
      ? 1
      : input.stageBudgetUsd / sum;
    this.maxBudgetUsd = this.agentCap(1);
  }

  developer(storyId: string): number {
    const price = this.priceOf(storyId);
    if (price === null) return this.agentCap(1 / this.worstCaseShares());
    return this.agentCap(this.shareOf(price / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE))));
  }

  reviewer(storyId: string): number {
    const price = this.priceOf(storyId);
    const derived = price === null
      ? this.agentCap(REVIEWER_SHARE / this.worstCaseShares())
      : this.agentCap(this.shareOf(price * REVIEWER_SHARE / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE))));
    const floor = Math.min(
      REVIEWER_FLOOR_USD,
      Math.max(this.input.stageBudgetUsd - this.input.stageSpentUsd, 0),
    );
    return round2(Math.min(Math.max(derived, floor), this.maxBudgetUsd));
  }

  private priceOf(storyId: string): number | null {
    const price = this.prices.get(storyId);
    if (price === undefined || !Number.isFinite(price) || price <= 0) return null;
    return price * this.scale;
  }

  private shareOf(usd: number): number {
    return this.input.stageBudgetUsd <= 0 ? 1 : usd / this.input.stageBudgetUsd;
  }

  private worstCaseShares(): number {
    return Math.max(this.storyCount, 1) * MAX_ATTEMPTS * (1 + REVIEWER_SHARE);
  }

  /** `runNext.agentCap`, with the same three candidates and the same rounding. */
  private agentCap(share: number): number {
    const candidates = [this.input.stageBudgetUsd * share, this.input.perAgentMaxUsd];
    const flag = this.input.maxUsd;
    if (flag !== undefined && flag !== null) candidates.push(flag);
    return round2(Math.min(...candidates));
  }
}

/**
 * How many review VERDICTS each story has recorded — the counter `build.ts`'s
 * `readReviewLedger` calls `verdicts` and the executor turns into an attempt
 * number.
 *
 * Two rules, both `readReviewLedger`'s, both load-bearing:
 *
 *  - a `check.passed`/`check.failed` whose `check` is `review` counts, UNLESS the
 *    event describes a reviewer that failed — an error is not a verdict, which is
 *    the rule that landed on 2026-08-30;
 *  - `story.reopened` resets the count to zero, because a human closed that run
 *    of attempts by hand.
 *
 * One pass for every story, where `readReviewLedger` is one pass per story: this
 * is called for a whole plan at once.
 */
export function reviewVerdictsByStory(runDir: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return counts;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return counts;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      // A half-written last line is not a reason to lose the count.
      continue;
    }
    const payload = event.payload ?? {};
    const story = payload.story;
    if (typeof story !== "string" || story === "") continue;
    if (event.type === "story.reopened") {
      counts.set(story, 0);
      continue;
    }
    if (event.type !== "check.passed" && event.type !== "check.failed") continue;
    if (payload.check !== "review") continue;
    if (reviewEventErrored(payload)) continue;
    counts.set(story, (counts.get(story) ?? 0) + 1);
  }
  return counts;
}

/** `build.ts`'s `reviewEventErrored`, restated. Two recorded shapes, two eras. */
function reviewEventErrored(payload: Record<string, unknown>): boolean {
  if (payload.verdict === "error") return true;
  if (payload.verdict !== "changes") return false;
  return typeof payload.detail === "string" && looksLikeReviewerError(payload.detail);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
