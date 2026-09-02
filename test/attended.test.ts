/**
 * `attended_by: host` — the run mode that never spawns (spec §2.2, §3, §5).
 *
 * The finding it is built for is one sentence of field notes from 2026-08-30:
 * a bare `tldrx next` on a Build stage runs the WHOLE headless pipeline — every
 * remaining wave, every story, as paid spawns — when the host wanted one turn.
 * Six of six of those spawns then died on `Reached maximum budget` at caps a
 * Plan agent had written assuming host-billed sub-agents. $9.95, for nothing.
 *
 * So the properties worth a test each are:
 *
 *   - the key parses, round-trips, and a value nobody understands is refused;
 *   - a bare `tldrx next` on such a run REFUSES and names the exact command;
 *   - `run auto` refuses at the CLI and writes nothing;
 *   - every executor exposes prepare/commit only;
 *   - no run path can reach `spawnAgent`, enforced at the spawn itself;
 *   - the in-session cycle still works end to end;
 *   - and a run WITHOUT the key is byte-identical to `main` on its events.
 *
 * That last one is the chunk's real gate. The sequence below was captured from
 * `main` at `dae1d07` by running this exact fixture through `runNext` twice; if
 * this work ever changes the ordinary path, that is the line that says so.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { runAuto } from "../src/core/facilitator/runAuto.ts";
import { spawnAgent } from "../src/core/facilitator/spawnAgent.ts";
import { AttendedSpawnError, attendedRun, withAttendedGuard } from "../src/core/facilitator/attended.ts";
import { buildExecutor } from "../src/core/facilitator/executors/build.ts";
import { watchExecutor } from "../src/core/facilitator/executors/watch.ts";
import type { ExecutorContext } from "../src/core/facilitator/executors/index.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { attendRun } from "../src/core/run/attend.ts";
import { cancelRun } from "../src/core/run/rescue.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { validateRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { renderRunLine } from "../src/core/statusline/renderRunLine.ts";
import type { RunSnapshot } from "../src/core/statusline/runSnapshot.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_SESSION",
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
] as const;

let open: { readonly dispose: () => void }[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const TWO_STAGE: readonly StageOptions[] = [
  {
    id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
    outputs: [
      { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
      { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    ],
  },
  { id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto", outputs: [{ path: "02-how/handoff.md" }] },
];

/** Both stages' outputs, so a two-stage run walks to `done` without failing. */
const BOTH_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
  "02-how/handoff.md": cannedHandoff(),
});

function workspace(stages: readonly StageOptions[] = TWO_STAGE): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10 });
  open.push(made);
  return made;
}

/** The fake `claude`, first and ONLY on PATH, writing both stages' outputs. */
function fakeClaude(ws: FacilitatorWorkspace): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = BOTH_OUTPUTS;
  process.env.FAKE_CLAUDE_COST = "0.42";
  process.env.FAKE_CLAUDE_SESSION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
}

function next(
  ws: { readonly root: string },
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-28T09:00:00Z",
    ...overrides,
  });
}

function events(runDir: string): readonly TldrxEvent[] {
  return EventLog.forRun(runDir).read();
}

function types(runDir: string): readonly string[] {
  return events(runDir).map((e) => `${e.type}${e.actor === "facilitator" ? "" : `@${e.actor ?? ""}`}`);
}

function spawns(runDir: string): number {
  return events(runDir).filter((e) => e.type === "agent.spawned").length;
}

/** Hand the run over the way `tldrx run attend host` does. */
function attend(runDir: string, root: string): void {
  const outcome = attendRun({ root, attendedBy: "host", actor: "alan", at: "2026-08-28T09:00:00Z" });
  if (outcome.code !== 0) throw new Error(`attend failed: ${outcome.lines.join(" ")}`);
  if (!readFileSync(join(runDir, "run.yml"), "utf8").includes("attended_by: host")) {
    throw new Error("attend did not write the key");
  }
}

async function tldrxIn(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv() });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

// ---------------------------------------------------------------------------

