/**
 * `tldrx story reopen <id>` — one story, given another run of attempts, by a person.
 *
 * The third verb of the 2026-08-30 family, and the only one a human signs.
 * `65ab09a` and `a48ec02` both stop the machine mis-reading a TRANSPORT failure
 * as a judgement, automatically. This one is for the case where the machine read
 * the run right and the owner overrules it.
 *
 * The live case these tests reproduce: `260830-tenancy-identity-customers` story
 * S3, `blocked` after two GENUINE `changes` verdicts over an empty diff. Both
 * attempts were legitimately spent, no rescue applies, and S3 gates wave 3. The
 * only reopening verb was `tldrx reject --stage`, which acts on a STAGE, and the
 * files are hand-edit-forbidden by design.
 *
 * Every test here runs the REAL pipeline against a REAL git repo, the same way
 * `build-executor.test.ts` does; only the two sub-agents are faked.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { readReviewLedger, MAX_ATTEMPTS } from "../src/core/facilitator/executors/build.ts";
import { reopenStory } from "../src/core/run/reopenStory.ts";
import { storyCommand } from "../src/cli/commands/story.ts";
import { storyBranchOf } from "../src/core/plan/branchModel.ts";
import { AS_IS_JUDGED_MARK, AS_IS_MARK, AS_IS_NOT_AHEAD_MARK, AS_IS_REVIEW_ONLY_MARK } from "../src/core/build/outcome.ts";
import { reject } from "../src/core/run/gates.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { validateEvent } from "../src/core/events/Event.ts";
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
  "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR", "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
  "FAKE_BUILD_DENIED",
] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}) {
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

/** `git` in the fixture repo, with stderr captured rather than inherited. */
function git(ws: BuildWorkspace, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: ws.repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function events(ws: BuildWorkspace): readonly { type: string; actor: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function reopen(ws: BuildWorkspace, id: string, note: string, overrides: Record<string, unknown> = {}) {
  return reopenStory({
    root: ws.root, storyId: id, note, actor: "alan", at: "2026-08-29T10:00:00Z", ...overrides,
  });
}

/** Sends the Build stage back to `ready` so `tldrx next` will run it again. */
function reenter(ws: BuildWorkspace, note: string): void {
  reject(RunStore.open(ws.runDir), { root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note });
}

/** One story, and its reviewer refuses it twice — S3's shape, in miniature. */
const ONE: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

/** The live note, near enough: what an owner actually writes at this moment. */
const WHY = "it gates wave 3 (S4, S6) and the owner has decided it ships";

// ---------------------------------------------------------------------------

describe("a story a person reopens", () => {
  async function blockedTwice(): Promise<BuildWorkspace> {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);
    expect(story(ws, "S1")).toContain("status: blocked");
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(2);
    return ws;
  }

  test("goes back to `todo`, and says what it cost and what it kept", async () => {
    const ws = await blockedTwice();

    const outcome = reopen(ws, "S1", WHY);
    const said = outcome.lines.join("\n");

    expect(outcome.code).toBe(0);
    expect(story(ws, "S1")).toContain("status: todo");
    expect(story(ws, "S1")).not.toContain("status: blocked");
    expect(said).toContain("reopened S1");
    expect(said).toContain("`blocked` → `todo`");
    expect(said).toContain(WHY);
    expect(said).toContain("2 verdict(s) were consumed before this and stay on the record");
    expect(said).toContain("its branch is kept");
    expect(said).toContain("no cost was refunded");
  });

  test("appends one story.reopened carrying the actor, the note and the prior state", async () => {
    const ws = await blockedTwice();
    reopen(ws, "S1", WHY);

    const reopened = events(ws).filter((e) => e.type === "story.reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ actor: "alan", cost_usd: 0, stage: null });
    expect(reopened[0]?.payload).toMatchObject({
      phase: "04-build",
      story: "S1",
      wave: "W1",
      from_status: "blocked",
      to_status: "todo",
      // The count the reset erases is written down at the moment it is erased.
      verdicts: 2,
      note: WHY,
    });
    // The envelope is a real §2.9 event, not a shape only this file can read.
    expect(validateEvent(reopened[0]).ok).toBe(true);
  });

  test("the two verdicts stay in the log — nothing is rewritten to make the reset true", async () => {
    const ws = await blockedTwice();
    reopen(ws, "S1", WHY);

    const verdicts = events(ws).filter((e) => e.payload.check === "review").map((e) => e.payload.verdict);
    expect(verdicts).toEqual(["changes", "changes"]);
  });

  /**
   * The reopen is the only line in the log that explains why the counter went
   * backwards. `replay` rendering nothing for it would leave a narrative showing
   * two `changes` verdicts and then a third developer turn, with nothing in
   * between — which reads as the framework losing count.
   */
  test("`tldrx replay` narrates it, with the note", async () => {
    const ws = await blockedTwice();
    reopen(ws, "S1", WHY);

    const narrative = renderReplay(loadRun(ws.root, ws.runId)!);
    expect(narrative).toContain("story S1 REOPENED by alan");
    expect(narrative).toContain("back to `todo` from `blocked`");
    expect(narrative).toContain(WHY);
  });

  test("it spends nothing and moves no stage — the run's own state is untouched", async () => {
    const ws = await blockedTwice();
    const before = RunStore.open(ws.runDir);
    const spentBefore = before.run.budget.spent_usd;
    const runYamlBefore = readFileSync(join(ws.runDir, "run.yml"), "utf8");

    reopen(ws, "S1", WHY);

    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toBe(runYamlBefore);
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(spentBefore);
  });

  /**
   * The BRANCH is what carries the work, and it is the thing a reopen must not
   * touch. The worktree of a `blocked` story is already gone by this point —
   * `settle` calls `cleanUp` for every status but `review` — so asserting "the
   * worktree survives" here would have been an assertion about `false === false`.
   */
  test("the story branch, with the last developer's commits, is untouched", async () => {
    const ws = await blockedTwice();
    const branch = `story/${ws.runId}/S1`;
    const shaBefore = git(ws, ["rev-parse", branch]);
    const worktreeBefore = existsSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`));

    reopen(ws, "S1", WHY);

    expect(git(ws, ["rev-parse", branch])).toBe(shaBefore);
    // And nothing about the worktree moved either way: reopen removes nothing
    // and creates nothing on disk but the one status line.
    expect(existsSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`))).toBe(worktreeBefore);
  });
});

