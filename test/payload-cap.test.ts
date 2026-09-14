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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCount, measuredWidening } from "../src/core/build/measuredTouches.ts";
import { spendBasisOf } from "../src/core/budget/spendBasis.ts";
import { buildStoryCost, LOWER_BOUND_MARK, renderStoryCost } from "../src/core/budget/costView.ts";
import { capPayload, MAX_PAYLOAD_BYTES, validateEvent } from "../src/core/events/Event.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { buildExecutor } from "../src/core/facilitator/executors/build.ts";
import type { ExecutorContext } from "../src/core/facilitator/executors/index.ts";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { splitFrontMatter } from "../src/core/schemas/frontMatter.ts";
import { parseYaml } from "../src/core/yaml.ts";
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
    // The stage itself stays `running` — S2 is next in line and the host owes it
    // a `--prepare`; that is a legitimate reason to stop, not the throw this
    // test guards against. (Until gh #280 this read `awaiting_gate`, and only
    // because the headless pass in `stallAtReview` had written S2 `blocked`
    // behind S1 at `review` — the defect #280 fixed. S2 now waits at `todo`, so
    // after S1 settles it is genuinely next, which is what the line says.)
    const onDisk = RunStore.open(ws.runDir).run;
    const stage = onDisk.phases.find((p) => p.id === "04-build")?.stages.find((s) => s.id === "build");
    expect(stage?.status).toBe("running");
    expect(settled.lines.join("\n")).toContain("S2 is next — run `tldrx next --prepare`");
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
 * declared also emits `story.touches_widened`, whose `paths`/`after` lists were a
 * THIRD uncapped field family — measured here at 7060 bytes, and refused for the
 * same reason `outputs` was. That was filed as #249 and is fixed below, on its
 * own seam; declaring the surface here keeps THIS test on the seam it is about:
 * the `agent.result` for a turn that wrote a lot of files.
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

/**
 * gh #222 put a `usage` block on every executor `agent.result`, and the question
 * this answers is whether `capPayload` has to learn a THIRD field name.
 *
 * It does not, and the reason is arithmetic rather than taste: `usage` is
 * FIXED-ARITY — four finite counters, one spelling (`envelope.ts`'s
 * `usagePayload`) — where `detail` is unbounded prose and `outputs` is an
 * unbounded list. A field that cannot grow cannot be the reason a payload is
 * oversized, so there is nothing for a branch to drop. What matters instead is
 * the opposite property, and it is the one #248 was filed about: when a payload
 * IS over the cap, the accounting has to be what survives the drop.
 */
