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
 *
 * Fix round 1 (review finding, Important): the first version of this fix pointed
 * `detail_omitted` at the story's own review log — a path that does not exist yet at
 * emit time (`writeLog` runs later, inside `settle`), that later holds only the
 * FINAL verdict's prose (an attempt-1 `changes` whose text was omitted is silently
 * overwritten by an attempt-2 `approve`), and that is never written at all for a
 * story that does not settle this invocation. The fix here makes the pointer true BY
 * CONSTRUCTION: the emit seam writes the omitted text to its own sidecar file BEFORE
 * building the event, and the event names exactly that file (or says the write
 * failed, never a path that does not exist).
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

/** The relative path named by an `"omitted text saved at <path>"` sentence. */
function savedPathIn(message: string): string {
  const match = /omitted text saved at (\S+)/.exec(message);
  if (match?.[1] === undefined) throw new Error(`no saved path in: ${message}`);
  return match[1];
}

describe("capPayload", () => {
  test("a payload inside the cap comes back untouched — every existing event is byte-identical", () => {
    const payload = { phase: "04-build", check: "review", story: "S1", detail: "looks good" };
    expect(capPayload(payload)).toBe(payload);
  });

  test("an oversized `detail` is replaced by a named absence pointing at where `save` put it", () => {
    const detail = "x".repeat(MAX_PAYLOAD_BYTES * 2);
    const payload = { phase: "04-build", check: "review", story: "S1", verdict: "changes", detail };
    let saved = "";

    const capped = capPayload(payload, (text) => {
      saved = text;
      return "omitted text saved at 04-build/log/overflow/2026-09-06T00-00-00Z-1-check.failed-detail.txt";
    });

    // `save` was handed the exact dropped text — not a copy, not a summary.
    expect(saved).toBe(detail);
    expect(capped.detail).toBeUndefined();
    expect(String(capped.detail_omitted)).toContain(String(bytes(payload)));
    expect(String(capped.detail_omitted)).toContain(String(MAX_PAYLOAD_BYTES));
    expect(String(capped.detail_omitted)).toContain(
      "omitted text saved at 04-build/log/overflow/2026-09-06T00-00-00Z-1-check.failed-detail.txt",
    );
    // Everything else the event was carrying survives — the verdict is the half a
    // ledger reads, and dropping it with the prose would lose the judgement too.
    expect(capped.verdict).toBe("changes");
    expect(capped.story).toBe("S1");
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("a `save` that reports failure is embedded verbatim, never a path that does not exist", () => {
    const capped = capPayload(
      { detail: "x".repeat(MAX_PAYLOAD_BYTES * 2) },
      () => "could not be saved: EACCES: permission denied, open '04-build/log/overflow'",
    );
    expect(String(capped.detail_omitted)).toContain(
      "could not be saved: EACCES: permission denied, open '04-build/log/overflow'",
    );
  });

  test("with no `save` callback it still says the text is not recoverable, rather than inventing a path", () => {
    const capped = capPayload({ detail: "x".repeat(MAX_PAYLOAD_BYTES * 2) });
    expect(String(capped.detail_omitted)).toContain("not preserved");
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

  test("dropping `detail` does not guarantee the result fits when the REST alone exceeds the cap", () => {
    // Fix round 1, finding 3: this function names ONE absence honestly — it does
    // not promise the payload fits afterwards. `EventLog.append` still refuses a
    // payload this oversized, and that throw is not silent: the emit seam in
    // `runNext.ts` catches it and fails the stage by name.
    const payload = { phase: "04-build", blob: "y".repeat(MAX_PAYLOAD_BYTES * 2), detail: "x".repeat(100) };
    const capped = capPayload(payload, () => "omitted text saved at somewhere.txt");
    expect(capped.detail).toBeUndefined();
    expect(capped.detail_omitted).toBeDefined();
    expect(bytes(capped)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
  });

  test("bounds by BYTES, not characters — fix round 1, finding 2's regression guard", () => {
    // The bug this guards against: `oneLine(text, 1000)` bounds CHARACTERS. 1000
    // astral characters (4 bytes each in UTF-8) clear 4096 bytes on their own,
    // before JSON escaping is even counted. `capPayload` must never repeat that
    // mistake — `Buffer.byteLength` is the ONLY measurement it takes, here and
    // everywhere else in this file.
    const detail = "😀".repeat(1100);
    const payload = { phase: "04-build", detail };
    expect(bytes(payload)).toBeGreaterThan(MAX_PAYLOAD_BYTES);

    const capped = capPayload(payload, () => "omitted text saved at somewhere.txt");

    expect(capped.detail).toBeUndefined();
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });
});

// ---------------------------------------------------------------------------
// The seam, end to end: `04-build`'s real executor, a real `runNext`, and the
// two ways an invocation used to lose every task row it had earned — an
// oversized reviewer verdict (the cap), and anything else that throws (not the
// cap). Both go through the SAME `runExecutor` try/catch in `runNext.ts`, and
// the SAME `appendCapped`/`capPayload`/sidecar mechanism.
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
  test("lands the verdict, the merge and the rows, and the omitted prose is really at the path named", async () => {
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
    expect(omitted).toMatch(/^\d+ bytes exceeds the \d+-byte cap — omitted text saved at /);
    // The event itself is inside the cap now that the prose is gone from it.
    expect(bytes(review?.payload as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);

    // The pointer is TRUE BY CONSTRUCTION: relative (never absolute), under this
    // run's own `04-build/log/overflow/`, written BEFORE the event landed, and
    // holding the exact text that was dropped — not a truncation, not a summary,
    // and not the story's OWN review log (which only ever holds the FINAL
    // verdict's prose, and did not exist yet at the moment this event was built).
    const relPath = savedPathIn(omitted);
    expect(relPath.startsWith("/")).toBe(false);
    expect(relPath).toMatch(/^04-build\/log\/overflow\/.+-check\.\w+-detail\.txt$/);
    const sidecar = readFileSync(join(ws.runDir, relPath), "utf8");
    expect(sidecar).toBe(summary);

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

  test("two oversized verdicts for the SAME story never share a sidecar file", async () => {
    // The exact shape the review finding named: an attempt-1 `changes` whose
    // prose is omitted, then an attempt-2 `approve` whose prose is ALSO
    // omitted — both must be readable afterwards, not one overwriting the other.
    const ws = workspace(ONE_STORY);
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    const round1 = "a".repeat(MAX_PAYLOAD_BYTES * 2);
    answerReview(ws, "S1", { verdict: "changes", summary: round1, findings: ["fix it"] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });

    // The requeue is real: attempt 2 gets a fresh developer run (headless, same
    // shape `stallAtReview` used for attempt 1), then its OWN spawned reviewer
    // dies at its cap the same way attempt 1's did, leaving a second host round
    // to prepare.
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#2";
    await next(ws, { at: "2026-08-29T10:25:00Z" });
    reenter(ws, "the reviewer died at its cap again");
    await next(ws, { mode: "prepare", at: "2026-08-29T10:30:00Z" });

    const round2 = "b".repeat(MAX_PAYLOAD_BYTES * 2);
    answerReview(ws, "S1", { verdict: "approve", summary: round2, findings: [] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:35:00Z" });

    const reviews = events(ws).filter((e) => e.payload.check === "review" && e.payload.source === "host");
    expect(reviews.map((e) => e.payload.verdict)).toEqual(["changes", "approve"]);
    const paths = reviews.map((e) => savedPathIn(String(e.payload.detail_omitted)));
    expect(paths[0]).not.toBe(paths[1]);
    expect(readFileSync(join(ws.runDir, String(paths[0])), "utf8")).toBe(round1);
    expect(readFileSync(join(ws.runDir, String(paths[1])), "utf8")).toBe(round2);
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
    // plainly that this invocation's task rows are not recorded, and why. Short
    // enough here to stay inline as `detail` — no cap kicks in.
    const errorEvent = events(ws).find((e) => e.type === "error");
    expect(errorEvent?.payload.where).toBe("executor");
    expect(errorEvent?.payload.tasks_recorded).toBe(false);
    expect(String(errorEvent?.payload.detail)).toContain("TLDRX_AGENT_PROVIDER must be one of");
    expect(events(ws).some((e) => e.type === "stage.failed")).toBe(true);
  }, 60_000);

  test("a HUGE thrown message is capped and saved to a sidecar too — the SAME mechanism, not a second one", async () => {
    // Fix round 1, finding 2: the first version of this bounded a thrown
    // message with `oneLine(why, 1000)` — a CHARACTER count, which a stray
    // multi-byte run could still clear 4096 BYTES with. This throw is real
    // (the same `agentProvider()` throw as above), just with a huge
    // configured value embedded verbatim in the message by `JSON.stringify`.
    const ws = workspace(ONE_STORY);
    process.env.TLDRX_AGENT_PROVIDER = "x".repeat(6000);

    const outcome = await next(ws);

    expect(outcome.code).toBe(5);
    const errorEvent = events(ws).find((e) => e.type === "error");
    expect(errorEvent?.payload.detail).toBeUndefined();
    const omitted = String(errorEvent?.payload.detail_omitted);
    expect(omitted).toMatch(/^\d+ bytes exceeds the \d+-byte cap — omitted text saved at /);
    const relPath = savedPathIn(omitted);
    expect(relPath.startsWith("/")).toBe(false);
    expect(relPath).toMatch(/^04-build\/log\/overflow\/.+-error-detail\.txt$/);
    const sidecar = readFileSync(join(ws.runDir, relPath), "utf8");
    expect(sidecar).toContain("TLDRX_AGENT_PROVIDER must be one of");
    expect(Buffer.byteLength(sidecar, "utf8")).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    // Still fails the stage by name — the cap swallowing the message did not
    // also swallow the fact that this invocation's rows are unrecorded.
    expect(outcome.lines.join("\n")).toContain("executor threw before returning its task rows");
  }, 60_000);
});
