/**
 * The remaining-work brake (design §E.2, wave 4C).
 *
 * The failure being guarded, measured on `260830-tenancy-identity-customers`:
 * the budget refusal compared the phase's remaining dollars against
 * `stage.budget_usd` — the full static estimate, $18.00, written before a single
 * story ran and never revised. Five stories later, with a couple of reviewer
 * floors the only metered money left to spend, it refused the stage twice and the
 * host raised the ceiling twice for money nobody was going to spend.
 *
 * Two directions are asserted throughout, because a brake that got LOOSER by
 * accident is a worse bug than the one being fixed:
 *
 *  - the §9 case (most stories settled, the real remaining work small) is NOT
 *    refused;
 *  - a fixture whose remaining work genuinely does not fit still IS.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE, developerPriceDivisor,
  remainingWork, remainingWorkContext, renderRemainingWork, reviewVerdictsByStory,
} from "../src/core/budget/remainingWork.ts";
import {
  MAX_ATTEMPTS as BUILD_MAX_ATTEMPTS,
  REVIEWER_FLOOR_USD as BUILD_REVIEWER_FLOOR_USD,
  REVIEWER_SHARE as BUILD_REVIEWER_SHARE,
  developerPriceDivisor as buildDeveloperPriceDivisor,
  readReviewLedger,
} from "../src/core/facilitator/executors/build.ts";
import { buildBudgetView, renderBudget } from "../src/core/budget/budgetView.ts";
import { asRunBudget, type RunBudget } from "../src/core/budget/RunBudget.ts";
import { asRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

// --- a plan on disk, and nothing else ---------------------------------------

interface StoryFixture {
  readonly id: string;
  readonly status: string;
  /** Review verdicts already recorded for it. */
  readonly verdicts?: number;
  readonly reopenedAfter?: boolean;
}

interface PlanFixture {
  readonly stories: readonly StoryFixture[];
  /** `03-plan/budget.yml` per-story prices. Omitted writes no file at all. */
  readonly prices?: Readonly<Record<string, number>>;
  readonly planEconomy?: string;
}

let temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

/**
 * The smallest run directory `remainingWork` reads: waves, story statuses, the
 * Plan's prices, and the events the verdict counter walks. Deliberately NOT the
 * full build workspace — this is arithmetic over files, and a git repo would only
 * make the fixture slower and the failure harder to read.
 */
