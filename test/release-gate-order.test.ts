/**
 * `scripts/release.sh` + `scripts/release-check.sh` — the gate runs before anything leaves
 * the machine (#100).
 *
 * The bug, read off the script rather than run (nobody reproduces this against the real
 * origin): the release commit was pushed at line 18 and the gate ran at line 19. Any red
 * item — tests, typecheck, build, the Bun seam grep, "already on npm", "tag exists" — then
 * left `origin/main` carrying a `release: X.Y.Z` commit with a DATED CHANGELOG heading and
 * a DATED README row, and no tag: exactly the half-released state checklist item 4 exists
 * to prevent, recoverable only by a revert commit or a hand-repaired CHANGELOG.
 *
 * These tests run the REAL two scripts against a REAL repository — a bare "origin", a
 * working clone, a real commit, a real push, a real tag. Only `bun` and `npm` are
 * stand-ins, for the two reasons the sandbox cannot use the real ones: `bun test` on a
 * five-file repo proves nothing about this repo's suite, and `npm view` would reach the
 * live registry from a unit test. The stand-in `bun` records, for every gate it runs, the
 * sha of HEAD and of `origin/main` at that moment — and that pair is the whole bug. On the
 * pre-fix script they are EQUAL (the push already happened); after it they differ by the
 * release commit, which is the ordering, measured rather than asserted.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Real git, real clones, real pushes — #43's budget.
setDefaultTimeout(spawnTestTimeout(120_000));

const REPO = join(import.meta.dir, "..");
const V = "0.9.9";

/**
 * Stand-in `bun`. Records `<args> HEAD=<sha> ORIGIN=<sha>` for every gate invocation, so
 * the test can read back WHEN in the sequence each gate ran, and goes red on demand:
 * `GATE_RED=test` is release-check item 5's "tests red", the most ordinary way to reach
 * this failure.
 */
const BUN_STUB = `#!/usr/bin/env bash
echo "$* HEAD=$(git rev-parse HEAD) ORIGIN=$(git rev-parse origin/main 2>/dev/null || echo none)" >> "$GATE_LOG"
[ "$1" = "\${GATE_RED:-__never__}" ] && exit 1
exit 0
`;

/**
 * Stand-in `npm`. release-check.sh's only npm call is `npm view tldr-experts@$V version`,
 * whose non-zero exit means "not on npm yet". A unit test must never ask the real registry,
 * so this always answers "not published" — and its existence on PATH is proven by the gate
 * log, which is empty if the shim directory was not picked up.
 */
const NPM_STUB = `#!/usr/bin/env bash
exit 1
`;

/**
 * Pinned, and pinned HOSTILE: a runner whose `init.defaultBranch` is not `main` is the
 * difference between green on macOS and red on ubuntu-latest, and everything here is named
 * `main` on purpose (the lesson merge-wave.test.ts learned in CI run 33459567355).
 */
const HOSTILE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "init.defaultBranch",
  GIT_CONFIG_VALUE_0: "trunk",
};

type Sandbox = { dir: string; main: string; originGit: string; bin: string; gateLog: string };
type Result = { code: number; stdout: string; stderr: string };

let open: Sandbox[] = [];

afterEach(() => {
  for (const sb of open) rmSync(sb.dir, { recursive: true, force: true });
  open = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: HOSTILE_GIT_ENV }).trim();
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-release-"));
  const main = join(dir, "main");
  const originGit = join(dir, "origin.git");
  // Outside the working tree on purpose: release-check item 4 asserts a CLEAN tree, and a
  // shim directory or a log file inside it would make every run of this file red for a
  // reason that has nothing to do with the release path.
  const bin = join(dir, "bin");
  const gateLog = join(dir, "gate.log");

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originGit], { env: HOSTILE_GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", main], { env: HOSTILE_GIT_ENV });
  for (const [k, v] of [["user.email", "fixture@example.com"], ["user.name", "Fixture"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) {
    git(main, "config", k!, v!);
  }

  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [["bun", BUN_STUB], ["npm", NPM_STUB]]) {
    writeFileSync(join(bin, name!), body!);
    chmodSync(join(bin, name!), 0o755);
  }

  // The scripts under test, byte for byte. release.sh calls `scripts/release-check.sh` by a
  // path relative to the repo toplevel, so the pair has to live in the sandbox.
  mkdirSync(join(main, "scripts"), { recursive: true });
  for (const s of ["release.sh", "release-check.sh"]) {
    copyFileSync(join(REPO, "scripts", s), join(main, "scripts", s));
    chmodSync(join(main, "scripts", s), 0o755);
  }

  writeFileSync(join(main, "package.json"), `${JSON.stringify({ name: "tldr-experts", version: "0.0.1", private: true, type: "module" }, null, 2)}\n`);
  mkdirSync(join(main, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(main, "plugin", ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "tldr-experts", version: "0.0.1" }, null, 2)}\n`);
  writeFileSync(join(main, "CHANGELOG.md"), `# Changelog\n\n## ${V} — unreleased\n\n- the sandbox release\n`);
  writeFileSync(join(main, "README.md"), `# sandbox\n\n| version | date | status | notes |\n| --- | --- | --- | --- |\n| ${V} | unreleased | \`alpha\` | the sandbox release |\n`);
  // release-check item 5 greps `src` for the Bun seam; give it a real directory to grep.
  mkdirSync(join(main, "src", "core", "runtime"), { recursive: true });
  writeFileSync(join(main, "src", "core", "runtime", "io.ts"), "export const read = () => Bun.file;\n");

  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "sandbox base");
  git(main, "remote", "add", "origin", originGit);
  git(main, "push", "-q", "origin", "main");
  git(main, "fetch", "-q", "origin");

  const sb: Sandbox = { dir, main, originGit, bin, gateLog };
  open.push(sb);
  return sb;
}

