/**
 * gh #183 and #184, and the third defect of the same audit — three things 23 real
 * runs on three real workspaces could not say about themselves.
 *
 * Measured, week of 2026-09-07:
 *
 *  1. **No version anywhere.** `run.yml`'s `version: 1` is the FILE FORMAT's
 *     number; no record carried the framework's. Ten releases shipped that week
 *     and behaviour moved in three of them, so no run could be attributed to the
 *     code that produced it (#183).
 *  2. **No per-task wall clock.** `started_at` is the INVOCATION's stamp and
 *     `ended_at` is the write instant, so every task of one parallel invocation
 *     shares a start and their subtraction is close to the whole invocation. Three
 *     runs measured 34.5 h, 43.2 h and 36.8 h of span that no record could
 *     attribute to a phase or a sub-agent (#184).
 *  3. **`$0.00 spent` over unmetered work.** 45% of 845 task rows carry
 *     `cost_usd: null, metered: false`; two runs rendered `spent_usd: 0.00`
 *     against $3,000 and $200 ceilings after 30 and 9 stories.
 *
 * Every assertion below is against a MEASUREMENT, never a constant that produced
 * it: the version is compared to `package.json`, the spawned span to a fake agent
 * that genuinely sleeps, and the not-measured sentence to the string the renderer
 * emits rather than to a bare English word that innocent prose could satisfy.
 *
 * The three guards matter as much as the three fixes: an OLD record must read as
 * "not recorded" and a fully metered run must keep its plain figure. A caveat on
 * every screen is a caveat nobody reads.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { stageLines } from "../src/core/facilitator/runAuto.ts";
import { frameworkVersion, frameworkVersionSync } from "../src/core/frameworkVersion.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { asRunFile, recordedVersion, validateRunFile, VERSION_NOT_RECORDED } from "../src/core/run/RunFile.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { buildBudgetView, renderBudget } from "../src/core/budget/budgetView.ts";
import { spentClause, spentFigure, spentBasis, tallyOf } from "../src/core/budget/spentFigure.ts";
import { durationCell, durationSum, formatDurationMs } from "../src/core/run/duration.ts";
import { buildRunCost, renderRunCost, toAttempt } from "../src/core/budget/costView.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  makeFacilitatorWorkspace, type FacilitatorWorkspace,
} from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns the fake `claude` and a real `--prepare`/`--commit` cycle.
// Process cost is a property of the machine, so bun's fixed 5000 ms default
// measures the box rather than the code (#43).
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";

let ws: FacilitatorWorkspace | null = null;
afterEach(() => {
  ws?.dispose();
  ws = null;
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_CLAUDE_OUTPUTS;
  delete process.env.FAKE_CLAUDE_RUNDIR;
  delete process.env.FAKE_CLAUDE_SLEEP_MS;
  delete process.env.FAKE_CLAUDE_COST;
});

/** One stage, one declared output, no gate in the way of a headless turn. */
function workspace(): FacilitatorWorkspace {
  ws = makeFacilitatorWorkspace({
    scope: "tiny",
    stages: [{
      id: "brief", phase: "01-what", budgetUsd: 2, gate: "auto",
      outputs: [{ path: "01-what/brief.md" }],
    }],
  });
  return ws;
}

function next(w: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}): Promise<{
  code: number; lines: readonly string[];
}> {
  return runNext({
    root: w.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-28T09:00:00Z",
    ...overrides,
  });
}

/** Put the fake `claude` first on PATH and tell it what to write and how slow to be. */
function armFakeAgent(w: FacilitatorWorkspace, sleepMs: number): void {
  process.env.PATH = `${w.binDir}:${ORIGINAL_PATH}`;
  process.env.FAKE_CLAUDE_RUNDIR = w.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({ "01-what/brief.md": "# Brief\n\nbody\n" });
  process.env.FAKE_CLAUDE_SLEEP_MS = String(sleepMs);
}

function events(w: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(w.runDir).read();
}

function runFile(w: FacilitatorWorkspace) {
  return RunStore.open(w.runDir).run;
}

function taskRows(w: FacilitatorWorkspace) {
  return runFile(w).phases.flatMap((p) => p.stages).flatMap((s) => s.tasks);
}