describe("the reset boundary", () => {
  test("the ledger counts nothing from before the reopen", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);

    const before = readReviewLedger(ws.runDir, "S1");
    expect(before.verdicts).toBe(2);
    expect(before.reopened).toBeNull();

    reopen(ws, "S1", WHY);

    const after = readReviewLedger(ws.runDir, "S1");
    // The requeue counter, which is what decides `attempt N of MAX_ATTEMPTS`.
    expect(after.verdicts).toBe(0);
    expect(after.reopened).toMatchObject({ actor: "alan", note: WHY, at: "2026-08-29T10:00:00Z" });
    // Everything else the ledger derives restarts with it: nothing from the
    // closed run of attempts may steer the reopened one.
    expect(after.commit).toBeNull();
    expect(after.dod).toEqual([]);
    expect(after.erroredWith).toBeNull();
    expect(after.developerErroredWith).toBeNull();
    expect(after.blockedWithNothingRun).toBe(false);
  });

  test("a verdict recorded AFTER the reopen counts again, from one", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-ledger-"));
    try {
      const lines = [
        line("check.failed", { story: "S1", check: "review", verdict: "changes", attempt: 1 }),
        line("check.failed", { story: "S1", check: "review", verdict: "changes", attempt: 2 }),
        line("story.reopened", { story: "S1", from_status: "blocked", to_status: "todo", verdicts: 2, note: "again" }),
        line("check.failed", { story: "S1", check: "review", verdict: "changes", attempt: 1 }),
      ];
      writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
      const ledger = readReviewLedger(dir, "S1");
      expect(ledger.verdicts).toBe(1);
      expect(ledger.reopened?.note).toBe("again");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a reopen of ANOTHER story resets nothing here", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-ledger-"));
    try {
      const lines = [
        line("check.failed", { story: "S1", check: "review", verdict: "changes", attempt: 1 }),
        line("story.reopened", { story: "S2", from_status: "blocked", to_status: "todo", verdicts: 0, note: "x" }),
        line("check.failed", { story: "S1", check: "review", verdict: "changes", attempt: 2 }),
      ];
      writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
      const ledger = readReviewLedger(dir, "S1");
      expect(ledger.verdicts).toBe(2);
      expect(ledger.reopened).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the LAST reopen is the boundary when there are several", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-ledger-"));
    try {
      const lines = [
        line("story.reopened", { story: "S1", verdicts: 0, note: "first" }),
        line("check.failed", { story: "S1", check: "review", verdict: "changes", attempt: 1 }),
        line("check.failed", { story: "S1", check: "review", verdict: "changes", attempt: 2 }),
        line("story.reopened", { story: "S1", verdicts: 2, note: "second" }),
      ];
      writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
      const ledger = readReviewLedger(dir, "S1");
      expect(ledger.verdicts).toBe(0);
      expect(ledger.reopened?.note).toBe("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what reopen refuses", () => {
  test("a story id the plan does not have, naming the ones it does", async () => {
    const ws = workspace(ONE);
    await next(ws);
    const outcome = reopen(ws, "S9", WHY);
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("plans no story `S9`");
    expect(outcome.lines.join("\n")).toContain("it plans S1");
    expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(0);
  });

  test("a `done` story — undoing finished work is reject --stage's job", async () => {
    const ws = workspace(ONE);
    await next(ws);
    expect(story(ws, "S1")).toContain("status: done");

    const before = story(ws, "S1");
    const outcome = reopen(ws, "S1", WHY);
    const said = outcome.lines.join("\n");

    expect(outcome.code).toBe(2);
    expect(said).toContain("S1 is `done` — refusing to reopen finished work");
    expect(said).toContain("tldrx reject --stage 04-build/build");
    // Nothing written, nothing appended.
    expect(story(ws, "S1")).toBe(before);
    expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(0);
  });

  test("a `todo` story — it is already pending", async () => {
    const ws = workspace(ONE);
    const outcome = reopen(ws, "S1", WHY);
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("already `todo` — nothing to reopen");
  });

  test("no --note, because a reopen with no reason is not actionable", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);

    const before = story(ws, "S1");
    for (const note of ["", "   "]) {
      const outcome = reopen(ws, "S1", note);
      expect(outcome.code).toBe(2);
      expect(outcome.lines.join("\n")).toContain("story reopen needs --note");
    }
    expect(story(ws, "S1")).toBe(before);
    expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(0);
  });

  /**
   * The only free text in the event is the note, and §2.9 caps a payload at 4KB.
   * `EventLog.append` validates — so without this check the story file would
   * already have been rewritten when the append threw, leaving the status moved
   * and no event to explain it.
   */
  test("a note too long for the event payload — and the file is NOT rewritten", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);

    const before = story(ws, "S1");
    const outcome = reopen(ws, "S1", "x".repeat(5000));

    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("not valid");
    expect(outcome.lines.join("\n")).toContain("nothing was written");
    expect(story(ws, "S1")).toBe(before);
    expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(0);
  });

  test("an unknown run id is not found (3), not refused (2)", async () => {
    const ws = workspace(ONE);
    await next(ws);
    expect(reopen(ws, "S1", WHY, { runId: "260101-nope" }).code).toBe(3);
  });
});

