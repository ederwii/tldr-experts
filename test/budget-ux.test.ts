import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { asRunBudget, validateRunBudget, type RunBudget } from "../src/core/budget/RunBudget.ts";
import { buildBudgetView, raiseCommand, renderBudget, shortBy } from "../src/core/budget/budgetView.ts";
import { describeRaise, raiseBudget, BudgetRaiseError } from "../src/core/budget/raiseBudget.ts";
import { renderAttempts, stageAttempts } from "../src/core/run/attempts.ts";
import { asRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { helpFor } from "../src/cli/helpText.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

async function tldrx(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

let workspace: TempRunWorkspace | null = null;
afterEach(() => {
  workspace?.dispose();
  workspace = null;
});

function fresh(): TempRunWorkspace {
  workspace = makeRunWorkspace();
  return workspace;
}

function onlyRunDir(root: string): string {
  const work = join(root, "tldrx-work");
  const entries = readdirSync(work).filter((name) => !name.startsWith("."));
  return join(work, entries[0] as string);
}

function loadBudgetFile(runDir: string): RunBudget {
  const doc = parseYaml(readFileSync(join(runDir, "budget.yml"), "utf8"));
  expect(validateRunBudget(doc).issues).toEqual([]);
  return asRunBudget(doc);
}

function loadRunFile(runDir: string): RunFile {
  return asRunFile(parseYaml(readFileSync(join(runDir, "run.yml"), "utf8")));
}

// --- the model -------------------------------------------------------------

const BUDGET: RunBudget = asRunBudget({
  version: 1, run: "260828-leaderboard", ceiling_usd: 25, per_agent_max_usd: 3,
  warn_at_pct: 80, on_exceed: "block",
  phases: [
    { id: "01-what", ceiling_usd: 4, spent_usd: 1.14 },
    { id: "02-how", ceiling_usd: 7, spent_usd: 6.39 },
    { id: "03-plan", ceiling_usd: 4, spent_usd: 0 },
  ],
});

const RUN: RunFile = asRunFile({
  version: 1, run: "260828-leaderboard", title: "Player leaderboard", scope: "feature",
  workflow: "feature", repos: ["lab"], created_at: null, updated_at: "2026-08-28T14:31:52Z",
  status: "ready", cursor: { phase: "02-how", stage: "contracts", task: null },
  budget: { ceiling_usd: 25, spent_usd: 7.53, per_agent_max_usd: 3 },
  phases: [
    { id: "01-what", status: "done", stages: [stage("what", "done", 2)] },
    { id: "02-how", status: "ready", stages: [stage("contracts", "ready", 3)] },
    { id: "03-plan", status: "pending", stages: [stage("plan", "pending", 4)] },
  ],
});

function stage(id: string, status: string, budget: number): Record<string, unknown> {
  return {
    id, status, expert: null, model: null, budget_usd: budget, cost_usd: 0,
    started_at: null, ended_at: null, inputs: [], outputs: [],
    gate: { type: "approve", status: "pending", by: null, at: null, note: "" }, tasks: [],
  };
}

describe("budget show — the phase table (spec §2.11)", () => {
  test("puts remaining and the next stage's own estimate on one line", () => {
    const view = buildBudgetView(RUN, BUDGET);
    expect(view.phases.map((p) => [p.id, p.remaining_usd, p.next_stage, p.next_estimate_usd, p.blocked])).toEqual([
      ["01-what", 2.86, null, 0, false],   // every stage terminal — nothing left to price
      ["02-how", 0.61, "contracts", 3, true],
      ["03-plan", 4, "plan", 4, false],
    ]);
  });

  test("names the cursor phase and says `next` would be blocked there", () => {
    const view = buildBudgetView(RUN, BUDGET);
    expect(view.blocked?.id).toBe("02-how");
    expect(view.fix_command).toBe("tldrx budget raise 02-how 2.39 --run 260828-leaderboard");
    const text = renderBudget(view);
    expect(text).toContain("BLOCKED");
    expect(text).toContain("tldrx budget raise 02-how 2.39 --run 260828-leaderboard");
    expect(text).toContain("--take-from <phase>");
  });

  test("says so plainly when nothing is blocked", () => {
    const roomy = { ...BUDGET, phases: BUDGET.phases.map((p) => ({ ...p, ceiling_usd: 20 })) };
    const view = buildBudgetView(RUN, roomy);
    expect(view.blocked).toBeNull();
    expect(renderBudget(view)).toContain("affordable in every phase");
  });

  test("a phase with nothing left to run shows no estimate", () => {
    const done = { ...RUN, phases: RUN.phases.map((p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, status: "done" as const })) })) };
    const view = buildBudgetView(done, BUDGET);
    expect(view.phases.every((p) => p.next_stage === null && !p.blocked)).toBe(true);
  });

  test("the shortfall rounds UP to the cent, so one raise is enough", () => {
    // $3.00 estimate against $0.6100000000000003 left: rounding down would leave
    // the stage refused a second time, which is the pilot failure this ends.
    expect(shortBy(3, 0.6100000000000003)).toBe(2.39);
    expect(shortBy(1.005, 0)).toBe(1.01);
    expect(raiseCommand("260828-x", "02-how", 2.39)).toBe("tldrx budget raise 02-how 2.39 --run 260828-x");
  });
});

