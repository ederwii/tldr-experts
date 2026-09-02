/**
 * A closed run must not make the operator's next `git pull` refuse (issue #102).
 *
 * ## What was measured, on a real repo
 *
 * `aparece-v2`, run `260830-ordering-inventory`, 2026-09-02. The run closed at
 * `14:14:00Z` (`events.jsonl`, `type: run.closed`). Ninety-two seconds later,
 * commit `37e9736` — "tldrx: run 260830-ordering-inventory closed — 7/7 stories,
 * epic ready for review", authored by the operator's agent, NOT by tldrx — put a
 * snapshot of the whole live `tldrx-work/<run>/` tree plus `.tldrx/memory/facts.yml`
 * onto `epic/ordering-inventory` (`git reflog show epic/ordering-inventory`: the
 * branch's only non-merge commit). PR #10 merged it to `main`, and the operator's
 * `git pull` was refused: five paths "modified locally, incoming in the merge" and
 * about forty "untracked locally, tracked in the incoming commits".
 *
 * The framework's own state is what collided, and the reason is structural rather
 * than a race: in a `root_is_repo` workspace the facilitator writes `run.yml`,
 * `events.jsonl`, `budget.yml` and every phase document into the operator's WORKING
 * TREE, and leaves them there uncommitted for the length of the run. Any commit of
 * those same paths arriving from anywhere else meets a dirty tree, every time.
 *
 * ## The invariant these tests pin
 *
 * After a run closes and its epic merges to the remote trunk, `git pull` in the
 * operator's checkout exits 0. Nothing else about the run is asserted here.
 *
 * Real git throughout — a bare "origin", a working clone that is the operator's
 * checkout, a real epic branch, a real merge and a real pull. A stubbed git would
 * let "the pull was clean" and "the pull was refused" pass in the same direction,
 * which is the entire question.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { approve } from "../src/core/run/gates.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { commitPathsOnly } from "../src/core/build/git.ts";
import { GITIGNORE_BODY, writeAmbientFootprint } from "../src/core/init/ambientFootprint.ts";
import { WriteLog } from "../src/core/init/writeFile.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../src/core/paths.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE"] as const;

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

/** One run, one epic, two stories — the smallest shape that cuts a real epic branch. */
const TWO_STORIES: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second story", dependsOn: ["S1"] },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1"], ["S2"]],
  // The workspace root IS the product repo — the shape the issue is about, and
  // the only one where the framework's state and the product share a checkout.
  rootIsRepo: true,
};

/**
 * The operator's checkout: the build fixture's `root_is_repo` workspace, plus the
 * managed `.gitignore` block a real workspace gets from `tldrx init` — without it
 * the fixture would commit `.agent/` scratch and `*.bak` backups that no real
 * workspace carries, and the test would be measuring the fixture.
 */
function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  appendFileSync(join(made.root, ".gitignore"), `\n${GITIGNORE_BODY}\n`, "utf8");
  git(made.root, "add", ".gitignore");
  git(made.root, "commit", "-m", "chore: tldrx ignores");
  return made;
}

/** The build, run for real. `4` is a green build parked at its gate (spec §3). */
async function build(ws: BuildWorkspace): Promise<void> {
  const outcome = await runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: "2026-09-02T09:00:00Z",
  });
  expect(outcome.code).toBe(4);
}

/** Signing the last gate — the most ordinary way a run closes. */
async function close(ws: BuildWorkspace): Promise<boolean> {
  const signed = await approve(RunStore.open(ws.runDir), {
    root: ws.root, actor: "alan", at: "2026-09-02T14:14:00Z", note: "ship it",
  });
  return signed.runDone;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** Exit code and output, for the calls whose FAILURE is the measurement. */
function tryGit(cwd: string, ...args: string[]): { code: number; out: string } {
  const done = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: done.status ?? -1, out: `${done.stdout}${done.stderr}` };
}

/** A bare remote for `ws.root`, with `main` already pushed. Cleaned up per test. */
function publish(ws: BuildWorkspace): string {
  const origin = mkdtempSync(join(tmpdir(), "tldrx-origin-"));
  scratch.push(origin);
  git(origin, "init", "--bare", "-b", "main", ".");
  git(ws.root, "remote", "add", "origin", origin);
  git(ws.root, "push", "-u", "origin", "main");
  return origin;
}

/**
 * The commit the operator's agent made, faithfully: a checkout of the epic branch,
 * the LIVE state copied over it, committed there. Made AFTER the run closed, which
 * is when it happened on aparece-v2 (92 s after `run.closed`).
 */
