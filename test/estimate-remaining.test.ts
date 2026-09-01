/**
 * `tldrx run estimate` is remaining-work aware (issue #21).
 *
 * The gap the issue names: `run estimate` priced the NEXT STAGE from token
 * medians while the budget brake separately computed what a stage still had left
 * to pay for (`core/budget/remainingWork.ts`, landed with #22). Two models, one
 * question — and the estimate was the one that never shrank. A Build stage with
 * five of six stories done was still quoted at the number the Plan wrote before
 * any of them ran, which is exactly the figure that made an operator move money
 * twice on the 2026-08-30/31 pilot for work the run could already afford.
 *
 * These tests hold `estimateNextStage` to the unified story:
 *
 *   - the stage-level remaining figure is the SAME function the brake and
 *     `budget show` call, so the three can never disagree;
 *   - finishing stories makes it go DOWN, and blocked stories are named rather
 *     than silently counted;
 *   - the run-level roll-up excludes stages that are already terminal;
 *   - the token half of the report is untouched — it was measured, and this issue
 *     is not about it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { estimateNextStage, renderEstimate } from "../src/core/budget/estimateView.ts";
import { remainingWork } from "../src/core/budget/remainingWork.ts";
import { economyFor } from "../src/core/budget/RunBudget.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

let open: BuildWorkspace[] = [];
let plain: TempRunWorkspace[] = [];

afterEach(() => {
  for (const ws of open) ws.dispose();
  for (const ws of plain) ws.dispose();
  open = [];
  plain = [];
});

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  return made;
}

/** Three stories in one wave — the shape the pilot's Build stage had. */
function threeStories(statuses: readonly (string | undefined)[]): BuildWorkspaceOptions {
  const ids = ["S1", "S2", "S3"];
  return {
    stories: ids.map((id, i) => ({
      id, epic: "E1", title: `Story ${id}`,
      ...(statuses[i] === undefined ? {} : { status: statuses[i] as string }),
    })),
    epics: [{ id: "E1", stories: ids, branch: "epic/e1" }],
    waves: [ids],
    budgetUsd: 18,
  };
}

describe("run estimate, remaining-work aware", () => {
  test("a Build stage with a plan is priced off the stories that are LEFT", () => {
    const ws = workspace(threeStories([undefined, undefined, undefined]));
    const estimate = estimateNextStage(ws.root, ws.runId);
    expect(estimate.stage).toBe("build");
    expect(estimate.remaining.basis).toBe("plan");
    expect(estimate.remaining.total).toBe(3);
    expect(estimate.remaining.done).toBe(0);
    expect(estimate.remaining.usd).toBeGreaterThan(0);
  });

  test("it is the SAME number the budget brake computes — one model, not two", () => {
    const ws = workspace(threeStories([undefined, undefined, undefined]));
    const estimate = estimateNextStage(ws.root, ws.runId);
    const store = RunStore.open(ws.runDir);
    const stage = store.run.phases.flatMap((p) => p.stages).find((s) => s.id === "build");
    const direct = remainingWork({
      runDir: ws.runDir,
      phaseId: "04-build",
      stageBudgetUsd: stage?.budget_usd ?? 0,
      stageSpentUsd: stage?.cost_usd ?? 0,
      perAgentMaxUsd: store.budget.per_agent_max_usd,
      maxUsd: null,
      economy: economyFor(store.budget, "04-build"),
    });
    expect(estimate.remaining.usd).toBe(direct.usd);
    expect(estimate.remaining.rawUsd).toBe(direct.rawUsd);
    expect(estimate.remaining.staticUsd).toBe(direct.staticUsd);
  });

  test("done stories are excluded: the estimate goes DOWN as the stage progresses", () => {
    const fresh = estimateNextStage(
      workspace(threeStories([undefined, undefined, undefined])).root,
      open[0]?.runId,
    );
    const late = estimateNextStage(
      workspace(threeStories(["done", "done", undefined])).root,
      open[1]?.runId,
    );
    expect(late.remaining.done).toBe(2);
    expect(late.remaining.total).toBe(3);
    expect(late.remaining.usd).toBeLessThan(fresh.remaining.usd);
    expect(late.remaining.usd).toBeLessThan(late.remaining.staticUsd);
  });

  test("a blocked story is named, not silently counted", () => {
    const ws = workspace(threeStories(["done", "blocked", undefined]));
    const estimate = estimateNextStage(ws.root, ws.runId);
    expect(estimate.remaining.blocked).toEqual(["S2"]);
    const text = renderEstimate(estimate);
    expect(text).toContain("S2");
    expect(text).toContain("blocked");
  });

  test("the report says what is left, and shows the arithmetic", () => {
    const ws = workspace(threeStories(["done", undefined, undefined]));
    const text = renderEstimate(estimateNextStage(ws.root, ws.runId));
    expect(text).toContain("remaining work:");
    expect(text).toContain("1 of 3 stories done");
    // The token half is untouched — it was measured, and this issue is not about it.
    expect(text).toContain("input tokens");
  });

  test("the run-level roll-up counts only the stages still to run", () => {
    const ws = makeRunWorkspace();
    plain.push(ws);
    const created = createRun({
      root: ws.root, slug: "leaderboard", scope: "feature", actor: "alan",
      now: new Date("2026-08-29T09:00:00Z"),
    });

    const before = estimateNextStage(ws.root, created.runId);
    expect(before.runRemaining.stages.length).toBe(5);
    expect(before.runRemaining.done).toBe(0);
    expect(before.runRemaining.staticUsd).toBeGreaterThan(0);

    // Finish the first stage and move the cursor on, exactly as `approve` does.
    const store = RunStore.open(created.runDir);
    const first = store.run.cursor.stage;
    const next = store.nextEntry();
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) => (stage.id === first ? { ...stage, status: "done" as const } : stage)),
      })),
      cursor: next === null
        ? run.cursor
        : { phase: next.phase.id, stage: next.stage.id, task: null },
    }));
    store.save();

    const after = estimateNextStage(ws.root, created.runId);
    expect(after.runRemaining.stages.length).toBe(4);
    expect(after.runRemaining.done).toBe(1);
    expect(after.runRemaining.staticUsd).toBeLessThan(before.runRemaining.staticUsd);
    expect(after.runRemaining.stages).not.toContain(`01-what/${first}`);
  });

  test("a stage with no plan keeps the static basis, and says so rather than inventing one", () => {
    const ws = makeRunWorkspace();
    plain.push(ws);
    const created = createRun({
      root: ws.root, slug: "leaderboard", scope: "feature", actor: "alan",
      now: new Date("2026-08-29T09:00:00Z"),
    });
    const estimate = estimateNextStage(ws.root, created.runId);
    expect(estimate.remaining.basis).toBe("static");
    expect(estimate.remaining.usd).toBe(estimate.remaining.staticUsd);
    const text = renderEstimate(estimate);
    expect(text).not.toContain("remaining work:");
    expect(text).toContain("still to run");
  });
});
