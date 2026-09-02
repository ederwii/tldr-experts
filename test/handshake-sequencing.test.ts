/**
 * A handshake called in the WRONG ORDER is a refusal, not a stage failure (gh #82).
 *
 * The evidence is one night on the live run `260901-leaderboard-v2`
 * (2026-09-02T00:36Z). The driver ran `tldrx next --commit --review` while no
 * reviewer bundle was out. The framework said the right thing —
 * "no reviewer bundle is out — run `tldrx next --prepare --review` first" — and
 * then did the wrong thing with it: `stage.failed` twice, `status: failed` on the
 * run, and an explicit recovery before any work could continue.
 *
 * Nothing had been attempted. No sub-agent was spawned, no cent was metered, no
 * branch moved, no story changed status. The ONLY thing wrong was the order two
 * commands were typed in, and the fix for it was already printed on the screen.
 *
 * The framework already gets this exactly right one layer over: a single-agent
 * stage sent `--commit` before its `--prepare` returns `EXIT_USAGE` with
 * "run `tldrx next --prepare` first" and touches nothing (`commitStage`,
 * runNext.ts). Build was the outlier, because Build owns its own middle and its
 * refusals came back as `ok: false` — which `runNext` can only read as a failed
 * stage. These tests hold Build to the behaviour the other path already has.
 *
 * The invariant, in the words of the issue: exit non-zero, name the fix, and
 * leave the run state UNTOUCHED.
 *
 * "Untouched" is measured as BYTES. `run.yml` is read before and after and
 * compared whole — not field by field, because a field-by-field check only ever
 * catches the fields somebody thought of, and the field this bug moved
 * (`status`) is one nobody thought of. The `stage.failed` count is asserted
 * beside it: a `run.yml` that came back identical because two writes cancelled
 * out would still be a bug, and the event log is where that would show.
 *
 * The last group is the guard rail. A story whose Definition of Done goes red,
 * and a plan that cannot be loaded, are FAILURES — work was attempted, or
 * something is genuinely broken — and they must keep flipping the stage exactly
 * as they did. A fix that made every refusal free would pass everything above
 * and be worse than the bug.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR",
  "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
] as const;

/** The words the live run's reviewer died with, verbatim. */
const DIED = "Reached maximum budget ($1)";

/**
 * A `dod` command that is GREEN on the base tree and red once the developer has
 * written its file — so a red DoD is the story's own fault, not the workspace's.
 * A plain `exit 1` is refused by the base-tree pre-flight instead (issue #41),
 * which is a different refusal and not the one this pins.
 */
const RED_ONLY_AFTER_DEVELOPER =
  'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"';

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
    at: "2026-09-02T09:00:00Z",
    ...overrides,
  });
}

/** `run.yml` as bytes — the whole state, so nothing has to be guessed at. */
function runYaml(ws: BuildWorkspace): string {
  return readFileSync(join(ws.runDir, "run.yml"), "utf8");
}

/**
 * The same bytes with `updated_at` blanked.
 *
 * `RunStore.save()` stamps `updated_at` from the wall clock on every write, so a
 * refusal that had to UNDO something — the `running` stamp an invocation puts on
 * a stage that was not running yet — moves that one line by construction, and
 * only that one. Blanking it is what lets "nothing else moved" be asserted over
 * the whole file rather than over a hand-picked list of fields.
 *
 * The refusal this issue is actually about writes nothing at all, and the live
 * shape asserts the raw bytes to prove it.
 */
function runState(ws: BuildWorkspace): string {
  return runYaml(ws).replace(/^updated_at: .*$/m, "updated_at: <clock>");
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function countOf(ws: BuildWorkspace, type: string): number {
  return events(ws).filter((e) => e.type === type).length;
}

function runStatus(ws: BuildWorkspace): string {
  return RunStore.open(ws.runDir).run.status;
}

function stageStatus(ws: BuildWorkspace): string | undefined {
  return RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages).find((s) => s.id === "build")?.status;
}

