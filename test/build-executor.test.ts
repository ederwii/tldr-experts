/**
 * The Build executor (spec §5, "Build executor"; concept §9).
 *
 * Every test here runs the REAL pipeline against a REAL git repo: branches are
 * cut, worktrees are opened, the story's dod command is run for real, the merge is
 * a merge. Only the two sub-agents are faked — a `claude` first on PATH that writes
 * files as the developer and returns a verdict as the reviewer — because they are
 * the only part that costs money.
 *
 * What each test is actually guarding is in its name: a green story is `done` ONLY
 * with evidence, a red one blocks WITHOUT merging, and neither outcome is anything
 * an agent asserted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { executorFor, EXECUTORS } from "../src/core/facilitator/executors/index.ts";
import { buildExecutor, developerTools, REVIEWER_TOOLS } from "../src/core/facilitator/executors/build.ts";
import { updateStoryFront, evidenceFor } from "../src/core/build/storyFile.ts";
import { renderBuildProgress, buildProgress } from "../src/core/run/buildProgress.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateHandoff } from "../src/core/text/handoff.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_IS_ERROR",
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
  // The fake `claude` is the only one reachable; `git`/`npm`/`node` are shims.
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
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

/** Two stories, one epic, two waves — the shape the wave loop exists for. */
const TWO_WAVES: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second story", dependsOn: ["S1"] },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1"], ["S2"]],
};

function git(ws: BuildWorkspace, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: ws.repoDir, encoding: "utf8" }).trim();
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown>; cost_usd: number }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

// ---------------------------------------------------------------------------

describe("the executor registry", () => {
  test("04-build gets the wave executor; a phase with no entry keeps the default path", () => {
    expect(executorFor("04-build")).toBe(buildExecutor);
    // `null` is what `runNext` reads as "run the ordinary single-agent stage".
    for (const phase of ["01-what", "02-how", "03-plan"]) {
      expect(executorFor(phase)).toBeNull();
    }
    expect([...EXECUTORS.keys()].sort()).toEqual(["04-build", "05-watch"]);
  });

  test("a developer may run its own repo's commands and commit; a reviewer may only read", () => {
    expect(developerTools(["npm run test"])).toEqual([
      "Read", "Write", "Edit", "Glob", "Grep",
      "Bash(npm run test)", "Bash(git add *)", "Bash(git commit *)",
    ]);
    expect(developerTools([]).some((tool: string) => tool.startsWith("Bash(git push"))).toBe(false);
    expect(REVIEWER_TOOLS).toEqual(["Read", "Grep", "Glob", "Bash(git diff *)"]);
  });
});