function planDir(fixture: PlanFixture): string {
  const runDir = mkdtempSync(join(tmpdir(), "tldrx-remaining-"));
  temps.push(runDir);
  const plan = join(runDir, "03-plan");
  mkdirSync(join(plan, "stories"), { recursive: true });
  write(join(plan, "waves.yml"), [
    "version: 1",
    "waves:",
    `  - {id: W1, stories: [${fixture.stories.map((s) => s.id).join(", ")}]}`,
    "",
  ].join("\n"));
  for (const story of fixture.stories) {
    write(join(plan, "stories", `${story.id}.md`), `---\nid: ${story.id}\nstatus: ${story.status}\n---\n`);
  }
  if (fixture.prices !== undefined) {
    write(join(plan, "budget.yml"), [
      "version: 1",
      'run: "260830-fixture"',
      "ceiling_usd: 18.0",
      "spent_usd: 0.0",
      ...(fixture.planEconomy === undefined ? [] : [`economy: ${fixture.planEconomy}`]),
      "per_phase_usd:",
      ...Object.entries(fixture.prices).map(([id, usd]) => `  ${id}: ${usd.toFixed(2)}`),
      "",
    ].join("\n"));
  }
  const events: string[] = [];
  for (const story of fixture.stories) {
    for (let i = 0; i < (story.verdicts ?? 0); i += 1) {
      events.push(JSON.stringify({
        ts: "2026-08-31T01:00:00Z", run: "260830-fixture", stage: "build",
        type: "check.failed", actor: "reviewer", cost_usd: 0,
        payload: { story: story.id, check: "review", verdict: "changes", detail: "wants tests" },
      }));
    }
    if (story.reopenedAfter === true) {
      events.push(JSON.stringify({
        ts: "2026-08-31T02:00:00Z", run: "260830-fixture", stage: "build",
        type: "story.reopened", actor: "alan", cost_usd: 0,
        payload: { story: story.id, note: "another go" },
      }));
    }
  }
  if (events.length > 0) write(join(runDir, "events.jsonl"), `${events.join("\n")}\n`);
  return runDir;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const BASE = {
  phaseId: "04-build",
  stageBudgetUsd: 18,
  stageSpentUsd: 0,
  perAgentMaxUsd: 18,
  maxUsd: null,
} as const;

// --- the constants ----------------------------------------------------------

describe("the cap constants are mirrored, not guessed", () => {
  test("every number this module restates equals the executor's own", () => {
    // The module header explains why they are restated (the budget-gate hook must
    // not drag `spawnAgent` in). This is the check that makes that safe.
    expect(MAX_ATTEMPTS).toBe(BUILD_MAX_ATTEMPTS);
    expect(REVIEWER_SHARE).toBe(BUILD_REVIEWER_SHARE);
    expect(REVIEWER_FLOOR_USD).toBe(BUILD_REVIEWER_FLOOR_USD);
  });

  test("and so does the per-attempt divisor gh #91 introduced", () => {
    // A schedule restated wrong is worse than a constant restated wrong: it would
    // put the brake's estimate and the executor's spend on different attempts.
    for (const attempt of [0, 1, 2, 3, 9]) {
      expect([attempt, developerPriceDivisor(attempt)])
        .toEqual([attempt, buildDeveloperPriceDivisor(attempt)]);
    }
    expect(developerPriceDivisor(1)).toBe(1 + REVIEWER_SHARE);
    expect(developerPriceDivisor(2)).toBe(MAX_ATTEMPTS * (1 + REVIEWER_SHARE));
  });
});

// --- the verdict counter ----------------------------------------------------

describe("counting the attempts a story has already spent", () => {
  test("agrees with readReviewLedger, story by story, on the same events file", () => {
    const dir = planDir({
      stories: [
        { id: "S1", status: "done", verdicts: 1 },
        { id: "S2", status: "review", verdicts: 1 },
        { id: "S3", status: "blocked", verdicts: 2 },
        { id: "S4", status: "todo" },
      ],
    });
    const mine = reviewVerdictsByStory(dir);
    for (const id of ["S1", "S2", "S3", "S4"]) {
      expect([id, mine.get(id) ?? 0]).toEqual([id, readReviewLedger(dir, id).verdicts]);
    }
  });

  test("a reviewer that ERRORED is not a verdict, and a reopen resets the count", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-remaining-"));
    temps.push(dir);
    write(join(dir, "events.jsonl"), [
      JSON.stringify({ type: "check.failed", payload: { story: "S1", check: "review", verdict: "changes", detail: "wants tests" } }),
      // the 2026-08-30 rule: an error is not a verdict
      JSON.stringify({ type: "check.failed", payload: { story: "S1", check: "review", verdict: "error", detail: "boom" } }),
      // a dod check is not a review
      JSON.stringify({ type: "check.passed", payload: { story: "S1", check: "dod", command: "npm test" } }),
      JSON.stringify({ type: "check.failed", payload: { story: "S2", check: "review", verdict: "changes" } }),
      JSON.stringify({ type: "story.reopened", payload: { story: "S2", note: "again" } }),
      "{ not json",
      "",
    ].join("\n"));
    const counts = reviewVerdictsByStory(dir);
    expect(counts.get("S1")).toBe(1);
    expect(counts.get("S2")).toBe(0);
    expect(counts.get("S1")).toBe(readReviewLedger(dir, "S1").verdicts);
    expect(counts.get("S2")).toBe(readReviewLedger(dir, "S2").verdicts);
  });
});

// --- the computation --------------------------------------------------------

