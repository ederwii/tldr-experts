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
  delete process.env.FAKE_BUILD_WRITE;
  delete process.env.FAKE_BUILD_SESSION_PAD;
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

/** The `04-build/build` stage as it is ON DISK — a fresh read, never the in-memory store. */
function buildStage(ws: BuildWorkspace) {
  return RunStore.open(ws.runDir).run.phases
    .find((p) => p.id === "04-build")?.stages.find((s) => s.id === "build");
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

  /**
   * Fix-round finding: the catch above calls `failStage`, and `failStage`
   * rewrites the LAST task row of the stage as `failed` with the throw's own
   * message. That row belongs to THIS invocation only when this invocation
   * recorded one — and the catch runs with `ExecutorOutcome.tasks` unreturned,
   * so it never has. On a stage that is being RETRIED, the last row is the
   * previous, completed attempt's: a `done` turn was rewritten `failed`,
   * carrying an error it did not produce and could not have.
   *
   * Measured before the fix, on exactly this flow: `t2` (S1's own in-session
   * turn, `status: done, error: null`) came back `status: failed` with
   * `error: the executor threw before returning its task rows …`.
   *
   * The invocation still fails the stage and still names the loss — what it may
   * not do is repaint someone else's row to say so.
   */
  test("a retry whose executor throws leaves the PREVIOUS attempt's `done` row alone", async () => {
    const ws = workspace(TWO_WAVES);

    // Invocation 1 and 2: an in-session cycle that carries S1 all the way to
    // `done`, so the stage owns finished task rows before anything throws.
    await next(ws, { mode: "prepare" });
    writeFileSync(
      join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1 in-session\n", "utf8",
    );
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0.3 }),
      "utf8",
    );
    const committed = await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
    expect(committed.code).toBe(0);
    const before = buildStage(ws);
    expect(before?.tasks.length).toBeGreaterThan(0);
    expect(before?.tasks.at(-1)?.status).toBe("done");
    const untouched = before?.tasks.map((t) => ({ id: t.id, status: t.status, error: t.error }));

    // Invocation 3: S2 is still pending, and the executor throws before it can
    // return a single row for this invocation.
    process.env.TLDRX_AGENT_PROVIDER = "bogus";
    const threw = await next(ws, { at: "2026-08-29T11:00:00Z" });

    expect(threw.code).toBe(5);
    // The loss is still named — that half is not what changed.
    expect(threw.lines.join("\n")).toContain("executor threw before returning its task rows");
    const after = buildStage(ws);
    expect(after?.status).toBe("failed");
    // Every row the earlier attempts earned is byte-for-byte what it was.
    expect(after?.tasks.map((t) => ({ id: t.id, status: t.status, error: t.error }))).toEqual(untouched);
    expect(after?.tasks.at(-1)?.status).toBe("done");
    expect(after?.tasks.at(-1)?.error).toBeNull();
  }, 90_000);

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

// ---------------------------------------------------------------------------
// #248: the SECOND field that overflows in the wild, and the two things the
// throw took with it.
//
// `agent.result` carries `outputs` — every run-relative path a turn wrote — and
// a story with a few dozen files clears 4096 bytes on that array alone. Three
// separate defects met there, and each half below is one of them:
//
//   1. the append in `recordExecutorTasks` was RAW (not the capped seam), and
//      `capPayload` only knew how to name `detail`, so routing alone would not
//      have saved it either;
//   2. the throw landed AFTER the executor try/catch closed, so it killed the
//      loop with exit 1 — outside `--retry-failed`'s exit-5 family;
//   3. the epic claim was in memory one line before the throw and `store.save()`
//      never ran, so the next `run auto` was refused its OWN epic as a foreign
//      one.
// ---------------------------------------------------------------------------

/**
 * A developer whose `outputs` array alone clears the cap — 80 realistic paths,
 * ~4.6 KB of JSON array. The live incident that filed #248 measured 3924 bytes of
 * `outputs` under a 212-byte envelope: this is that, rounded up so the assertion
 * cannot pass by a handful of bytes either way.
 */
