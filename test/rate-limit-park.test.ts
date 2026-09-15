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
import { summarize } from "../src/core/ui/summary.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

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

async function next(ws: BuildWorkspace, parallel?: number): Promise<readonly string[]> {
  const outcome = await runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-09-15T09:00:00Z",
    ...(parallel === undefined ? {} : { parallel }),
  });
  return outcome.lines;
}

type Ev = { type: string; payload: Record<string, unknown> };
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

  test("the event type is in the closed enum, so the log accepts the line", () => {
    expect(EVENT_TYPES).toContain("agent.rate_limited");
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