function run(sb: Sandbox, script: string, args: string[], env: Record<string, string> = {}): Result {
  const r = spawnSync("bash", [join(sb.main, "scripts", script), ...args], {
    cwd: sb.main,
    encoding: "utf8",
    env: { ...HOSTILE_GIT_ENV, PATH: `${sb.bin}:${process.env.PATH ?? ""}`, GATE_LOG: sb.gateLog, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** What the bare origin actually holds — the only thing the invariant is about. */
const originSha = (sb: Sandbox) => execFileSync("git", ["--git-dir", sb.originGit, "rev-parse", "main"], { encoding: "utf8" }).trim();
const originLog = (sb: Sandbox) => execFileSync("git", ["--git-dir", sb.originGit, "log", "--format=%s", "main"], { encoding: "utf8" }).trim().split("\n");
const originTags = (sb: Sandbox) => execFileSync("git", ["--git-dir", sb.originGit, "tag", "--list"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

/** `[args, HEAD, origin/main]` for each gate the stand-in `bun` ran, in order. */
function gateRuns(sb: Sandbox): { what: string; head: string; origin: string }[] {
  let raw = "";
  try { raw = readFileSync(sb.gateLog, "utf8"); } catch { return []; }
  return raw.trim().split("\n").filter(Boolean).map((l) => {
    const m = /^(.*) HEAD=(\S+) ORIGIN=(\S+)$/.exec(l)!;
    return { what: m[1]!, head: m[2]!, origin: m[3]! };
  });
}

/** The state release.sh is in the moment it calls the gate: the release commit, unpushed. */
function makeReleaseCommit(sb: Sandbox, version = V): void {
  const date = "2026-09-02";
  for (const [f, o] of [["package.json", {}], ["plugin/.claude-plugin/plugin.json", {}]] as const) {
    const d = JSON.parse(readFileSync(join(sb.main, f), "utf8"));
    writeFileSync(join(sb.main, f), `${JSON.stringify({ ...d, ...o, version }, null, 2)}\n`);
  }
  writeFileSync(join(sb.main, "CHANGELOG.md"), `# Changelog\n\n## ${version} — ${date}\n\n- the sandbox release\n`);
  writeFileSync(join(sb.main, "README.md"), `# sandbox\n\n| version | date | status | notes |\n| --- | --- | --- | --- |\n| ${version} | ${date} | \`beta\` | the sandbox release |\n`);
  git(sb.main, "add", "-A");
  git(sb.main, "commit", "-q", "-m", `release: ${version}`);
}

describe("a red gate leaves origin untouched (#100)", () => {
  test("tests red: no release commit on origin/main, no tag, nothing half-released", () => {
    const sb = sandbox();
    const before = originSha(sb);

    const r = run(sb, "release.sh", [V, "--tag", "beta"], { GATE_RED: "test" });

    expect(r.code).not.toBe(0);
    // The invariant, stated three ways because each is a different way to be half-released.
    expect(originSha(sb)).toBe(before);
    expect(originLog(sb)).not.toContain(`release: ${V}`);
    expect(originTags(sb)).toEqual([]);
  });

  test("the gate ran against the release commit while origin/main was still behind it", () => {
    const sb = sandbox();

    const r = run(sb, "release.sh", [V, "--tag", "beta"]);
    expect(r.code).toBe(0);

    const runs = gateRuns(sb);
    // Empty means the PATH shim was not picked up and the real toolchain ran — the
    // assertions below would then be vacuous.
    expect(runs.length).toBeGreaterThan(0);
    for (const g of runs) {
      expect(g.head).not.toBe(g.origin);           // the push had not happened yet
      expect(g.head).toBe(git(sb.main, "rev-parse", "HEAD"));  // and it gated the release commit
    }
  });

  test("a red gate is loud about the local commit it leaves behind", () => {
    const sb = sandbox();
    const r = run(sb, "release.sh", [V, "--tag", "beta"], { GATE_RED: "test" });
    expect(`${r.stdout}${r.stderr}`).toMatch(/NOTHING was pushed/);
  });
});

describe("the green path ends exactly where it ended before", () => {
  test("commit on main, annotated tag v<version> on it, both pushed", () => {
    const sb = sandbox();

    const r = run(sb, "release.sh", [V, "--tag", "beta"]);
    expect(r.code).toBe(0);

    expect(originLog(sb)[0]).toBe(`release: ${V}`);
    expect(originTags(sb)).toEqual([`v${V}`]);
    // Annotated, not lightweight — publish.yml reads the tag.
    expect(execFileSync("git", ["--git-dir", sb.originGit, "cat-file", "-t", `v${V}`], { encoding: "utf8" }).trim()).toBe("tag");
    expect(execFileSync("git", ["--git-dir", sb.originGit, "rev-list", "-n1", `v${V}`], { encoding: "utf8" }).trim()).toBe(originSha(sb));
  });

  test("the mechanical edits are the same edits", () => {
    const sb = sandbox();
    expect(run(sb, "release.sh", [V, "--tag", "beta"]).code).toBe(0);

    expect(readFileSync(join(sb.main, "CHANGELOG.md"), "utf8")).toMatch(new RegExp(`^## ${V} — \\d{4}-\\d{2}-\\d{2}$`, "m"));
    expect(readFileSync(join(sb.main, "README.md"), "utf8")).toMatch(new RegExp(`^\\| ${V} \\| \\d{4}-\\d{2}-\\d{2} \\| \`beta\` \\|`, "m"));
    expect(JSON.parse(readFileSync(join(sb.main, "package.json"), "utf8")).version).toBe(V);
    expect(JSON.parse(readFileSync(join(sb.main, "plugin/.claude-plugin/plugin.json"), "utf8")).version).toBe(V);
  });
});

describe("--pre-push re-states the sync check, it does not drop it", () => {
  test("green when the release commit sits directly on top of origin/main", () => {
    const sb = sandbox();
    makeReleaseCommit(sb);
    const r = run(sb, "release-check.sh", ["--pre-push"]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/RELEASE CHECK FAILED/);
    expect(r.code).toBe(0);
  });

  test("red when someone else moved origin/main under it — the thing the check is for", () => {
    const sb = sandbox();
    // A sibling merges while the release is being prepared.
    const other = join(sb.dir, "other");
    execFileSync("git", ["clone", "-q", sb.originGit, other], { env: HOSTILE_GIT_ENV });
    git(other, "config", "user.email", "sibling@example.com");
    git(other, "config", "user.name", "Sibling");
    writeFileSync(join(other, "sibling.txt"), "merged while you were releasing\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "a sibling merge");
    git(other, "push", "-q", "origin", "main");

    makeReleaseCommit(sb);
    const r = run(sb, "release-check.sh", ["--pre-push"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/origin\/main/);
  });

  test("red when the tree is dirty, on a branch, or the tag already exists — items 4 and 5 all still run", () => {
    const sb = sandbox();
    makeReleaseCommit(sb);
    git(sb.main, "tag", "-a", `v${V}`, "-m", "left over from a previous attempt");
    writeFileSync(join(sb.main, "stray.txt"), "uncommitted\n");
    const r = run(sb, "release-check.sh", ["--pre-push"], { GATE_RED: "run" });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/working tree not clean/);
    expect(r.stdout).toMatch(new RegExp(`tag v${V} already exists locally`));
    expect(r.stdout).toMatch(/typecheck red/);
  });

  test("the default gate is untouched: an unpushed commit is still out of sync", () => {
    const sb = sandbox();
    makeReleaseCommit(sb);
    // No flag — this is what the PreToolUse hook and a bare `release-check.sh` run.
    const r = run(sb, "release-check.sh", []);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/not in sync with origin\/main/);
  });

  test("--ci is unchanged: it skips the whole git/toolchain block", () => {
    const sb = sandbox();
    makeReleaseCommit(sb);
    writeFileSync(join(sb.main, "stray.txt"), "uncommitted\n");
    const r = run(sb, "release-check.sh", ["--ci"], { GATE_RED: "test" });
    expect(r.code).toBe(0);
    expect(gateRuns(sb)).toEqual([]);
  });
});
