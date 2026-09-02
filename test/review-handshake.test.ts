/**
 * `next --prepare --review` / `--commit --review` — the reviewer as the second
 * delegable role (design §B.3).
 *
 * The finding it is built for is one night's measurement on the live run
 * `260830-tenancy-identity-customers`: story S3, a 100-file diff, sat at
 * `review` after the framework's spawned reviewer died at its $1.00 cap — and
 * the path that was supposed to rescue it SPAWNED ANOTHER metered reviewer under
 * `tldrx next --prepare`, which a two-minute host timeout then killed mid-read.
 * A `--prepare` that spawns is not a `--prepare`.
 *
 * So the properties worth a test each are:
 *
 *   - `--prepare` on a story awaiting review writes the bundle and spawns NOTHING;
 *   - the bundle's `prompt.md` is byte-identical to what the spawn would have sent;
 *   - `--commit --review` over an `approve` envelope settles the story `done`;
 *   - over a `changes` envelope it follows the EXISTING requeue rules, unchanged;
 *   - an envelope it cannot read is `changes`, never `approve` (fail-closed);
 *   - on `attended_by: host` the whole story cycle emits zero `agent.spawned`;
 *   - and the live run's shape — `review` + an errored-review ledger + a merged
 *     commit — round-trips through the new path.
 *
 * "Spawns nothing" is asserted from the fake `claude` itself: it logs its argv on
 * every invocation, before it does anything else, so an empty log is the process
 * saying it was never run rather than a test believing it was not.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { attendRun } from "../src/core/run/attend.ts";
import { reject } from "../src/core/run/gates.ts";
import { REVIEW_DIR, reviewBundles } from "../src/core/run/prepared.ts";
import { REVIEW_SCHEMA } from "../src/core/build/prompts.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR",
  "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
] as const;

/** The words the live run's reviewer died with, verbatim. */
const DIED = "Reached maximum budget ($1)";

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
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

function workspace(options: BuildWorkspaceOptions = ONE_STORY): BuildWorkspace {
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
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-29T09:00:00Z",
    ...overrides,
  });
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function reviewDir(ws: BuildWorkspace, id: string): string {
  return join(ws.runDir, ".agent", "build", id, REVIEW_DIR);
}

