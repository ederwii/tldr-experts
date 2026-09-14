/**
 * `tldrx ship` may not open a PR over an epic that is behind its base or red on
 * its own Definition of Done (gh #315).
 *
 * ## What was measured
 *
 * Relayed on the issue (a 12-run audit window, 2026-09-12 → 09-14): four PRs
 * opened by `tldrx ship` came back red and needed a human — an epic cut from a
 * `main` that had since moved, a check that failed on the tree the PR really
 * merges, and scratch files that broke the suite. Read on `origin/main` at
 * `70da3d1`: between choosing `base` and `gh pr create`, `ship.ts` never fetched
 * the base, never asked whether the epic contained it, and never ran a single
 * workspace command — so the first thing that ever ran the gate over the tree
 * a PR merges was the remote's CI, on a PR that already existed.
 *
 * ## What these tests hold
 *
 *   FRESH       under `ship.push` a base that moved is fetched and MERGED into the
 *               epic (never rebased, never forced) before the push and the PR.
 *   GATED       the done stories' ```dod commands run on the tree the PR would
 *               merge — the epic head, with the base merged in — and a red one is
 *               a refusal (exit 2) naming the command and its exit.
 *   NOTHING MOVES ON A NO   a conflict or a red gate leaves the epic ref, the remote
 *               and the worktree list exactly as they were.
 *   ONE PATH    `--dry-run` runs the same fetch, merge and gate, and exits with the
 *               same code; only the ref update, the push and `gh` are skipped.
 *
 * The premise is REAL git, not stubbed: a bare `origin` inside the test's own temp
 * directory, a second clone that advances `main` so the local `main` stays stale
 * (the field shape), and the fixture's real `npm run test`. Only `gh` is a table.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realShipTransport, shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import type { RunFile } from "../src/core/run/RunFile.ts";
import { EXIT_GATE_REFUSED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Real git, a real bare origin, a real `npm run test` in a worktree.
setDefaultTimeout(spawnTestTimeout(90_000));

const ONE: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

const PR_URL = "https://github.com/ederwii/app/pull/7";
const PUSH_POLICY: NonNullable<RunFile["ship"]> = { push: true, pr: true, auto_merge: "never" };

let open: BuildWorkspace[] = [];

afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function exitOf(dir: string, args: readonly string[]): number {
  try {
    execFileSync("git", [...args], { cwd: dir, stdio: "pipe" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

function commitFile(dir: string, rel: string, content: string, message: string): string {
  writeFileSync(join(dir, rel), content, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

interface Shippable extends BuildWorkspace {
  readonly originDir: string;
  /** A second clone of origin — the "somebody else merged to main" side. */
  readonly otherDir: string;
}

/**
 * S1 done, an epic branch with one real commit on it, both branches on a bare
 * origin, and a second clone to move `main` from. The local `main` is never
 * updated after that, which is exactly the stale checkout the field ran from.
 */
function shippable(ship: RunFile["ship"] | null): Shippable {
  const ws = makeBuildWorkspace(ONE);
  open.push(ws);
  const storyDir = join(ws.runDir, "03-plan", "stories");
  for (const name of readdirSync(storyDir)) {
    const path = join(storyDir, name);
    writeFileSync(path, readFileSync(path, "utf8")
      .replace(/^status: todo$/m, "status: done")
      .replace(/^evidence: \[\]$/m, 'evidence: ["04-build/handoff.md:1"]'), "utf8");
  }
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: ["epic/e1"] }, ...(ship === null ? {} : { ship }) }));
  store.save();
  mkdirSync(join(ws.runDir, "04-build"), { recursive: true });
  writeFileSync(join(ws.runDir, "04-build", "handoff.md"), "# Build handoff\n\n## Findings\n\n- S1 done\n", "utf8");

  const originDir = join(ws.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originDir], { stdio: "pipe" });
  git(ws.repoDir, ["remote", "add", "origin", originDir]);
  git(ws.repoDir, ["push", "-q", "origin", "main"]);
  git(ws.repoDir, ["checkout", "-q", "-b", "epic/e1"]);
  commitFile(ws.repoDir, "s1.txt", "S1\n", "merge(S1)");
  git(ws.repoDir, ["checkout", "-q", "main"]);
  git(ws.repoDir, ["push", "-q", "origin", "epic/e1"]);

  const otherDir = join(ws.root, "other");
  execFileSync("git", ["clone", "-q", originDir, otherDir], { stdio: "pipe" });
  return { ...ws, originDir, otherDir };
}

