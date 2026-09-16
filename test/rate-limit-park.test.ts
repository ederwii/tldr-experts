/**
 * gh #298 — the provider announces the wall BEFORE it hits, and the run parks.
 *
 * The signal was never missing. `claude --output-format stream-json` emits
 * `{"type":"rate_limit_event", …}` while the turn is still working, and this
 * repository has carried one in its own recorded transcript since the fixture
 * was written: `test/fixtures/agent/stream-json.jsonl:9`, asserted below as the
 * measurement this change is built on. What was missing was a reader — the
 * `switch` in `agentEvents.ts` dropped it through `default:` — so the only trace
 * a quota wall left was a developer dying mid-story.
 *
 * What is built here is the WARNING half only (owner decision, Split): the frame
 * becomes a typed event, the outcome carries the last one, and a Build stage that
 * sees a non-`allowed` status starts no further story. Classifying the DEATH
 * needs a terminal capture nobody has, and is filed separately.
 *
 * The executor tests run the REAL executor against a REAL git repo with the fake
 * `claude` first on PATH (AGENTS.md §8), and the frame reaches them through the
 * ONE shared emitter, `src/core/facilitator/fakeTranscript.ts`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentStream, rateLimitLine } from "../src/core/facilitator/agentEvents.ts";
import { EVENT_TYPES } from "../src/core/events/Event.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { runAuto } from "../src/core/facilitator/runAuto.ts";
import { RATE_LIMIT_RESUME_ACTOR, refusalNote, type AutoGateVerdict } from "../src/core/run/autoGate.ts";
import { waitingFor } from "../src/core/run/waiting.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { summarize } from "../src/core/ui/summary.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

/** The dod command that cancels the run it is running inside (gh #305's fixture). */
const CANCEL_FROM_DOD = join(FRAMEWORK_ROOT, "test", "fixtures", "build", "cancelFromDod.ts");

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_RATE_LIMIT", "FAKE_BUILD_SLEEP_MS",
] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

// --- the measured shape ----------------------------------------------------

/** The `rate_limit_event` line of the recorded transcript, verbatim. */
function recordedFrame(): string {
  const lines = readFileSync(join(FRAMEWORK_ROOT, "test", "fixtures", "agent", "stream-json.jsonl"), "utf8")
    .trim().split("\n");
  const at = lines.findIndex((line) => line.includes('"rate_limit_event"'));
  // The citation is a LINE NUMBER in a committed file; if it moves, the comment
  // above (and #298's own evidence) is talking about a different line.
  expect(at).toBe(8);
  return lines[at] ?? "";
}

describe("the recorded transcript's own rate-limit frame is read, not dropped", () => {
  test("stream-json.jsonl:9 parses into one typed event carrying the provider's figures", () => {
    const events = new AgentStream("claude").push(recordedFrame());
    expect(events).toEqual([{
      kind: "rate-limit",
      status: "allowed",
      window: "five_hour",
      // Read off `unifiedWindows.five_hour`: that frame states no top-level
      // `utilization` at all, which is exactly why the fallback exists.
      utilization: 0.03,
      resetsAt: 1788065400,
    }]);
  });

  test("a frame that states no figures reports them ABSENT — never a zero", () => {
    const events = new AgentStream("claude").push(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning" },
    }));
    expect(events).toEqual([{
      kind: "rate-limit", status: "allowed_warning", window: null, utilization: null, resetsAt: null,
    }]);
  });

  test("a frame with no readable status is still noise", () => {
    expect(new AgentStream("claude").push('{"type":"rate_limit_event"}')).toEqual([]);
    expect(new AgentStream("claude").push('{"type":"rate_limit_event","rate_limit_info":{}}')).toEqual([]);
  });

  test("Codex is untouched: its stream has no frame this repo has measured", () => {
    expect(new AgentStream("codex").push(recordedFrame())).toEqual([]);
  });
});

describe("the operator's line quotes the provider and invents nothing", () => {
  test("every figure the frame stated, and only those", () => {
    expect(rateLimitLine({
      status: "allowed_warning", window: "five_hour", utilization: 0.92, resetsAt: 1789364400,
    })).toBe("allowed_warning 92% of the five_hour window · resets 2026-09-14T05:40:00.000Z");
  });

  test("a frame that stated nothing but its status says nothing but its status", () => {
    expect(rateLimitLine({ status: "allowed_warning", window: null, utilization: null, resetsAt: null }))
      .toBe("allowed_warning the provider's window");
  });

  test("the progress view shows the warning and stays quiet on a healthy frame", () => {
    const ctx = { root: "/repo", elapsedMs: 0, width: 200 };
    expect(summarize({
      kind: "rate-limit", status: "allowed_warning", window: "five_hour", utilization: 0.94, resetsAt: null,
    }, ctx)).toBe("rate limit allowed_warning 94% of the five_hour window");
    expect(summarize({
      kind: "rate-limit", status: "allowed", window: "five_hour", utilization: 0.03, resetsAt: null,
    }, ctx)).toBeNull();
  });
});

