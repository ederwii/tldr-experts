/**
 * A parallel wave reserves money for the lanes it has already dispatched (gh #325).
 *
 * Measured live (tldrx 0.27.0, run `260914-tenant-credits`): a $21.60 Build stage
 * spawned S1 under `max_budget_usd: 21` and S2 under `16.5` in the SAME wave, before
 * either had metered a cent — every cap was derived off the stage's metered remainder,
 * which is stale by construction for two turns started at the same moment. Spend
 * landed at $33.07 and S2's reviewer was refused with "$0.00 left".
 *
 * The fake `claude` records every `--max-budget-usd` it was spawned with, and the
 * `timeline.jsonl` happens-before record (see `build-parallel.test.ts`) says what
 * overlapped. Nothing here asserts on elapsed time.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import {
  REVIEWER_FLOOR_USD, waveLaneFunding, type CapParts,
} from "../src/core/build/caps.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_STATE", "FAKE_BUILD_LIVE_DIR", "FAKE_BUILD_SLEEP_MS", "FAKE_BUILD_COST"] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const TWO_IN_ONE_WAVE: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First" },
    { id: "S2", epic: "E1", title: "Second" },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1", "S2"]],
};

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  process.env.FAKE_BUILD_LIVE_DIR = join(made.root, "live");
  // Long enough that a lane dispatched beside another really overlaps it.
  process.env.FAKE_BUILD_SLEEP_MS = "300";
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z",
    ...overrides,
  });
}

function priceStories(ws: BuildWorkspace, prices: Record<string, number>): void {
  writeFileSync(join(ws.planDir, "budget.yml"), [
    "version: 1", `run: "${ws.runId}"`, "ceiling_usd: 8.00", "spent_usd: 0.00", "per_phase_usd:",
    ...Object.entries(prices).map(([id, usd]) => `  ${id}: ${usd.toFixed(2)}`), "",
  ].join("\n"), "utf8");
}

/** `[story, max_budget_usd]` of every DEVELOPER spawn, in event order. */
function developerCaps(ws: BuildWorkspace): readonly (readonly [string, number])[] {
  return (EventLog.forRun(ws.runDir).read() as readonly { type: string; payload: Record<string, unknown> }[])
    .filter((e) => e.type === "agent.spawned" && e.payload.role === "developer")
    .map((e) => [String(e.payload.story), Number(e.payload.max_budget_usd)] as const);
}

interface TimelineEntry { readonly story: string; readonly role: string; readonly event: string; readonly live: number }