describe("remaining work over a plan", () => {
  test("reproduces the §9 case: most stories settled, the remaining work is small", () => {
    // The live shape of `260830-tenancy-identity-customers`, read off its own run
    // dir on 2026-08-31: four stories done, S4 mid-attempt-2 with one verdict
    // already spent, S6 and S7 blocked. The stage was priced at $18.00.
    const dir = planDir({
      stories: [
        { id: "S1", status: "done" }, { id: "S2", status: "done" },
        { id: "S3", status: "done" }, { id: "S5", status: "done" },
        { id: "S4", status: "in_progress", verdicts: 1 },
        { id: "S6", status: "blocked" }, { id: "S7", status: "blocked" },
      ],
      prices: { S1: 4.75, S2: 0.75, S3: 3.25, S4: 3.75, S5: 2.25, S6: 1.25, S7: 1.00 },
    });
    const work = remainingWork({ ...BASE, runDir: dir, stageSpentUsd: 12.26 });

    expect(work.basis).toBe("plan");
    expect(work.staticUsd).toBe(18);
    // S4's price is $3.75 and its one remaining turn is ATTEMPT 2, whose divisor
    // gh #91 left alone: price / (2 attempts x 1.25) = $1.50. The reviewer's
    // derived quarter ($0.375) loses to the $1.00 floor.
    expect(work.stories).toEqual([{
      id: "S4", status: "in_progress", developerTurns: 1, reviews: 1,
      developerCapUsd: 1.5, developerCapsUsd: [1.5], reviewerCapUsd: 1, usd: 2.5,
    }]);
    expect(work.usd).toBe(2.5);
    expect(work.blocked).toEqual(["S6", "S7"]);
    expect(work.done).toBe(4);
    expect(renderRemainingWork(work)).toBe("remaining work: S4 dev $1.50 + reviewer $1.00 = $2.50");
    expect(remainingWorkContext(work).join("\n")).toContain("4 of 7 stories done");
    expect(remainingWorkContext(work).join("\n")).toContain("S6, S7 are blocked");
  });

  test("a story at `review` has already paid the developer turn under review", () => {
    const pending = remainingWork({
      ...BASE,
      runDir: planDir({ stories: [{ id: "S1", status: "review" }], prices: { S1: 10 } }),
    });
    const todo = remainingWork({
      ...BASE,
      runDir: planDir({ stories: [{ id: "S1", status: "todo" }], prices: { S1: 10 } }),
    });
    expect(pending.stories[0]?.developerTurns).toBe(1);
    expect(pending.stories[0]?.reviews).toBe(2);
    expect(todo.stories[0]?.developerTurns).toBe(2);
    expect(todo.stories[0]?.reviews).toBe(2);
    expect(pending.rawUsd).toBeLessThan(todo.rawUsd);
  });

  test("attempts already spent are not charged twice", () => {
    const fresh = remainingWork({
      ...BASE,
      runDir: planDir({ stories: [{ id: "S1", status: "todo" }], prices: { S1: 10 } }),
    });
    const half = remainingWork({
      ...BASE,
      runDir: planDir({ stories: [{ id: "S1", status: "todo", verdicts: 1 }], prices: { S1: 10 } }),
    });
    const spent = remainingWork({
      ...BASE,
      runDir: planDir({ stories: [{ id: "S1", status: "todo", verdicts: 2 }], prices: { S1: 10 } }),
    });
    // NOT `half x 2 = fresh` any more, and deliberately: since gh #91 the two
    // developer turns are priced differently — $8.00 for attempt 1, $4.00 for
    // attempt 2 — so a story with attempt 1 behind it drops exactly attempt 1's
    // developer cap plus one reviewer floor, and nothing else.
    expect(fresh.stories[0]?.developerCapsUsd).toEqual([8, 4]);
    expect(half.stories[0]?.developerCapsUsd).toEqual([4]);
    expect(fresh.rawUsd - half.rawUsd).toBeCloseTo(9, 5);   // $8.00 dev + $1.00 reviewer
    expect(half.rawUsd).toBeLessThan(fresh.rawUsd);
    expect(spent.rawUsd).toBe(0);
    expect(spent.stories).toEqual([]);
  });

  /**
   * gh #91, run `260901-leaderboard-v2`: the plan priced S2 at $2.10 of a $3.85
   * Build stage and the brake — mirroring the executor — priced its first turn at
   * $0.84. The brake and the spawn have to agree, so this is the same fixture as
   * the executor's own leaderboard-v2 test.
   */
  test("the leaderboard-v2 shape: the first turn is priced at what the plan said", () => {
    const dir = planDir({
      stories: [{ id: "S1", status: "todo" }, { id: "S2", status: "todo" }],
      prices: { S1: 1.75, S2: 2.10 },
    });
    const work = remainingWork({ ...BASE, runDir: dir, stageBudgetUsd: 3.85, perAgentMaxUsd: 3.85 });
    const s2 = work.stories.find((story) => story.id === "S2");
    expect(s2?.developerCapsUsd).toEqual([1.68, 0.84]);
    expect(s2?.developerCapUsd).toBe(1.68);
    expect(renderRemainingWork(work)).toContain("S2 dev $1.68 + $0.84");
  });

  test("a reopened story is charged its attempts again — a reopen RAISES the estimate", () => {
    const dir = planDir({
      stories: [{ id: "S1", status: "todo", verdicts: 2, reopenedAfter: true }],
      prices: { S1: 10 },
    });
    expect(remainingWork({ ...BASE, runDir: dir }).stories[0]?.reviews).toBe(2);
  });

  test("`blocked` costs nothing, and the caller is told so rather than left to assume", () => {
    const dir = planDir({
      stories: [{ id: "S1", status: "blocked" }, { id: "S2", status: "blocked" }],
      prices: { S1: 9, S2: 9 },
    });
    const work = remainingWork({ ...BASE, runDir: dir });
    expect(work.usd).toBe(0);
    expect(work.blocked).toEqual(["S1", "S2"]);
    expect(remainingWorkContext(work).join("\n")).toContain("tldrx story reopen");
    expect(renderRemainingWork(work)).toContain("nothing left to dispatch");
  });

  test("with no per-story prices it falls to the uniform share, exactly as the executor does", () => {
    // 4 stories, no `03-plan/budget.yml`: developer = ceiling / (4 x 2 x 1.25).
    const dir = planDir({
      stories: [
        { id: "S1", status: "todo" }, { id: "S2", status: "todo" },
        { id: "S3", status: "todo" }, { id: "S4", status: "todo" },
      ],
    });
    const work = remainingWork({ ...BASE, runDir: dir });
    expect(work.stories[0]?.developerCapUsd).toBe(1.8); // 18 / 10
    expect(work.stories[0]?.reviewerCapUsd).toBe(1); // derived $0.45 loses to the floor
  });

  test("`--max-usd` and `per_agent_max_usd` clamp a cap, as they do on a real spawn", () => {
    const dir = planDir({ stories: [{ id: "S1", status: "todo" }], prices: { S1: 18 } });
    expect(remainingWork({ ...BASE, runDir: dir }).stories[0]?.developerCapUsd).toBe(14.4);
    expect(remainingWork({ ...BASE, runDir: dir, perAgentMaxUsd: 2 }).stories[0]?.developerCapUsd).toBe(2);
    expect(remainingWork({ ...BASE, runDir: dir, maxUsd: 0.5 }).stories[0]?.developerCapUsd).toBe(0.5);
  });
});

