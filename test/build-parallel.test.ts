/**
 * Stories of ONE wave, running at once (`--parallel N`, spec §5).
 *
 * `waves.yml` already guarantees a dependency is in an EARLIER wave, so a wave's
 * stories are independent by construction and this is a scheduling change, not a
 * correctness one. Four properties are worth a test each and they are all here:
 *
 *   - N stories really do overlap, and the N+1st waits;
 *   - merges land in the wave's LISTED order however the fan-out finished;
 *   - a red story does not cancel its siblings, and the next wave does not start;
 *   - N = 1 is byte-identical to what shipped.
 *
 * **Nothing here asserts on elapsed time.** The fake `claude` writes a marker
 * while it works and appends `{story, role, event, live}` to a shared
 * `timeline.jsonl`; the file's line order is the happens-before record and `live`
 * is how many markers existed at that moment. That is what the processes saw, and
 * it reproduces on a CI box that is ten times slower than this one.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { clampParallel, DEFAULT_PARALLEL, REVIEWER_FLOOR_USD } from "../src/core/facilitator/executors/build.ts";
import { parallelFlag } from "../src/cli/commands/next.ts";
import { parseArgs, UsageError } from "../src/cli/argv.ts";
import { declaredFlags, declaredValueFlags } from "../src/cli/helpText.ts";
import { loadStageSpec, stageOrder } from "../src/core/facilitator/stageSpec.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { FRAMEWORK_ROOT, WORKFLOWS_DIR } from "../src/core/paths.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { UiState } from "../src/core/ui/state.ts";
import { renderCompact } from "../src/core/ui/compact.ts";
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
  "FAKE_BUILD_LIVE_DIR", "FAKE_BUILD_SLEEP_MS", "FAKE_BUILD_PID_DIR",
] as const;

let open: BuildWorkspace[] = [];
/** Bare roots made by the shipped-defaults tests — their own dirs, removed here. */
let bare: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const root of bare) rmSync(root, { recursive: true, force: true });
  bare = [];
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

/** Three independent stories in ONE wave — the shape the fan-out exists for. */
const THREE_IN_ONE_WAVE: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First" },
    { id: "S2", epic: "E1", title: "Second" },
    { id: "S3", epic: "E1", title: "Third" },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2", "S3"], branch: "epic/e1" }],
  waves: [["S1", "S2", "S3"]],
};

interface TimelineEntry {
  readonly story: string;
  readonly role: string;
  readonly event: string;
  readonly live: number;
}