describe("the run.yml key", () => {
  const MINIMAL: Record<string, unknown> = {
    version: 1,
    run: "260828-demo",
    title: "Demo",
    scope: "feature",
    workflow: "feature",
    repos: ["api"],
    created_at: "2026-08-28T09:00:00Z",
    updated_at: "2026-08-28T09:00:00Z",
    status: "ready",
    cursor: { phase: "01-what", stage: "alpha", task: null },
    budget: { ceiling_usd: 10, spent_usd: 0, per_agent_max_usd: 3 },
    phases: [{
      id: "01-what",
      status: "ready",
      stages: [{
        id: "alpha", status: "ready", expert: null, model: null, budget_usd: 10, cost_usd: 0,
        started_at: null, ended_at: null, inputs: [], outputs: [],
        gate: { type: "approve", status: "pending", by: null, at: null, note: "" },
        tasks: [],
      }],
    }],
  };

  test("`attended_by: host` validates", () => {
    expect(validateRunFile({ ...MINIMAL, attended_by: "host" }).ok).toBe(true);
  });

  test("absence is legal and is what every run written before this had", () => {
    expect(validateRunFile(MINIMAL).ok).toBe(true);
  });

  /**
   * The one refusal that matters for the operator's safety: a value this binary
   * does not understand must NOT be read as "no value", because "no value" means
   * the framework may spend money.
   */
  test("a value nobody understands is refused, naming the one that exists", () => {
    const result = validateRunFile({ ...MINIMAL, attended_by: "nobody" });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === "attended_by");
    expect(issue?.message).toContain("host");
  });

  test("the emitter writes it only when it is set", () => {
    const run = MINIMAL as unknown as RunFile;
    expect(emitRunYaml(run)).not.toContain("attended_by");
    expect(emitRunYaml({ ...run, attended_by: "host" })).toContain("attended_by: host");
  });

  test("it round-trips through a save", () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);
    const store = RunStore.open(ws.runDir);
    expect(store.run.attended_by).toBe("host");
    store.save();
    expect(RunStore.open(ws.runDir).run.attended_by).toBe("host");
  });
});

describe("run new --attended-by host", () => {
  test("freezes the key into run.yml and says so in run.created", () => {
    const ws = makeFacilitatorWorkspace({ scope: "demo", stages: TWO_STAGE, budgetUsd: 10, slug: "unused" });
    open.push(ws);
    const outcome = createRun({
      root: ws.root, slug: "attended", scope: "demo", budgetUsd: 10,
      attendedBy: "host", actor: "alan", now: new Date("2026-08-28T09:00:00Z"),
    });
    expect(readFileSync(join(outcome.runDir, "run.yml"), "utf8")).toContain("attended_by: host");
    const created = events(outcome.runDir).find((e) => e.type === "run.created");
    expect(created?.payload).toMatchObject({ attended_by: "host" });
  });

  test("an ordinary run carries neither the key nor the payload field", () => {
    const ws = workspace();
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).not.toContain("attended_by");
    const created = events(ws.runDir).find((e) => e.type === "run.created");
    expect(Object.keys(created?.payload ?? {})).not.toContain("attended_by");
  });

  test("`--attended-by nope` is a usage error and no run is created", async () => {
    const ws = workspace();
    const run = await tldrxIn(ws.root, "run", "new", "nope-run", "--scope", "demo", "--attended-by", "nope");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--attended-by must be one of host");
  });
});

describe("tldrx next refuses to spawn", () => {
  test("a bare `next` exits 4, names the --prepare command, and spawns nothing", async () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);
    fakeClaude(ws);

    const before = events(ws.runDir).length;
    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    const text = outcome.lines.join("\n");
    expect(text).toContain("is attended_by: host — the framework does not spawn on this run.");
    expect(text).toContain(`01-what/alpha is waiting on a host turn: tldrx next --prepare ${ws.runId}`);
    expect(text).toContain(`tldrx run attend --none ${ws.runId}`);
    // Nothing spawned, and nothing was even written: no stage.started, no task.
    expect(spawns(ws.runDir)).toBe(0);
    expect(events(ws.runDir).length).toBe(before);
    // Still `pending` — the status a stage has before anything runs it. The
    // refusal is ahead of `markRunning`, so there is nothing to demote later.
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("pending");
  });

  /**
   * `--dry-run` is `mode: "headless"`, so it is refused with everything else —
   * but the REASON changed with issue #17. It used to spawn a real sub-agent and
   * bill for it, reverting only the files afterwards; it spawns nothing now. It
   * is refused because it describes a dispatch the framework will never make on
   * an attended run, and the message points at the half that IS useful here.
   */
  test("`--dry-run` is refused too, and no longer claims it spawns for real", async () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);
    fakeClaude(ws);
    const outcome = await next(ws, { dryRun: true });
    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("--dry-run is headless too");
    expect(said).toContain("it spawns nothing");
    expect(said).not.toContain("spawns a real sub-agent");
    expect(said).toContain("--prepare");
    expect(spawns(ws.runDir)).toBe(0);
  });

  test("the refusal names --commit once a bundle is out", async () => {
    const ws = buildWorkspace();
    attend(ws.runDir, ws.root);
    const prepared = await next(ws, { mode: "prepare" });
    expect(prepared.code).toBe(0);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("running");

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain(`has a bundle out and is waiting for its result: tldrx next --commit ${ws.runId}`);
    expect(spawns(ws.runDir)).toBe(0);
  }, 60_000);

  test("the whole in-session cycle still works on an attended run", async () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);

    const prepared = await next(ws, { mode: "prepare" });
    expect(prepared.code).toBe(0);
    expect(prepared.lines.join("\n")).toContain("prepared 01-what/alpha");

    // The host does the turn: write the declared outputs and the envelope.
    const agentDir = join(ws.runDir, ".agent", "alpha");
    writeAgentResult(ws.runDir, agentDir, ["01-what/intent.md", "01-what/handoff.md"]);

    const committed = await next(ws, { mode: "commit" });
    expect(committed.code).toBe(0);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("done");
    // The whole point: a finished stage, and nothing was ever spawned.
    expect(spawns(ws.runDir)).toBe(0);
  });
});

