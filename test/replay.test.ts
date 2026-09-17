import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { BUDGET_FILE, listRuns, loadRun, renderReplay, runDir } from "../src/core/replay/index.ts";
import { NO_REASON_RECORDED, STAGE_FAILED_MARKER } from "../src/core/replay/renderReplay.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_NOT_FOUND, EXIT_OK } from "../src/cli/exitCodes.ts";
import { VIEWS_FIXTURE, VIEWS_RUN, makeViewsWorkspace } from "./fixtures/views/tempViews.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

async function tldrx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

const loaded = loadRun(VIEWS_FIXTURE, VIEWS_RUN)!;
const narrative = renderReplay(loaded);

describe("loadRun", () => {
  test("reads the spec §2.2 shape, including the parts the v0 validator rejects", () => {
    expect(loaded.run.run).toBe(VIEWS_RUN);
    expect(loaded.run.status).toBe("awaiting_gate");
    expect(loaded.run.cursor).toEqual({ phase: "02-how", stage: "how", task: null });
    expect(loaded.run.ceiling_usd).toBe(25);
    expect(loaded.run.ceiling_basis).toBe("recorded");
    expect(loaded.run.ceiling_reason).toBeNull();
    expect(loaded.run.phases.map((phase) => phase.id)).toEqual(["01-what", "02-how"]);
    expect(loaded.budget?.on_exceed).toBe("warn");
  });

  test("every event carries its 1-based line in events.jsonl", () => {
    expect(loaded.eventsError).toBeNull();
    expect(loaded.events).toHaveLength(21);
    expect(loaded.events[0]!.line).toBe(1);
    expect(loaded.events[0]!.event.type).toBe("run.created");
    expect(loaded.events.at(-1)!.line).toBe(loaded.events.length);
  });

  test("listRuns finds the fixture run", () => {
    expect(listRuns(VIEWS_FIXTURE)).toEqual([VIEWS_RUN]);
  });
});

/**
 * #245, owner decision "Null con razón": a DAMAGED `budget.yml` — one that
 * EXISTS but will not parse — must never resurrect `run.yml`'s frozen creation
 * mirror as if it were live. The fixture's mirror is `ceiling_usd: 25.0` — the
 * same figure `budget.yml` itself carries — so a regression that restores the
 * fallback would still pass a bare `toBe(25)` on the ceiling; the tests below
 * also pin `ceiling_basis` and `ceiling_reason`, which only the fallback's
 * removal can satisfy.
 *
 * A run with NO `budget.yml` at all is a DIFFERENT case, deliberately left
 * alone (§ below): it was never raised through a file it never had, so there
 * is nothing for the mirror to disagree with, and `test/dashboard-hero.test.ts`
 * / `test/dashboard-sources.test.ts` already pin the mirror fallback for it.
 */
describe("loadRun — damaged budget.yml (#245)", () => {
  test("an unparseable budget.yml nulls the ceiling with basis absent and a reason naming the file", () => {
    const views = makeViewsWorkspace();
    try {
      writeFileSync(join(runDir(views.root, VIEWS_RUN), BUDGET_FILE), "ceiling_usd: [this is not yaml\n");
      const damaged = loadRun(views.root, VIEWS_RUN)!;
      expect(damaged.run.ceiling_usd).toBeNull();
      expect(damaged.run.ceiling_basis).toBe("absent");
      expect(damaged.run.ceiling_reason).not.toBeNull();
      expect(damaged.run.ceiling_reason).toContain(BUDGET_FILE);
      // The frozen mirror must never surface as a relabelled live figure.
      expect(damaged.run.ceiling_reason).not.toContain("25");
      // The replay headline falls back to the SAME `$?` it already prints for an
      // unreadable spend — never `$5.01 spent of $25.00 ceiling` (the mirror).
      const narrative = renderReplay(damaged);
      expect(narrative).toContain("$5.01 spent of $? ceiling");
      expect(narrative).not.toContain("$25.00 ceiling");
    } finally {
      views.dispose();
    }
  });

  test("a MISSING budget.yml is not damaged — the mirror is kept, exactly as before #245", () => {
    const views = makeViewsWorkspace();
    try {
      rmSync(join(runDir(views.root, VIEWS_RUN), BUDGET_FILE));
      const undamaged = loadRun(views.root, VIEWS_RUN)!;
      expect(undamaged.run.ceiling_usd).toBe(25);
      expect(undamaged.run.ceiling_basis).toBe("mirror");
      expect(undamaged.run.ceiling_reason).toBeNull();
      const narrative = renderReplay(undamaged);
      expect(narrative).toContain("$5.01 spent of $25.00 ceiling");
    } finally {
      views.dispose();
    }
  });
});

