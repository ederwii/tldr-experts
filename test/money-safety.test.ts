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
import {
  MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE, developerPriceDivisor,
} from "../src/core/facilitator/executors/build.ts";
import { tokenSplit } from "../src/core/facilitator/runNext.ts";
import { turnTokens } from "../src/core/budget/turnTokens.ts";
import { validateRunFile, type RunTask } from "../src/core/run/RunFile.ts";
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

describe("tokenSplit — both-or-nothing, and never an invented number", () => {
  /**
   * `AgentUsage`'s parse collapses "no usage object at all" and "usage reported
   * as exactly 0" into the identical `{0, 0}` shape (`envelope.ts`'s
   * `toUsage`/`EMPTY_USAGE`), so this layer cannot tell those two apart — and a
   * HALF-reported split (`{0, 56}`) hands the same problem to just one side: the
   * 56 might be real, but the 0 next to it is `number()`'s default, not a
   * measurement. Requiring BOTH strictly positive is the only rule under which
   * every number this writes is one the provider actually reported.
   */
  test("a fully-unreported split ({0, 0}) is absent", () => {
    expect(tokenSplit(0, 0)).toEqual({});
  });

  test("a half-reported split ({0, N}) is absent — the 0 would be invented", () => {
    expect(tokenSplit(0, 56)).toEqual({});
    expect(tokenSplit(56, 0)).toEqual({});
  });

  test("a fully-reported split ({N, M}, both positive) writes both together", () => {
    expect(tokenSplit(12, 56)).toEqual({ input_tokens: 12, output_tokens: 56 });
  });

  test("a negative on either side is absent, never clamped into a schema error", () => {
    expect(tokenSplit(-1, 56)).toEqual({});
    expect(tokenSplit(12, -1)).toEqual({});
    expect(tokenSplit(-1, -1)).toEqual({});
  });

  test("either side missing is absent", () => {
    expect(tokenSplit(undefined, 56)).toEqual({});
    expect(tokenSplit(12, undefined)).toEqual({});
    expect(tokenSplit(undefined, undefined)).toEqual({});
  });
});

describe("the provider's token split on a run.yml task row", () => {
  /**
   * The split is PARSED on every provider turn and used to reach the event log
   * only, so `run.yml` — the file every cost report and every resumed run reads —
   * could say what a turn cost in dollars and never what it cost in tokens. A
   * dollar figure with no token figure beside it cannot be checked against a
   * price table, which makes it an unfalsifiable bound.
   */
  const DEFAULT_TASK: RunTask = {
    id: "t1", status: "done", expert: null, model: null,
    cost_usd: 0.01, error: null, session_id: "s1",
    started_at: "2026-08-29T09:00:00Z", ended_at: "2026-08-29T09:01:00Z",
    outputs: [],
  };

  /**
   * Replace the run's first task with `fn`'s result, seeding a default valid one
   * first when the run has none yet (a freshly created run's stage starts with
   * `tasks: []`) — same reach `withUnmetered` above uses, generalized with a
   * transform instead of a fixed literal.
   */
  function mapFirstTask(store: RunStore, fn: (task: RunTask) => RunTask): void {
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage, j) => j !== 0 ? stage : {
          ...stage,
          tasks: [fn(stage.tasks[0] ?? DEFAULT_TASK)],
        }),
      }),
    }));
  }

  /**
   * The same reach as `mapFirstTask`, but for a plain JSON doc rather than a
   * `RunStore` — seeds a default task in place (mutating `doc`) when the run has
   * none yet, and returns a reference the caller can corrupt a field on directly.
   */
  function firstTaskOf(doc: Record<string, unknown>): Record<string, unknown> | undefined {
    const phases = doc.phases as Array<Record<string, unknown>> | undefined;
    const stages = phases?.[0]?.stages as Array<Record<string, unknown>> | undefined;
    const tasks = stages?.[0]?.tasks as Array<Record<string, unknown>> | undefined;
    if (tasks === undefined) return undefined;
    if (tasks.length === 0) {
      const seeded = { ...DEFAULT_TASK } as unknown as Record<string, unknown>;
      tasks.push(seeded);
      return seeded;
    }
    return tasks[0];
  }

  test("round-trips through the emitter and the parser", () => {
    const ws = workspace();
    const store = newRun(ws.root);
    mapFirstTask(store, (task) => ({ ...task, input_tokens: 184_203, output_tokens: 9_114 }));
    store.save();

    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(text).toContain("input_tokens: 184203");
    expect(text).toContain("output_tokens: 9114");

    const reread = RunStore.open(store.runDir).run.phases[0]?.stages[0]?.tasks[0];
    expect(reread?.input_tokens).toBe(184_203);
    expect(reread?.output_tokens).toBe(9_114);
  });

  test("a run with no tasks yet says nothing about tokens either", () => {
    const ws = workspace();
    const store = newRun(ws.root);
    store.save();
    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(text).not.toContain("input_tokens");
    expect(text).not.toContain("output_tokens");
  });

  test("a TASK row without them is byte-identical to what it was, and still loads", () => {
    const ws = workspace();
    const store = newRun(ws.root);
    // A real, already-recorded task row — same shape a run.yml written before
    // this field existed would have — so the emitter actually runs `task()` on
    // it rather than mapping an empty array. Without this, a mutation as blunt
    // as writing `input_tokens: ${t.input_tokens ?? 0}` unconditionally would
    // pass every test in this block (measured: it did, before this test existed).
    mapFirstTask(store, (task) => task);
    store.save();
    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    // The keys are written only when there is something to write. Every run.yml
    // produced before this field existed round-trips unchanged.
    expect(text).not.toContain("input_tokens");
    expect(text).not.toContain("output_tokens");
    expect(RunStore.open(store.runDir).run.phases[0]?.stages[0]?.tasks[0]?.input_tokens)
      .toBeUndefined();
  });

  test("a non-number is a schema error, so the field cannot hold prose", () => {
    const ws = workspace();
    const store = newRun(ws.root);
    const doc = JSON.parse(JSON.stringify(store.run)) as Record<string, unknown>;
    const task = firstTaskOf(doc);
    if (task !== undefined) task.input_tokens = "lots";
    const report = validateRunFile(doc);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.message).join(" ")).toContain("expected a number >= 0");
  });
});

