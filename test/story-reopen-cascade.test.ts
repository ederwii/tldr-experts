/**
 * `tldrx story reopen <dep>` releases the dependents that were blocked ONLY by
 * that dependency (#312).
 *
 * Measured three times in one day on a live run: S2–S4 sat `blocked` with
 * `dependency S<n> blocked`, and reopening the blocked dependency moved none of
 * them — every dependent needed its own `story reopen`. The reason each one
 * recorded became stale the instant its dependency was reopened, and nothing
 * re-read it.
 *
 * Real pipeline, real git repo; only the two sub-agents are faked — the same
 * harness `story-reopen.test.ts` uses.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { reopenStory } from "../src/core/run/reopenStory.ts";
import { approve } from "../src/core/run/gates.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { dependencyHoldOfLog, dependencyHoldReason, releasedByReopen } from "../src/core/build/dependencyHold.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_VERDICTS", "FAKE_BUILD_STATE"] as const;
let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * W1 [S0, S1] both refused twice → `blocked` by a reviewer.
 * W2 [S2 ← S1, S4 ← S1+S0]    → `blocked`, `dependency S1 blocked` (S4's deciding hold is S1: depends_on order).
 * W3 [S3 ← S2]                → `blocked`, `dependency S2 blocked`.
 */
const CHAIN: BuildWorkspaceOptions = {
  stories: [
    { id: "S0", epic: "E1", title: "Other root" },
    { id: "S1", epic: "E1", title: "Root" },
    { id: "S2", epic: "E1", title: "Direct dependent", dependsOn: ["S1"] },
    { id: "S4", epic: "E1", title: "Held twice", dependsOn: ["S1", "S0"] },
    { id: "S3", epic: "E1", title: "Transitive dependent", dependsOn: ["S2"] },
  ],
  epics: [{ id: "E1", stories: ["S0", "S1", "S2", "S4", "S3"], branch: "epic/e1" }],
  waves: [["S0", "S1"], ["S2", "S4"], ["S3"]],
};

async function blockedChain(): Promise<BuildWorkspace> {
  const ws = makeBuildWorkspace(CHAIN);
  open.push(ws);
  process.env.PATH = ws.binDir;
  process.env.FAKE_BUILD_STATE = ws.statePath;
  process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S0: ["changes", "changes"], S1: ["changes", "changes"] });
  await runNext({ root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: "2026-09-14T09:00:00Z" });
  for (const id of ["S0", "S1", "S2", "S3", "S4"]) expect(status(ws, id)).toBe("blocked");
  expect(holdOf(ws, "S2")).toBe("S1");
  expect(holdOf(ws, "S4")).toBe("S1");
  expect(holdOf(ws, "S3")).toBe("S2");
  expect(holdOf(ws, "S1")).toBeNull();
  return ws;
}