describe("every executor exposes prepare/commit only", () => {
  test("the Build executor refuses a headless context without spawning", async () => {
    const ws = buildWorkspace();
    const outcome = await buildExecutor(executorContext(ws, "04-build", "build"));
    expect(outcome.refused).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.costUsd).toBe(0);
    expect(outcome.tasks).toHaveLength(0);
    expect(outcome.lines.join("\n")).toContain("does not run headless");
    expect(spawns(ws.runDir)).toBe(0);
  });

  test("the Watch executor refuses a headless context without spawning", async () => {
    const ws = buildWorkspace();
    const outcome = await watchExecutor({
      ...executorContext(ws, "04-build", "build"),
      phaseId: "05-watch",
      stageId: "watch",
    });
    expect(outcome.refused).toBe(true);
    expect(outcome.lines.join("\n")).toContain("does not run headless");
    expect(spawns(ws.runDir)).toBe(0);
  });

  test("an unattended context is untouched — the refusal is not the default", async () => {
    const ws = buildWorkspace();
    const ctx = { ...executorContext(ws, "04-build", "build"), attendedByHost: false, mode: "prepare" as const };
    const outcome = await buildExecutor(ctx);
    expect(outcome.refused).toBeUndefined();
  }, 60_000);
});

describe("the guard at the spawn itself", () => {
  /**
   * The refusals above are doors; this is the wall behind them. It exists because
   * "no run path reaches `spawnAgent`" is a claim about three call sites and a
   * fourth is one merge away.
   */
  test("spawnAgent throws while a host-driven run is in flight", async () => {
    await expect(withAttendedGuard("260828-demo", () => spawnAgent({
      prompt: "never sent",
      model: null,
      maxBudgetUsd: 1,
      workspaceCommands: [],
      yolo: false,
      cwd: FRAMEWORK_ROOT,
      timeoutMs: 1000,
    }))).rejects.toBeInstanceOf(AttendedSpawnError);
  });

  test("the guard is disarmed again however the call leaves", async () => {
    expect(attendedRun()).toBeNull();
    await withAttendedGuard("260828-demo", async () => {
      expect(attendedRun()).toBe("260828-demo");
      throw new Error("boom");
    }).catch(() => undefined);
    expect(attendedRun()).toBeNull();
  });

  test("it is not armed on an ordinary run", async () => {
    const ws = workspace();
    fakeClaude(ws);
    await next(ws);
    expect(attendedRun()).toBeNull();
    expect(spawns(ws.runDir)).toBe(1);
  });
});

describe("run auto", () => {
  test("refuses an attended run at exit 1 and writes nothing", async () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);
    fakeClaude(ws);
    const before = events(ws.runDir).length;

    const outcome = await runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-08-28T09:00:00Z" });

    expect(outcome.code).toBe(1);
    const text = outcome.lines.join("\n");
    expect(text).toContain("`run auto` is a loop over spawns and this run does not spawn");
    expect(text).toContain(`tldrx next --prepare ${ws.runId}`);
    expect(events(ws.runDir).length).toBe(before);
    expect(spawns(ws.runDir)).toBe(0);
  });
});