/** Every `claude` invocation the fake recorded, however it was called. */
function spawns(ws: BuildWorkspace): readonly string[] {
  const path = join(ws.root, "argv.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

/** Log every spawn, so "nothing was spawned" is a measurement, not a belief. */
function countSpawns(ws: BuildWorkspace): void {
  process.env.FAKE_BUILD_ARGV_LOG = join(ws.root, "argv.jsonl");
}

/** The host's answer, written where `--commit --review` reads it. */
function answerReview(ws: BuildWorkspace, id: string, envelope: unknown): void {
  writeFileSync(join(reviewDir(ws, id), "result.json"), `${JSON.stringify(envelope)}\n`, "utf8");
}

/** Send the stage back so the next invocation re-enters it (the operator's move). */
function reenter(ws: BuildWorkspace, note: string): void {
  reject(RunStore.open(ws.runDir), { root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note });
}

/**
 * Drive one story to `review` with an ERRORED reviewer on the ledger — the live
 * run's exact shape: a merged commit, a green DoD, and no verdict — and leave the
 * stage re-enterable.
 */
async function stallAtReview(ws: BuildWorkspace): Promise<void> {
  process.env.FAKE_BUILD_COST = "0";
  process.env.FAKE_BUILD_FAIL_REASON = DIED;
  process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
  await next(ws);
  expect(story(ws, "S1")).toContain("status: review");
  reenter(ws, "the reviewer died at its cap");
}

/**
 * The same stall, reached through the IN-SESSION doors — which is how the live
 * run reached it, and which leaves the stage `running` with later stories still
 * to do rather than at its gate.
 */
async function stallAtReviewInSession(ws: BuildWorkspace): Promise<void> {
  process.env.FAKE_BUILD_COST = "0";
  process.env.FAKE_BUILD_FAIL_REASON = DIED;
  process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
  await next(ws, { mode: "prepare" });
  writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1\n", "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", "S1", "result.json"),
    JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
    "utf8",
  );
  await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
  expect(story(ws, "S1")).toContain("status: review");
}

// ---------------------------------------------------------------------------

describe("--prepare on a story awaiting review", () => {
  test("writes the reviewer bundle and spawns NOTHING", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    // Only from here: the run above spawned for real, and it is the state this
    // test starts from, not the thing it measures.
    countSpawns(ws);

    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    expect(prepared.code).toBe(0);
    expect(spawns(ws)).toEqual([]);
    expect(existsSync(join(reviewDir(ws, "S1"), "prompt.md"))).toBe(true);
    expect(existsSync(join(reviewDir(ws, "S1"), "pending.json"))).toBe(true);
    // Not settled — the verdict is the host's to write.
    expect(story(ws, "S1")).toContain("status: review");
    const said = prepared.lines.join("\n");
    expect(said).toContain("prepared the REVIEW of S1");
    expect(said).toContain("tldrx next --commit --review");
  }, 60_000);

  test("the bundle carries the diff refs, the recovered DoD and the result contract", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    const pending = JSON.parse(readFileSync(join(reviewDir(ws, "S1"), "pending.json"), "utf8")) as {
      expert: string; role: string; story: string; result_schema: unknown;
      review: { diff: string; commit: string; branch: string; epic_branch: string; dod: unknown[] };
    };
    expect(pending.expert).toBe("reviewer");
    expect(pending.role).toBe("reviewer");
    expect(pending.story).toBe("S1");
    // The envelope shape, so the host does not have to read our source for it.
    expect(pending.result_schema).toEqual(REVIEW_SCHEMA as unknown as Record<string, unknown>);
    expect(pending.review.epic_branch).toBe("epic/e1");
    expect(pending.review.branch).toBe(`story/${ws.runId}/S1`);
    expect(pending.review.diff).toContain("epic/e1");
    expect(pending.review.diff).toContain(`story/${ws.runId}/S1`);
    // Recovered from the ledger, not re-run: the DoD went green in the cycle that
    // produced the commit, and that fact has not changed.
    expect(pending.review.dod).toEqual([{ command: "npm run test", exit_code: 0 }]);
    expect(pending.review.commit).toMatch(/^[0-9a-f]{7,40}$/);
  }, 60_000);

  test("the bundle's prompt is byte-identical to what a spawn would have sent", async () => {
    const ws = workspace();
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    await stallAtReview(ws);
    // What the spawned reviewer of this same story was actually handed.
    const spawned = readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8");

    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    // One line differs and it is not the renderer's: the prompt inlines the story
    // FILE, and the story has legitimately moved from `todo` to `review` between
    // the two processes. Everything else — the objective, the diff command, the
    // acceptance criteria, the DoD, the conventions, the envelope rules — is the
    // same bytes, because it is the same `buildReviewerPrompt` call.
    const bundled = readFileSync(join(reviewDir(ws, "S1"), "prompt.md"), "utf8");
    const withoutStatus = (text: string): string => text.replace(/^status: \w+$/m, "status: <state>");
    expect(withoutStatus(bundled)).toBe(withoutStatus(spawned));
    expect(bundled).toContain(`git diff epic/e1...story/${ws.runId}/S1`);
  }, 60_000);

  test("--prepare --review names the story with no merged commit rather than preparing one", async () => {
    const ws = workspace();
    countSpawns(ws);

    const outcome = await next(ws, { mode: "prepare", review: true });

    // Exit 1 — the same shape `commit()` uses for "no story is in_progress": a
    // half of the handshake asked for over work that has not reached it yet.
    //
    // It was exit 5, a stage FAILURE, until gh #82. Nothing here was attempted,
    // nothing was spent and nothing is broken; the only thing wrong is the order,
    // and the line below already says which command fixes it. What the stage does
    // about that is pinned in test/handshake-sequencing.test.ts.
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("S1 has no merged commit to review");
    expect(outcome.lines.join("\n")).toContain("tldrx next --prepare");
    expect(spawns(ws)).toEqual([]);
    expect(reviewBundles(ws.runDir, "build")).toEqual([]);
  }, 60_000);
});