describe("turnTokens — the scalar, else the provider's split, never a half (#159)", () => {
  /**
   * The READ-side pair of `tokenSplit` above: that one decides what a row
   * WRITES, this one decides what a row — this one's or an older one's —
   * counts as having DECLARED, for `spendBasisOf`'s two feeders.
   */
  test("a host-declared `tokens` wins, because it is what the host said", () => {
    expect(turnTokens({ tokens: 900, input_tokens: 100, output_tokens: 10 })).toBe(900);
  });

  test("no scalar, both sides of the split present: their sum", () => {
    expect(turnTokens({ input_tokens: 100, output_tokens: 10 })).toBe(110);
  });

  test("a HALF split is absent — the same rule `tokenSplit` writes rows by", () => {
    expect(turnTokens({ input_tokens: 100 })).toBeNull();
    expect(turnTokens({ output_tokens: 10 })).toBeNull();
    expect(turnTokens({ input_tokens: 100, output_tokens: 0 })).toBeNull();
  });

  test("nothing declared is null, never a confident zero", () => {
    expect(turnTokens({})).toBeNull();
  });

  test("a negative or non-finite side is absent, never arithmetic", () => {
    expect(turnTokens({ input_tokens: -1, output_tokens: 10 })).toBeNull();
    expect(turnTokens({ input_tokens: Number.NaN, output_tokens: 10 })).toBeNull();
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

    // gh #91: attempt 1 is the pass Delivery priced, so it gets the price less
    // the reviewer's derived quarter — not that figure halved again.
    const dev = prices.S1 / developerPriceDivisor(1);
    expect(dev).toBeCloseTo(3.8, 5);
    // The reviewer's own share is UNTOUCHED by #91 and still derives off the
    // worst case: $0.475 — under the floor, and under what a 39-file diff costs
    // to read. The measured failure was $0.26.
    const reviewer = prices.S1 * REVIEWER_SHARE / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE));
    expect(reviewer).toBeCloseTo(0.475, 5);
    expect(Math.max(reviewer, REVIEWER_FLOOR_USD)).toBe(1.0);

    // What the old uniform split handed the same story: $1.03 and $0.26, the
    // same as the story priced at $0.75.
    const uniform = stage / (7 * MAX_ATTEMPTS * (1 + REVIEWER_SHARE));
    expect(uniform).toBeCloseTo(1.028571, 5);
    expect(uniform * REVIEWER_SHARE).toBeCloseTo(0.257143, 5);
  });

  /**
   * gh #91's arithmetic, written down where the trade can be read back.
   *
   * The phase ceiling is metered ONCE, at stage entry (`runNext.runExecutor`
   * skips the brake while a stage is `running`), so nothing checks the envelope
   * again between two story spawns of the same headless `runAll`. That is why
   * attempt 1 may take the whole priced pass but attempt 2 may not: the worst
   * case one priced story can be asked for goes from `0.8 x price` to
   * `1.2 x price`, and `priceScale` still holds the sum of the prices themselves
   * inside the stage.
   */
  test("attempt 1 doubles, attempt 2 does not, and the sum of the prices still fits", () => {
    const stage = 3.85;                                  // 260901-leaderboard-v2
    const prices = { S1: 1.75, S2: 2.10 };
    expect(Object.values(prices).reduce((sum, p) => sum + p, 0)).toBeCloseTo(stage, 5);

    expect(prices.S2 / developerPriceDivisor(1)).toBeCloseTo(1.68, 5);
    expect(prices.S2 / developerPriceDivisor(2)).toBeCloseTo(0.84, 5);
    // The pre-#91 figure IS attempt 2's, so no attempt is ever handed less than
    // it used to be.
    for (const attempt of [1, 2, 3]) {
      expect([attempt, developerPriceDivisor(attempt) <= MAX_ATTEMPTS * (1 + REVIEWER_SHARE)])
        .toEqual([attempt, true]);
    }

    const worstPerStory = 1 / developerPriceDivisor(1) + 1 / developerPriceDivisor(2);
    expect(worstPerStory).toBeCloseTo(1.2, 5);
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