describe("the happy path: two stories, two waves", () => {
  test("cuts the branches, merges both stories into the epic, and stops at a human gate", async () => {
    const ws = workspace(TWO_WAVES);
    const outcome = await next(ws);

    // Exit 4 = awaiting a human (spec §3). The phase never merges to main itself.
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("gate pending");

    expect(git(ws, ["rev-parse", "--verify", "epic/e1"])).not.toBe("");
    const log = git(ws, ["log", "epic/e1", "--oneline"]);
    expect(log).toContain("merge(S1)");
    expect(log).toContain("merge(S2)");
    // Both stories' files reached the epic branch.
    expect(git(ws, ["show", "epic/e1:s1.txt"])).toContain("S1 was here");
    expect(git(ws, ["show", "epic/e1:s2.txt"])).toContain("S2 was here");
    // `main` is untouched — merging the epic is the human's move.
    expect(git(ws, ["rev-parse", "main"])).not.toBe(git(ws, ["rev-parse", "epic/e1"]));

    const store = RunStore.open(ws.runDir);
    const stage = store.run.phases[0]?.stages[0];
    expect(stage?.status).toBe("awaiting_gate");
    expect(stage?.gate.status).toBe("pending");
    // Two agents per story: a developer and a reviewer.
    expect(stage?.tasks).toHaveLength(4);
  });

  test("a done story carries its proof: the dod command, the commit sha, the review", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws);

    const s1 = story(ws, "S1");
    expect(s1).toContain("status: done");
    expect(s1).toContain('"$ npm run test → exit 0"');
    expect(s1).toMatch(/- "commit [0-9a-f]{7,}"/);
    expect(s1).toContain('"04-build/log/S1.md"');
    expect(existsSync(join(ws.runDir, "04-build", "log", "S1.md"))).toBe(true);
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8")).toContain("Verdict: **approve**");
    // The epic follows its stories.
    expect(readFileSync(join(ws.planDir, "epics", "E1.md"), "utf8")).toContain("status: done");
  });

  test("the handoff is deterministic, sourced, and passes the claim-sources check", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws);

    const path = join(ws.runDir, "04-build", "handoff.md");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("[src: 04-build/log/S1.md:1]");
    expect(text).toContain("[src: $ npm run test → exit 0]");
    expect(text).toContain("epic/e1");

    const validation = validateHandoff(text, toSrcContext(loadWorkspace(ws.root), ws.runDir));
    expect({ unsourced: validation.unsourced, unresolved: validation.unresolved, missing: validation.missingSections })
      .toEqual({ unsourced: [], unresolved: [], missing: [] });
  });

  test("events carry the story, and `run status` shows the waves and per-story cost", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws);

    const log = events(ws);
    const started = log.filter((e) => e.type === "task.started");
    expect(started.map((e) => e.payload.story)).toEqual(["S1", "S2"]);
    expect(log.filter((e) => e.type === "task.done").map((e) => e.payload.status)).toEqual(["done", "done"]);
    expect(log.filter((e) => e.type === "check.passed" && e.payload.check === "dod").map((e) => e.payload.story))
      .toEqual(["S1", "S2"]);
    // `agent.spawned` carries the role (the executor's own event); `agent.result`
    // is emitted by `runNext` from the returned tasks and carries the story key.
    expect(log.filter((e) => e.type === "agent.spawned").map((e) => e.payload.role))
      .toEqual(["developer", "reviewer", "developer", "reviewer"]);
    const results = log.filter((e) => e.type === "agent.result");
    expect(results.map((e) => e.payload.key)).toEqual(["S1", "S1", "S2", "S2"]);
    expect(results.every((e) => e.cost_usd > 0)).toBe(true);

    const progress = buildProgress(ws.runDir);
    expect(progress).not.toBeNull();
    expect(renderBuildProgress(progress!)).toBe("W1 [S1 done] W2 [S2 done]");

    const store = RunStore.open(ws.runDir);
    const rendered = renderStatus(buildStatus(store.run, store.budget, store.runDir));
    expect(rendered).toContain("W1 [S1 done] W2 [S2 done]");
    expect(rendered).toContain("S1 $0.20");
  });

  test("worktrees are cleaned up, and kept with --keep-worktrees", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws);
    // The run id is in the worktree path (wave Q): four runs of one plan used to
    // share `.tldrx/worktrees/app/S1`, and the fourth walked into the third's.
    expect(existsSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`))).toBe(false);

    const kept = workspace(TWO_WAVES);
    await next(kept, { keepWorktrees: true });
    expect(existsSync(join(kept.root, ".tldrx", "worktrees", "app", `${kept.runId}-S1`))).toBe(true);
  });
});

describe("a story that cannot prove itself", () => {
  test("a failed dod blocks the story and nothing is merged", async () => {
    const ws = workspace({ ...TWO_WAVES, testScript: 'node -e "process.exit(1)"' });
    const outcome = await next(ws);
    expect(outcome.code).toBe(4);

    expect(story(ws, "S1")).toContain("status: blocked");
    expect(story(ws, "S1")).toContain("evidence: []");
    // The epic branch exists but holds nothing: a red story does not merge.
    expect(git(ws, ["rev-parse", "epic/e1"])).toBe(git(ws, ["rev-parse", "main"]));
    expect(git(ws, ["log", "epic/e1", "--oneline"])).not.toContain("merge(S1)");

    const failed = events(ws).filter((e) => e.type === "check.failed");
    expect(failed.map((e) => e.payload.story)).toContain("S1");
    expect(failed[0]?.payload.command).toBe("npm run test");

    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("Verdict: **n-a**");
    expect(log).toContain("exit 1");
    // The wave carried on: the second story was still attempted.
    expect(story(ws, "S2")).toContain("status: blocked");
  });

  test("a merge conflict blocks the story, names the files, and leaves the epic usable", async () => {
    const ws = workspace({
      stories: [
        { id: "S1", epic: "E1", title: "First story", touches: ["shared.txt"] },
        { id: "S2", epic: "E1", title: "Second story", dependsOn: ["S1"], touches: ["shared.txt"] },
      ],
      epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
      waves: [["S1"], ["S2"]],
      repoFiles: { "shared.txt": "base\n" },
    });
    // A story branch that already diverged from `main`, so its merge collides
    // with what S1 puts on the epic branch. The name carries the run id, because
    // that is the branch the executor will check out (wave Q).
    execFileSync("git", ["checkout", "-q", "-b", `story/${ws.runId}/S2`], { cwd: ws.repoDir });
    writeFileSync(join(ws.repoDir, "shared.txt"), "from S2\n", "utf8");
    execFileSync("git", ["commit", "-qam", "S2 diverges"], { cwd: ws.repoDir });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: ws.repoDir });

    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "shared.txt": "from S1\n" },
      S2: { "shared.txt": "from S2, again\n" },
    });
    await next(ws);

    expect(story(ws, "S1")).toContain("status: done");
    const s2 = story(ws, "S2");
    expect(s2).toContain("status: blocked");
    expect(s2).toContain('"merge conflict: shared.txt"');

    const log = readFileSync(join(ws.runDir, "04-build", "log", "S2.md"), "utf8");
    expect(log).toContain("Merge conflict");
    expect(log).toContain("shared.txt");

    // The abort left the epic branch exactly as S1 left it — still mergeable.
    expect(git(ws, ["show", "epic/e1:shared.txt"])).toBe("from S1");
    expect(git(ws, ["status", "--porcelain"])).toBe("");
  });
});

describe("the reviewer", () => {
  test("`changes` requeues the story once, with the review in the next prompt", async () => {
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
    });
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "approve"] });

    await next(ws);

    expect(story(ws, "S1")).toContain("status: done");
    // The reviewer IS a check: a `changes` verdict is a failed one, in the ledger.
    const verdicts = events(ws)
      .filter((e) => e.payload.check === "review")
      .map((e) => e.payload.verdict);
    expect(verdicts).toEqual(["changes", "approve"]);

    const second = readFileSync(join(promptDir, "developer-S1-2.md"), "utf8");
    expect(second).toContain("## Previous attempt");
    expect(second).toContain("the acceptance criteria are not met yet");
  });

  test("a second `changes` blocks the story rather than looping", async () => {
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
    });
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });

    await next(ws);

    expect(story(ws, "S1")).toContain("status: blocked");
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain("asked for changes twice");
    expect(events(ws).filter((e) => e.payload.check === "review").map((e) => e.payload.verdict))
      .toEqual(["changes", "changes"]);
  });
});

describe("in-session mode", () => {
  test("--prepare bundles ONE story and --commit finishes its pipeline", async () => {
    const ws = workspace(TWO_WAVES);

    const first = await next(ws, { mode: "prepare" });
    expect(first.code).toBe(0);
    expect(first.lines.join("\n")).toContain("prepared S1");
    const pending = JSON.parse(
      readFileSync(join(ws.runDir, ".agent", "build", "S1", "pending.json"), "utf8"),
    ) as { story?: string };
    expect(pending.story).toBe("S1");
    expect(readFileSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"), "utf8"))
      .toContain("# Build — story S1");
    expect(story(ws, "S1")).toContain("status: in_progress");

    // The host session's sub-agent: write the file into the story's worktree.
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1 in-session\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0.3 }),
      "utf8",
    );

    const committed = await next(ws, { mode: "commit" });
    expect(committed.code).toBe(0);
    expect(committed.lines.join("\n")).toContain("S2 is next");
    expect(story(ws, "S1")).toContain("status: done");
    expect(git(ws, ["show", "epic/e1:s1.txt"])).toContain("S1 in-session");

    // Second cycle: S2, then the gate.
    const second = await next(ws, { mode: "prepare" });
    expect(second.lines.join("\n")).toContain("prepared S2");
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S2`, "s2.txt"), "S2 in-session\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S2", "result.json"),
      JSON.stringify({ outputs: ["s2.txt"], questions_asked: [], notes: "", cost_usd: 0.2 }),
      "utf8",
    );
    const done = await next(ws, { mode: "commit" });
    expect(done.code).toBe(4);
    expect(done.lines.join("\n")).toContain("gate pending");
    expect(story(ws, "S2")).toContain("status: done");
  });
});

