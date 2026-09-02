/**
 * `scripts/merge-wave.sh` — the lock, the HEAD assertion, and the dirty-tree guard
 * (#44, #45).
 *
 * Every test here runs the REAL script against a REAL repository: a bare "origin", a
 * working clone that stands in for the shared main checkout, real branches, a real
 * merge and a real push. Only the four gates are stand-ins — the sandbox's own
 * package.json declares them — because `bun run typecheck` on a two-file repo proves
 * nothing, while the sha each gate RAN AGAINST proves everything. That sha is the whole
 * bug: measured 2026-08-31 on the pre-fix script, two concurrent invocations produced
 *
 *   A: typecheck 7afcc0e (its own merge) · build fadc923 (the OTHER agent's merge)
 *   A's summary line: "OK fadc923 … pushed"
 *
 * — a green report over a tree A never finished gating, and, with a red change in the
 * other branch, a FAIL handed to the agent who did not write it. The same repro against
 * this script is the first test below.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Each invocation runs a real `bun install`, a real `bun test` and a real merge, and the
// serialisation test deliberately runs two of them. #43's budget, with a bigger base.
setDefaultTimeout(spawnTestTimeout(180_000));

const REPO = join(import.meta.dir, "..");
const MERGE_WAVE = join(REPO, "scripts", "merge-wave.sh");

/** A stand-in gate that records the sha it ran against — and can be told to misbehave. */
const GATE_SH = `#!/usr/bin/env bash
echo "$1 $(git rev-parse HEAD)" >> "$GATE_LOG"
if [ -f poison.txt ]; then echo "gate saw poison.txt"; exit 1; fi
if [ -n "\${GATE_HOLD_UNTIL:-}" ] && [ "\${GATE_HOLD_ON:-typecheck}" = "$1" ]; then
  n=0
  while [ ! -f "$GATE_HOLD_UNTIL" ] && [ "$n" -lt 900 ]; do sleep 0.1; n=$((n+1)); done
fi
if [ "\${GATE_MOVE_HEAD:-}" = "$1" ]; then git commit -q --allow-empty -m "a third party moves HEAD mid-gate"; fi
exit 0
`;

const PACKAGE_JSON = JSON.stringify({
  name: "mw-sandbox", private: true, type: "module",
  scripts: { typecheck: "bash gate.sh typecheck", build: "bash gate.sh build" },
}, null, 2);

/**
 * Every git command the sandbox builds itself with runs under an `init.defaultBranch`
 * that is deliberately NOT `main` (#49).
 *
 * This file's repos are all named `main`, and a runner whose default branch is `master`
 * is the difference between green on macOS and red on CI: the bare repo's HEAD points at
 * a ref that never exists, a clone that does not ASK for a branch checks out nothing, and
 * the next `git push origin main` dies with `src refspec main does not match any` —
 * five lines away from the cause. That is the real CI failure of 2026-09-01 (run
 * 33459567355, sha 064279e), and it was invisible here because the host happened to
 * default to `main`.
 *
 * So the hostile default is pinned rather than inherited. Anything in this sandbox that
 * still infers a branch name now fails on every machine, not one in twenty runs.
 */
const HOSTILE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "init.defaultBranch",
  GIT_CONFIG_VALUE_0: "trunk",
};

type Sandbox = { dir: string; main: string; originGit: string; git: (...a: string[]) => string };

let open: Sandbox[] = [];

afterEach(() => {
  for (const sb of open) rmSync(sb.dir, { recursive: true, force: true });
  open = [];
});

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-mergewave-"));
  const main = join(dir, "main");
  const originGit = join(dir, "origin.git");
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: HOSTILE_GIT_ENV }).trim();
  // `-b main` and `--branch main` are not decoration: a runner whose `init.defaultBranch`
  // is `master` gives the bare repo a HEAD pointing at a ref that never exists, and the
  // clone below then has no local `main` at all. That is exactly how this file passed on
  // macOS and failed on CI.
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originGit], { env: HOSTILE_GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", main], { env: HOSTILE_GIT_ENV });
  for (const cfg of [["user.email", "fixture@example.com"], ["user.name", "Fixture"], ["commit.gpgsign", "false"]]) {
    run(main, "config", cfg[0]!, cfg[1]!);
  }
  // The sandbox carries the REAL .gitignore — the rule #45 adds is the one under test.
  writeFileSync(join(main, ".gitignore"), `${readFileSync(join(REPO, ".gitignore"), "utf8")}\nbun.lock\n`);
  writeFileSync(join(main, "package.json"), `${PACKAGE_JSON}\n`);
  writeFileSync(join(main, "gate.sh"), GATE_SH);
  chmodSync(join(main, "gate.sh"), 0o755);
  writeFileSync(join(main, "sandbox.test.ts"),
    'import { expect, test } from "bun:test";\ntest("the sandbox suite is green", () => { expect(1).toBe(1); });\n');
  run(main, "add", "-A");
  run(main, "commit", "-q", "-m", "sandbox base");
  run(main, "remote", "add", "origin", originGit);
  run(main, "push", "-q", "origin", "main");
  run(main, "fetch", "-q", "origin");
  for (const branch of ["wave-a", "wave-b", "wave-poison"]) {
    run(main, "checkout", "-q", "-b", branch, "main");
    writeFileSync(join(main, branch === "wave-poison" ? "poison.txt" : `${branch}.txt`), `${branch}\n`);
    run(main, "add", "-A");
    run(main, "commit", "-q", "-m", `${branch} work`);
    run(main, "checkout", "-q", "main");
  }
  const sb: Sandbox = { dir, main, originGit, git: (...a) => run(main, ...a) };
  open.push(sb);
  return sb;
}

