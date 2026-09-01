/**
 * A story branch that has fallen behind its epic — design §F.2, wave 4B.
 *
 * The two live cases, from `260830-tenancy-identity-customers` (notes §11):
 *
 *   (a) S3 was reopened, `story reopen` keeps its branch by design, and that
 *       branch still sat at the S1-era epic tip while the epic had since gained
 *       S2 and S5. S3's handlers needed S2's contract, so a dispatch on that base
 *       would not have compiled. The host fast-forwarded by hand. That is the one
 *       case this chunk automates.
 *   (b) S4's branch had DIVERGED — a dead spawn's partial commit on a stale base
 *       — so no fast-forward existed. The host preserved the partial on a backup
 *       branch and re-pointed the story branch by hand. Which history survives is
 *       a DECISION, so this chunk does not make it: it warns with both counts and
 *       both shas and changes nothing.
 *
 * Every git assertion here is against a REAL repository. A stubbed git would let
 * "fast-forwarded" and "left alone" be wrong in the same direction and pass.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { baseStateOf, commitsBetween, fastForward, shaOf } from "../src/core/build/git.ts";
import { reopenStory } from "../src/core/run/reopenStory.ts";
import { reject } from "../src/core/run/gates.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent, EVENT_TYPES } from "../src/core/events/Event.ts";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
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
] as const;

let open: BuildWorkspace[] = [];
let scratch: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  open = [];
  scratch = [];
});

// ---------------------------------------------------------------------------
// Part 1 — the git seam, on plain repositories
// ---------------------------------------------------------------------------

/** A throwaway repo with one commit on `main`, and a `git` bound to it. */
function bareRepo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-basestate-"));
  scratch.push(dir);
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "fixture@example.com");
  run("config", "user.name", "tldrx fixture");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "c1");
  return { dir, git: run };
}

describe("baseStateOf — where a story branch stands against its epic", () => {
  test("identical branches are `current`, with both counts 0", async () => {
    const { dir, git } = bareRepo();
    git("branch", "story");

    const state = await baseStateOf(dir, "story", "main");

    expect(state.state).toBe("current");
    expect(state.ahead).toBe(0);
    expect(state.behind).toBe(0);
    expect(state.branchSha).toBe(state.baseSha);
    expect(state.branchSha).not.toBe("");
  });

  /**
   * A branch that is only AHEAD is `current` on purpose: the question this
   * answers is "is there anything on the epic this branch has not got", and the
   * answer is no. It is also the ordinary shape of a story mid-attempt.
   */
  test("ahead-only is `current` — there is nothing on the epic to pick up", async () => {
    const { dir, git } = bareRepo();
    git("branch", "story");
    git("checkout", "-q", "story");
    git("commit", "-q", "--allow-empty", "-m", "story work");

    const state = await baseStateOf(dir, "story", "main");

    expect(state.state).toBe("current");
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(0);
  });

  test("behind-only names how many commits the epic has that the branch lacks", async () => {
    const { dir, git } = bareRepo();
    git("branch", "story");
    git("commit", "-q", "--allow-empty", "-m", "S2");
    git("commit", "-q", "--allow-empty", "-m", "S5");

    const state = await baseStateOf(dir, "story", "main");

    expect(state.state).toBe("behind");
    expect(state.ahead).toBe(0);
    expect(state.behind).toBe(2);
    expect(state.branchSha).not.toBe(state.baseSha);
  });

  test("commits on both sides is `diverged`, and both counts are reported", async () => {
    const { dir, git } = bareRepo();
    git("branch", "story");
    git("commit", "-q", "--allow-empty", "-m", "S2");
    git("commit", "-q", "--allow-empty", "-m", "S5");
    git("checkout", "-q", "story");
    git("commit", "-q", "--allow-empty", "-m", "a dead spawn's partial");

    const state = await baseStateOf(dir, "story", "main");

    expect(state.state).toBe("diverged");
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(2);
  });

  test("a branch that does not exist has no sha and no counts", async () => {
    const { dir } = bareRepo();

    const state = await baseStateOf(dir, "story/nope", "main");

    expect(state.branchSha).toBe("");
    expect(state.state).toBe("current");
  });
});