describe("budget raise — validation before the write (spec §2.11)", () => {
  test("without --take-from the phase ceiling grows; the run ceiling only if it must", () => {
    // 4 + 12 + 4 = 20, still inside the $25 run ceiling, so nothing else moves.
    const outcome = raiseBudget(BUDGET, { phaseId: "02-how", amountUsd: 5 });
    expect(outcome.phaseCeilingBefore).toBe(7);
    expect(outcome.phaseCeilingAfter).toBe(12);
    expect(outcome.runCeilingGrew).toBe(false);
    expect(outcome.runCeilingAfter).toBe(25);
    expect(describeRaise(outcome)).toContain("still covers the phase ceilings");
  });

  test("the run ceiling grows only when Σ phase ceilings would break it", () => {
    const tight = { ...BUDGET, ceiling_usd: 15 };
    const outcome = raiseBudget(tight, { phaseId: "02-how", amountUsd: 5 });
    expect(outcome.runCeilingGrew).toBe(true);
    expect(outcome.runCeilingAfter).toBe(20);
    expect(describeRaise(outcome)).toContain("The run ceiling GREW");
  });

  test("--take-from moves the money and leaves the run ceiling alone", () => {
    const outcome = raiseBudget(BUDGET, { phaseId: "02-how", amountUsd: 3, takeFrom: "03-plan" });
    expect(outcome.runCeilingAfter).toBe(25);
    expect(outcome.runCeilingGrew).toBe(false);
    expect(outcome.budget.phases.map((p) => p.ceiling_usd)).toEqual([4, 10, 1]);
    expect(describeRaise(outcome)).toContain("moved from 03-plan");
  });

  test("Σ phase ceilings ≤ run ceiling holds after every raise", () => {
    for (const request of [
      { phaseId: "01-what", amountUsd: 12 },
      { phaseId: "03-plan", amountUsd: 2, takeFrom: "01-what" },
    ]) {
      const outcome = raiseBudget(BUDGET, request);
      const sum = outcome.budget.phases.reduce((total, p) => total + p.ceiling_usd, 0);
      expect(sum).toBeLessThanOrEqual(outcome.budget.ceiling_usd + 1e-9);
      expect(validateRunBudget(outcome.budget).issues).toEqual([]);
    }
  });

  test("a donor may not be cut below what it has already spent", () => {
    expect(() => raiseBudget(BUDGET, { phaseId: "03-plan", amountUsd: 1, takeFrom: "02-how" }))
      .toThrow(BudgetRaiseError);
    expect(() => raiseBudget(BUDGET, { phaseId: "03-plan", amountUsd: 1, takeFrom: "02-how" }))
      .toThrow(/only \$0\.61 unspent/);
  });

  test("an unknown phase, a zero amount and a self-move are all refused", () => {
    expect(() => raiseBudget(BUDGET, { phaseId: "09-nope", amountUsd: 1 })).toThrow(/no phase `09-nope`/);
    expect(() => raiseBudget(BUDGET, { phaseId: "02-how", amountUsd: 0 })).toThrow(/at least \$0\.01/);
    expect(() => raiseBudget(BUDGET, { phaseId: "02-how", amountUsd: 1, takeFrom: "02-how" }))
      .toThrow(/moves nothing/);
  });
});

describe("per-attempt cost (spec §2.9)", () => {
  test("one `agent.result` is one attempt, in ledger order", () => {
    const ws = fresh();
    const runDir = join(ws.root, "tldrx-work", "260828-x");
    const line = (cost: number): string => JSON.stringify({
      ts: "2026-08-28T09:00:00Z", run: "260828-x", stage: "what", type: "agent.result",
      actor: "product", cost_usd: cost, payload: { phase: "01-what", task: "t1" },
    });
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "events.jsonl"), `${line(1.39)}\n${line(1.21)}\nnot json\n`, "utf8");

    const attempts = stageAttempts(runDir, "01-what", "what");
    expect(attempts.costs).toEqual([1.39, 1.21]);
    expect(attempts.total_usd).toBe(2.6);
    expect(renderAttempts(attempts)).toBe("attempts: 2 · $1.39 + $1.21");
  });

  test("a stage that has not run yet renders nothing", () => {
    const ws = fresh();
    expect(renderAttempts(stageAttempts(ws.root, "01-what", "what"))).toBeNull();
  });
});

