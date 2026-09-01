/**
 * The statusline and SessionStart hooks, wired to run data (spec §4).
 *
 * Two halves have to meet: the payload Claude Code pipes in (model, context,
 * session cost) and the run on disk (id, cursor, progress, ceiling). These tests
 * check the join, the exact §4 rendering, and — the part that actually matters
 * for a hook — that neither half can take the status line down.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { renderRunLine, money, hostFrom, locateFrom } from "../src/core/statusline/renderRunLine.ts";
import { runSnapshot } from "../src/core/statusline/runSnapshot.ts";
import { NO_SESSION_DATA } from "../src/core/statusline/renderStatusLine.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { makeWorkspace, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

/** The documented statusLine payload (code.claude.com/docs/en/statusline). */
function payload(root: string): Record<string, unknown> {
  return {
    cwd: root,
    session_id: "abc123",
    model: { id: "claude-opus-5", display_name: "Opus" },
    workspace: { current_dir: root, project_dir: root },
    version: "2.1.90",
    cost: { total_cost_usd: 0.01234 },
    context_window: { used_percentage: 8, context_window_size: 200000 },
  };
}

const STAGES = [
  { id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto" as const, outputs: [{ path: "01-what/handoff.md" }] },
  { id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto" as const, outputs: [{ path: "02-how/handoff.md" }] },
];

let open: (FacilitatorWorkspace | TempWorkspace)[] = [];
afterEach(() => {
  for (const workspace of open) workspace.dispose();
  open = [];
});

function withRun(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: STAGES, budgetUsd: 10 });
  open.push(made);
  return made;
}

async function statusline(input: unknown): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "statusline.ts")], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout: stdout.trim() };
}

describe("renderRunLine", () => {
  test("renders the spec §4 line", () => {
    expect(
      renderRunLine(
        { modelName: "Sonnet", usedPercentage: 16, totalCostUsd: 3.75 },
        {
          runDir: "/tmp/x", run: "260828-leaderboard", title: "", scope: "feature", status: "awaiting_gate",
          phase: "02-how", stage: "contracts", stageStatus: "awaiting_gate", expert: "architect",
          done: 2, total: 5, ceilingUsd: 25, spentUsd: 3.75, openCount: 1, autoGates: 0, staleStages: 0, attendedByHost: false, source: "run-store",
        },
      ),
    ).toBe("[tldrx] 260828-leaderboard · 02-HOW [▓▓░░░] 2/5 > contracts — architect | Sonnet ctx:16% $3.75/$25");
  });

  test("drops the expert segment when the stage has none", () => {
    const line = renderRunLine(
      { modelName: "Opus", usedPercentage: 3.9, totalCostUsd: 0 },
      {
        runDir: "/tmp/x", run: "260828-x", title: "", scope: "docs", status: "ready",
        phase: "01-what", stage: "alpha", stageStatus: "ready", expert: null,
        done: 0, total: 2, ceilingUsd: 10, spentUsd: 0, openCount: 1, autoGates: 0, staleStages: 0, attendedByHost: false, source: "run-store",
      },
    );
    expect(line).toBe("[tldrx] 260828-x · 01-WHAT [░░░░░] 0/2 > alpha | Opus ctx:3% $0/$10");
  });

  test("money keeps cents when there are cents and drops them when there are not", () => {
    expect(money(25)).toBe("$25");
    expect(money(3.75)).toBe("$3.75");
    expect(money(0.01234)).toBe("$0.01");
  });

  test("hostFrom refuses a payload that is missing any half of what it renders", () => {
    expect(hostFrom(payload("/tmp"))).toEqual({ modelName: "Opus", usedPercentage: 8, totalCostUsd: 0.01234 });
    expect(hostFrom({ ...payload("/tmp"), context_window: { used_percentage: null } })).toBeNull();
    expect(hostFrom(null)).toBeNull();
  });

  test("locateFrom prefers project_dir over a wandered cwd", () => {
    expect(locateFrom({ cwd: "/a/b/c", workspace: { project_dir: "/a" } })).toBe("/a");
    expect(locateFrom({ cwd: "/a/b/c" })).toBe("/a/b/c");
    expect(locateFrom({})).toBeNull();
  });
});

