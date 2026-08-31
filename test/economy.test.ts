/**
 * The dual economy (design §E) — a price gets a currency.
 *
 * The measurement this file exists for: on 2026-08-30 a Plan agent priced
 * `260830-tenancy-identity-customers` assuming HOST-billed sub-agents — turns the
 * host session pays for, which this process never meters — and the executor then
 * enforced those figures as dollar ceilings on METERED spawns. Six spawns of six
 * died on `Reached maximum budget`, each having spent real money to get there:
 * **$9.95**, for nothing.
 *
 * So `budget.yml` gains one optional label, and three things follow from it: a
 * headless spawn under a `host-tokens` ceiling is refused BEFORE it spends, the
 * auto gate's money condition abstains instead of comparing two different units,
 * and `tldrx cost` stops printing one number over two currencies.
 *
 * The compat bar is the first describe block and it is the important one: with no
 * label, every path must behave exactly as it did before the label existed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import {
  asRunBudget, economyFor, isHostTokens, validateRunBudget,
  DEFAULT_ECONOMY, type RunBudget,
} from "../src/core/budget/RunBudget.ts";
import { validateBudget } from "../src/core/schemas/budget.ts";
import { emitBudgetYaml } from "../src/core/run/emitRunYaml.ts";
import { raiseBudget } from "../src/core/budget/raiseBudget.ts";
import { buildRunCost, renderRunCost } from "../src/core/budget/costView.ts";
import { loadPlanPrices } from "../src/core/build/plan.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace,
  type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_ARGV_LOG",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const workspace of open) workspace.dispose();
  open = [];
});

const ONE_STAGE: readonly StageOptions[] = [
  {
    id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
    outputs: [
      { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
      { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    ],
  },
  { id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto", outputs: [{ path: "02-how/handoff.md" }] },
];

const ALPHA_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});

function workspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: ONE_STAGE, budgetUsd: 10 });
  open.push(made);
  return made;
}

/**
 * The same run, but `alpha` ends at a real gate the harness is allowed to sign —
 * `gate: approve` in the stage file plus `gates_policy: auto` from the workflow,
 * which is the pair `evaluateAutoGate` actually runs for.
 */
function autoGatedWorkspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo",
    stages: [{ ...(ONE_STAGE[0] as StageOptions), gate: "approve", checks: "[claim-sources]" }, ONE_STAGE[1] as StageOptions],
    budgetUsd: 10,
    gates: { alpha: "auto" },
  });
  open.push(made);
  return made;
}

/**
 * The fake `claude`, alone on PATH, with an argv log.
 *
 * The log is the instrument for "nothing was spawned": the fake appends one line
 * to it the moment it starts, so an absent file is proof the binary was never
 * reached — a stronger claim than "no `agent.spawned` event was written", which
 * only proves the ledger stayed quiet.
 */
function fakeClaude(ws: FacilitatorWorkspace): string {
  const log = join(ws.root, "argv.log");
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = ALPHA_OUTPUTS;
  process.env.FAKE_CLAUDE_ARGV_LOG = log;
  return log;
}

function next(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
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

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

/** Label one phase `host-tokens`, in the file on disk, as an operator would. */
function priceInHostTokens(ws: FacilitatorWorkspace, phaseId = "01-what"): void {
  const path = join(ws.runDir, "budget.yml");
  const marker = new RegExp(`id: "?${phaseId}"?,`);
  const text = readFileSync(path, "utf8").split("\n").map((line) =>
    marker.test(line) ? line.replace(/}\s*$/, ", economy: host-tokens}") : line,
  ).join("\n");
  writeFileSync(path, text, "utf8");
  // The edit is only worth anything if it survives the loader.
  expect(isHostTokens(RunStore.open(ws.runDir).budget, phaseId)).toBe(true);
}

