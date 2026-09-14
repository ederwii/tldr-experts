/**
 * gh #305, the process half: "cancelled wins" must win the PROCESS, not only the
 * file. A `run cancel --force` that lands while a Build stage is mid-fan-out has
 * to stop the next spawn — otherwise `run.yml` says `cancelled` while a
 * developer keeps spending, which is a record lying in the expensive direction.
 *
 * The real dispatch, the real fake agent: two stories in one wave, and the FIRST
 * story's dod command is a forced `cancelRun` (`fixtures/build/cancelFromDod.ts`).
 * After it, nothing may be spawned: not S1's reviewer, not S2's developer.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here spawns real processes (git, the fake claude, the dod command);
// the budget scales with measured load, as in build-parallel.test.ts.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const CANCEL_FROM_DOD = join(FRAMEWORK_ROOT, "test", "fixtures", "build", "cancelFromDod.ts");

let open: BuildWorkspace[] = [];
afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_BUILD_STATE;
  for (const ws of open) ws.dispose();
  open = [];
});

function spawned(ws: BuildWorkspace): readonly { story: unknown; role: unknown }[] {
  return EventLog.forRun(ws.runDir).read()
    .filter((e) => e.type === "agent.spawned")
    .map((e) => ({ story: e.payload.story, role: e.payload.role }));
}

describe("a forced `run cancel` mid-Build stops the next spawn (#305)", () => {
  test("after the cancel lands in S1's dod, neither S1's reviewer nor S2's developer is spawned, and the invocation reports the cancel", async () => {
    const ws = makeBuildWorkspace({
      stories: [
        { id: "S1", epic: "E1", title: "First" },
        { id: "S2", epic: "E1", title: "Second" },
      ],
      epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
      waves: [["S1", "S2"]],
      // `npm run test` (the default dod) runs this: the forced cancel.
      testScript: `${JSON.stringify(process.execPath)} ${JSON.stringify(CANCEL_FROM_DOD)}`,
    });
    open.push(ws);
    process.env.PATH = ws.binDir;
    process.env.FAKE_BUILD_STATE = ws.statePath;

    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z",
    });

    // Exactly ONE spawn: S1's developer, which ran before its dod cancelled the run.
    expect(spawned(ws)).toEqual([{ story: "S1", role: "developer" }]);
    const run = RunStore.open(ws.runDir).run;
    expect(run.status).toBe("cancelled");
    expect(run.cancelled).toMatchObject({ note: "operator cancel from a dod command" });
    // The turn that happened is in the ledger, and the stage keeps the cancel's status.
    const build = run.phases.flatMap((p) => p.stages).find((s) => s.id === "build")!;
    expect(build.tasks.length).toBeGreaterThanOrEqual(1);
    expect(build.status).toBe("cancelled");
    // Same exit the existing cancelled path uses — 0, "nothing to advance" — and the
    // lines say the run was cancelled under this stage rather than "gate pending".
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("cancelled");
    expect(outcome.lines.join("\n")).not.toContain("gate pending");
    // S1 parked where an unjudged, merged diff parks: `review`, with the cancel named.
    expect(outcome.lines.join("\n")).toContain("S1 → `review` (the run was cancelled");
    expect(outcome.lines.join("\n")).toContain("S2: not started — the run was cancelled");
  });
});
