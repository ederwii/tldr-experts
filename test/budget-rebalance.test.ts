/**
 * gh #314 — which phases hold ceiling that is PROVABLY unspendable, and how much of it a
 * blocked phase may take.
 *
 * Pure: a `RunBudget` and a `RunFile` in, a plan out. Nothing here spawns or writes, so this
 * file adds no `machine-load` row. The loop half — `run auto --rebalance-finished` actually
 * moving the money, and refusing when it cannot — is in `test/run-auto-until-done.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { asRunBudget, type RunBudget } from "../src/core/budget/RunBudget.ts";
import { applyRebalance, planRebalance } from "../src/core/budget/rebalance.ts";
import { asRunFile, type RunFile } from "../src/core/run/RunFile.ts";

interface TaskShape { readonly cost: number | null; readonly metered?: boolean }

function stage(
  id: string,
  status: string,
  tasks: readonly TaskShape[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id, status, expert: null, model: null, budget_usd: 4,
    cost_usd: tasks.reduce((sum, t) => sum + (t.metered === false ? 0 : t.cost ?? 0), 0),
    started_at: null, ended_at: null, inputs: [], outputs: [],
    gate: status === "done"
      ? { type: "approve", status: "approved", by: "auto", at: "2026-09-14T18:00:00Z", note: "" }
      : { type: "approve", status: "pending", by: null, at: null, note: "" },
    tasks: tasks.map((t, i) => ({
      id: `t${String(i + 1)}`, status: "done", expert: null, model: null, cost_usd: t.cost,
      ...(t.metered === false ? { metered: false } : {}),
      input_tokens: 0, output_tokens: 0, error: null, session_id: null,
    })),
    ...extra,
  };
}

function run(phases: readonly Record<string, unknown>[]): RunFile {
  return asRunFile({
    version: 1, run: "260914-ui-chat-first", title: "t", scope: "feature", workflow: "feature",
    repos: ["api"], created_at: null, updated_at: "2026-09-14T18:09:01Z", status: "ready",
    cursor: { phase: "04-build", stage: "build", task: null },
    budget: { ceiling_usd: 180, spent_usd: 0, per_agent_max_usd: 3 },
    phases,
  });
}

function budget(
  phases: readonly { id: string; ceiling_usd: number; spent_usd: number; economy?: string }[],
  extra: Record<string, unknown> = {},
): RunBudget {
  return asRunBudget({
    version: 1, run: "260914-ui-chat-first", ceiling_usd: 180, per_agent_max_usd: 30,
    warn_at_pct: 80, on_exceed: "block", phases, ...extra,
  });
}

/** The issue's own shape: 01-what finished $16.25 under, 04-build $11.07 short, 05-watch still to run. */
const FIELD_RUN = run([
  { id: "01-what", status: "done", stages: [stage("what", "done", [{ cost: 3.75 }])] },
  { id: "02-how", status: "done", stages: [stage("how", "done", [{ cost: 20 }])] },
  { id: "03-plan", status: "done", stages: [stage("plan", "done", [{ cost: 15.21 }])] },
  { id: "04-build", status: "ready", stages: [stage("build", "ready")] },
  { id: "05-watch", status: "pending", stages: [stage("watch", "pending")] },
]);
const FIELD_BUDGET = budget([
  { id: "01-what", ceiling_usd: 20, spent_usd: 3.75 },
  { id: "02-how", ceiling_usd: 20, spent_usd: 20 },
  { id: "03-plan", ceiling_usd: 15.21, spent_usd: 15.21 },
  { id: "04-build", ceiling_usd: 78.73, spent_usd: 0 },
  { id: "05-watch", ceiling_usd: 46.06, spent_usd: 0 },
]);

