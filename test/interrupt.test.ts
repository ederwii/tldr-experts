/**
 * `src/core/facilitator/interrupt.ts` — what a SIGINT/SIGTERM leaves behind for
 * the turn it killed mid-flight (gh #355).
 *
 * No test exercised this file before now (`grep -rl
 * "recordPartialResult|runInterruptHooks" test/` returned nothing) — this is
 * the first. Only the RECORDING half is under test here: `stopInFlightRun` is
 * called directly, in-process, on a run staged exactly the way a real Ctrl-C
 * would leave one (a `running` stage with an `agent.spawned` no `agent.result`
 * has answered). No process is spawned, so this file needs no
 * `machine-load.test.ts` guard row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stopInFlightRun } from "../src/core/facilitator/interrupt.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { tallyOf } from "../src/core/budget/spentFigure.ts";
import { spendBasisOf } from "../src/core/budget/spendBasis.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";

let open: FacilitatorWorkspace[] = [];
afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

const ONE_STAGE = [
  {
    id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto" as const,
    outputs: [{ path: "01-what/intent.md", sections: ["Intent"] }],
  },
];

function workspace(): FacilitatorWorkspace {
  const ws = makeFacilitatorWorkspace({ scope: "demo", stages: ONE_STAGE, budgetUsd: 10 });
  open.push(ws);
  return ws;
}

/** Put `alpha` in exactly the state a real Ctrl-C mid-turn leaves it: `running`,
 * with an `agent.spawned` no `agent.result` has closed. */
function midTurn(ws: FacilitatorWorkspace): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase, i) => (i !== 0 ? phase : {
      ...phase,
      stages: phase.stages.map((stage, j) => (j !== 0 ? stage : { ...stage, status: "running" as const })),
    })),
  }));
  store.save();
  EventLog.forRun(ws.runDir).append({
    ts: "2026-09-17T09:00:00Z", run: ws.runId, stage: "alpha", type: "agent.spawned",
    actor: "alan", cost_usd: 0, payload: { phase: "01-what", task: "t1" },
  });
}

describe("a SIGINT/SIGTERM partial result (#355)", () => {
  test("the killed turn's task row is unmetered-absent, never a measured $0.00", () => {
    const ws = workspace();
    midTurn(ws);

    const lines = stopInFlightRun(ws.runDir, {
      signal: "SIGINT", killed: 1, actor: "alan", at: "2026-09-17T09:00:05Z",
    });
    expect(lines.join("\n")).toContain("recorded a partial agent.result");

    const store = RunStore.open(ws.runDir);
    const alpha = store.run.phases[0]?.stages[0];
    expect(alpha?.tasks).toHaveLength(1);
    const task = alpha?.tasks[0];
    expect(task?.status).toBe("failed");
    // This is the bug: today `cost_usd` is `0` with no `metered` key, which
    // `tallyOf` cannot tell apart from a real, measured $0.00 turn.
    expect(task?.cost_usd).toBeNull();
    expect(task?.metered).toBe(false);

    // The event payload should carry the same named field, not just a null value.
    const result = EventLog.forRun(ws.runDir).read().find((e) => e.type === "agent.result");
    expect(result?.payload.metered).toBe(false);

    // Downstream readers must count this as UNMETERED, not as $0 metered.
    const tally = tallyOf(store.run.phases[0]!.stages[0]!.tasks);
    expect(tally.unmetered).toBe(1);
    expect(tally.usd).toBe(0);

    const basis = spendBasisOf(
      store.run.phases[0]!.stages[0]!.tasks.map((t) => ({
        costUsd: t.cost_usd, metered: t.metered !== false, tokens: null,
      })),
      0,
    );
    expect(basis.basis).not.toBe("measured");

    // `budget.yml` should carry the same lower-bound story `unmetered_tasks`
    // already tells for the headless orphan case (#337).
    const budgetText = readFileSync(join(ws.runDir, "budget.yml"), "utf8");
    expect(budgetText).toContain("unmetered_tasks: 1");
  });
});
