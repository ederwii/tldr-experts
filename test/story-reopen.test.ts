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
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { readReviewLedger, MAX_ATTEMPTS } from "../src/core/facilitator/executors/build.ts";
import { reopenStory } from "../src/core/run/reopenStory.ts";
import { storyCommand } from "../src/cli/commands/story.ts";
import { reject } from "../src/core/run/gates.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR", "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
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