// --- the park --------------------------------------------------------------

function twoStories(): BuildWorkspaceOptions {
  return {
    stories: [
      { id: "S1", epic: "E1", title: "First story" },
      { id: "S2", epic: "E1", title: "Second story" },
    ],
    epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
    waves: [["S1", "S2"]],
  };
}

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  // A free fake keeps these tests about the quota, not about the budget.
  process.env.FAKE_BUILD_COST = "0";
  return made;
}

async function next(ws: BuildWorkspace, parallel?: number, at = "2026-09-15T09:00:00Z"): Promise<readonly string[]> {
  const outcome = await runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at,
    ...(parallel === undefined ? {} : { parallel }),
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

describe("a warning on one story's stream parks the NEXT story (gh #298)", () => {
  test("the second story is not started, and the ledger says why", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.94" });

    const lines = await next(ws);

    // S1 ran to the end — the park is at a STORY boundary, not mid-story.
    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(developerSpawns(ws, "S2")).toBe(0);
    expect(lines.join("\n")).toContain(
      "S2: not started — the provider warned its rate limit was close, so the run parked before it bit: "
        + "allowed_warning 94% of the five_hour window",
    );

    const parked = events(ws).filter((e) => e.type === "agent.rate_limited");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.payload).toMatchObject({
      status: "allowed_warning",
      window: "five_hour",
      utilization: 0.94,
      resets_at: 1789364400,
      parked: "S2",
    });
  });

  test("a healthy `allowed` frame parks nothing — the provider's own word decides", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed@0.03" });

    await next(ws);

    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(developerSpawns(ws, "S2")).toBe(1);
    expect(events(ws).filter((e) => e.type === "agent.rate_limited")).toHaveLength(0);
  });

  test("a figure the frame did not state is absent WITH ITS REASON, not a zero", async () => {
    const ws = workspace(twoStories());
    // A warning with no utilization and no reset instant: both must come back as
    // sentences. A `0` utilization would read as "none of the window is used",
    // and a `0` reset as 1970.
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@none@none" });

    await next(ws);

    const payload = events(ws).find((e) => e.type === "agent.rate_limited")?.payload ?? {};
    expect(payload).toMatchObject({
      status: "allowed_warning",
      window: "five_hour",
      utilization_absent: "not recorded — the provider's frame stated no utilization",
      resets_at_absent: "not recorded — the provider's frame stated no resetsAt",
      parked: "S2",
    });
    // The absence is the assertion: a key that is present would be a figure the
    // provider never stated.
    expect(Object.keys(payload)).not.toContain("utilization");
    expect(Object.keys(payload)).not.toContain("resets_at");
  });

  test("the warning is recorded even when there was nothing left to park", async () => {
    // The one-story wave: the frame arrives on the LAST story, so no park line
    // is ever printed. The FRAME is still the fact the operator acts on, and a
    // stage that said it on stdout and wrote nothing to the ledger was the first
    // review's Important finding, reproduced here.
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "Only story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
    });
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.94" });

    await next(ws);

    const parked = events(ws).filter((e) => e.type === "agent.rate_limited");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.payload).toMatchObject({
      status: "allowed_warning",
      window: "five_hour",
      utilization: 0.94,
      resets_at: 1789364400,
      parked_absent: "nothing was left to park — the warning arrived on this stage's last story",
    });
    // Nothing was withheld, so nothing may claim to have been.
    expect(Object.keys(parked[0]?.payload ?? {})).not.toContain("parked");
  });

  test("the handoff names the park as the reason, instead of `no reason for it`", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.94" });

    await next(ws);

    const handoff = readFileSync(join(ws.runDir, "04-build", "handoff.md"), "utf8");
    expect(handoff).toContain("S2");
    expect(handoff).toContain("the provider warned its rate limit was close, so the run parked before it bit");
    // The audit record must not say the run has no explanation for a story it
    // withheld on purpose, and said so about, twice (AGENTS.md §7).
    expect(handoff).not.toContain("this stage recorded no attempt and no reason for it");
  });

  test("a park with no reset instant says so, rather than leaving the question open", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.94@none" });

    const lines = await next(ws);

    expect(lines.join("\n")).toContain("it stated no reset instant, so nothing here knows when it clears");
    const handoff = readFileSync(join(ws.runDir, "04-build", "handoff.md"), "utf8");
    expect(handoff).toContain("it stated no reset instant, so nothing here knows when it clears");
  });

  test("the event type is in the closed enum, so the log accepts the line", () => {
    expect(EVENT_TYPES).toContain("agent.rate_limited");
  });
});

