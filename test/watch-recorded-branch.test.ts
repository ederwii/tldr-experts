/**
 * The Watch stage reads the branch it diffs off the RUN's record — gh #90.
 *
 * ## What happened
 *
 * On `260901-leaderboard-v2` (2026-09-02) the watch prompt told BOTH watchers,
 * verbatim:
 *
 * > "Not diffed: `epic/leaderboard-v2-api` does not resolve in scavtopia-workflows.
 * >  Treat this feature's code as UNSEEN — cite `absent:` rather than guessing at
 * >  what it emits."
 *
 * That branch name was DERIVED from the epic file's own `branch:` declaration. The
 * run had cut ONE integration branch (issue #57) and recorded it in `run.yml` as
 * `build.epic_branch: [epic/260901-leaderboard-v2]`. The derived name existed
 * nowhere. An obedient watcher would have written an all-`absent:` card — which
 * PASSES `claim-sources`, because an `absent:` citation resolves by construction.
 * Confidently useless coverage, and only caught because the host's brief carried
 * the real branch independently.
 *
 * ## What is pinned here
 *
 * 1. The branch in the prompt comes from `build.epic_branch` / `build.branch_model`
 *    and NOWHERE else — asserted byte for byte, under both branch models.
 * 2. A branch the run RECORDED that does not resolve in its repo is incoherent
 *    state: a loud refusal naming the recorded value and the repo, never a
 *    treat-as-unseen instruction.
 * 3. The treat-as-unseen instruction survives for the one honest case: the run
 *    recorded no branch at all.
 *
 * Real git repos, real `git rev-parse`, the real executor. Only the sub-agent is
 * faked.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchExecutor } from "../src/core/facilitator/executors/watch.ts";
import type { ExecutorContext } from "../src/core/facilitator/executors/index.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import { collectFeatures, recordedEpicBranch, watcherRelPath, WATCH_PHASE } from "../src/core/watch/index.ts";
import type { BranchModelKind } from "../src/core/plan/branchModel.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here shells out to a real git. Process cost is a property of the box,
// not of the code (#43), so the budget scales with measured load.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST"] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
  clearSrcCaches();
});

// --- the fixture -----------------------------------------------------------

/** The real name Build cut and recorded — `integrationBranchFor("260901-leaderboard-v2")`. */
const RECORDED_INTEGRATION = "epic/260901-leaderboard-v2";
/** What the epic file DECLARES. Under #57's integration model, Build ignored it. */
const DECLARED_API = "epic/leaderboard-v2-api";
const DECLARED_CLIENT = "epic/leaderboard-v2-client";

const LEADERBOARD_CS = [
  "public sealed class LeaderboardRefresher",
  "{",
  "    public void Refresh() => _log.LogInformation(\"leaderboard.refreshed {Rows}\", rows);",
  "}",
  "",
].join("\n");

