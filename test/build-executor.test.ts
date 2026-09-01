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
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { executorFor, EXECUTORS } from "../src/core/facilitator/executors/index.ts";
import {
  buildExecutor, developerTools, readReviewLedger, REVIEWER_TOOLS,
} from "../src/core/facilitator/executors/build.ts";
import { looksLikeReviewerError, reviewerFailed } from "../src/core/build/review.ts";
import { UNFINISHED_STORIES } from "../src/core/run/autoGate.ts";
import { approve, reject } from "../src/core/run/gates.ts";
import { updateStoryFront, evidenceFor } from "../src/core/build/storyFile.ts";
import { renderBuildProgress, buildProgress } from "../src/core/run/buildProgress.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateHandoff } from "../src/core/text/handoff.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import {
  assertWorktreeOn, GitError, partitionDirty, porcelainPath, stateDirPrefixes, WorktreeBranchMismatchError,
} from "../src/core/build/git.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../src/core/paths.ts";
import {
  addBuildRun, makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
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

function next(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[]; stderr?: readonly string[] }> {
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

/**
 * A `test` script that is GREEN on the untouched base tree and RED once a
 * developer has written its story file.
 *
 * It replaced a plain `node -e "process.exit(1)"` when the base-tree pre-flight
 * landed (issue #41). That script failed on pristine main too, which is now a
 * WORKSPACE-CONFIG error and refuses Build by design — so a test about a story
 * that cannot prove itself has to fail for the story's own reason, which is what
 * it always meant. The fake developer writes `<story>.txt` into its worktree; the
 * base repo has no `.txt` file at all.
 */
const RED_ONLY_AFTER_DEVELOPER =
  'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"';

/** Two stories, one epic, two waves — the shape the wave loop exists for. */
const TWO_WAVES: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second story", dependsOn: ["S1"] },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1"], ["S2"]],
};

/**
 * `git` in the fixture repo, with stderr CAPTURED rather than inherited.
 *
 * `execFileSync` sends the child's stderr to ours unless told otherwise, so the
 * two `expect(() => git(ws, ["rev-parse", "--verify", ...])).toThrow()` lines
 * below — the ones that prove no branch was cut — printed
 * `fatal: Needed a single revision` on every `bun test` run. The assertion is
 * the non-zero exit, not the message; piping keeps the exit (and puts the
 * message on `error.stderr`, so a genuinely unexpected failure still reports).
 */
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

/**
 * The EPIC worktree — the one a story merges IN (issue #40).
 *
 * The story worktree above got the run id in its path after the 2026-08-29 audit;
 * this one did not, and it is the worse half, because the collision here is a
 * merge. `_epic-E1` was a path two runs both computed — every plan names its first
 * epic `E1` — so the second run's `existsSync` hit the first's directory,
 * `addWorktree` was skipped, and `git merge --no-ff` ran inside a checkout of
 * ANOTHER run's epic branch while every line printed the branch the story meant to
 * reach. Three stories reported "merged" onto an epic that stayed empty
 * (measured live 2026-08-31).
 *
 * Two things are pinned here, because the fix is two things: the path cannot
 * collide, and a reuse that is on the wrong branch REFUSES instead of merging.
 */
describe("the epic worktree", () => {
  test("a second run on the same workspace gets its own epic worktree, and merges onto its OWN epic branch", async () => {
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/one" }],
      waves: [["S1"]],
    });
    // `--keep-worktrees` is how the live shape was set up: a finished run's
    // `_epic-…` directory was still on disk when the next run started. `4` is a
    // green build awaiting its gate, the same code every passing story returns.
    expect((await next(ws, { keepWorktrees: true })).code).toBe(4);
    expect(story(ws, "S1")).toContain("status: done");

    // Run two: same workspace, same repo, same epic ID, different epic branch.
    const second = addBuildRun(ws, {
      stories: [{ id: "S1", epic: "E1", title: "First story again" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/two" }],
      waves: [["S1"]],
    });
    expect((await next(ws, { runId: second.runId, keepWorktrees: true })).code).toBe(4);
    expect(readFileSync(join(second.planDir, "stories", "S1.md"), "utf8")).toContain("status: done");

    // The BYTES, first, because the handoff line was never the thing that was
    // wrong: run two's merge is on run two's branch, and run one's branch carries
    // exactly the one merge it made itself. That count is what goes to 2 when a
    // foreign run merges into it — the whole bug, in one number.
    expect(git(ws, ["log", "epic/two", "--oneline"])).toContain("merge(S1)");
    expect(git(ws, ["log", "epic/one", "--oneline"]).split("\n").filter((l) => l.includes("merge(S1)")))
      .toHaveLength(1);
    expect(git(ws, ["rev-parse", "epic/one"])).not.toBe(git(ws, ["rev-parse", "epic/two"]));

    // …and the path shape that makes it impossible in the first place.
    const firstPath = join(ws.root, ".tldrx", "worktrees", "app", `_epic-${ws.runId}-E1`);
    const secondPath = join(ws.root, ".tldrx", "worktrees", "app", `_epic-${second.runId}-E1`);
    expect(secondPath).not.toBe(firstPath);
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
  });

  test("an epic worktree on the WRONG branch is refused by name, and nothing is merged", async () => {
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/one" }],
      waves: [["S1"]],
    });
    // Somebody else's worktree, sitting exactly where this run's would go. Path
    // scoping should make this unreachable; the invariant is what makes it
    // survivable if it ever becomes reachable again.
    const path = join(ws.root, ".tldrx", "worktrees", "app", `_epic-${ws.runId}-E1`);
    mkdirSync(join(path, ".."), { recursive: true });
    execFileSync("git", ["branch", "epic/somebody-else"], { cwd: ws.repoDir, stdio: "pipe" });
    execFileSync("git", ["worktree", "add", path, "epic/somebody-else"], { cwd: ws.repoDir, stdio: "pipe" });

    const outcome = await next(ws);
    expect(outcome.code).toBe(5);
    const said = outcome.lines.join("\n");
    expect(said).toContain("epic/somebody-else");   // where the worktree actually is
    expect(said).toContain("epic/one");             // where the story meant to merge
    expect(said).toContain(path);                   // and which directory to go look at

    // The refusal is the point: neither branch moved a byte.
    expect(git(ws, ["rev-parse", "epic/somebody-else"])).toBe(git(ws, ["rev-parse", "main"]));
    expect(git(ws, ["log", "epic/one", "--oneline"])).not.toContain("merge(S1)");
  });

  test("`assertWorktreeOn` throws its own class, naming both branches and the path", async () => {
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/one" }],
      waves: [["S1"]],
    });
    const path = join(ws.root, "elsewhere");
    execFileSync("git", ["branch", "epic/somebody-else"], { cwd: ws.repoDir, stdio: "pipe" });
    execFileSync("git", ["worktree", "add", path, "epic/somebody-else"], { cwd: ws.repoDir, stdio: "pipe" });

    // On the branch it claims to be on: silence, and no throw.
    expect(await assertWorktreeOn(path, "epic/somebody-else")).toBeUndefined();

    const thrown = await assertWorktreeOn(path, "epic/one", "epic worktree").then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(WorktreeBranchMismatchError);
    expect(thrown).toBeInstanceOf(GitError);
    const message = (thrown as Error).message;
    expect(message).toContain("`epic/somebody-else`");
    expect(message).toContain("`epic/one`");
    expect(message).toContain(path);
    expect(message).toContain("epic worktree");
  });
});

