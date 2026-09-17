/**
 * gh #354 — the default build-phase budget gate has no story-boundary park.
 *
 * Before this, `runNext.ts`'s `budgetRefusal` metered the phase ceiling exactly
 * ONCE, at stage entry (`runExecutor`'s `!started` guard) — the Build EXECUTOR
 * itself never re-checked the envelope between two dispatches of the same
 * headless `runAll`. A phase that could afford its entry estimate but ran short
 * partway through (attempts, retries, or a plan whose prices under-shot real
 * cost) kept dispatching underfunded until the phase ran dry, and the only way
 * the gate fired again was a RETRY of a `stage.failed` stage — all-or-nothing
 * against whatever the remaining plan still cost, with the stage left
 * incomplete and no boundary the operator chose.
 *
 * Modeled directly on #298's rate-limit park (`test/rate-limit-park.test.ts`):
 * a story-boundary check inside the SAME two dispatch doors (`driveStory`'s
 * serial loop, a wave's `lane()`), a `budget.parked` event mirroring
 * `agent.rate_limited`'s shape, a shared reason in the handoff and the operator
 * line, and a `run auto --wait-gates` resume — money-based rather than
 * time-based, since a budget shortfall clears on an operator's `tldrx budget
 * raise` (or `--rebalance-finished`'s own move), never on a clock.
 *
 * The executor tests run the REAL executor against a REAL git repo with the
 * fake `claude` first on PATH (AGENTS.md §8).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EVENT_TYPES } from "../src/core/events/Event.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { runAuto } from "../src/core/facilitator/runAuto.ts";
import { BUDGET_RESUME_ACTOR, refusalNote, type AutoGateVerdict } from "../src/core/run/autoGate.ts";
import { waitingFor } from "../src/core/run/waiting.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { currentBudgetPark } from "../src/core/run/budgetPark.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_SLEEP_MS"] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * Two unpriced stories, and a stage `budget_usd` tight enough that S1's FULL
 * half (developer + reviewer, both funded) leaves too little for S2's
 * park floor (`REVIEWER_FLOOR_USD`, the same fixed floor `reviewerUnderfunded`
 * already uses — see `budgetParkFor`'s own docstring for why it is NOT a
 * per-story `developerFloorUsd`) — MEASURED, not guessed: `budgetUsd: 10` with
 * a $4.50 turn cost leaves $5.50 before S1's review (comfortably above the
 * $2.00 reviewer floor, so S1 reaches `done` cleanly) and $1.00 after it,
 * below the same $2.00 floor. The fake agent reports its configured cost
 * regardless of the cap it was handed, exactly as #298's fixture does for the rate-limit park —
 * the point under test is the STAGE's remainder, not any one turn's own
 * ceiling.
 */
function twoStories(): BuildWorkspaceOptions {
  return {
    stories: [
      { id: "S1", epic: "E1", title: "First story" },
      { id: "S2", epic: "E1", title: "Second story" },
    ],
    epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
    waves: [["S1", "S2"]],
    budgetUsd: 10,
  };
}

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

async function next(ws: BuildWorkspace, at = "2026-09-17T09:00:00Z"): Promise<readonly string[]> {
  const outcome = await runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at,
  });
  return outcome.lines;
}

type Ev = { type: string; actor: string; payload: Record<string, unknown> };
function events(ws: BuildWorkspace): readonly Ev[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function developerSpawns(ws: BuildWorkspace, id: string): number {
  return events(ws)
    .filter((e) => e.type === "agent.spawned" && e.payload.role === "developer" && e.payload.story === id).length;
}

describe("a short remainder parks the NEXT story, at the boundary (gh #354)", () => {
  test("the second story is not started, and the ledger says why", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_COST = "4.5";

    const lines = await next(ws);

    // S1 ran to the end, reviewed and approved — the park is at a STORY
    // boundary, not mid-story and not a story this park half-funded.
    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(developerSpawns(ws, "S2")).toBe(0);
    const done = events(ws).find((e) => e.type === "task.done" && e.payload.story === "S1");
    expect(done?.payload.status).toBe("done");
    expect(lines.join("\n")).toContain(
      "S2: not started — the stage can no longer afford the next story's developer, so the run parked "
        + "before overspending it: $1.00 left, $2.00 is the least this stage can fund another turn with",
    );

    const parked = events(ws).filter((e) => e.type === "budget.parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.payload).toMatchObject({ remainder_usd: 1, floor_usd: 2, parked: "S2" });
  });

  test("a phase with plenty left parks nothing", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_COST = "0.5";

    await next(ws);

    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(developerSpawns(ws, "S2")).toBe(1);
    expect(events(ws).filter((e) => e.type === "budget.parked")).toHaveLength(0);
  });

  test("the handoff names the park as the reason, instead of `no reason for it`", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_COST = "4.5";

    await next(ws);

    const handoff = readFileSync(`${ws.runDir}/04-build/handoff.md`, "utf8");
    expect(handoff).toContain("S2");
    expect(handoff).toContain(
      "the stage can no longer afford the next story's developer, so the run parked before overspending it",
    );
    expect(handoff).not.toContain("this stage recorded no attempt and no reason for it");
  });

  test("the event type is in the closed enum, so the log accepts the line", () => {
    expect(EVENT_TYPES).toContain("budget.parked");
  });
});