function git(dir: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Turn a fixture repo into a real git repo on `main`, with `branches` cut from it.
 * `default_branch: main` is what `.tldrx/workspace.yml` declares for both repos.
 */
function initRepo(root: string, repo: string, branches: readonly string[]): void {
  const dir = join(root, repo);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "Fixture"]);
  writeFileSync(join(dir, "README.md"), `# ${repo}\n`, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  for (const branch of branches) {
    git(dir, ["branch", branch]);
    // One commit on the branch, so the diff is non-empty and `resolved` is real.
    git(dir, ["checkout", "-q", branch]);
    writeFileSync(join(dir, "src.txt"), `landed on ${branch}\n`, "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `work on ${branch}`]);
    git(dir, ["checkout", "-q", "main"]);
  }
}

function story(id: string, epic: string, status: string, repo = "api"): string {
  const evidence = status === "done" ? `evidence: ["npm run test exited 0"]` : "evidence: []";
  return [
    "---", "version: 1", `id: ${id}`, `epic: ${epic}`, `title: "${id} on ${epic}"`,
    `repo: ${repo}`, `status: ${status}`, "depends_on: []", 'touches: ["src/"]',
    'acceptance: ["it works"]', 'test_plan: ["a unit test"]', evidence, "---", "",
    `# ${id}`, "", "## Definition of done", "", "```dod", "true", "```", "",
  ].join("\n");
}

function epic(id: string, branch: string, stories: readonly string[], repos = "[api]"): string {
  return [
    "---", "version: 1", `id: ${id}`, `title: "${id} — a shipped thing"`, `repos: ${repos}`,
    `stories: [${stories.join(", ")}]`, `branch: ${branch}`, "status: done", "---", "", `# ${id}`, "",
  ].join("\n");
}

function card(id: string, epicId: string, stories: readonly string[]): string {
  return [
    "---", "version: 1", `id: ${id}`, `epic: ${epicId}`, `title: "${id} — a shipped thing"`,
    `stories: [${stories.join(", ")}]`, "repos: [api]", "status: draft", "---", "", `# ${id}`, "",
    "## Signal",
    "- `leaderboard.refreshed` is emitted on every refresh [src: api:src/Leaderboard.cs:3]",
    "", "## Where", "- Application Insights `traces` [src: api:src/Leaderboard.cs:3]",
    "", "## Healthy baseline", "- 12-40 refreshes/hour [src: api:src/Leaderboard.cs:3]",
    "", "## Looks broken when", "- Zero refreshes for 30 minutes [src: api:src/Leaderboard.cs:3]",
    "", "## Query", "", "```kql", 'traces | where message startswith "leaderboard.refreshed"', "```",
    "", "## Sources", "", "`Leaderboard.cs:3` is the only place the event is emitted.", "",
  ].join("\n");
}

interface Recorded {
  readonly branches: readonly string[];
  readonly model?: BranchModelKind;
}

interface Fixture {
  readonly ws: FacilitatorWorkspace;
  readonly ctx: ExecutorContext;
}

function fixture(plan: Readonly<Record<string, string>>, recorded: Recorded | null): Fixture {
  const ws = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{
      id: "watch",
      phase: WATCH_PHASE,
      budgetUsd: 2,
      gate: "approve",
      outputs: [{ path: "handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
    }],
    files: { "api/src/Leaderboard.cs": LEADERBOARD_CS },
  });
  open.push(ws);
  for (const [rel, content] of Object.entries(plan)) {
    const path = join(ws.runDir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  const store = RunStore.open(ws.runDir);
  if (recorded !== null) {
    store.mutate((run) => ({
      ...run,
      build: {
        epic_branch: [...recorded.branches],
        ...(recorded.model === undefined ? {} : { branch_model: recorded.model }),
      },
    }));
    store.save();
  }
  return {
    ws,
    ctx: {
      root: ws.root,
      runId: store.runId,
      runDir: ws.runDir,
      phaseId: WATCH_PHASE,
      stageId: "watch",
      spec: loadStageSpec(ws.root, "demo", "watch"),
      repos: store.run.repos,
      mode: "headless",
      model: null,
      effort: null,
      costUsd: null,
      tokens: null,
      budgetUsd: 2,
      maxBudgetUsd: 2,
      yolo: false,
      at: "2026-09-02T10:00:00Z",
      keepWorktrees: false,
      parallel: 1,
      reuseEpic: false,
      discardPending: false,
      review: false,
      attendedByHost: false,
      agentCap: (share = 1) => Math.round(2 * share * 100) / 100,
      emit: () => undefined,
    },
  };
}

/** Two epics, both shipped: the shape of `260901-leaderboard-v2`. */
function twoEpicPlan(): Record<string, string> {
  return {
    "03-plan/stories/S1.md": story("S1", "E1", "done"),
    "03-plan/stories/S2.md": story("S2", "E2", "done"),
    "03-plan/epics/E1.md": epic("E1", DECLARED_API, ["S1"]),
    "03-plan/epics/E2.md": epic("E2", DECLARED_CLIENT, ["S2"]),
  };
}

function onePlan(declared: string): Record<string, string> {
  return {
    "03-plan/stories/S1.md": story("S1", "E1", "done"),
    "03-plan/epics/E1.md": epic("E1", declared, ["S1"]),
  };
}

function prompt(ws: FacilitatorWorkspace, featureId: string): string {
  return readFileSync(join(ws.runDir, ".agent", "watch", featureId, "prompt.md"), "utf8");
}

/**
 * Every branch the prompt's diff block names, in order.
 *
 * The header the Watch prompt writes per repo is
 * `` ### `<repo>` — `<base>...<branch>` `` — and that, byte for byte, is the
 * claim the watcher acts on. Nothing else in the prompt may introduce a branch
 * name: the epic FILE is inlined too and legitimately carries its own `branch:`
 * declaration, so a whole-prompt substring assertion would be testing the wrong
 * string.
 */
function branchLines(text: string): readonly string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^### `[^`]+` — `([^`.]+)\.\.\.([^`]+)`$/.exec(line.trim());
    if (match !== null) out.push(match[2] ?? "");
  }
  return out;
}

function fakeClaude(ws: FacilitatorWorkspace, outputs: Readonly<Record<string, string>>): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify(outputs);
  process.env.FAKE_CLAUDE_COST = "0.11";
}

// ---------------------------------------------------------------------------
// 1 — the derivation itself
// ---------------------------------------------------------------------------