describe("a story that cannot prove itself", () => {
  test("a failed dod blocks the story and nothing is merged", async () => {
    const ws = workspace({ ...TWO_WAVES, testScript: RED_ONLY_AFTER_DEVELOPER });
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

/**
 * The Plan's own prices decide the caps (2026-08-30).
 *
 * `03-plan/budget.yml` is authored by Delivery, validated by the Plan gate, and
 * was until now read by NOTHING. On run `260830-tenancy-identity-customers` it
 * priced S1 at $4.75 and S2 at $0.75, and the executor handed both the same
 * $1.03 — because it split the stage into equal shares and never opened the file.
 */
describe("story caps come from 03-plan/budget.yml when it has them", () => {
  /** Every `--max-budget-usd` the fake `claude` was called with, in order. */
  async function caps(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<string[]> {
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_BUILD_ARGV_LOG = argvLog;
    await next(ws, overrides);
    return readFileSync(argvLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string[])
      .map((argv) => argv[argv.indexOf("--max-budget-usd") + 1] ?? "");
  }

  function priceStories(ws: BuildWorkspace, prices: Record<string, number>): void {
    writeFileSync(join(ws.planDir, "budget.yml"), [
      "version: 1",
      `run: "${ws.runId}"`,
      "ceiling_usd: 8.00",
      "spent_usd: 0.00",
      "per_phase_usd:",
      ...Object.entries(prices).map(([id, usd]) => `  ${id}: ${usd.toFixed(2)}`),
      "",
    ].join("\n"), "utf8");
  }

  test("an expensive story gets more than a cheap one, priced by the plan", async () => {
    const ws = workspace({ ...TWO_WAVES, budgetUsd: 8, perAgentMaxUsd: 8 });
    priceStories(ws, { S1: 5.0, S2: 1.0 });

    // developer = price / (MAX_ATTEMPTS x (1 + REVIEWER_SHARE)) = price / 2.5.
    // S1: 5.00/2.5 = $2.00. S2: 1.00/2.5 = $0.40. Both reviewers derive under a
    // dollar and are lifted to REVIEWER_FLOOR_USD.
    expect(await caps(ws)).toEqual(["2.00", "1.00", "0.40", "1.00"]);
  }, 60_000);

  test("prices that add up to more than the stage are scaled down, keeping the ratio", async () => {
    const ws = workspace({ ...TWO_WAVES, budgetUsd: 8, perAgentMaxUsd: 8 });
    // $24 of stories priced into an $8 stage: scale 1/3, and S1 stays 3x S2.
    priceStories(ws, { S1: 18.0, S2: 6.0 });

    const seen = await caps(ws);
    expect([seen[0], seen[2]]).toEqual(["2.40", "0.80"]);
    expect(Number(seen[0]) / Number(seen[2])).toBeCloseTo(3, 5);
  }, 60_000);

  test("a story the plan did not price falls back to the uniform share", async () => {
    const ws = workspace({ ...TWO_WAVES, budgetUsd: 8, perAgentMaxUsd: 8 });
    priceStories(ws, { S1: 5.0 });
    // S2 is unpriced: 8 / (2 stories x 2 attempts x 1.25) = $1.60, as before.
    const seen = await caps(ws);
    expect([seen[0], seen[2]]).toEqual(["2.00", "1.60"]);
  }, 60_000);

  test("a budget.yml that does not validate is an advisory, never a refusal", async () => {
    const ws = workspace({ ...TWO_WAVES, budgetUsd: 8, perAgentMaxUsd: 8 });
    writeFileSync(join(ws.planDir, "budget.yml"), "version: 1\nrun: \"nope\"\n", "utf8");

    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_BUILD_ARGV_LOG = argvLog;
    const outcome = await next(ws);

    expect(outcome.code).toBe(4);                       // the build still ran
    expect((outcome.stderr ?? []).join("\n")).toContain("03-plan/budget.yml was ignored");
    const seen = readFileSync(argvLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string[])
      .map((argv) => argv[argv.indexOf("--max-budget-usd") + 1] ?? "");
    expect([seen[0], seen[2]]).toEqual(["1.60", "1.60"]);   // the uniform share
  }, 60_000);
});

/**
 * A reviewer that FAILED is not a verdict (2026-08-30).
 *
 * Measured on run `260830-tenancy-identity-customers`: the headless reviewer of a
 * 39-file, +1879-line story was given $0.26, died mid-read with
 * `Reached maximum budget ($0.26)`, and the executor wrote that corpse down as
 * `verdict: "changes"`. That single line cost the story its only requeue, sent a
 * fresh developer at code nobody had faulted, and would have blocked S1 after a
 * second reviewer hit the same wall — with zero review ever performed.
 *
 * Fail-closed is right: an unfinished review is not an approval. Inventing the
 * verdict is not, and these tests are the difference.
 */
describe("a reviewer that FAILED is not a verdict", () => {
  const ONE_STORY: BuildWorkspaceOptions = {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
  };

  /** The live failure, word for word (2026-08-30). */
  const DIED = "Reached maximum budget ($0.26)";

  function reviewEvents(ws: BuildWorkspace): readonly Record<string, unknown>[] {
    return events(ws).filter((e) => e.payload.check === "review").map((e) => e.payload);
  }

  /**
   * The operator's own move between invocations: send the finished stage back
   * (`tldrx reject`) so `tldrx next` runs the Build executor again.
   *
   * Every test that re-enters also pins `FAKE_BUILD_COST` to zero. Not for
   * tidiness — the budget gate refuses to START a stage whose estimate no longer
   * fits what the phase has left, and in this fixture the stage's estimate IS the
   * phase ceiling, so any recorded spend makes the second invocation unaffordable
   * before it reaches a line of executor code.
   */
  function reenter(ws: BuildWorkspace, note: string): void {
    reject(RunStore.open(ws.runDir), { root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note });
  }

  test("it settles at `review` with verdict `error`, and the ledger says so", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer";

    const outcome = await next(ws);

    // Not `blocked`, not `done`: the diff is merged and unjudged.
    expect(story(ws, "S1")).toContain("status: review");
    expect(reviewEvents(ws)).toEqual([{
      phase: "04-build",
      check: "review",
      story: "S1",
      verdict: "error",
      attempt: 1,
      // `detail` is the ERROR, verbatim — that is what a ledger needs to tell a
      // transport failure from a reviewer with an opinion.
      detail: `claude exited 1 with is_error=true: ${DIED}`,
    }]);
    // And the operator is told the reviewer FAILED, never that it asked for changes.
    const said = outcome.lines.join("\n");
    expect(said).toContain("the reviewer FAILED and returned no verdict");
    expect(said).not.toContain("asked for changes");
  });

  test("the requeue is NOT consumed: no second developer attempt is started", async () => {
    const ws = workspace(ONE_STORY);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer";

    await next(ws);

    // Exactly one developer prompt was ever written. The old code wrote two.
    expect(readdirSync(promptDir).filter((n) => n.startsWith("developer-"))).toEqual(["developer-S1-1.md"]);
    // And nothing in the ledger claims a second attempt was started.
    const starts = events(ws).filter((e) => e.type === "task.started").map((e) => e.payload.attempt);
    expect(starts).toEqual([1]);
  });

  test("the story's worktree survives, and the diff stays merged into the epic", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer";

    await next(ws);

    expect(git(ws, ["show", "epic/e1:s1.txt"])).toContain("S1 was here");
    expect(existsSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`))).toBe(true);
  });

  test("the log and the retro both say FAILED, not `changes`", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer";

    await next(ws);

    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("- Verdict: **error**");
    expect(log).toContain("The reviewer FAILED and returned no verdict");
    expect(log).toContain("Reached maximum budget");
    expect(log).not.toContain("asked for changes");

    const retro = readFileSync(join(ws.runDir, "retro.md"), "utf8");
    expect(retro).toContain("`S1` — the reviewer FAILED and returned no verdict on attempt 1");
    expect(retro).not.toContain("asked for CHANGES");
  });

  test("`tldrx next` again re-runs ONLY the review — no second developer turn", async () => {
    const ws = workspace(ONE_STORY);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    // The FIRST reviewer of S1 dies; every later one works.
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";

    await next(ws);
    expect(story(ws, "S1")).toContain("status: review");

    // The operator's move: send the stage back and run it again.
    reenter(ws, "the reviewer died");
    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    expect(again.lines.join("\n")).toContain("re-running the REVIEW only");
    // ONE developer prompt across BOTH invocations. That is the whole fix.
    expect(readdirSync(promptDir).filter((n) => n.startsWith("developer-"))).toEqual(["developer-S1-1.md"]);
    expect(readdirSync(promptDir).filter((n) => n.startsWith("reviewer-")).sort())
      .toEqual(["reviewer-S1-1.md", "reviewer-S1-2.md"]);
    // The re-review is attempt 1, because no verdict was ever spent on S1.
    expect(reviewEvents(ws).map((p) => [p.verdict, p.attempt]))
      .toEqual([["error", 1], ["approve", 1]]);
  }, 60_000);

  test("the resumed review sees the DoD the ledger recorded, not an empty one", async () => {
    const ws = workspace(ONE_STORY);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";

    await next(ws);
    reenter(ws, "again");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    // The second reviewer's prompt still carries the story's proof, recovered
    // from `events.jsonl` — the DoD was not re-run and was not lost either.
    const second = readFileSync(join(promptDir, "reviewer-S1-2.md"), "utf8");
    expect(second).toContain("npm run test");
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain("`npm run test` → exit 0");
  }, 60_000);

  test("--prepare writes the REVIEWER bundle instead of handing out a developer bundle", async () => {
    // The live shape, start to finish: the whole story goes through the
    // in-session doors, its reviewer dies, and the NEXT --prepare is the moment
    // the old code said `task.started … attempt: 2, mode: prepare` for work
    // nobody had asked for.
    //
    // Since 2026-08-31 it does not spawn a replacement reviewer either: a
    // `--prepare` that spawns is the one thing `--prepare` must never be, and on
    // the live run a host timeout killed exactly that spawn mid-read.
    const ws = workspace(TWO_WAVES);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";

    expect((await next(ws, { mode: "prepare" })).lines.join("\n")).toContain("prepared S1");
    writeFileSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`, "s1.txt"), "S1 in-session\n", "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "result.json"),
      JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0 }),
      "utf8",
    );

    const committed = await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z" });
    expect(committed.lines.join("\n")).toContain("S1 → `review`");
    expect(story(ws, "S1")).toContain("status: review");

    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    const said = prepared.lines.join("\n");
    expect(said).toContain("the previous reviewer FAILED");
    expect(said).toContain("preparing the REVIEW only");
    expect(said).toContain("prepared the REVIEW of S1");
    expect(said).toContain("tldrx next --commit --review");
    // The two sentences the old path printed here, and must not print again.
    expect(said).not.toContain("prepared S1 ·");
    expect(said).not.toContain("dispatch ONE sub-agent");
    // Parked, not settled: the verdict is the host's to write.
    expect(story(ws, "S1")).toContain("status: review");
    // And NOTHING was spawned by the prepare. The developer was the HOST's, so it
    // left no spawn prompt at all; the only spawn this run ever made is the one
    // reviewer that died inside `--commit`.
    expect(readdirSync(promptDir).sort()).toEqual(["reviewer-S1-1.md"]);

    // The host answers, and the same seam settles it.
    writeFileSync(
      join(ws.runDir, ".agent", "build", "S1", "review", "result.json"),
      JSON.stringify({ verdict: "approve", summary: "read the diff by hand", findings: [] }),
      "utf8",
    );
    const settled = await next(ws, { mode: "commit", review: true, at: "2026-08-29T10:20:00Z" });
    expect(settled.lines.join("\n")).toContain("S1 → `done` (host review, unmetered)");
    expect(settled.lines.join("\n")).toContain("S2 is next");
    expect(story(ws, "S1")).toContain("status: done");
    // Still one spawn for the whole story: the host's review replaced the second.
    expect(readdirSync(promptDir).sort()).toEqual(["reviewer-S1-1.md"]);
  }, 60_000);

  test("a run recorded by the OLD code still resumes at the review", async () => {
    // The shape measured on 2026-08-30: an errored reviewer written down as
    // `verdict: "changes"` with the spawn error as its detail. This is the only
    // path that reads it, and it is why `looksLikeReviewerError` exists.
    const ws = workspace(ONE_STORY);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";

    await next(ws);
    rewriteVerdictAsOldCode(ws);
    expect(readReviewLedger(ws.runDir, "S1")).toMatchObject({ verdicts: 0, erroredWith: expect.any(String) });

    reenter(ws, "old record");
    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(again.lines.join("\n")).toContain("re-running the REVIEW only");
    expect(story(ws, "S1")).toContain("status: done");
    expect(readdirSync(promptDir).filter((n) => n.startsWith("developer-"))).toEqual(["developer-S1-1.md"]);
  }, 60_000);

  test("a story left `in_progress` by a wrongly-prepared attempt 2 still resumes at the review", async () => {
    // Exactly the live run's state: `--prepare` had already handed the host a
    // developer bundle for an attempt that was never owed, which set the story
    // to `in_progress`. The resume must look past that.
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "reviewer:S1#1";

    await next(ws);
    rewriteVerdictAsOldCode(ws);
    const path = join(ws.planDir, "stories", "S1.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("status: review", "status: in_progress"), "utf8");

    reenter(ws, "live shape");
    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(again.lines.join("\n")).toContain("re-running the REVIEW only");
    expect(story(ws, "S1")).toContain("status: done");
  }, 60_000);

  test("a genuine `changes` still consumes the requeue — the fix is narrow", async () => {
    const ws = workspace(ONE_STORY);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "changes"] });

    await next(ws);

    expect(story(ws, "S1")).toContain("status: blocked");
    expect(reviewEvents(ws).map((p) => p.verdict)).toEqual(["changes", "changes"]);
  }, 60_000);

  /** Rewrite the run's own review event into the pre-2026-08-30 spelling. */
  function rewriteVerdictAsOldCode(ws: BuildWorkspace): void {
    const path = join(ws.runDir, "events.jsonl");
    const rewritten = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => (line.includes('"check":"review"') ? line.replaceAll('"verdict":"error"', '"verdict":"changes"') : line))
      .join("\n");
    writeFileSync(path, rewritten, "utf8");
  }
});