describe("tldrx run attend", () => {
  test("host: sets the key and appends exactly one run.attended", () => {
    const ws = workspace();
    const outcome = attendRun({ root: ws.root, attendedBy: "host", actor: "alan", at: "2026-08-28T10:00:00Z" });
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("the framework will not spawn on it");
    const attended = events(ws.runDir).filter((e) => e.type === "run.attended");
    expect(attended).toHaveLength(1);
    expect(attended[0]?.payload).toMatchObject({ attended_by: "host", was: null });
    expect(attended[0]?.cost_usd).toBe(0);
  });

  test("--none removes the key from run.yml rather than blanking it", () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);
    const outcome = attendRun({ root: ws.root, attendedBy: null, actor: "alan", at: "2026-08-28T11:00:00Z" });
    expect(outcome.code).toBe(0);
    // Not `attended_by: null` — that is not a legal §2.2 value.
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).not.toContain("attended_by");
    expect(RunStore.open(ws.runDir).run.attended_by).toBeUndefined();
    const last = events(ws.runDir).filter((e) => e.type === "run.attended").at(-1);
    expect(last?.payload).toMatchObject({ attended_by: null, was: "host" });
  });

  test("the run runs again once it is handed back", async () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);
    attendRun({ root: ws.root, attendedBy: null, actor: "alan", at: "2026-08-28T11:00:00Z" });
    fakeClaude(ws);
    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(spawns(ws.runDir)).toBe(1);
  });

  /** A no-op writes no event: a decision nobody made does not belong in the log. */
  test("setting it twice is a silent no-op", () => {
    const ws = workspace();
    attend(ws.runDir, ws.root);
    const again = attendRun({ root: ws.root, attendedBy: "host", actor: "alan", at: "2026-08-28T12:00:00Z" });
    expect(again.code).toBe(0);
    expect(again.lines.join("\n")).toContain("already attended_by: host");
    expect(events(ws.runDir).filter((e) => e.type === "run.attended")).toHaveLength(1);
  });

  // By id, because a cancelled run is no longer the "one open run" and an id-less
  // call would never reach the refusal at all — it would be exit 3.
  test("a finished run is refused — there is nothing left to attend", () => {
    const ws = workspace();
    cancelRun({ root: ws.root, note: "done with it", force: false, actor: "alan", at: "2026-08-28T12:00:00Z" });
    const outcome = attendRun({
      root: ws.root, runId: ws.runId, attendedBy: "host", actor: "alan", at: "2026-08-28T13:00:00Z",
    });
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("there is nothing left to attend");
  });

  test("an unknown run id is exit 3", () => {
    const ws = workspace();
    const outcome = attendRun({
      root: ws.root, runId: "260101-nope", attendedBy: "host", actor: "alan", at: "2026-08-28T13:00:00Z",
    });
    expect(outcome.code).toBe(3);
  });

  test("the CLI needs a direction and will not guess one", async () => {
    const ws = workspace();
    const run = await tldrxIn(ws.root, "run", "attend");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("run attend needs a direction");
  });

  test("`host` and `--none` together is a usage error", async () => {
    const ws = workspace();
    const run = await tldrxIn(ws.root, "run", "attend", "host", "--none");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("opposite directions");
  });

  test("the CLI flips it end to end", async () => {
    const ws = workspace();
    const on = await tldrxIn(ws.root, "run", "attend", "host", ws.runId);
    expect(on.code).toBe(0);
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toContain("attended_by: host");
    const off = await tldrxIn(ws.root, "run", "attend", "--none", ws.runId);
    expect(off.code).toBe(0);
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).not.toContain("attended_by");
  });
});

