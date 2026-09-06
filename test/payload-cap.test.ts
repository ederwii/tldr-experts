/**
 * The 4096-byte payload cap is a rule about what an event may CARRY, and it was
 * being enforced as a rule about whether the invocation survives.
 *
 * `EventLog.append` throws on an oversized payload, the reviewer's verdict prose is
 * the field that overflows, and nothing wrapped the executor call — so one long
 * review took out `recordExecutorTasks` and `store.save()` with it: the epic merge
 * was on disk and every task's cost was gone from run.yml.
 *
 * The cap is honoured, never raised (spec §2.9). What changes is what happens at the
 * seam: the oversized field is replaced by a NAMED absence, and the executor call is
 * wrapped so nothing that was already earned is lost to a throw.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capPayload, MAX_PAYLOAD_BYTES, validateEvent } from "../src/core/events/Event.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { reject } from "../src/core/run/gates.ts";
import { REVIEW_DIR } from "../src/core/run/prepared.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

function bytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

describe("capPayload", () => {
  test("a payload inside the cap comes back untouched — every existing event is byte-identical", () => {
    const payload = { phase: "04-build", check: "review", story: "S1", detail: "looks good" };
    expect(capPayload(payload)).toBe(payload);
  });

  test("an oversized `detail` is replaced by a named absence, and the result fits", () => {
    const detail = "x".repeat(MAX_PAYLOAD_BYTES * 2);
    const payload = { phase: "04-build", check: "review", story: "S1", verdict: "changes", detail };

    const capped = capPayload(payload, "04-build/log/S1.md");

    expect(capped.detail).toBeUndefined();
    expect(String(capped.detail_omitted)).toContain(String(bytes(payload)));
    expect(String(capped.detail_omitted)).toContain(String(MAX_PAYLOAD_BYTES));
    expect(String(capped.detail_omitted)).toContain("04-build/log/S1.md");
    // Everything else the event was carrying survives — the verdict is the half a
    // ledger reads, and dropping it with the prose would lose the judgement too.
    expect(capped.verdict).toBe("changes");
    expect(capped.story).toBe("S1");
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("with no pointer it still says where the text is NOT, rather than inventing a path", () => {
    const capped = capPayload({ detail: "x".repeat(MAX_PAYLOAD_BYTES * 2) });
    expect(String(capped.detail_omitted)).toContain("not in this event");
    expect(String(capped.detail_omitted)).not.toContain("undefined");
  });

  test("an oversized payload with no `detail` is left alone — the cap still refuses it", () => {
    // Honesty over convenience: this function knows how to name ONE absence. A
    // payload that is oversized for another reason is a bug in whoever built it,
    // and silently trimming an unknown field would be the framework editing its
    // own record.
    const payload = { blob: "x".repeat(MAX_PAYLOAD_BYTES * 2) };
    expect(capPayload(payload)).toBe(payload);
    expect(validateEvent({
      ts: "2026-09-06T00:00:00Z", run: "r", stage: null, type: "check.failed",
      actor: "facilitator", cost_usd: 0, payload,
    }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The seam, end to end: `04-build`'s real executor, a real `runNext`, and the
// two ways an invocation used to lose every task row it had earned — an
// oversized reviewer verdict (the cap), and anything else that throws (not the
// cap). Both go through the SAME `runExecutor` try/catch in `runNext.ts`.
//
// This file spawns a real `claude` (the fake fixture binary) via
// `makeBuildWorkspace`/`runNext`, so it takes the load-aware spawn timeout —
// see `test/machine-load.test.ts`'s "every file that spawns a real process"
// invariant.
// ---------------------------------------------------------------------------
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_BUILD_COST;
  delete process.env.FAKE_BUILD_FAIL;
  delete process.env.FAKE_BUILD_FAIL_REASON;
  delete process.env.FAKE_BUILD_STATE;
  delete process.env.TLDRX_AGENT_PROVIDER;
  for (const ws of open) ws.dispose();
  open = [];
});

const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

const TWO_WAVES: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second story", dependsOn: ["S1"] },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1"], ["S2"]],
};

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan",
    at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function reviewDir(ws: BuildWorkspace, id: string): string {
  return join(ws.runDir, ".agent", "build", id, REVIEW_DIR);
}

/** The host's answer, written where `--commit --review` reads it. */
function answerReview(ws: BuildWorkspace, id: string, envelope: unknown): void {
  writeFileSync(join(reviewDir(ws, id), "result.json"), `${JSON.stringify(envelope)}\n`, "utf8");
}

/** Send the stage back so the next invocation re-enters it (the operator's move). */
function reenter(ws: BuildWorkspace, note: string): void {
  reject(RunStore.open(ws.runDir), { root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note });
}