describe("which phases count as finished (gh #314)", () => {
  test("the field case: 01-what's unspent covers 04-build's shortfall, and exactly the shortfall moves", () => {
    const plan = planRebalance(FIELD_BUDGET, FIELD_RUN, "04-build", 11.07);
    expect(plan.moves).toEqual([{ takeFrom: "01-what", amountUsd: 11.07 }]);
    expect(plan.finishedUnspentUsd).toBe(16.25);
    expect(plan.uncoveredUsd).toBe(0);
  });

  test("a phase with a stage still to run is never a donor — 05-watch holds $46.06 and gives none of it", () => {
    const plan = planRebalance(FIELD_BUDGET, FIELD_RUN, "04-build", 40);
    expect(plan.moves).toEqual([]);
    expect(plan.donors.map((d) => d.phaseId)).toEqual(["01-what"]);
    const watch = plan.excluded.find((e) => e.phaseId === "05-watch");
    expect(watch?.reason).toContain("watch");
    expect(watch?.reason).toContain("pending");
    // How short, said as a number — not "insufficient".
    expect(plan.uncoveredUsd).toBe(23.75);
  });

  test("a finished phase with nothing left gives nothing, and says so rather than disappearing", () => {
    const plan = planRebalance(FIELD_BUDGET, FIELD_RUN, "04-build", 1);
    const how = plan.excluded.find((e) => e.phaseId === "02-how");
    expect(how?.reason).toContain("no unspent ceiling");
  });

  test("a phase whose spend is a LOWER BOUND (an unmetered turn) is not provably unspent", () => {
    const r = run([
      { id: "01-what", status: "done", stages: [stage("what", "done", [{ cost: null, metered: false }])] },
      { id: "04-build", status: "ready", stages: [stage("build", "ready")] },
    ]);
    const b = budget([{ id: "01-what", ceiling_usd: 20, spent_usd: 0 }, { id: "04-build", ceiling_usd: 5, spent_usd: 0 }]);
    const plan = planRebalance(b, r, "04-build", 2);
    expect(plan.moves).toEqual([]);
    expect(plan.excluded.find((e) => e.phaseId === "01-what")?.reason).toContain("unmetered");
  });

  test("a stale stage (an earlier gate revoked) will run again, so its phase is not finished", () => {
    const r = run([
      { id: "01-what", status: "done", stages: [stage("what", "done", [{ cost: 1 }], { stale: true })] },
      { id: "04-build", status: "ready", stages: [stage("build", "ready")] },
    ]);
    const b = budget([{ id: "01-what", ceiling_usd: 20, spent_usd: 1 }, { id: "04-build", ceiling_usd: 5, spent_usd: 0 }]);
    const plan = planRebalance(b, r, "04-build", 2);
    expect(plan.moves).toEqual([]);
    expect(plan.excluded.find((e) => e.phaseId === "01-what")?.reason).toContain("stale");
  });

  test("a host-tokens phase is not dollars, so it is never a donor", () => {
    const r = run([
      { id: "01-what", status: "done", stages: [stage("what", "done", [{ cost: 1 }])] },
      { id: "04-build", status: "ready", stages: [stage("build", "ready")] },
    ]);
    const b = budget([
      { id: "01-what", ceiling_usd: 20, spent_usd: 1, economy: "host-tokens" },
      { id: "04-build", ceiling_usd: 5, spent_usd: 0 },
    ]);
    const plan = planRebalance(b, r, "04-build", 2);
    expect(plan.moves).toEqual([]);
    expect(plan.excluded.find((e) => e.phaseId === "01-what")?.reason).toContain("host-tokens");
  });

  test("skipped stages finish a phase; a failed one does not", () => {
    const r = run([
      { id: "01-what", status: "skipped", stages: [stage("what", "skipped")] },
      { id: "02-how", status: "failed", stages: [stage("how", "failed", [{ cost: 1 }])] },
      { id: "04-build", status: "ready", stages: [stage("build", "ready")] },
    ]);
    const b = budget([
      { id: "01-what", ceiling_usd: 3, spent_usd: 0 },
      { id: "02-how", ceiling_usd: 10, spent_usd: 1 },
      { id: "04-build", ceiling_usd: 5, spent_usd: 0 },
    ]);
    const plan = planRebalance(b, r, "04-build", 2);
    expect(plan.donors.map((d) => d.phaseId)).toEqual(["01-what"]);
    expect(plan.moves).toEqual([{ takeFrom: "01-what", amountUsd: 2 }]);
  });

  test("several donors, in run order, each giving at most what it has left", () => {
    const r = run([
      { id: "01-what", status: "done", stages: [stage("what", "done", [{ cost: 1 }])] },
      { id: "02-how", status: "done", stages: [stage("how", "done", [{ cost: 1 }])] },
      { id: "04-build", status: "ready", stages: [stage("build", "ready")] },
    ]);
    const b = budget([
      { id: "01-what", ceiling_usd: 2.5, spent_usd: 1 },
      { id: "02-how", ceiling_usd: 4, spent_usd: 1 },
      { id: "04-build", ceiling_usd: 5, spent_usd: 0 },
    ]);
    const plan = planRebalance(b, r, "04-build", 3);
    expect(plan.moves).toEqual([
      { takeFrom: "01-what", amountUsd: 1.5 },
      { takeFrom: "02-how", amountUsd: 1.5 },
    ]);
  });
});

describe("applying a plan goes through raiseBudget, and never grows the run ceiling", () => {
  test("the field case: 04-build +11.07, 01-what −11.07, run ceiling $180 before and after", () => {
    const plan = planRebalance(FIELD_BUDGET, FIELD_RUN, "04-build", 11.07);
    const applied = applyRebalance(FIELD_BUDGET, plan);
    expect(applied.budget.ceiling_usd).toBe(180);
    expect(applied.budget.phases.find((p) => p.id === "04-build")?.ceiling_usd).toBe(89.8);
    expect(applied.budget.phases.find((p) => p.id === "01-what")?.ceiling_usd).toBe(8.93);
    expect(applied.outcomes).toHaveLength(1);
    expect(applied.outcomes[0]).toMatchObject({
      phaseId: "04-build", takeFrom: "01-what", amountUsd: 11.07,
      phaseCeilingBefore: 78.73, phaseCeilingAfter: 89.8,
      takeFromCeilingBefore: 20, takeFromCeilingAfter: 8.93,
      runCeilingBefore: 180, runCeilingAfter: 180, runCeilingGrew: false,
    });
  });

  test("an uncovered plan applies nothing", () => {
    const plan = planRebalance(FIELD_BUDGET, FIELD_RUN, "04-build", 40);
    const applied = applyRebalance(FIELD_BUDGET, plan);
    expect(applied.outcomes).toEqual([]);
    expect(applied.budget).toBe(FIELD_BUDGET);
  });
});