describe("fastForward — the only move this chunk makes", () => {
  test("a clean behind branch lands on the tip and is then 0 behind", async () => {
    const { dir, git } = bareRepo();
    git("branch", "story");
    git("commit", "-q", "--allow-empty", "-m", "S2");
    const tip = await shaOf(dir, "main");
    git("checkout", "-q", "story");

    const moved = await fastForward(dir, "main");

    expect(moved.ok).toBe(true);
    expect(await shaOf(dir, "story")).toBe(tip);
    expect(await commitsBetween(dir, "story", "main")).toBe(0);
  });

  test("it refuses a diverged branch rather than writing a merge commit", async () => {
    const { dir, git } = bareRepo();
    git("branch", "story");
    git("commit", "-q", "--allow-empty", "-m", "S2");
    git("checkout", "-q", "story");
    git("commit", "-q", "--allow-empty", "-m", "partial");
    const before = await shaOf(dir, "story");

    const moved = await fastForward(dir, "main");

    expect(moved.ok).toBe(false);
    expect(await shaOf(dir, "story")).toBe(before);
    expect(await commitsBetween(dir, "main", "story")).toBe(1);
  });

  /**
   * Design §I.5, the one assumption the fast-forward rests on: can `--ff-only`
   * fail in a way that leaves the worktree half-moved? Measured here — it exits
   * non-zero, HEAD is still on the original commit, and the file that blocked it
   * is untouched. Atomic-or-nothing, so a failed call needs no repair.
   */
  test("blocked by an untracked file, it leaves HEAD and the file exactly as they were", async () => {
    const { dir, git } = bareRepo();
    git("branch", "story");
    writeFileSync(join(dir, "b.txt"), "from main\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "S2 adds b.txt");
    git("checkout", "-q", "story");
    const before = await shaOf(dir, "story");
    writeFileSync(join(dir, "b.txt"), "the operator's own\n", "utf8");

    const moved = await fastForward(dir, "main");

    expect(moved.ok).toBe(false);
    expect(await shaOf(dir, "story")).toBe(before);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("the operator's own\n");
  });
});

describe("the event type", () => {
  test("`story.base_fastforwarded` is in the closed §2.9 set", () => {
    expect(EVENT_TYPES).toContain("story.base_fastforwarded");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — through the real executor
// ---------------------------------------------------------------------------

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  // Every test here runs the Build stage TWICE. At the fake's default $0.10 a
  // turn the phase brake refuses the second one before the executor is reached,
  // and the refusal is not what any of these tests are about.
  process.env.FAKE_BUILD_COST = "0";
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

function git(ws: BuildWorkspace, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: ws.repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function fastForwards(ws: BuildWorkspace) {
  return events(ws).filter((e) => e.type === "story.base_fastforwarded");
}

/** Sends the Build stage back to `ready` so `tldrx next` will run it again. */
function reenter(ws: BuildWorkspace, note: string): void {
  reject(RunStore.open(ws.runDir), { root: ws.root, actor: "alan", at: "2026-08-30T10:00:00Z", note });
}

/** Two stories, two waves, one epic — so the epic tip moves twice. */
const TWO: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second story" },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1"], ["S2"]],
};

const WHY = "it gates wave 3 and the owner has decided it ships";

interface Stale {
  readonly ws: BuildWorkspace;
  /** `story/<run>/S1` — the branch left behind. */
  readonly branch: string;
  /** Its short sha before anything in the test touches it. */
  readonly stale: string;
  /** Commits `epic/e1` carries that the branch does not. */
  readonly behind: number;
  /**
   * `story.base_fastforwarded` events the FIRST run already emitted.
   *
   * It legitimately emits one: S1's second attempt is a requeue, and a requeued
   * story has already been merged, so its branch is behind the tip its own merge
   * created. Counting from zero here would count that one twice.
   */
  readonly ffSoFar: number;
}

/**
 * The half of a `--prepare`/`--commit` cycle the HOST does: a file in the story's
 * worktree, and the `result.json` its sub-agent would have left behind.
 */
function hostTurn(ws: BuildWorkspace, storyId: string): void {
  const worktree = join(ws.root, ".tldrx", "worktrees", ws.repoName, `${ws.runId}-${storyId}`);
  writeFileSync(join(worktree, `${storyId.toLowerCase()}.txt`), `${storyId} in-session\n`, "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", storyId, "result.json"),
    JSON.stringify({ outputs: [`${storyId.toLowerCase()}.txt`], questions_asked: [], notes: "", cost_usd: 0 }),
    "utf8",
  );
}

/**
 * S3's live shape, in miniature.
 *
 * S1 is refused twice, so it settles `blocked` — and its work is nevertheless IN
 * the epic, because a story merges before it is reviewed. S2 then builds and
 * merges on top. That leaves S1's branch an ANCESTOR of an epic tip it knows
 * nothing about, which is exactly where S3's branch sat on 2026-08-30: at the
 * S1-era tip, while the epic had gained S2 and S5.
 *
 * `blocked` and not `done` because `story reopen` refuses a finished story by
 * design — reopening one of those is `reject --stage`.
 */
async function s1BlockedThenReopened(overrides: Partial<NextOptions> = {}): Promise<Stale> {
  const ws = workspace(TWO);
  process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"], S2: ["approve"] });
  await next(ws, overrides);
  expect(readFileSync(join(ws.planDir, "stories", "S1.md"), "utf8")).toContain("status: blocked");
  expect(readFileSync(join(ws.planDir, "stories", "S2.md"), "utf8")).toContain("status: done");

  const branch = `story/${ws.runId}/S1`;
  const stale = git(ws, "rev-parse", "--short", branch);
  const behind = await commitsBetween(ws.repoDir, branch, "epic/e1");
  // The premise: behind, and behind ONLY.
  expect(behind).toBeGreaterThan(0);
  expect(await commitsBetween(ws.repoDir, "epic/e1", branch)).toBe(0);

  expect(reopenStory({
    root: ws.root, storyId: "S1", note: WHY, actor: "alan", at: "2026-08-30T10:00:00Z",
  }).code).toBe(0);
  reenter(ws, "another go at S1");
  return { ws, branch, stale, behind, ffSoFar: fastForwards(ws).length };
}

describe("(a) behind and clean — the reopened story the host fast-forwarded by hand", () => {
  test("the branch lands on the epic tip, and is then 0 commits behind", async () => {
    const { ws, branch } = await s1BlockedThenReopened();
    const tip = git(ws, "rev-parse", "--short", "epic/e1");

    await next(ws, { mode: "prepare" });

    expect(git(ws, "rev-parse", "--short", branch)).toBe(tip);
    expect(await commitsBetween(ws.repoDir, branch, "epic/e1")).toBe(0);
  });

  test("the operator line names the branch, the epic, the count and both shas", async () => {
    const { ws, branch, stale, behind } = await s1BlockedThenReopened();
    const tip = git(ws, "rev-parse", "--short", "epic/e1");

    const said = (await next(ws, { mode: "prepare" })).lines.join("\n");

    expect(said).toContain(
      `S1: fast-forwarded \`${branch}\` to \`epic/e1\` — ${String(behind)} commit(s), ${stale} → ${tip}`,
    );
  });

  test("one `story.base_fastforwarded`, carrying from, to and the count", async () => {
    const { ws, branch, stale, behind, ffSoFar } = await s1BlockedThenReopened();
    const tip = git(ws, "rev-parse", "--short", "epic/e1");

    await next(ws, { mode: "prepare" });

    const moved = fastForwards(ws).slice(ffSoFar);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.payload).toMatchObject({
      phase: "04-build",
      story: "S1",
      repo: ws.repoName,
      branch,
      base: "epic/e1",
      from: stale,
      to: tip,
      commits: behind,
    });
    // A real §2.9 envelope, not a shape only this file can read.
    expect(validateEvent(moved[0]).ok).toBe(true);
  });

  test("`tldrx replay` narrates the ref tldrx moved", async () => {
    const { ws, stale, behind } = await s1BlockedThenReopened();
    const tip = git(ws, "rev-parse", "--short", "epic/e1");

    await next(ws, { mode: "prepare" });

    const narrative = renderReplay(loadRun(ws.root, ws.runId)!);
    expect(narrative).toContain(
      `story S1's base fast-forwarded to \`epic/e1\` — ${stale} → ${tip} (${String(behind)} commit(s))`,
    );
  });

  /**
   * Notes §11 records that the reopen note already surfaced at the next prepare.
   * The fast-forward line lands in the same list; this asserts it did not push
   * the note out of it.
   */
  test("the reopen note still surfaces verbatim in the same prepare", async () => {
    const { ws } = await s1BlockedThenReopened();

    const said = (await next(ws, { mode: "prepare" })).lines.join("\n");

    expect(said).toContain("S1 was reopened by alan");
    expect(said).toContain(WHY);
  });

  /**
   * The move belongs to the openings that put a DEVELOPER on the branch. The
   * `--commit` half of the same cycle opens the story again, and moving the base
   * out from under work that has just been written would be the opposite of the
   * point.
   */
  test("the `--commit` half of the same cycle moves nothing", async () => {
    const { ws, ffSoFar } = await s1BlockedThenReopened();
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"] });

    await next(ws, { mode: "prepare" });
    const after = fastForwards(ws).length;
    hostTurn(ws, "S1");
    await next(ws, { mode: "commit" });

    expect(after).toBe(ffSoFar + 1);
    expect(fastForwards(ws)).toHaveLength(after);
  });

  /**
   * The headless half of the same fix, and the case that fires most often: a
   * story requeued by a `changes` verdict has ALREADY been merged into its epic,
   * so its branch is an ancestor of a tip that has since moved. Before §F.2 the
   * second attempt was dispatched onto the first attempt's base.
   */
  test("a requeued attempt 2 starts on the epic tip, not on attempt 1's base", async () => {
    const ws = workspace(TWO);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "approve"], S2: ["approve"] });

    await next(ws);

    const moved = fastForwards(ws);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.payload).toMatchObject({ story: "S1", base: "epic/e1", commits: 1 });
    expect(readFileSync(join(ws.planDir, "stories", "S1.md"), "utf8")).toContain("status: done");
  });
});

