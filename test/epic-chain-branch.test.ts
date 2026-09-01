/**
 * Dependent epics share ONE integration branch (issue #57, owner decision (a),
 * 2026-09-01).
 *
 * ## What broke
 *
 * Run `260829-scoring-leaderboard` planned E2 (API) → E3/E4 (mobile), and
 * one-branch-per-epic cannot express that: a downstream story's base is cut from
 * its OWN epic branch, which was cut from `main`, so it never sees the upstream
 * epic's merged work. It broke twice. Both times the host fast-forwarded the epic
 * branches by hand — cross-EPIC surgery the auto-fast-forward (built for stale
 * STORY bases, design §F.2) was never designed to express — and that collapses
 * branches the owner may have meant to merge separately.
 *
 * ## What the owner decided
 *
 * When a run's epics form a dependency chain, the run cuts a SINGLE integration
 * branch and the epics become labels. When they do not, it is one branch per
 * epic, exactly as before. Either way the PLAN check says which, up front — the
 * host must never discover the branch model mid-Build.
 *
 * ## What is asserted here
 *
 * The acceptance test is `a downstream story SEES the upstream epic's work`: it
 * reproduces the leaderboard shape (S1 in E1, S2 in E2 depending on S1, two
 * waves) and asserts S2's worktree holds the file S1 wrote — with NO
 * `story.base_fastforwarded` event, because no surgery is involved. Every git
 * assertion is against a real repository; a stubbed git would let "the base was
 * right" and "the base was wrong" pass in the same direction.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchModelFor, detectEpicChain, epicBranchOf, integrationBranchFor,
  INTEGRATION_EPIC_SLOT, isChained,
} from "../src/core/plan/branchModel.ts";
import { EPIC_BRANCH_RE } from "../src/core/schemas/planCommon.ts";
import { validatePlan } from "../src/core/plan/validatePlan.ts";
import { runCheck } from "../src/core/run/checks.ts";
import type { PlannedCheck, PlannedStage } from "../src/core/run/workflowPreset.ts";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { reject } from "../src/core/run/gates.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

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

// ---------------------------------------------------------------------------
// Part 1 — detection, on plain data
// ---------------------------------------------------------------------------

/** story id -> epic id. */
function epics(pairs: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  return new Map(Object.entries(pairs));
}

/** story id -> `depends_on`. */
function deps(pairs: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, readonly string[]> {
  return new Map(Object.entries(pairs));
}

describe("detectEpicChain — the plan already knows this", () => {
  test("a story depending on another epic's story IS the chain", () => {
    const chain = detectEpicChain(
      epics({ S1: "E1", S2: "E2" }),
      deps({ S1: [], S2: ["S1"] }),
    );

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ from: "E2", to: "E1", story: "S2", dependsOn: "S1" });
    expect(isChained(chain)).toBe(true);
  });

  test("dependencies INSIDE one epic are not a chain", () => {
    const chain = detectEpicChain(
      epics({ S1: "E1", S2: "E1", S3: "E2" }),
      deps({ S1: [], S2: ["S1"], S3: [] }),
    );

    expect(chain).toEqual([]);
    expect(isChained(chain)).toBe(false);
  });

  test("the leaderboard shape — E3 and E4 both consume E2 — is one chain, edges deduped", () => {
    const chain = detectEpicChain(
      epics({ S1: "E2", S2: "E3", S3: "E3", S4: "E4" }),
      deps({ S1: [], S2: ["S1"], S3: ["S1"], S4: ["S1"] }),
    );

    // One edge per epic PAIR: three stories crossing E3→E2 is still one relation.
    expect(chain.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["E3->E2", "E4->E2"]);
    expect(isChained(chain)).toBe(true);
  });

  test("a transitive chain E3→E2→E1 is detected whole", () => {
    const chain = detectEpicChain(
      epics({ S1: "E1", S2: "E2", S3: "E3" }),
      deps({ S1: [], S2: ["S1"], S3: ["S2"] }),
    );

    expect(chain.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["E2->E1", "E3->E2"]);
  });

  test("a dependency on a story with no epic on file is not invented into an edge", () => {
    const chain = detectEpicChain(epics({ S2: "E2" }), deps({ S2: ["S1"] }));
    expect(chain).toEqual([]);
  });
});