function budget(overrides: Partial<RunBudget> = {}): RunBudget {
  return asRunBudget({
    version: 1, run: "260830-x", ceiling_usd: 25, per_agent_max_usd: 4,
    warn_at_pct: 80, on_exceed: "block",
    phases: [
      { id: "01-what", ceiling_usd: 4, spent_usd: 1.14 },
      { id: "04-build", ceiling_usd: 8, spent_usd: 0 },
    ],
    ...overrides,
  });
}

// --- the compat bar --------------------------------------------------------

describe("no label (the compat bar)", () => {
  test("an absent `economy` resolves to metered-usd, at the run and at every phase", () => {
    const b = budget();
    expect(b.economy).toBe(DEFAULT_ECONOMY);
    expect(economyFor(b)).toBe("metered-usd");
    expect(economyFor(b, "01-what")).toBe("metered-usd");
    expect(economyFor(b, "no-such-phase")).toBe("metered-usd");
    expect(isHostTokens(b, "04-build")).toBe(false);
    // A run with no budget.yml at all is the default too, never a throw.
    expect(economyFor(null, "04-build")).toBe("metered-usd");
  });

  test("a budget.yml with no label emits no `economy:` line — byte-identical output", () => {
    const text = emitBudgetYaml(budget());
    expect(text).not.toContain("economy");
    // And it still validates, which is the round trip the emitter is checked on.
    expect(validateRunBudget(parseYaml(text)).ok).toBe(true);
  });

  test("an unlabelled headless stage still spawns — the refusal is opt-in, not a new default", async () => {
    const ws = workspace();
    const log = fakeClaude(ws);
    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(events(ws).filter((e) => e.type === "agent.spawned").length).toBe(1);
  });

  test("`tldrx cost` on an unlabelled run prints one economy and no host-billed footer", () => {
    const ws = workspace();
    EventLog.forRun(ws.runDir).append(metered(ws.runId));
    const cost = buildRunCost(ws.runDir);
    expect(cost?.stages[0]?.economy).toBe("metered-usd");
    expect(cost?.economies).toEqual(["metered-usd"]);
    const text = renderRunCost(cost!);
    expect(text).toContain("metered      $0.42 over 1 attempt");
    expect(text).not.toContain("host-billed");
  });
});

// --- the label -------------------------------------------------------------

