/**
 * gh #364, part (c) — a developer turn that ends with a question and no diff,
 * in an UNATTENDED run, is a failed attempt with a named `failure_kind`,
 * requeued under the attempt cap — not a silent terminal `blocked` only a
 * human's `story reopen` can lift.
 *
 * Measured live: `run auto --wait-gates --questions none`, a developer that
 * believed its brief forbade reading anything outside `touches` asked a
 * question in its result text, produced no diff, and the story went
 * `blocked` with "the developer produced no diff … no DoD ran and no
 * reviewer was spawned" — with nothing in `run.yml` distinguishing this from
 * any other block, and no mechanism to retry it. $0.50 and an operator's
 * `story reopen` were the only way out.
 *
 * The fix gives this shape the same treatment `settleRedDod` (#313) already
 * gives a red Definition of Done: a spent, requeueable attempt while
 * `story.attempt < attempts`, blocked (the old terminal shape) on the last
 * one — and the task row this turn already wrote carries
 * `failure_kind: "asked_no_diff"` (`AgentFailureKind`, reused from #348)
 * rather than reading `status: done` on a turn that delivered nothing.
 *
 * ATTENDED runs (the default; `questions_policy` resolves to `human`) are
 * UNCHANGED: `this.ctx.unattended` gates the whole check, so a question with
 * no diff there still runs the old path — the DoD over the untouched tree
 * (green, since nothing broke it), reviewed and approved like any other
 * no-op first attempt (a first attempt that lands nothing is rendered
 * honestly and reviewed, a decision this fix does not touch) — this new
 * shape fires only because an UNATTENDED run has nobody to ask.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { ASKED_NO_DIFF_MARK } from "../src/core/build/outcome.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_QUESTIONS",
] as const;

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
    actor: "alan", at: "2026-09-16T09:00:00Z",
  });
  return outcome.code;
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

type Ev = { type: string; payload: Record<string, unknown> };
function events(ws: BuildWorkspace): readonly Ev[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function startedAttempts(ws: BuildWorkspace, id: string): readonly unknown[] {
  return events(ws).filter((e) => e.type === "task.started" && e.payload.story === id).map((e) => e.payload.attempt);
}

function developerSpawns(ws: BuildWorkspace, id: string): number {
  return events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "developer" && e.payload.story === id)
    .length;
}

/**
 * Every recorded task row of the Build stage, in `run.yml` order. `RunTask`
 * carries no story id of its own (`key` is `ExecutorTask`'s, not persisted) —
 * every fixture here has exactly one story, so every row IS that story's.
 */
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

describe("#364 · an unattended developer that asks and leaves no diff requeues, not blocks", () => {
  test("attempt 1 asks + no diff, attempt 2 has real work: DONE, no human reopen, and attempt 1's row carries failure_kind", async () => {
    const ws = workspace(one({ questions: "none" }));
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ "S1#1": {} });
    process.env.FAKE_BUILD_QUESTIONS = JSON.stringify({
      "S1#1": ["may I read the port interface outside touches?"],
    });

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1, 2]);
    expect(developerSpawns(ws, "S1")).toBe(2);
    expect(story(ws, "S1")).toContain("status: done");
    expect(events(ws).some((e) => e.type === "story.reopened")).toBe(false);

    const settled = events(ws).filter((e) => e.type === "task.done" && e.payload.story === "S1");
    expect(settled.map((e) => [e.payload.attempt, e.payload.status])).toEqual([[1, "todo"], [2, "done"]]);
    // Exactly ONE dod check ran (`check.passed`/`check.failed` carry no
    // `attempt` field, so this counts totals rather than filtering by one) —
    // attempt 2's, over real work; attempt 1 proved nothing over an untouched
    // tree and none ran for it. `review` DOES carry `attempt`: none at all
    // for attempt 1.
    expect(events(ws).filter((e) => e.payload.check === "dod")).toHaveLength(1);
    expect(events(ws).filter((e) => e.payload.check === "review" && e.payload.attempt === 1)).toHaveLength(0);

    // Attempt 1's developer row, attempt 2's developer row, attempt 2's
    // reviewer row — real work earns a review, an asked-no-diff attempt earns
    // no DoD and no reviewer, which the two assertions above already pin.
    const rows = taskRows(ws);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.failure_kind).toBe("asked_no_diff");
    expect(rows[0]?.status).toBe("failed");
    expect(String(rows[0]?.error ?? "")).toContain(ASKED_NO_DIFF_MARK);
    // Neither of attempt 2's rows is tarred with attempt 1's kind.
    expect(rows[1]?.failure_kind ?? null).toBeNull();
    expect(rows[2]?.failure_kind ?? null).toBeNull();
  });

  test("asks + no diff on EVERY attempt: the last one blocks, with the ASKED_NO_DIFF reason, and every row is failed", async () => {
    const ws = workspace(one({ questions: "none" }));
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: {} });
    process.env.FAKE_BUILD_QUESTIONS = JSON.stringify({ S1: ["what should I do?"] });

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1, 2]);
    expect(story(ws, "S1")).toContain("status: blocked");
    const rows = taskRows(ws);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.failure_kind).toBe("asked_no_diff");
      expect(row.status).toBe("failed");
    }
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain(ASKED_NO_DIFF_MARK);
  });

  test("`attempts: 1`: the first asked-no-diff attempt blocks immediately — never a free retry", async () => {
    const ws = workspace(one({ questions: "none", attempts: 1 }));
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: {} });
    process.env.FAKE_BUILD_QUESTIONS = JSON.stringify({ S1: ["what should I do?"] });

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1]);
    expect(story(ws, "S1")).toContain("status: blocked");
    expect(taskRows(ws)[0]?.failure_kind).toBe("asked_no_diff");
  });

  test("ATTENDED (default questions_policy: human): a question + no diff is UNCHANGED — this shape never fires", async () => {
    const ws = workspace(one());
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: {} });
    process.env.FAKE_BUILD_QUESTIONS = JSON.stringify({ S1: ["what should I do?"] });

    await next(ws);

    // Unchanged: the gate (`this.ctx.unattended === true`) never opens, so the
    // turn runs the old path — DoD over the untouched tree (green: the fixture
    // repo's default test script exits 0), reviewed and approved (the fake
    // reviewer's default verdict), attempt 1 only, no `askedNoDiff` anywhere.
    expect(startedAttempts(ws, "S1")).toEqual([1]);
    expect(story(ws, "S1")).toContain("status: done");
    expect(events(ws).some((e) => e.payload.check === "dod")).toBe(true);
    expect(events(ws).some((e) => e.type === "agent.spawned" && e.payload.role === "reviewer")).toBe(true);
    for (const row of taskRows(ws)) expect(row.failure_kind ?? null).toBeNull();
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).not.toContain(ASKED_NO_DIFF_MARK);
  });
});