describe("safety", () => {
  test("a dirty repo is refused before anything is cut, and says what to do", async () => {
    const ws = workspace(TWO_WAVES);
    writeFileSync(join(ws.repoDir, "README.md"), "# app\n\nuncommitted\n", "utf8");

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain("uncommitted change(s)");
    expect(text).toContain("Commit or stash them");
    // Nothing was cut.
    expect(() => git(ws, ["rev-parse", "--verify", "epic/e1"])).toThrow();
    expect(story(ws, "S1")).toContain("status: todo");
  });

  test("--dry-run is refused: branches and commits are not revertible by a flag", async () => {
    const ws = workspace(TWO_WAVES);
    const outcome = await next(ws, { dryRun: true });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("refusing --dry-run");
    expect(() => git(ws, ["rev-parse", "--verify", "epic/e1"])).toThrow();
  });

  test("the stage budget is split by story count and capped by per_agent_max_usd", async () => {
    const ws = workspace({ ...TWO_WAVES, budgetUsd: 8, perAgentMaxUsd: 3 });
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_BUILD_ARGV_LOG = argvLog;

    await next(ws);

    const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const caps = calls.map((argv) => argv[argv.indexOf("--max-budget-usd") + 1]);
    // The share is divided by the WORST CASE, not by the story count: 2 stories x
    // MAX_ATTEMPTS(2) x (1 + REVIEWER_SHARE(0.25)) = 5 developer-shares, so the
    // developer gets 8/5 = $1.60 and the reviewer a quarter of that, $0.40.
    // Before 2026-08-29 it was 8/2 = $4.00 capped to $3.00, and 2 stories x 2
    // attempts x ($3.00 + $0.75) could charge $15.00 against an $8.00 stage —
    // the audit's "Build 2.5x su fase".
    expect(caps).toEqual(["1.60", "0.40", "1.60", "0.40"]);
    const total = caps.reduce((sum, c) => sum + Number(c), 0);
    expect(total * 2).toBeLessThanOrEqual(8 + 0.001); // both attempts still fit
    // The developer's allowance names its own repo's command, and no git push.
    const devAllowance = calls[0]?.[calls[0].indexOf("--allowedTools") + 1] ?? "";
    expect(devAllowance).toContain("Bash(npm run test)");
    expect(devAllowance).toContain("Bash(git commit *)");
    expect(devAllowance).not.toContain("git push");
    expect(calls[1]?.[calls[1].indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash(git diff *)");
  });
});

describe("story front matter", () => {
  test("only the status and evidence lines change", () => {
    const before = [
      "---",
      "version: 1",
      "id: S3",
      "status: todo",
      "evidence: []",
      "---",
      "",
      "# S3",
      "",
      "status: this line is prose, not front matter",
      "",
    ].join("\n");
    const after = updateStoryFront(before, {
      status: "done",
      evidence: evidenceFor(["npm run test"], "abc1234", "04-build/log/S3.md"),
    });
    expect(after).toContain("status: done");
    expect(after).toContain('  - "$ npm run test → exit 0"');
    expect(after).toContain('  - "commit abc1234"');
    expect(after).toContain("status: this line is prose, not front matter");
    // Round-trips: rewriting an already-written list replaces it, never appends.
    const again = updateStoryFront(after, { status: "blocked", evidence: [] });
    expect(again).toContain("status: blocked");
    expect(again).toContain("evidence: []");
    expect(again.split("\n").filter((l) => l.startsWith("evidence"))).toHaveLength(1);
  });
});

// --- wave Q: branches and worktrees carry the run id, epics are claimed ------

describe("branch and worktree names carry the run id", () => {
  test("`story/<run>/<story>` is the branch, `<run>-<story>` the worktree", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws, { keepWorktrees: true });

    const branches = git(ws, ["branch", "--list", "--format=%(refname:short)"]).split("\n");
    expect(branches).toContain(`story/${ws.runId}/S1`);
    expect(branches).toContain(`story/${ws.runId}/S2`);
    // The un-prefixed names are gone: they are what four runs used to collide on.
    expect(branches).not.toContain("story/S1");

    expect(existsSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`))).toBe(true);
    expect(existsSync(join(ws.root, ".tldrx", "worktrees", "app", "S1"))).toBe(false);
  });

  test("the epic branch this run cut is recorded in run.yml", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws);
    expect(RunStore.open(ws.runDir).run.build?.epic_branch).toEqual(["epic/e1"]);
  });
});

describe("an epic branch this run did not cut", () => {
  test("is refused, and the message names --reuse-epic", async () => {
    const ws = workspace(TWO_WAVES);
    // Somebody else's epic branch, already on the repo before this run starts.
    execFileSync("git", ["branch", "epic/e1", "main"], { cwd: ws.repoDir });

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain("did not cut it");
    expect(text).toContain("--reuse-epic");
    // Refused, not failed: the stage goes back to ready and nothing was spent.
    const store = RunStore.open(ws.runDir);
    expect(store.run.phases.flatMap((p) => p.stages).find((s) => s.id === "build")?.status).toBe("ready");
    expect(store.run.budget.spent_usd).toBe(0);
    // And no story branch was cut behind the refusal.
    expect(git(ws, ["branch", "--list", "--format=%(refname:short)"]).split("\n"))
      .not.toContain(`story/${ws.runId}/S1`);
  });

  test("--reuse-epic adopts it, says so, and claims it from then on", async () => {
    const ws = workspace(TWO_WAVES);
    execFileSync("git", ["branch", "epic/e1", "main"], { cwd: ws.repoDir });

    const outcome = await next(ws, { reuseEpic: true });
    expect(outcome.lines.join("\n")).toContain("--reuse-epic");
    expect(RunStore.open(ws.runDir).run.build?.epic_branch).toEqual(["epic/e1"]);
  });

  test("a run's SECOND invocation is not refused its own branch", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws);
    expect(RunStore.open(ws.runDir).run.build?.epic_branch).toEqual(["epic/e1"]);
    // `epic/e1` now exists. The same run must still be able to keep working.
    const again = await next(ws);
    expect(again.lines.join("\n")).not.toContain("did not cut it");
  });
});
