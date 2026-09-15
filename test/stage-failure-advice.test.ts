/**
 * What a dead stage tells the operator to do next (gh #232, remaining half).
 *
 * The advice line at the end of every `EXIT_AGENT_FAILED` report used to be a
 * literal: "retry with `tldrx next`". On a phase that cannot fund the retry —
 * the pre-#170 one-attempt shape, which no `run new` creates any more but which
 * every run written before 2026-09-09 keeps for life — that command is refused
 * on arrival with exit 2, and the operator learns it by spending a round trip.
 *
 * The other half of #232 shipped in `efb4eee`: `budget show` now says NO-RETRY
 * for such a phase BEFORE the money is spent. This is the same fact said at the
 * other end, where the operator actually is when it bites.
 *
 * The prediction is made with the GATE's OWN inputs — `remaining`,
 * `stageRemainingWork`, `planRebalance` and this invocation's own
 * `--rebalance-finished` state, which is every term `budgetRefusal` decides on —
 * never with a second estimate of its own, so the two cannot disagree about the
 * arithmetic. `--rebalance-finished` is the term that matters most and the one a
 * first version of this fix got wrong: it is ON by default under `run auto`
 * (#330), and `tldrx next` alone never rebalances (`cli/helpText.ts`), so the
 * same starved phase is refused through one door and funded through the other.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { attendRun } from "../src/core/run/attend.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace,
  type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

setDefaultTimeout(spawnTestTimeout(60_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const workspace of open) workspace.dispose();
  open = [];
});

/** `planBudget` sizes `alpha` at $3 a turn and `01-what` at $6 — two attempts (#170). */
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

const ALPHA_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});

const BOTH_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
  "02-how/handoff.md": cannedHandoff(),
});

const PLAIN = 'cost is recorded, not refunded — retry with `tldrx next`, or `tldrx reject --note "…"`';

function workspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: TWO_STAGE, budgetUsd: 10 });
  open.push(made);
  return made;
}

function fakeClaude(ws: FacilitatorWorkspace, env: Readonly<Record<string, string>>): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function next(
  ws: FacilitatorWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, runId: ws.runId, dryRun: false, mode: "headless",
    yolo: true, actor: "alan", at: "2026-09-15T10:00:00Z", ...overrides,
  });
}

/**
 * Shrink a phase to the pre-#170 shape: a ceiling that holds exactly ONE attempt
 * of its stage. Not a hypothetical — it is what `run new` wrote before
 * 2026-09-09, and nothing migrates it.
 */
function starve(ws: FacilitatorWorkspace, phaseId: string, ceilingUsd: number, economy?: "host-tokens"): void {
  const store = RunStore.open(ws.runDir);
  store.mutateBudget((budget) => ({
    ...budget,
    phases: budget.phases.map((phase) => (phase.id === phaseId
      ? { ...phase, ceiling_usd: ceilingUsd, ...(economy === undefined ? {} : { economy }) }
      : phase)),
  }));
  store.save();
}

/** Everything the report says from the advice line down — it can be more than one line. */
function advice(lines: readonly string[]): string {
  const at = lines.findIndex((line) => line.startsWith("cost is recorded, not refunded"));
  return at === -1 ? "<no advice line>" : lines.slice(at).join("\n");
}

/** Finish `01-what` under its ceiling, so it is a rebalance DONOR for `02-how`. */
async function finishAlphaWithSlack(ws: FacilitatorWorkspace): Promise<void> {
  fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });
  const done = await next(ws);
  expect(done.code).toBe(0);
  expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("done");
}