type Result = { code: number; stdout: string; stderr: string };
type Invocation = {
  done: Promise<Result>;
  /** The private $TMPDIR this invocation's `mw-$$` goes in — see `waveLogs` (#95, #97). */
  logRoot: string;
  stderrSoFar: () => string;
  signal: (sig: NodeJS.Signals) => void;
};

let invocations = 0;

function invoke(sb: Sandbox, branch: string, env: Record<string, string> = {}): Invocation {
  let stdout = "";
  let stderr = "";
  // Per INVOCATION, not per sandbox: this file deliberately runs two waves at once, and a
  // run's cleanup is only ever its own to answer for. Inside `sb.dir`, so afterEach takes
  // the log directories a RED run keeps on purpose instead of leaving them in the machine's
  // tmpdir, where 1300 of them had piled up by the time #95 was filed.
  const logRoot = join(sb.dir, "tmpdirs", `invocation-${++invocations}`);
  mkdirSync(logRoot, { recursive: true });
  const child = spawn("bash", [MERGE_WAVE, branch, `merge ${branch}`], {
    cwd: sb.main,
    env: { ...process.env, TMPDIR: logRoot, GATE_LOG: join(sb.dir, `gate-${branch}.log`), ...env },
  });
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const done = new Promise<Result>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  return { done, logRoot, stderrSoFar: () => stderr, signal: (sig) => { child.kill(sig); } };
}

/**
 * The `mw-*` log directories THIS invocation left behind — never another process's.
 *
 * Read only after `done` resolves, so the run that owns this root has exited: anything
 * still in here is a genuine leftover, and no liveness rule has to be guessed at. What a
 * concurrent wave is holding in the shared $TMPDIR is, correctly, invisible from here.
 */
function waveLogs(run: Invocation): string[] {
  return readdirSync(run.logRoot).filter((f) => f.startsWith("mw-"));
}

/** The shas the gates of `branch` actually ran against, in order. */
function gateShas(sb: Sandbox, branch: string): string[] {
  const log = join(sb.dir, `gate-${branch}.log`);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")[1]!);
}

function originLog(sb: Sandbox): string[] {
  return execFileSync("git", ["--git-dir", sb.originGit, "log", "--format=%s", "main"], { encoding: "utf8" })
    .trim().split("\n");
}

async function waitUntil(predicate: () => boolean, budgetMs: number, what: string): Promise<void> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const lockDir = (sb: Sandbox) => join(sb.main, ".git", "merge-wave.lock");

/** The branch a clone actually checked out — `""` when it checked out nothing at all. */
function cloneBranch(cwd: string): string {
  return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", env: HOSTILE_GIT_ENV }).trim();
}

/** Run from `cwd` instead of the main checkout — used for the linked-worktree case. */
function invokeFrom(cwd: string, sb: Sandbox, branch: string, env: Record<string, string> = {}): Invocation {
  const saved = sb.main;
  (sb as { main: string }).main = cwd;
  const started = invoke(sb, branch, env);
  (sb as { main: string }).main = saved;
  return started;
}

describe("two concurrent merges in one checkout (#44)", () => {
  test("the second WAITS, and each one's gates run on its own merge commit", async () => {
    const sb = sandbox();
    const release = join(sb.dir, "release-a");

    // A takes the lock and parks inside its first gate until this test lets it go, so the
    // overlap is a fact of the test rather than a hopeful sleep.
    const a = invoke(sb, "wave-a", { GATE_HOLD_UNTIL: release, GATE_HOLD_ON: "typecheck" });
    await waitUntil(() => existsSync(join(lockDir(sb), "owner")), 30_000, "A to take the lock");

    const b = invoke(sb, "wave-b");
    await waitUntil(() => b.stderrSoFar().includes("waiting for another merge"), 30_000, "B to report waiting");
    // B is queued, not merging: main is still exactly where A's merge left it.
    expect(gateShas(sb, "wave-b")).toEqual([]);

    writeFileSync(release, "go\n");
    const [ra, rb] = [await a.done, await b.done];
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);

    const aShas = gateShas(sb, "wave-a");
    const bShas = gateShas(sb, "wave-b");
    expect(aShas).toHaveLength(2);
    expect(bShas).toHaveLength(2);
    // The bug, precisely: every gate of a run must have seen ONE tree, and not the other run's.
    expect(new Set(aShas).size).toBe(1);
    expect(new Set(bShas).size).toBe(1);
    expect(aShas[0]).not.toBe(bShas[0]);
    // And each of those trees is the merge that run pushed.
    expect(ra.stdout).toContain(aShas[0]!.slice(0, 7));
    expect(rb.stdout).toContain(bShas[0]!.slice(0, 7));
    expect(originLog(sb).slice(0, 2)).toEqual(["merge wave-b", "merge wave-a"]);
    expect(existsSync(lockDir(sb))).toBe(false);
  });

  test("a red branch fails ITS OWN merge, and not the one queued beside it", async () => {
    const sb = sandbox();
    const release = join(sb.dir, "release-a");
    const a = invoke(sb, "wave-a", { GATE_HOLD_UNTIL: release, GATE_HOLD_ON: "typecheck" });
    await waitUntil(() => existsSync(join(lockDir(sb), "owner")), 30_000, "A to take the lock");
    const b = invoke(sb, "wave-poison");
    await waitUntil(() => b.stderrSoFar().includes("waiting for another merge"), 30_000, "B to report waiting");
    writeFileSync(release, "go\n");

    const [ra, rb] = [await a.done, await b.done];
    expect(ra.code).toBe(0);                       // pre-fix this was FAIL build=1, on wave-poison's file
    expect(ra.stdout).toContain("pushed");
    expect(rb.code).toBe(3);
    expect(rb.stdout).toContain("NOT pushed");
    expect(originLog(sb)[0]).toBe("merge wave-a");
  });
});

