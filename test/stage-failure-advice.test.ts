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
 * The prediction is deliberately made with the GATE's OWN arithmetic
 * (`remaining` vs `stageRemainingWork`, the two figures `budgetRefusal` compares),
 * never with a fresh estimate of its own: whatever bias those figures carry on a
 * partly-unmetered run, the retry is refused on exactly the comparison this line
 * reports, so the two can never disagree.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
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
 * Shrink `01-what` to the pre-#170 shape: a ceiling that holds exactly ONE
 * attempt of its stage. This is not a hypothetical — it is what `run new` wrote
 * before 2026-09-09, and nothing migrates it.
 */
function sizeForOneAttempt(ws: FacilitatorWorkspace, phaseId: string, ceilingUsd: number): void {
  const store = RunStore.open(ws.runDir);
  store.mutateBudget((budget) => ({
    ...budget,
    phases: budget.phases.map((phase) => (phase.id === phaseId ? { ...phase, ceiling_usd: ceilingUsd } : phase)),
  }));
  store.save();
}

const ADVICE = (lines: readonly string[]): string =>
  lines.find((line) => line.startsWith("cost is recorded, not refunded")) ?? "<no advice line>";

describe("a stage death does not recommend a retry the budget will refuse (gh #232)", () => {
  test("the advice names the shortfall and the raise, not `tldrx next`", async () => {
    const ws = workspace();
    sizeForOneAttempt(ws, "01-what", 3);

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws);
    expect(failed.code).toBe(5);

    const advice = ADVICE(failed.lines);
    // The money is still not refunded — that half of the sentence is unconditional.
    expect(advice).toContain("cost is recorded, not refunded");
    // …and the retry is named as refused, with BOTH figures and the family it
    // would come back on, so the operator never has to spend the round trip.
    expect(advice).toContain("`tldrx next` would be refused on arrival (exit 2, the money family)");
    expect(advice).toContain("phase 01-what has $2.58 left");
    expect(advice).toContain("the retry is priced at $3.00");
    expect(advice).toContain("$0.42 short");
    expect(advice).toContain("tldrx budget raise 01-what 0.42");
    expect(advice).toContain("tldrx reject");

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

    const advice = ADVICE(failed.lines);
    expect(advice).toBe('cost is recorded, not refunded — retry with `tldrx next`, or `tldrx reject --note "…"`');

    // Same control in the other direction: the retry is genuinely allowed here.
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_IS_ERROR: "", FAKE_CLAUDE_COST: "0.30" });
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    const retried = await next(ws, { at: "2026-09-15T10:30:00Z" });
    expect(retried.code).not.toBe(2);
  });

  test("`on_exceed: warn` never refuses, so the advice is not rewritten for it", async () => {
    const ws = workspace();
    sizeForOneAttempt(ws, "01-what", 3);
    const store = RunStore.open(ws.runDir);
    store.mutateBudget((budget) => ({ ...budget, on_exceed: "warn" as const }));
    store.save();

    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws);
    expect(failed.code).toBe(5);
    expect(ADVICE(failed.lines)).toContain("retry with `tldrx next`");
    expect(ADVICE(failed.lines)).not.toContain("would be refused");
  });

  test("the failure SIGNATURE is still the failure's own sentence, not the advice (gh #297)", async () => {
    const ws = workspace();
    sizeForOneAttempt(ws, "01-what", 3);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws) as { code: number; lines: readonly string[]; signature?: string };
    expect(failed.signature).toContain("01-what/alpha failed:");
    expect(failed.signature).not.toContain("cost is recorded");
  });
});