describe("tldrx story reopen, from the command line", () => {
  test("prints the reopen on stdout and exits 0", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);

    const printed = capture();
    const code = await storyCommand.run(["reopen", "S1", "--root", ws.root, "--note", WHY]);
    const out = printed();

    expect(code).toBe(0);
    expect(out.stdout).toContain("reopened S1");
    expect(out.stdout).toContain(WHY);
    expect(out.stderr).toBe("");
    expect(story(ws, "S1")).toContain("status: todo");
  });

  test("a refusal goes to stderr, and stdout stays empty", async () => {
    const ws = workspace(ONE);
    await next(ws);

    const printed = capture();
    const code = await storyCommand.run(["reopen", "S1", "--root", ws.root, "--note", WHY]);
    const out = printed();

    expect(code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("tldrx story reopen:");
    expect(out.stderr).toContain("refusing to reopen finished work");
  });

  test("a subcommand that is not `reopen` is a usage error", async () => {
    const printed = capture();
    const code = await storyCommand.run(["unblock", "S1"]);
    printed();
    expect(code).toBe(1);
  });
});

describe("the build executor picks a reopened story back up", () => {
  /** Two stories in one wave: S1 goes green, S2 is refused twice. */
  const TWO: BuildWorkspaceOptions = {
    stories: [
      { id: "S1", epic: "E1", title: "First story" },
      { id: "S2", epic: "E1", title: "Second story" },
    ],
    epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
    waves: [["S1", "S2"]],
  };

  test("--prepare offers the reopened story, at attempt 1, while the done one refuses", async () => {
    const ws = workspace(TWO);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["changes", "changes"] });

    await next(ws);
    expect(story(ws, "S1")).toContain("status: done");
    expect(story(ws, "S2")).toContain("status: blocked");

    // The story that finished is not this verb's business.
    expect(reopen(ws, "S1", "I want it redone").code).toBe(2);

    expect(reopen(ws, "S2", WHY).code).toBe(0);
    reenter(ws, "S2 was reopened");
    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });
    const said = prepared.lines.join("\n");

    expect(said).toContain(`S2 was reopened by alan (${WHY})`);
    // The whole point: the counter restarted. Before the reopen this story had
    // spent both its attempts and could not be offered at all.
    //
    // Asserted against the PREPARED line and not against the whole output: the
    // operator note above also says "attempt 1 of 2", so a `said.toContain`
    // passes whether or not the executor agrees with it — which it did, wrongly,
    // when this test was first written.
    const preparedLine = prepared.lines.find((l) => l.startsWith("prepared S2")) ?? "";
    expect(preparedLine).not.toBe("");
    expect(preparedLine).toContain(`attempt 1 of ${String(MAX_ATTEMPTS)}`);
    // S1 is done and stays done — reopening S2 reopened nothing else.
    expect(story(ws, "S1")).toContain("status: done");
  }, 60_000);

  /**
   * `--for-fix`'s closing sentence names the stage's `attempts:`, not the
   * constant. It said "attempt 1 of 2" to a workspace that had written
   * `attempts: 3` — a sentence about how many turns are left, wrong about the
   * only number in it.
   */
  test("`--for-fix` says `of 3` on a stage that declares `attempts: 3`", async () => {
    const ws = workspace({ ...ONE, attempts: 3 });
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"] });
    await next(ws);
    expect(story(ws, "S1")).toContain("status: done");

    const said = reopen(ws, "S1", WHY, { forFix: true }).lines.join("\n");
    expect(said).toContain("so the fix runs as attempt 1 of 3");
  }, 60_000);

  test("headless: it runs again, as attempt 1, and can finish", async () => {
    const ws = workspace(ONE);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes", "approve"] });

    await next(ws);
    expect(story(ws, "S1")).toContain("status: blocked");

    reopen(ws, "S1", WHY);
    reenter(ws, "S1 was reopened");
    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    expect(again.lines.join("\n")).toContain(`S1 was reopened by alan (${WHY})`);
    // Three developer turns in all, and the third was attempt 1 — the reopen put
    // the counter back, and `task.started` is where that is visible.
    expect(events(ws).filter((e) => e.type === "task.started").map((e) => e.payload.attempt))
      .toEqual([1, 2, 1]);
  }, 60_000);

  test("a reopened story that blocks AGAIN blocks on its own two verdicts", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes"] });

    await next(ws);
    expect(story(ws, "S1")).toContain("status: blocked");

    reopen(ws, "S1", WHY);
    reenter(ws, "S1 was reopened");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    // Two more `changes`, so it blocks again — the reopen bought two attempts,
    // not immunity. Four verdicts on the log; two of them count.
    expect(story(ws, "S1")).toContain("status: blocked");
    expect(events(ws).filter((e) => e.payload.check === "review")).toHaveLength(4);
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(2);
  }, 60_000);
});