function developerTimeline(ws: BuildWorkspace): readonly TimelineEntry[] {
  const path = join(ws.root, "live", "timeline.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TimelineEntry)
    .filter((e) => e.role === "developer");
}

describe("a parallel wave reserves what its dispatched lanes may still spend (gh #325)", () => {
  test("(a) two lanes in flight: their developer caps plus a reviewer floor each fit inside the stage", async () => {
    // $20 stage, both stories priced $3.00 → each developer's own cap is max(3 × 3, $4) = $9.00.
    // Before #325 both were spawned at $9.00 at once: $18 of developer caps + $4 of reviewer
    // floors = $22 claimed against $20 before either metered a cent.
    const ws = workspace({ ...TWO_IN_ONE_WAVE, budgetUsd: 20, perAgentMaxUsd: 40 });
    priceStories(ws, { S1: 3, S2: 3 });

    const outcome = await next(ws, { parallel: 2 });
    expect(outcome.code).toBe(4);

    // They really did overlap — this is the concurrent case, not a serialised one.
    expect(Math.max(...developerTimeline(ws).map((e) => e.live))).toBe(2);
    // Sorted: which spawn EVENT lands first is the lanes' race; which lane was FUNDED first is not.
    const caps = [...developerCaps(ws)].sort(([a], [b]) => a.localeCompare(b));
    expect(caps.map(([id]) => id)).toEqual(["S1", "S2"]);
    const claimed = caps.reduce((sum, [, cap]) => sum + cap, 0) + caps.length * REVIEWER_FLOOR_USD;
    expect(claimed).toBeLessThanOrEqual(20);
    // S1 keeps its own cap; S2 gets what is left once S1's $9.00 and two review floors are held.
    expect(caps).toEqual([["S1", 9], ["S2", 7]]);
  }, 90_000);

  test("(b) a wave too poor for lane 2 defers it, says why with the figures, and runs it after lane 1 meters", async () => {
    // $8 stage, both priced $2.00 → each cap $6.00. S1 takes $6.00 (≤ $8 − one $2 floor);
    // S2's bound is $8.00 − $6.00 reserved − 2 × $2.00 floors = −$2.00, below the $4.00 floor.
    const ws = workspace({ ...TWO_IN_ONE_WAVE, budgetUsd: 8, perAgentMaxUsd: 40 });
    priceStories(ws, { S1: 2, S2: 2 });

    const outcome = await next(ws, { parallel: 2 });
    expect(outcome.code).toBe(4);
    const text = outcome.lines.join("\n");

    expect(text).toContain(
      "S2: not dispatched beside S1 yet — the stage has $8.00 left, $6.00 is reserved for the developer(s) "
      + "already in flight (S1) and $4.00 holds a reviewer floor for 2 story(ies), which leaves -$2.00 where "
      + "S2's developer may not be spawned under $4.00; it waits for a lane to meter",
    );

    const devs = developerTimeline(ws);
    const s1End = devs.findIndex((e) => e.story === "S1" && e.event === "end");
    const s2Start = devs.findIndex((e) => e.story === "S2" && e.event === "start");
    expect(s1End).toBeGreaterThanOrEqual(0);
    expect(s2Start).toBeGreaterThan(s1End);
    expect(Math.max(...devs.map((e) => e.live))).toBe(1);
    // Alone, nothing in flight can free money by waiting: S2 is dispatched at the $4.00 floor
    // ($7.90 left less S1's owed review floor and its own is $3.90), never under it.
    expect(developerCaps(ws)).toEqual([["S1", 6], ["S2", 4]]);

    // S2 ran once S1 had metered, and both stories still landed.
    for (const id of ["S1", "S2"]) {
      expect(readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8")).toContain("status: done");
    }
  }, 90_000);

  test("(c) GUARD: `--parallel 1` is untouched — each developer gets its own cap, as before #325", async () => {
    // A guard, not a proof: this passed before the fix and must keep passing. The
    // byte-level proof of the serial path is `build-golden.test.ts`.
    const ws = workspace({ ...TWO_IN_ONE_WAVE, budgetUsd: 8, perAgentMaxUsd: 40 });
    priceStories(ws, { S1: 2, S2: 2 });

    const outcome = await next(ws, { parallel: 1 });
    expect(outcome.code).toBe(4);
    expect(developerCaps(ws)).toEqual([["S1", 6], ["S2", 6]]);
    expect(outcome.lines.join("\n")).not.toContain("not dispatched beside");
  }, 90_000);
});

describe("waveLaneFunding — the arithmetic, as data", () => {
  const parts = (budgetUsd: number, prices: Record<string, number>): CapParts => ({
    prices: new Map(Object.entries(prices)),
    storyCount: Object.keys(prices).length,
    budgetUsd,
    maxBudgetUsd: 40,
    agentCap: (share = 1) => Math.round(Math.min(budgetUsd * share, 40) * 100) / 100,
  });

  test("a lane alone is bounded by the remainder less its own review floor", () => {
    const f = waveLaneFunding(parts(20, { S1: 5, S2: 5 }), 0, {
      storyId: "S1", attempt: 1, inFlight: [], awaitingReview: 0,
    });
    // own cap $15.00, bound $20 − $2 = $18 → $15.00
    expect(f).toMatchObject({ kind: "dispatch", capUsd: 15 });
  });

  test("the reservation and one floor per story are both subtracted", () => {
    const f = waveLaneFunding(parts(30, { S1: 5, S2: 5 }), 0, {
      storyId: "S2", attempt: 1, inFlight: [{ storyId: "S1", capUsd: 15 }], awaitingReview: 0,
    });
    // $30 − $15 − 2 × $2 = $11 < own cap $15 → $11
    expect(f).toMatchObject({ kind: "dispatch", capUsd: 11 });
  });

  test("a story whose review is still owed keeps its floor held", () => {
    const f = waveLaneFunding(parts(30, { S1: 5, S2: 5, S3: 5 }), 0, {
      storyId: "S3", attempt: 1, inFlight: [{ storyId: "S1", capUsd: 15 }], awaitingReview: 1,
    });
    // $30 − $15 − 3 × $2 = $9 → $9
    expect(f).toMatchObject({ kind: "dispatch", capUsd: 9 });
  });

  test("below the developer floor with a lane in flight, it defers", () => {
    const f = waveLaneFunding(parts(20, { S1: 5, S2: 5 }), 0, {
      storyId: "S2", attempt: 1, inFlight: [{ storyId: "S1", capUsd: 15 }], awaitingReview: 0,
    });
    expect(f.kind).toBe("defer");
  });

  test("with nothing in flight there is nothing to wait for: never deferred, never under the floor", () => {
    const f = waveLaneFunding(parts(8, { S1: 2, S2: 2 }), 7.9, {
      storyId: "S2", attempt: 1, inFlight: [], awaitingReview: 1,
    });
    expect(f).toMatchObject({ kind: "dispatch", capUsd: 4 });
  });

  test("a stage with no budget figure is not bounded — nothing here can count its money (§7)", () => {
    const f = waveLaneFunding(parts(0, {}), 0, {
      storyId: "S2", attempt: 1, inFlight: [{ storyId: "S1", capUsd: 5 }], awaitingReview: 0,
    });
    expect(f.kind).toBe("dispatch");
  });
});