describe("the usage block is bounded, so the cap has nothing to learn (#222)", () => {
  /** Twelve-digit counters — far past anything a provider has reported. */
  const HUGE_USAGE = {
    input_tokens: 999_999_999_999, output_tokens: 999_999_999_999,
    cache_creation_input_tokens: 999_999_999_999, cache_read_input_tokens: 999_999_999_999,
  };

  test("even at absurd counter widths it is a rounding error against the cap", () => {
    // Measured, not asserted: the block's own bytes, at counters no real turn
    // will reach. 148 of 4096 — under 4% of the cap.
    const block = bytes({ usage: HUGE_USAGE }) - bytes({});
    expect(block).toBeLessThan(MAX_PAYLOAD_BYTES / 20);
  });

  test("an oversized turn drops its path list and KEEPS its accounting", () => {
    const outputs = Array.from({ length: 200 }, (_, i) => `src/generated/file-${String(i)}.ts`);
    const payload = {
      phase: "04-build", task: "t2", key: "S2", outputs,
      tldrx_version: "0.17.0", usage: HUGE_USAGE,
    };
    expect(bytes(payload)).toBeGreaterThan(MAX_PAYLOAD_BYTES);

    const capped = capPayload(payload, () => "omitted text saved at 04-build/log/overflow/x.txt");

    expect(capped.outputs).toBeUndefined();
    expect(capped.outputs_omitted).toBe(200);
    // The whole point of #248 was that an oversized event must not take the
    // invocation's accounting with it. The four counters are still there.
    expect(capped.usage).toEqual(HUGE_USAGE);
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
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
    // …and the accounting the event now carries (#222) came through the drop.
    expect(result?.payload.usage).toEqual({
      input_tokens: 100, output_tokens: 10,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    });

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

// ---------------------------------------------------------------------------
// #249: the THIRD field family that overflows in the wild — `story.touches_widened`'s
// three path lists — and the two seams the throw took with it.
//
// Measured on a live 0.24.0 field run (issue comment, 2026-09-14): 32 changed
// files, 16 declared touches, 13 outside → `paths` 1363 B, `before` 1316 B,
// `after` 2678 B, `note` 130 B = 5556 B > 4096. `capPayload` knew `detail` and
// `outputs` by name and nothing else, so the append threw out of
// `measureSurface` — whose contract says "advisory, never throws" but only
// guarded git — through `settle`, and `runNext`'s catch failed the stage with
// `tasks_recorded: false`: the developer's and the reviewer's paid turns never
// reached run.yml, and the ceilings that derive from recorded spend were short.
// ---------------------------------------------------------------------------

/** The live incident's shape, rebuilt synthetically: 16 declared, 29 changed, 13 outside. */
function liveWidening(): { payload: Record<string, unknown>; before: number; after: number; outside: number } {
  const declared = Array.from({ length: 16 }, (_, i) =>
    `src/modules/owner-panel/components/panel-section-${String(i).padStart(2, "0")}/index.tsx`);
  const outside = Array.from({ length: 13 }, (_, i) =>
    `src/modules/owner-panel/application/use-cases/owner-panel-completion-${String(i).padStart(2, "0")}.ts`);
  const m = measuredWidening([...declared, ...outside], declared);
  if (m === null) throw new Error("the synthetic diff must widen");
  return {
    payload: { story: "S1", paths: [...m.paths], note: m.note, before: [...m.before], after: [...m.after], basis: "measured" },
    before: m.before.length,
    after: m.after.length,
    outside: m.paths.length,
  };
}

describe("capPayload learns the widening's three lists (#249)", () => {
  test("the live incident's payload validates: the two ends go by COUNT, the paths that fit stay", () => {
    const live = liveWidening();
    expect(bytes(live.payload)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    const saved: Record<string, string> = {};

    const capped = capPayload(live.payload, (text, field) => {
      saved[field] = text;
      return `omitted text saved at 04-build/log/overflow/2026-09-14T11-32-15Z-1-story.touches_widened-${field}.txt`;
    });

    const v = validateEvent({
      ts: "2026-09-14T11:32:15Z", run: "r", stage: "build", type: "story.touches_widened",
      actor: "framework", cost_usd: 0, payload: capped,
    });
    expect(v.ok).toBe(true);
    // `after` — the largest list, and derivable from the other two — goes WHOLE
    // and named by count, and that alone brings this payload under the cap, so
    // `before` STAYS: one list at a time and only while still over, exactly as
    // `outputs` after `detail`. The `(16 → 29 path(s))` every reader renders is
    // still derivable through `listCount`, and a shortened list would not be.
    expect(capped.after).toBeUndefined();
    expect(capped.after_omitted).toBe(live.after);
    expect(String(capped.after_omitted_reason)).toContain("story.touches_widened-after.txt");
    expect(saved.after?.split("\n")).toEqual(live.payload.after as string[]);
    expect(capped.before).toEqual(live.payload.before);
    expect(capped.before_omitted).toBeUndefined();
    expect(saved.before).toBeUndefined();
    expect(listCount(capped, "before")).toBe(live.before);
    expect(listCount(capped, "after")).toBe(live.after);
    // The ADDED paths are the reading itself, and they fit once the ends are
    // named — so they stay, verbatim.
    expect(capped.paths).toEqual(live.payload.paths);
    expect(capped.paths_omitted).toBeUndefined();
    expect(capped.note).toBe(live.payload.note);
    expect(capped.basis).toBe("measured");
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("`paths` goes LAST, and only when the payload is still over without the ends", () => {
    const paths = Array.from({ length: 120 }, (_, i) => `src/generated/module-${String(i).padStart(3, "0")}/very-long-descriptive-name.ts`);
    const payload = { story: "S1", paths, note: "n", before: ["docs/never"], after: ["docs/never", ...paths], basis: "measured" };
    const capped = capPayload(payload, (_text, field) => `omitted text saved at x-${field}.txt`);
    expect(capped.paths).toBeUndefined();
    expect(capped.paths_omitted).toBe(120);
    expect(String(capped.paths_omitted_reason)).toContain("x-paths.txt");
    expect(capped.after_omitted).toBe(121);
    expect(capped.before_omitted).toBe(1);
    expect(capped.story).toBe("S1");
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("an EMPTY end is not dropped — `before: []` on an undeclared story stays, since dropping it buys nothing", () => {
    const paths = Array.from({ length: 80 }, (_, i) => `src/generated/module-${String(i).padStart(3, "0")}/very-long-descriptive-name.ts`);
    const payload = { story: "S1", paths, note: "n", before: [], after: [...paths], basis: "measured" };
    const capped = capPayload(payload, () => "omitted text saved at x.txt");
    expect(capped.before).toEqual([]);
    expect(capped.before_omitted).toBeUndefined();
    expect(capped.after_omitted).toBe(80);
    expect(capped.paths_omitted).toBe(80);
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("a `paths_omitted` the writer already put there is ADDED to, not overwritten (`worktree.foreign_work_aside`)", () => {
    // `foreignWork.ts` caps its own list at 40 and counts the rest in the same key;
    // when even the 40 clear the cap, the count must say every path the event
    // does not carry — 40 + the rest — or a reader would under-count the stash.
    const paths = Array.from({ length: 40 }, (_, i) => `apps/web/src/features/very/long/path/segment/${String(i)}/component-${"x".repeat(60)}.tsx`);
    const payload = { repo: "app", paths, paths_omitted: 12, stash_ref: "abc", reason: "r" };
    expect(bytes(payload)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    const capped = capPayload(payload, () => "omitted text saved at x.txt");
    expect(capped.paths).toBeUndefined();
    expect(capped.paths_omitted).toBe(52);
    expect(capped.stash_ref).toBe("abc");
  });

  test("an in-cap widening is the SAME object — every row already written is byte-identical", () => {
    const payload = { story: "S1", paths: ["a.ts"], note: "n", before: ["b.ts"], after: ["b.ts", "a.ts"], basis: "measured" };
    expect(capPayload(payload)).toBe(payload);
  });
});

describe("#249 — a widening too wide for the cap never kills the money path", () => {
  test("the story settles `done`, both rows and their money land, and the event names its lists by count", async () => {
    // ONE story, NOTHING declared, 80 files written: `after` and `paths` are two
    // copies of 80 long paths and the payload clears the cap on either alone.
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: MANY_FILES });
    process.env.FAKE_BUILD_COST = "0.25";

    const outcome = await next(ws);

    expect(outcome.lines.join("\n")).not.toContain("exceeds the 4096 byte cap");
    const stage = buildStage(ws);
    expect(stage?.status).not.toBe("failed");
    const rows = stage?.tasks ?? [];
    expect(rows.map((t) => t.role).sort()).toEqual(["developer", "reviewer"]);
    const widened = events(ws).find((e) => e.type === "story.touches_widened");
    expect(widened).toBeDefined();
    expect(widened?.payload.paths).toBeUndefined();
    expect(widened?.payload.paths_omitted).toBe(MANY_FILES_COUNT);
    // The fixture declares `s1.txt`, so the story's list after the widening is
    // the 80 it wrote plus the one it declared — and `before` (that one entry)
    // went by count too, because the payload was still over without `after`.
    expect(widened?.payload.before_omitted).toBe(1);
    expect(widened?.payload.after_omitted).toBe(MANY_FILES_COUNT + 1);
    expect(bytes(widened?.payload as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const relPath = savedPathIn(String(widened?.payload.paths_omitted_reason));
    expect(relPath).toMatch(/^04-build\/log\/overflow\/.+-story\.touches_widened-paths\.txt$/);
    expect(readFileSync(join(ws.runDir, relPath), "utf8").split("\n").length).toBe(MANY_FILES_COUNT);
    expect(events(ws).some((e) => e.type === "task.done" && e.payload.story === "S1")).toBe(true);
  }, 90_000);
});

describe("#249 — measureSurface never throws: the story's row and `done` land whatever the emit does", () => {
  function directContext(ws: BuildWorkspace, emit: ExecutorContext["emit"]): ExecutorContext {
    const store = RunStore.open(ws.runDir);
    return {
      root: ws.root, runId: store.runId, runDir: ws.runDir, phaseId: "04-build", stageId: "build",
      spec: loadStageSpec(ws.root, store.run.scope, "build"), repos: store.run.repos,
      mode: "headless", model: null, effort: null, modelFlag: null, effortFlag: null,
      costUsd: null, tokens: null, budgetUsd: 8, maxBudgetUsd: 2, yolo: false,
      at: "2026-08-29T09:00:00Z", keepWorktrees: false, reuseEpic: false, parallel: 1,
      discardPending: false, review: false, attendedByHost: false, agentCap: () => 2, emit,
    };
  }

  function storyStatus(ws: BuildWorkspace, id: string): unknown {
    const text = readFileSync(join(ws.runDir, "03-plan", "stories", `${id}.md`), "utf8");
    return (parseYaml(splitFrontMatter(text).raw) as Record<string, unknown>).status;
  }

  /** The declared `s1.txt` plus one file outside it, so the settle has a widening to record. */
  const ONE_OUTSIDE = JSON.stringify({ S1: { "s1.txt": "S1 was here\n", "src/extra.ts": "// outside\n" } });

  test("an emit that throws once is replaced by a bounded absence on the SAME event, and task.done follows", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_WRITE = ONE_OUTSIDE;
    const seen: { type: string; payload: Record<string, unknown> }[] = [];
    // Throws exactly like the cap did: on the widening that carries its lists.
    // The bounded absence carries none, so it lands.
    const emit: ExecutorContext["emit"] = (type, payload) => {
      if (type === "story.touches_widened" && Array.isArray(payload.paths)) {
        throw new Error("refusing to append an invalid event: payload 5556 bytes exceeds the 4096 byte cap");
      }
      seen.push({ type, payload });
    };

    const outcome = await buildExecutor(directContext(ws, emit));

    expect(outcome.tasks.map((t) => t.role).sort()).toEqual(["developer", "reviewer"]);
    expect(storyStatus(ws, "S1")).toBe("done");
    const absence = seen.find((e) => e.type === "story.touches_widened");
    expect(absence).toBeDefined();
    expect(absence?.payload.paths).toBeUndefined();
    expect(absence?.payload.paths_omitted).toBe(1);
    expect(absence?.payload.before_omitted).toBe(1);
    expect(absence?.payload.after_omitted).toBe(2);
    expect(absence?.payload.basis).toBe("measured");
    expect(String(absence?.payload.note)).toContain("exceeds the 4096 byte cap");
    const order = seen.map((e) => e.type);
    expect(order.indexOf("task.done")).toBeGreaterThan(order.indexOf("story.touches_widened"));
  }, 90_000);

  test("an emit that throws EVERY time still settles the story; the loss is said on stderr", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_WRITE = ONE_OUTSIDE;
    const seen: string[] = [];
    const emit: ExecutorContext["emit"] = (type) => {
      if (type === "story.touches_widened") throw new Error("events.jsonl: EACCES");
      seen.push(type);
    };

    const outcome = await buildExecutor(directContext(ws, emit));

    expect(outcome.tasks.map((t) => t.role).sort()).toEqual(["developer", "reviewer"]);
    expect(storyStatus(ws, "S1")).toBe("done");
    expect(seen).toContain("task.done");
    expect((outcome.stderr ?? []).join("\n")).toContain("EACCES");
    expect((outcome.stderr ?? []).join("\n")).toContain("S1");
  }, 90_000);
});

describe("#249 — an executor that throws AFTER paid turns hands their rows to the ledger", () => {
  test("both rows and their money are in run.yml, the stage is `failed`, and the error event says so", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_COST = "0.25";
    // A late throw nothing in the executor catches: `settle` writes the story's
    // review log at `04-build/log/S1.md` AFTER the developer's and the reviewer's
    // rows are pushed — a directory in its place makes that write throw EISDIR.
    // Both readers of that path are tolerant (`staleDependencyHold`,
    // `priorAttemptLog`), so nothing earlier trips on it.
    mkdirSync(join(ws.runDir, "04-build", "log", "S1.md"), { recursive: true });

    const outcome = await next(ws);

    expect(outcome.code).toBe(5); // EXIT_AGENT_FAILED — still `--retry-failed`'s family
    const stage = buildStage(ws);
    expect(stage?.status).toBe("failed");
    const rows = stage?.tasks ?? [];
    expect(rows.map((t) => t.role).sort()).toEqual(["developer", "reviewer"]);
    // The rows are what the turns produced — not repainted `failed` with an error
    // they did not produce (the #234 lesson, this seam).
    expect(rows.every((t) => t.status === "done" && t.error === null)).toBe(true);
    const paid = rows.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
    expect(paid).toBeGreaterThan(0);
    // The money direction: the spend every ceiling derives from is not short.
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(paid);
    expect(events(ws).filter((e) => e.type === "agent.result")).toHaveLength(2);
    const errorEvent = events(ws).find((e) => e.type === "error" && e.payload.where === "executor");
    expect(errorEvent?.payload.tasks_recorded).toBe(true);
    expect(errorEvent?.payload.rows_written).toBe(2);
    expect(errorEvent?.payload.rows_expected).toBe(2);
    expect(String(errorEvent?.payload.detail)).toContain("EISDIR");
    expect(outcome.lines.join("\n")).toContain("threw after 2 turn(s)");
    expect(outcome.lines.join("\n")).not.toContain("not in run.yml");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// #249, review round 1: the DOUBLE fault. The executor throws after paid turns
// AND recording their rows throws too — an `agent.result` the cap cannot rescue
// (a 6000-character session id, exactly #248 half 2's case). Two findings:
//
//   1. `recordExecutorTasks` interleaved row, event, row, event — so a throw at
//      event k stranded rows k+1… in memory, and nothing the money readers
//      (`spendBasis.ts`, `phaseCost.ts`, the dashboard) read said the total was
//      short: a plausible number, worse than a loud zero. `recordTask` is a pure
//      in-memory `mapStage` and cannot throw; the append is the ONLY throw. So
//      every row goes into the store BEFORE any event is appended, and the
//      residual "written < expected" is structurally empty rather than signalled
//      — no new vocabulary for the three spend surfaces to learn. The EVENTS side
//      already has its door: `costView.ts` labels a story with no metered
//      `agent.result` as a LOWER BOUND by itself.
//   2. The catch emitted its `error` event BEFORE `store.save()`, and that
//      payload's `recording_error` was free text the cap did not trim — a long
//      one would throw uncaught, skip the save, and lose the rows just recorded
//      with zero trace. Now: rows, save, THEN the emit, wrapped; and
//      `recording_error` is in the cap's prose table beside `detail`.
// ---------------------------------------------------------------------------

describe("#249 double fault — the rows and their money survive an event append that throws", () => {
  test("every row is in run.yml with its cost; the spend surfaces read a MEASUREMENT; the event gap is named", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_COST = "0.25";
    process.env.FAKE_BUILD_SESSION_PAD = HUGE_SESSION;
    mkdirSync(join(ws.runDir, "04-build", "log", "S1.md"), { recursive: true });

    const outcome = await next(ws);

    expect(outcome.code).toBe(5);
    const stage = buildStage(ws);
    expect(stage?.status).toBe("failed");
    const rows = stage?.tasks ?? [];
    // BOTH rows — before the fix the first row's event threw and the second row
    // never reached the store (measured: 1 of 2).
    expect(rows.map((t) => t.role).sort()).toEqual(["developer", "reviewer"]);
    expect(rows.map((t) => t.cost_usd)).toEqual([0.25, 0.25]);
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0.5);
    // The ONE derivation every spend surface prints from, over the rows on disk:
    // nothing is missing from run.yml, so it says so — and says nothing it would
    // have to be taught.
    const basis = spendBasisOf(
      rows.map((t) => ({ costUsd: t.cost_usd, metered: t.metered !== false, tokens: t.tokens ?? null })),
      0,
    );
    expect(basis.basis).toBe("measured");
    expect(basis.reason).toContain("a measurement rather than a lower bound");
    // No `agent.result` could be appended (both carry the huge session id), and
    // the error event says exactly that — rows whole, events short, and why.
    expect(events(ws).filter((e) => e.type === "agent.result")).toHaveLength(0);
    const errorEvent = events(ws).find((e) => e.type === "error" && e.payload.where === "executor");
    expect(errorEvent?.payload.tasks_recorded).toBe(true);
    expect(errorEvent?.payload.rows_written).toBe(2);
    expect(errorEvent?.payload.rows_expected).toBe(2);
    expect(errorEvent?.payload.events_written).toBe(0);
    expect(String(errorEvent?.payload.recording_error)).toContain("exceeds the 4096 byte cap");
    expect(String(errorEvent?.payload.detail)).toContain("EISDIR");
    const said = outcome.lines.join("\n");
    expect(said).toContain("threw after 2 turn(s)");
    expect(said).toContain("0 of 2 agent.result events");
  }, 90_000);

  test("the ordinary record-tasks seam (#248 half 2) now leaves EVERY row in run.yml, events short", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_COST = "0.25";
    process.env.FAKE_BUILD_SESSION_PAD = HUGE_SESSION;

    const outcome = await next(ws);

    expect(outcome.code).toBe(5);
    const rows = buildStage(ws)?.tasks ?? [];
    expect(rows.map((t) => t.role).sort()).toEqual(["developer", "reviewer"]);
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0.5);
    const errorEvent = events(ws).find((e) => e.type === "error" && e.payload.where === "record-tasks");
    expect(errorEvent?.payload.rows_written).toBe(2);
    expect(errorEvent?.payload.rows_expected).toBe(2);
    expect(errorEvent?.payload.events_written).toBe(0);
    expect(outcome.lines.join("\n")).toContain("all 2 rows are in run.yml");
  }, 90_000);

  test("`recording_error` is prose the cap trims, beside `detail` — a huge one cannot throw the seam", () => {
    const payload = {
      phase: "04-build", where: "executor", detail: "short", tasks_recorded: false,
      rows_written: 1, rows_expected: 2, recording_error: "y".repeat(MAX_PAYLOAD_BYTES * 2),
    };
    const capped = capPayload(payload, (_text, field) => `omitted text saved at x-${field}.txt`);
    expect(capped.recording_error).toBeUndefined();
    expect(String(capped.recording_error_omitted)).toContain("x-recording_error.txt");
    expect(capped.detail).toBe("short");
    expect(capped.rows_written).toBe(1);
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("the replay renders the error line from `detail` and says how many rows landed", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_COST = "0.25";
    mkdirSync(join(ws.runDir, "04-build", "log", "S1.md"), { recursive: true });
    await next(ws);

    const text = renderReplay(loadRun(ws.root, ws.runId)!);
    expect(text).not.toContain("no message recorded");
    expect(text).toContain("EISDIR");
    expect(text).toContain("2 of 2 task rows recorded");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// #249, review round 2: the SECOND money surface. `budget.spent_usd` reads
// run.yml rows and shows $0.50 after the double fault; `tldrx cost --stories`
// (`storyLedger`) reads ONLY `agent.result` events, which the fault never wrote
// — so S1 came back measuredUsd null, unmeteredTurns 0: a confident "nothing",
// indistinguishable from a story no turn ran for, and silently at odds with the
// $0.50 the budget records. The lost turns must enter the EXISTING lower-bound
// door: a story `agent.spawned` named but no `agent.result` accounts for is a
// turn this figure does not see — counted as unmetered, so the row SAYS lower
// bound rather than null. No new vocabulary, no second parser (§7).
// ---------------------------------------------------------------------------

describe("#249 round 2 — the story ledger names the lost turns instead of a silent null", () => {
  test("after the double fault, buildStoryCost labels S1 a LOWER BOUND, not measuredUsd null / 0 unmetered", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_COST = "0.25";
    process.env.FAKE_BUILD_SESSION_PAD = HUGE_SESSION;
    mkdirSync(join(ws.runDir, "04-build", "log", "S1.md"), { recursive: true });

    const outcome = await next(ws);
    expect(outcome.code).toBe(5);
    // The two money surfaces, side by side: run.yml recorded the spend…
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0.5);
    // …and no agent.result reached the log, which is the fault this exercises.
    expect(events(ws).filter((e) => e.type === "agent.result")).toHaveLength(0);

    const cost = buildStoryCost(ws.runDir);
    expect(cost).not.toBeNull();
    const s1 = cost!.rows.find((r) => r.story === "S1");
    expect(s1).toBeDefined();
    // The two turns S1 was spawned for produced no agent.result — so the figure
    // is a LOWER BOUND and the ledger says so, rather than a confident null with
    // zero unmetered turns.
    expect(cost!.unmeteredStories).toContain("S1");
    expect(cost!.unmeteredTurns).toBe(2);
    // Measured is still null — the dollars are in run.yml, not recoverable per
    // story from the events, so it is NAMED absent, never invented as $0.00.
    expect(s1!.measuredUsd).toBeNull();

    const rendered = renderStoryCost(cost!);
    expect(rendered).toContain("LOWER BOUND");
    expect(rendered).toContain("S1");
    expect(rendered).not.toContain("every story measured inside the spawn ceilings");
  }, 90_000);

  test("a healthy run is unchanged: spawns and results balance, so nothing is flagged", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_COST = "0.25";

    const outcome = await next(ws);
    // A headless build stops at the human gate — exit 4, not 0 — with both turns
    // evented; the control is that nothing is flagged, not the exit code.
    expect(outcome.code).toBe(4);

    const cost = buildStoryCost(ws.runDir);
    expect(cost).not.toBeNull();
    expect(cost!.unmeteredTurns).toBe(0);
    expect(cost!.unmeteredStories).toEqual([]);
    const s1 = cost!.rows.find((r) => r.story === "S1");
    expect(s1?.measuredUsd).toBe(0.5);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// #249, review round 3: `spawned − accounted` cannot tell "result lost to the
// fault" from "turn still running". A bare `agent.spawned` with no result YET
// is every healthy mid-flight build — and `tldrx cost`, `--stories` and the
// handoff's per-story table are mid-run tools by design. A turn is LOST only
// when nothing can still deliver its result: the invocation that spawned it has
// written its terminal event on that stage (`stage.done`/`failed`/`skipped`,
// an `error` from the executor or record-tasks seam) or a later `stage.started`
// has superseded it. Events carry no attempt id (measured: none in
// `EVENT_TYPES`' payloads), so the walk's own order is the attempt scope.
// ---------------------------------------------------------------------------

describe("#249 round 3 — a spawned turn with no result YET is in flight, not lost", () => {
  function spawned(ws: BuildWorkspace, ts: string): void {
    EventLog.forRun(ws.runDir).append({
      ts, run: ws.runId, stage: "build", type: "agent.spawned", actor: "developer", cost_usd: 0,
      payload: { phase: "04-build", story: "S1", role: "developer", model: "sonnet", effort: null, max_budget_usd: 1.5 },
    });
  }
  function stageEvent(ws: BuildWorkspace, ts: string, type: "stage.started" | "stage.failed", payload: Record<string, unknown>): void {
    EventLog.forRun(ws.runDir).append({ ts, run: ws.runId, stage: "build", type, actor: "facilitator", cost_usd: 0, payload });
  }

  test("the reviewer's repro: one bare agent.spawned on the live attempt is NOT unmetered and carries no lower-bound marker", () => {
    const ws = workspace(ONE_STORY);
    stageEvent(ws, "2026-09-14T12:00:00Z", "stage.started", { phase: "04-build", mode: "headless", executor: "04-build" });
    spawned(ws, "2026-09-14T12:00:01Z");

    const cost = buildStoryCost(ws.runDir);
    expect(cost).not.toBeNull();
    expect(cost!.rows.map((r) => r.story)).toEqual(["S1"]);
    expect(cost!.unmeteredStories).toEqual([]);
    expect(cost!.unmeteredTurns).toBe(0);
    expect(renderStoryCost(cost!)).not.toContain(LOWER_BOUND_MARK);
  });

  test("the same spawn is LOST once its stage has failed — and once a later stage.started has superseded it", () => {
    const failed = workspace(ONE_STORY);
    stageEvent(failed, "2026-09-14T12:00:00Z", "stage.started", { phase: "04-build", mode: "headless", executor: "04-build" });
    spawned(failed, "2026-09-14T12:00:01Z");
    stageEvent(failed, "2026-09-14T12:00:02Z", "stage.failed", { phase: "04-build", reason: "the executor threw" });
    const afterFailure = buildStoryCost(failed.runDir)!;
    expect(afterFailure.unmeteredStories).toEqual(["S1"]);
    expect(afterFailure.unmeteredTurns).toBe(1);
    expect(renderStoryCost(afterFailure)).toContain(LOWER_BOUND_MARK);

    const superseded = workspace(ONE_STORY);
    stageEvent(superseded, "2026-09-14T12:00:00Z", "stage.started", { phase: "04-build", mode: "headless", executor: "04-build" });
    spawned(superseded, "2026-09-14T12:00:01Z");
    // A crash nothing wrote down, then the operator re-entered the stage.
    stageEvent(superseded, "2026-09-14T13:00:00Z", "stage.started", { phase: "04-build", mode: "headless", executor: "04-build" });
    const afterReentry = buildStoryCost(superseded.runDir)!;
    expect(afterReentry.unmeteredStories).toEqual(["S1"]);
    expect(afterReentry.unmeteredTurns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #249, review round 4: a result that lands AFTER the terminal event already
// closed its slot as lost — an orphaned agent subprocess outliving a crashed or
// relaunched invocation and appending late — was counted TWICE: the real dollars
// in measuredUsd AND one lost turn on the same story. A result is proof the turn
// was metered, whenever it arrives: with no open slot for its story it retires a
// LOST one instead. Same single walk, no new vocabulary.
// ---------------------------------------------------------------------------

describe("#249 round 4 — a late result retires the lost slot it belongs to, never double-counts", () => {
  function append(ws: BuildWorkspace, ts: string, type: "stage.started" | "stage.failed" | "agent.spawned" | "agent.result", extra: Record<string, unknown>, costUsd = 0): void {
    const base = type === "agent.spawned"
      ? { actor: "developer", payload: { phase: "04-build", story: "S1", role: "developer", model: "sonnet", effort: null, max_budget_usd: 1.5 } }
      : type === "agent.result"
        ? { actor: "developer", payload: { phase: "04-build", task: "t1", key: "S1", session_id: "late-developer-S1", model: "sonnet", outputs: [], tldrx_version: "0.25.0" } }
        : { actor: "facilitator", payload: { phase: "04-build", mode: "headless", executor: "04-build", ...extra } };
    EventLog.forRun(ws.runDir).append({ ts, run: ws.runId, stage: "build", type, cost_usd: costUsd, ...base });
  }

  test("stage.failed, then the late result: measured $0.25 and NOTHING flagged", () => {
    const ws = workspace(ONE_STORY);
    append(ws, "2026-09-14T12:00:00Z", "stage.started", {});
    append(ws, "2026-09-14T12:00:01Z", "agent.spawned", {});
    append(ws, "2026-09-14T12:00:02Z", "stage.failed", { reason: "the executor threw" });
    append(ws, "2026-09-14T12:00:03Z", "agent.result", {}, 0.25);

    const cost = buildStoryCost(ws.runDir)!;
    const s1 = cost.rows.find((r) => r.story === "S1");
    expect(s1?.measuredUsd).toBe(0.25);
    expect(cost.unmeteredTurns).toBe(0);
    expect(cost.unmeteredStories).toEqual([]);
    expect(renderStoryCost(cost)).not.toContain(LOWER_BOUND_MARK);
  });

  test("relaunch: the new stage.started precedes the old attempt's result — still $0.25, nothing flagged", () => {
    const ws = workspace(ONE_STORY);
    append(ws, "2026-09-14T12:00:00Z", "stage.started", {});
    append(ws, "2026-09-14T12:00:01Z", "agent.spawned", {});
    append(ws, "2026-09-14T13:00:00Z", "stage.started", {});
    append(ws, "2026-09-14T13:00:01Z", "agent.result", {}, 0.25);

    const cost = buildStoryCost(ws.runDir)!;
    expect(cost.rows.find((r) => r.story === "S1")?.measuredUsd).toBe(0.25);
    expect(cost.unmeteredTurns).toBe(0);
    expect(cost.unmeteredStories).toEqual([]);
  });
});