// --- the economy label ------------------------------------------------------

describe("the economy label", () => {
  const fixture: PlanFixture = {
    stories: [{ id: "S1", status: "todo" }, { id: "S2", status: "todo" }],
    prices: { S1: 9, S2: 9 },
  };

  test("`host-tokens` zeroes the developer turns and keeps the reviewer floors", () => {
    const dir = planDir(fixture);
    const metered = remainingWork({ ...BASE, runDir: dir });
    const host = remainingWork({ ...BASE, runDir: dir, economy: "host-tokens" });
    expect(host.stories.every((s) => s.developerCapUsd === 0)).toBe(true);
    // The reviewer is NOT zeroed: outside attended mode `reviewAndSettle` still
    // spawns a metered one and its floor is real money.
    expect(host.stories.every((s) => s.reviewerCapUsd === REVIEWER_FLOOR_USD)).toBe(true);
    expect(host.usd).toBe(4); // 2 stories x 2 reviews x $1.00
    expect(host.usd).toBeLessThan(metered.usd);
    expect(remainingWorkContext(host).join("\n")).toContain("host-tokens");
  });

  /**
   * #22(c), owner decision 2026-09-01. Attendedness and the phase economy were
   * independent, so an attended run on a `metered-usd` phase still counted
   * developer turns the HOST pays for — an over-estimate of real money that the
   * brake and `run estimate` both reported. Attended ⇒ host economy for the
   * developer share, mirroring `economy: host-tokens` exactly.
   */
  test("an attended run zeroes the developer turns the same way (#22c)", () => {
    const dir = planDir(fixture);
    const metered = remainingWork({ ...BASE, runDir: dir });
    const attended = remainingWork({ ...BASE, runDir: dir, attended: true });

    expect(attended.stories.every((s) => s.developerCapUsd === 0)).toBe(true);
    // Same reason the host-tokens case keeps them: a reviewer floor is metered.
    expect(attended.stories.every((s) => s.reviewerCapUsd === REVIEWER_FLOOR_USD)).toBe(true);
    expect(attended.usd).toBe(4);
    expect(attended.usd).toBeLessThan(metered.usd);
    expect(remainingWorkContext(attended).join("\n")).toContain("attended");
  });

  test("attended and host-tokens together are the same answer, not a double discount", () => {
    const dir = planDir(fixture);
    const both = remainingWork({ ...BASE, runDir: dir, economy: "host-tokens", attended: true });
    expect(both.usd).toBe(4);
    expect(both.stories.every((s) => s.developerCapUsd === 0)).toBe(true);
  });

  test("an UNattended metered run is untouched — the developer share is still counted", () => {
    const dir = planDir(fixture);
    expect(remainingWork({ ...BASE, runDir: dir, attended: false }))
      .toEqual(remainingWork({ ...BASE, runDir: dir }));
  });

  test("a plan priced in `host-tokens` contributes no story prices — the uniform share applies", () => {
    // `loadPlanPrices` refuses that file; the point here is that the refusal
    // reaches this computation rather than being routed around it.
    const priced = remainingWork({ ...BASE, runDir: planDir(fixture) });
    const hostPriced = remainingWork({
      ...BASE,
      runDir: planDir({ ...fixture, planEconomy: "host-tokens" }),
    });
    expect(priced.stories[0]?.developerCapUsd).toBe(7.2); // 9 / 1.25, attempt 1
    expect(hostPriced.stories[0]?.developerCapUsd).toBe(3.6); // 18 / (2 x 2 x 1.25)
    // The price was actually DROPPED, not silently reused: assert it directly
    // rather than trusting a total the two paths could reach by coincidence.
    expect(remainingWork({
      ...BASE,
      runDir: planDir({ stories: fixture.stories, prices: { S1: 2, S2: 16 }, planEconomy: "host-tokens" }),
    }).stories.map((s) => s.developerCapUsd)).toEqual([3.6, 3.6]);
    expect(hostPriced.stories.map((s) => s.developerCapsUsd)).toEqual([[3.6, 3.6], [3.6, 3.6]]);
  });
});