describe("the economy label (§E.2)", () => {
  test("both values validate, at the run level and per phase", () => {
    const doc = {
      version: 1, run: "r", ceiling_usd: 25, per_agent_max_usd: 4, on_exceed: "block",
      economy: "metered-usd",
      phases: [{ id: "04-build", ceiling_usd: 8, spent_usd: 0, economy: "host-tokens" }],
    };
    expect(validateRunBudget(doc).ok).toBe(true);
  });

  test("a value this reader does not know is REFUSED, never defaulted to dollars", () => {
    const doc = {
      version: 1, run: "r", ceiling_usd: 25, per_agent_max_usd: 4, on_exceed: "block",
      economy: "eur", phases: [],
    };
    const issues = validateRunBudget(doc).issues;
    expect(issues.some((i) => i.path === "economy")).toBe(true);
    expect(issues.find((i) => i.path === "economy")?.message)
      .toContain("expected one of metered-usd | host-tokens");
  });

  test("an unknown value on a PHASE is refused too, and names the phase index", () => {
    const doc = {
      version: 1, run: "r", ceiling_usd: 25, per_agent_max_usd: 4, on_exceed: "block",
      phases: [{ id: "04-build", ceiling_usd: 8, spent_usd: 0, economy: "credits" }],
    };
    expect(validateRunBudget(doc).issues.some((i) => i.path === "phases[0].economy")).toBe(true);
  });

  test("resolution is phase-then-run, and a phase may disagree with its run", () => {
    const mixed = budget({
      economy: "host-tokens",
      phases: [
        { id: "01-what", ceiling_usd: 4, spent_usd: 0, economy: "metered-usd" },
        { id: "04-build", ceiling_usd: 8, spent_usd: 0, economy: null },
      ],
    });
    expect(economyFor(mixed, "01-what")).toBe("metered-usd");
    expect(economyFor(mixed, "04-build")).toBe("host-tokens");
    expect(economyFor(mixed)).toBe("host-tokens");
  });

  /**
   * `budget raise` rewrites budget.yml through the emitter. A label that did not
   * round-trip would be ERASED by the one command an operator reaches for when a
   * ceiling binds — turning a token budget back into dollars silently, which is
   * the exact failure the label exists to stop.
   */
  test("`budget raise` does not erase the label it rewrites past", () => {
    const before = budget({
      economy: "host-tokens",
      phases: [
        { id: "01-what", ceiling_usd: 4, spent_usd: 0, economy: null },
        { id: "04-build", ceiling_usd: 8, spent_usd: 0, economy: "metered-usd" },
      ],
    });
    const after = raiseBudget(before, { phaseId: "04-build", amountUsd: 2 }).budget;
    const text = emitBudgetYaml(after);
    expect(text).toContain("economy: host-tokens");
    expect(text).toContain("economy: metered-usd");
    const reread = asRunBudget(parseYaml(text));
    expect(economyFor(reread, "04-build")).toBe("metered-usd");
    expect(economyFor(reread, "01-what")).toBe("host-tokens");
    expect(reread.phases.find((p) => p.id === "04-build")?.ceiling_usd).toBe(10);
  });

  test("`03-plan/budget.yml` takes the same label, and rejects a value it does not know", () => {
    const base = { version: 1, run: "r", ceiling_usd: 20, spent_usd: 0, per_phase_usd: { S1: 4.75 } };
    expect(validateBudget({ ...base, economy: "host-tokens" }).ok).toBe(true);
    expect(validateBudget({ ...base, economy: "tokens" }).ok).toBe(false);
    expect(validateBudget(base).ok).toBe(true);
  });
});

// --- the refusal that would have saved the $9.95 ---------------------------

describe("a headless spawn under a host-tokens ceiling (§E.2)", () => {
  test("REFUSES at exit 2 before spending, and the fake claude is never invoked", async () => {
    const ws = workspace();
    const log = fakeClaude(ws);
    priceInHostTokens(ws);

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);

    // Nothing was spawned — the strong instrument first.
    expect(existsSync(log)).toBe(false);
    expect(events(ws).filter((e) => e.type === "agent.spawned").length).toBe(0);
    // And nothing was even started: the refusal is above prompt assembly.
    expect(events(ws).filter((e) => e.type === "stage.started").length).toBe(0);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("pending");
  });

  test("the message names the phase, the number, the unit and both ways out", async () => {
    const ws = workspace();
    fakeClaude(ws);
    priceInHostTokens(ws);

    const text = (await next(ws)).lines.join(" ");
    expect(text).toContain("refusing to spawn");
    expect(text).toContain("01-what is priced in `host-tokens`");
    expect(text).toContain("is not dollars a spawn may");
    expect(text).toContain("tldrx next --prepare");
    expect(text).toContain("economy: metered-usd");
    expect(text).toContain("tldrx budget raise 01-what");
  });

  test("`--prepare` on the same phase runs: in-session is where a host-billed turn belongs", async () => {
    const ws = workspace();
    const log = fakeClaude(ws);
    priceInHostTokens(ws);

    const outcome = await next(ws, { mode: "prepare" });
    expect(outcome.code).toBe(0);
    expect(existsSync(join(ws.runDir, ".agent", "alpha", "prompt.md"))).toBe(true);
    expect(existsSync(log)).toBe(false);
    // The phase said its ceiling is not in dollars, and the run says so once.
    const warned = events(ws).filter((e) => e.type === "budget.warned");
    expect(warned.length).toBe(1);
    expect((warned[0]?.payload as { economy?: string }).economy).toBe("host-tokens");
    expect(outcome.lines.join(" ")).toContain("priced in `host-tokens`");
  });

  test("a metered phase in the same run is untouched by the label on another", async () => {
    const ws = workspace();
    const log = fakeClaude(ws);
    priceInHostTokens(ws, "02-how");

    // 01-what is unlabelled, so it spawns exactly as before.
    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(existsSync(log)).toBe(true);
  });
});