// ---------------------------------------------------------------------------
// #183 — a run says which tldrx wrote it
// ---------------------------------------------------------------------------

describe("a run records the tldrx that wrote it (#183)", () => {
  /**
   * Against `package.json`, not against a literal: the point of the field is that
   * it equals what `tldrx --version` prints, and a test comparing it to a hard-
   * coded "0.11.1" would go green on a release that forgot to stamp anything.
   */
  test("`run new` stamps created_with AND last_written_by at the package version", async () => {
    const w = workspace();
    const version = await frameworkVersion();

    const run = runFile(w);
    expect(run.created_with).toBe(version);
    expect(run.last_written_by).toBe(version);
    // And on disk, not only in memory — this is the record, not a projection.
    const text = readFileSync(join(w.runDir, "run.yml"), "utf8");
    expect(text).toContain(`created_with: "${version}"`);
    expect(text).toContain(`last_written_by: "${version}"`);
  });

  /** The sync door and the async door are the same file and the same answer. */
  test("frameworkVersionSync agrees with frameworkVersion", async () => {
    expect(frameworkVersionSync()).toBe(await frameworkVersion());
  });

  /**
   * The guard that makes the field additive rather than required: a run.yml from
   * before it existed still loads, still validates, and READS AS "not recorded"
   * everywhere — never as a guessed version and never as `0.0.0` pretending to be
   * one somebody installed.
   */
  test("an old run.yml with neither stamp validates and reads as `not recorded`", () => {
    const w = workspace();
    const path = join(w.runDir, "run.yml");
    const stripped = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("created_with:") && !line.startsWith("last_written_by:"))
      .join("\n");
    writeFileSync(path, stripped, "utf8");

    const doc = parseYaml(stripped);
    expect(validateRunFile(doc).issues).toEqual([]);
    const run = asRunFile(doc);
    expect(run.created_with).toBeUndefined();
    expect(recordedVersion(run.created_with)).toBe(VERSION_NOT_RECORDED);

    const store = RunStore.open(w.runDir);
    const screen = renderStatus(buildStatus(store.run, store.budget, w.runDir));
    expect(screen).toContain(`created with ${VERSION_NOT_RECORDED}`);
    expect(screen).toContain(`last written by ${VERSION_NOT_RECORDED}`);
  });

  test("`run status` prints both stamps on a run that has them", () => {
    const w = workspace();
    const store = RunStore.open(w.runDir);
    const screen = renderStatus(buildStatus(store.run, store.budget, w.runDir));
    expect(screen).toContain(`created with ${frameworkVersionSync()}`);
    expect(screen).not.toContain(VERSION_NOT_RECORDED);
  });

  /** The spawn and its result both name the version — two ends, two records. */
  test("agent.spawned and agent.result carry tldrx_version", async () => {
    const w = workspace();
    armFakeAgent(w, 0);
    await next(w);

    const spawned = events(w).find((e) => e.type === "agent.spawned");
    const result = events(w).find((e) => e.type === "agent.result");
    expect(spawned?.payload.tldrx_version).toBe(frameworkVersionSync());
    expect(result?.payload.tldrx_version).toBe(frameworkVersionSync());
  });
});

// ---------------------------------------------------------------------------
// #184 — a task row carries a span, and says which span it is
// ---------------------------------------------------------------------------

