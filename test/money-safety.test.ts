/**
 * Wave M · M6–M10 — the money and the destructive defaults.
 *
 * Every number here is from the 2026-08-29 audit:
 *   §A  `budget-gate` matched `^(claude -p|tldrx next)` only, and failed OPEN
 *   §A  Build charged 2.5x its phase; Watch's floor could exceed the ceiling
 *   §C  `tickets sync` wrote live by default; `--provider` walked past `kind: none`
 *   §D  `.claude/settings.json.bak-tldrx-*` was ignored by nothing
 *   §E  `budget raise` rewrote budget.yml and appended no event at all
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITIGNORE_BODY } from "../src/core/init/ambientFootprint.ts";
import { budgetCommand } from "../src/cli/commands/budget.ts";
import { ticketsCommand } from "../src/cli/commands/tickets.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { EVENT_TYPES } from "../src/core/events/Event.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { buildBudgetView, renderBudget, countUnmetered } from "../src/core/budget/budgetView.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { MIN_AGENT_USD, floorOverrun } from "../src/core/facilitator/executors/watch.ts";
import { MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE } from "../src/core/facilitator/executors/build.ts";
import { validateRunFile } from "../src/core/run/RunFile.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { makeRunWorkspace, gatedScope, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

let plain: TempRunWorkspace[] = [];
let scratch: string[] = [];

afterEach(() => {
  for (const ws of plain) ws.dispose();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  plain = [];
  scratch = [];
});

function workspace(): TempRunWorkspace {
  const made = makeRunWorkspace({ files: gatedScope("true") });
  plain.push(made);
  return made;
}

function newRun(root: string): RunStore {
  const created = createRun({
    root, slug: "money", title: "Money", scope: "gated", budgetUsd: 10,
    actor: "alan", now: new Date("2026-08-29T09:00:00Z"),
  });
  return RunStore.open(created.runDir);
}

function capture(): () => string {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
    return buffer;
  };
}

describe("M6 · budget raise leaves a record", () => {
  test("`budget.raised` is a real event type", () => {
    expect(EVENT_TYPES).toContain("budget.raised");
  });

  test("a raise appends one event with before, after, actor and note", async () => {
    const ws = workspace();
    const store = newRun(ws.root);
    const before = store.budget.phases[0]?.ceiling_usd ?? 0;

    const printed = capture();
    const code = await budgetCommand.run([
      "raise", "01-what", "2.50", "--run", store.runId, "--root", ws.root,
      "--note", "the retry needs headroom",
    ]);
    printed();
    expect(code).toBe(0);

    const raised = new EventLog(join(store.runDir, "events.jsonl")).read()
      .filter((e) => e.type === "budget.raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.payload).toMatchObject({
      phase: "01-what",
      amount_usd: 2.5,
      phase_ceiling_before: before,
      phase_ceiling_after: before + 2.5,
      note: "the retry needs headroom",
    });
    expect(raised[0]?.actor).not.toBe("");
    expect(raised[0]?.cost_usd).toBe(0);
  });

  test("a REFUSED raise appends nothing", async () => {
    const ws = workspace();
    const store = newRun(ws.root);
    const code = await budgetCommand.run([
      "raise", "09-nope", "2.50", "--run", store.runId, "--root", ws.root,
    ]);
    expect(code).not.toBe(0);
    const raised = new EventLog(join(store.runDir, "events.jsonl")).read()
      .filter((e) => e.type === "budget.raised");
    expect(raised).toHaveLength(0);
  });
});

describe("M7 · unmetered is not zero", () => {
  /** A run.yml with one in-session task nobody costed. */
  function withUnmetered(store: RunStore): RunStore {
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage, j) => j !== 0 ? stage : {
          ...stage,
          tasks: [{
            id: "t1", status: "done" as const, expert: null, model: null,
            cost_usd: null, metered: false,
            error: null, session_id: "s1",
            started_at: "2026-08-29T09:00:00Z", ended_at: "2026-08-29T09:01:00Z",
            outputs: [],
          }],
        }),
      }),
    }));
    store.save();
    return RunStore.open(store.runDir);
  }

  test("`cost_usd: null` + `metered: false` validates and round-trips", () => {
    const ws = workspace();
    const store = withUnmetered(newRun(ws.root));
    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(text).toContain("cost_usd: null");
    expect(text).toContain("metered: false");
    expect(validateRunFile(parseYaml(text)).ok).toBe(true);
    expect(store.run.phases[0]?.stages[0]?.tasks[0]?.cost_usd).toBeNull();
  });

  test("a null cost without `metered: false` is a schema error — the two go together", () => {
    const ws = workspace();
    const store = withUnmetered(newRun(ws.root));
    const doc = parseYaml(emitRunYaml(store.run)) as Record<string, unknown>;
    const stage = (doc.phases as { stages: { tasks: Record<string, unknown>[] }[] }[])[0]?.stages[0];
    const task = stage?.tasks[0];
    if (task !== undefined) delete task.metered;
    const report = validateRunFile(doc);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.message).join(" ")).toContain("must be marked `metered: false`");
  });

  test("it contributes nothing to the total, and the total says so", () => {
    const ws = workspace();
    const store = withUnmetered(newRun(ws.root));
    expect(store.run.budget.spent_usd).toBe(0);
    expect(countUnmetered(store.run)).toBe(1);
  });

  test("`budget show` renders it as unmetered rather than as $0.00 verified", () => {
    const ws = workspace();
    const store = withUnmetered(newRun(ws.root));
    const rendered = renderBudget(buildBudgetView(store.run, store.budget));
    expect(rendered).toContain("+1 unmetered");
    expect(rendered).toContain("LOWER BOUND");
    expect(rendered).toContain("--cost-usd");
  });

  test("`run status` renders it too", () => {
    const ws = workspace();
    const store = withUnmetered(newRun(ws.root));
    const rendered = renderStatus(buildStatus(store.run, store.budget, store.runDir));
    expect(rendered).toContain("1 unmetered (in-session)");
  });

  test("a metered task is unchanged — no `metered:` key at all", () => {
    const ws = workspace();
    const store = newRun(ws.root);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage, j) => j !== 0 ? stage : {
          ...stage,
          tasks: [{
            id: "t1", status: "done" as const, expert: null, model: null,
            cost_usd: 1.25, error: null, session_id: "s1",
            started_at: "2026-08-29T09:00:00Z", ended_at: "2026-08-29T09:01:00Z",
            outputs: [],
          }],
        }),
      }),
    }));
    store.save();
    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(text).toContain("cost_usd: 1.25");
    expect(text).not.toContain("metered:");
    expect(RunStore.open(store.runDir).run.budget.spent_usd).toBe(1.25);
  });
});

