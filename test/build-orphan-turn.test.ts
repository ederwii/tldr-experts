/**
 * gh #337, the remaining scope: the headless-orphan fix (`demoteStaleRunning`,
 * `runNext.ts`) deliberately excludes every Build-executor phase
 * (`executorFor(phase.id) !== null`) — the shipped comment on #337 calls that
 * carve-out justified because Build phases "already get orphan accounting
 * through `costView.ts`'s open/lost slot tracking", but flags it as NOT
 * independently live-tested. That slot tracking (`storyLedger`) feeds
 * `phaseCost.ts`'s PER-STORY ceiling view — a different question from whether
 * `run.yml`'s own `tasks[]` (what `tallyOf`/`spendBasisOf`, and so
 * `budget.spent_usd`, actually sum) ever gets a row for the abandoned attempt.
 *
 * The orphaned state itself is SIMULATED, not a real kill — the same technique
 * the merged headless #337 test uses (`test/facilitator.test.ts:551-589`): a
 * `.lock` holding a dead pid, plus a synthetic `agent.spawned` event with no
 * `agent.result` after it. No process is spawned and killed here to produce
 * that state. The RESUME half that follows it, though, is the real algorithm
 * against real processes (git, the fake claude) via the Build fixture, like
 * every other `build-*.test.ts` file — `machine-load.test.ts`'s spawn budget
 * already counts this family.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
let open: BuildWorkspace[] = [];
afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_BUILD_STATE;
  for (const ws of open) ws.dispose();
  open = [];
});

function buildStage(ws: BuildWorkspace) {
  return RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages).find((s) => s.id === "build")!;
}

describe("a killed parent's orphaned Build turn (#337, remaining scope)", () => {
  test("the abandoned story attempt banks its cost as absent, not omitted", async () => {
    const ws = makeBuildWorkspace({
      stories: [{ id: "S1", epic: "E1", title: "First" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
    });
    open.push(ws);

    // Simulate — not spawn-and-kill — the state a real SIGKILL of the parent
    // would leave: `running`, with an `agent.spawned` for S1's developer that
    // no `agent.result` has answered. Same technique the merged headless
    // #337 test uses (`facilitator.test.ts:551-589`): fabricate the `.lock`
    // and the ledger, never actually spawn and kill a process. In the field
    // (#246/#337's own case) a live `claude` may still be running to
    // completion independently while this state sits on disk.
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
      ts: "2026-09-17T09:00:00Z", run: ws.runId, stage: "build", type: "agent.spawned",
      actor: "alan", cost_usd: 0,
      payload: { phase: "04-build", story: "S1", role: "developer", model: "sonnet", max_budget_usd: 3 },
    });
    const deadPid = 4194302;
    writeFileSync(join(ws.runDir, ".lock"), JSON.stringify({ pid: deadPid, at: "2026-09-17T08:59:59Z" }), "utf8");

    process.env.PATH = ws.binDir;
    process.env.FAKE_BUILD_STATE = ws.statePath;

    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: "2026-09-17T09:01:00Z",
    });
    // 4 == "gate pending": the story ran to completion and awaits a human
    // `tldrx approve` (no `gates: "none"` in this fixture) — a normal, healthy
    // resume, not a refusal. What matters is what `run.yml` recorded on the way.
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("done");

    const build = buildStage(ws);
    // Today: the resumed run just spawns S1 fresh and finishes it — the
    // abandoned attempt leaves NO row at all in `run.yml`, so `tallyOf` never
    // even gets the chance to call it unmetered; it is simply invisible.
    const orphanRows = build.tasks.filter((t) => t.metered === false && t.cost_usd === null);
    expect(orphanRows.length).toBeGreaterThanOrEqual(1);
    expect(outcome.lines.join("\n")).toContain("orphaned turn");
  });
});
