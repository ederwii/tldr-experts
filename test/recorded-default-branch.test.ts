/**
 * A recorded `default_branch` that does not resolve is incoherent state — gh #92.
 *
 * ## The gap
 *
 * gh #90 taught `epicDiff` to tell two absences apart: a run that RECORDED no
 * branch (honest — the prompt says so and instructs `absent:`) and a branch the
 * run's own `build.epic_branch` claims that the repo cannot find (incoherent —
 * the Watch stage refuses, naming the value and the repo).
 *
 * It deliberately left a third case alone. `.tldrx/workspace.yml` declares
 * `default_branch: main` for a repo where `main` does not resolve — a value the
 * WORKSPACE records that the repo cannot find — and Watch rendered it as
 *
 * > `_Not diffed: `main`, the `default_branch` of api, does not resolve there.`
 * >  `Treat this feature's code as UNSEEN — cite `absent:` rather than guessing._`
 *
 * which invites exactly the all-`absent:` card that PASSES `claim-sources` and
 * covers nothing. Same shape of contradiction, same instruction, narrower blast
 * radius (a misdetected or renamed default branch, not an every-run derivation).
 *
 * ## What is pinned here
 *
 * 1. **Watch** refuses at `--prepare`, naming the repo, the recorded value and the
 *    fix. Never the treat-as-UNSEEN instruction. `--commit` stays tolerant, the
 *    same call gh #90 made: that turn is already paid for.
 * 2. **`tldrx doctor`** reports it — the command whose whole job is "what does this
 *    machine and this workspace actually have". A WARNING, never a blocker.
 * 3. **`boundary`** — MEASURED, not assumed. It diffs the same range at the Build
 *    gate and it IS affected, but only in its wording: the gate's `n/a` verdict is
 *    a documented contract that must not change, so what is fixed is that its
 *    reason names the RECORDED value rather than reading like a deleted branch.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchExecutor } from "../src/core/facilitator/executors/watch.ts";
import type { ExecutorContext } from "../src/core/facilitator/executors/index.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import { renderDiffs, watcherRelPath, WATCH_PHASE } from "../src/core/watch/index.ts";
import { evaluateBoundary, epicTargets } from "../src/core/run/boundary.ts";
import { loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { DoctorReport } from "../src/core/doctor/DoctorReport.ts";
import { findUnresolvedDefaultBranches } from "../src/core/doctor/recordedDefaultBranch.ts";
import { runDoctor } from "../src/core/doctor/runDoctor.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Real git, real processes. Cost is a property of the box, not of the code (#43).
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_BUILD_STATE"] as const;

let openWatch: FacilitatorWorkspace[] = [];
let openBuild: BuildWorkspace[] = [];
let openTemp: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of openWatch) ws.dispose();
  for (const ws of openBuild) ws.dispose();
  for (const dir of openTemp) rmSync(dir, { recursive: true, force: true });
  openWatch = [];
  openBuild = [];
  openTemp = [];
  clearSrcCaches();
});

// --- shared fixture bits ---------------------------------------------------

const RECORDED_BRANCH = "epic/260901-leaderboard-v2";
const DECLARED_API = "epic/leaderboard-v2-api";

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

/** A real git repo on `main`, with `branches` cut from it. */
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
    git(dir, ["checkout", "-q", branch]);
    writeFileSync(join(dir, "src.txt"), `landed on ${branch}\n`, "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `work on ${branch}`]);
    git(dir, ["checkout", "-q", "main"]);
  }
}

/**
 * Rewrite ONE repo's `default_branch:` in `.tldrx/workspace.yml`.
 *
 * This is the whole of #92's setup: the workspace RECORDS a value, and the repo
 * on disk has never had a branch by that name.
 */
function recordDefaultBranch(root: string, repo: string, branch: string): void {
  const path = join(root, ".tldrx", "workspace.yml");
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let inRepo = false;
  const out = lines.map((line) => {
    if (line.trim().startsWith("- name:")) inRepo = line.trim() === `- name: ${repo}`;
    if (inRepo && line.trim().startsWith("default_branch:")) {
      return line.replace(/default_branch:.*/, `default_branch: ${branch}`);
    }
    return line;
  });
  writeFileSync(path, out.join("\n"), "utf8");
}