describe("the integration branch model (#57): the branch is the one the run RECORDED", () => {
  test("both features are diffed against `build.epic_branch`, not their epics' declarations", async () => {
    const { ws, ctx } = fixture(twoEpicPlan(), {
      branches: [RECORDED_INTEGRATION],
      model: "integration",
    });
    initRepo(ws.root, "api", [RECORDED_INTEGRATION]);
    process.env.PATH = "";

    await watchExecutor({ ...ctx, mode: "prepare" });

    const features = collectFeatures(ws.runDir).map((f) => f.id);
    expect(features).toEqual(["leaderboard-v2-api", "leaderboard-v2-client"]);
    for (const id of features) {
      // The one assertion gh #90 is about: the branch line names the RECORD.
      expect(branchLines(prompt(ws, id))).toEqual([RECORDED_INTEGRATION]);
    }
  });

  test("no derived name reaches a branch line, and the recorded branch really diffs", async () => {
    const { ws, ctx } = fixture(twoEpicPlan(), {
      branches: [RECORDED_INTEGRATION],
      model: "integration",
    });
    initRepo(ws.root, "api", [RECORDED_INTEGRATION]);
    process.env.PATH = "";

    await watchExecutor({ ...ctx, mode: "prepare" });
    const text = prompt(ws, "leaderboard-v2-api");

    expect(branchLines(text)).not.toContain(DECLARED_API);
    expect(branchLines(text)).not.toContain(DECLARED_CLIENT);
    // A branch that resolves produces a real diff, so no absence is claimed at all.
    expect(text).not.toContain("Not diffed:");
    expect(text).toContain("src.txt");
  });
});

describe("the per-epic branch model: each feature gets ITS recorded branch", () => {
  test("two epics, two recorded branches, one each — byte for byte", async () => {
    const { ws, ctx } = fixture(twoEpicPlan(), {
      branches: [DECLARED_API, DECLARED_CLIENT],
      model: "per-epic",
    });
    initRepo(ws.root, "api", [DECLARED_API, DECLARED_CLIENT]);
    process.env.PATH = "";

    await watchExecutor({ ...ctx, mode: "prepare" });

    expect(branchLines(prompt(ws, "leaderboard-v2-api"))).toEqual([DECLARED_API]);
    expect(branchLines(prompt(ws, "leaderboard-v2-client"))).toEqual([DECLARED_CLIENT]);
  });

  test("an epic whose declaration the run never recorded gets NO branch line, and the record is named", async () => {
    // The epic file was edited after Build, or the branch was renamed. Either way
    // `epic/ghost` is a name this run never cut — asserting it "does not resolve"
    // would be asserting something about a branch nobody claimed.
    const { ws, ctx } = fixture(onePlan("epic/ghost"), {
      branches: [DECLARED_API],
      model: "per-epic",
    });
    initRepo(ws.root, "api", [DECLARED_API]);
    process.env.PATH = "";

    await watchExecutor({ ...ctx, mode: "prepare" });
    const text = prompt(ws, "ghost");

    expect(branchLines(text)).toEqual([]);
    expect(text).not.toContain("`epic/ghost` does not resolve");
    expect(text).toContain("build.epic_branch");
    expect(text).toContain(DECLARED_API);
  });
});

// ---------------------------------------------------------------------------
// 2 — the loud path
// ---------------------------------------------------------------------------