describe("the HEAD assertion stands alone, for anyone who bypasses the lock (#44)", () => {
  test("a HEAD that moved between the gates and the push refuses to push", async () => {
    const sb = sandbox();
    const before = originLog(sb);
    const { code, stdout } = await invoke(sb, "wave-a", { GATE_MOVE_HEAD: "build" }).done;
    expect(code).toBe(5);
    expect(stdout).toContain("HEAD moved during the gates");
    expect(stdout).toContain("NOT pushed");
    expect(originLog(sb)).toEqual(before);
  });

  test("an untouched HEAD pushes, so the assertion is not simply refusing everything", async () => {
    const sb = sandbox();
    const { code, stdout } = await invoke(sb, "wave-a").done;
    expect(code).toBe(0);
    expect(stdout).toContain("pushed");
    expect(originLog(sb)[0]).toBe("merge wave-a");
  });
});

describe("the lock cannot wedge the repo", () => {
  test("a lock whose owner is gone is broken open, and the merge proceeds", async () => {
    const sb = sandbox();
    mkdirSync(lockDir(sb), { recursive: true });
    // A pid that is not running, on this host — the case a killed agent leaves behind.
    writeFileSync(join(lockDir(sb), "owner"), `999999 ${hostname()} ${Math.floor(Date.now() / 1000)}\n`);
    const { code, stdout } = await invoke(sb, "wave-a").done;
    expect(code).toBe(0);
    expect(stdout).toContain("pushed");
    expect(existsSync(lockDir(sb))).toBe(false);
  });

  test("from a linked worktree the lock still resolves — `.git` is a FILE there", async () => {
    const sb = sandbox();
    const wt = join(sb.dir, "wt");
    sb.git("worktree", "add", "-q", wt, "wave-b");
    expect(existsSync(join(wt, ".git"))).toBe(true);       // a file, not a directory
    const { code, stderr } = await invokeFrom(wt, sb, "wave-a", { MW_LOCK_WAIT_S: "1", MW_LOCK_POLL_S: "1" }).done;
    // Against "$R/.git/merge-wave.lock" this would be ENOTDIR on every attempt: queue, then exit 6.
    expect(stderr).not.toContain("waiting for another merge");
    expect(code).not.toBe(6);
    expect(existsSync(join(sb.main, ".git", "merge-wave.lock"))).toBe(false);
  });

  test("an interrupted merge hands the lock back on its way out", async () => {
    const sb = sandbox();
    const release = join(sb.dir, "release-a");
    const a = invoke(sb, "wave-a", { GATE_HOLD_UNTIL: release, GATE_HOLD_ON: "typecheck" });
    await waitUntil(() => existsSync(join(lockDir(sb), "owner")), 30_000, "the lock to be taken");
    a.signal("SIGTERM");
    const { code } = await a.done;
    expect(code).toBe(143);
    expect(existsSync(lockDir(sb))).toBe(false);
    writeFileSync(release, "go\n");   // let the orphaned gate stand-in stop waiting
  });

  test("a LIVE owner is respected, and waiting is bounded rather than forever", async () => {
    const sb = sandbox();
    mkdirSync(lockDir(sb), { recursive: true });
    // This very process: alive, on this host, so no staleness rule may break it.
    writeFileSync(join(lockDir(sb), "owner"), `${process.pid} ${hostname()} ${Math.floor(Date.now() / 1000)}\n`);
    const before = originLog(sb);
    const { code, stdout, stderr } = await invoke(sb, "wave-a", { MW_LOCK_WAIT_S: "1", MW_LOCK_POLL_S: "1" }).done;
    expect(code).toBe(6);
    expect(stdout).toContain("FAIL lock");
    expect(stderr).toContain("waiting for another merge");
    expect(originLog(sb)).toEqual(before);        // nothing merged, nothing pushed
    expect(existsSync(lockDir(sb))).toBe(true);   // and someone else's lock is left alone
  });
});

describe("what gets pushed is what was gated (#44)", () => {
  test("the gated commit is pushed even when the local `main` ref points elsewhere", async () => {
    const sb = sandbox();
    // A local `main` carrying a commit no gate ever saw — e.g. a merge an earlier red gate
    // left behind. `git push origin main` would publish THAT; only `HEAD:main` cannot.
    sb.git("commit", "-q", "--allow-empty", "-m", "never gated, never pushed");
    const stale = sb.git("rev-parse", "HEAD");
    sb.git("checkout", "-q", "--detach", "origin/main");

    const { code, stdout } = await invoke(sb, "wave-a").done;
    expect(code).toBe(0);
    expect(stdout).toContain("pushed");
    const published = originLog(sb);
    expect(published[0]).toBe("merge wave-a");
    expect(published).not.toContain("never gated, never pushed");
    expect(sb.git("rev-parse", "main")).toBe(stale);   // the local ref is left exactly alone
  });

  test("a commit that is not a fast-forward of origin/main refuses to push", async () => {
    const sb = sandbox();
    // Someone else's commit lands on origin/main while this checkout knows nothing of it.
    const clone = join(sb.dir, "other");
    execFileSync("git", ["clone", "-q", "--branch", "main", sb.originGit, clone], { env: HOSTILE_GIT_ENV });
    // Said out loud, because the alternative is the failure five lines down (#49): a clone
    // with no local `main` does not complain, it just pushes nothing under that name.
    expect(cloneBranch(clone)).toBe("main");
    for (const cfg of [["user.email", "o@example.com"], ["user.name", "Other"]]) {
      execFileSync("git", ["config", cfg[0]!, cfg[1]!], { cwd: clone });
    }
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "someone else's work"], { cwd: clone });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: clone });
    sb.git("fetch", "-q", "origin");

    const { code, stdout } = await invoke(sb, "wave-a").done;
    expect(code).toBe(7);
    expect(stdout).toContain("not a fast-forward");
    expect(originLog(sb)[0]).toBe("someone else's work");   // untouched
  });
});