function status(ws: BuildWorkspace, id: string): string {
  return /^status:\s*(\w+)/m.exec(readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8"))?.[1] ?? "?";
}

function holdOf(ws: BuildWorkspace, id: string): string | null {
  return dependencyHoldOfLog(readFileSync(join(ws.runDir, "04-build", "log", `${id}.md`), "utf8"));
}

function reopened(ws: BuildWorkspace): readonly { actor: string; payload: Record<string, unknown> }[] {
  return (EventLog.forRun(ws.runDir).read() as never as { type: string; actor: string; payload: Record<string, unknown> }[])
    .filter((e) => e.type === "story.reopened");
}

const WHY = "the owner has decided S1 ships";

function reopen(ws: BuildWorkspace, id: string) {
  return reopenStory({ root: ws.root, storyId: id, note: WHY, actor: "alan", at: "2026-09-14T10:00:00Z" });
}

describe("reopening a blocked dependency releases what it alone was holding (#312)", () => {
  test("direct and transitive dependents held ONLY by it go back to `todo`, in the same command", async () => {
    const ws = await blockedChain();

    const outcome = reopen(ws, "S1");
    const said = outcome.lines.join("\n");

    expect(outcome.code).toBe(0);
    expect(status(ws, "S1")).toBe("todo");
    expect(status(ws, "S2")).toBe("todo");
    expect(status(ws, "S3")).toBe("todo");
    expect(said).toContain("released S2 — `blocked` → `todo`: its only hold was dependency S1");
    expect(said).toContain("released S3 — `blocked` → `todo`: its only hold was dependency S2");
  });

  test("each release is its own story.reopened, signed by the actor, naming the dependency that caused it, consuming no attempt", async () => {
    const ws = await blockedChain();
    reopen(ws, "S1");

    const rows = reopened(ws);
    expect(rows.map((e) => e.payload.story)).toEqual(["S1", "S2", "S3"]);
    expect(rows[0]?.payload.released_by).toBeUndefined();
    expect(rows[1]).toMatchObject({ actor: "alan" });
    expect(rows[1]?.payload).toMatchObject({
      story: "S2", from_status: "blocked", to_status: "todo", verdicts: 0, reason: "attempts",
      released_by: "S1", dependency: "S1",
    });
    expect(rows[2]?.payload).toMatchObject({ story: "S3", verdicts: 0, released_by: "S1", dependency: "S2" });
    expect(String(rows[2]?.payload.note)).toContain("dependency S2");
    for (const row of rows) expect(validateEvent({ ...row, ts: "2026-09-14T10:00:00Z", run: "r", stage: null, type: "story.reopened", cost_usd: 0 }).ok).toBe(true);
  });

  test("a story ALSO held by another still-blocked dependency stays `blocked`, and the output says why", async () => {
    const ws = await blockedChain();

    const said = reopen(ws, "S1").lines.join("\n");

    expect(status(ws, "S4")).toBe("blocked");
    expect(said).toContain(`S4 stays \`blocked\`: ${dependencyHoldReason({ id: "S0", status: "blocked" })}`);
    expect(reopened(ws).map((e) => e.payload.story)).not.toContain("S4");
  });

  test("a dependent blocked for a reason that is NOT the dependency stays `blocked`", async () => {
    const ws = await blockedChain();
    // S2's own record now says a reviewer blocked it — a verdict, not a hold.
    const log = join(ws.runDir, "04-build", "log", "S2.md");
    writeFileSync(log, readFileSync(log, "utf8").replace("dependency S1 blocked", "the reviewer refused it twice"), "utf8");

    const said = reopen(ws, "S1").lines.join("\n");

    expect(status(ws, "S2")).toBe("blocked");
    expect(status(ws, "S3")).toBe("blocked");
    expect(said).toContain("S2 stays `blocked`: its block is not a dependency hold");
    expect(reopened(ws).map((e) => e.payload.story)).toEqual(["S1"]);
  });
});

/**
 * #227: the cascade is prepared BEFORE anything is written (`prepareCascade`'s
 * own docstring), but the run-level check in `reopenStory` runs before even
 * that — so a done run refuses the WHOLE reopen, dependents included, rather
 * than releasing them out from under a gate that has already signed over them.
 */
describe("the cascade refuses on a done run, releasing nothing (#227)", () => {
  test("S1's own dependents stay `blocked`, no file moves, no event is appended", async () => {
    const ws = await blockedChain();
    const store = RunStore.open(ws.runDir);
    const approved = await approve(store, { root: ws.root, actor: "alan", at: "2026-09-14T09:30:00Z", note: "shipping without S1" });
    expect(approved.ok).toBe(true);
    expect(RunStore.open(ws.runDir).run.status).toBe("done");

    const before = new Map(["S0", "S1", "S2", "S3", "S4"].map((id) => [id, status(ws, id)]));
    const beforeEvents = reopened(ws).length;

    const outcome = reopenStory({ root: ws.root, storyId: "S1", note: WHY, actor: "alan", at: "2026-09-14T10:00:00Z", runId: ws.runId });
    const said = outcome.lines.join("\n");

    expect(outcome.code).toBe(1);
    expect(said).toContain("S1 cannot be reopened");
    expect(said).toContain("tldrx reject --stage 04-build/build");
    for (const [id, s] of before) expect(status(ws, id)).toBe(s);
    expect(reopened(ws)).toHaveLength(beforeEvents);
  });
});

describe("releasedByReopen — the rule, as data", () => {
  const row = (id: string, s: string, dependsOn: readonly string[], hold: string | null) =>
    ({ id, status: s, dependsOn, hold });

  test("fixed point: order of the rows does not decide the answer", () => {
    const rows = [
      row("S3", "blocked", ["S2"], "S2"),
      row("S2", "blocked", ["S1"], "S1"),
      row("S1", "todo", [], null),
    ];
    const got = releasedByReopen("S1", rows);
    expect(got.released).toEqual([{ id: "S2", dependency: "S1" }, { id: "S3", dependency: "S2" }]);
    expect(got.stayed).toEqual([]);
  });

  test("a second blocker keeps it, and so does its own dependent", () => {
    const rows = [
      row("S0", "blocked", [], null),
      row("S1", "todo", [], null),
      row("S4", "blocked", ["S1", "S0"], "S1"),
      row("S5", "blocked", ["S4"], "S4"),
    ];
    const got = releasedByReopen("S1", rows);
    expect(got.released).toEqual([]);
    expect(got.stayed.map((s) => s.id)).toEqual(["S4"]);
  });

  test("a dependency mid-pipeline is a wait, not a block — released", () => {
    const rows = [row("S1", "todo", [], null), row("S0", "review", [], null), row("S4", "blocked", ["S1", "S0"], "S1")];
    expect(releasedByReopen("S1", rows).released).toEqual([{ id: "S4", dependency: "S1" }]);
  });
});
