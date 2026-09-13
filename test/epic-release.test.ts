/**
 * A cancelled run's epic branch is released, and a Build entering over a stale
 * one moves it aside instead of refusing it as someone else's (gh #272).
 *
 * Measured on a headless proof run at a509dca: run A had cut `epic/main-ci-green`,
 * was cancelled, and the ordinary retry — run A-2, same feature — reached Build and
 * was refused: "`epic/main-ci-green` already exists … and run A-2 did not cut it —
 * refusing to stack this run's commits onto someone else's epic". The stale epic
 * had ZERO commits beyond main; the only work sat on A's story branch (#129).
 * $3.70 of what/how/plan died at Build on a leftover nothing cleaned up.
 *
 * Two halves, both against a REAL git repo:
 *   1. `run cancel` releases the epic it claimed — deleted when it carries nothing
 *      beyond its base, renamed to `epic/<slug>@<run-id>` when it does — recorded
 *      on the run (`build.epic_released`) and on the ledger (`epic.released`).
 *   2. Build, at the refusal, reads who OWNS the epic from the claims under
 *      `tldrx-work/`: an owner that is explicitly finished (`cancelled` / `done` on
 *      its run.yml — never "no process") is a leftover and is moved aside by the
 *      same rule; an open owner, or NO claim anywhere (#262's killed-mid-cut run
 *      must be able to recover its own epic), keeps today's refusal verbatim.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { cancelRun } from "../src/core/run/rescue.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { EVENT_TYPES, validateEvent } from "../src/core/events/Event.ts";
import { asideBranchOf, describeRelease, releaseEpicBranch, releaseRunEpics, uncountedReason } from "../src/core/build/epicRelease.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import {
  addBuildRun, makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here spawns a REAL process — git, `bun`, the fake agent. Process cost is a
// property of the machine, so the budget scales with measured load (#43).
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const AT = "2026-09-13T09:00:00Z";
const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "Only story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};
/** The two refusal lines the issue measured, verbatim (`branchClaims.ts`). */
const VERBATIM_FIRST = (runId: string) =>
  `[tldrx] build: \`epic/e1\` already exists in app and run ${runId} did not cut it — `
  + "refusing to stack this run's commits onto someone else's epic.";
/** The fixture's first run id — literal, so the aside names below are literal too. */
const OWNER = "260829-build";
const ASIDE = `epic/e1@${OWNER}`;
const VERBATIM_SECOND =
  "  either delete or rename that branch, or run `tldrx next --reuse-epic` to work on it deliberately.";

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_BUILD_STATE;
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(options: BuildWorkspaceOptions = ONE_STORY): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function git(repoDir: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function branches(repoDir: string): readonly string[] {
  return git(repoDir, ["branch", "--list", "--format=%(refname:short)"]).split("\n").filter((b) => b !== "");
}

/** `epic/e1` cut from main, with `commits` empty commits on top — no checkout needed. */
function cutEpic(repoDir: string, commits: number): string {
  let sha = git(repoDir, ["rev-parse", "main"]);
  for (let i = 0; i < commits; i++) {
    sha = git(repoDir, ["commit-tree", `${sha}^{tree}`, "-p", sha, "-m", `epic commit ${String(i + 1)}`]);
  }
  git(repoDir, ["branch", "epic/e1", sha]);
  return sha;
}

/** What a Build that cut the branch writes: the claim on run.yml (#248). */
function claim(runDir: string, branch: string): void {
  const store = RunStore.open(runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: [branch], branch_model: "per-epic" } }));
  store.save();
}

function cancel(ws: BuildWorkspace, runId: string, note = "abandoned after the incident"): void {
  const outcome = cancelRun({ root: ws.root, runId, force: false, actor: "alan", at: AT, note });
  expect(outcome.code).toBe(0);
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}) {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: AT, ...overrides,
  });
}

function releaseEvents(runDir: string) {
  return EventLog.forRun(runDir).read().filter((e) => e.type === "epic.released");
}