function snapshotStateOntoEpic(ws: BuildWorkspace, branch: string, message: string): void {
  const tree = mkdtempSync(join(tmpdir(), "tldrx-epic-"));
  scratch.push(tree);
  rmSync(tree, { recursive: true, force: true });
  git(ws.root, "worktree", "add", "-f", tree, branch);
  cpSync(join(ws.root, PROJECT_WORK_DIR), join(tree, PROJECT_WORK_DIR), { recursive: true });
  cpSync(join(ws.root, PROJECT_FRAMEWORK_DIR, "memory"), join(tree, PROJECT_FRAMEWORK_DIR, "memory"), { recursive: true });
  git(tree, "add", "--", PROJECT_WORK_DIR, `${PROJECT_FRAMEWORK_DIR}/memory`);
  git(tree, "commit", "-m", message);
  git(ws.root, "worktree", "remove", "--force", tree);
}

/** The PR merge: the epic lands on the remote's trunk, in somebody else's clone. */
function mergeToTrunk(origin: string, ws: BuildWorkspace, branch: string): void {
  git(ws.root, "push", "origin", branch);
  const clone = mkdtempSync(join(tmpdir(), "tldrx-merge-"));
  scratch.push(clone);
  rmSync(clone, { recursive: true, force: true });
  git(tmpdir(), "clone", "-q", origin, clone);
  git(clone, "config", "user.email", "merge@example.com");
  git(clone, "config", "user.name", "the pr merge");
  git(clone, "merge", "--no-ff", "--no-edit", "-m", `Merge pull request from ${branch}`, `origin/${branch}`);
  git(clone, "push", "origin", "main");
}

// ---------------------------------------------------------------------------
// 1. The invariant, end to end
// ---------------------------------------------------------------------------