// --- condition 3 -----------------------------------------------------------

describe("the auto gate's money condition (§E.2)", () => {
  test("reads `n/a (host-tokens economy)` rather than comparing two units", async () => {
    const ws = autoGatedWorkspace();
    fakeClaude(ws);
    priceInHostTokens(ws);

    await next(ws, { mode: "prepare" });
    // The host session does the work: the files land on disk and result.json
    // names them. No `cost_usd` — this phase is not priced in dollars.
    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "alpha", "result.json"),
      JSON.stringify({
        outputs: ["01-what/intent.md", "01-what/handoff.md"],
        questions_asked: [],
        notes: "written by the host session",
      }),
      "utf8",
    );
    const committed = await next(ws, { mode: "commit" });
    expect(committed.code).toBe(0);

    const gate = RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate;
    expect(gate?.status).toBe("approved");
    expect(gate?.note).toContain("budget=n/a (host-tokens economy)");
    // The other five conditions still report their measured values.
    expect(gate?.note).toContain("claim-sources=");
  });
});

// --- the two ledgers -------------------------------------------------------

describe("`tldrx cost`, with the economy as its axis (§E.2)", () => {
  test("two footers, no grand total, and no row spanning both units", () => {
    const ws = workspace();
    priceInHostTokens(ws, "02-how");
    const log = EventLog.forRun(ws.runDir);
    log.append(metered(ws.runId));
    log.append(declared(ws.runId));

    const cost = buildRunCost(ws.runDir);
    expect(cost?.economies).toEqual(["metered-usd", "host-tokens"]);
    const byStage = new Map(cost!.stages.map((s) => [s.stage, s]));
    expect(byStage.get("alpha")?.economy).toBe("metered-usd");
    expect(byStage.get("beta")?.economy).toBe("host-tokens");

    const text = renderRunCost(cost!);
    expect(text).toContain("STAGE");
    expect(text).toContain("ECONOMY");
    expect(text).toContain("metered      $0.42 over 1 attempt");
    expect(text).toContain("host-billed  ~342.5k tokens declared over 1 attempt");
    expect(text).toContain("no dollar figure; this process metered none of it");
    expect(text).toContain("(no total: two economies, no exchange rate");

    // The metered row carries no token figure and the host row carries no dollar.
    const rows = text.split("\n");
    const metered_ = rows.find((l) => l.includes("01-what/alpha") && l.includes("metered-usd"));
    const host = rows.find((l) => l.includes("02-how/beta") && l.includes("host-tokens"));
    expect(metered_).toContain("$0.42");
    expect(metered_).not.toContain("tokens (host session)");
    expect(host).toContain("~342.5k tokens (host session)");
    expect(host).not.toContain("$");
  });

  test("the header carries NO dollar figure — the totals live in their own footers", () => {
    const ws = workspace();
    priceInHostTokens(ws, "02-how");
    const log = EventLog.forRun(ws.runDir);
    log.append(metered(ws.runId));
    log.append(declared(ws.runId));

    const text = renderRunCost(buildRunCost(ws.runDir)!);
    const header = text.split("\n")[0] ?? "";
    expect(header).toContain(ws.runId);
    expect(header).not.toContain("$");
    // The stage row, its one attempt, and the metered footer — and nothing above
    // them claiming to be the run's cost.
    expect(text.split("\n").filter((line) => line.includes("$0.42")).length).toBe(3);
  });

  test("`--json` carries the economy on every row", () => {
    const ws = workspace();
    priceInHostTokens(ws, "02-how");
    const log = EventLog.forRun(ws.runDir);
    log.append(metered(ws.runId));
    log.append(declared(ws.runId));

    const json = JSON.parse(JSON.stringify(buildRunCost(ws.runDir))) as {
      economies: string[]; stages: { stage: string; economy: string }[];
    };
    expect(json.economies).toEqual(["metered-usd", "host-tokens"]);
    expect(json.stages.map((s) => `${s.stage}:${s.economy}`).sort())
      .toEqual(["alpha:metered-usd", "beta:host-tokens"]);
  });

  test("an attempt that reported neither is still UNMETERED, never zero", () => {
    const ws = workspace();
    EventLog.forRun(ws.runDir).append(agentResult("alpha", ws.runId, {
      cost_usd: 2, payload: { phase: "01-what", task: "t1", metered: false },
    }));
    const text = renderRunCost(buildRunCost(ws.runDir)!);
    expect(text).toContain("UNMETERED");
    expect(text).toContain("cost unknown, and never counted as zero");
    expect(text).not.toContain("host-billed");
  });

  test("a budget.yml that will not load never stops the ledger printing", () => {
    const ws = workspace();
    writeFileSync(join(ws.runDir, "budget.yml"), "this: [is not\n", "utf8");
    EventLog.forRun(ws.runDir).append(metered(ws.runId));
    const cost = buildRunCost(ws.runDir);
    expect(cost?.stages[0]?.economy).toBe("metered-usd");
    expect(renderRunCost(cost!)).toContain("$0.42");
  });
});