describe("the CLI", () => {
  test("`budget show` renders the table for the newest run", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--budget", "10");
    const shown = await tldrx(ws.root, "budget", "show");
    expect(shown.stderr).toBe("");
    expect(shown.code).toBe(EXIT_OK);
    expect(shown.stdout).toContain("01-what");
    expect(shown.stdout).toContain("next stage");
    expect(shown.stdout).toContain("affordable in every phase");
  });

  test("`budget show --json` is the same view as data", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--budget", "10");
    const shown = await tldrx(ws.root, "budget", "show", "--json");
    const view = JSON.parse(shown.stdout) as { phases: { id: string }[]; blocked: unknown };
    expect(view.phases.map((p) => p.id)).toEqual(["01-what", "02-how", "03-plan", "04-build", "05-watch"]);
    expect(view.blocked).toBeNull();
  });

  test("`budget raise` edits budget.yml and mirrors the ceiling into run.yml", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--budget", "10");
    const runDir = onlyRunDir(ws.root);
    const before = loadBudgetFile(runDir);

    const raised = await tldrx(ws.root, "budget", "raise", "01-what", "2.00");
    expect(raised.stderr).toBe("");
    expect(raised.code).toBe(EXIT_OK);

    const after = loadBudgetFile(runDir);
    const phase = (b: RunBudget): number => b.phases.find((p) => p.id === "01-what")?.ceiling_usd ?? 0;
    expect(phase(after)).toBeCloseTo(phase(before) + 2, 2);
    expect(loadRunFile(runDir).budget.ceiling_usd).toBe(after.ceiling_usd);
    expect(validateRunBudget(parseYaml(readFileSync(join(runDir, "budget.yml"), "utf8"))).issues).toEqual([]);
  });

  test("`budget raise --take-from` keeps the run ceiling", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--budget", "10");
    const runDir = onlyRunDir(ws.root);
    const before = loadBudgetFile(runDir).ceiling_usd;

    const raised = await tldrx(ws.root, "budget", "raise", "01-what", "0.50", "--take-from", "05-watch");
    expect(raised.code).toBe(EXIT_OK);
    expect(raised.stdout).toContain("moved from 05-watch");
    expect(loadBudgetFile(runDir).ceiling_usd).toBe(before);
  });

  test("a bad amount is a usage error, and nothing is written", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--budget", "10");
    const runDir = onlyRunDir(ws.root);
    const before = readFileSync(join(runDir, "budget.yml"), "utf8");

    const bad = await tldrx(ws.root, "budget", "raise", "01-what", "banana");
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.stdout).toBe("");
    expect(readFileSync(join(runDir, "budget.yml"), "utf8")).toBe(before);
  });

  test("with no run at all, both subcommands exit 3", async () => {
    const ws = fresh();
    expect((await tldrx(ws.root, "budget", "show")).code).toBe(EXIT_NOT_FOUND);
    expect((await tldrx(ws.root, "budget", "raise", "01-what", "1")).code).toBe(EXIT_NOT_FOUND);
  });

  test("`run status` shows per-attempt cost for the cursor stage", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--budget", "10");
    const runDir = onlyRunDir(ws.root);
    const runId = loadRunFile(runDir).run;
    const line = (cost: number): string => JSON.stringify({
      ts: "2026-08-29T09:00:00Z", run: runId, stage: "what", type: "agent.result",
      actor: "product", cost_usd: cost, payload: { phase: "01-what", task: "t1" },
    });
    appendFileSync(join(runDir, "events.jsonl"), `${line(1.39)}\n${line(1.21)}\n`, "utf8");

    const status = await tldrx(ws.root, "run", "status");
    expect(status.code).toBe(EXIT_OK);
    expect(status.stdout).toContain("attempts: 2 · $1.39 + $1.21");
  });
});

/**
 * gh #32 — the help said `<usd>` was "the new ceiling"; `raiseBudget` adds it to
 * the one already there (`raiseBudget.ts:83`, `ceiling_usd + amount`). An operator
 * reading the help and typing the number they wanted as a ceiling over-raised:
 * measured live on the scavtopia leaderboard run, a "$5.40 new ceiling" command
 * would have set $8.00. The arithmetic is what live runs depend on, so the WORDS
 * move, not the code.
 */
describe("budget raise: <usd> is a delta, and the help says so (#32)", () => {
  test("the <usd> arg is not described as the new ceiling", () => {
    const usd = helpFor("budget")?.args.find((arg) => arg.name === "<usd>");
    expect(usd).toBeDefined();
    expect(usd?.meaning).not.toContain("the new ceiling");
  });

  test("the <usd> arg names the addition, and says what it is NOT", () => {
    const meaning = helpFor("budget")?.args.find((arg) => arg.name === "<usd>")?.meaning ?? "";
    expect(meaning.toLowerCase()).toContain("add");
    expect(meaning.toLowerCase()).toContain("not a new ceiling");
  });

  test("the words match the arithmetic: the issue's own 2.60 + 5.40 = 8.00", () => {
    const before = { ...BUDGET, phases: BUDGET.phases.map((p) => ({ ...p, ceiling_usd: 2.6, spent_usd: 0 })) };
    const outcome = raiseBudget(before, { phaseId: "02-how", amountUsd: 5.4 });
    expect(outcome.phaseCeilingBefore).toBe(2.6);
    expect(outcome.phaseCeilingAfter).toBe(8);
  });
});