describe("reading a review off the ledger", () => {
  test("`reviewerFailed` never produces a verdict, and never an empty summary", () => {
    expect(reviewerFailed("Reached maximum budget ($0.26)"))
      .toEqual({
        verdict: "error",
        summary: "Reached maximum budget ($0.26)",
        findings: [],
        fixlist: [],
        fixlistProblems: [],
        // A reviewer that never answered declared no verdict to misread (gh #36).
        verdictProblem: null,
      });
    expect(reviewerFailed(null).summary).toBe("the reviewer sub-agent failed");
    expect(reviewerFailed("  ").verdict).toBe("error");
  });

  test("`looksLikeReviewerError` catches every string the framework itself writes", () => {
    for (const detail of [
      "claude exited 1 with is_error=true: Reached maximum budget ($0.26)",
      "claude exited 2 without a parseable result event: (no output)",
      "claude timed out (killed after the stage's timeout_s)",
      "stopped after 200 reads: the stage's max_reads is 200. Raise `max_reads` …",
      "the reviewer sub-agent failed",
    ]) {
      expect(looksLikeReviewerError(detail)).toBe(true);
    }
    // A model's own summary is a VERDICT and must never be mistaken for one.
    for (const summary of [
      "the acceptance criteria are not met yet",
      "changes requested with no comment",
      "the migration is missing a down step",
    ]) {
      expect(looksLikeReviewerError(summary)).toBe(false);
    }
  });

  test("the ledger counts verdicts, not turns, and remembers the merged commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-ledger-"));
    const rows = [
      { type: "task.started", payload: { story: "S1", attempt: 1 } },
      { type: "check.passed", payload: { story: "S1", check: "dod", command: "npm run test", exit_code: 0, detail: "" } },
      { type: "check.failed", payload: { story: "S1", check: "review", verdict: "error", detail: "claude timed out (…)" } },
      { type: "task.done", payload: { story: "S1", status: "review", commit: "abc1234" } },
      { type: "check.failed", payload: { story: "S2", check: "review", verdict: "changes", detail: "not yet" } },
    ];
    writeFileSync(join(dir, "events.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

    const s1 = readReviewLedger(dir, "S1");
    expect(s1.verdicts).toBe(0);              // an errored review is not a verdict
    expect(s1.erroredWith).toBe("claude timed out (…)");
    expect(s1.commit).toBe("abc1234");
    expect(s1.dod).toEqual([{ command: "npm run test", exitCode: 0, timedOut: false, tail: "" }]);

    const s2 = readReviewLedger(dir, "S2");
    expect(s2.verdicts).toBe(1);              // a real `changes` is
    expect(s2.erroredWith).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an attempt that started and ran nothing does not erase the DoD before it", () => {
    // The live run's own event order (2026-08-30): S1's three commands went
    // green, its reviewer died, and then a `--prepare` recorded a `task.started`
    // for an attempt 2 that never ran. Resetting on `task.started` alone left the
    // resumed reviewer with no DoD results and the log claiming the story
    // declares none.
    const dir = mkdtempSync(join(tmpdir(), "tldrx-ledger-"));
    const rows = [
      { type: "task.started", payload: { story: "S1", attempt: 1 } },
      { type: "check.passed", payload: { story: "S1", check: "dod", command: "dotnet build", exit_code: 0, detail: "" } },
      { type: "check.passed", payload: { story: "S1", check: "dod", command: "dotnet test", exit_code: 0, detail: "" } },
      { type: "check.failed", payload: { story: "S1", check: "review", verdict: "error", detail: "claude exited 1" } },
      { type: "task.done", payload: { story: "S1", status: "review", commit: "dc5c67a" } },
      { type: "task.started", payload: { story: "S1", attempt: 2, mode: "prepare" } },
    ];
    writeFileSync(join(dir, "events.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

    expect(readReviewLedger(dir, "S1").dod.map((r) => r.command)).toEqual(["dotnet build", "dotnet test"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a later real verdict clears an earlier error", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-ledger-"));
    const rows = [
      { type: "check.failed", payload: { story: "S1", check: "review", verdict: "error", detail: "claude exited 1" } },
      { type: "check.passed", payload: { story: "S1", check: "review", verdict: "approve", detail: "looks good" } },
    ];
    writeFileSync(join(dir, "events.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    expect(readReviewLedger(dir, "S1")).toMatchObject({ verdicts: 1, erroredWith: null });
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The feedback loop, closed at the Build end (wave O).
 *
 * A reviewer's `changes` verdict and a failed DoD command are the moments this
 * team learned something, and until now they reached `events.jsonl` and a
 * per-story log — neither of which any expert reads. `mineRuns` reads
 * `handoff.md` and `retro.md`; so Build writes `retro.md` as it goes.
 */
describe("Build writes retro.md as it goes", () => {
  function retro(ws: BuildWorkspace): string {
    return readFileSync(join(ws.runDir, "retro.md"), "utf8");
  }

  test("a `changes` verdict and a first-attempt failure land in `## Build feedback`, sourced", async () => {
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
    });
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["changes", "approve"] });

    await next(ws);
    expect(story(ws, "S1")).toContain("status: done");

    const text = retro(ws);
    expect(text).toContain("## Build feedback");
    expect(text).toContain("`S1` — the reviewer asked for CHANGES on attempt 1");
    expect(text).toContain("reviewer finding:");
    // The citation points at a file that is really there, so a knowledge file
    // mined from this retro inherits a `[src: …]` that still resolves.
    expect(text).toContain(`[src: tldrx-work/${ws.runId}/04-build/log/S1.md:1]`);
    expect(existsSync(join(ws.runDir, "04-build", "log", "S1.md"))).toBe(true);
  });

  test("a failed dod is written with its command and exit code", async () => {
    const ws = workspace({ ...TWO_WAVES, testScript: RED_ONLY_AFTER_DEVELOPER });
    await next(ws);
    const text = retro(ws);
    expect(text).toContain("dod `npm run test` exited 1 on the first attempt");
    expect(text).toContain("`S1`");
    expect(text).toContain("`S2`");
  });

  test("a green run writes nothing — there is no push-back to record", async () => {
    const ws = workspace(TWO_WAVES);
    await next(ws);
    expect(existsSync(join(ws.runDir, "retro.md"))).toBe(false);
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

/** One story, one epic, one wave — enough to watch a single commit's contents. */
const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

describe("what counts as dirt", () => {
  test("the state dirs are excused only where they are actually inside the repo", () => {
    // root_is_repo: the framework writes into the product repo.
    expect(stateDirPrefixes("/w", "/w")).toEqual([PROJECT_WORK_DIR, PROJECT_FRAMEWORK_DIR]);
    expect(stateDirPrefixes("/w", "/w/.")).toEqual([PROJECT_WORK_DIR, PROJECT_FRAMEWORK_DIR]);
    // multi-repo: the state is a sibling of the repo, so nothing is excused and
    // a repo's own `tldrx-work/` stays product dirt.
    expect(stateDirPrefixes("/w", "/w/app")).toEqual([]);
    expect(stateDirPrefixes("/w", "/elsewhere")).toEqual([]);
  });

  test("a porcelain entry is judged by its path — untracked dirs and renames included", () => {
    const prefixes = [PROJECT_WORK_DIR, PROJECT_FRAMEWORK_DIR];
    const split = partitionDirty([
      "M tldrx-work/260830-decisions-gate/run.yml",
      "M tldrx-work/260830-decisions-gate/events.jsonl",
      "?? tldrx-work/260830-decisions-gate/.lock",
      "?? tldrx-work/260830-decisions-gate/04-build/",
      "M .tldrx/memory/facts.yml",
      "M src/app.ts",
      "?? tldrx-workshop/notes.md",
      "R  src/old.ts -> src/new.ts",
    ], prefixes);
    expect(split.state).toHaveLength(5);
    // `tldrx-workshop/` only SHARES a prefix — it is the human's directory.
    expect(split.product).toEqual(["M src/app.ts", "?? tldrx-workshop/notes.md", "R  src/old.ts -> src/new.ts"]);
    // With nothing to excuse, every entry is product dirt, exactly as before.
    expect(partitionDirty(["M src/app.ts"], []).product).toEqual(["M src/app.ts"]);
  });

  test("porcelainPath strips the status letters, the rename arrow and the quotes", () => {
    expect(porcelainPath("M src/app.ts")).toBe("src/app.ts");
    expect(porcelainPath("?? 04-build/")).toBe("04-build/");
    expect(porcelainPath("MM a b.txt")).toBe("a b.txt");
    expect(porcelainPath("R  src/old.ts -> src/new.ts")).toBe("src/new.ts");
    expect(porcelainPath('?? "tldrx-work/caf\u00e9.md"')).toBe("tldrx-work/caf\u00e9.md");
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

  /**
   * The dirty-tree check must not count tldrx's OWN writes.
   *
   * Measured 2026-08-30 on a copy of a real `root_is_repo: true` workspace:
   * `tldrx next --prepare` exited 2 with four "uncommitted changes" that were all
   * its own — `run.yml` and `events.jsonl` are rewritten on every `next`, `.lock`
   * is the run lock, and `04-build/` held the implicit plan written seconds
   * earlier. The command refused itself, and a user's uncommitted answers under
   * `tldrx-work/` did the same, though those are committed on the user's cadence.
   */
  test("single-repo: the framework's own state files do not refuse the Build that wrote them", async () => {
    const ws = workspace({ ...TWO_WAVES, rootIsRepo: true });
    // The exact shape that was measured: a modified run.yml and an untracked lock.
    appendFileSync(join(ws.runDir, "run.yml"), "\n# touched by this very run\n", "utf8");
    writeFileSync(join(ws.runDir, ".lock"), "held\n", "utf8");

    const outcome = await next(ws);
    const text = outcome.lines.join("\n");

    expect(text).not.toContain("refusing to cut an epic branch");
    expect(text).toContain("tldrx state file(s) in the dirty-tree check");
    // Exit 4 = it ran and reached the human gate; the branch is really there.
    expect(outcome.code).toBe(4);
    expect(git(ws, ["rev-parse", "--verify", "epic/e1"])).not.toBe("");
  }, 60_000);

  test("single-repo: a product file still refuses, and the message names only it", async () => {
    const ws = workspace({ ...TWO_WAVES, rootIsRepo: true });
    writeFileSync(join(ws.repoDir, "README.md"), "# app\n\nuncommitted\n", "utf8");
    writeFileSync(join(ws.runDir, ".lock"), "held\n", "utf8");

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain("1 uncommitted change(s)");
    expect(text).toContain("README.md");
    expect(text).not.toContain(PROJECT_WORK_DIR);
    expect(text).not.toContain(PROJECT_FRAMEWORK_DIR);
    expect(text).toContain("Commit or stash them");
    expect(() => git(ws, ["rev-parse", "--verify", "epic/e1"])).toThrow();
    expect(story(ws, "S1")).toContain("status: todo");
  });

  test("single-repo: a story commit never carries the framework's own state", async () => {
    const ws = workspace({ ...ONE_STORY, rootIsRepo: true });
    // A story worktree is a checkout of the SAME repo, so it holds `tldrx-work/`
    // and `.tldrx/` too. `git add -A` would sweep anything written there into the
    // story commit — and from there into the diff a reviewer is asked to read.
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: {
        "s1.txt": "S1 was here\n",
        [`${PROJECT_WORK_DIR}/${ws.runId}/leaked.md`]: "written into the run folder\n",
        [`${PROJECT_FRAMEWORK_DIR}/leaked.txt`]: "written into the framework dir\n",
      },
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    const changed = git(ws, ["diff", "--name-only", "main...epic/e1"]).split("\n").filter((l) => l !== "");
    expect(changed).toEqual(["s1.txt"]);
  }, 60_000);

  test("multi-repo: a repo's own `tldrx-work/` is product dirt — that shape is untouched", async () => {
    // The state lives at the workspace root and the repo is a subdirectory, so a
    // `tldrx-work/` INSIDE the repo is the human's directory, not the framework's.
    const ws = workspace(TWO_WAVES);
    mkdirSync(join(ws.repoDir, PROJECT_WORK_DIR), { recursive: true });
    writeFileSync(join(ws.repoDir, PROJECT_WORK_DIR, "notes.md"), "mine\n", "utf8");

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain(PROJECT_WORK_DIR);
    expect(() => git(ws, ["rev-parse", "--verify", "epic/e1"])).toThrow();
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
    // developer gets 8/5 = $1.60. Before 2026-08-29 it was 8/2 = $4.00 capped to
    // $3.00, and 2 stories x 2 attempts x ($3.00 + $0.75) could charge $15.00
    // against an $8.00 stage — the audit's "Build 2.5x su fase".
    //
    // The reviewer's derived quarter-share is $0.40, and it is raised to
    // REVIEWER_FLOOR_USD. That is deliberate and it is the 2026-08-30 lesson: a
    // $0.26 reviewer died mid-read on a 39-file diff and the framework recorded
    // the corpse as "changes". A quarter of a share buys no review on anything
    // real, and an unread diff wastes the whole developer turn beside it.
    expect(caps).toEqual(["1.60", "1.00", "1.60", "1.00"]);
    // What THIS pass hands out still fits the stage; the floor is the one place
    // the strict "x MAX_ATTEMPTS also fits" arithmetic is knowingly given up,
    // and budget.yml's own gate is what stops a stage that actually runs out.
    const total = caps.reduce((sum, c) => sum + Number(c), 0);
    expect(total).toBeLessThanOrEqual(8 + 0.001);
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

/**
 * A developer that FAILED is not an attempt (2026-08-30) — the developer-side
 * sibling of the reviewer fix above, found by the same run.
 *
 * Measured on `260830-tenancy-identity-customers`: five developer spawns died
 * with `Reached maximum budget ($0.30 | $0.40 | $0.50 | $0.90 | $1.50)` having
 * written nothing — zero commits on any of the five story branches — and every
 * one was recorded as a story `blocked`. `blocked` is terminal in-run, so a spawn
 * that never ran ended the story, and the phase reported six of seven stories as
 * tried and failed when six of them had never been tried at all.
 *
 * The line these tests draw: did the spawn ERROR, or did it deliver work that was
 * then judged. The second still blocks, exactly as before.
 */
describe("a developer that FAILED is not an attempt", () => {
  const ONE: BuildWorkspaceOptions = {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
  };

  /** The live failure, word for word — S2's developer on 2026-08-30. */
  const DIED = "Reached maximum budget ($0.3)";
  const SPAWN_ERROR = `claude exited 1 with is_error=true: ${DIED}`;

  function reenter(ws: BuildWorkspace, note: string): void {
    reject(RunStore.open(ws.runDir), { root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note });
  }

  function developerChecks(ws: BuildWorkspace): readonly Record<string, unknown>[] {
    return events(ws).filter((e) => e.payload.check === "developer").map((e) => e.payload);
  }

  test("the story goes back where it was, and the ledger says the DEVELOPER failed", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "developer";

    const outcome = await next(ws);

    // Not `blocked`. `todo` is where the story was before a spawn that produced
    // nothing, and a turn that never ran may not move it.
    expect(story(ws, "S1")).toContain("status: todo");
    expect(story(ws, "S1")).not.toContain("status: blocked");
    expect(developerChecks(ws)).toEqual([{
      phase: "04-build",
      check: "developer",
      story: "S1",
      status: "error",
      attempt: 1,
      // The ERROR, verbatim: the one thing that tells a reader the turn never ran.
      detail: SPAWN_ERROR,
    }]);
    const said = outcome.lines.join("\n");
    expect(said).toContain("the developer FAILED and produced no work");
    expect(said).toContain(DIED);
  });

  test("the attempt is not consumed: no verdict is recorded and no second spawn follows", async () => {
    const ws = workspace(ONE);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "developer";

    await next(ws);

    // ONE developer prompt, and no reviewer at all — there was nothing to review.
    expect(readdirSync(promptDir)).toEqual(["developer-S1-1.md"]);
    expect(events(ws).filter((e) => e.type === "task.started").map((e) => e.payload.attempt)).toEqual([1]);
    const ledger = readReviewLedger(ws.runDir, "S1");
    expect(ledger.verdicts).toBe(0);
    expect(ledger.developerErroredWith).toBe(SPAWN_ERROR);
  });

  test("the worktree survives and nothing was merged into the epic", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "developer";

    await next(ws);

    expect(existsSync(join(ws.root, ".tldrx", "worktrees", "app", `${ws.runId}-S1`))).toBe(true);
    expect(git(ws, ["rev-parse", "epic/e1"])).toBe(git(ws, ["rev-parse", "main"]));
  });

  test("the log and the retro both say the DEVELOPER failed, never that it was reviewed", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "developer";

    await next(ws);

    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain(`- Developer: **FAILED** — ${SPAWN_ERROR}`);
    expect(log).toContain("The developer FAILED and produced no work");
    expect(log).not.toContain("asked for changes");

    const retro = readFileSync(join(ws.runDir, "retro.md"), "utf8");
    expect(retro).toContain("`S1` — the developer FAILED and produced no work on attempt 1");
  });

  test("`tldrx next` again re-runs the developer at the SAME attempt number", async () => {
    const ws = workspace(ONE);
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    // The FIRST developer of S1 dies; every later one works.
    process.env.FAKE_BUILD_FAIL = "developer:S1#1";

    await next(ws);
    expect(story(ws, "S1")).toContain("status: todo");

    reenter(ws, "the developer died");
    await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(story(ws, "S1")).toContain("status: done");
    // Two developer turns, and BOTH were attempt 1 — the first one never ran.
    expect(readdirSync(promptDir).filter((n) => n.startsWith("developer-")).sort())
      .toEqual(["developer-S1-1.md", "developer-S1-2.md"]);
    expect(events(ws).filter((e) => e.type === "task.started").map((e) => e.payload.attempt))
      .toEqual([1, 1]);
  }, 60_000);

  test("`--prepare` offers the story again as a fresh developer bundle", async () => {
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "developer";

    await next(ws);
    reenter(ws, "the developer died");
    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    const said = prepared.lines.join("\n");
    expect(said).toContain("prepared S1");
    expect(said).toContain("attempt 1 of 2");
    expect(said).toContain("dispatch ONE sub-agent");
  }, 60_000);

  test("a developer that RAN and failed its DoD still blocks — the fix is narrow", async () => {
    const ws = workspace({ ...ONE, testScript: RED_ONLY_AFTER_DEVELOPER });

    await next(ws);

    expect(story(ws, "S1")).toContain("status: blocked");
    // No developer check at all: the spawn was fine, the story was not.
    expect(developerChecks(ws)).toEqual([]);
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .not.toContain("The developer FAILED");
  });

  test("a story blocked by a failed DoD is NOT re-offered on the next invocation", async () => {
    const ws = workspace({ ...ONE, testScript: RED_ONLY_AFTER_DEVELOPER });
    process.env.FAKE_BUILD_COST = "0";

    await next(ws);
    reenter(ws, "look again");
    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(again.lines.join("\n")).toContain("S1 is already `blocked` — left alone");
    expect(again.lines.join("\n")).not.toContain("offered again");
  }, 60_000);

  test("a run recorded by the OLD code re-offers the story its spawn never got", async () => {
    // The live shape: `blocked`, verdict `n-a`, no commit, no check of any kind,
    // and the error only in `run.yml`. Nothing in `events.jsonl` said "developer".
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "developer:S1#1";

    await next(ws);
    rewriteAsOldCode(ws, "S1");
    expect(readReviewLedger(ws.runDir, "S1")).toMatchObject({
      developerErroredWith: null,
      blockedWithNothingRun: true,
    });

    reenter(ws, "old record");
    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });

    expect(again.lines.join("\n")).toContain("was `blocked` by a developer that FAILED");
    expect(story(ws, "S1")).toContain("status: done");
  }, 60_000);

  test("`--prepare` picks up an OLD-code `blocked` story too", async () => {
    // The in-session door onto the same migration: the live run is parked at
    // `blocked`, and a host session driving `--prepare`/`--commit` has to be
    // offered the turn its spawn never got, not told the stage is finished.
    const ws = workspace(ONE);
    process.env.FAKE_BUILD_COST = "0";
    process.env.FAKE_BUILD_FAIL_REASON = DIED;
    process.env.FAKE_BUILD_FAIL = "developer:S1#1";

    await next(ws);
    rewriteAsOldCode(ws, "S1");

    reenter(ws, "old record, in session");
    const prepared = await next(ws, { mode: "prepare", at: "2026-08-29T10:05:00Z" });

    const said = prepared.lines.join("\n");
    expect(said).toContain("prepared S1");
    expect(said).toContain("attempt 1 of 2");
    expect(story(ws, "S1")).toContain("status: in_progress");
  }, 60_000);

  /**
   * Rewrite the run into the pre-2026-08-30 spelling: drop the `developer` check
   * this executor now writes, and put the story back at `blocked` where the old
   * code left it.
   */
  function rewriteAsOldCode(ws: BuildWorkspace, storyId: string): void {
    const path = join(ws.runDir, "events.jsonl");
    const kept: string[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const event = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      const payload = event.payload ?? {};
      if (event.type === "check.failed" && payload.check === "developer" && payload.story === storyId) continue;
      if (event.type === "task.done" && payload.story === storyId) payload.status = "blocked";
      kept.push(JSON.stringify(event));
    }
    writeFileSync(path, `${kept.join("\n")}\n`, "utf8");
    const storyPath = join(ws.planDir, "stories", `${storyId}.md`);
    writeFileSync(storyPath, readFileSync(storyPath, "utf8").replace(/^status: .*$/m, "status: blocked"), "utf8");
  }
});

/**
 * The auto gate does not sign a Build stage over stories that are not `done`
 * (2026-08-30).
 *
 * Its other five conditions are all about the ARTEFACT — citations, questions,
 * money, status — and none of them looks at what the stage was for. On
 * `260830-tenancy-identity-customers` all five held while six of seven stories
 * sat `blocked` with zero commits, and the gate signed the stage twice, the
 * second time after a human had revoked it.
 */
describe("the auto gate and unfinished stories", () => {
  const ONE_AUTO: BuildWorkspaceOptions = {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
    gates: "none",
  };

  test("it signs a stage whose every story is `done`", async () => {
    const ws = workspace(ONE_AUTO);

    const outcome = await next(ws);

    expect(outcome.lines.join("\n")).toContain("auto-approved");
    expect(outcome.lines.join("\n")).toContain("stories=1 of 1 done");
    expect(RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages)[0]?.gate.by).toBe("auto");
  }, 60_000);

  test("it refuses a stage with a story that is not done, and names the story", async () => {
    const ws = workspace(ONE_AUTO);
    process.env.FAKE_BUILD_FAIL_REASON = "Reached maximum budget ($0.3)";
    process.env.FAKE_BUILD_FAIL = "developer";

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("auto gate not taken");
    expect(said).toContain("stories=0 of 1 done — S1:todo");
    expect(said).toContain(UNFINISHED_STORIES);
    // The gate is REQUESTED and still pending: a human decides, not the machine.
    const stage = RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages)[0];
    expect(stage?.gate.status).toBe("pending");
    expect(stage?.gate.by).toBeNull();
  }, 60_000);

  test("a blocked story refuses it too — the condition is `done`, not `attempted`", async () => {
    const ws = workspace({ ...ONE_AUTO, testScript: RED_ONLY_AFTER_DEVELOPER });

    const outcome = await next(ws);

    expect(outcome.lines.join("\n")).toContain("stories=0 of 1 done — S1:blocked");
    expect(RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages)[0]?.gate.status).toBe("pending");
  }, 60_000);

  test("a HUMAN may still approve over an unfinished story — the machine may not", async () => {
    // The whole point of the condition. Shipping an epic with a blocked story in
    // it is a judgement about what is worth shipping, and a person is allowed to
    // make it; the harness has no basis for making it on their behalf.
    const ws = workspace({ ...ONE_AUTO, testScript: RED_ONLY_AFTER_DEVELOPER });
    await next(ws);
    expect(story(ws, "S1")).toContain("status: blocked");

    const signed = await approve(RunStore.open(ws.runDir), {
      root: ws.root, actor: "alan", at: "2026-08-29T10:05:00Z", note: "shipping without S1 on purpose",
    });

    expect(signed.ok).toBe(true);
    const stage = RunStore.open(ws.runDir).run.phases.flatMap((p) => p.stages)[0];
    expect(stage?.gate.status).toBe("approved");
    expect(stage?.gate.by).toBe("alan");
  }, 60_000);
});

/**
 * A merge that moved nothing is not a merge (2026-08-30).
 *
 * `git merge --no-ff` of a branch that is already an ancestor exits 0 and says
 * "Already up to date". The handoff rendered that as "merged", and on
 * `260830-tenancy-identity-customers` its Gate section read
 * "(S1, S3, S5, S4, S7 merged)" when the epic tip carried only S1's work.
 */
describe("honest merge rendering", () => {
  const ONE_EMPTY: BuildWorkspaceOptions = {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
  };

  test("a story whose branch stays identical to the epic is not reported as merged", async () => {
    const ws = workspace(ONE_EMPTY);
    // A developer that writes nothing: the branch ends where it started.
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: {} });

    await next(ws);

    expect(git(ws, ["rev-parse", "epic/e1"])).toBe(git(ws, ["rev-parse", "main"]));
    const handoff = readFileSync(join(ws.runDir, "04-build", "handoff.md"), "utf8");
    expect(handoff).toContain("S1 added nothing — identical to `epic/e1`");
    expect(handoff).not.toContain("S1 merged");
    expect(handoff).toContain("its branch is identical to `epic/e1`: nothing was merged");
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain("nothing to merge — identical to the epic");
  }, 60_000);

  test("a story that really merged still says merged", async () => {
    const ws = workspace(TWO_WAVES);

    await next(ws);

    const handoff = readFileSync(join(ws.runDir, "04-build", "handoff.md"), "utf8");
    expect(handoff).toContain("(S1, S2 merged)");
    expect(handoff).not.toContain("added nothing");
    expect(readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8"))
      .toContain("→ `epic/e1` (merged)");
  }, 60_000);
});