describe("--commit --review", () => {
  test("an `approve` envelope settles the story `done`, unmetered", async () => {
    const ws = workspace(TWO_WAVES);
    await stallAtReviewInSession(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    countSpawns(ws);

    answerReview(ws, "S1", { verdict: "approve", summary: "read the diff by hand", findings: [] });
    const settled = await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });

    expect(spawns(ws)).toEqual([]);
    expect(story(ws, "S1")).toContain("status: done");
    expect(settled.lines.join("\n")).toContain("S1 → `done` (host review, unmetered)");
    // The verdict went down the same ledger line a spawn's does, and says whose.
    const review = events(ws).filter((e) => e.payload.check === "review");
    expect(review.map((e) => [e.payload.verdict, e.payload.source]))
      .toEqual([["error", undefined], ["approve", "host"]]);
    // No `agent.spawned` for the host's review; a `task.started` for it instead.
    const started = events(ws).filter((e) => e.type === "task.started" && e.payload.role === "reviewer");
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.mode).toBe("prepare");
    // Unmetered: `null` + `metered: false`, never a `$0.00` that reads as measured.
    const tasks = RunStore.open(ws.runDir).run.phases
      .flatMap((p) => p.stages).flatMap((s) => s.tasks)
      .filter((t) => t.metered === false);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.cost_usd).toBeNull();
    // A settled handshake leaves the log, not the bundle.
    expect(reviewBundles(ws.runDir, "build")).toEqual([]);
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain("read the diff by hand");
  }, 60_000);

  test("a `changes` envelope follows the EXISTING requeue rules", async () => {
    const ws = workspace(TWO_WAVES);
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    answerReview(ws, "S1", { verdict: "changes", summary: "the criteria are not met", findings: ["fix it"] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });

    // One `changes` at attempt 1 requeues, exactly as a spawned one does.
    expect(story(ws, "S1")).toContain("status: review");
    // And the requeue is REAL: the next --prepare offers the DEVELOPER again,
    // because a story the reviewer faulted is owed its second attempt.
    const again = await next(ws, { mode: "prepare", at: "2026-08-29T10:30:00Z" });
    expect(again.lines.join("\n")).toContain("prepared S1");
    expect(again.lines.join("\n")).not.toContain("prepared the REVIEW");
    expect(story(ws, "S1")).toContain("status: in_progress");
  }, 60_000);

  test("a second `changes` blocks the story — MAX_ATTEMPTS is untouched", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    answerReview(ws, "S1", { verdict: "changes", summary: "round one", findings: [] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });

    // Attempt 2: developer, then a second host review that also asks for changes.
    await next(ws, { mode: "prepare", at: "2026-08-29T10:30:00Z" });
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "again\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
      "utf8",
    );
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes"] });
    await next(ws, { mode: "commit", at: "2026-08-29T10:40:00Z" });

    expect(story(ws, "S1")).toContain("status: blocked");
  }, 60_000);

  test("an envelope it cannot read is `changes`, never `approve`", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    // Present, parseable JSON, and meaningless — it declares no `verdict` at
    // all. Fail-closed: an unreadable verdict must never buy a sign-off.
    //
    // gh #79 changed WHEN it is written down, not what it is written down as.
    // An envelope refused for its SHAPE now buys a bounded free correction
    // (`MAX_FORMAT_RETRIES`), so the first two are re-prompted and the third is
    // recorded as the `changes` this always fell to. Never `approve`, at any
    // point in that sequence — which is the invariant this test is named for.
    const verdicts = (): readonly unknown[] =>
      events(ws).filter((e) => e.payload.check === "review").map((e) => e.payload.verdict);
    for (const at of ["10:20", "10:30", "10:40"]) {
      answerReview(ws, "S1", { nonsense: true });
      await next(ws, { mode: "commit", review: true, at: `2026-08-29T${at}:00Z` });
      expect(verdicts()).not.toContain("approve");
    }

    expect(story(ws, "S1")).toContain("status: review");
    expect(verdicts().at(-1)).toBe("changes");
  }, 90_000);

  test("with no bundle out it says so, and settles nothing", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    countSpawns(ws);

    const outcome = await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });

    // Exit 1, not the 5 this asserted until gh #82: the live run that earned this
    // message had its stage and its whole run marked `failed` over a mistyped
    // command. "Settles nothing" is now the smaller half of the promise — it also
    // CHANGES nothing (test/handshake-sequencing.test.ts).
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("no reviewer bundle is out");
    expect(story(ws, "S1")).toContain("status: review");
    expect(spawns(ws)).toEqual([]);
  }, 60_000);
});