describe("a task row carries a measured span (#184)", () => {
  /**
   * The fake agent SLEEPS for a known minimum, so the assertion is against a
   * behaviour rather than against the constant that produced it: a `duration_ms`
   * copied from `options.at` arithmetic could not clear this bar, and one read off
   * the process could not fall under it.
   */
  test("a spawned turn's row carries duration_ms >= the time it really took, basis `spawned`", async () => {
    const w = workspace();
    armFakeAgent(w, 250);

    await next(w);

    const rows = taskRows(w);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.duration_basis).toBe("spawned");
    expect(row?.duration_ms).toBeGreaterThanOrEqual(250);
    // And it is NOT the invocation's clock: `started_at` is `options.at`, a
    // 2026-08-28 stamp, and `ended_at` is now — subtracting those two yields a
    // span in DAYS. The whole issue is that they are not the same quantity.
    expect(row?.started_at).toBe("2026-08-28T09:00:00Z");
    expect(row?.duration_ms ?? 0).toBeLessThan(60 * 60 * 1000);

    // The event carries the same pair, so a ledger reader who never opens run.yml
    // gets the same answer.
    const result = events(w).find((e) => e.type === "agent.result");
    expect(result?.payload.duration_basis).toBe("spawned");
    expect(result?.payload.duration_ms).toBe(row?.duration_ms);
  });

  /**
   * The in-session half, and the honesty that makes it publishable: the span is
   * `--prepare` to `--commit`, it INCLUDES the host's own time, and it is labelled
   * `prepare-to-commit` so nothing can call it the sub-agent's.
   */
  test("a --prepare/--commit handshake yields basis `prepare-to-commit` over the measured gap", async () => {
    const w = workspace();
    const prepared = await next(w, { mode: "prepare" });
    expect(prepared.code).toBe(0);

    // The host's half of the handshake: the declared output, and a result envelope.
    writeFileSync(join(w.runDir, "01-what", "brief.md"), "# Brief\n\nbody\n", "utf8");
    writeFileSync(
      join(w.runDir, ".agent", "brief", "result.json"),
      `${JSON.stringify({ outputs: ["01-what/brief.md"], questions_asked: [], notes: "" })}\n`,
      "utf8",
    );

    const committed = await next(w, { mode: "commit" });
    expect(committed.code).toBe(0);

    const rows = taskRows(w);
    const row = rows[rows.length - 1];
    expect(row?.duration_basis).toBe("prepare-to-commit");
    // `prepared_at` is `options.at` — 2026-08-28T09:00:00Z on both invocations —
    // and the far end is the live clock, so the span is real and large. What is
    // asserted is that it EXISTS and is non-negative; asserting a small number
    // here would be asserting the fixture's clock, not the code.
    expect(typeof row?.duration_ms).toBe("number");
    expect(row?.duration_ms ?? -1).toBeGreaterThanOrEqual(0);
  });

  /**
   * The guard: a row written before #184 has no span, and every renderer says so
   * in words rather than printing `0s`. "It took no time" and "nobody timed it"
   * are different facts and only one of them is a measurement.
   */
  test("a row with no duration_ms renders `not recorded`, never `0s`", () => {
    expect(durationCell(undefined, undefined)).toBe("not recorded");
    expect(durationCell(undefined, "spawned")).toBe("not recorded");
    expect(durationSum([{}, {}])).toBe("not recorded");
    // A real zero-length span is still a span, and still says so.
    expect(durationCell(0, "spawned")).toBe("0s (spawned)");
    expect(formatDurationMs(252_000)).toBe("4m 12s");
    expect(formatDurationMs(3_780_000)).toBe("1h 3m");
  });

  /** Two bases never add up into one figure. The sum says which it is, or that it is mixed. */
  test("durationSum names a mixed basis and counts the rows it could not time", () => {
    expect(durationSum([{ ms: 1000, basis: "spawned" }, { ms: 2000, basis: "spawned" }]))
      .toBe("3s (spawned)");
    expect(durationSum([{ ms: 1000, basis: "spawned" }, { ms: 2000, basis: "prepare-to-commit" }]))
      .toBe("3s (mixed bases: prepare-to-commit + spawned)");
    expect(durationSum([{ ms: 1000, basis: "spawned" }, {}, {}]))
      .toBe("1s (spawned) — 2 of 3 attempts not recorded");
  });

  /** `tldrx cost` prints the column, with the absence sentence for old events. */
  test("`tldrx cost` shows a duration per attempt and `not recorded` for an old one", async () => {
    const w = workspace();
    armFakeAgent(w, 120);
    await next(w);

    const cost = buildRunCost(w.runDir);
    expect(cost).not.toBeNull();
    const screen = renderRunCost(cost as NonNullable<typeof cost>);
    expect(screen).toContain("DURATION");
    expect(screen).toContain("(spawned)");

    // An `agent.result` from before #184 — no duration keys at all.
    const old = toAttempt({
      ts: "2026-08-01T00:00:00Z", run: "r", stage: "brief", type: "agent.result",
      actor: "facilitator", cost_usd: 0.4,
      payload: { phase: "01-what", task: "t1", model: "sonnet", outputs: [] },
    } as TldrxEvent);
    expect(old?.durationMs).toBeUndefined();
    expect(durationCell(old?.durationMs, old?.durationBasis)).toBe("not recorded");
  });
});