describe("a cancel that lands after the warning is the cause the record names", () => {
  test("the handoff says the run was cancelled, not that the quota parked it", async () => {
    // Both facts are true at once: S1's turn warned, and then a forced
    // `tldrx run cancel` landed in S1's own Definition of Done. The live report
    // already names the cancel — it is the door the loop actually took — so the
    // audit record naming the quota would be the two halves of one run
    // disagreeing about why a story was withheld.
    const ws = workspace({
      ...twoStories(),
      testScript: `${JSON.stringify(process.execPath)} ${JSON.stringify(CANCEL_FROM_DOD)}`,
    });
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.94" });

    // The invocation stamp must PRECEDE the cancel's own (`cancelFromDod` writes
    // `2026-09-14T06:35:00Z`): measured on the first cut of this test, a later
    // `at` made `cancelRun` write a run.yml the schema refuses, the dod command
    // exited 1, and the cancel never landed at all — the test was green about a
    // scenario it had not produced. The instrument was the bug.
    const lines = await next(ws, undefined, "2026-09-14T06:00:00Z");

    expect(lines.join("\n")).toContain("S2: not started — the run was cancelled");
    const handoff = readFileSync(join(ws.runDir, "04-build", "handoff.md"), "utf8");
    expect(handoff).toContain("S2");
    expect(handoff).toContain("the run was cancelled (tldrx run cancel) while this stage held it");
    expect(handoff).not.toContain("the provider warned its rate limit was close");
  });
});

describe("a wave's lanes park on the same signal", () => {
  test("the third story is never dispatched, whichever lane frees up first", async () => {
    const ws = workspace({
      stories: [
        { id: "S1", epic: "E1", title: "First story" },
        { id: "S2", epic: "E1", title: "Second story" },
        { id: "S3", epic: "E1", title: "Third story" },
      ],
      epics: [{ id: "E1", stories: ["S1", "S2", "S3"], branch: "epic/e1" }],
      waves: [["S1", "S2", "S3"]],
    });
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.94" });
    // Two lanes take S1 and S2 at once; S3 waits for one of them. S2's turns are
    // slowed so the ORDER is a fact and not a race: S1's developer returns —
    // which is what sets the park — long before either lane can pick S3 up.
    process.env.FAKE_BUILD_SLEEP_MS = JSON.stringify({ S1: 0, S2: 400, S3: 0 });

    const lines = await next(ws, 2);

    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(developerSpawns(ws, "S2")).toBe(1);
    expect(developerSpawns(ws, "S3")).toBe(0);
    expect(lines.join("\n")).toContain("S3: not started — the provider warned its rate limit was close");
    expect(events(ws).filter((e) => e.type === "agent.rate_limited")).toHaveLength(1);
  });
});

// --- gh #367: a warning parks only at or above the threshold ---------------