/** Drive S1 to `review` with an errored reviewer on the ledger, re-enterable. */
async function stallAtReview(ws: BuildWorkspace): Promise<void> {
  process.env.FAKE_BUILD_COST = "0";
  process.env.FAKE_BUILD_FAIL_REASON = "Reached maximum budget ($1)";
  process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
  await next(ws);
  reenter(ws, "the reviewer died at its cap");
}

describe("the emit seam under a real build run — an oversized reviewer verdict", () => {
  test("lands the verdict, the merge and the rows instead of throwing the invocation away", async () => {
    const ws = workspace(TWO_WAVES);
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    const summary = "x".repeat(MAX_PAYLOAD_BYTES * 2);
    answerReview(ws, "S1", { verdict: "approve", summary, findings: [] });

    // Before the fix this rejected — `EventLog.append` refusing the oversized
    // `detail` — and left the stage `running` on disk with no task row for it.
    // After the fix `capPayload` is applied at the ONE seam every executor event
    // goes through, so the invocation completes normally.
    const settled = await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });
    // Not asserting `code` here: a settled S1 leaves S2 next in line, which is a
    // legitimate `EXIT_AWAITING_HUMAN` (4), not a failure — the point under test
    // is that this invocation returned an outcome AT ALL, rather than rejecting.
    expect(settled.lines.join("\n")).toContain("S1 → `done`");

    // The verdict survives — it is the half a ledger reads — and the oversized
    // prose is named, not silently dropped and not silently truncated in place.
    const review = events(ws).find((e) => e.payload.check === "review" && e.payload.source === "host");
    expect(review?.payload.verdict).toBe("approve");
    expect(review?.payload.detail).toBeUndefined();
    const omitted = String(review?.payload.detail_omitted);
    expect(omitted).toContain(String(MAX_PAYLOAD_BYTES));
    expect(omitted).toContain("04-build/log/S1.md");
    // The event itself is inside the cap now that the prose is gone from it.
    expect(bytes(review?.payload as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);

    // The pointer is honest: the full text really is at that path.
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain(summary);

    // `store.save()` ran: a FRESH read off disk (not the in-memory `RunStore`
    // this invocation held) shows the story settled and the epic merge stood.
    // The stage itself moves to `awaiting_gate` — S2 is next in line and that is
    // a legitimate reason to stop, not the throw this test guards against.
    const onDisk = RunStore.open(ws.runDir).run;
    const stage = onDisk.phases.find((p) => p.id === "04-build")?.stages.find((s) => s.id === "build");
    expect(stage?.status).toBe("awaiting_gate");
    const storyMd = readFileSync(join(ws.planDir, "stories", "S1.md"), "utf8");
    expect(storyMd).toContain("status: done");
  }, 60_000);
});

describe("the emit seam under a real build run — a non-cap throw", () => {
  test("fails the stage by name, saves what could be saved, and says which rows could not be recovered", async () => {
    const ws = workspace(ONE_STORY);
    // Not a payload-cap throw at all: a bad provider name throws out of
    // `spawnAgent` (`spawnAgent.ts`'s `agentProvider()`) before a single byte of
    // this invocation's work exists — the same shape any OTHER executor throw
    // takes once it clears the seam this task added a try/catch around.
    process.env.TLDRX_AGENT_PROVIDER = "bogus";

    const outcome = await next(ws);

    expect(outcome.code).toBe(5); // EXIT_AGENT_FAILED
    const said = outcome.lines.join("\n");
    expect(said).toContain("executor threw before returning its task rows");
    expect(said).toContain("not in run.yml");
    expect(said).toContain('TLDRX_AGENT_PROVIDER must be one of claude | codex; got "bogus"');

    // `store.save()` ran: a fresh read off disk shows the stage FAILED, not
    // still `running` with nobody having written that down.
    const onDisk = RunStore.open(ws.runDir).run;
    const stage = onDisk.phases.find((p) => p.id === "04-build")?.stages.find((s) => s.id === "build");
    expect(stage?.status).toBe("failed");

    // The loss is named IN THE LOG, not just on stdout: an `error` event says
    // plainly that this invocation's task rows are not recorded, and why.
    const errorEvent = events(ws).find((e) => e.type === "error");
    expect(errorEvent?.payload.where).toBe("executor");
    expect(errorEvent?.payload.tasks_recorded).toBe(false);
    expect(String(errorEvent?.payload.message)).toContain("TLDRX_AGENT_PROVIDER must be one of");
    expect(events(ws).some((e) => e.type === "stage.failed")).toBe(true);
  }, 60_000);
});