// ---------------------------------------------------------------------------
// defect 3 — no bare `$0.00` over work nobody metered
// ---------------------------------------------------------------------------

describe("a spent figure names what it cannot see", () => {
  /** The three shapes, at the one implementation. */
  test("spentFigure: plain, floor, or not-measured", () => {
    expect(spentFigure({ usd: 12.4, unmetered: 0, metered: 5 })).toBe("$12.40");
    expect(spentFigure({ usd: 12.4, unmetered: 7, metered: 5 }))
      .toBe("≥ $12.40 (7 tasks unmetered)");
    expect(spentFigure({ usd: 0, unmetered: 9, metered: 0 }))
      .toBe("not measured: 9 in-session tasks, 0 metered");
    expect(spentFigure({ usd: 0, unmetered: 1, metered: 0 }))
      .toBe("not measured: 1 in-session task, 0 metered");
    // Never the thing the audit found.
    expect(spentFigure({ usd: 0, unmetered: 30, metered: 0 })).not.toContain("$0.00");
    // The whole clause, because `… 0 metered spent of $25.00 ceiling` is not English
    // and a caveat nobody can parse is a caveat nobody reads.
    expect(spentClause({ usd: 3.5, unmetered: 0, metered: 2 }, "$25.00"))
      .toBe("$3.50 spent of $25.00 ceiling");
    expect(spentClause({ usd: 0, unmetered: 9, metered: 0 }, "$25.00"))
      .toBe("not measured: 9 in-session tasks, 0 metered — the ceiling is $25.00");
  });

  test("spentBasis and tallyOf agree about what `metered: false` means", () => {
    expect(spentBasis(0)).toBe("complete");
    expect(spentBasis(1)).toBe("lower-bound");
    expect(tallyOf([
      { cost_usd: null, metered: false },
      { cost_usd: 1.25 },
      { cost_usd: 0.75, metered: true },
    ])).toEqual({ usd: 2, unmetered: 1, metered: 2 });
  });

  /**
   * The end-to-end shape of the two audited runs: every turn in-session, nothing
   * declared. Three screens, and none of them may print a bare `$0.00`.
   */
  test("a run whose every turn is unmetered renders the not-measured sentence, not `$0.00`", () => {
    const w = workspace();
    const store = RunStore.open(w.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) => ({
          ...stage,
          tasks: [1, 2, 3].map((n) => ({
            id: `t${String(n)}`, status: "done" as const, expert: null, model: null,
            cost_usd: null, metered: false, error: null, session_id: null,
            started_at: null, ended_at: null, outputs: [],
          })),
        })),
      })),
    }));
    store.save();

    const fresh = RunStore.open(w.runDir);
    const sentence = "not measured: 3 in-session tasks, 0 metered";

    const status = renderStatus(buildStatus(fresh.run, fresh.budget, w.runDir));
    expect(status).toContain(sentence);
    expect(status).not.toContain("$0.00 spent");

    const budget = renderBudget(buildBudgetView(fresh.run, fresh.budget, w.runDir));
    expect(budget).toContain(sentence);

    // And `budget.yml` itself says so, so a reader of the archive alone is not
    // left inferring it from a number that looks precise.
    const doc = parseYaml(readFileSync(join(w.runDir, "budget.yml"), "utf8")) as Record<string, unknown>;
    expect(doc.unmetered_tasks).toBe(3);
    expect(doc.spent_basis).toBe("lower-bound");
  });

  /**
   * The guard, and it is half the fix: a run that really did meter everything
   * keeps its plain figure, its plain screen and its `complete` basis.
   */
  test("a fully metered run keeps the plain figure", async () => {
    const w = workspace();
    armFakeAgent(w, 0);
    process.env.FAKE_CLAUDE_COST = "0.42";
    await next(w);

    const store = RunStore.open(w.runDir);
    expect(store.budget.unmetered_tasks).toBe(0);
    expect(store.budget.spent_basis).toBe("complete");

    const status = renderStatus(buildStatus(store.run, store.budget, w.runDir));
    expect(status).toContain("budget  $0.42 spent of");
    expect(status).not.toContain("unmetered");
    expect(status).not.toContain("not measured");
  });

  /** `budget.yml` grows two keys and reads tolerantly when they are absent. */
  test("budget.yml without the two keys still loads, as `0` and `complete`", () => {
    const w = workspace();
    const path = join(w.runDir, "budget.yml");
    const stripped = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("unmetered_tasks:") && !line.startsWith("spent_basis:"))
      .join("\n");
    writeFileSync(path, stripped, "utf8");
    const store = RunStore.open(w.runDir);
    expect(store.budget.unmetered_tasks).toBe(0);
    expect(store.budget.spent_basis).toBe("complete");
  });

  /** The run.yml emitter's own round-trip: what it writes, the validator accepts. */
  test("emitRunYaml's stamps round-trip through the validator", () => {
    const w = workspace();
    const store = RunStore.open(w.runDir);
    const text = emitRunYaml(store.run);
    expect(text).toContain("created_with:");
    const dir = mkdtempSync(join(tmpdir(), "tldrx-183-"));
    try {
      // Round-trip: what the emitter wrote is what the validator accepts.
      writeFileSync(join(dir, "run.yml"), text, "utf8");
      expect(validateRunFile(parseYaml(text)).issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `run auto`'s own stdout — the surface an operator actually watches while an
 * unattended loop runs, and the one that still printed a bare `$0.00`.
 *
 * `notifyFresh` already recomputed the same `stage.done` event through
 * `tallyOf`/`spentFigure`; `stageLines` did not, so the notification and the
 * terminal disagreed about the same stage. Asserted against the renderer with a
 * tally it is HANDED, so the test cannot pass by accident of a fixture's run.yml.
 */
describe("`run auto`'s per-stage line names what it did not meter", () => {
  const doneEvent = (cost: number): TldrxEvent => ({
    ts: "2026-09-07T10:00:00Z", run: "260907-x", stage: "build", type: "stage.done",
    actor: "facilitator", cost_usd: cost, payload: { phase: "04-build", cost_usd: cost },
  } as TldrxEvent);
  const gateEvent = (cost: number): TldrxEvent => ({
    ts: "2026-09-07T10:00:00Z", run: "260907-x", stage: "build", type: "gate.requested",
    actor: "facilitator", cost_usd: 0, payload: { phase: "04-build", cost_usd: cost },
  } as TldrxEvent);
  const outcome = { code: 0, lines: [] } as never;

  test("a stage whose every turn was in-session prints the fact, not `$0.00`", () => {
    const nothingMetered = () => ({ unmetered: 9, metered: 0 });
    const done = stageLines([doneEvent(0)], "04-build/build", outcome, nothingMetered);
    expect(done).toEqual([
      "04-build/build … done not measured: 9 in-session tasks, 0 metered",
    ]);
    expect(done.join("")).not.toContain("$0.00");

    // The gate branch is a second `done $…` and had the same bug.
    const gated = stageLines([gateEvent(0)], "04-build/build", outcome, nothingMetered);
    expect(gated).toEqual([
      "04-build/build … done not measured: 9 in-session tasks, 0 metered · awaiting human gate",
    ]);
    expect(gated.join("")).not.toContain("$0.00");
  });

  test("a partly metered stage prints the floor and the count", () => {
    const some = () => ({ unmetered: 3, metered: 2 });
    expect(stageLines([doneEvent(1.2)], "04-build/build", outcome, some)).toEqual([
      "04-build/build … done ≥ $1.20 (3 tasks unmetered)",
    ]);
  });

  /** The guard, and it is half the fix: a fully metered stage's line is unchanged. */
  test("a fully metered stage keeps the plain figure it always printed", () => {
    const allMetered = () => ({ unmetered: 0, metered: 4 });
    expect(stageLines([doneEvent(2.61)], "04-build/build", outcome, allMetered))
      .toEqual(["04-build/build … done $2.61"]);
    expect(stageLines([gateEvent(2.61)], "04-build/build", outcome, allMetered))
      .toEqual(["04-build/build … done $2.61 · awaiting human gate"]);
  });
});