describe("the aside name has ONE derivation and git accepts it", () => {
  test("epic/<slug>@<run-id>", () => {
    expect(asideBranchOf("epic/main-ci-green", "260913-main-ci-green")).toBe("epic/main-ci-green@260913-main-ci-green");
    execFileSync("git", ["check-ref-format", "--branch", asideBranchOf("epic/x", "260913-x")], { stdio: "ignore" });
  });

  test("`epic.released` is in the closed event set", () => {
    expect(EVENT_TYPES).toContain("epic.released");
    expect(validateEvent({
      ts: AT, run: "260913-x", stage: null, type: "epic.released", actor: "alan", cost_usd: 0, payload: {},
    }).ok).toBe(true);
  });
});

describe("run cancel releases the epic it claimed (#272, half 1)", () => {
  test("an epic with NO commit beyond its base is deleted; the story branch is untouched", async () => {
    const ws = workspace();
    claim(ws.runDir, "epic/e1");
    cutEpic(ws.repoDir, 0);
    git(ws.repoDir, ["branch", `story/${ws.runId}/S1`, "main"]);
    cancel(ws, ws.runId);

    const outcome = await releaseRunEpics({
      root: ws.root, owner: RunStore.open(ws.runDir), actor: "alan", at: AT,
      via: "run cancel", reason: "cancelled: abandoned after the incident",
    });
    expect(outcome.released.map((r) => r.outcome)).toEqual(["deleted"]);
    expect(branches(ws.repoDir)).not.toContain("epic/e1");
    expect(branches(ws.repoDir)).not.toContain(asideBranchOf("epic/e1", ws.runId));
    // #129: the story branch is where the cancelled run's work lives. Never touched.
    expect(branches(ws.repoDir)).toContain(`story/${ws.runId}/S1`);

    // Recorded where a person reads it: the claim on run.yml, and the ledger.
    const run = RunStore.open(ws.runDir).run;
    expect(run.build?.epic_branch).toEqual(["epic/e1"]);
    expect(run.build?.epic_released).toMatchObject([
      { branch: "epic/e1", repo: "app", outcome: "deleted", commits: 0, base: "main", via: "run cancel" },
    ]);
    const events = releaseEvents(ws.runDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      branch: "epic/e1", repo: "app", outcome: "deleted", renamed_to: null, commits: 0, owner: ws.runId,
    });
    expect(outcome.lines).toEqual([describeRelease(outcome.released[0]!, git(ws.repoDir, ["rev-parse", "--short", "main"]))]);
  });

  test("an epic git could NOT count against its base is KEPT — an uncounted branch is never deleted", async () => {
    const ws = workspace();
    cutEpic(ws.repoDir, 0);
    // A base that does not resolve: `git rev-list --count <base>..epic/e1` fails, and the
    // dangerous reading of that failure is "0 commits beyond the base" — a delete.
    const outcome = await releaseEpicBranch({
      repoDir: ws.repoDir, branch: "epic/e1", base: "no-such-base", ownerRunId: ws.runId,
    });
    expect(outcome).toEqual({ kind: "kept", branch: "epic/e1", reason: uncountedReason("no-such-base", "epic/e1") });
    expect(branches(ws.repoDir)).toContain("epic/e1");
    expect(branches(ws.repoDir)).not.toContain(ASIDE);
  });

  test("an epic WITH commits is renamed to epic/<slug>@<run-id>, and the commits survive there", async () => {
    const ws = workspace();
    claim(ws.runDir, "epic/e1");
    const tip = cutEpic(ws.repoDir, 2);
    cancel(ws, ws.runId);

    const outcome = await releaseRunEpics({
      root: ws.root, owner: RunStore.open(ws.runDir), actor: "alan", at: AT,
      via: "run cancel", reason: "cancelled: abandoned after the incident",
    });
    expect(ws.runId).toBe(OWNER);
    const aside = ASIDE;
    expect(outcome.released.map((r) => r.outcome)).toEqual(["renamed"]);
    expect(branches(ws.repoDir)).not.toContain("epic/e1");
    expect(branches(ws.repoDir)).toContain(aside);
    expect(git(ws.repoDir, ["rev-parse", aside])).toBe(tip);

    const run = RunStore.open(ws.runDir).run;
    expect(run.build?.epic_released).toMatchObject([
      { branch: "epic/e1", outcome: "renamed", renamed_to: aside, commits: 2, base: "main" },
    ]);
    expect(releaseEvents(ws.runDir)[0]!.payload).toMatchObject({ outcome: "renamed", renamed_to: aside, commits: 2 });
    expect(outcome.lines.join("\n")).toContain(aside);
    // The record round-trips: a re-open of run.yml still validates and still says so.
    expect(RunStore.open(ws.runDir).run.build?.epic_released?.[0]?.renamed_to).toBe(aside);
  });

  test("an epic checked out in a worktree is LEFT ALONE, with the worktree named", async () => {
    const ws = workspace();
    claim(ws.runDir, "epic/e1");
    cutEpic(ws.repoDir, 1);
    const tree = join(ws.root, "kept-epic-checkout");
    git(ws.repoDir, ["worktree", "add", tree, "epic/e1"]);
    cancel(ws, ws.runId);

    const outcome = await releaseRunEpics({
      root: ws.root, owner: RunStore.open(ws.runDir), actor: "alan", at: AT,
      via: "run cancel", reason: "cancelled: abandoned after the incident",
    });
    expect(outcome.released).toHaveLength(0);
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.kept[0]!.reason).toContain(tree);
    expect(branches(ws.repoDir)).toContain("epic/e1");
    expect(RunStore.open(ws.runDir).run.build?.epic_released).toBeUndefined();
    expect(releaseEvents(ws.runDir)).toHaveLength(0);
    expect(existsSync(tree)).toBe(true);
  });

  test("through the real binary: `tldrx run cancel` says what it released", async () => {
    const ws = workspace();
    claim(ws.runDir, "epic/e1");
    cutEpic(ws.repoDir, 0);
    const proc = Bun.spawn(
      ["bun", join(FRAMEWORK_ROOT, "bin", "tldrx.ts"), "run", "cancel", ws.runId, "--note", "not this one", "--root", ws.root],
      { stdout: "pipe", stderr: "pipe", cwd: ws.root, env: noSpawnEnv() },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("released `epic/e1`");
    expect(RunStore.open(ws.runDir).run.status).toBe("cancelled");
    expect(branches(ws.repoDir)).not.toContain("epic/e1");
    expect(releaseEvents(ws.runDir)).toHaveLength(1);
  }, 60_000);
});