describe("a stage death does not recommend a retry the budget will refuse (gh #232)", () => {
  test("the advice names the shortfall and the raise, not `tldrx next`", async () => {
    const ws = workspace();
    starve(ws, "01-what", 3);

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws);
    expect(failed.code).toBe(5);

    const said = advice(failed.lines);
    // The money is still not refunded — that half of the sentence is unconditional.
    expect(said).toContain("cost is recorded, not refunded");
    // …and the retry is named as refused, with BOTH figures and the family it
    // would come back on, so the operator never has to spend the round trip.
    expect(said).toContain("`tldrx next` would be refused on arrival (exit 2, the money family)");
    expect(said).toContain("phase 01-what has $2.58 left");
    expect(said).toContain("the retry is priced at $3.00");
    expect(said).toContain("$0.42 short");
    expect(said).toContain("tldrx budget raise 01-what 0.42");
    expect(said).toContain("tldrx reject");
    // Nothing is finished on this run, so there is no donor to offer and the
    // advice must not invent one.
    expect(said).not.toContain("--rebalance-finished");

    // The prediction is the gate's own: the retry really is refused, on those
    // figures. Asserting the advice alone would pass on a confident guess.
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_IS_ERROR: "", FAKE_CLAUDE_COST: "0.30" });
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    const retried = await next(ws, { at: "2026-09-15T10:30:00Z" });
    expect(retried.code).toBe(2);
    expect(retried.lines.join("\n")).toContain("refusing to start stage");
    expect(retried.lines.join("\n")).toContain("$2.58 left");
  });

  test("a phase that CAN fund the retry still gets the plain `tldrx next` advice", async () => {
    const ws = workspace();

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws);
    expect(failed.code).toBe(5);
    expect(advice(failed.lines)).toBe(PLAIN);

    // Same control in the other direction: the retry is genuinely allowed here.
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_IS_ERROR: "", FAKE_CLAUDE_COST: "0.30" });
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    const retried = await next(ws, { at: "2026-09-15T10:30:00Z" });
    expect(retried.code).not.toBe(2);
  });

  test("`on_exceed: warn` never refuses, so the advice is not rewritten for it", async () => {
    const ws = workspace();
    starve(ws, "01-what", 3);
    const store = RunStore.open(ws.runDir);
    store.mutateBudget((budget) => ({ ...budget, on_exceed: "warn" as const }));
    store.save();

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws);
    expect(failed.code).toBe(5);
    expect(advice(failed.lines)).toBe(PLAIN);
  });

  test("the failure SIGNATURE is still the failure's own sentence, not the advice (gh #297)", async () => {
    const ws = workspace();
    starve(ws, "01-what", 3);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws) as { code: number; lines: readonly string[]; signature?: string };
    expect(failed.signature).toContain("01-what/alpha failed:");
    expect(failed.signature).not.toContain("cost is recorded");
  });
});

/**
 * The correction a reviewer caught on the first version of this fix (13c2fd1).
 *
 * That version read the phase's remainder raw and declared the retry refused.
 * But `budgetRefusal` tries `rebalanceFinished` FIRST when this invocation was
 * launched with `--rebalance-finished`, which `run auto` passes by default
 * (#330) — the repo's primary mode. So the advice told the operator to raise a
 * ceiling on a run whose very next relaunch would have moved exactly that money
 * out of a finished phase by itself. `tldrx next` alone never rebalances, so the
 * SAME starved phase is refused through one door and funded through the other,
 * and the advice has to know which door it is standing in.
 */