/** The fakes' own happens-before record, in append order. */
function timeline(dir: string): readonly TimelineEntry[] {
  const path = join(dir, "timeline.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TimelineEntry);
}

function liveDirOn(ws: BuildWorkspace): string {
  const dir = join(ws.root, "live");
  process.env.FAKE_BUILD_LIVE_DIR = dir;
  return dir;
}

function git(ws: BuildWorkspace, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: ws.repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown>; actor: string | null }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

/** The same shape the N=1 snapshot below is written in. */
function sequence(ws: BuildWorkspace): readonly string[] {
  return events(ws).map((e) => {
    const key = e.payload.story ?? e.payload.key ?? e.payload.check ?? "";
    return `${e.type}${key === "" ? "" : `:${String(key)}`}${e.actor === "facilitator" ? "" : `@${e.actor ?? ""}`}`;
  });
}

// ---------------------------------------------------------------------------

describe("the flag", () => {
  test("`--parallel` is declared in the registry for both commands that take it", () => {
    // The invariant test in cli.test.ts checks every flag the CLI reads is
    // declared; this checks the two entries are the RIGHT two.
    expect(declaredFlags("next").has("parallel")).toBe(true);
    expect(declaredValueFlags("next").has("parallel")).toBe(true);
    expect(declaredFlags("run").has("parallel")).toBe(true);
    expect(declaredValueFlags("run").has("parallel")).toBe(true);
  });

  test("it is refused rather than clamped when it is not a whole number >= 1", () => {
    const args = (argv: readonly string[]): ReturnType<typeof parseArgs> => parseArgs(argv, ["parallel"]);
    expect(parallelFlag(args([]))).toBeUndefined();
    expect(parallelFlag(args(["--parallel", "3"]))).toBe(3);
    // A `--parallel 0` that quietly became 1 would be a flag that lied.
    expect(() => parallelFlag(args(["--parallel", "0"]))).toThrow(UsageError);
    expect(() => parallelFlag(args(["--parallel", "-2"]))).toThrow(UsageError);
    expect(() => parallelFlag(args(["--parallel", "2.5"]))).toThrow(UsageError);
  });

  test("the executor clamps what reaches it: floor 1, ceiling the per-wave story cap", () => {
    expect(DEFAULT_PARALLEL).toBe(1);
    expect(clampParallel(undefined)).toBe(1);
    expect(clampParallel(0)).toBe(1);
    expect(clampParallel(-4)).toBe(1);
    expect(clampParallel(3)).toBe(3);
    expect(clampParallel(1000)).toBe(32);
    expect(clampParallel(Number.NaN)).toBe(1);
  });

  test("the workflow's `build: {parallel: N}` is read, and stage.yml's is the fallback", () => {
    const ws = workspace({
      ...THREE_IN_ONE_WAVE,
      files: {
        ".tldrx/workflows/wide.yml": [
          "version: 1", "name: wide", 'title: "wide"', "depth: minimal", "default_budget_usd: 8",
          "skips: []", "build: {parallel: 4}",
          "stages:", '  - {id: build, phase: "04-build", budget_usd: 8}', "",
        ].join("\n"),
      },
    });
    expect(loadStageSpec(ws.root, "wide", "build").parallel).toBe(4);
    // The shipped `build-only` workflow says nothing, and the fixture's stage.yml
    // says nothing either — so the answer is "the run decides", i.e. null ⇒ 1.
    expect(loadStageSpec(ws.root, "build-only", "build").parallel).toBeNull();
  });
});

describe("what the SHIPPED build stage says", () => {
  /**
   * The framework's own opinion, read through the real resolution off a root that
   * overrides nothing — so `stagePath`/`workflowPath` fall through to `stages/`
   * and `workflows/` exactly as an installed workspace does.
   */
  function shippedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "tldrx-shipped-"));
    bare.push(root);
    return root;
  }

  test("a workspace that overrides nothing gets two lanes in Build", () => {
    // `waves.yml` guarantees a dependency is in an EARLIER wave, so the stories of
    // one wave are independent by construction (`plan/validatePlan.ts`, spec §5) —
    // running two is a scheduling change, not a correctness one.
    expect(loadStageSpec(shippedRoot(), "feature", "build").parallel).toBe(2);
  });

  /** `workflows/retro.yml` lists no stages at all and REFUSES to load — not a build scope. */
  function hasBuild(root: string, scope: string): boolean {
    try {
      return stageOrder(loadWorkflowPreset(root, scope)).includes("build");
    } catch {
      return false;
    }
  }

  test("every shipped workflow with a Build stage inherits it — none resets it", () => {
    const root = shippedRoot();
    const withBuild = readdirSync(WORKFLOWS_DIR)
      .filter((file) => file.endsWith(".yml"))
      .map((file) => file.replace(/\.yml$/, ""))
      .filter((scope) => hasBuild(root, scope));
    expect(withBuild.length).toBeGreaterThan(0);
    for (const scope of withBuild) {
      expect([scope, loadStageSpec(root, scope, "build").parallel]).toEqual([scope, 2]);
    }
  });

  test("a workflow still outranks it, and the code fallback is still 1", () => {
    const root = shippedRoot();
    mkdirSync(join(root, ".tldrx", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".tldrx", "workflows", "wider.yml"),
      [
        "version: 1", "name: wider", 'title: "wider"', "depth: minimal", "default_budget_usd: 8",
        "skips: []", "build: {parallel: 3}",
        "stages:", '  - {id: build, phase: "04-build", budget_usd: 8}', "",
      ].join("\n"),
    );
    expect(loadStageSpec(root, "wider", "build").parallel).toBe(3);
    // The shipped stage carries the opinion; the CODE default stays the last
    // resort, for a workspace whose stage.yml says nothing at all.
    expect(DEFAULT_PARALLEL).toBe(1);
    // And the flag still wins over both, at the only place it is read.
    expect(clampParallel(1)).toBe(1);
  });

  test("the ROADMAP no longer calls Build sequential", () => {
    const roadmap = readFileSync(join(FRAMEWORK_ROOT, "docs", "ROADMAP.md"), "utf8");
    expect(roadmap).not.toContain("Sequential on purpose");
  });
});