/**
 * A DONE story reopened for ONE NAMED DEFECT (#58, owner decision 2026-09-01).
 *
 * Measured on `260829-scoring-leaderboard` (scavtopia, 2026-09-01). S11's
 * adversarial review found a real defect — `linkEmail` succeeds, `setDisplayName`
 * fails, the account is permanently linked and the score is never claimable, and
 * every retry fails the same way. It was accepted, small and well understood. The
 * story was already `done`, and there was no verb for it: rejecting the whole
 * Build stage destroys fourteen good stories' closure, and fixing it outside the
 * story machinery is an epic-level commit with no story provenance.
 *
 * So `--for-fix`, and it is deliberately narrow. It reopens a story that is DONE,
 * it consumes no attempt, the fix goes through the SAME DoD and the SAME reviewer
 * as the original, and one `story.reopened` carries `reason: fix` and the named
 * defect. It is not a way to relitigate scope: the note names a defect, the
 * story's acceptance criteria are not touched, and one story may have exactly one
 * fix round open at a time.
 */
describe("a done story reopened for a named fix (#58)", () => {
  /** The live defect, near enough — what an owner actually writes at this moment. */
  const DEFECT = "linkEmail succeeds then setDisplayName fails: account linked, score never claimable";

  async function done(): Promise<BuildWorkspace> {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_COST = "0";
    await next(ws);
    expect(story(ws, "S1")).toContain("status: done");
    return ws;
  }

  function forFix(ws: BuildWorkspace, id: string, note: string) {
    return reopen(ws, id, note, { forFix: true });
  }

  test("goes back to `todo`, and says it is a fix round, not another attempt", async () => {
    const ws = await done();

    const outcome = forFix(ws, "S1", DEFECT);
    const said = outcome.lines.join("\n");

    expect(outcome.code).toBe(0);
    expect(story(ws, "S1")).toContain("status: todo");
    expect(said).toContain("reopened S1");
    expect(said).toContain("`done` → `todo`");
    expect(said).toContain(DEFECT);
    expect(said).toContain("fix round");
    expect(said).toContain("no attempt");
    // The scope is frozen, and the message says so — this is the sentence that
    // stops the verb becoming "reopen anything I have changed my mind about".
    expect(said).toMatch(/acceptance criteria/i);
  });

  test("one `story.reopened` carries reason `fix`, the defect and the prior state", async () => {
    const ws = await done();
    forFix(ws, "S1", DEFECT);

    const appended = events(ws).filter((e) => e.type === "story.reopened");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.actor).toBe("alan");
    expect(appended[0]?.payload).toMatchObject({
      story: "S1", from_status: "done", to_status: "todo", reason: "fix", note: DEFECT,
    });
    expect(validateEvent(appended[0]).ok).toBe(true);
  });

  test("an ordinary reopen still records its own reason, and it is not `fix`", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);
    expect(reopen(ws, "S1", WHY).code).toBe(0);
    expect(events(ws).filter((e) => e.type === "story.reopened")[0]?.payload.reason).toBe("attempts");
  });

  /**
   * "Without consuming an attempt" is the whole ask, and the mechanism is the one
   * that was already there: `story.reopened` is a reset boundary the review ledger
   * reads, so the approve that closed the story stops counting and the fix runs as
   * attempt 1 of 2 — with both of them available to it, not one.
   */
  test("no attempt is consumed: the ledger resets and the fix runs as attempt 1", async () => {
    const ws = await done();
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(1);

    forFix(ws, "S1", DEFECT);
    expect(readReviewLedger(ws.runDir, "S1").verdicts).toBe(0);

    reenter(ws, "S1 has a defect to fix");
    await next(ws, { at: "2026-08-29T10:05:00Z" });
    // Two developer turns in all, and BOTH were attempt 1: the original, and the
    // fix. The fix round did not start life owing an attempt.
    expect(events(ws).filter((e) => e.type === "task.started").map((e) => e.payload.attempt))
      .toEqual([1, 1]);
  }, 60_000);

  test("the fix passes the same DoD and the same reviewer, and only then is it done", async () => {
    const ws = await done();
    const before = events(ws).length;
    forFix(ws, "S1", DEFECT);
    reenter(ws, "S1 has a defect to fix");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    const after = events(ws).slice(before);
    // The DoD ran again, in the fix round — not once, at the start of time.
    expect(after.filter((e) => e.payload.check === "dod").length).toBeGreaterThan(0);
    // And a reviewer judged the fix.
    expect(after.filter((e) => e.payload.check === "review").length).toBeGreaterThan(0);
    expect(after.some((e) => e.type === "task.done" && e.payload.status === "done")).toBe(true);
  }, 60_000);

  test("a fix a reviewer refuses does NOT go done — the handshake still gates it", async () => {
    const ws = await done();
    forFix(ws, "S1", DEFECT);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    reenter(ws, "S1 has a defect to fix");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: blocked");
  }, 60_000);

  /**
   * The line between "land a named defect fix" and "reopen the negotiation". The
   * status is the only thing on the file this verb may move; the acceptance
   * criteria the reviewer will judge against are the ones that were already there.
   */
  test("the story's acceptance criteria are untouched — only `status:` moves", async () => {
    const ws = await done();
    const before = story(ws, "S1");
    forFix(ws, "S1", DEFECT);
    expect(story(ws, "S1")).toBe(before.replace("status: done", "status: todo"));
  });

  describe("what --for-fix refuses", () => {
    test("a story that is not done — that is what the plain reopen is for", async () => {
      const ws = workspace(ONE);
      process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
      await next(ws);
      expect(story(ws, "S1")).toContain("status: blocked");

      const before = story(ws, "S1");
      const outcome = forFix(ws, "S1", DEFECT);
      const said = outcome.lines.join("\n");

      expect(outcome.code).toBe(2);
      expect(said).toContain("--for-fix");
      expect(said).toContain("`blocked`");
      expect(said).toContain("tldrx story reopen S1 --note");
      expect(story(ws, "S1")).toBe(before);
      expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(0);
    });

    test("no --note, because the note is the named defect", async () => {
      const ws = await done();
      const before = story(ws, "S1");
      for (const note of ["", "   "]) {
        const outcome = forFix(ws, "S1", note);
        expect(outcome.code).toBe(2);
        expect(outcome.lines.join("\n")).toContain("--note");
      }
      expect(story(ws, "S1")).toBe(before);
      expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(0);
    });

    test("a second fix round while one is still open — the bound is ONE", async () => {
      const ws = await done();
      expect(forFix(ws, "S1", DEFECT).code).toBe(0);

      const before = story(ws, "S1");
      const outcome = forFix(ws, "S1", "a second, different defect");
      const said = outcome.lines.join("\n");

      expect(outcome.code).toBe(2);
      expect(said).toMatch(/fix round/i);
      expect(said).toContain(DEFECT);
      expect(said).toContain("alan");
      expect(story(ws, "S1")).toBe(before);
      // Still exactly the one event: nothing was appended by the refusal.
      expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(1);
    });

    /** A fix round CLOSES when the story is done again, so the next defect may open one. */
    test("a fix round that landed is closed, and a later defect may open another", async () => {
      const ws = await done();
      forFix(ws, "S1", DEFECT);
      reenter(ws, "S1 has a defect to fix");
      await next(ws, { at: "2026-08-29T10:05:00Z" });
      expect(story(ws, "S1")).toContain("status: done");

      expect(forFix(ws, "S1", "a later, different defect").code).toBe(0);
      expect(events(ws).filter((e) => e.type === "story.reopened")).toHaveLength(2);
    }, 60_000);
  });

  test("the plain reopen's `done` refusal now points at --for-fix", async () => {
    const ws = await done();
    const said = reopen(ws, "S1", WHY).lines.join("\n");
    expect(said).toContain("S1 is `done` — refusing to reopen finished work");
    expect(said).toContain("--for-fix");
  });

  test("from the command line, with both flags", async () => {
    const ws = await done();
    const printed = capture();
    const code = await storyCommand.run(
      ["reopen", "S1", "--root", ws.root, "--for-fix", "--note", DEFECT],
    );
    const out = printed();

    expect(code).toBe(0);
    expect(out.stdout).toContain("reopened S1");
    expect(out.stdout).toContain(DEFECT);
    expect(out.stderr).toBe("");
    expect(story(ws, "S1")).toContain("status: todo");
    expect(storyCommand.usage).toContain("--for-fix");
  });
});