describe("the advice knows whether this invocation rebalances (#330)", () => {
  test("under `run auto`'s default, a shortfall finished phases cover is not called a refusal", async () => {
    const ws = workspace();
    await finishAlphaWithSlack(ws);
    starve(ws, "02-how", 2);

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws, { rebalanceFinished: true, at: "2026-09-15T10:30:00Z" });
    expect(failed.code).toBe(5);

    const said = advice(failed.lines);
    expect(said).not.toContain("would be refused on arrival");
    expect(said).toContain("phase 02-how has $1.58 left");
    expect(said).toContain("$0.42 short");
    // Named: where the money comes from, and that this loop moves it itself.
    expect(said).toContain("01-what");
    expect(said).toContain("--rebalance-finished");
    // …and that a bare `tldrx next` is NOT that door.
    expect(said).toContain("`tldrx next` alone never rebalances");

    // The control the first version lacked: the relaunch really does fund it.
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_IS_ERROR: "", FAKE_CLAUDE_COST: "0.30" });
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    const retried = await next(ws, { rebalanceFinished: true, at: "2026-09-15T11:00:00Z" });
    expect(retried.code).not.toBe(2);
    expect(retried.lines.join("\n")).not.toContain("refusing to start stage");
  });

  test("through a bare `tldrx next`, the same shortfall IS a refusal — and the advice says which door funds it", async () => {
    const ws = workspace();
    await finishAlphaWithSlack(ws);
    starve(ws, "02-how", 2);

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws, { at: "2026-09-15T10:30:00Z" });
    expect(failed.code).toBe(5);

    const said = advice(failed.lines);
    expect(said).toContain("`tldrx next` would be refused on arrival (exit 2, the money family)");
    expect(said).toContain("phase 02-how has $1.58 left");
    // The cheaper remedy is still named, because it exists on this run.
    expect(said).toContain("run auto --rebalance-finished");
    expect(said).toContain("01-what");

    // Both halves of that claim, measured: bare `next` refuses…
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_IS_ERROR: "", FAKE_CLAUDE_COST: "0.30" });
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    const bare = await next(ws, { at: "2026-09-15T11:00:00Z" });
    expect(bare.code).toBe(2);
    // …and the same command with the rebalance on does not.
    const looped = await next(ws, { rebalanceFinished: true, at: "2026-09-15T11:30:00Z" });
    expect(looped.code).not.toBe(2);
  });

  test("a shortfall NO finished phase can cover is a refusal through either door", async () => {
    const ws = workspace();
    await finishAlphaWithSlack(ws);
    // $0.20 of donor slack against a shortfall of $0.42 — `planRebalance` moves
    // nothing rather than moving part of it. `02-how` still holds its full
    // $2.00 on entry, so the stage RUNS and dies; only the retry is short.
    starve(ws, "01-what", 0.62);
    starve(ws, "02-how", 2);

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws, { rebalanceFinished: true, at: "2026-09-15T10:30:00Z" });
    expect(failed.code).toBe(5);

    const said = advice(failed.lines);
    expect(said).toContain("`tldrx next` would be refused on arrival (exit 2, the money family)");
    expect(said).toContain("phase 02-how has $1.58 left");
    expect(said).toContain("$0.42 short");
    // How short it still is with every donor's money, rather than a bare "no".
    expect(said).toContain("short of the $0.42 shortfall even with all of it");

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_IS_ERROR: "", FAKE_CLAUDE_COST: "0.30" });
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    const retried = await next(ws, { rebalanceFinished: true, at: "2026-09-15T11:00:00Z" });
    expect(retried.code).toBe(2);
  });
});

/**
 * The two economies this gate does not decide, tested through the in-session
 * cycle because both are refused before the stage even runs in headless mode —
 * `economyRefusal` and `attendedRefusal` sit above the executor. Each phase here
 * is starved BELOW its stage's estimate, so a missing guard would print the
 * refusal prediction and the assertion would go red.
 */
describe("the silent paths are silent because it is not this gate's call", () => {
  /** A host turn that claims its outputs and writes none — `validateOutputs` fails the stage. */
  function writeEmptyResult(ws: FacilitatorWorkspace, stageId: string, outputs: readonly string[]): void {
    writeFileSync(
      join(ws.runDir, ".agent", stageId, "result.json"),
      JSON.stringify({ outputs, questions_asked: [], notes: "host turn", cost_usd: 0 }),
      "utf8",
    );
  }

  async function failThroughTheHost(ws: FacilitatorWorkspace): Promise<readonly string[]> {
    const prepared = await next(ws, { mode: "prepare" });
    expect(prepared.code).toBe(0);
    writeEmptyResult(ws, "alpha", ["01-what/intent.md", "01-what/handoff.md"]);
    const committed = await next(ws, { mode: "commit", at: "2026-09-15T10:30:00Z" });
    expect(committed.code).toBe(5);
    return committed.lines;
  }

  test("a `host-tokens` phase gets the plain advice — its ceiling is not dollars to compare", async () => {
    const ws = workspace();
    starve(ws, "01-what", 2, "host-tokens");
    expect(advice(await failThroughTheHost(ws))).toBe(PLAIN);
  });

  test("an `attended_by: host` run gets the plain advice — this brake never denies it", async () => {
    const ws = workspace();
    starve(ws, "01-what", 2);
    const attended = attendRun({
      root: ws.root, runId: ws.runId, attendedBy: "host", actor: "alan", at: "2026-09-15T09:00:00Z",
    });
    expect(attended.code).toBe(0);
    expect(advice(await failThroughTheHost(ws))).toBe(PLAIN);
  });
});