// --- the two compat properties ---------------------------------------------

describe("what does not change", () => {
  test("no plan on disk ⇒ the static estimate, byte-identical to the old behaviour", () => {
    const empty = mkdtempSync(join(tmpdir(), "tldrx-remaining-"));
    temps.push(empty);
    const work = remainingWork({ ...BASE, runDir: empty });
    expect(work).toEqual({
      basis: "static", usd: 18, rawUsd: 18, staticUsd: 18, clamped: false,
      economy: "metered-usd", attended: false, stories: [], done: 0, total: 0, blocked: [],
    });
    expect(renderRemainingWork(work)).toBe("stage estimate $18.00");
    expect(remainingWorkContext(work)).toEqual([]);
  });

  test("a plan it cannot read falls back to the static estimate rather than throwing", () => {
    // Totality matters here: two of the three callers are the budget-gate hook
    // and `tldrx next`'s own brake, and the fallback is the SAFE direction.
    const dir = planDir({ stories: [{ id: "S1", status: "todo" }] });
    writeFileSync(join(dir, "03-plan", "waves.yml"), "waves: [[[ not yaml\n", "utf8");
    const work = remainingWork({ ...BASE, runDir: dir });
    expect(work.basis).toBe("static");
    expect(work.usd).toBe(18);
  });

  test("outside the Build phase the plan is not read at all", () => {
    const dir = planDir({ stories: [{ id: "S1", status: "todo" }], prices: { S1: 4 } });
    const work = remainingWork({ ...BASE, runDir: dir, phaseId: "03-plan" });
    expect(work.basis).toBe("static");
    expect(work.usd).toBe(18);
  });

  test("the estimate can only NARROW: it is capped at the stage's own price", () => {
    // Twelve tiny stories: each reviewer is floored at $1.00, so the honest sum
    // is 12 x 2 x ($0.13 + $1.00) = well above the $6.00 the stage was priced at.
    // A brake that got TIGHTER by accident is the failure to fear here.
    const dir = planDir({
      stories: Array.from({ length: 12 }, (_, i) => ({ id: `S${String(i + 1)}`, status: "todo" })),
    });
    const work = remainingWork({ ...BASE, runDir: dir, stageBudgetUsd: 6, perAgentMaxUsd: 6 });
    expect(work.rawUsd).toBeGreaterThan(6);
    expect(work.clamped).toBe(true);
    expect(work.usd).toBe(6);
    expect(work.usd).toBeLessThanOrEqual(work.staticUsd);
    expect(remainingWorkContext(work).join("\n")).toContain("capped at the static estimate");
  });

  test("across a spread of plan shapes the estimate never exceeds the static one", () => {
    for (const count of [1, 3, 7, 12, 24]) {
      for (const budget of [2, 8, 18, 50]) {
        const dir = planDir({
          stories: Array.from({ length: count }, (_, i) => ({ id: `S${String(i + 1)}`, status: "todo" })),
        });
        const work = remainingWork({
          ...BASE, runDir: dir, stageBudgetUsd: budget, perAgentMaxUsd: budget,
        });
        expect([count, budget, work.usd <= work.staticUsd]).toEqual([count, budget, true]);
      }
    }
  });
});