describe("runSnapshot", () => {
  test("reads a valid run through RunStore", () => {
    const ws = withRun();
    const snapshot = runSnapshot(ws.root);
    expect(snapshot?.source).toBe("run-store");
    expect(snapshot?.run).toBe(ws.runId);
    expect(snapshot).toMatchObject({ phase: "01-what", stage: "alpha", expert: "product", done: 0, total: 2, ceilingUsd: 10 });
  });

  test("degrades to the tolerant reader rather than blanking on a run that fails §2.2 validation", () => {
    const ws = makeWorkspace();
    open.push(ws);
    const snapshot = runSnapshot(ws.root);
    // the shipped hooks fixture states spent_usd 3.75 with no tasks to back it
    expect(snapshot?.source).toBe("tolerant");
    expect(snapshot).toMatchObject({ run: "260828-leaderboard", phase: "02-how", stage: "contracts", ceilingUsd: 25 });
  });

  /**
   * The tolerant reader used to hard-code `attendedByHost: false` and say so:
   * "false here means cannot see, never a claim that the run is unattended". The
   * operator most in need of that flag is the one about to type `tldrx next` and
   * wonder why nothing happened — and a run.yml that fails §2.2 validation is
   * exactly when they are looking at the status line (issue #22).
   */
  test("the tolerant reader now sees `attended_by: host` instead of hard-coding false", () => {
    const ws = makeWorkspace();
    open.push(ws);
    const path = join(ws.runDir, "run.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^status: /m, "attended_by: host\nstatus: "), "utf8");
    const snapshot = runSnapshot(ws.root);
    expect(snapshot?.source).toBe("tolerant");
    expect(snapshot?.attendedByHost).toBe(true);
  });

  test("is nowhere near the 50 ms hook budget", () => {
    const ws = withRun();
    runSnapshot(ws.root); // warm the module graph, not a cache — there isn't one
    const started = performance.now();
    const snapshot = runSnapshot(ws.root);
    if (snapshot !== null) renderRunLine({ modelName: "Opus", usedPercentage: 8, totalCostUsd: 0 }, snapshot);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("returns null when there is no run at all", () => {
    const ws = withRun();
    rmSync(join(ws.root, "tldrx-work"), { recursive: true, force: true });
    expect(runSnapshot(ws.root)).toBeNull();
  });
});

describe("the statusline hook", () => {
  test("renders the full line when a run is live", async () => {
    const ws = withRun();
    const run = await statusline(payload(ws.root));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`[tldrx] ${ws.runId} · 01-WHAT [░░░░░] 0/2 > alpha — product | Opus ctx:8% $0.01/$10`);
  });

  test("keeps the short host-only line when there is no run", async () => {
    const ws = withRun();
    rmSync(join(ws.root, "tldrx-work"), { recursive: true, force: true });
    const run = await statusline(payload(ws.root));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("[tldrx] Opus ctx:8% $0.01");
  });

  test("keeps the short line outside a tldrx workspace", async () => {
    const run = await statusline(payload("/"));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("[tldrx] Opus ctx:8% $0.01");
  });

  test("never breaks the session on garbage", async () => {
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "statusline.ts")], {
      stdin: new TextEncoder().encode("{not json"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.trim()).toBe(NO_SESSION_DATA);
  });
});

describe("the session-start hook", () => {
  test("reports the same run the status line does", async () => {
    const ws = withRun();
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "session-start.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: ws.root })),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const context = (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? "";
    const lines = context.split("\n");
    // Three "where we are" lines, then up to three of the pending report (§4).
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toBe(`tldrx: run ${ws.runId} — "Demo" (demo) · pending`);
    expect(lines[1]).toBe("tldrx: at 01-what / alpha — product · pending");
    // The run block stays the PREFIX; the pending block only ever follows it.
    expect(lines.filter((line) => line.startsWith("tldrx: 1 pending —")).length).toBe(1);
  });
});