function storyFile(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

/** Every `claude` invocation the fake recorded — an empty log is a measurement. */
function spawns(ws: BuildWorkspace): readonly string[] {
  const path = join(ws.root, "argv.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

function countSpawns(ws: BuildWorkspace): void {
  process.env.FAKE_BUILD_ARGV_LOG = join(ws.root, "argv.jsonl");
}

/**
 * What every sequencing refusal must be: the run untouched, the fix named, and a
 * non-zero exit.
 *
 * The state assertions come FIRST on purpose. This helper is the red-first proof
 * for gh #82, and the failure it has to report is "the run moved", not "the exit
 * code was 5" — an exit code asserted first would mask the damage underneath it.
 *
 * Everything is snapshotted before the out-of-order command and compared after,
 * rather than asserted against literals, so it says "unchanged" rather than
 * "equal to what I expected".
 */
async function refusesWithoutTouchingAnything(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions>,
  says: string,
): Promise<void> {
  countSpawns(ws);
  const before = runState(ws);
  const failedBefore = countOf(ws, "stage.failed");
  const stageBefore = stageStatus(ws);

  const outcome = await next(ws, overrides);

  // The whole issue, in four lines.
  expect(runState(ws)).toBe(before);
  expect(countOf(ws, "stage.failed")).toBe(failedBefore);
  expect(stageStatus(ws)).toBe(stageBefore as string);
  expect(runStatus(ws)).not.toBe("failed");

  // It still refuses, and it still says what to run instead.
  expect(outcome.lines.join("\n")).toContain(says);
  // Non-zero, and specifically the code the single-agent path already returns for
  // this exact mistake (spec §3: 1 = "you asked for something impossible").
  expect(outcome.code).toBe(1);
  expect(spawns(ws)).toEqual([]);
}

// ---------------------------------------------------------------------------

describe("a handshake called out of order refuses and changes nothing (gh #82)", () => {
  test("the live shape: `--commit --review` with no reviewer bundle out", async () => {
    const ws = workspace();
    // A developer bundle IS out — the stage is `running`, mid-handshake, exactly
    // where `260901-leaderboard-v2` stood — and the driver reaches for the
    // reviewer's half of it.
    expect((await next(ws, { mode: "prepare" })).code).toBe(0);
    expect(stageStatus(ws)).toBe("running");
    const bytes = runYaml(ws);

    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", review: true, at: "2026-09-02T09:10:00Z" },
      "no reviewer bundle is out",
    );

    // The strict bar, and the one the issue asks for: on the shape it was
    // written from, the refusal does not write a single byte — not even the
    // `updated_at` clock, because nothing calls `save()` at all.
    expect(runYaml(ws)).toBe(bytes);

    // What was mid-flight is still mid-flight: `--prepare`'s bundle is still the
    // thing to answer, not something to re-issue.
    expect(stageStatus(ws)).toBe("running");
    expect(existsSync(join(ws.runDir, ".agent", "build", "S1", "result.json"))).toBe(false);
    expect(storyFile(ws, "S1")).toContain("status: in_progress");
  });

  test("`--commit` with no story in progress", async () => {
    const ws = workspace();
    // A fresh Build stage: nothing prepared, so the developer half has nothing to
    // settle. The same mistake in the other role.
    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", at: "2026-09-02T09:10:00Z" },
      "no story is `in_progress`",
    );
    // Back to `pending` — where the cursor found it, and where the `--prepare`
    // that actually starts this cycle expects to find it.
    expect(stageStatus(ws)).toBe("pending");
  });

  test("`--prepare --review` before the developer half has run", async () => {
    const ws = workspace();
    // The reviewer's bundle asked for over a story with no merged commit. The
    // message already names the fix; this is about what it does to the run.
    await refusesWithoutTouchingAnything(
      ws,
      { mode: "prepare", review: true, at: "2026-09-02T09:10:00Z" },
      "has no merged commit to review",
    );
    expect(stageStatus(ws)).toBe("pending");
  });

  test("`--commit` before the host has written result.json", async () => {
    const ws = workspace();
    expect((await next(ws, { mode: "prepare" })).code).toBe(0);

    // The bundle is out and the host has not answered it yet. "Write the file,
    // then run the same command again" is a step in the handshake, not a failure.
    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", at: "2026-09-02T09:10:00Z" },
      "must write it before `next --commit`",
    );
    expect(stageStatus(ws)).toBe("running");
  });

  test("`--commit --review` before the host has written the reviewer's result.json", async () => {
    const ws = workspace();
    await stallAtReviewInSession(ws);
    expect((await next(ws, { mode: "prepare", review: true, at: "2026-09-02T09:10:00Z" })).code).toBe(0);

    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", review: true, at: "2026-09-02T09:20:00Z" },
      "must write it before `next --commit`",
    );
    expect(stageStatus(ws)).toBe("running");
  });

  /**
   * The consequence the live run actually paid for, pinned on its own.
   *
   * `runExecutor` skips the phase-budget gate when the stage is already
   * `running`, because a Build stage hands out one story per `--prepare` /
   * `--commit` cycle and re-pricing the whole stage on cycle 2 would refuse it
   * every time. Failing the stage on a sequencing refusal demoted it OUT of
   * `running`, so the very next `--prepare` was priced as a fresh start and the
   * run took a `budget.blocked` it had not earned.
   *
   * This is the live event sequence reproduced — `stage.failed` at
   * events.jsonl L79, `budget.blocked` at L80, ten seconds apart, $2.66 left
   * against a re-charged $4.32 estimate. A refusal that leaves the stage alone
   * never reaches that gate at all.
   */
  test("the refusal does not re-price the stage: the next `--prepare` is not budget-blocked", async () => {
    const ws = workspace({ ...ONE_STORY, budgetUsd: 4 });
    await stallAtReviewInSession(ws, 1.2);
    expect(stageStatus(ws)).toBe("running");
    const blockedBefore = countOf(ws, "budget.blocked");

    await next(ws, { mode: "commit", review: true, at: "2026-09-02T09:40:00Z" });
    const prepared = await next(ws, { mode: "prepare", at: "2026-09-02T09:50:00Z" });

    expect(countOf(ws, "budget.blocked")).toBe(blockedBefore);
    expect(prepared.code).toBe(0);
  });
});