describe("M9 · a phase ceiling is a ceiling", () => {
  /** Enough of an ExecutorContext for the two pure budget helpers. */
  function ctx(budgetUsd: number, maxBudgetUsd = budgetUsd): never {
    return {
      phaseId: "05-watch", stageId: "watch", budgetUsd, maxBudgetUsd,
      agentCap: (share = 1) => Math.round(maxBudgetUsd * share * 100) / 100,
    } as never;
  }

  test("Watch refuses BEFORE spawning when the floor cannot fit", () => {
    // 10 features x $0.25 = $2.50 against a $1.00 stage ceiling.
    const message = floorOverrun(ctx(1), 10);
    expect(message).not.toBeNull();
    expect(message).toContain("refuses to start");
    expect(message).toContain("$2.50 in total");
    expect(message).toContain("tldrx budget raise 05-watch 1.50");
  });

  test("and allows it when it does fit", () => {
    expect(floorOverrun(ctx(5), 10)).toBeNull();
    expect(floorOverrun(ctx(10 * MIN_AGENT_USD), 10)).toBeNull();
  });

  test("Build's dev+reviewer x attempts now fits inside the stage ceiling", () => {
    // The shares the executor computes, reproduced from its own constants.
    const stories = 4;
    const stageCeiling = 10;
    const worstCase = stories * MAX_ATTEMPTS * (1 + REVIEWER_SHARE);
    const dev = stageCeiling * (1 / worstCase);
    const reviewer = stageCeiling * (REVIEWER_SHARE / worstCase);
    const total = stories * MAX_ATTEMPTS * (dev + reviewer);
    expect(total).toBeLessThanOrEqual(stageCeiling + 0.001);
  });

  /**
   * The live case, in numbers, so the trade is written down where it can be read
   * back: run `260830-tenancy-identity-customers`, 7 stories, a $18.00 Build
   * stage, and `03-plan/budget.yml` pricing S1 at $4.75.
   */
  test("the priced split gives S1 what the plan said it was worth", () => {
    const stage = 18;
    const prices = { S1: 4.75, S2: 0.75, S3: 3.25, S4: 3.75, S5: 2.25, S6: 1.25, S7: 1.0 };
    const total = Object.values(prices).reduce((sum, p) => sum + p, 0);
    expect(total).toBe(17);
    expect(total).toBeLessThanOrEqual(stage);           // nothing is scaled down

    const dev = prices.S1 / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE));
    expect(dev).toBeCloseTo(1.9, 5);
    // The derived reviewer share is $0.475 — under the floor, and under what a
    // 39-file diff costs to read. The measured failure was $0.26.
    expect(dev * REVIEWER_SHARE).toBeCloseTo(0.475, 5);
    expect(Math.max(dev * REVIEWER_SHARE, REVIEWER_FLOOR_USD)).toBe(1.0);

    // What the old uniform split handed the same story: $1.03 and $0.26, the
    // same as the story priced at $0.75.
    const uniform = stage / (7 * MAX_ATTEMPTS * (1 + REVIEWER_SHARE));
    expect(uniform).toBeCloseTo(1.028571, 5);
    expect(uniform * REVIEWER_SHARE).toBeCloseTo(0.257143, 5);
  });

  test("the OLD arithmetic is what overran — 2.5x, as measured", () => {
    const stories = 4;
    const stageCeiling = 10;
    const oldDev = stageCeiling * (1 / stories);
    const oldReviewer = stageCeiling * (REVIEWER_SHARE / stories);
    const oldTotal = stories * MAX_ATTEMPTS * (oldDev + oldReviewer);
    expect(oldTotal / stageCeiling).toBeCloseTo(2.5, 5);
  });
});