describe("N = 1 is what shipped", () => {
  /**
   * Captured from `main` at e28124a by running this exact fixture through
   * `runNext` and mapping every event to `type:key@actor`. If the parallel work
   * ever changes the sequential path, this is the line that says so.
   */
  const MAIN_SEQUENCE = [
    "run.created@alan",
    "stage.started",
    "task.started:S1", "agent.spawned:S1@developer", "check.passed:S1",
    "agent.spawned:S1@reviewer", "check.passed:S1", "task.done:S1",
    "task.started:S2", "agent.spawned:S2@developer", "check.passed:S2",
    "agent.spawned:S2@reviewer", "check.passed:S2", "task.done:S2",
    "task.started:S3", "agent.spawned:S3@developer", "check.passed:S3",
    "agent.spawned:S3@reviewer", "check.passed:S3", "task.done:S3",
    "agent.result:S1", "agent.result:S1",
    "agent.result:S2", "agent.result:S2",
    "agent.result:S3", "agent.result:S3",
    "check.passed:claim-sources",
    "gate.requested",
  ];

  test("the default emits main's event sequence, event for event", async () => {
    const ws = workspace(THREE_IN_ONE_WAVE);
    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(sequence(ws)).toEqual(MAIN_SEQUENCE);
    // And nothing says a wave fanned out, because none did.
    expect(outcome.lines.join("\n")).not.toContain("at a time");
  }, 90_000);

  test("`--parallel 1` is the same thing said out loud", async () => {
    const ws = workspace(THREE_IN_ONE_WAVE);
    await next(ws, { parallel: 1 });
    expect(sequence(ws)).toEqual(MAIN_SEQUENCE);
  }, 90_000);
});