describe("replay narrative", () => {
  test("the header carries run, scope, status and cost against the ceiling", () => {
    expect(narrative).toContain(`# Replay — ${VIEWS_RUN}`);
    expect(narrative).toContain("scope `feature`");
    expect(narrative).toContain("Status: **awaiting_gate**");
    expect(narrative).toContain("$5.01 spent of $25.00 ceiling");
  });

  test("stages appear per phase, in event order, with start and end", () => {
    expect(narrative).toContain("## 01-what — done");
    expect(narrative).toContain("### what — done (product, sonnet)");
    expect(narrative).toContain("## 02-how — awaiting_gate");
    expect(narrative).toContain("### how — awaiting_gate (architect, sonnet)");
    expect(narrative.indexOf("### what")).toBeLessThan(narrative.indexOf("### how"));
    expect(narrative).toContain("2026-09-01T09:02:00Z — started (facilitator)");
    expect(narrative).toContain("2026-09-01T11:40:00Z — ended");
  });

  test("questions show who asked and who answered", () => {
    expect(narrative).toContain("Q1 asked by product: Are rankings per tenant or global?");
    expect(narrative).toContain("Q1 answered by alan: Global, same as Places");
  });

  test("gates show the decision and the note", () => {
    expect(narrative).toContain("gate REJECTED by alan — \"success metrics are not measurable");
    expect(narrative).toContain("gate APPROVED by alan — \"good now\"");
  });

  test("failed checks and budget warnings are not swallowed", () => {
    expect(narrative).toContain("check failed: claim-sources");
    expect(narrative).toContain("budget warning: phase 02-how is at 87%");
  });

  test("each stage reports its cost against its ceiling", () => {
    expect(narrative).toContain("- Cost: $2.40 of $1.00 ceiling");
    expect(narrative).toContain("- Cost: $2.61 of $3.00 ceiling");
  });

  test("it ends with where things stand: cursor, pending gate, open questions", () => {
    const tail = narrative.slice(narrative.indexOf("## Where it stands now"));
    expect(tail).toContain("Cursor: 02-how / how");
    expect(tail).toContain("Pending gate: `how`");
    expect(tail).toContain("Open question: Q2");
    expect(tail).toContain("Open question: Q3");
    expect(tail).not.toContain("Open question: Q1");
  });

  test("it is deterministic", () => {
    expect(renderReplay(loadRun(VIEWS_FIXTURE, VIEWS_RUN)!)).toBe(narrative);
  });
});

describe("tldrx replay", () => {
  test("exits 0 and prints the narrative", async () => {
    const run = await tldrx("replay", VIEWS_RUN, "--root", VIEWS_FIXTURE);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toBe(narrative);
  });

  test("exits 3 when the run does not exist", async () => {
    const run = await tldrx("replay", "260101-nope", "--root", VIEWS_FIXTURE);
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stderr).toContain("not found");
    expect(run.stdout).toBe("");
  });
});

describe("stage.failed rendering (#309)", () => {
  // The ONLY writer of `stage.failed` (`runNext.ts`, the `fail` path) carries the
  // failure as `payload.reason`; the renderer read `payload.error`, which no writer
  // ever set, so every failed stage replayed as the fallback regardless of why it
  // died. The event is fed by hand — the fixture run has no failed stage — and the
  // reason is a token no fixture prose could contain, so the assertion cannot pass
  // on an innocent sentence.
  const REASON = "agent exited 137 after 2 turns [#309-reason-token]";
  const started = loaded.events.find((item) => item.event.type === "stage.started")!;
  const failed = {
    ...loaded,
    events: [
      ...loaded.events,
      {
        line: loaded.events.length + 1,
        event: { ...started.event, ts: "2026-09-01T14:00:00Z", type: "stage.failed", payload: { phase: "02-how", reason: REASON } },
      },
    ],
  } as typeof loaded;

  test("the FAILED line carries the reason the event recorded, never the fallback", () => {
    const rendered = renderReplay(failed);
    const line = rendered.split("\n").find((candidate) => candidate.includes(REASON));
    expect(line).toBe(`- 2026-09-01T14:00:00Z — ${STAGE_FAILED_MARKER}${REASON}`);
    expect(rendered).not.toContain(NO_REASON_RECORDED);
  });

  test("a stage.failed with no reason at all still says so, rather than printing nothing", () => {
    const bare = {
      ...failed,
      events: [...loaded.events, { ...failed.events.at(-1)!, event: { ...failed.events.at(-1)!.event, payload: { phase: "02-how" } } }],
    } as typeof loaded;
    expect(renderReplay(bare)).toContain(`${STAGE_FAILED_MARKER}${NO_REASON_RECORDED}`);
  });
});