describe("gh #354: `run status` names the park, instead of \"held by: stories\"", () => {
  test("the message never reads as a decision waiting on a person", () => {
    const ws = workspace(twoStories());
    const verdict: AutoGateVerdict = {
      ok: false,
      conditions: [
        { id: "stories", ok: false, detail: "1 of 2 done — S2:todo; a build stage self-signs only when every story is `done`" },
      ],
      note: "",
      why: "stories=1 of 2 done — S2:todo",
      warnedBy: [],
      failedChecks: [],
    };
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) =>
          stage.id === "build"
            ? { ...stage, status: "awaiting_gate", gate: { ...stage.gate, type: "approve", status: "pending", note: refusalNote(verdict) } }
            : stage
        ),
      })),
    }));
    store.save();
    EventLog.forRun(ws.runDir).append({
      ts: "2026-09-17T08:55:00.000Z",
      run: store.runId,
      stage: "build",
      type: "stage.started",
      actor: "tldrx",
      cost_usd: 0,
      payload: { phase: "04-build", mode: "headless" },
    });
    EventLog.forRun(ws.runDir).append({
      ts: "2026-09-17T09:00:00.000Z",
      run: store.runId,
      stage: "build",
      type: "budget.parked",
      actor: "developer",
      cost_usd: 0,
      payload: { phase: "04-build", remainder_usd: 1, floor_usd: 2, parked: "S2" },
    });

    const reloaded = RunStore.open(ws.runDir);
    const waiting = waitingFor(reloaded.run, reloaded.runDir);

    expect(waiting.kind).toBe("gate");
    expect(waiting.message).toContain("parked by a budget shortfall");
    expect(waiting.message).toContain("$1.00 left");
    expect(waiting.message).toContain("$2.00 needed");
    expect(waiting.message).not.toContain("held by stories");
    expect(waiting.message).not.toContain("tldrx approve");
  });
});

describe("gh #354: `run auto` resumes a budget park once the phase can afford it", () => {
  test("resumes the stage automatically once an operator raises the ceiling — never a human gate", async () => {
    const ws = workspace({ ...twoStories(), gates: "none" });
    process.env.FAKE_BUILD_COST = "4.5";

    // `tldrx budget raise <phase> <usd> --stage <id>` moves TWO figures
    // together (measured against the CLI's own `stageRaiseLines`, `budget.ts`):
    // the phase ceiling (`budget.yml`, what the STAGE-ENTRY check
    // `budgetRefusal` reads on the retry `reject --and-continue` re-enters) and
    // the STAGE's own `budget_usd` (`run.yml`, what every per-story and
    // reviewer cap — including `budgetParkFor`'s own — is derived from).
    // Raising only the phase ceiling moves no spawn ceiling at all. The same
    // shape `answerWhenWaiting` (auto-gate-questions.test.ts) uses to act while
    // a loop is demonstrably parked, adapted to a MONEY signal instead of a
    // heartbeat payload: poll the run's own event log.
    const raiseWhenParked = (async (): Promise<void> => {
      for (let i = 0; i < 800; i++) {
        const parkedNow = events(ws).some((e) => e.type === "budget.parked" && e.payload.parked === "S2");
        if (parkedNow) {
          const raiser = RunStore.open(ws.runDir);
          raiser.mutateBudget((b) => ({
            ...b,
            ceiling_usd: b.ceiling_usd + 10,
            phases: b.phases.map((p) => (p.id === "04-build" ? { ...p, ceiling_usd: p.ceiling_usd + 10 } : p)),
          }));
          raiser.mutate((run) => ({
            ...run,
            phases: run.phases.map((phase) => (
              phase.id !== "04-build" ? phase : {
                ...phase,
                stages: phase.stages.map((stage) => (
                  stage.id !== "build" ? stage : { ...stage, budget_usd: stage.budget_usd + 10 }
                )),
              }
            )),
          }));
          raiser.save();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    const outcome = await runAuto({
      root: ws.root, yolo: false, actor: "alan", at: "2026-09-17T09:00:00Z",
      waitGatesMs: spawnTestTimeout(30_000),
    });
    await raiseWhenParked;

    expect(outcome.code).toBe(0);
    expect(developerSpawns(ws, "S1")).toBe(1);
    // S2 never ran on the FIRST pass (the park), but did on the resumed one.
    expect(developerSpawns(ws, "S2")).toBe(1);
    const resumed = events(ws).filter((e) => e.type === "gate.rejected" && e.actor === BUDGET_RESUME_ACTOR);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.payload.and_continue).toBe(true);
    expect(outcome.lines.join("\n")).toContain(`signed "${BUDGET_RESUME_ACTOR}"`);
    // Never asked a person: no rejection signed by the operator's own name.
    expect(events(ws).filter((e) => e.type === "gate.rejected" && e.actor === "alan")).toHaveLength(0);
  });

  test("without an operator raising it, the park never resumes on its own — it is a money question, not a clock", async () => {
    const ws = workspace({ ...twoStories(), gates: "none" });
    process.env.FAKE_BUILD_COST = "4.5";

    const outcome = await runAuto({
      root: ws.root, yolo: false, actor: "alan", at: "2026-09-17T09:00:00Z",
      waitGatesMs: 1500,
    });

    expect(outcome.code).toBe(4); // no human signed it, and none was ever asked
    expect(developerSpawns(ws, "S2")).toBe(0);
    expect(events(ws).filter((e) => e.type === "gate.rejected" && e.actor === BUDGET_RESUME_ACTOR)).toHaveLength(0);
    const store = RunStore.open(ws.runDir);
    expect(currentBudgetPark(store.runDir, "build")).not.toBeNull();
  });
});