describe("a genuine failure still fails the stage (gh #82 must not widen)", () => {
  test("a red Definition of Done still blocks the story", async () => {
    const ws = workspace({ ...ONE_STORY, testScript: RED_ONLY_AFTER_DEVELOPER });

    const outcome = await next(ws);

    // Work WAS attempted and the story cannot prove itself: not a refusal.
    expect(outcome.code).not.toBe(1);
    expect(storyFile(ws, "S1")).toContain("status: blocked");
  });

  test("a reviewer that DIES is still recorded as a failure, not waved through", async () => {
    const ws = workspace();
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";

    await next(ws);

    // The spawn layer's error reaches the ledger as a failed check; the story
    // does not reach `done` on a review nobody gave.
    expect(countOf(ws, "check.failed")).toBeGreaterThan(0);
    expect(storyFile(ws, "S1")).not.toContain("status: done");
  });

  test("a plan that cannot be loaded is a stage failure, with `stage.failed` and a failed run", async () => {
    const ws = workspace();
    // The plan the executor must read, made unreadable. Nothing about this is an
    // order-of-commands mistake, and no other command fixes it.
    writeFileSync(join(ws.planDir, "waves.yml"), "waves: [[[\n", "utf8");

    const outcome = await next(ws, { at: "2026-09-02T09:10:00Z" });

    expect(outcome.code).toBe(5);
    expect(countOf(ws, "stage.failed")).toBe(1);
    expect(runStatus(ws)).toBe("failed");
    expect(stageStatus(ws)).toBe("failed");
  });
});

/**
 * Drive S1 to `review` through the IN-SESSION doors with its reviewer dead — the
 * live run's exact shape: a merged commit, a green DoD, no verdict, and a stage
 * left `running` rather than at its gate.
 *
 * `declared` is what the host says the developer turn cost, so a test about the
 * phase budget has real money spent in it rather than a $0.00 ledger.
 */
async function stallAtReviewInSession(ws: BuildWorkspace, declared = 0): Promise<void> {
  process.env.FAKE_BUILD_COST = "0";
  process.env.FAKE_BUILD_FAIL_REASON = DIED;
  process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
  await next(ws, { mode: "prepare" });
  writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1\n", "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", "S1", "result.json"),
    JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: declared }),
    "utf8",
  );
  await next(ws, { mode: "commit", at: "2026-09-02T09:30:00Z" });
  expect(storyFile(ws, "S1")).toContain("status: review");
}

/**
 * The refusal has to come BEFORE the event, not after it (gh #87).
 *
 * `runExecutor` stamps a stage `running` and appends `stage.started` on its way
 * in, before the executor has had a chance to say anything. #82 restores the
 * STATUS when the executor turns out to be refusing a sequencing mistake, so
 * `run.yml` comes back correct — but events.jsonl is append-only truth and the
 * line cannot be unwritten. The live run left one behind on 2026-09-02T00:36:37Z:
 * a `stage.started` with no matching `stage.done` or `stage.failed`, which
 * `renderReplay` and anything counting starts read as a start.
 *
 * Measured as the WHOLE log, not as a `stage.started` count: a refusal that
 * writes nothing must write nothing, and a count only ever catches the one event
 * somebody thought of.
 */