// --- `tldrx budget show` ----------------------------------------------------

describe("budget show's est. column", () => {
  const RUN: RunFile = asRunFile(parseYaml([
    "version: 1",
    'run: "260830-fixture"',
    'title: "Fixture"',
    "scope: feature",
    "status: running",
    'created_at: "2026-08-30T09:00:00Z"',
    'updated_at: "2026-08-30T09:00:00Z"',
    "repos: [app]",
    "cursor: {phase: \"04-build\", stage: build, task: null}",
    "budget: {ceiling_usd: 30.0, spent_usd: 12.0, per_agent_max_usd: 18.0}",
    "phases:",
    '  - id: "04-build"',
    "    status: running",
    "    stages:",
    "      - id: build",
    "        status: running",
    "        expert: developer",
    "        model: sonnet",
    "        budget_usd: 18.00",
    "        cost_usd: 12.26",
    "        started_at: null",
    "        ended_at: null",
    "        inputs: []",
    '        outputs: ["04-build/handoff.md"]',
    "        gate: {type: approve, status: pending, by: null, at: null, note: null}",
    "        tasks: []",
    "",
  ].join("\n")));

  const BUDGET: RunBudget = asRunBudget({
    version: 1, run: "260830-fixture", ceiling_usd: 30, per_agent_max_usd: 18,
    warn_at_pct: 80, on_exceed: "block",
    phases: [{ id: "04-build", ceiling_usd: 15, spent_usd: 12.26 }],
  });

  const FIXTURE: PlanFixture = {
    stories: [
      { id: "S1", status: "done" }, { id: "S2", status: "done" },
      { id: "S3", status: "done" }, { id: "S5", status: "done" },
      { id: "S4", status: "in_progress", verdicts: 1 },
      { id: "S6", status: "blocked" }, { id: "S7", status: "blocked" },
    ],
    prices: { S1: 4.75, S2: 0.75, S3: 3.25, S4: 3.75, S5: 2.25, S6: 1.25, S7: 1.00 },
  };

  test("with a run dir it prints the remaining work and its arithmetic, not the stage price", () => {
    const view = buildBudgetView(RUN, BUDGET, planDir(FIXTURE));
    const phase = view.phases[0];
    expect(phase?.next_estimate_usd).toBe(2.5);
    expect(phase?.next_estimate_basis).toBe("plan");
    expect(phase?.next_estimate_static_usd).toBe(18);
    expect(phase?.next_estimate_detail).toBe("remaining work: S4 dev $1.50 + reviewer $1.00 = $2.50");
    // $2.74 left against $2.50 of work: affordable, where the static $18.00 was
    // the number that demanded a raise.
    expect(phase?.blocked).toBe(false);
    const rendered = renderBudget(view);
    expect(rendered).toContain("$2.50");
    expect(rendered).toContain("remaining work: S4 dev $1.50 + reviewer $1.00");
    expect(rendered).toContain("(stage estimate $18.00)");
    expect(rendered).toContain("affordable in every phase");
  });

  test("without a run dir it is exactly what it always was", () => {
    const view = buildBudgetView(RUN, BUDGET);
    const phase = view.phases[0];
    expect(phase?.next_estimate_usd).toBe(18);
    expect(phase?.next_estimate_basis).toBe("static");
    expect(phase?.next_estimate_detail).toBe(null);
    expect(phase?.blocked).toBe(true);
    const rendered = renderBudget(view);
    expect(rendered).toContain("is BLOCKED");
    expect(rendered).not.toContain("remaining work:");
  });

  test("it still BLOCKS when the remaining work genuinely does not fit", () => {
    const starved = asRunBudget({
      ...BUDGET, phases: [{ id: "04-build", ceiling_usd: 13, spent_usd: 12.26 }],
    });
    const view = buildBudgetView(RUN, starved, planDir(FIXTURE));
    expect(view.phases[0]?.blocked).toBe(true);
    expect(view.phases[0]?.short_by_usd).toBe(1.76);
    expect(renderBudget(view)).toContain("is BLOCKED");
  });
});