describe("attended_by: host", () => {
  /** Everything a host does for one story, without ever letting the framework spawn. */
  async function driveStoryAsHost(ws: BuildWorkspace, verdict: string): Promise<void> {
    await next(ws, { mode: "prepare" });
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "host\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
      "utf8",
    );
    await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
    answerReview(ws, "S1", { verdict, summary: `host says ${verdict}`, findings: [] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T09:40:00Z" });
  }

  test("half B routes through the handshake: a full story cycle spawns nothing", async () => {
    const ws = workspace(TWO_WAVES);
    attendRun({ root: ws.root, attendedBy: "host", actor: "alan", at: "2026-08-29T08:00:00Z" });
    countSpawns(ws);

    await driveStoryAsHost(ws, "approve");

    expect(spawns(ws)).toEqual([]);
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toEqual([]);
    expect(story(ws, "S1")).toContain("status: done");
  }, 60_000);

  test("`--commit` hands the review over instead of spawning one, and says which command", async () => {
    const ws = workspace(TWO_WAVES);
    attendRun({ root: ws.root, attendedBy: "host", actor: "alan", at: "2026-08-29T08:00:00Z" });
    countSpawns(ws);

    await next(ws, { mode: "prepare" });
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "host\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
      "utf8",
    );
    const committed = await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });

    expect(spawns(ws)).toEqual([]);
    const said = committed.lines.join("\n");
    expect(said).toContain("its review is the host's");
    expect(said).toContain("tldrx next --commit --review");
    // Merged and parked, not settled: the story is at `review` with a bundle out
    // and NOT reported as done or blocked.
    expect(story(ws, "S1")).toContain("status: review");
    expect(said).not.toContain("S2 is next");
    expect(reviewBundles(ws.runDir, "build")).toHaveLength(1);
  }, 60_000);

  test("a bare `tldrx next` points at the REVIEW half when a review bundle is out", async () => {
    const ws = workspace(TWO_WAVES);
    attendRun({ root: ws.root, attendedBy: "host", actor: "alan", at: "2026-08-29T08:00:00Z" });
    await next(ws, { mode: "prepare" });
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "host\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
      "utf8",
    );
    await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
    countSpawns(ws);

    const refused = await next(ws, { at: "2026-08-29T09:35:00Z" });

    expect(refused.code).toBe(4);
    const said = refused.lines.join("\n");
    expect(said).toContain("has a REVIEW bundle out and is waiting for its verdict");
    expect(said).toContain(`tldrx next --commit --review ${ws.runId}`);
    expect(spawns(ws)).toEqual([]);
  }, 60_000);

  test("a `changes` verdict from the host requeues the developer, still without spawning", async () => {
    const ws = workspace(TWO_WAVES);
    attendRun({ root: ws.root, attendedBy: "host", actor: "alan", at: "2026-08-29T08:00:00Z" });
    countSpawns(ws);

    await driveStoryAsHost(ws, "changes");

    expect(spawns(ws)).toEqual([]);
    expect(story(ws, "S1")).toContain("status: review");
    const again = await next(ws, { mode: "prepare", at: "2026-08-29T09:50:00Z" });
    expect(again.lines.join("\n")).toContain("prepared S1");
    expect(spawns(ws)).toEqual([]);
  }, 60_000);
});

describe("the live run's shape", () => {
  /**
   * `260830-tenancy-identity-customers` / S3 on 2026-08-31, reproduced: the story
   * is `review`, its last reviewer errored, its commit is merged, and a LATER
   * `task.started … resumed: review` + `agent.spawned … role: reviewer` sit at the
   * end of the ledger with no check after them — the host timeout killed that
   * second reviewer mid-read, so it recorded no verdict at all.
   */
  test("review + an errored-review ledger + a merged commit round-trips", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    // The killed second spawn, recorded exactly as the live run recorded it.
    for (const type of ["task.started", "agent.spawned"]) {
      appendFileSync(join(ws.runDir, "events.jsonl"), `${JSON.stringify({
        ts: "2026-08-31T06:10:22Z",
        run: ws.runId,
        stage: "build",
        type,
        actor: "facilitator",
        cost_usd: 0,
        payload: type === "task.started"
          ? { phase: "04-build", story: "S1", wave: "W1", attempt: 1, resumed: "review" }
          : { phase: "04-build", story: "S1", role: "reviewer", max_budget_usd: 1 },
      })}\n`, "utf8");
    }
    countSpawns(ws);

    const prepared = await next(ws, { mode: "prepare", at: "2026-08-31T07:00:00Z" });

    // What the live run gets: a bundle, not a spawn, and not a developer.
    expect(spawns(ws)).toEqual([]);
    expect(prepared.lines.join("\n")).toContain("the previous reviewer FAILED");
    expect(prepared.lines.join("\n")).toContain("prepared the REVIEW of S1");
    expect(prepared.lines.join("\n")).not.toContain("dispatch ONE sub-agent with cwd");
    expect(readdirSync(reviewDir(ws, "S1")).sort()).toEqual(["pending.json", "prompt.md"]);

    answerReview(ws, "S1", { verdict: "approve", summary: "host read all 100 files", findings: [] });
    await next(ws, { mode: "commit", review: true, at: "2026-08-31T07:30:00Z" });

    expect(spawns(ws)).toEqual([]);
    expect(story(ws, "S1")).toContain("status: done");
  }, 60_000);

  test("a re-prepare KEEPS an answer already in the bundle, and says so", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    answerReview(ws, "S1", { verdict: "approve", summary: "already read it", findings: [] });
    countSpawns(ws);

    const again = await next(ws, { mode: "prepare", at: "2026-08-29T10:10:00Z" });

    // A turn somebody already paid for is not `--prepare`'s to throw away.
    expect(again.lines.join("\n")).toContain("was already in the reviewer bundle and was KEPT");
    expect(JSON.parse(readFileSync(join(reviewDir(ws, "S1"), "result.json"), "utf8")))
      .toMatchObject({ verdict: "approve" });
    expect(spawns(ws)).toEqual([]);
    // And it still settles.
    await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });
    expect(story(ws, "S1")).toContain("status: done");
  }, 60_000);

  test("--discard-pending bins the reviewer bundle too", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    expect(reviewBundles(ws.runDir, "build")).toHaveLength(1);
    countSpawns(ws);

    const again = await next(ws, { mode: "prepare", discardPending: true, at: "2026-08-29T10:10:00Z" });

    expect(again.lines.join("\n")).toContain("discarded the reviewer bundle");
    // And it is written back, because the review is still outstanding.
    expect(reviewBundles(ws.runDir, "build")).toHaveLength(1);
    expect(spawns(ws)).toEqual([]);
  }, 60_000);
});