describe("(b) diverged — the dead spawn's partial commit, which is a decision, not a move", () => {
  /** Put a commit on the story branch that the epic has never seen. */
  function divergeS1(ws: BuildWorkspace, branch: string): void {
    const tmp = join(ws.root, ".diverge");
    git(ws, "worktree", "add", "-q", tmp, branch);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "wip: a dead spawn left this"], {
      cwd: tmp, stdio: ["ignore", "pipe", "pipe"],
    });
    git(ws, "worktree", "remove", "--force", tmp);
  }

  async function diverged(): Promise<Stale & { head: string }> {
    const made = await s1BlockedThenReopened();
    divergeS1(made.ws, made.branch);
    return { ...made, head: git(made.ws, "rev-parse", "--short", made.branch) };
  }

  test("nothing is changed — the branch is exactly where it was", async () => {
    const { ws, branch, head, ffSoFar } = await diverged();

    await next(ws, { mode: "prepare" });

    expect(git(ws, "rev-parse", "--short", branch)).toBe(head);
    expect(fastForwards(ws)).toHaveLength(ffSoFar);
  });

  test("the warning names both shas, both counts, and the operator's two options", async () => {
    const { ws, branch, head, behind } = await diverged();
    const tip = git(ws, "rev-parse", "--short", "epic/e1");

    const said = (await next(ws, { mode: "prepare" })).lines.join("\n");

    expect(said).toContain(
      `S1: \`${branch}\` (${head}) has DIVERGED from \`epic/e1\` (${tip}) — `
      + `1 commit(s) the epic lacks, ${String(behind)} the story lacks`,
    );
    expect(said).toContain("nothing was changed — tldrx never rebases a branch a developer has committed to");
    expect(said).toContain("`git merge epic/e1`");
    expect(said).toContain("preserve the divergent commit(s) on a backup branch and re-point");
  });

  /**
   * Design §F.2 is explicit: diverged is "warn, change nothing". It is not a
   * refusal and there is no acknowledgment flag — so the dispatch goes ahead on
   * the old base, and the line says so in as many words rather than leaving the
   * operator to infer it from the absence of a stop.
   */
  test("the dispatch proceeds, on the old base, and says which base that is", async () => {
    const { ws, head, behind } = await diverged();

    const outcome = await next(ws, { mode: "prepare" });

    expect(outcome.lines.join("\n")).toContain(
      `S1: the dispatch below is on the OLD base (${head}), ${String(behind)} commit(s) behind \`epic/e1\``,
    );
    expect(existsSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"))).toBe(true);
  });
});