describe("N = 2 over three stories in one wave", () => {
  test("two overlap and the third waits — read off what the sub-agents saw", async () => {
    const ws = workspace(THREE_IN_ONE_WAVE);
    const dir = liveDirOn(ws);
    process.env.FAKE_BUILD_SLEEP_MS = "150";

    const outcome = await next(ws, { parallel: 2 });
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("W1: 3 story(ies), 2 at a time");

    const devs = timeline(dir).filter((entry) => entry.role === "developer");
    expect(devs.filter((e) => e.event === "start")).toHaveLength(3);

    // Two markers existed at once — the overlap, observed by the fakes.
    expect(Math.max(...devs.map((e) => e.live))).toBe(2);

    // The third started only after one of the first two had finished. Read off
    // the file's ORDER, so a slow machine cannot make this flaky.
    const thirdStart = devs.findIndex((e) => e.event === "start" && e.story === "S3");
    const firstEnd = devs.findIndex((e) => e.event === "end");
    expect(firstEnd).toBeGreaterThanOrEqual(0);
    expect(thirdStart).toBeGreaterThan(firstEnd);

    // Reviewers are serial by design (their diff's merge base moves when another
    // story merges into the epic), so they never overlap.
    const reviewers = timeline(dir).filter((entry) => entry.role === "reviewer");
    expect(reviewers.length).toBeGreaterThan(0);
    expect(Math.max(...reviewers.map((e) => e.live))).toBe(1);

    // Every story still reached `done` with its evidence.
    for (const id of ["S1", "S2", "S3"]) {
      expect(readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8")).toContain("status: done");
    }
  }, 90_000);

  test("merges land in the wave's listed order, whatever order the fan-out finished in", async () => {
    const ws = workspace(THREE_IN_ONE_WAVE);
    const dir = liveDirOn(ws);
    // S1 is the slowest, so it finishes LAST — and must still merge FIRST.
    process.env.FAKE_BUILD_SLEEP_MS = JSON.stringify({ S1: 400, S2: 30, S3: 10 });

    await next(ws, { parallel: 3 });

    const devEnds = timeline(dir)
      .filter((entry) => entry.role === "developer" && entry.event === "end")
      .map((entry) => entry.story);
    expect(devEnds[devEnds.length - 1]).toBe("S1");

    // `git log` is newest first, so the listed order S1, S2, S3 reads bottom-up.
    const merges = git(ws, ["log", "epic/e1", "--oneline"])
      .split("\n")
      .filter((line) => line.includes("merge("))
      .map((line) => /merge\((S\d)\)/.exec(line)?.[1] ?? "")
      .reverse();
    expect(merges).toEqual(["S1", "S2", "S3"]);
  }, 90_000);

  test("each sub-agent keeps its own share, and every share the wave hands out fits the ceiling", async () => {
    const ws = workspace({ ...THREE_IN_ONE_WAVE, budgetUsd: 9, perAgentMaxUsd: 9 });
    await next(ws, { parallel: 3 });

    const caps = events(ws)
      .filter((e) => e.type === "agent.spawned")
      .map((e) => Number(e.payload.max_budget_usd));
    expect(caps.length).toBe(6);           // three developers, three reviewers
    expect(new Set(caps).size).toBe(2);    // one developer share, one reviewer share
    // `worstCaseShares` = stories x attempts x (1 + REVIEWER_SHARE) = 3 x 2 x 1.25,
    // so the developer share is 9/7.5 = $1.20. The reviewer's derived $0.30 is
    // raised to REVIEWER_FLOOR_USD: a reviewer under a dollar does not finish
    // reading a real diff (measured 2026-08-30, $0.26 died mid-read).
    const stage = RunStore.open(ws.runDir).run.phases[0]?.stages[0];
    expect(caps.filter((cap) => cap === 1.2).length).toBe(3);
    expect(caps.filter((cap) => cap === REVIEWER_FLOOR_USD).length).toBe(3);
    // What this invocation hands out is inside the ceiling. The floor knowingly
    // gives up the stricter "and again on every retry" version of that property.
    expect(caps.reduce((sum, cap) => sum + cap, 0)).toBeLessThanOrEqual(stage?.budget_usd ?? 0);
  }, 90_000);
});

describe("a story that fails inside a parallel wave", () => {
  /**
   * **THIS CASE CHANGED WITH #260 — read this before "fixing" it back.**
   *
   * Until #260 `S4` carried NO `depends_on` and this test asserted it stayed
   * `todo`: it froze "a blocked story with no dependents stops an independent
   * story" as correct behaviour, which is the defect #260 was filed for (a run
   * built 5 of 8 stories and reported the stage `done`). What the `break` it
   * pinned actually defends is the 1-of-N rule in the executor's own comment —
   * "Wave N+1 fanning out over code wave N failed to produce is how one red story
   * becomes N of them" — and that rule is about a story that DEPENDS on the
   * blocked one. So `S4` now declares `depends_on: [S2]`, and the assertion below
   * is true for the reason the comment gives. The case where the later story
   * depends on nothing that blocked is the first test in the describe below, and
   * it asserts the opposite. Do not drop the `dependsOn` to make a diff close.
   */
  test("its siblings finish, the wave ends failed, and a story that DEPENDS on the red one does not start", async () => {
    const ws = workspace({
      stories: [
        { id: "S1", epic: "E1", title: "First" },
        // Its own dod command, and that command goes red once its developer has run.
        { id: "S2", epic: "E1", title: "Second, red", dod: ["npm run lint"] },
        { id: "S3", epic: "E1", title: "Third" },
        { id: "S4", epic: "E1", title: "Fourth, in the next wave", dependsOn: ["S2"] },
      ],
      epics: [{ id: "E1", stories: ["S1", "S2", "S3", "S4"], branch: "epic/e1" }],
      waves: [["S1", "S2", "S3"], ["S4"]],
      commands: { build: null, test: "npm run test", lint: "npm run lint", typecheck: null, run: null },
      repoFiles: {
        "package.json": `${JSON.stringify({
          name: "app",
          version: "0.0.0",
          private: true,
          scripts: {
            test: 'node -e "process.exit(0)"',
            // Green on the untouched base tree, red in a worktree a developer has
            // written its story file into. A `lint` that failed on main too is a
            // WORKSPACE-CONFIG error since the base-tree pre-flight landed
            // (issue #41) and would refuse the whole build — which is not what
            // this test is about.
            lint: 'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"',
          },
        }, null, 2)}\n`,
      },
    });
    const dir = liveDirOn(ws);
    process.env.FAKE_BUILD_SLEEP_MS = "80";

    const outcome = await next(ws, { parallel: 3 });
    const said = outcome.lines.join("\n");

    // The siblings were not cancelled: all three developers ran to completion.
    const devEnds = timeline(dir).filter((e) => e.role === "developer" && e.event === "end");
    expect(devEnds.map((e) => e.story).sort()).toEqual(["S1", "S2", "S3"]);

    const story = (id: string): string => readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
    expect(story("S1")).toContain("status: done");
    expect(story("S3")).toContain("status: done");
    expect(story("S2")).toContain("status: blocked");

    // The wave ended failed, and S4 — which depends on S2 — never started. It is
    // `blocked` WITH the reason rather than silently `todo` (#260): the reason is
    // what `run status` and the next turn read.
    expect(said).toContain("S4 was not started");
    expect(said).toContain("dependency S2 blocked");
    expect(story("S4")).toContain("status: blocked");
    expect(events(ws).some((e) => e.type === "task.started" && e.payload.story === "S4")).toBe(false);
    expect(git(ws, ["log", "epic/e1", "--oneline"])).not.toContain("merge(S2)");
  }, 90_000);
});

/**
 * The wave boundary asks per STORY, not per wave (#260).
 *
 * A blocked story used to end the loop for everything behind it: a run told to
 * build 8 stories built 5, left S3 and S4 `todo` while the only thing S3 depended
 * on was `done`, and reported the stage `done` with nothing written anywhere
 * saying which stories it never started. The rule the old `break` defended is
 * kept — nothing fans out over code that was not landed — it just stops applying
 * to a story that never needed that code.
 *
 * Both directions are pinned here, and they are the same fixture with ONE field
 * moved, so neither can be satisfied by a rule that ignores `depends_on`:
 * mutate `waveFailed`/the frontier back to a wave-wide `some(...)` and the first
 * goes red; drop the `dependency <id> blocked` write and the second does.
 */
describe("a later wave whose dependencies are settled (#260)", () => {
  /**
   * W1 = [S1, S2] with S2 red on its own `dod`, W2 = [S3]. `dependsOn` is the
   * only thing the two cases below disagree about.
   */
  function twoWaves(dependsOn: readonly string[]): BuildWorkspace {
    return workspace({
      stories: [
        { id: "S1", epic: "E1", title: "First" },
        // Its own dod command, and that command goes red once its developer has run.
        { id: "S2", epic: "E1", title: "Second, red", dod: ["npm run lint"] },
        { id: "S3", epic: "E1", title: "Third, in the next wave", dependsOn },
      ],
      epics: [{ id: "E1", stories: ["S1", "S2", "S3"], branch: "epic/e1" }],
      waves: [["S1", "S2"], ["S3"]],
      commands: { build: null, test: "npm run test", lint: "npm run lint", typecheck: null, run: null },
      repoFiles: {
        "package.json": `${JSON.stringify({
          name: "app",
          version: "0.0.0",
          private: true,
          scripts: {
            test: 'node -e "process.exit(0)"',
            // Green on the untouched base tree, red in a worktree a developer has
            // written its story file into — the same trick the describe above uses.
            lint: 'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"',
          },
        }, null, 2)}\n`,
      },
    });
  }

  function storyFile(ws: BuildWorkspace, id: string): string {
    return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
  }

  /** The bullets of one `## ` section of the Build handoff, in file order. */
  function handoffSection(ws: BuildWorkspace, name: string): readonly string[] {
    const text = readFileSync(join(ws.runDir, "04-build", "handoff.md"), "utf8");
    const lines = text.split("\n");
    const start = lines.indexOf(`## ${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.startsWith("- "));
  }

  test("S3 depends on the story that PASSED, so it runs and the stage counts it", async () => {
    const ws = twoWaves(["S1"]);
    process.env.FAKE_BUILD_SLEEP_MS = "80";

    const outcome = await next(ws, { parallel: 2 });
    const said = outcome.lines.join("\n");

    // The whole point: S3's dependency is `done`, so S3 is attempted.
    expect(events(ws).some((e) => e.type === "task.started" && e.payload.story === "S3")).toBe(true);
    expect(storyFile(ws, "S3")).toContain("status: done");
    expect(storyFile(ws, "S2")).toContain("status: blocked");
    // The count is over every SCHEDULED story, not over the rows the executor
    // happened to hold: 2 of 3, never 2 of 2.
    expect(said).toContain("2 of 3 story(ies) done");
    // `## Unknowns` needs a human for S2 and for nothing else.
    const unknowns = handoffSection(ws, "Unknowns").filter((b) => b.includes("needs a human"));
    expect(unknowns.length).toBe(1);
    expect(unknowns[0]).toContain("S2 is `blocked`");
  }, 90_000);

  test("S3 depends on the story that BLOCKED, so it is not run — `blocked` with the reason, never a silent `todo`", async () => {
    const ws = twoWaves(["S2"]);
    process.env.FAKE_BUILD_SLEEP_MS = "80";

    const outcome = await next(ws, { parallel: 2 });
    const said = outcome.lines.join("\n");

    // The dangerous direction, and the reason the `break` existed at all: nothing
    // fans out over code S2 did not land.
    expect(events(ws).some((e) => e.type === "task.started" && e.payload.story === "S3")).toBe(false);
    expect(storyFile(ws, "S3")).toContain("status: blocked");
    expect(said).toContain("S3 was not started");
    const unknowns = handoffSection(ws, "Unknowns").filter((b) => b.includes("needs a human"));
    expect(unknowns.map((b) => b.includes("S3") && b.includes("dependency S2 blocked"))).toContain(true);
    expect(unknowns.length).toBe(2);
  }, 90_000);
});

describe("the live view", () => {
  test("one activity line per running lane, joined; a finished lane stops taking a column", () => {
    const state = new UiState({ root: "/w", startedAt: 0, width: 96 });
    state.apply({ kind: "tool", id: "1", name: "Read", target: "/w/src/a.ts" }, 10, "S1");
    state.apply({ kind: "tool", id: "2", name: "Bash", target: "dotnet test" }, 20, "S2");

    const both = state.snapshot(30).activity;
    expect(both).toContain("S1 ");
    expect(both).toContain("S2 ");
    expect(both).toContain(" · ");
    // The compact one-liner shows the same thing, cut to the terminal.
    expect(renderCompact(state.snapshot(30), 200, 0)).toContain(" · ");

    state.apply({ kind: "done", ok: true, structured: null, costUsd: 0.1 }, 40, "S1");
    const after = state.snapshot(50).activity;
    expect(after).not.toContain("S1 ");
    expect(after).toContain("S2 ");
  });

  test("with no lane the activity line is exactly what it always was", () => {
    const state = new UiState({ root: "/w", startedAt: 0, width: 96 });
    state.apply({ kind: "tool", id: "1", name: "Read", target: "/w/src/a.ts" }, 10);
    const activity = state.snapshot(20).activity;
    expect(activity).not.toContain(" · ");
    expect(activity).not.toMatch(/^S\d /);
  });
});

describe("SIGTERM during a parallel wave", () => {
  const BIN = join(import.meta.dir, "..", "bin", "tldrx.ts");

  test("kills every live child, not just the first", async () => {
    const ws = workspace(THREE_IN_ONE_WAVE);
    const pidDir = join(ws.root, "pids");

    const proc = Bun.spawn(
      [process.execPath, BIN, "next", "--root", ws.root, "--parallel", "2", "--ui", "off"],
      {
        cwd: ws.root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: ws.binDir,
          FAKE_BUILD_STATE: ws.statePath,
          FAKE_BUILD_PID_DIR: pidDir,
          // Long enough that both are certainly still running when the signal
          // lands — the wait below is on the FILES, not on this number.
          FAKE_BUILD_SLEEP_MS: "30000",
        },
      },
    );

    // Wait for TWO developers to be alive. Loose deadline: CI is slow, and the
    // assertion is "two exist", never "two exist within X ms".
    const deadline = Date.now() + 30_000;
    const pids = (): number[] => {
      if (!existsSync(pidDir)) return [];
      return readdirSync(pidDir)
        .filter((name) => name.startsWith("developer-"))
        .map((name) => Number(readFileSync(join(pidDir, name), "utf8").trim()));
    };
    while (pids().length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const live = pids();
    expect(live.length, "two developers never started").toBe(2);
    for (const pid of live) expect(isAlive(pid)).toBe(true);

    proc.kill("SIGTERM");
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    expect(code).toBe(130);
    expect(stderr).toContain("killed 2 sub-agent process tree(s)");
    for (const pid of live) {
      let alive = isAlive(pid);
      for (let i = 0; i < 200 && alive; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        alive = isAlive(pid);
      }
      expect(alive, `pid ${String(pid)} survived SIGTERM`).toBe(false);
    }
    // And the run is left where `tldrx next` can pick it up again.
    expect(existsSync(join(ws.runDir, ".lock"))).toBe(false);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("ready");
  }, 120_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