// --- the Plan's own prices -------------------------------------------------

describe("`03-plan/budget.yml` priced in host-tokens (§E.2)", () => {
  test("its numbers never become dollar caps; the executor is told why", () => {
    const ws = workspace();
    const planDir = join(ws.runDir, "03-plan");
    write(planDir, "budget.yml", [
      "version: 1", "run: r", "ceiling_usd: 20", "spent_usd: 0",
      "economy: host-tokens", "per_phase_usd:", "  S1: 4.75", "",
    ].join("\n"));

    const stories = new Map([["S1", {} as never]]);
    const priced = loadPlanPrices(planDir, stories);
    expect(priced.prices.size).toBe(0);
    expect(priced.issue).toContain("priced in `host-tokens`");
    expect(priced.issue).toContain("not dollars a spawn may spend");
  });

  test("the same file without the label prices the story exactly as before", () => {
    const ws = workspace();
    const planDir = join(ws.runDir, "03-plan");
    write(planDir, "budget.yml", [
      "version: 1", "run: r", "ceiling_usd: 20", "spent_usd: 0",
      "per_phase_usd:", "  S1: 4.75", "",
    ].join("\n"));

    const priced = loadPlanPrices(planDir, new Map([["S1", {} as never]]));
    expect(priced.prices.get("S1")).toBe(4.75);
    expect(priced.issue).toBeNull();
  });
});

// --- fixtures --------------------------------------------------------------

function agentResult(
  stage: string,
  run: string,
  overrides: Partial<TldrxEvent> & { payload?: Record<string, unknown> } = {},
): TldrxEvent {
  return {
    ts: "2026-08-30T00:00:00Z", run, stage, type: "agent.result",
    actor: "alan", cost_usd: 0.42,
    payload: { phase: "01-what", task: "t1", model: "sonnet", outputs: [] },
    ...overrides,
  } as TldrxEvent;
}

function metered(run: string): TldrxEvent {
  return agentResult("alpha", run, {
    cost_usd: 0.42,
    payload: {
      phase: "01-what", task: "t1", model: "sonnet",
      usage: {
        input_tokens: 1000, output_tokens: 200,
        cache_creation_input_tokens: 50, cache_read_input_tokens: 900,
      },
    },
  });
}

function declared(run: string): TldrxEvent {
  return agentResult("beta", run, {
    cost_usd: 0,
    payload: { phase: "02-how", task: "t1", model: "sonnet", metered: false, tokens: 342527 },
  });
}

function write(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, "utf8");
}