describe("(c) dirty — a tree the operator owns is never moved out from under them", () => {
  test("the branch is left alone, and the warning names the count and the paths", async () => {
    // `--keep-worktrees` so S1's worktree survives its first cycle and can be
    // dirtied: an opening that has to CREATE the worktree creates a clean one.
    const { ws, branch, stale, behind, ffSoFar } = await s1BlockedThenReopened({ keepWorktrees: true });
    const worktree = join(ws.root, ".tldrx", "worktrees", ws.repoName, `${ws.runId}-S1`);
    expect(existsSync(worktree)).toBe(true);
    writeFileSync(join(worktree, "half-done.txt"), "the operator was mid-thought\n", "utf8");
    const tip = git(ws, "rev-parse", "--short", "epic/e1");

    const said = (await next(ws, { mode: "prepare", keepWorktrees: true })).lines.join("\n");

    expect(git(ws, "rev-parse", "--short", branch)).toBe(stale);
    expect(fastForwards(ws)).toHaveLength(ffSoFar);
    expect(said).toContain(
      `S1: \`${branch}\` (${stale}) is ${String(behind)} commit(s) behind \`epic/e1\` (${tip}), `
      + "but its worktree has 1 uncommitted change(s) — left alone; a dirty tree is the operator's",
    );
    expect(said).toContain("half-done.txt");
  });
});

describe("(d) up to date — the case that must stay byte-identical", () => {
  test("a plain two-wave build says nothing about the base and emits no event", async () => {
    const ws = workspace(TWO);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");

    // 4 — the Build stage ended at its human gate, which is a full green run.
    expect(outcome.code).toBe(4);
    expect(fastForwards(ws)).toHaveLength(0);
    expect(said).not.toContain("fast-forwarded");
    expect(said).not.toContain("DIVERGED");
    expect(said).not.toContain("a dirty tree is the operator's");
    expect(readFileSync(join(ws.planDir, "stories", "S1.md"), "utf8")).toContain("status: done");
    expect(readFileSync(join(ws.planDir, "stories", "S2.md"), "utf8")).toContain("status: done");
  });

  test("the same is true through the prepare/commit handshake", async () => {
    const ws = workspace(TWO);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    expect((await next(ws, { mode: "prepare" })).lines.join("\n")).toContain("prepared S1");
    hostTurn(ws, "S1");
    const outcome = await next(ws, { mode: "commit" });

    expect(outcome.lines.join("\n")).toContain("S1 → `done`");
    expect(fastForwards(ws)).toHaveLength(0);
  });
});