describe("1. a closed run's epic merges without breaking the operator's pull", () => {
  /**
   * The whole of issue #102 in one test.
   *
   * Every step is the real one: a real Build (the fake `claude` is the only stand-in),
   * a real `approve` that closes the run, the agent's snapshot commit made exactly
   * where it was made on aparece-v2, a real merge on a real remote, and a real pull.
   *
   * RED before the fix: the pull is refused, because the run's state sits modified
   * and untracked in the operator's tree while the same paths arrive in the merge.
   */
  test("after `approve` closes the run and the epic merges to origin/main, `git pull` exits 0", async () => {
    const ws = workspace(TWO_STORIES);
    const origin = publish(ws);

    // The run: a real build, which writes run.yml, events.jsonl and 04-build/ into
    // the operator's working tree and leaves them there.
    await build(ws);
    expect(git(ws.root, "status", "--porcelain")).toContain(PROJECT_WORK_DIR);

    expect(await close(ws)).toBe(true);

    // …and then the agent's snapshot, and the PR merge.
    snapshotStateOntoEpic(ws, "epic/e1", "tldrx: run closed — epic ready for review");
    mergeToTrunk(origin, ws, "epic/e1");

    const pulled = tryGit(ws.root, "pull", "--no-rebase", "--no-edit");
    expect(pulled.out).not.toContain("would be overwritten");
    expect(pulled.code).toBe(0);
  }, 120_000);

  /**
   * The mechanism, stated on its own so a regression says WHICH half broke.
   *
   * The state the run wrote is committed by the close, in the operator's checkout,
   * on the branch that checkout is on — not on the epic, and not left for the
   * operator to sweep up with `git add .` on a stale base (which is what turned the
   * refused pull into a divergent-branches fork on aparece-v2).
   */
  test("the close commits the run's own state in the operator's checkout, and nothing else", async () => {
    const ws = workspace(TWO_STORIES);
    await build(ws);

    // A product change the operator has in flight — STAGED, which is the case a
    // bare `git add -A && git commit` would silently swallow into the run's commit.
    writeFileSync(join(ws.root, "README.md"), "# app\n\nthe operator was mid-edit\n", "utf8");
    git(ws.root, "add", "README.md");

    const before = git(ws.root, "rev-parse", "HEAD").trim();
    expect(await close(ws)).toBe(true);
    const after = git(ws.root, "rev-parse", "HEAD").trim();

    expect(after).not.toBe(before);
    const committed = git(ws.root, "show", "--name-only", "--format=", "HEAD").split("\n")
      .map((line) => line.trim()).filter((line) => line !== "");
    expect(committed.length).toBeGreaterThan(0);
    const product = committed.filter((path) =>
      !path.startsWith(`${PROJECT_WORK_DIR}/`) && !path.startsWith(`${PROJECT_FRAMEWORK_DIR}/`));
    expect(product).toEqual([]);
    // The operator's staged product change is still staged, and still uncommitted.
    expect(git(ws.root, "status", "--porcelain")).toContain("M  README.md");
    // The run's live state is not dirty any more.
    expect(git(ws.root, "status", "--porcelain")).not.toContain(`${PROJECT_WORK_DIR}/${ws.runId}/run.yml`);
  }, 120_000);

  /**
   * The one branch the close must never commit run state to is the run's own epic.
   *
   * An operator whose checkout happens to sit on the epic would otherwise have the
   * close create the exact commit this issue exists to stop — from inside the fix.
   */
  test("it refuses to commit run state when the operator's checkout is ON the run's epic branch", async () => {
    const ws = workspace(TWO_STORIES);
    await build(ws);

    git(ws.root, "checkout", "--ignore-other-worktrees", "epic/e1");
    const before = git(ws.root, "rev-parse", "HEAD").trim();

    expect(await close(ws)).toBe(true);

    expect(git(ws.root, "rev-parse", "HEAD").trim()).toBe(before);
    expect(git(ws.root, "status", "--porcelain")).toContain(PROJECT_WORK_DIR);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. An epic under review carries feature code, not process meta-state
// ---------------------------------------------------------------------------

describe("2. `tldrx ship` will not open a PR for an epic carrying the framework's own state", () => {
  /** Real `git` in the real fixture repo; a stub `gh` that would happily create a PR. */
  function transport(log: string[]): ShipTransport {
    return {
      async run(cmd, args, cwd) {
        if (cmd !== "git") {
          log.push(`${cmd} ${args.join(" ")}`);
          return { exitCode: 0, stdout: "https://example.invalid/pr/1\n", stderr: "" };
        }
        const done = spawnSync("git", args, { cwd, encoding: "utf8" });
        return { exitCode: done.status ?? 1, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
      },
    };
  }

  /** A run that built and closed — `tldrx ship` runs after the close, as it did here. */
  async function shipReady(): Promise<BuildWorkspace> {
    const ws = workspace(TWO_STORIES);
    await build(ws);
    // The Build stage writes `04-build/handoff.md` itself; `ship` uses it as the PR body.
    expect(existsSync(join(ws.runDir, "04-build", "handoff.md"))).toBe(true);
    expect(await close(ws)).toBe(true);
    return ws;
  }

  test("it refuses, names the paths, and creates nothing", async () => {
    const ws = await shipReady();
    const origin = publish(ws);
    snapshotStateOntoEpic(ws, "epic/e1", "tldrx: run closed — epic ready for review");
    git(ws.root, "push", "origin", "epic/e1");

    const log: string[] = [];
    const outcome = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-02T14:20:00Z", transport: transport(log),
    });

    expect(outcome.code).toBe(2);
    const said = outcome.lines.join("\n");
    expect(said).toContain(`${PROJECT_WORK_DIR}/`);
    expect(said).toContain("epic/e1");
    // `gh --version` is a probe; nothing was created. (`gh pr create` is the line
    // that would have opened the PR, and it never ran.)
    expect(log.join("\n")).not.toContain("pr create");
    expect(existsSync(origin)).toBe(true);
  }, 120_000);

  test("an epic that carries only product code is shipped exactly as before", async () => {
    const ws = await shipReady();
    publish(ws);
    git(ws.root, "push", "origin", "epic/e1");

    const log: string[] = [];
    const outcome = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-02T14:20:00Z", transport: transport(log),
    });

    expect(outcome.code).toBe(0);
    expect(log.join("\n")).toContain("pr create");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. tldrx's own *.bak backups
// ---------------------------------------------------------------------------

describe("3. every `*.bak` tldrx writes is gitignored", () => {
  /**
   * Measured on aparece-v2, 2026-09-02: `run.yml.bak`, `budget.yml.bak`,
   * `facts.yml.bak` and `preflight.yml.bak` sat untracked and were swept into the
   * operator's rescue commit. `preflight.yml.bak` is the one the shipped patterns
   * miss — it lives at `tldrx-work/<run>/04-build/preflight.yml.bak`, one level
   * deeper than `tldrx-work/*&#47;*.bak` reaches, so the block's own
   * `!tldrx-work/**` re-include claims it.
   */
  test("at every depth the framework actually writes one", async () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-ignore-"));
    scratch.push(root);
    git(root, "init", "-b", "main", ".");
    await writeAmbientFootprint(root, new WriteLog());

    const backups = [
      `${PROJECT_WORK_DIR}/260830-a/run.yml.bak`,
      `${PROJECT_WORK_DIR}/260830-a/budget.yml.bak`,
      `${PROJECT_WORK_DIR}/260830-a/04-build/preflight.yml.bak`,
      `${PROJECT_FRAMEWORK_DIR}/memory/facts.yml.bak`,
    ];
    for (const path of backups) {
      expect(`${path}: ${tryGit(root, "check-ignore", "--no-index", path).code}`).toBe(`${path}: 0`);
    }

    // …and the state itself is still committed. An ignore that swallowed run.yml
    // would pass the four assertions above and lose the run.
    for (const path of [`${PROJECT_WORK_DIR}/260830-a/run.yml`, `${PROJECT_FRAMEWORK_DIR}/memory/facts.yml`]) {
      expect(`${path}: ${tryGit(root, "check-ignore", "--no-index", path).code}`).toBe(`${path}: 1`);
    }
  });

  /**
   * The seam for workspaces that already exist.
   *
   * A widened `init` block only reaches a workspace that re-runs `tldrx init`, and
   * aparece-v2's block predates it — so the close excludes `*.bak` in its own
   * pathspec, whatever the repo's `.gitignore` says. Asserted against a repo with
   * NO tldrx ignores at all, which is the case that would otherwise commit them.
   *
   * `*` and not `**` in that exclude, because a git pathspec is fnmatch without
   * FNM_PATHNAME: `<path>/*.bak` excludes at every depth, and `<path>/**\/*.bak`
   * needs a literal slash for the `**` to sit in and lets `run.yml.bak` through.
   */
  test("the close's own pathspec keeps them out even when nothing gitignores them", async () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-bakspec-"));
    scratch.push(root);
    git(root, "init", "-b", "main", ".");
    git(root, "config", "user.email", "fixture@example.com");
    git(root, "config", "user.name", "tldrx fixture");
    writeFileSync(join(root, "README.md"), "# app\n", "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-m", "init");

    const run = `${PROJECT_WORK_DIR}/260830-a`;
    for (const [rel, body] of [
      [`${run}/run.yml`, "version: 1\n"],
      [`${run}/run.yml.bak`, "version: 0\n"],
      [`${run}/04-build/preflight.yml`, "ok: true\n"],
      [`${run}/04-build/preflight.yml.bak`, "ok: false\n"],
      [`${PROJECT_FRAMEWORK_DIR}/memory/facts.yml`, "facts: []\n"],
      [`${PROJECT_FRAMEWORK_DIR}/memory/facts.yml.bak`, "facts: []\n"],
    ] as const) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), body, "utf8");
    }

    const done = await commitPathsOnly(root, "tldrx: state", [run, `${PROJECT_FRAMEWORK_DIR}/memory`],
      [`${run}/*.bak`, `${PROJECT_FRAMEWORK_DIR}/memory/*.bak`]);

    expect(done.committed).toBe(true);
    expect([...done.files].sort()).toEqual([
      `${PROJECT_FRAMEWORK_DIR}/memory/facts.yml`,
      `${run}/04-build/preflight.yml`,
      `${run}/run.yml`,
    ]);
  });

  /**
   * A workspace that deliberately gitignores `tldrx-work/` is not a workspace whose
   * close should report a failure at it. `git add <ignored dir>` exits 1 with "Use
   * -f if you really want to add them", and `-f` is exactly what must not happen —
   * so the ignored paths are dropped and the close has nothing to say.
   */
  test("state the repo gitignores is dropped, not forced and not reported as a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "tldrx-ignored-"));
    scratch.push(root);
    git(root, "init", "-b", "main", ".");
    git(root, "config", "user.email", "fixture@example.com");
    git(root, "config", "user.name", "tldrx fixture");
    writeFileSync(join(root, ".gitignore"), `${PROJECT_WORK_DIR}/\n`, "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-m", "init");
    mkdirSync(join(root, PROJECT_WORK_DIR, "260830-a"), { recursive: true });
    writeFileSync(join(root, PROJECT_WORK_DIR, "260830-a", "run.yml"), "version: 1\n", "utf8");

    const done = await commitPathsOnly(root, "tldrx: state", [`${PROJECT_WORK_DIR}/260830-a`]);

    expect(done.ok).toBe(true);
    expect(done.committed).toBe(false);
    expect(git(root, "log", "--format=%s").trim()).toBe("init");
  });
});