describe("Build moves a stale epic aside instead of refusing it (#272, half 2)", () => {
  test("owner cancelled → renamed aside, a fresh epic cut, both ledgers and both records say so", async () => {
    const ws = workspace();
    claim(ws.runDir, "epic/e1");
    const tip = cutEpic(ws.repoDir, 1);
    cancel(ws, ws.runId);
    const retry = addBuildRun(ws, { ...ONE_STORY, slug: "retry" });

    const outcome = await next(ws, { runId: retry.runId });
    const text = outcome.lines.join("\n");
    expect(text).not.toContain("did not cut it");
    // The story built green and parked on the Build gate: awaiting a human, as every green build does.
    expect(outcome.code).toBe(4);

    expect(ws.runId).toBe(OWNER);
    const aside = ASIDE;
    expect(git(ws.repoDir, ["rev-parse", aside])).toBe(tip);
    // The retry cut its OWN `epic/e1`, from main — not on top of the leftover.
    expect(branches(ws.repoDir)).toContain("epic/e1");
    // `--is-ancestor` exits 1 when it is not: the leftover commit is NOT under the new epic.
    expect(() => git(ws.repoDir, ["merge-base", "--is-ancestor", tip, "epic/e1"])).toThrow();
    expect(RunStore.open(retry.runDir).run.build?.epic_branch).toEqual(["epic/e1"]);

    // Where a person reads it: the OWNER's claim and ledger, the RETRY's ledger and handoff.
    expect(RunStore.open(ws.runDir).run.build?.epic_released).toMatchObject([
      { branch: "epic/e1", outcome: "renamed", renamed_to: aside, commits: 1, via: "build" },
    ]);
    expect(releaseEvents(ws.runDir)).toHaveLength(1);
    const own = releaseEvents(retry.runDir);
    expect(own).toHaveLength(1);
    expect(own[0]!.payload).toMatchObject({ branch: "epic/e1", outcome: "renamed", renamed_to: aside, owner: ws.runId });
    expect(readFileSync(join(retry.runDir, "04-build", "handoff.md"), "utf8")).toContain(aside);
    expect(text).toContain(aside);
  }, 120_000);

  test("owner OPEN (parked, no process) → today's refusal verbatim, exit 2, branch untouched", async () => {
    const ws = workspace();
    claim(ws.runDir, "epic/e1");
    const tip = cutEpic(ws.repoDir, 1);
    // The owner has no process and no lock — and it is still the owner.
    expect(RunStore.open(ws.runDir).run.status).not.toBe("cancelled");
    const retry = addBuildRun(ws, { ...ONE_STORY, slug: "retry" });

    const outcome = await next(ws, { runId: retry.runId });
    expect(outcome.code).toBe(2);
    expect(outcome.lines).toContain(VERBATIM_FIRST(retry.runId));
    expect(outcome.lines).toContain(VERBATIM_SECOND);
    expect(git(ws.repoDir, ["rev-parse", "epic/e1"])).toBe(tip);
    expect(branches(ws.repoDir)).not.toContain(asideBranchOf("epic/e1", ws.runId));
    expect(releaseEvents(retry.runDir)).toHaveLength(0);
    expect(RunStore.open(ws.runDir).run.build?.epic_released).toBeUndefined();
  });

  test("NO claim anywhere → today's refusal verbatim, exit 2 (#262: a killed run must recover its own epic)", async () => {
    const ws = workspace();
    // A finished sibling that does NOT claim the branch, so "some run is finished"
    // cannot be mistaken for "this branch is a finished run's leftover".
    cancel(ws, ws.runId);
    const tip = cutEpic(ws.repoDir, 1);
    const retry = addBuildRun(ws, { ...ONE_STORY, slug: "retry" });

    const outcome = await next(ws, { runId: retry.runId });
    expect(outcome.code).toBe(2);
    expect(outcome.lines).toContain(VERBATIM_FIRST(retry.runId));
    expect(outcome.lines).toContain(VERBATIM_SECOND);
    expect(git(ws.repoDir, ["rev-parse", "epic/e1"])).toBe(tip);
    expect(branches(ws.repoDir)).not.toContain(asideBranchOf("epic/e1", ws.runId));
    expect(releaseEvents(retry.runDir)).toHaveLength(0);
  });

  test("owner run.yml UNREADABLE → today's refusal verbatim, exit 2, branch untouched — unknown is not finished", async () => {
    const ws = workspace();
    claim(ws.runDir, "epic/e1");
    const tip = cutEpic(ws.repoDir, 1);
    const retry = addBuildRun(ws, { ...ONE_STORY, slug: "retry" });
    // The claim is on disk and the file will not parse: who owns the branch is UNKNOWN,
    // and unknown reads as "still the owner", never as a leftover.
    writeFileSync(join(ws.runDir, "run.yml"), "version: 1\nrun: [\n", "utf8");
    expect(() => RunStore.open(ws.runDir)).toThrow();

    const outcome = await next(ws, { runId: retry.runId });
    expect(outcome.code).toBe(2);
    expect(outcome.lines).toContain(VERBATIM_FIRST(retry.runId));
    expect(outcome.lines).toContain(VERBATIM_SECOND);
    expect(outcome.lines).toContain(`  · tldrx-work/${ws.runId}/run.yml could not be read, so who owns it is unknown`);
    expect(git(ws.repoDir, ["rev-parse", "epic/e1"])).toBe(tip);
    expect(branches(ws.repoDir)).not.toContain(ASIDE);
    expect(releaseEvents(retry.runDir)).toHaveLength(0);
  });
});