/** Advance origin's `main` from the other clone; the local checkout does not see it. */
function moveMain(ws: Shippable, rel: string, content: string): string {
  const sha = commitFile(ws.otherDir, rel, content, `main moves: ${rel}`);
  git(ws.otherDir, ["push", "-q", "origin", "main"]);
  return sha;
}

interface Call { readonly cmd: string; readonly args: readonly string[]; readonly epicHasBase?: boolean }

/**
 * Real git and real workspace commands; `gh` answered from a table. At the moment
 * `gh pr create` runs it measures, on the ORIGIN's epic, whether `baseSha` is an
 * ancestor — the property the PR's checks would see.
 */
function transport(ws: Shippable, baseSha: string | null): ShipTransport & { calls: Call[] } {
  const real = realShipTransport();
  const calls: Call[] = [];
  return {
    calls,
    async run(cmd, args, cwd, timeoutMs) {
      if (cmd === "gh") {
        const create = args[0] === "pr" && args[1] === "create";
        const epicHasBase = create && baseSha !== null
          ? exitOf(ws.originDir, ["merge-base", "--is-ancestor", baseSha, "refs/heads/epic/e1"]) === 0
          : undefined;
        calls.push({ cmd, args: [...args], ...(epicHasBase === undefined ? {} : { epicHasBase }) });
        if (args[0] === "--version") return { exitCode: 0, stdout: "gh version 2.62.0\n", stderr: "" };
        if (create) return { exitCode: 0, stdout: `${PR_URL}\n`, stderr: "" };
        if (args[0] === "pr" && args[1] === "list") return { exitCode: 0, stdout: "[]\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      calls.push({ cmd, args: [...args] });
      return await real.run(cmd, args, cwd, timeoutMs);
    },
  };
}

function ship(ws: Shippable, t: ShipTransport, dryRun = false) {
  return shipRun({
    root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-14T10:00:00Z", transport: t, dryRun,
  });
}

const created = (t: { calls: Call[] }): Call[] =>
  t.calls.filter((call) => call.cmd === "gh" && call.args[0] === "pr" && call.args[1] === "create");
const pushed = (t: { calls: Call[] }): boolean =>
  t.calls.some((call) => call.cmd === "git" && call.args[0] === "push");
const worktrees = (ws: Shippable): number =>
  git(ws.repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length;

describe("tldrx ship brings the epic up to date with its base and runs the gate before the PR (#315)", () => {
  test("ship.push + a base that moved: the base is merged into the epic and pushed BEFORE gh pr create", async () => {
    const ws = shippable(PUSH_POLICY);
    const baseSha = moveMain(ws, "main-only.txt", "from main\n");
    // The premise: the epic does not contain the moved base, and neither does the local main.
    expect(exitOf(ws.repoDir, ["merge-base", "--is-ancestor", baseSha, "epic/e1"])).not.toBe(0);
    const epicBefore = git(ws.repoDir, ["rev-parse", "epic/e1"]);

    const t = transport(ws, baseSha);
    const out = await ship(ws, t);

    expect(out.code).toBe(EXIT_OK);
    expect(created(t)).toHaveLength(1);
    // Measured on the ORIGIN at the moment the PR was created, not on a log line.
    expect(created(t)[0]?.epicHasBase).toBe(true);
    // A forward merge: the old epic tip is still an ancestor — nothing was rewritten.
    expect(exitOf(ws.repoDir, ["merge-base", "--is-ancestor", epicBefore, "epic/e1"])).toBe(0);
    expect(exitOf(ws.repoDir, ["merge-base", "--is-ancestor", baseSha, "epic/e1"])).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("merged `origin/main` into `epic/e1`");
    expect(text).toContain("gate: `npm run test` exit 0");
    // No force of any kind reached git.
    const pushes = t.calls.filter((call) => call.cmd === "git" && call.args[0] === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.args.some((arg) => arg.startsWith("--force") || arg.startsWith("+"))).toBe(false);
    expect(worktrees(ws)).toBe(1);
  });

  test("ship.push + a base that moved, --dry-run: the merge is gated, and the branch, origin and gh are untouched", async () => {
    const ws = shippable(PUSH_POLICY);
    const baseSha = moveMain(ws, "main-only.txt", "from main\n");
    const epicBefore = git(ws.repoDir, ["rev-parse", "epic/e1"]);
    const originEpicBefore = git(ws.originDir, ["rev-parse", "refs/heads/epic/e1"]);

    const t = transport(ws, null);
    const out = await ship(ws, t, true);

    expect(out.code).toBe(EXIT_OK);
    expect(git(ws.repoDir, ["rev-parse", "epic/e1"])).toBe(epicBefore);
    expect(git(ws.originDir, ["rev-parse", "refs/heads/epic/e1"])).toBe(originEpicBefore);
    expect(pushed(t)).toBe(false);
    expect(created(t)).toHaveLength(0);
    const text = out.lines.join("\n");
    expect(text).toContain(`would merge \`origin/main\` (${baseSha.slice(0, 7)}) into \`epic/e1\``);
    expect(text).toContain("gate: `npm run test` exit 0 on the merge of `origin/main` into `epic/e1`");
    expect(worktrees(ws)).toBe(1);
  });

  test("ship.push + the epic checked out in a worktree: that checkout is fast-forwarded with its ref, clean", async () => {
    const ws = shippable(PUSH_POLICY);
    const epicTree = join(ws.root, "epic-tree");
    git(ws.repoDir, ["worktree", "add", "-q", epicTree, "epic/e1"]);
    const baseSha = moveMain(ws, "main-only.txt", "from main\n");

    const t = transport(ws, baseSha);
    const out = await ship(ws, t);

    expect(out.code).toBe(EXIT_OK);
    expect(created(t)[0]?.epicHasBase).toBe(true);
    expect(git(epicTree, ["rev-parse", "HEAD"])).toBe(git(ws.repoDir, ["rev-parse", "epic/e1"]));
    expect(git(epicTree, ["status", "--porcelain"])).toBe("");
    expect(worktrees(ws)).toBe(2);
  });

  test("no ship.push: the gate runs on the merge of the moved base, the user's branch is not moved", async () => {
    const ws = shippable(null);
    const baseSha = moveMain(ws, "main-only.txt", "from main\n");
    const epicBefore = git(ws.repoDir, ["rev-parse", "epic/e1"]);

    const t = transport(ws, null);
    const out = await ship(ws, t);

    expect(out.code).toBe(EXIT_OK);
    expect(git(ws.repoDir, ["rev-parse", "epic/e1"])).toBe(epicBefore);
    expect(pushed(t)).toBe(false);
    const text = out.lines.join("\n");
    expect(text).toContain(`gate: \`npm run test\` exit 0`);
    expect(text).toContain(`\`epic/e1\` is behind \`origin/main\` (${baseSha.slice(0, 7)})`);
    expect(worktrees(ws)).toBe(1);
  });

  test("a base whose change turns the suite red on the merged tree: exit 2 naming the command, nothing moved — dry-run agrees", async () => {
    const ws = shippable(PUSH_POLICY);
    const pkg = JSON.parse(readFileSync(join(ws.repoDir, "package.json"), "utf8")) as Record<string, unknown>;
    moveMain(ws, "package.json", `${JSON.stringify({ ...pkg, scripts: { test: 'node -e "process.exit(3)"' } }, null, 2)}\n`);
    const epicBefore = git(ws.repoDir, ["rev-parse", "epic/e1"]);
    const originEpicBefore = git(ws.originDir, ["rev-parse", "refs/heads/epic/e1"]);

    for (const dryRun of [true, false]) {
      const t = transport(ws, null);
      const out = await ship(ws, t, dryRun);

      expect(out.code, `dryRun=${String(dryRun)}`).toBe(EXIT_GATE_REFUSED);
      const text = out.lines.join("\n");
      expect(text).toContain("`npm run test` exited 3");
      expect(text).toContain("no PR was opened");
      expect(created(t)).toHaveLength(0);
      expect(pushed(t)).toBe(false);
      expect(git(ws.repoDir, ["rev-parse", "epic/e1"])).toBe(epicBefore);
      expect(git(ws.originDir, ["rev-parse", "refs/heads/epic/e1"])).toBe(originEpicBefore);
      expect(worktrees(ws)).toBe(1);
    }
  });

  test("an epic whose own head is red, base unchanged: exit 2, no PR", async () => {
    const ws = shippable(null);
    const pkg = JSON.parse(readFileSync(join(ws.repoDir, "package.json"), "utf8")) as Record<string, unknown>;
    git(ws.repoDir, ["checkout", "-q", "epic/e1"]);
    commitFile(ws.repoDir, "package.json",
      `${JSON.stringify({ ...pkg, scripts: { test: 'node -e "process.exit(1)"' } }, null, 2)}\n`, "red");
    git(ws.repoDir, ["checkout", "-q", "main"]);
    git(ws.repoDir, ["push", "-q", "origin", "epic/e1"]);

    const t = transport(ws, null);
    const out = await ship(ws, t);

    expect(out.code).toBe(EXIT_GATE_REFUSED);
    expect(out.lines.join("\n")).toContain("`npm run test` exited 1");
    expect(created(t)).toHaveLength(0);
  });

  test("a base that conflicts with the epic: exit 2 naming the path, epic and worktrees untouched — dry-run agrees", async () => {
    const ws = shippable(PUSH_POLICY);
    git(ws.repoDir, ["checkout", "-q", "epic/e1"]);
    commitFile(ws.repoDir, "README.md", "# app — the epic's words\n", "epic edits README");
    git(ws.repoDir, ["checkout", "-q", "main"]);
    git(ws.repoDir, ["push", "-q", "origin", "epic/e1"]);
    moveMain(ws, "README.md", "# app — main's words\n");
    const epicBefore = git(ws.repoDir, ["rev-parse", "epic/e1"]);

    for (const dryRun of [true, false]) {
      const t = transport(ws, null);
      const out = await ship(ws, t, dryRun);

      expect(out.code, `dryRun=${String(dryRun)}`).toBe(EXIT_GATE_REFUSED);
      const text = out.lines.join("\n");
      expect(text).toContain("conflicts with `origin/main`");
      expect(text).toMatch(/^\s+README\.md$/m);
      expect(created(t)).toHaveLength(0);
      expect(pushed(t)).toBe(false);
      expect(git(ws.repoDir, ["rev-parse", "epic/e1"])).toBe(epicBefore);
      expect(worktrees(ws)).toBe(1);
    }
  });

  test("GUARD: a fresh, green epic opens the PR and says what the gate ran", async () => {
    const ws = shippable(null);
    const t = transport(ws, null);
    const out = await ship(ws, t);

    expect(out.code).toBe(EXIT_OK);
    expect(created(t)).toHaveLength(1);
    const text = out.lines.join("\n");
    expect(text).toContain("gate: `npm run test` exit 0");
    expect(text).not.toContain("is behind");
    expect(worktrees(ws)).toBe(1);
  });
});