// --- the brake itself, end to end -------------------------------------------

describe("the brake", () => {
  let open: BuildWorkspace[] = [];
  const ORIGINAL_PATH = process.env.PATH ?? "";
  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
    delete process.env.FAKE_BUILD_STATE;
    for (const ws of open) ws.dispose();
    open = [];
  });

  const PLAN: BuildWorkspaceOptions = {
    stories: [
      { id: "S1", epic: "E1", title: "One" },
      { id: "S2", epic: "E1", title: "Two" },
      { id: "S3", epic: "E1", title: "Three" },
    ],
    epics: [{ id: "E1", stories: ["S1", "S2", "S3"], branch: "epic/e1" }],
    waves: [["S1"], ["S2"], ["S3"]],
    budgetUsd: 9,
  };

  function workspace(): BuildWorkspace {
    const made = makeBuildWorkspace(PLAN);
    open.push(made);
    process.env.PATH = made.binDir;
    process.env.FAKE_BUILD_STATE = made.statePath;
    return made;
  }

  /** Leave the phase exactly `left` dollars, without touching anything else. */
  function starve(ws: BuildWorkspace, left: number): void {
    const path = join(ws.runDir, "budget.yml");
    const text = readFileSync(path, "utf8");
    writeFileSync(
      path,
      text.replace(/\{id: "04-build", ceiling_usd: [0-9.]+, spent_usd: [0-9.]+\}/,
        `{id: "04-build", ceiling_usd: ${left.toFixed(2)}, spent_usd: 0.00}`),
      "utf8",
    );
    expect(readFileSync(path, "utf8")).toContain(`ceiling_usd: ${left.toFixed(2)}`);
  }

  function settle(ws: BuildWorkspace, id: string, status: string): void {
    const path = join(ws.planDir, "stories", `${id}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/^status: .*$/m, `status: ${status}`), "utf8");
  }

  function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}) {
    return runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-31T09:00:00Z", ...overrides,
    });
  }

  test("§9's case is NOT refused: two of three stories settled, the last one fits", async () => {
    const ws = workspace();
    settle(ws, "S1", "done");
    settle(ws, "S2", "done");
    // $5.00 left against a $9.00 stage. The OLD brake compared $5.00 < $9.00 and
    // refused, which is precisely the $9.69 raise the host was asked for on
    // 2026-08-31 for money nobody was going to spend. The remaining work is S3
    // alone: two developer shares of $1.20 and two reviewer floors = $4.40.
    starve(ws, 5.0);

    const outcome = await next(ws);
    expect(outcome.code).not.toBe(2);
    expect(outcome.lines.join("\n")).not.toContain("refusing to start stage");
  });

  test("a fixture whose remaining work does not fit is still refused, showing its arithmetic", async () => {
    const ws = workspace();
    settle(ws, "S1", "done");
    settle(ws, "S2", "done");
    starve(ws, 0.4);

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain("refusing to start stage \"build\"");
    expect(text).toContain("$0.40 left and the remaining work is");
    expect(text).toContain("remaining work: S3 dev $");
    expect(text).toContain("reviewer $1.00");
    expect(text).toContain("2 of 3 stories done");
    expect(text).toContain("tldrx budget raise 04-build");

    const events = readFileSync(join(ws.runDir, "events.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    const blocked = events.find((e) => e.type === "budget.blocked");
    expect(blocked?.payload).toMatchObject({
      phase: "04-build", estimate_basis: "plan", static_estimate_usd: 9, stories_done: 2, stories_total: 3,
    });
    expect(events.some((e) => e.type === "agent.spawned")).toBe(false);
  });

  /**
   * gh #91 raised what one story may be dispatched at; it did not raise what the
   * PHASE may spend. The brake is the only thing between a starved phase and a
   * spawn — `runNext.runExecutor` skips it once the stage is `running` — so a
   * bigger first-attempt cap must still hit the same wall.
   */
  test("a PRICED plan is still refused at the wall, and spawns nothing", async () => {
    const ws = workspace();
    writeFileSync(join(ws.planDir, "budget.yml"), [
      "version: 1",
      `run: "${ws.runId}"`,
      "ceiling_usd: 9.00",
      "spent_usd: 0.00",
      "per_phase_usd:",
      "  S1: 2.00",
      "  S2: 2.50",
      "  S3: 4.50",
      "",
    ].join("\n"), "utf8");
    settle(ws, "S1", "done");
    settle(ws, "S2", "done");
    // S3 alone, priced $4.50: dev $3.60 (attempt 1) + $1.80 (attempt 2) + two
    // $1.00 reviewer floors = $7.40, against $0.40 of phase ceiling. The prices
    // are deliberately NOT the uniform share ($1.20), so a plan that went unread
    // fails this test rather than passing it by coincidence.
    starve(ws, 0.4);

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain("refusing to start stage \"build\"");
    expect(text).toContain("$0.40 left and the remaining work is");
    expect(text).toContain("remaining work: S3 dev $3.60 + $1.80");
    expect(text).toContain("= $7.40");
    const events = readFileSync(join(ws.runDir, "events.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string });
    expect(events.some((e) => e.type === "agent.spawned")).toBe(false);
  });

  test("with every story blocked there is no work left, and no refusal to make", async () => {
    const ws = workspace();
    settle(ws, "S1", "done");
    settle(ws, "S2", "blocked");
    settle(ws, "S3", "blocked");
    starve(ws, 0.05);

    const outcome = await next(ws);
    expect(outcome.code).not.toBe(2);
  });

  test("a stage whose phase cannot afford the FIRST attempt is refused exactly as before", async () => {
    // Nothing settled, so remaining work is the whole plan and the old wording
    // (`the stage estimate is …`) is what an operator would have seen anyway.
    const ws = workspace();
    starve(ws, 0.4);
    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("refusing to start stage \"build\"");
  });
});