describe("branchModelFor — what the run cuts", () => {
  test("a chain becomes one integration branch, named for the run", () => {
    const model = branchModelFor("260829-scoring-leaderboard", detectEpicChain(
      epics({ S1: "E2", S2: "E3" }),
      deps({ S1: [], S2: ["S1"] }),
    ));

    expect(model.kind).toBe("integration");
    expect(model.integrationBranch).toBe("epic/260829-scoring-leaderboard");
    // It is still an `epic/<slug>`, so every reader keyed on that prefix works.
    expect(EPIC_BRANCH_RE.test(model.integrationBranch ?? "")).toBe(true);
  });

  test("no chain leaves each epic on its own declared branch", () => {
    const model = branchModelFor("260829-x", []);

    expect(model.kind).toBe("per-epic");
    expect(model.integrationBranch).toBeNull();
    expect(epicBranchOf(model, "epic/e1")).toBe("epic/e1");
    expect(epicBranchOf(model, "epic/e2")).toBe("epic/e2");
  });

  test("under the integration model every epic resolves to the SAME branch", () => {
    const model = branchModelFor("260829-x", detectEpicChain(
      epics({ S1: "E1", S2: "E2" }),
      deps({ S2: ["S1"] }),
    ));

    expect(epicBranchOf(model, "epic/e1")).toBe("epic/260829-x");
    expect(epicBranchOf(model, "epic/e2")).toBe("epic/260829-x");
  });

  test("integrationBranchFor forces a run id into the `epic/<slug>` shape", () => {
    expect(integrationBranchFor("260829-scoring-leaderboard")).toBe("epic/260829-scoring-leaderboard");
    expect(EPIC_BRANCH_RE.test(integrationBranchFor("260829-A_Weird.Slug"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the PLAN check states the branch model up front
// ---------------------------------------------------------------------------

const CHECK: PlannedCheck = { id: "plan", on: "post-write", repo: null, command: null, expect_exit: 0 };

function planWorkspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  return made;
}

/** A Plan stage, minimal: `checkPlan` reads only `phase` and `outputs`. */
function planStage(): PlannedStage {
  return {
    id: "plan", title: "Plan", phase: "03-plan",
    model: null, effort: null, experts: [], budget_usd: 1, timeout_s: 60,
    inputs: [], outputs: ["03-plan/waves.yml"], sections: new Map(),
    gateType: "approve", checks: [CHECK], preconditions: [],
    questionsPath: null, source: "test",
  };
}

/** Two epics, chained: S2 (E2) needs S1 (E1). */
const CHAINED: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "The API half" },
    { id: "S2", epic: "E2", title: "The mobile half", dependsOn: ["S1"], touches: ["s1.txt", "s2.txt"] },
  ],
  epics: [
    { id: "E1", stories: ["S1"], branch: "epic/e1" },
    { id: "E2", stories: ["S2"], branch: "epic/e2" },
  ],
  waves: [["S1"], ["S2"]],
};

/** Two epics, independent — the model that must not change at all. */
const INDEPENDENT: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "One thing" },
    { id: "S2", epic: "E2", title: "Another thing" },
  ],
  epics: [
    { id: "E1", stories: ["S1"], branch: "epic/e1" },
    { id: "E2", stories: ["S2"], branch: "epic/e2" },
  ],
  waves: [["S1", "S2"]],
};

describe("validatePlan carries the chain it read", () => {
  test("a chained plan reports its cross-epic edges", () => {
    const ws = planWorkspace(CHAINED);
    const report = validatePlan(ws.planDir, new Set(["npm run test"]));

    expect(report.ok).toBe(true);
    expect(report.epicChain.map((e) => `${e.from}->${e.to}`)).toEqual(["E2->E1"]);
  });

  test("an independent plan reports none", () => {
    const ws = planWorkspace(INDEPENDENT);
    const report = validatePlan(ws.planDir, new Set(["npm run test"]));

    expect(report.ok).toBe(true);
    expect(report.epicChain).toEqual([]);
  });
});

