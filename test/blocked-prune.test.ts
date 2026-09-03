/**
 * Nothing tldrx deletes may be the only copy of somebody's work (#129).
 *
 * Measured live on 2026-09-02, run `260830-money-and-payments` (aparece-v2): a
 * story's DoD verification failed, the executor settled it `blocked`, and
 * `cleanUp` ran `git worktree remove --force` over a tree that still held the
 * developer's fix, uncommitted. The fix had reached no ref anywhere. It was gone.
 *
 * `blocked` is precisely the state a human is going to want to inspect, so the
 * one path that must never destroy anything destroyed everything. The invariant
 * here has no exceptions in it: a worktree holding changes that reached no ref is
 * not the framework's to delete. Either the changes reach a ref first, or the
 * worktree stays.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { EVENT_TYPES } from "../src/core/events/Event.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR",
  "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_REASON",
] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/** Green on the untouched base tree, RED once the fake developer writes its file. */
const RED_ONLY_AFTER_DEVELOPER =
  'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"';

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

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

function git(ws: BuildWorkspace, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: ws.repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Git that ANSWERS rather than throws — for the "is it there?" questions. */
function gitOk(ws: BuildWorkspace, args: readonly string[]): boolean {
  try {
    git(ws, args);
    return true;
  } catch {
    return false;
  }
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function storyBranch(ws: BuildWorkspace, id: string): string {
  return `story/${ws.runId}/${id}`;
}

function worktreeOf(ws: BuildWorkspace, id: string): string {
  return join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-${id}`);
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

// ---------------------------------------------------------------------------

describe("a blocked story's work reaches a ref before anything is pruned (#129)", () => {
  test("a failed DoD leaves the developer's uncommitted work reachable from the story branch", async () => {
    const ws = workspace({ ...ONE_STORY, testScript: RED_ONLY_AFTER_DEVELOPER });
    await next(ws);

    // The premise: the story really did block, and the developer really did write.
    expect(story(ws, "S1")).toContain("status: blocked");

    // The invariant. Before the fix this threw: the branch existed and was
    // byte-identical to `main`, because the only copy of `s1.txt` was inside the
    // worktree `git worktree remove --force` had just deleted.
    expect(gitOk(ws, ["cat-file", "-e", `${storyBranch(ws, "S1")}:s1.txt`])).toBe(true);
    expect(git(ws, ["show", `${storyBranch(ws, "S1")}:s1.txt`])).toContain("S1 was here");
  });

  test("the rescue commit says out loud that it is one, and names the blocked verdict", async () => {
    const ws = workspace({ ...ONE_STORY, testScript: RED_ONLY_AFTER_DEVELOPER });
    await next(ws);

    const subject = git(ws, ["log", "-1", "--format=%s", storyBranch(ws, "S1")]);
    const body = git(ws, ["log", "-1", "--format=%b", storyBranch(ws, "S1")]);
    expect(subject).toContain("wip(S1)");
    expect(subject).toContain("blocked");
    // Not `feat(S1): …` — this commit is not a story delivered, and a message
    // that said so would be the audit trail lying in the same direction #130 did.
    expect(subject.startsWith("feat(")).toBe(false);
    expect(body).toContain("npm run test");
  });

  test("the sha is recorded where a human looks: the review log and events.jsonl", async () => {
    const ws = workspace({ ...ONE_STORY, testScript: RED_ONLY_AFTER_DEVELOPER });
    await next(ws);

    // The SHORT sha, which is what every other record in this framework carries.
    const sha = git(ws, ["rev-parse", "--short", storyBranch(ws, "S1")]);
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("## Uncommitted work rescued");
    expect(log).toContain(sha);
    expect(log).toContain(storyBranch(ws, "S1"));

    const rescued = events(ws).filter((e) => e.type === "story.work_rescued");
    expect(rescued).toHaveLength(1);
    expect(rescued[0]?.payload.story).toBe("S1");
    expect(rescued[0]?.payload.branch).toBe(storyBranch(ws, "S1"));
    expect(rescued[0]?.payload.sha).toBe(sha);
    expect(EVENT_TYPES).toContain("story.work_rescued");
  });

  test("a worktree whose changes could NOT reach a ref is KEPT, and the log says where it is", async () => {
    const ws = workspace({ ...ONE_STORY, testScript: RED_ONLY_AFTER_DEVELOPER });
    // A commit that genuinely cannot be made. The hook lives in the common git
    // dir, so the story worktree inherits it, and on this path it is the ONLY
    // commit attempted — the DoD fails before `commitIfDirty` is ever reached.
    const hook = join(ws.repoDir, ".git", "hooks", "pre-commit");
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(hook, 0o755);

    await next(ws);

    expect(story(ws, "S1")).toContain("status: blocked");
    // Nothing reached a ref, so nothing may be deleted. The tree is the work.
    expect(gitOk(ws, ["cat-file", "-e", `${storyBranch(ws, "S1")}:s1.txt`])).toBe(false);
    expect(existsSync(join(worktreeOf(ws, "S1"), "s1.txt"))).toBe(true);

    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("## Uncommitted work rescued");
    expect(log).toContain("could NOT be committed");
    expect(log).toContain(worktreeOf(ws, "S1"));
  });

  test("a green story still gets its worktree pruned — the rescue is not a leak", async () => {
    const ws = workspace(ONE_STORY);
    await next(ws);
    expect(story(ws, "S1")).toContain("status: done");
    expect(existsSync(worktreeOf(ws, "S1"))).toBe(false);
    // Nothing was rescued: `commitIfDirty` already put every byte on the branch.
    expect(events(ws).filter((e) => e.type === "story.work_rescued")).toHaveLength(0);
  });
});