describe("the dirty-tree guard and the pack artifact (#45)", () => {
  test("a stray `tldr-experts-<version>.tgz` is ignored by this repo's own .gitignore", () => {
    const ignored = execFileSync("git", ["check-ignore", "-v", "--", "tldr-experts-0.3.1.tgz"],
      { cwd: REPO, encoding: "utf8" });
    expect(ignored).toContain(".gitignore");
    expect(ignored).toContain("*.tgz");
  });

  test("so porcelain stays empty with one in the tree, and the merge is not refused", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.main, "tldr-experts-0.3.1.tgz"), "not really a tarball\n");
    expect(sb.git("status", "--porcelain")).toBe("");
    const { code, stdout } = await invoke(sb, "wave-a").done;
    expect(stdout).not.toContain("FAIL dirty tree");
    expect(code).toBe(0);
  });

  test("a green run leaves no log directory behind; a red one keeps the one it names", async () => {
    const green = invoke(sandbox(), "wave-a");
    expect((await green.done).code).toBe(0);
    // Its OWN root, so this says "this run cleaned up after itself" and nothing else (#95, #97).
    expect(waveLogs(green)).toEqual([]);

    const red = invoke(sandbox(), "wave-poison");
    const result = await red.done;
    expect(result.code).toBe(3);
    const named = /logs: (\S+);/.exec(result.stdout)?.[1];
    expect(named).toBeTruthy();
    expect(existsSync(named!)).toBe(true);            // kept, because someone has to read it
    // And the scoped scan still SEES its own: hermetic is not blind.
    expect(waveLogs(red)).toEqual([basename(named!)]);
    // It sits inside the sandbox, so afterEach takes it — no wave leaks a log dir into the
    // machine's tmpdir any more, which is the other half of #95.
    expect(named!.startsWith(`${red.logRoot}/`)).toBe(true);
  });

  test("the guard keeps its teeth: a genuinely untracked file still refuses", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.main, "half-finished.ts"), "export const x = 1;\n");
    expect(sb.git("status", "--porcelain")).toContain("half-finished.ts");
    const { code, stdout } = await invoke(sb, "wave-a").done;
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL dirty tree");
  });
});

/**
 * #95 and #97 — two waves, one machine, one $TMPDIR.
 *
 * `merge-wave.sh` writes its logs to `${TMPDIR:-/tmp}/mw-$$`, so under the machine's
 * shared $TMPDIR every wave on the box lands in ONE directory: this file's other tests,
 * every sibling agent's wave, and the REAL merge wave whose `bun test` is running this
 * very file. A directory-listing diff over that root is a global-namespace diff, and it
 * has now failed two waves on trees whose diff never touched this script:
 *
 *   #95 — a sibling's DELIBERATELY KEPT red log (`mw-35458`, carrying another run's
 *         `poison.txt` merge) counted as the green run's residue. Merge-wave keeps a red
 *         run's logs on purpose: "every FAIL above names the directory it kept".
 *   #97 — a CONCURRENT invocation's LIVE `mw-15412` counted as the green run's residue,
 *         12 minutes into #90's wave, leaving `main` at an unpushed merge commit.
 *
 * Same defect both times: the assertion is about ONE run's cleanup and it measured the
 * whole machine. These two tests plant the foreign directory rather than racing a second
 * live wave for it — a test that needs the box to be busy to prove its point is the
 * disease, not the treatment.
 */