describe("the `plan` gate check says which branch model this run will use", () => {
  test("chained epics: the single integration branch is named in the detail", async () => {
    const ws = planWorkspace(CHAINED);
    const outcome = await runCheck(CHECK, { root: ws.root, runDir: ws.runDir, stage: planStage() });

    expect(outcome.status).toBe("passed");
    expect(outcome.detail).toContain("epics form a chain");
    expect(outcome.detail).toContain("E2→E1");
    expect(outcome.detail).toContain(`single integration branch \`epic/${ws.runId}\``);
  });

  test("independent epics: the detail says one branch each", async () => {
    const ws = planWorkspace(INDEPENDENT);
    const outcome = await runCheck(CHECK, { root: ws.root, runDir: ws.runDir, stage: planStage() });

    expect(outcome.status).toBe("passed");
    expect(outcome.detail).toContain("independent epics");
    expect(outcome.detail).toContain("one branch each");
    expect(outcome.detail).not.toContain("integration branch");
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the Build executor, on a real repo
// ---------------------------------------------------------------------------

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
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
    at: "2026-09-01T09:00:00Z",
    ...overrides,
  });
}

function git(ws: BuildWorkspace, ...args: string[]): string {
  return execFileSync("git", args, { cwd: ws.repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git merge-base --is-ancestor`, as a boolean rather than a thrown exit code. */
function isAncestor(ws: BuildWorkspace, older: string, newer: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], {
      cwd: ws.repoDir, stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function branches(ws: BuildWorkspace): readonly string[] {
  return git(ws, "branch", "--list", "--format=%(refname:short)").split("\n");
}

function events(ws: BuildWorkspace): readonly { type: string }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

describe("a chained run cuts ONE branch", () => {
  test("run.yml records the integration branch and the model that chose it", async () => {
    const ws = workspace(CHAINED);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    await next(ws);

    const run = RunStore.open(ws.runDir).run;
    expect(run.build?.epic_branch).toEqual([`epic/${ws.runId}`]);
    expect(run.build?.branch_model).toBe("integration");
    // The per-epic branches were never cut: they are labels now.
    expect(branches(ws)).not.toContain("epic/e1");
    expect(branches(ws)).not.toContain("epic/e2");
  });

  test("the operator is told, in the stage's own lines", async () => {
    const ws = workspace(CHAINED);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    const outcome = await next(ws);

    expect(outcome.lines.join("\n")).toContain(`epics form a chain`);
    expect(outcome.lines.join("\n")).toContain(`epic/${ws.runId}`);
  });

  /**
   * THE ACCEPTANCE TEST — the leaderboard failure shape, passing.
   *
   * S1 writes `s1.txt` and merges. S2 belongs to a DIFFERENT epic and depends on
   * S1. Under one-branch-per-epic its base was `epic/e2`, cut from `main`, with
   * no `s1.txt` anywhere — which is what needed the host's cross-epic
   * fast-forward, twice. Under the integration branch its base already carries
   * S1's merge, and no ref is moved to make that true.
   */
  test("a downstream story SEES the upstream epic's merged work, with no fast-forward", async () => {
    const ws = workspace(CHAINED);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "s1.txt": "the API contract S2 compiles against\n" },
      S2: { "s2.txt": "the mobile half\n" },
    });

    await next(ws, { keepWorktrees: true });

    const s2Worktree = join(ws.root, ".tldrx", "worktrees", ws.repoName, `${ws.runId}-S2`);
    expect(existsSync(join(s2Worktree, "s1.txt"))).toBe(true);
    expect(readFileSync(join(s2Worktree, "s1.txt"), "utf8")).toBe("the API contract S2 compiles against\n");

    // S1's commit is an ANCESTOR of S2's branch — the base was right when the
    // developer was dispatched, not repaired afterwards.
    expect(isAncestor(ws, `story/${ws.runId}/S1`, `story/${ws.runId}/S2`)).toBe(true);
    expect(events(ws).filter((e) => e.type === "story.base_fastforwarded")).toHaveLength(0);

    // And both stories landed on the one branch.
    const log = git(ws, "log", "--oneline", `epic/${ws.runId}`);
    expect(log).toContain("S1");
    expect(log).toContain("S2");
  });
});

describe("an unchained run is exactly what it was", () => {
  test("one branch per epic, and the model says so", async () => {
    const ws = workspace(INDEPENDENT);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    await next(ws);

    const run = RunStore.open(ws.runDir).run;
    expect(run.build?.epic_branch).toEqual(["epic/e1", "epic/e2"]);
    expect(run.build?.branch_model).toBe("per-epic");
    expect(branches(ws)).toContain("epic/e1");
    expect(branches(ws)).toContain("epic/e2");
    expect(branches(ws)).not.toContain(`epic/${ws.runId}`);
  });

  test("nothing is said about an integration branch", async () => {
    const ws = workspace(INDEPENDENT);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    const outcome = await next(ws);

    expect(outcome.lines.join("\n")).not.toContain("integration branch");
  });
});

describe("backward safety — a run that already cut epic branches keeps them", () => {
  /**
   * The three closed runs and any in-flight one. Their `run.yml` carries
   * `build.epic_branch` and NO `branch_model`, because the key did not exist when
   * they ran. Re-entering such a run must not re-point its stories at a branch
   * that was never cut.
   */
  test("a chained plan whose run.yml predates the model stays per-epic", async () => {
    const ws = workspace(CHAINED);
    // Exactly the shape an older Build left behind: branches claimed, no model.
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({ ...run, build: { epic_branch: ["epic/e1"] } }));
    store.save();
    execFileSync("git", ["branch", "epic/e1", "main"], { cwd: ws.repoDir });
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    await next(ws);

    const run = RunStore.open(ws.runDir).run;
    expect(run.build?.epic_branch).toEqual(["epic/e1", "epic/e2"]);
    expect(run.build?.branch_model).toBe("per-epic");
    expect(branches(ws)).not.toContain(`epic/${ws.runId}`);
  });

  test("a run that already recorded `integration` is not refused its own branch", async () => {
    const ws = workspace(CHAINED);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    await next(ws);
    const first = RunStore.open(ws.runDir).run.build;
    expect(first?.branch_model).toBe("integration");
    // Send the stage back to `ready` so `next` runs the executor again — the
    // branch now EXISTS, and the foreign-epic guard must recognise it as ours.
    reject(RunStore.open(ws.runDir), {
      root: ws.root, actor: "alan", at: "2026-09-01T10:00:00Z", note: "another go",
    });

    const again = await next(ws);

    expect(again.lines.join("\n")).not.toContain("did not cut it");
    expect(RunStore.open(ws.runDir).run.build?.epic_branch).toEqual(first?.epic_branch ?? []);
    expect(RunStore.open(ws.runDir).run.build?.branch_model).toBe("integration");
  });
});

describe("the epic worktree is run-scoped and singular under the integration model", () => {
  test("one `_epic-<run>-integration`, not one per epic", async () => {
    const ws = workspace(CHAINED);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });

    await next(ws);

    const dir = join(ws.root, ".tldrx", "worktrees", ws.repoName);
    expect(existsSync(join(dir, `_epic-${ws.runId}-${INTEGRATION_EPIC_SLOT}`))).toBe(true);
    expect(existsSync(join(dir, `_epic-${ws.runId}-E1`))).toBe(false);
    expect(existsSync(join(dir, `_epic-${ws.runId}-E2`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — ship
// ---------------------------------------------------------------------------

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

function shipTransport(branch: string): ShipTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
      const table: Record<string, { exitCode?: number; stdout?: string }> = {
        "gh --version": { stdout: "gh version 2.62.0\n" },
        "git remote": { stdout: "origin\n" },
        "git ls-remote --heads": { stdout: `a1b2c3\trefs/heads/${branch}\n` },
      };
      const answer = table[key] ?? { stdout: "" };
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: "" };
    },
  };
}

describe("ship on a chained run names ONE branch", () => {
  test("no --branch is needed, and the PR head is the integration branch", async () => {
    const ws = workspace(CHAINED);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S1: ["approve"], S2: ["approve"] });
    await next(ws);
    mkdirSync(join(ws.runDir, "04-build"), { recursive: true });
    writeFileSync(
      join(ws.runDir, "04-build", "handoff.md"),
      "# Handoff\n\n## Findings\n\n- it built [src: app:README.md:1]\n",
      "utf8",
    );

    const branch = `epic/${ws.runId}`;
    const transport = shipTransport(branch);
    const outcome = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-01T10:00:00Z",
      dryRun: true, transport,
    });

    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain(`from \`${branch}\``);
    // Not "the run cut 2 branches, name one with --branch".
    expect(outcome.lines.join("\n")).not.toContain("--branch");
  });
});