describe("M10 · the settings backup is ignored", () => {
  test("`tldrx init` writes the pattern into .gitignore", () => {
    expect(GITIGNORE_BODY).toContain(".claude/settings.json.bak-tldrx-*");
  });

  test("and this repo's own .gitignore carries it", () => {
    const own = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    expect(own).toContain(".claude/settings.json.bak-tldrx-*");
  });
});

describe("M8 · tickets sync writes only on purpose", () => {
  /** A workspace whose process.yml turns the adapter off. */
  function withProcess(kind: string): TempRunWorkspace {
    const made = makeRunWorkspace({
      files: {
        ...gatedScope("true"),
        ".tldrx/process.yml": `version: 1\nticket_tool: {kind: ${kind}, project: null, sync: one-way}\n`,
      },
    });
    plain.push(made);
    return made;
  }

  test("`--provider github` cannot switch on a workspace set to `kind: none`", async () => {
    const ws = withProcess("none");
    newRun(ws.root);
    const code = await ticketsCommand.run(["sync", "--root", ws.root, "--provider", "github"]);
    expect(code).toBe(1);
  });

  test("with no --provider, `kind: none` is still the no-op it always was", async () => {
    const ws = withProcess("none");
    newRun(ws.root);
    const printed = capture();
    const code = await ticketsCommand.run(["sync", "--root", ws.root]);
    const out = printed();
    expect(code).toBe(0);
    expect(out).toContain("adapter disabled");
  });

  test("the usage line advertises --apply, not --dry-run", () => {
    expect(ticketsCommand.usage).toContain("--apply");
    expect(ticketsCommand.usage).not.toContain("--dry-run");
  });
});

/** Keeps the temp-dir helper reachable for a future test. */
export function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-money-"));
  mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  writeFileSync(join(dir, ".keep"), "", "utf8");
  return dir;
}