describe("the screens say so", () => {
  test("run status prints `attended: host`, and nothing at all when it is absent", () => {
    const ws = workspace();
    const before = RunStore.open(ws.runDir);
    expect(renderStatus(buildStatus(before.run, before.budget, ws.runDir))).not.toContain("attended");

    attend(ws.runDir, ws.root);
    const after = RunStore.open(ws.runDir);
    const view = buildStatus(after.run, after.budget, ws.runDir);
    expect(view.attended_by).toBe("host");
    expect(renderStatus(view)).toContain("attended: host");
  });

  test("the status line gains ` att`, and is byte-identical without it", () => {
    const snapshot: RunSnapshot = {
      runDir: "/tmp/x", run: "260828-leaderboard", title: "", scope: "feature", status: "ready",
      phase: "02-how", stage: "contracts", stageStatus: "ready", expert: "architect",
      done: 2, total: 5, ceilingUsd: 25, spentUsd: 3.75, openCount: 1, machineGates: 0, staleStages: 0,
      attendedByHost: false, source: "run-store",
    };
    const host = { modelName: "Sonnet", usedPercentage: 16, totalCostUsd: 3.75 };
    expect(renderRunLine(host, snapshot))
      .toBe("[tldrx] 260828-leaderboard · 02-HOW [▓▓░░░] 2/5 > contracts — architect | Sonnet ctx:16% $3.75/$25");
    expect(renderRunLine(host, { ...snapshot, attendedByHost: true }))
      .toBe("[tldrx] 260828-leaderboard · 02-HOW [▓▓░░░] 2/5 att > contracts — architect | Sonnet ctx:16% $3.75/$25");
  });

  test("`att` leads the markers when a gate was also machine-signed", () => {
    const snapshot: RunSnapshot = {
      runDir: "/tmp/x", run: "260828-x", title: "", scope: "docs", status: "ready",
      phase: "01-what", stage: "alpha", stageStatus: "ready", expert: null,
      done: 0, total: 2, ceilingUsd: 10, spentUsd: 0, openCount: 1, machineGates: 2, staleStages: 1,
      attendedByHost: true, source: "run-store",
    };
    expect(renderRunLine({ modelName: "Opus", usedPercentage: 4, totalCostUsd: 0 }, snapshot))
      .toContain("0/2 att machine:2 stale:1 > alpha");
  });
});

describe("a run without the key is what shipped", () => {
  /**
   * Captured from `main` at `dae1d07` by running this exact fixture through
   * `runNext` twice and mapping every event to `type@actor`. This is the chunk's
   * gate: `attended_by` is additive, and additive means the ordinary path did not
   * move an inch.
   */
  const MAIN_SEQUENCE = [
    "run.created@alan",
    "stage.started", "agent.spawned@product", "agent.result@product", "stage.done",
    "stage.started", "agent.spawned@product", "agent.result@product", "stage.done",
    "run.closed",
  ];

  test("emits main's event sequence, event for event", async () => {
    const ws = workspace();
    fakeClaude(ws);
    const first = await next(ws);
    const second = await next(ws);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(types(ws.runDir)).toEqual(MAIN_SEQUENCE);
  }, 60_000);

  test("and its run.yml never mentions the key", async () => {
    const ws = workspace();
    fakeClaude(ws);
    await next(ws);
    await next(ws);
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).not.toContain("attended_by");
  }, 60_000);
});

// --- fixture helpers ---------------------------------------------------------

/** A one-story Build run, for the executor and bundle tests. */
function buildWorkspace(): BuildWorkspace {
  const made = makeBuildWorkspace({
    stories: [{ id: "S1", epic: "E1", title: "First" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
  });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

/**
 * An `ExecutorContext` with `attendedByHost: true` and `mode: "headless"` — the
 * combination `runNext` refuses before an executor is reached, which is exactly
 * why the executors have to be asked directly.
 */
function executorContext(ws: BuildWorkspace, phaseId: string, stageId: string): ExecutorContext {
  const store = RunStore.open(ws.runDir);
  return {
    root: ws.root,
    runId: store.runId,
    runDir: ws.runDir,
    phaseId,
    stageId,
    spec: loadStageSpec(ws.root, store.run.scope, stageId),
    repos: store.run.repos,
    mode: "headless",
    model: null,
    effort: null,
    // Nothing declared on the command line — these tests drive the executor directly.
    costUsd: null,
    tokens: null,
    budgetUsd: 8,
    maxBudgetUsd: 2,
    yolo: false,
    at: "2026-08-28T09:00:00Z",
    keepWorktrees: false,
    reuseEpic: false,
    parallel: 1,
    discardPending: false,
    review: false,
    attendedByHost: true,
    agentCap: () => 2,
    emit: () => undefined,
  };
}

/** What a host session leaves behind after doing a `--prepare` turn by hand. */
function writeAgentResult(runDir: string, agentDir: string, outputs: readonly string[]): void {
  const files: Record<string, string> = {
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": cannedHandoff(),
    "02-how/handoff.md": cannedHandoff(),
  };
  for (const rel of outputs) writeFileSync(join(runDir, rel), files[rel] ?? "# stub\n", "utf8");
  writeFileSync(
    join(agentDir, "result.json"),
    JSON.stringify({ outputs, questions_asked: [], notes: "written by the host session", cost_usd: 0.19 }),
    "utf8",
  );
}