/** One `events.jsonl` line, valid against §2.9, for the ledger unit tests. */
function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    ts: "2026-08-29T09:00:00Z",
    run: "260829-build",
    stage: type === "story.reopened" ? null : "build",
    type,
    actor: type === "story.reopened" ? "alan" : "facilitator",
    cost_usd: 0,
    payload: { phase: "04-build", ...payload },
  });
}

function capture(): () => { stdout: string; stderr: string } {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    ((chunk: string | Uint8Array): boolean => {
      append(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = sink((text) => { stdout += text; });
  process.stderr.write = sink((text) => { stderr += text; });
  return () => {
    process.stdout.write = out;
    process.stderr.write = err;
    return { stdout, stderr };
  };
}

/**
 * A story a person FINISHED BY HAND, settled from its branch as it stands (#279).
 *
 * Measured on a real unattended run (tldrx 0.18.2). S2's merge into the epic hit
 * the #268 conflict; the facilitator rebased the branch by hand, ran the DoD
 * green and checked `git merge-tree` clean — and then had no way to get that
 * branch merged. `tldrx story reopen` spawns a DEVELOPER, the developer had
 * nothing to do, and #271's rule (work is measured SINCE THE SPAWN) correctly
 * blocked the story after one attempt: work that already exists, older than the
 * spawn, is indistinguishable from a developer that did nothing. A second reopen
 * buys the same outcome. The only way out was to invent a commit.
 *
 * `--as-is` is the case #271 could not see, and it does not weaken that rule: no
 * developer is spawned at all, so there is no spawn to measure work since. The
 * DoD, the review and the merge are unchanged — they run over the branch as it
 * stands — and the record says who signed it and that no developer delivered it.
 */
describe("a story finished by hand, settled as it stands (#279)", () => {
  /** What the facilitator actually typed, near enough. */
  const HAND = "rebased onto the epic by hand after the #268 conflict; dod green, merge-tree clean";

  /** The branch this run cut for a story — derived the ONE way (`storyBranchOf`). */
  function storyBranch(ws: BuildWorkspace, id: string): string {
    return storyBranchOf(ws.runId, id);
  }

  /**
   * A person's commit on the story branch, made the way the field fix was made:
   * in a scratch worktree, which is then REMOVED — so the story's own worktree
   * does not exist when the verb runs, and the branch is all there is.
   */
  function handFinish(ws: BuildWorkspace, id: string, files: Record<string, string>): string {
    const scratch = mkdtempSync(join(tmpdir(), "tldrx-hand-"));
    git(ws, ["worktree", "add", scratch, storyBranch(ws, id)]);
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(scratch, rel), text, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["commit", "-m", `hand fix for ${id}`], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratch, encoding: "utf8" }).trim();
    git(ws, ["worktree", "remove", "--force", scratch]);
    rmSync(scratch, { recursive: true, force: true });
    return sha;
  }

  /** A story blocked with real committed work on its branch, and no worktree left. */
  async function handFinished(options: BuildWorkspaceOptions = ONE): Promise<BuildWorkspace> {
    const ws = workspace(options);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes", "approve"] });
    await next(ws);
    expect(story(ws, "S1")).toContain("status: blocked");
    handFinish(ws, "S1", { "hand.txt": "the person did this\n" });
    return ws;
  }

  test("no developer is spawned, and the story settles from its branch", async () => {
    const ws = await handFinished();
    const spawnsBefore = events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "developer").length;

    expect(reopen(ws, "S1", HAND, { asIs: true }).code).toBe(0);
    reenter(ws, "S1 was finished by hand");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    // The whole point: not one more developer turn.
    expect(events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "developer"))
      .toHaveLength(spawnsBefore);
    // And the hand commit really is on the epic.
    expect(git(ws, ["log", "epic/e1", "--oneline"])).toContain("hand fix for S1");
  }, 60_000);

  test("the record says the branch was taken as it stands, and who signed it", async () => {
    const ws = await handFinished();
    reopen(ws, "S1", HAND, { asIs: true });
    reenter(ws, "S1 was finished by hand");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    const done = events(ws).filter((e) => e.type === "task.done" && e.payload.story === "S1").at(-1);
    expect(done?.payload.as_is_by).toBe("alan");
    expect(done?.payload.as_is_note).toBe(HAND);
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain(AS_IS_MARK);
    expect(log).toContain("alan");
    // Nothing may say a developer delivered this turn.
    expect(log).not.toContain("Developer: **FAILED**");
  }, 60_000);

  test("a red dod REFUSES — no flag skips it, nothing merges, and no developer is bought", async () => {
    const ws = await handFinished({
      ...ONE,
      // Red exactly when the hand commit is in the tree.
      testScript: 'node -e "process.exit(require(\'fs\').existsSync(\'hand.txt\') ? 1 : 0)"',
    });
    const spawnsBefore = events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "developer").length;
    reopen(ws, "S1", HAND, { asIs: true });
    reenter(ws, "S1 was finished by hand");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: blocked");
    expect(git(ws, ["log", "epic/e1", "--oneline"])).not.toContain("hand fix for S1");
    // The shortcut did not buy a developer on the way to the refusal either —
    // the refusal is structural, not a fallback.
    expect(events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "developer"))
      .toHaveLength(spawnsBefore);
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("exit 1");
  }, 60_000);

  test("a tip that is not ahead of its epic REFUSES, and says which", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);
    expect(story(ws, "S1")).toContain("status: blocked");
    // The hand fix that was not a fix: the person put the branch back where the
    // epic is, so it carries nothing at all. This is the shape the refusal is
    // for — a signature over an empty branch must not merge and must not settle.
    git(ws, ["branch", "-f", storyBranch(ws, "S1"), "epic/e1"]);
    expect(git(ws, ["rev-parse", storyBranch(ws, "S1")])).toBe(git(ws, ["rev-parse", "epic/e1"]));

    expect(reopen(ws, "S1", HAND, { asIs: true }).code).toBe(0);
    reenter(ws, "S1 was signed as-is over an empty branch");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    // Blocked, naming the reason — NOT settled `done` over a branch with nothing
    // on it, and not quietly handed to a developer either.
    expect(story(ws, "S1")).toContain("status: blocked");
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain(AS_IS_NOT_AHEAD_MARK);
  }, 60_000);

  test("`story.reopened` carries reason `as_is`, the note and the actor", async () => {
    const ws = await handFinished();
    reopen(ws, "S1", HAND, { asIs: true });
    const reopened = events(ws).filter((e) => e.type === "story.reopened").at(-1);
    expect(reopened?.payload.reason).toBe("as_is");
    expect(reopened?.payload.note).toBe(HAND);
    expect(reopened?.actor).toBe("alan");
    expect(validateEvent(reopened as never).ok).toBe(true);
  }, 60_000);

  /**
   * The leak this found before it shipped: the signature is held per INVOCATION,
   * and a reviewer that asks for changes over a hand-finished branch requeues
   * the story to a REAL developer inside the same process. That attempt's record
   * must not carry the as-is marker — it is the one direction in which this
   * record must never be wrong.
   */
  test("a requeued attempt after an as-is settlement records a DEVELOPER, not an as-is", async () => {
    const ws = await handFinished();
    // The reviewer faults the hand-finished branch, so attempt 2 is a developer.
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes", "changes", "approve"] });
    reopen(ws, "S1", HAND, { asIs: true });
    reenter(ws, "S1 was finished by hand");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    const done = events(ws).filter((e) => e.type === "task.done" && e.payload.story === "S1");
    // The as-is turn said so; the developer turn after it must not.
    expect(done.at(-2)?.payload.as_is).toBe(true);
    expect(done.at(-1)?.payload.as_is).toBeUndefined();
    expect(done.at(-1)?.payload.as_is_by).toBeUndefined();
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).not.toContain(AS_IS_MARK);
  }, 60_000);

  test("--as-is with --for-fix is a usage error: they are different decisions", async () => {
    const ws = await handFinished();
    const stop = capture();
    const code = await storyCommand.run(["reopen", "S1", "--as-is", "--for-fix", "--note", HAND, "--root", ws.root]);
    const { stdout, stderr } = stop();
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("--as-is");
    expect(stderr).toContain("--for-fix");
  }, 60_000);

  test("from the command line: it prints what it will and will not do", async () => {
    const ws = await handFinished();
    const stop = capture();
    const code = await storyCommand.run(["reopen", "S1", "--as-is", "--note", HAND, "--root", ws.root]);
    const { stdout, stderr } = stop();
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("no developer");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// gh #295, second half — BEGIN. Work already on the epic, review never completed.
// ---------------------------------------------------------------------------

/**
 * A story whose WORK is already in the epic and whose REVIEW never completed
 * (#295). Measured twice on 2026-09-13 (tldrx 0.20.0): under merge-before-review
 * a story's diff can be entirely on the epic while nothing has judged it — a
 * reviewer that died, a later developer attempt that died on a refusal with no
 * work — and then #279's "tip ahead of base" guard measures the wrong thing.
 * There is nothing to MERGE, and there is something to SETTLE: the DoD on the
 * epic head, and the review over the range the story was merged as. The only
 * moves an operator had were inventing a commit for `--as-is` to take, which
 * corrupts the measurement, or leaving the story blocked with its dependents.
 *
 * The named case, `review-only`, is added BESIDE #279's refusal, not carved out
 * of it: a story with no recorded merge, or one whose last review over that
 * merge STANDS (`approve`, `changes`, `fixlist`), still refuses exactly as
 * before — the pin test above is untouched.
 */
describe("a story already on the epic whose review never completed (#295)", () => {
  const OWED = "the migration regen is already on the epic; only the verdict is missing";
  const REQUIRE_EPIC_HEAD = "require-epic-head";

  function storyBranch(ws: BuildWorkspace, id: string): string {
    return storyBranchOf(ws.runId, id);
  }

  /**
   * A commit made straight onto a branch — in the worktree the run keeps for it
   * (an epic branch stays checked out for the run's lifetime, so a second
   * checkout of it is refused by git), or in a scratch one otherwise.
   */
  function commitOn(ws: BuildWorkspace, branch: string, files: Record<string, string>, message: string): string {
    const listed = git(ws, ["worktree", "list", "--porcelain"]).split("\n\n");
    const kept = listed.find((block) => block.includes(`branch refs/heads/${branch}`));
    const dir = kept === undefined
      ? mkdtempSync(join(tmpdir(), "tldrx-epic-"))
      : (/^worktree (.+)$/m.exec(kept)?.[1] ?? "");
    expect(dir).not.toBe("");
    if (kept === undefined) git(ws, ["worktree", "add", dir, branch]);
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    if (kept === undefined) {
      git(ws, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
    return sha;
  }

  function taskDone(ws: BuildWorkspace, id: string) {
    return events(ws).filter((e) => e.type === "task.done" && e.payload.story === id);
  }

  function developerSpawns(ws: BuildWorkspace): number {
    return events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "developer").length;
  }

  /**
   * Story B's shape, in miniature: attempt 1 delivered, was merged and its
   * reviewer DIED; a person reopened it and attempt 2 died on an ungranted
   * command with no work (#261) — `blocked`, `verdict: n-a`, no commit, and the
   * story's whole diff sitting on the epic with nothing having judged it.
   *
   * The DoD script is red ONLY when `require-epic-head` exists beside the
   * workspace and `epic-only.txt` is not in the tree — so once the flag is set,
   * a green DoD is proof the check ran on the epic head, not on the stale tip.
   */
  async function mergedUnjudged(): Promise<BuildWorkspace> {
    const ws = workspace({
      ...ONE,
      testScript: "node -e \"const f=require('fs');process.exit(f.existsSync('../../../../"
        + REQUIRE_EPIC_HEAD + "') && !f.existsSync('epic-only.txt') ? 1 : 0)\"",
    });
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";
    process.env.FAKE_BUILD_FAIL_REASON = "Reached maximum budget ($1)";
    await next(ws);
    expect(story(ws, "S1")).toContain("status: review");
    expect(taskDone(ws, "S1").at(-1)?.payload.verdict).toBe("error");
    delete process.env.FAKE_BUILD_FAIL;
    delete process.env.FAKE_BUILD_FAIL_REASON;

    // The person hands it back to a developer, which asks for an ungranted verb
    // and writes nothing — the story blocks with no commit of its own.
    expect(reopen(ws, "S1", "granting dotnet ef and trying again").code).toBe(0);
    reenter(ws, "S1 reopened");
    process.env.FAKE_BUILD_DENIED = JSON.stringify({ S1: "dotnet ef migrations add Init" });
    await next(ws, { at: "2026-08-29T10:05:00Z" });
    delete process.env.FAKE_BUILD_DENIED;
    expect(story(ws, "S1")).toContain("status: blocked");
    expect(taskDone(ws, "S1").at(-1)?.payload.verdict).toBe("n-a");
    expect(taskDone(ws, "S1").at(-1)?.payload.commit).toBeNull();
    // The whole diff is on the epic, and the branch carries nothing beyond it.
    expect(git(ws, ["rev-list", "--count", `epic/e1..${storyBranch(ws, "S1")}`])).toBe("0");
    expect(git(ws, ["log", "epic/e1", "--oneline"])).toContain("S1");
    return ws;
  }

  test("`--as-is` runs the review it is owed: nothing merged, no developer, and the story settles", async () => {
    const ws = await mergedUnjudged();
    const merged = taskDone(ws, "S1")[0];
    const epicBefore = git(ws, ["rev-parse", "epic/e1"]);
    const developersBefore = developerSpawns(ws);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;

    expect(reopen(ws, "S1", OWED, { asIs: true }).code).toBe(0);
    reenter(ws, "S1 signed as-is: the review is owed");
    await next(ws, { at: "2026-08-29T10:10:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    // Nothing was merged and nothing was invented: the epic did not move.
    expect(git(ws, ["rev-parse", "epic/e1"])).toBe(epicBefore);
    expect(developerSpawns(ws)).toBe(developersBefore);
    // The record names the case, the signer, and the merge it reviewed —
    // the commit and the base the story was merged as, off the ledger.
    const done = taskDone(ws, "S1").at(-1);
    expect(done?.payload.status).toBe("done");
    expect(done?.payload.as_is).toBe(true);
    expect(done?.payload.as_is_reason).toBe("review-only");
    expect(done?.payload.as_is_by).toBe("alan");
    expect(done?.payload.commit).toBe(merged?.payload.commit);
    expect(done?.payload.epic_base).toBe(merged?.payload.epic_base);
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain(AS_IS_REVIEW_ONLY_MARK);
    // "the branch was TAKEN" is the other case's sentence, and it would be false here.
    expect(log).not.toContain(AS_IS_MARK);
    // The reviewer was handed the RECORDED range, not an empty `epic...story`.
    const prompts = readdirSync(promptDir).filter((name) => name.startsWith("reviewer-S1-"));
    expect(prompts).toHaveLength(1);
    const prompt = readFileSync(join(promptDir, prompts[0] ?? ""), "utf8");
    expect(prompt).toContain(String(merged?.payload.epic_base));
  }, 90_000);

  test("the Definition of Done runs on the EPIC HEAD, not on the stale story tip", async () => {
    const ws = await mergedUnjudged();
    // The epic moved on after S1 merged (a sibling landed), and S1's tip is now
    // strictly behind it. The DoD is red on the old tip from here on.
    commitOn(ws, "epic/e1", { "epic-only.txt": "a sibling's work\n" }, "sibling story landed");
    const worktree = join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`);
    writeFileSync(join(ws.root, REQUIRE_EPIC_HEAD), "", "utf8");
    // The instrument: the script's relative path resolves to that flag from the worktree.
    expect(existsSync(join(worktree, "..", "..", "..", "..", REQUIRE_EPIC_HEAD))).toBe(true);
    const epicBefore = git(ws, ["rev-parse", "epic/e1"]);

    expect(reopen(ws, "S1", OWED, { asIs: true }).code).toBe(0);
    reenter(ws, "S1 signed as-is: the review is owed");
    await next(ws, { at: "2026-08-29T10:10:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    expect(git(ws, ["rev-parse", "epic/e1"])).toBe(epicBefore);
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("exit 0");
  }, 90_000);

  test("a review that STANDS still refuses — `changes` over the merged work is not 'never completed'", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });
    await next(ws);
    expect(story(ws, "S1")).toContain("status: blocked");
    git(ws, ["branch", "-f", storyBranch(ws, "S1"), "epic/e1"]);
    const reviewersBefore = events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "reviewer").length;

    expect(reopen(ws, "S1", OWED, { asIs: true }).code).toBe(0);
    reenter(ws, "S1 signed as-is over a judged diff");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: blocked");
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain(AS_IS_NOT_AHEAD_MARK);
    // And the refusal says WHICH verdict stands, so the operator knows a fix is owed.
    expect(log).toContain(AS_IS_JUDGED_MARK);
    expect(log).toContain("`changes`");
    expect(events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "reviewer")).toHaveLength(reviewersBefore);
  }, 60_000);

  test("the ledger keeps the last merge across a reopen — it is evidence, not a count", async () => {
    const ws = await mergedUnjudged();
    const merged = taskDone(ws, "S1")[0];
    const ledger = readReviewLedger(ws.runDir, "S1");
    // Two reopen boundaries have passed (attempts, then nothing yet as-is) and
    // the reset cleared `commit`/`epicBase` — but the merge happened, and the
    // record of it survives under its own name with the verdict that judged it.
    expect(ledger.commit).toBeNull();
    expect(ledger.lastMerge).toEqual({
      commit: String(merged?.payload.commit),
      epicBase: String(merged?.payload.epic_base),
      verdict: "error",
    });
  }, 90_000);
});

// ---------------------------------------------------------------------------
// gh #295, second half — END.
// ---------------------------------------------------------------------------