// ---------------------------------------------------------------------------
// 1 — Watch: the loud refusal
// ---------------------------------------------------------------------------

function story(id: string, epicId: string, status: string, repo = "api"): string {
  const evidence = status === "done" ? `evidence: ["npm run test exited 0"]` : "evidence: []";
  return [
    "---", "version: 1", `id: ${id}`, `epic: ${epicId}`, `title: "${id} on ${epicId}"`,
    `repo: ${repo}`, `status: ${status}`, "depends_on: []", 'touches: ["src/"]',
    'acceptance: ["it works"]', 'test_plan: ["a unit test"]', evidence, "---", "",
    `# ${id}`, "", "## Definition of done", "", "```dod", "true", "```", "",
  ].join("\n");
}

function epicFile(id: string, branch: string, stories: readonly string[]): string {
  return [
    "---", "version: 1", `id: ${id}`, `title: "${id} — a shipped thing"`, "repos: [api]",
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

interface WatchFixture {
  readonly ws: FacilitatorWorkspace;
  readonly ctx: ExecutorContext;
}

function watchFixture(): WatchFixture {
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
  openWatch.push(ws);
  const plan: Record<string, string> = {
    "03-plan/stories/S1.md": story("S1", "E1", "done"),
    "03-plan/epics/E1.md": epicFile("E1", DECLARED_API, ["S1"]),
  };
  for (const [rel, content] of Object.entries(plan)) {
    const path = join(ws.runDir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({
    ...run,
    build: { epic_branch: [RECORDED_BRANCH], branch_model: "integration" },
  }));
  store.save();
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

describe("a RECORDED default_branch that does not resolve is incoherent state (#92)", () => {
  test("the stage refuses, names the repo, the recorded value and workspace.yml, and spawns nothing", async () => {
    const { ws, ctx } = watchFixture();
    // The repo is real and the epic branch IS on it. The only thing wrong is the
    // value `.tldrx/workspace.yml` records as this repo's default branch.
    initRepo(ws.root, "api", [RECORDED_BRANCH]);
    recordDefaultBranch(ws.root, "api", "trunk");
    // A card WOULD be written if anything spawned — so the refusal is provable.
    process.env.PATH = ws.binDir;
    process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
      [watcherRelPath("leaderboard-v2-api")]: card("leaderboard-v2-api", "E1", ["S1"]),
    });
    process.env.FAKE_CLAUDE_COST = "0.11";

    const outcome = await watchExecutor(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toBe(true);
    expect(outcome.tasks).toEqual([]);
    expect(outcome.costUsd).toBe(0);
    const said = outcome.lines.join("\n");
    expect(said).toContain("trunk");
    expect(said).toContain("api");
    expect(said).toContain("default_branch");
    expect(said).toContain(".tldrx/workspace.yml");
    // Never the soft instruction: that is what produced the useless card (#90).
    expect(said).not.toContain("UNSEEN");
    expect(existsSync(join(ws.runDir, watcherRelPath("leaderboard-v2-api")))).toBe(false);
    expect(existsSync(join(ws.runDir, WATCH_PHASE, "handoff.md"))).toBe(false);
  });

  test("`--prepare` refuses too — the bundle is never written", async () => {
    const { ws, ctx } = watchFixture();
    initRepo(ws.root, "api", [RECORDED_BRANCH]);
    recordDefaultBranch(ws.root, "api", "trunk");
    process.env.PATH = "";

    const outcome = await watchExecutor({ ...ctx, mode: "prepare" });

    expect(outcome.refused).toBe(true);
    expect(outcome.awaiting).toBe(false);
    expect(existsSync(join(ws.runDir, ".agent", "watch", "leaderboard-v2-api", "prompt.md"))).toBe(false);
  });

  test("`--commit` does NOT refuse — that turn is already paid for", async () => {
    const { ws, ctx } = watchFixture();
    initRepo(ws.root, "api", [RECORDED_BRANCH]);
    process.env.PATH = "";
    await watchExecutor({ ...ctx, mode: "prepare" });

    // The workspace's record goes wrong between the two halves of the handshake —
    // a re-detect, a rename. The card is written; nothing is left to refuse.
    recordDefaultBranch(ws.root, "api", "trunk");
    const path = join(ws.runDir, watcherRelPath("leaderboard-v2-api"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, card("leaderboard-v2-api", "E1", ["S1"]), "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "watch", "leaderboard-v2-api", "result.json"),
      JSON.stringify({
        outputs: [watcherRelPath("leaderboard-v2-api")],
        questions_asked: [],
        notes: "",
        cost_usd: 0.07,
      }),
      "utf8",
    );

    const outcome = await watchExecutor({ ...ctx, mode: "commit" });

    expect(outcome.ok).toBe(true);
    expect(outcome.refused).toBeUndefined();
    expect(existsSync(join(ws.runDir, WATCH_PHASE, "handoff.md"))).toBe(true);
  });

  test("a resolvable default_branch is untouched — the ordinary run still prepares", async () => {
    const { ws, ctx } = watchFixture();
    initRepo(ws.root, "api", [RECORDED_BRANCH]);
    process.env.PATH = "";

    const outcome = await watchExecutor({ ...ctx, mode: "prepare" });

    expect(outcome.refused).toBeUndefined();
    expect(outcome.awaiting).toBe(true);
    const text = readFileSync(join(ws.runDir, ".agent", "watch", "leaderboard-v2-api", "prompt.md"), "utf8");
    expect(text).toContain("src.txt");
    expect(text).not.toContain("Not diffed:");
  });
});

describe("renderDiffs tells a missing BASE from a missing BRANCH (#92)", () => {
  const shell = {
    repo: "api",
    dir: "/tmp/api",
    base: "trunk",
    branch: "epic/x",
    resolved: false,
    stat: "",
    nameStatus: "",
    patch: "",
    truncated: false,
  } as const;

  test("a base the workspace records and the repo cannot find is INCOHERENT, never UNSEEN", () => {
    const text = renderDiffs([{
      ...shell,
      reason: "`trunk`, the `default_branch` of api recorded in .tldrx/workspace.yml, does not resolve there",
      branchMissing: false,
      baseMissing: true,
    }]);
    expect(text).toContain("INCOHERENT");
    expect(text).toContain("trunk");
    expect(text).toContain(".tldrx/workspace.yml");
    expect(text).not.toContain("UNSEEN");
  });

  test("an honest absence still gets the treat-as-UNSEEN instruction", () => {
    const text = renderDiffs([{
      ...shell,
      branch: "",
      reason: "`build.epic_branch` in run.yml is empty",
      branchMissing: false,
      baseMissing: false,
    }]);
    expect(text).toContain("UNSEEN");
    expect(text).not.toContain("INCOHERENT");
  });
});

// ---------------------------------------------------------------------------
// 2 — doctor: the workspace records something false
// ---------------------------------------------------------------------------

function tempWorkspace(repos: readonly { name: string; path: string; branch: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-doctor-92-"));
  openTemp.push(root);
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  const lines = [
    "version: 1",
    "mode: multi-repo",
    "root_is_repo: false",
    "detected_at: 2026-09-02T10:00:00Z",
    'detected_by: "tldrx test"',
    "repos:",
  ];
  for (const repo of repos) {
    lines.push(
      `  - name: ${repo.name}`,
      `    path: ${repo.path}`,
      `    default_branch: ${repo.branch}`,
      "    stack: [typescript]",
      "    package_manager: npm",
      "    commands: {build: null, test: null, lint: null, typecheck: null, run: null}",
      "    ci: []",
      "    confidence: high",
    );
  }
  writeFileSync(join(root, ".tldrx", "workspace.yml"), `${lines.join("\n")}\n`, "utf8");
  return root;
}

describe("`tldrx doctor` reports a recorded default_branch its repo cannot find (#92)", () => {
  test("the unresolvable one is named with its repo and its recorded value", async () => {
    const root = tempWorkspace([
      { name: "api", path: "api", branch: "trunk" },
      { name: "lab", path: "lab", branch: "main" },
    ]);
    initRepo(root, "api", []);
    initRepo(root, "lab", []);

    const audit = await findUnresolvedDefaultBranches(root);

    expect(audit.ran).toBe(true);
    expect(audit.probed).toEqual(["api", "lab"]);
    expect(audit.unresolved.map((row) => row.repo)).toEqual(["api"]);
    expect(audit.unresolved[0]?.branch).toBe("trunk");
  });

  test("every recorded branch resolving is reported as such, not as silence", async () => {
    const root = tempWorkspace([{ name: "api", path: "api", branch: "main" }]);
    initRepo(root, "api", []);

    const audit = await findUnresolvedDefaultBranches(root);

    expect(audit.ran).toBe(true);
    expect(audit.unresolved).toEqual([]);
    expect(new DoctorReport([], null, null, null, audit).render())
      .toContain("1 probed, all resolve");
  });

  test("a repo that is not on disk is SKIPPED with a reason, never counted as resolved", async () => {
    const root = tempWorkspace([{ name: "api", path: "api", branch: "main" }]);
    // No initRepo: the repo was never cloned. That is not a false record.

    const audit = await findUnresolvedDefaultBranches(root);

    expect(audit.unresolved).toEqual([]);
    expect(audit.skipped.map((row) => row.repo)).toEqual(["api"]);
    const rendered = new DoctorReport([], null, null, null, audit).render();
    expect(rendered).toContain("skipped");
    expect(rendered).toContain("api");
  });

  test("no workspace here is not the claim that nothing is wrong", () => {
    expect(new DoctorReport([], null, null, null, null).render())
      .toContain("no workspace here");
  });

  test("it is a WARNING — `healthy` and the exit code never move", async () => {
    const root = tempWorkspace([{ name: "api", path: "api", branch: "trunk" }]);
    initRepo(root, "api", []);
    const audit = await findUnresolvedDefaultBranches(root);
    expect(audit.unresolved.length).toBe(1);

    // The report, with no failing tool, is healthy in spite of the finding.
    expect(new DoctorReport([], null, null, null, audit).healthy).toBe(true);

    // And end to end: `runDoctor` on that workspace still exits on the TOOLS.
    const outcome = await runDoctor({ mcp: false, root });
    expect(outcome.exitCode).toBe(outcome.healthy ? 0 : 1);
    expect(outcome.defaultBranches?.unresolved.map((row) => row.repo)).toEqual(["api"]);
    expect(outcome.output).toContain("trunk");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3 — boundary: the determination, measured
// ---------------------------------------------------------------------------

const BOUNDARY_RUN: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "Inside the surface", touches: ["src/in.ts"] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
  gates: "none",
  repoFiles: { "src/in.ts": "export const before = 1;\n" },
};

function boundaryWorkspace(): BuildWorkspace {
  const ws = makeBuildWorkspace(BOUNDARY_RUN);
  openBuild.push(ws);
  const what = join(ws.runDir, "01-what");
  mkdirSync(what, { recursive: true });
  writeFileSync(join(what, "handoff.md"), "## Decisions\n- a [src: app:src/in.ts:1]\n", "utf8");
  return ws;
}

describe("boundary DOES diff against the recorded default_branch (#92, measured)", () => {
  test("the base it diffs from is read straight out of workspace.yml", () => {
    const ws = boundaryWorkspace();
    expect(epicTargets(ws.runDir, loadWorkspace(ws.root))[0]?.base).toBe("main");

    recordDefaultBranch(ws.root, "app", "trunk");

    expect(epicTargets(ws.runDir, loadWorkspace(ws.root))[0]?.base).toBe("trunk");
  });

  test("an unresolvable base is STILL n/a and STILL ok — the gate never refuses on an absence", async () => {
    const ws = boundaryWorkspace();
    recordDefaultBranch(ws.root, "app", "trunk");

    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });

    // Deliberately unchanged. boundary.ts's own contract: "it must not refuse a
    // gate for a reason that has nothing to do with the boundary". A workspace
    // whose `default_branch` is wrong would otherwise brick every Build gate.
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("n/a (nothing could be diffed");
  });

  test("but the reason names it as the RECORDED default_branch, and points at doctor", async () => {
    const ws = boundaryWorkspace();
    recordDefaultBranch(ws.root, "app", "trunk");

    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });

    expect(verdict.detail).toContain("default_branch");
    expect(verdict.detail).toContain(".tldrx/workspace.yml");
    expect(verdict.detail).toContain("tldrx doctor");
  });

  test("a missing EPIC branch keeps its own wording — the two absences stay told apart", async () => {
    const ws = boundaryWorkspace();
    // `default_branch: main` resolves; `epic/e1` was never cut.
    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });

    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("`epic/e1` does not resolve in app");
    expect(verdict.detail).not.toContain("default_branch");
  });
});