describe("the log-directory assertion is about THIS run, not the machine (#95, #97)", () => {
  /**
   * A foreign `mw-<pid>` in the machine's SHARED tmpdir — the real shape, real contents,
   * removed again by the caller's `finally`.
   *
   * Overwriting an existing one costs nothing: a directory already at `mw-<this process's
   * pid>` was written by something that held this pid, and this process holds it now, so
   * that wave is dead and its log is stale.
   */
  function plantForeignWaveLog(pid: number): string {
    const dir = join(tmpdir(), `mw-${pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "merge.log"), "Merge made by the 'ort' strategy.\n poison.txt | 1 +\n");
    writeFileSync(join(dir, "tc.log"), "$ bash gate.sh typecheck\ngate saw poison.txt\n");
    return dir;
  }

  test("a sibling wave's deliberately KEPT red log is not this run's residue (#95)", async () => {
    // A wave that has exited and left its log behind ON PURPOSE, for someone to read.
    const foreign = plantForeignWaveLog(999_999);
    try {
      const green = invoke(sandbox(), "wave-a");
      expect((await green.done).code).toBe(0);
      expect(waveLogs(green)).toEqual([]);      // pre-fix: ["mw-999999"] — measured
      expect(existsSync(foreign)).toBe(true);   // and it was never this run's to delete
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("a CONCURRENT wave's live log directory is not this run's residue either (#97)", async () => {
    // This process's own pid: alive, on this host, for the whole of the run below — a
    // wave still inside its gates, whose log directory is not a leftover of anything.
    const foreign = plantForeignWaveLog(process.pid);
    try {
      const green = invoke(sandbox(), "wave-a");
      expect((await green.done).code).toBe(0);
      expect(waveLogs(green)).toEqual([]);      // pre-fix: ["mw-36550"], this process — measured
      expect(existsSync(foreign)).toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});

describe("the sandbox does not inherit the host's default branch (#49)", () => {
  /**
   * CI run 33459567355 (sha 064279e) failed here — `git push -q origin main` →
   * `src refspec main does not match any` — while macOS stayed green, because macOS
   * happened to default to `main` and the runner did not. The treatment landed in
   * f1ffe56 (`-b main` on both inits, `--branch main` on the clone), but nothing
   * exercised it: on a main-defaulting host, removing the treatment changes nothing.
   *
   * These two tests are the exercise. They build the sandbox's repo shapes by hand under
   * an explicitly hostile default, so the mechanism is pinned on every machine: untreated
   * is the exact CI error, treated is a clone on `main`. Measured 2026-08-31 on git
   * 2.50.1 — untreated reproduces the failure verbatim.
   */
  const hostile = (extra: Record<string, string> = {}) => ({ ...HOSTILE_GIT_ENV, ...extra });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: hostile() }).trim();

  /** A bare origin carrying `refs/heads/main`, built with or without the `-b main` treatment. */
  function origin(dir: string, treated: boolean): string {
    const bare = join(dir, "origin.git");
    const seed = join(dir, "seed");
    execFileSync("git", ["init", "-q", "--bare", ...(treated ? ["-b", "main"] : []), bare], { env: hostile() });
    execFileSync("git", ["init", "-q", "-b", "main", seed], { env: hostile() });
    for (const cfg of [["user.email", "s@example.com"], ["user.name", "Seed"], ["commit.gpgsign", "false"]]) {
      git(seed, "config", cfg[0]!, cfg[1]!);
    }
    writeFileSync(join(seed, "a.txt"), "seed\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "remote", "add", "origin", bare);
    git(seed, "push", "-q", "origin", "main");
    return bare;
  }

  test("untreated, a clone checks out nothing and the push dies exactly as CI reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-defaultbranch-"));
    try {
      const bare = origin(dir, false);
      expect(git(dir, "--git-dir", bare, "symbolic-ref", "HEAD")).toBe("refs/heads/trunk");

      const clone = join(dir, "other");
      execFileSync("git", ["clone", "-q", bare, clone], { env: hostile(), stdio: "ignore" });
      // The whole bug: the clone followed the origin's HEAD onto an UNBORN `trunk`, so it
      // has no commits, no local `main`, and not one word of complaint about either.
      expect(cloneBranch(clone)).toBe("trunk");
      expect(git(clone, "branch", "--list")).toBe("");

      let stderr = "";
      try {
        execFileSync("git", ["push", "-q", "origin", "main"], { cwd: clone, env: hostile(), stdio: "pipe" });
        throw new Error("expected the push to fail");
      } catch (err) {
        stderr = String((err as { stderr?: Buffer }).stderr ?? "");
      }
      expect(stderr).toContain("src refspec main does not match any");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("treated, the clone is on `main` and the push lands", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-defaultbranch-"));
    try {
      const bare = origin(dir, true);
      expect(git(dir, "--git-dir", bare, "symbolic-ref", "HEAD")).toBe("refs/heads/main");

      const clone = join(dir, "other");
      execFileSync("git", ["clone", "-q", "--branch", "main", bare, clone], { env: hostile() });
      expect(cloneBranch(clone)).toBe("main");

      for (const cfg of [["user.email", "o@example.com"], ["user.name", "Other"], ["commit.gpgsign", "false"]]) {
        git(clone, "config", cfg[0]!, cfg[1]!);
      }
      git(clone, "commit", "-q", "--allow-empty", "-m", "someone else's work");
      git(clone, "push", "-q", "origin", "main");
      expect(git(dir, "--git-dir", bare, "log", "--format=%s", "-1", "main")).toBe("someone else's work");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the sandbox itself is built under the hostile default, so the treatment is live", () => {
    const sb = sandbox();
    expect(execFileSync("git", ["config", "--get", "init.defaultBranch"],
      { cwd: sb.main, encoding: "utf8", env: HOSTILE_GIT_ENV }).trim()).toBe("trunk");
    expect(cloneBranch(sb.main)).toBe("main");
    expect(execFileSync("git", ["--git-dir", sb.originGit, "symbolic-ref", "HEAD"],
      { encoding: "utf8", env: HOSTILE_GIT_ENV }).trim()).toBe("refs/heads/main");
  });
});

/**
 * #76 — a conflicted merge must hand the checkout back the way it found it.
 *
 * Measured 2026-09-01 on the pre-fix script: `exit 2` fired the EXIT trap, which
 * released the lock and left the conflicted index in place. The next queued
 * invocation then hit the dirty-tree guard and exited 1, `FAIL dirty tree`, having
 * merged nothing — and so did every one after it, until a human ran `git merge
 * --abort` by hand. Under the concurrent multi-cluster pattern this repo is driven
 * with, one conflict wedged every other cluster; two agents hit it live that night.
 *
 * `mergeNoFf` (src/core/build/git.ts:314-326) already does the right thing one
 * directory over: collect the conflicted paths for the message, THEN abort. This is
 * the same hazard the lock was written for — state from one invocation leaking into
 * the next — so it gets the same standard.
 */
describe("a conflicted merge does not wedge the checkout (#76)", () => {
  /**
   * `main` and `wave-conflict` rewrite the same line of a file BOTH already had, so
   * the merge stops with `UU` — the state the live wedge was observed in, rather than
   * the `AA` two independent additions would give.
   */
  function conflicting(sb: Sandbox): void {
    writeFileSync(join(sb.main, "contested.txt"), "the version they both started from\n");
    sb.git("add", "-A");
    sb.git("commit", "-q", "-m", "a file both sides will touch");
    sb.git("checkout", "-q", "-b", "wave-conflict", "main");
    writeFileSync(join(sb.main, "contested.txt"), "the branch's version\n");
    sb.git("add", "-A");
    sb.git("commit", "-q", "-m", "wave-conflict work");
    sb.git("checkout", "-q", "main");
    writeFileSync(join(sb.main, "contested.txt"), "main's version\n");
    sb.git("add", "-A");
    sb.git("commit", "-q", "-m", "main touches the same file");
  }

  test("the conflicting paths are still named, and the exit code is still 2", async () => {
    const sb = sandbox();
    conflicting(sb);
    const { code, stdout } = await invoke(sb, "wave-conflict").done;
    expect(code).toBe(2);
    expect(stdout).toContain("FAIL merge conflict");
    // Aborting must not cost the agent the one thing it needs to act on.
    expect(stdout).toContain("contested.txt");
  });

  test("and the tree it hands back is CLEAN, with no merge left half-done", async () => {
    const sb = sandbox();
    conflicting(sb);
    const before = sb.git("rev-parse", "HEAD");
    expect((await invoke(sb, "wave-conflict").done).code).toBe(2);
    // The bug, precisely: without the abort this reads `UU contested.txt`\n    // — measured on the pre-fix script, 2026-09-01.
    expect(sb.git("status", "--porcelain")).toBe("");
    expect(existsSync(join(sb.main, ".git", "MERGE_HEAD"))).toBe(false);
    expect(sb.git("rev-parse", "HEAD")).toBe(before);
    // The lock goes back too — that half was never broken, and must stay that way.
    expect(existsSync(lockDir(sb))).toBe(false);
  });

  test("so the next queued sibling merges, instead of being refused for dirtiness", async () => {
    const sb = sandbox();
    conflicting(sb);
    expect((await invoke(sb, "wave-conflict").done).code).toBe(2);
    // This is the invocation that returned 1 `FAIL dirty tree` for cluster L.
    const next = await invoke(sb, "wave-a").done;
    expect(next.stdout).not.toContain("FAIL dirty tree");
    expect(next.code).toBe(0);
    expect(originLog(sb)[0]).toBe("merge wave-a");
  });
});

/**
 * The message the guard prints when it DOES refuse (#76, the second half).
 *
 * `FAIL dirty tree` names the wrong culprit: it reads as "you left junk in your own
 * checkout" when, inside the lock, the likeliest cause is another run's residue in
 * the SHARED one. Naming the paths is the difference between a dead end and a fix.
 */
describe("the dirty-tree refusal says what is dirty (#76)", () => {
  test("the refusal names the offending path", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.main, "half-finished.ts"), "export const x = 1;\n");
    const { code, stdout } = await invoke(sb, "wave-a").done;
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL dirty tree");
    expect(stdout).toContain("half-finished.ts");
  });
});

/**
 * The lock serialises merge-wave INVOCATIONS. It has never stopped raw git in the shared
 * checkout (#89).
 *
 * Measured 2026-09-02: while agent A's gates were running, agent B typed
 * `git reset --hard origin/main` into the same shared checkout. The reflog says
 * `reset: moving to origin/main`; A's merge commit stopped being reachable from `main`
 * mid-gate. The #44 gated-HEAD assertion fired and refused to push — the aftermath was
 * caught, the damage was not prevented.
 *
 * So the lock now advertises itself two ways: a marker file at the shared checkout's root
 * that a human or an agent can SEE, and a `reference-transaction` hook that git consults
 * before it will move any ref. What that hook can and cannot save is measured below, and
 * the boundary is stated in `scripts/merge-guard.sh` rather than implied.
 */
const MERGE_GUARD = join(REPO, "scripts", "merge-guard.sh");
const markerPath = (sb: Sandbox) => join(sb.main, ".MERGE-WAVE-IN-PROGRESS");

/** Run git and hand back the exit code instead of throwing on it. */
function gitTry(cwd: string, env: Record<string, string>, ...args: string[]): { code: number; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...HOSTILE_GIT_ENV, ...env } });
  return { code: r.status ?? -1, err: r.stderr ?? "" };
}

/** Install the guard into the sandbox's own git dir, the way merge-wave does at startup. */
function installGuard(cwd: string): { code: number; err: string } {
  const r = spawnSync("bash", [MERGE_GUARD, "--install"], { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, err: r.stderr ?? "" };
}

/** A lock held by SOMEONE ELSE: a live pid on this host, and a token this test will not lend out. */
function holdLock(sb: Sandbox, pid: number = process.pid): string {
  const lock = lockDir(sb);
  mkdirSync(lock, { recursive: true });
  const token = "token-of-another-invocation";
  writeFileSync(join(lock, "token"), `${token}\n`);
  writeFileSync(join(lock, "owner"), `${pid} ${hostname()} ${Math.floor(Date.now() / 1000)}\n`);
  writeFileSync(markerPath(sb), "MERGE WAVE IN PROGRESS — planted by the test\n");
  return token;
}

describe("a held lock is visible in the tree it is guarding (#89)", () => {
  test("the marker names the wave while the lock is held, and leaves with it", async () => {
    const sb = sandbox();
    const release = join(sb.dir, "release-a");
    const a = invoke(sb, "wave-a", { GATE_HOLD_UNTIL: release, GATE_HOLD_ON: "typecheck" });
    await waitUntil(() => existsSync(join(lockDir(sb), "owner")), 30_000, "the lock to be taken");

    // Read the instant `owner` appears, and demand a COMPLETE marker. That is the ordering
    // under test: the marker is moved into place BEFORE `owner` is published, so nobody who
    // can see the lock as taken can catch the file half-written. Read as a `>` redirection
    // mid-flight, this assertion failed on the last line under full-suite load.
    expect(existsSync(markerPath(sb))).toBe(true);
    const marker = readFileSync(markerPath(sb), "utf8");
    expect(marker).toContain("MERGE WAVE IN PROGRESS");
    expect(marker).toContain("wave-a");                       // which wave, not just "a wave"
    expect(marker).toContain("scripts/merge-wave.sh");        // and what to do instead
    expect(marker).toContain("git reset --hard");             // the last line, so: all of it
    // It must not itself trip the dirty-tree guard it sits beside.
    expect(sb.git("status", "--porcelain")).toBe("");

    writeFileSync(release, "go\n");
    const ra = await a.done;
    expect(ra.code).toBe(0);
    expect(existsSync(markerPath(sb))).toBe(false);
  });

  test("an interrupted merge takes its marker with it, not only its lock", async () => {
    const sb = sandbox();
    const release = join(sb.dir, "release-a");
    const a = invoke(sb, "wave-a", { GATE_HOLD_UNTIL: release, GATE_HOLD_ON: "typecheck" });
    await waitUntil(() => existsSync(markerPath(sb)), 30_000, "the marker to appear");
    a.signal("SIGTERM");
    const { code } = await a.done;
    expect(code).toBe(143);
    expect(existsSync(markerPath(sb))).toBe(false);
    expect(existsSync(lockDir(sb))).toBe(false);
    writeFileSync(release, "go\n");
  });

  test("the repo's own .gitignore covers the marker, so no wave can dirty its own tree", () => {
    const ignored = execFileSync("git", ["check-ignore", "-v", "--", ".MERGE-WAVE-IN-PROGRESS"],
      { cwd: REPO, encoding: "utf8" });
    expect(ignored).toContain(".gitignore");
  });
});

describe("the guard refuses raw git in the SHARED checkout while a wave holds the lock (#89)", () => {
  test("with no wave in progress the guard is invisible", () => {
    const sb = sandbox();
    expect(installGuard(sb.main).code).toBe(0);
    const { code } = gitTry(sb.main, {}, "commit", "-q", "--allow-empty", "-m", "ordinary work");
    expect(code).toBe(0);
  });

  test("`git reset --hard` is refused, and the ref does NOT move — #89's exact command", () => {
    const sb = sandbox();
    expect(installGuard(sb.main).code).toBe(0);
    sb.git("commit", "-q", "--allow-empty", "-m", "the merge commit a sibling destroyed");
    const kept = sb.git("rev-parse", "HEAD");
    holdLock(sb);

    const { code, err } = gitTry(sb.main, {}, "reset", "--hard", "HEAD~1");
    expect(code).not.toBe(0);
    expect(err).toContain("MERGE-WAVE-IN-PROGRESS");        // points at the marker it can read
    expect(err).toContain("merge-wave.sh");                 // and at the way in
    expect(sb.git("rev-parse", "HEAD")).toBe(kept);         // the commit is still reachable
  });

  test("`git checkout -B main` and `git merge` are refused the same way", () => {
    const sb = sandbox();
    expect(installGuard(sb.main).code).toBe(0);
    const kept = sb.git("rev-parse", "HEAD");
    holdLock(sb);

    expect(gitTry(sb.main, {}, "checkout", "-B", "main", "wave-a").code).not.toBe(0);
    expect(gitTry(sb.main, {}, "merge", "--no-ff", "wave-a", "-m", "not yours to merge").code).not.toBe(0);
    expect(sb.git("rev-parse", "HEAD")).toBe(kept);
  });

  test("the lock HOLDER's own git is let through — otherwise merge-wave would deadlock itself", () => {
    const sb = sandbox();
    expect(installGuard(sb.main).code).toBe(0);
    const token = holdLock(sb);
    const { code } = gitTry(sb.main, { MW_LOCK_TOKEN: token }, "commit", "-q", "--allow-empty", "-m", "the holder's own merge");
    expect(code).toBe(0);
  });

  test("a lock whose owner is dead does not wedge the checkout", () => {
    const sb = sandbox();
    expect(installGuard(sb.main).code).toBe(0);
    holdLock(sb, 999999);                                   // a pid that is not running, on this host
    const { code } = gitTry(sb.main, {}, "commit", "-q", "--allow-empty", "-m", "after the owner died");
    expect(code).toBe(0);
  });

  test("an agent's OWN worktree keeps working; only `main` is off limits from there", () => {
    const sb = sandbox();
    expect(installGuard(sb.main).code).toBe(0);
    const wt = join(sb.dir, "agent-wt");
    sb.git("worktree", "add", "-q", wt, "wave-b");
    const mainSha = sb.git("rev-parse", "main");
    holdLock(sb);

    // The whole point of the convention: your own branch, in your own worktree, is yours.
    expect(gitTry(wt, {}, "commit", "-q", "--allow-empty", "-m", "my own work").code).toBe(0);
    // `main` is shared no matter which worktree the command is typed in.
    expect(gitTry(wt, {}, "update-ref", "refs/heads/main", "HEAD").code).not.toBe(0);
    expect(sb.git("rev-parse", "main")).toBe(mainSha);
  });

  /**
   * The state names git passes are NOT portable, and assuming they were shipped a red CI.
   *
   * macOS git 2.50.1 calls the abortable state `prepared`. The Linux runner's git calls it
   * something else — `fatal: in 'preparing' phase, update aborted by the reference-transaction
   * hook`, CI run 33589554234 on e0e76a2. The guard's `*)` arm printed a usage error and
   * exited 2, so on that machine EVERY ref update in every sandbox was refused and the whole
   * of this file went red at once, while macOS stayed green — #49's failure shape exactly.
   *
   * So nothing here hardcodes a state name. The test ASKS this git which states it passes,
   * then holds the guard to both halves of the contract for each one.
   */
  function statesThisGitPasses(sb: Sandbox): string[] {
    const hook = join(sb.main, ".git", "hooks", "reference-transaction");
    const seen = join(sb.dir, "states.log");
    mkdirSync(join(sb.main, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> ${seen}\ncat > /dev/null\nexit 0\n`);
    chmodSync(hook, 0o755);
    sb.git("commit", "-q", "--allow-empty", "-m", "a probe, to ask git what it calls its states");
    rmSync(hook, { force: true });
    return [...new Set(readFileSync(seen, "utf8").trim().split("\n").filter(Boolean))];
  }

  test("whatever THIS git calls its transaction states, the guard handles every one", () => {
    const sb = sandbox();
    const states = statesThisGitPasses(sb);
    expect(states.length).toBeGreaterThan(0);

    // Both the names this git uses AND the names it does not: a machine only ever exercises
    // its own, so the portability property is only testable against the others. `preparing`
    // is the one that shipped red; the third is a name no git has, standing in for the next
    // rename. On macOS all three fail against the `*)` arm this replaced.
    const probe = [...new Set([...states, "prepared", "preparing", "some-future-state"])];

    // With no wave in progress, not one of them may refuse — and none may hit the usage error,
    // which is the arm that bricked CI.
    for (const state of probe) {
      const clear = spawnSync("bash", [MERGE_GUARD, state], { cwd: sb.main, encoding: "utf8", input: "" });
      expect(clear.stderr).not.toContain("usage:");
      expect(clear.status, `state \`${state}\` refused with no wave running: ${clear.stderr}`).toBe(0);
    }

    // With one in progress, at least one of them must refuse — otherwise the guard is decoration
    // on this machine, which is the OTHER way a portable state name can be got wrong.
    holdLock(sb);
    const refuses = (state: string) =>
      spawnSync("bash", [MERGE_GUARD, state], { cwd: sb.main, encoding: "utf8", input: "" }).status !== 0;
    expect(states.filter(refuses).length).toBeGreaterThan(0);
    // And the name CI actually uses refuses here even on a machine that never passes it.
    expect(refuses("preparing")).toBe(true);
  });

  test("`--check` answers the same question without a ref transaction to hang it on", () => {
    const sb = sandbox();
    const clear = spawnSync("bash", [MERGE_GUARD, "--check"], { cwd: sb.main, encoding: "utf8" });
    expect(clear.status).toBe(0);
    holdLock(sb);
    const held = spawnSync("bash", [MERGE_GUARD, "--check"], { cwd: sb.main, encoding: "utf8" });
    expect(held.status).toBe(1);
    expect(held.stderr).toContain("MERGE-WAVE-IN-PROGRESS");
  });

  test("installing over a foreign hook refuses rather than clobbering it", () => {
    const sb = sandbox();
    const hook = join(sb.main, ".git", "hooks", "reference-transaction");
    mkdirSync(join(sb.main, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, "#!/usr/bin/env bash\nexit 0\n");
    const { code, err } = installGuard(sb.main);
    expect(code).not.toBe(0);
    expect(err).toContain("already exists");
    expect(readFileSync(hook, "utf8")).not.toContain("merge guard");
  });
});