describe("an out-of-order `--commit` writes no event either (gh #87)", () => {
  test("`--commit` with no story in progress appends nothing to events.jsonl", async () => {
    const ws = workspace();
    const before = events(ws).length;
    const startedBefore = countOf(ws, "stage.started");

    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", at: "2026-09-02T09:10:00Z" },
      "no story is `in_progress`",
    );

    // The whole issue: a `--commit` never STARTS a stage — it settles a cycle a
    // `--prepare` started — so there is no true `stage.started` to write here.
    expect(countOf(ws, "stage.started")).toBe(startedBefore);
    expect(events(ws).length).toBe(before);
  });

  test("`--commit --review` on a stage nothing has prepared appends nothing either", async () => {
    const ws = workspace();
    const before = events(ws).length;

    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", review: true, at: "2026-09-02T09:10:00Z" },
      "no reviewer bundle is out",
    );

    expect(countOf(ws, "stage.started")).toBe(0);
    expect(events(ws).length).toBe(before);
  });
});

/**
 * An UNREADABLE `result.json` is treated like an absent one, LOUDLY (gh #88).
 *
 * Owner decision, 2026-09-02: nothing was attempted here either — no sub-agent
 * ran, no cent moved, no branch changed — and the fix is the same shape as the
 * `absent` one, which is to rewrite the file and run the same command again.
 * Failing the stage actively obstructs that fix: it demotes the stage out of
 * `running`, and the phase-budget gate is skipped exactly when a stage IS
 * `running`, which is how #82's live run took a `budget.blocked` it had not
 * earned. A host that fat-fingers its JSON must not pay that tax.
 *
 * The other half of the decision is what stops this being a framework that
 * shrugs at broken artefacts: corruption never passes silently. A typed event
 * lands in events.jsonl naming the file and the parse error, so the log says a
 * host wrote something it could not read even though the run did not move.
 */
describe("an unreadable result.json refuses loudly instead of failing the stage (gh #88)", () => {
  test("the developer envelope: not valid JSON", async () => {
    const ws = workspace();
    expect((await next(ws, { mode: "prepare" })).code).toBe(0);
    const path = join(ws.runDir, ".agent", "build", "S1", "result.json");
    writeFileSync(path, "{ outputs: [s1.txt]  <- not JSON\n", "utf8");

    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", at: "2026-09-02T09:10:00Z" },
      "is not valid JSON",
    );
    // The bundle is still out and the stage is still mid-handshake: rewrite the
    // file and run the SAME command again.
    expect(stageStatus(ws)).toBe("running");

    const loud = events(ws).filter((e) => e.type === "result.unreadable");
    expect(loud).toHaveLength(1);
    expect(String(loud[0]!.payload.path)).toContain("result.json");
    expect(String(loud[0]!.payload.error)).not.toBe("");
    expect(String(loud[0]!.payload.error)).toContain("not valid JSON");
  });

  test("the developer envelope: valid JSON that is not an object", async () => {
    const ws = workspace();
    expect((await next(ws, { mode: "prepare" })).code).toBe(0);
    writeFileSync(join(ws.runDir, ".agent", "build", "S1", "result.json"), "[1, 2, 3]\n", "utf8");

    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", at: "2026-09-02T09:10:00Z" },
      "must be a JSON object",
    );
    expect(stageStatus(ws)).toBe("running");
    expect(events(ws).filter((e) => e.type === "result.unreadable")).toHaveLength(1);
  });

  test("the reviewer envelope gets the same door", async () => {
    const ws = workspace();
    await stallAtReviewInSession(ws);
    expect((await next(ws, { mode: "prepare", review: true, at: "2026-09-02T09:10:00Z" })).code).toBe(0);
    writeFileSync(join(ws.runDir, ".agent", "build", "S1", "review", "result.json"), "{{\n", "utf8");

    await refusesWithoutTouchingAnything(
      ws,
      { mode: "commit", review: true, at: "2026-09-02T09:20:00Z" },
      "is not valid JSON",
    );
    expect(stageStatus(ws)).toBe("running");

    const loud = events(ws).filter((e) => e.type === "result.unreadable");
    expect(loud).toHaveLength(1);
    expect(String(loud[0]!.payload.role)).toBe("reviewer");
  });
});