const MANY_FILES_COUNT = 80;
const MANY_FILES: Record<string, string> = Object.fromEntries(
  Array.from({ length: MANY_FILES_COUNT }, (_, i) => [
    `src/generated/module-${String(i).padStart(3, "0")}/very-long-descriptive-name.ts`,
    `// generated ${String(i)}\n`,
  ]),
);

/**
 * The same one story, with `src/generated` DECLARED as its surface.
 *
 * Deliberate, and worth the sentence: a story that writes 60 files it never
 * declared also emits `story.touches_widened`, whose `paths`/`after` lists are a
 * THIRD uncapped field family — measured here at 7060 bytes, and refused for the
 * same reason `outputs` was. That is a separate defect on a separate event and it
 * is filed, not fixed in this change (AGENTS.md §1). Declaring the surface keeps
 * this test on the seam it is about: the `agent.result` for a turn that wrote a
 * lot of files.
 */
const WIDE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story", touches: ["src/generated"] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

describe("capPayload learns `outputs` (#248)", () => {
  test("an oversized `outputs` list is named by COUNT, never truncated in place", () => {
    const outputs = Array.from({ length: 200 }, (_, i) => `src/generated/file-${String(i)}.ts`);
    const payload = { phase: "04-build", task: "t2", key: "S2", outputs, tldrx_version: "0.17.0" };
    expect(bytes(payload)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    let saved = "";

    const capped = capPayload(payload, (text) => {
      saved = text;
      return "omitted text saved at 04-build/log/overflow/2026-09-12T00-00-00Z-1-agent.result-outputs.txt";
    });

    // The list is GONE, not shortened: a 12-of-200 `outputs` would read as the
    // whole list to everything downstream, which is the invented value §7 bans.
    expect(capped.outputs).toBeUndefined();
    expect(capped.outputs_omitted).toBe(200);
    expect(String(capped.outputs_omitted_reason)).toContain(String(MAX_PAYLOAD_BYTES));
    expect(String(capped.outputs_omitted_reason)).toContain(
      "omitted text saved at 04-build/log/overflow/2026-09-12T00-00-00Z-1-agent.result-outputs.txt",
    );
    // `save` got the full list, one path per line — recoverable verbatim.
    expect(saved.split("\n")).toEqual(outputs);
    // Everything the ledger reads survives.
    expect(capped.task).toBe("t2");
    expect(capped.key).toBe("S2");
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("`detail` still goes first, and `outputs` only if the payload is STILL over", () => {
    // Order matters: `detail` is prose and `outputs` is a list a ledger reads, so
    // the prose is the first thing to go. A payload that fits once `detail` is
    // named keeps its `outputs` untouched.
    const outputs = ["a.ts", "b.ts"];
    const payload = { phase: "04-build", outputs, detail: "x".repeat(MAX_PAYLOAD_BYTES * 2) };
    const capped = capPayload(payload, () => "omitted text saved at somewhere.txt");
    expect(capped.detail_omitted).toBeDefined();
    expect(capped.outputs).toEqual(outputs);
    expect(capped.outputs_omitted).toBeUndefined();
  });

  test("an in-cap payload carrying `outputs` is the SAME object — every existing event is byte-identical", () => {
    const payload = { phase: "04-build", task: "t1", outputs: ["s1.txt"] };
    expect(capPayload(payload)).toBe(payload);
  });
});

describe("#248 half 1 — a huge `outputs` never kills the money path", () => {
  test("the task row, its cost and the epic merge all land; the list is beside the event", async () => {
    const ws = workspace(WIDE_STORY);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: MANY_FILES });
    process.env.FAKE_BUILD_COST = "0.25";

    // Before the fix this threw out of `EventLog.append` — "payload NNNN bytes
    // exceeds the 4096 byte cap" — and took `store.save()` with it.
    const outcome = await next(ws);

    expect(outcome.code).not.toBe(1);
    const stage = buildStage(ws);
    // The row is ON DISK with its money, which is the whole point.
    const dev = stage?.tasks.find((t) => t.role === "developer");
    expect(dev).toBeDefined();
    expect(dev?.cost_usd).toBe(0.25);
    expect(dev?.outputs.length).toBe(MANY_FILES_COUNT);

    // The event is inside the cap, and says what it left out by COUNT.
    const result = events(ws).find((e) => e.type === "agent.result" && e.payload.outputs_omitted !== undefined);
    expect(result?.payload.outputs).toBeUndefined();
    expect(result?.payload.outputs_omitted).toBe(MANY_FILES_COUNT);
    expect(bytes(result?.payload as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);

    // The full list is beside the event, relative and real.
    const relPath = savedPathIn(String(result?.payload.outputs_omitted_reason));
    expect(relPath.startsWith("/")).toBe(false);
    expect(relPath).toMatch(/^04-build\/log\/overflow\/.+-agent\.result-outputs\.txt$/);
    const sidecar = readFileSync(join(ws.runDir, relPath), "utf8");
    expect(sidecar.split("\n").length).toBe(MANY_FILES_COUNT);
    expect(sidecar).toContain("src/generated/module-079/very-long-descriptive-name.ts");
  }, 90_000);
});

/**
 * A payload oversized for a reason `capPayload` does NOT know how to name, in
 * the one place it can only be recorded and nowhere earlier: `session_id`.
 *
 * `agent.result` is the only event that carries it (grep over `src/`, measured),
 * so a 6000-character session id sails through every executor emit and throws at
 * `recordExecutorTasks`'s append and nowhere else — which is precisely the line
 * halves 2 and 3 are about. A provider may hand back a session id of any length,
 * and naming ONE absence has never promised a fit (see `capPayload` above): what
 * may not happen is the throw escaping past the accounting.
 */
const HUGE_SESSION = "6000";

describe("#248 half 2 — a throw while recording rows fails the STAGE, it does not kill the loop", () => {
  test("exit 5, not 1, and the rows already earned are on disk", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_SESSION_PAD = HUGE_SESSION;

    // Before the fix this REJECTED — the throw escaped `runNext` entirely, and
    // `run auto` turned it into exit 1 via `fail()`, outside `--retry-failed`'s
    // exit-5 family. The loop told to survive two failures survived zero.
    const outcome = await next(ws);

    expect(outcome.code).toBe(5); // EXIT_AGENT_FAILED — `--retry-failed`'s family
    expect(outcome.lines.join("\n")).toContain("exceeds the 4096 byte cap");
    const stage = buildStage(ws);
    expect(stage?.status).toBe("failed");
    // Every row recorded before the throw is on disk: the catch saves.
    expect(stage?.tasks.length ?? 0).toBeGreaterThan(0);
    // And the loss is named in the log, where it happened — not under `executor`,
    // which would send a reader looking at the wrong seam.
    const errorEvent = events(ws).find((e) => e.type === "error" && e.payload.where === "record-tasks");
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent?.payload.detail)).toContain("exceeds the 4096 byte cap");
  }, 90_000);
});

describe("#248 half 3 — a claim already earned is on disk before anything that can throw", () => {
  test("the epic branch this run cut is in run.yml even when recording the rows throws", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_SESSION_PAD = HUGE_SESSION;
    // Deliberately tolerant of a REJECTION rather than asserting exit 5: the exit
    // code is half 2's property and half 2 owns the test for it. This one has to
    // hold even for a throw nothing catches, which is what makes it a separate
    // defect — so it asserts the claim and nothing else.
    await next(ws).catch(() => null);

    // The refusal this closes: `branchClaims.ts` reads `build.epic_branch` off
    // run.yml, finds `epic/e1` on disk and NOT in the file, and refuses the run
    // its own epic — "this run did not cut it". It did cut it. The claim is
    // saved the moment it is earned, one line BEFORE anything that can throw.
    const onDisk = RunStore.open(ws.runDir).run;
    expect(onDisk.build?.epic_branch ?? []).toContain("epic/e1");
  }, 90_000);
});