describe("gh #367 — an allowed_warning parks only at or above 90% utilization", () => {
  test("0.60 utilization does not park — the next story is dispatched", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.60" });

    const lines = await next(ws);

    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(developerSpawns(ws, "S2")).toBe(1);
    expect(lines.join("\n")).not.toContain("S2: not started");
    expect(lines.join("\n")).toContain(
      "the provider warned its rate limit, but stayed below the park threshold — dispatch continues: "
        + "allowed_warning 60% of the five_hour window",
    );

    const warned = events(ws).filter((e) => e.type === "agent.rate_limited");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.payload).toMatchObject({
      status: "allowed_warning",
      window: "five_hour",
      utilization: 0.6,
      parked_absent: "below the 90% park threshold — dispatch continued",
    });
    // Nothing was withheld, so nothing may claim to have been (AGENTS.md §7).
    expect(Object.keys(warned[0]?.payload ?? {})).not.toContain("parked");
  });

  test("0.89 utilization — just under the line — still does not park (boundary)", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.89" });

    await next(ws);

    expect(developerSpawns(ws, "S2")).toBe(1);
    const warned = events(ws).filter((e) => e.type === "agent.rate_limited");
    expect(warned[0]?.payload).toMatchObject({
      utilization: 0.89,
      parked_absent: "below the 90% park threshold — dispatch continued",
    });
  });

  test("0.90 utilization — the line itself — still parks (boundary)", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@0.90" });

    const lines = await next(ws);

    expect(developerSpawns(ws, "S2")).toBe(0);
    expect(lines.join("\n")).toContain(
      "S2: not started — the provider warned its rate limit was close, so the run parked before it bit: "
        + "allowed_warning 90% of the five_hour window",
    );
    const parked = events(ws).filter((e) => e.type === "agent.rate_limited");
    expect(parked[0]?.payload).toMatchObject({ status: "allowed_warning", utilization: 0.9, parked: "S2" });
  });

  test("a non-allowed_warning status still parks unconditionally, whatever the utilization", async () => {
    const ws = workspace(twoStories());
    // A status this repo has no reading for, at a LOW utilization — the threshold is
    // read by `allowed_warning` alone; every other status still parks as #298 always has.
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "blocked@0.10" });

    const lines = await next(ws);

    expect(developerSpawns(ws, "S2")).toBe(0);
    expect(lines.join("\n")).toContain("S2: not started — the provider warned its rate limit was close");
    const parked = events(ws).filter((e) => e.type === "agent.rate_limited");
    expect(parked[0]?.payload).toMatchObject({ status: "blocked", utilization: 0.1, parked: "S2" });
  });

  test("allowed_warning with NO stated utilization still parks — an unknown magnitude is not evidence it is far away", async () => {
    const ws = workspace(twoStories());
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: "allowed_warning@none" });

    const lines = await next(ws);

    expect(developerSpawns(ws, "S2")).toBe(0);
    expect(lines.join("\n")).toContain("S2: not started — the provider warned its rate limit was close");
  });
});

// --- gh #367: `run auto` resumes a park on the provider's clock, not a human's ---

describe("gh #367 — run auto treats a rate-limit-parked gate as a timed wait", () => {
  test("resumes the stage automatically once resets_at has passed, with no human gate", async () => {
    const ws = workspace({ ...twoStories(), gates: "none" });
    // resets_at 90s in the (real) past: past the floor the instant this is polled.
    const resetsAtSec = Math.floor((Date.now() - 90_000) / 1000);
    process.env.FAKE_BUILD_RATE_LIMIT = JSON.stringify({ S1: `allowed_warning@0.94@${String(resetsAtSec)}` });

    const outcome = await runAuto({
      root: ws.root, yolo: false, actor: "alan", at: "2026-09-16T09:00:00Z",
      waitGatesMs: spawnTestTimeout(30_000),
    });

    expect(outcome.code).toBe(0);
    expect(developerSpawns(ws, "S1")).toBe(1);
    // S2 never ran on the FIRST pass (the park), but did on the resumed one.
    expect(developerSpawns(ws, "S2")).toBe(1);
    const resumed = events(ws).filter((e) => e.type === "gate.rejected" && e.actor === RATE_LIMIT_RESUME_ACTOR);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.payload.and_continue).toBe(true);
    expect(outcome.lines.join("\n")).toContain(`signed "${RATE_LIMIT_RESUME_ACTOR}"`);
    // Never asked a person: no rejection signed by the operator's own name, and the
    // #231 checks-retry actor never signed anything either.
    expect(events(ws).filter((e) => e.type === "gate.rejected" && e.actor === "alan")).toHaveLength(0);
  });

  test("run status names the park and when it resumes, instead of \"held by: stories\"", () => {
    const ws = workspace({ ...twoStories(), gates: "none" });
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600; // an hour from now — not yet due
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
      ts: "2026-09-16T09:00:00.000Z",
      run: store.runId,
      stage: "build",
      type: "agent.rate_limited",
      actor: "developer",
      cost_usd: 0,
      payload: {
        phase: "04-build", status: "allowed_warning", window: "five_hour", utilization: 0.94,
        resets_at: resetsAtSec, parked: "S2",
      },
    });

    const reloaded = RunStore.open(ws.runDir);
    const waiting = waitingFor(reloaded.run, reloaded.runDir);

    expect(waiting.kind).toBe("gate");
    expect(waiting.message).toContain("parked by a rate-limit warning");
    expect(waiting.message).toContain(`resumes automatically at ${new Date(resetsAtSec * 1000).toISOString()}`);
    expect(waiting.message).not.toContain("held by stories");
  });
});