describe("the convention the guard only approximates is written down (#89)", () => {
  /**
   * The header block is the only usage text a maintainer reads before running this script,
   * and it drifted from the code the day it was written: it advertised `--install [--force]`
   * when no `--force` existed. "A comment that no longer describes the code beside it is a
   * defect in its own right" — so the two are pinned to each other in both directions.
   */
  test("every flag the header advertises is a flag the case statement accepts, and vice versa", () => {
    const src = readFileSync(MERGE_GUARD, "utf8");
    const block = /# Three ways in:\n((?:#.*\n)+)/.exec(src)?.[1] ?? "";
    expect(block).not.toBe("");
    const documented = [...block.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]).sort();
    const accepted = [...src.matchAll(/^ {2}(--[a-z][a-z-]*)\)/gm)].map((m) => m[1]!).sort();
    expect(documented).toEqual(accepted);
    expect(accepted).toEqual(["--check", "--install"]);   // and the pin itself can fail
  });

  const rule = (file: string) => readFileSync(join(REPO, file), "utf8");

  test("CONTRIBUTING and CLAUDE.md both state the rule in the same words", () => {
    for (const file of ["CONTRIBUTING.md", "CLAUDE.md"]) {
      const text = rule(file);
      expect(text).toContain("ONLY through `scripts/merge-wave.sh`");
      expect(text).toContain("own worktree");
      expect(text).toContain("git reset --hard");
      expect(text).toContain("git checkout -B main");
    }
  });
});