describe("a RECORDED branch that does not resolve is incoherent state, not an absence", () => {
  test("the stage refuses, names the recorded value and the repo, and spawns nothing", async () => {
    const { ws, ctx } = fixture(onePlan(DECLARED_API), {
      branches: [RECORDED_INTEGRATION],
      model: "integration",
    });
    // The repo is real; the recorded branch is not on it.
    initRepo(ws.root, "api", []);
    // A card WOULD be written if anything spawned — so the refusal is provable.
    fakeClaude(ws, { [watcherRelPath("leaderboard-v2-api")]: card("leaderboard-v2-api", "E1", ["S1"]) });

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toBe(true);
    expect(outcome.tasks).toEqual([]);
    expect(outcome.costUsd).toBe(0);
    const said = outcome.lines.join("\n");
    expect(said).toContain(RECORDED_INTEGRATION);
    expect(said).toContain("api");
    expect(said).toContain("build.epic_branch");
    // Never the soft instruction: that is what produced the useless card.
    expect(said).not.toContain("UNSEEN");
    expect(existsSync(join(ws.runDir, watcherRelPath("leaderboard-v2-api")))).toBe(false);
    expect(existsSync(join(ws.runDir, WATCH_PHASE, "handoff.md"))).toBe(false);
  });

  test("`--commit` does NOT refuse — that turn is already paid for", async () => {
    const { ws, ctx } = fixture(onePlan(DECLARED_API), {
      branches: [RECORDED_INTEGRATION],
      model: "integration",
    });
    initRepo(ws.root, "api", [RECORDED_INTEGRATION]);
    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });

    // The branch goes away between the two halves of the handshake — merged and
    // deleted, most likely. The card is already written; nothing is left to refuse.
    git(join(ws.root, "api"), ["branch", "-D", RECORDED_INTEGRATION]);
    const path = join(ws.runDir, watcherRelPath("leaderboard-v2-api"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, card("leaderboard-v2-api", "E1", ["S1"]), "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "watch", "leaderboard-v2-api", "result.json"),
      JSON.stringify({ outputs: [watcherRelPath("leaderboard-v2-api")], questions_asked: [], notes: "", cost_usd: 0.07 }),
      "utf8",
    );

    const outcome = await watchExecutor({ ...ctx, mode: "commit" });

    expect(outcome.ok).toBe(true);
    expect(outcome.refused).toBeUndefined();
    expect(existsSync(join(ws.runDir, WATCH_PHASE, "handoff.md"))).toBe(true);
  });

  test("`--prepare` refuses too — the bundle is never written", async () => {
    const { ws, ctx } = fixture(onePlan(DECLARED_API), {
      branches: [RECORDED_INTEGRATION],
      model: "integration",
    });
    initRepo(ws.root, "api", []);
    process.env.PATH = "";

    const outcome = await watchExecutor({ ...ctx, mode: "prepare" });

    expect(outcome.refused).toBe(true);
    expect(outcome.awaiting).toBe(false);
    expect(existsSync(join(ws.runDir, ".agent", "watch", "leaderboard-v2-api", "prompt.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 — the honest absence keeps its instruction
// ---------------------------------------------------------------------------

describe("a run that recorded no branch at all", () => {
  test("the prompt says so against run.yml and keeps the treat-as-UNSEEN instruction", async () => {
    const { ws, ctx } = fixture(onePlan(DECLARED_API), null);
    initRepo(ws.root, "api", []);
    process.env.PATH = "";

    await watchExecutor({ ...ctx, mode: "prepare" });
    const text = prompt(ws, "leaderboard-v2-api");

    expect(branchLines(text)).toEqual([]);
    expect(text).toContain("build.epic_branch");
    expect(text).toContain("UNSEEN");
    // The derived name is never presented as a branch that failed to resolve.
    expect(text).not.toContain(`\`${DECLARED_API}\` does not resolve`);
  });
});

// ---------------------------------------------------------------------------
// 4 — the resolver, directly
// ---------------------------------------------------------------------------

describe("recordedEpicBranch reads the record and nothing else", () => {
  function feature(declared: string) {
    const { ws } = fixture(onePlan(declared), null);
    const found = collectFeatures(ws.runDir)[0];
    if (found === undefined) throw new Error("the fixture shipped no feature");
    return found;
  }

  test("integration: the run's one recorded branch, whatever the epic declares", () => {
    const found = recordedEpicBranch(
      { epic_branch: [RECORDED_INTEGRATION], branch_model: "integration" },
      feature(DECLARED_API),
    );
    expect(found).toEqual({ kind: "recorded", branch: RECORDED_INTEGRATION });
  });

  test("per-epic: the recorded entry the epic declares", () => {
    const found = recordedEpicBranch(
      { epic_branch: [DECLARED_API, DECLARED_CLIENT], branch_model: "per-epic" },
      feature(DECLARED_API),
    );
    expect(found).toEqual({ kind: "recorded", branch: DECLARED_API });
  });

  test("a run with no `build:` block is unrecorded, and says which key is missing", () => {
    const found = recordedEpicBranch(undefined, feature(DECLARED_API));
    expect(found.kind).toBe("unrecorded");
    expect(found.kind === "unrecorded" ? found.reason : "").toContain("build.epic_branch");
  });

  test("no `branch_model` and one recorded branch is read as per-epic (a pre-#57 run)", () => {
    const found = recordedEpicBranch({ epic_branch: [DECLARED_API] }, feature(DECLARED_API));
    expect(found).toEqual({ kind: "recorded", branch: DECLARED_API });
  });

  test("a declaration outside the record is unrecorded, and the reason names both", () => {
    const found = recordedEpicBranch(
      { epic_branch: [DECLARED_API], branch_model: "per-epic" },
      feature("epic/ghost"),
    );
    expect(found.kind).toBe("unrecorded");
    const reason = found.kind === "unrecorded" ? found.reason : "";
    expect(reason).toContain("epic/ghost");
    expect(reason).toContain(DECLARED_API);
  });
});