/**
 * gh #36 — `260831-hardening-d1` / S1, 2026-08-31. The hint said only "write
 * {verdict, summary, findings}". The host, holding the GATE vocabulary from
 * `gate template`, wrote `"verdict": "sign"`. `parseReview` fail-closed it to
 * `changes` and said nothing, so a clean fix-list verification round read as a
 * second `changes`, the story went `blocked`, and it took a `story reopen` to
 * record the verdict that had been intended all along.
 *
 * Fail-closed is right and stays. The two things that were wrong: the contract
 * was never stated, and the downgrade was never announced.
 */
describe("the verdict enum is stated and an unknown one is announced (#36)", () => {
  test("--prepare's hint names the enum, not just the field names", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    const said = prepared.lines.join("\n");
    expect(said).toContain("approve | fixlist | changes");
  }, 60_000);

  test("the attended hand-over line names the enum too", async () => {
    const ws = workspace(TWO_WAVES);
    attendRun({ root: ws.root, attendedBy: "host", actor: "alan", at: "2026-08-29T08:00:00Z" });
    await next(ws, { mode: "prepare" });
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "host\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
      "utf8",
    );
    const committed = await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });

    expect(committed.lines.join("\n")).toContain("approve | fixlist | changes");
  }, 60_000);

  test("a host `sign` verdict is still `changes` — and the run SAYS the word it read", async () => {
    const ws = workspace();
    await stallAtReview(ws);
    await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    answerReview(ws, "S1", { verdict: "sign", summary: "the diff is clean", findings: [] });
    const committed = await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });

    // Loud, and attributable: the operator can see WHICH word was not
    // understood. This half is #36 itself and gh #79 does not touch it — what
    // #79 changed is the PRICE of the mistake, never the message.
    const said = committed.lines.join("\n");
    expect(said).toContain("sign");
    expect(said).toContain("approve|fixlist|changes");
    // A verdict word outside the enum is a FORM fault (#79), so the first two
    // are re-prompted for free and nothing NEW is recorded against the story.
    // Measured as a delta, because `stallAtReview` leaves an errored review of
    // its own on the ledger and that one is not a verdict this test wrote.
    const verdicts = (): readonly unknown[] =>
      events(ws).filter((e) => e.payload.check === "review").map((e) => e.payload.verdict);
    expect(verdicts()).toEqual(["error"]);
    // …and past the bound it is the fail-closed `changes` it always was.
    for (const at of ["10:30", "10:40"]) {
      answerReview(ws, "S1", { verdict: "sign", summary: "the diff is clean", findings: [] });
      await next(ws, { mode: "commit", review: true, at: `2026-08-29T${at}:00Z` });
    }
    expect(verdicts().at(-1)).toBe("changes");
  }, 90_000);
});
