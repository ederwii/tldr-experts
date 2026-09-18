/**
 * gh #357 — a Build story's `ExecutorTask` rows never copied
 * `AgentOutcome.failureKind` across, so a Build developer or reviewer turn
 * that died with a classifiable cause (gh #348) left no `failure_kind` on its
 * `run.yml` row — even though the field audit that MEASURED #348's own
 * population (24 of 54 failed tasks, 44%, one workspace) was drawn from a
 * live Build session. `ExecutorTask.failureKind` and its
 * `recordExecutorTasks` mapping already existed (`executors/index.ts`,
 * `runNext.ts`); the four `this.tasks.push` sites in `executors/build.ts`
 * were the only thing not copying it.
 *
 * This test exercises the spawned-developer push site (`spawnDeveloper`,
 * `executors/build.ts`): a developer that dies with a non-zero exit and no
 * parseable envelope (the real CLI shape a `--max-budget-usd` kill produces)
 * earns `failure_kind: "non_zero_exit"` on its `run.yml` row — where before
 * this fix the key was silently absent although `.error` already carried the
 * same cause in prose.
 *
 * MEASURED (debugging this test): a developer transport failure PARKS the
 * story at `status: "todo"` and moves the Build stage straight to
 * `awaiting_gate` within the SAME invocation — it does not loop to a second
 * attempt the way gh #364's `asked_no_diff` does. So this is a single
 * `next()` call, one row.
 *
 * Reuses the shared Build fake (`test/fixtures/build/fakeClaude.ts`, built
 * on the ONE emitter `fakeTranscript.ts`/`fakeStream.ts` — AGENTS.md §8): a
 * real process spawn, not a second fake.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_FAIL", "FAKE_BUILD_COST", "FAKE_BUILD_STATE"] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function one(extra: Partial<BuildWorkspaceOptions> = {}): BuildWorkspaceOptions {
  return {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
    ...extra,
  };
}

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  process.env.FAKE_BUILD_COST = "0";
  return made;
}

async function next(ws: BuildWorkspace): Promise<number> {
  const outcome = await runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-09-18T09:00:00Z",
  });
  return outcome.code;
}

/** Every recorded task row of the Build stage, in `run.yml` order. */
function taskRows(ws: BuildWorkspace): readonly Record<string, unknown>[] {
  const store = RunStore.open(ws.runDir);
  const rows: Record<string, unknown>[] = [];
  for (const phase of store.run.phases) {
    for (const stage of phase.stages) {
      for (const task of stage.tasks) rows.push(task as unknown as Record<string, unknown>);
    }
  }
  return rows;
}

describe("#357 · a Build story's task rows carry the spawned turn's failure_kind", () => {
  test("a developer that dies non-zero earns failure_kind: non_zero_exit on its run.yml row", async () => {
    const ws = workspace(one());
    process.env.FAKE_BUILD_FAIL = "developer:S1#1";

    await next(ws);

    const rows = taskRows(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.role).toBe("developer");
    expect(String(rows[0]?.error ?? "")).toContain("Reached maximum budget");
    expect(rows[0]?.failure_kind).toBe("non_zero_exit");
  });
});
