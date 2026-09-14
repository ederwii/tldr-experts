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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
# #299: what the release marker said WHILE a gate ran — the only moment its span can be observed.
[ -f .RELEASE-IN-PROGRESS ] && cp .RELEASE-IN-PROGRESS "$GATE_LOG.marker"
[ "$1" = "\${GATE_RED:-__never__}" ] && exit 1
# #304: hold the release INSIDE its gate until a file appears, so a test can observe the span
# from outside — the only way to run a real wave against a real, still-running release.
if [ -n "\${GATE_HOLD_UNTIL:-}" ] && [ "$1" = "\${GATE_HOLD_ON:-test}" ]; then
  n=0
  while [ ! -f "$GATE_HOLD_UNTIL" ] && [ "$n" -lt 900 ]; do sleep 0.1; n=$((n+1)); done
fi
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
  for (const s of ["release.sh", "release-check.sh", "merge-lock.sh"]) {
    copyFileSync(join(REPO, "scripts", s), join(main, "scripts", s));
    chmodSync(join(main, "scripts", s), 0o755);
  }

  // The REAL .gitignore: the release marker sits at the root for the whole run, and release-check
  // item 4 asserts a CLEAN tree — so the ignore rule is under test here as much as the scripts.
  writeFileSync(join(main, ".gitignore"), readFileSync(join(REPO, ".gitignore"), "utf8"));
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

/**
 * `publish.yml` no longer re-runs the suite (owner decision, 2026-09-08). It ran typecheck,
 * tests and build a THIRD time on a sha `ci` had already proved green — measured ~6.5 min a
 * publish, ~14 publishes a week, ~87 min/week of runner time for an answer the repo already
 * had. The dependency is now explicit instead: publish refuses unless the `ci` workflow has a
 * SUCCESSFUL run for `github.sha`.
 *
 * The gate is queried through the REST API with `head_sha`, never `gh run list --commit`,
 * which returns `[]` for minutes while the runs demonstrably exist (`AGENTS.md` §4). And
 * `cancelled` is a NAMED outcome, not a silent one: `ci.yml` cancels superseded runs on a ref,
 * so a release commit whose run lost a race must fail loudly with the remedy rather than
 * publish on a sha nothing verified.
 *
 * Reads the workflow file; spawns nothing (no `test/machine-load.test.ts` row of its own).
 */
describe("publish.yml depends on ci instead of re-running the gates", () => {
  const publish = readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "publish.yml"), "utf8",
  );
  const steps = publish.split(/^jobs:$/m)[1] ?? "";

  test("it runs no `bun test` step of its own", () => {
    expect(
      /^\s*-?\s*(?:run:\s*)?bun test\s*$/m.test(steps),
      "publish.yml still runs `bun test` — a third run of the same gates on the same sha:\n" + steps,
    ).toBe(false);
  });

  test("it runs no `bun run typecheck` and no `bun run build` step of its own", () => {
    const again = [...steps.matchAll(/^\s*-\s*run:\s*(bun run (?:typecheck|build))\s*$/gm)]
      .map((m) => m[1] ?? "");
    expect(again, "publish.yml re-runs a gate ci already ran for this sha").toEqual([]);
  });

  test("it gates on a successful ci run for this exact sha", () => {
    expect(publish, "publish.yml has no step named for the ci gate")
      .toContain("ci must be green for this sha");
    expect(
      publish.includes("actions/workflows/ci.yml/runs?head_sha=${{ github.sha }}"),
      "publish.yml does not query ci's runs by head_sha — `gh run list --commit` lies (AGENTS.md §4)",
    ).toBe(true);
    expect(publish, "the job cannot read the ci run without `actions: read`").toContain("actions: read");
  });

  test("a cancelled ci run is named, not treated as green", () => {
    expect(
      publish.includes("cancelled"),
      "publish.yml never mentions `cancelled`, yet ci.yml cancels superseded runs — a release commit can lose that race",
    ).toBe(true);
  });

  test("the checks that only publish can do are still there", () => {
    expect(publish).toContain("release-check.sh --ci");
    expect(publish).toContain("npm publish --access public");
    expect(publish).toContain("already published");
    expect(publish).toContain("id-token: write");
  });
});

/**
 * Released CHANGELOG sections are immutable (#200).
 *
 * Measured on `main` at 0.14.0: `awk '/^## /{h=$0} /wait-gates/{print h}' CHANGELOG.md` put
 * #197's `--wait-gates` bullets under `## 0.13.0 — 2026-09-08`, a section whose tag does not
 * contain them (`git show v0.13.0:CHANGELOG.md | grep -c wait-gates` → 0). They were merged in
 * 069a73e, after v0.13.1 was cut, and shipped in v0.14.0 — appended to the FIRST `### Added` in
 * the file rather than the unreleased heading. The same slip is in 0.3.1 (60 lines from a528985,
 * which first shipped in v0.4.0) and 0.6.1 (a blank line deleted). Nothing checked, because
 * nothing compared a dated section against the tag that named it.
 *
 * The gate does: for every dated heading whose tag is present, the section's text must equal
 * that section's text at the tag. Tolerant where it must be — `--ci` runs on a shallow checkout
 * that may carry no tags, and v0.0.2's own tag still says `unreleased` — and those skips are
 * announced in one line rather than passed in silence. A deliberate correction is recorded in
 * `CHANGELOG.amendments`, a second file an accidental append never touches.
 *
 * Runs in `--ci` mode on purpose: this check is about the file and the tags, and `--ci` is the
 * mode that skips the toolchain block, so a red here can only be the section comparison.
 */
describe("a released CHANGELOG section may not be edited (#200)", () => {
  /** release.sh leaves the sandbox with a real `v0.9.9` tag over a dated 0.9.9 section. */
  function released(): Sandbox {
    const sb = sandbox();
    expect(run(sb, "release.sh", [V, "--tag", "beta"]).code).toBe(0);
    return sb;
  }

  const changelog = (sb: Sandbox) => join(sb.main, "CHANGELOG.md");

  test("untouched: the section still equals its tag, and the gate is green", () => {
    const sb = released();
    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/RELEASE CHECK FAILED/);
    expect(r.code).toBe(0);
  });

  test("a bullet appended to the released section is refused, with the version and the remedy", () => {
    const sb = released();
    writeFileSync(changelog(sb), `${readFileSync(changelog(sb), "utf8")}- a bullet that shipped in no release\n`);

    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`released section '## ${V}'`));
    expect(r.stdout).toContain(`v${V}:CHANGELOG.md`);
    expect(r.stdout).toMatch(/a bullet that shipped in no release/);   // the first differing line
    expect(r.stdout).toMatch(/restored, never edited/);                // the remedy
  });

  test("a deleted line is caught too — the direction that quietly unships a claim", () => {
    const sb = released();
    writeFileSync(changelog(sb), readFileSync(changelog(sb), "utf8").replace("- the sandbox release\n", ""));
    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`released section '## ${V}'`));
  });

  test("no tag for that version: skipped out loud, never failed — `--ci` may hold no tags at all", () => {
    const sb = released();
    writeFileSync(changelog(sb), `${readFileSync(changelog(sb), "utf8")}- a bullet that shipped in no release\n`);
    git(sb.main, "tag", "-d", `v${V}`);

    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/released-section check: skipped 1/);
  });

  /**
   * An amendment is a MOVE, and the gate checks it is one. A version listed in
   * `CHANGELOG.amendments` bought exactly two freedoms and no third: the tag's section must
   * survive as an ordered subsequence (nothing deleted, nothing reworded), and every line the
   * amendment ADDS must already exist, verbatim, in `<source-sha>:CHANGELOG.md`. Written after
   * a reviewer injected an arbitrary bullet into an amended section and the gate passed it: a
   * bare "this version is amended" line is a licence to write anything, which is the hole the
   * whole check exists to close.
   */
  const amendments = (sb: Sandbox) => join(sb.main, "CHANGELOG.amendments");
  const headSha = (sb: Sandbox) => git(sb.main, "rev-parse", "HEAD");

  test("a recorded amendment is allowed when every added line existed at the source sha", () => {
    const sb = released();
    const sha = headSha(sb);            // its CHANGELOG carries "- the sandbox release"
    writeFileSync(changelog(sb), `${readFileSync(changelog(sb), "utf8")}- the sandbox release\n`);
    writeFileSync(amendments(sb), `${V} ${sha} the bullet was filed under the section above; moved here verbatim\n`);

    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`${V.replace(/\./g, "\\.")}.*amendment`));
  });

  test("an amendment is not a licence: a line that exists at no source sha is refused", () => {
    const sb = released();
    const sha = headSha(sb);
    writeFileSync(changelog(sb), `${readFileSync(changelog(sb), "utf8")}- a bullet that shipped in no release\n`);
    writeFileSync(amendments(sb), `${V} ${sha} claims to be a move\n`);

    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`'## ${V}'`));
    expect(r.stdout).toMatch(/a bullet that shipped in no release/);
    expect(r.stdout).toContain(sha);
  });

  test("an amendment may not delete or reword a line the tag has", () => {
    const sb = released();
    const sha = headSha(sb);
    writeFileSync(changelog(sb), readFileSync(changelog(sb), "utf8").replace("- the sandbox release\n", "- the sandbox release, reworded\n"));
    writeFileSync(amendments(sb), `${V} ${sha} claims to be a move\n`);

    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`'## ${V}'`));
    expect(r.stdout).toMatch(/- the sandbox release/);
  });

  test("an amendment whose source sha is not a commit here is refused, not trusted", () => {
    const sb = released();
    writeFileSync(changelog(sb), `${readFileSync(changelog(sb), "utf8")}- the sandbox release\n`);
    writeFileSync(amendments(sb), `${V} 0000000000000000000000000000000000000000 a sha nobody can read\n`);

    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`'## ${V}'`));
  });

  test("an amendments file that does not name this version does not excuse it", () => {
    const sb = released();
    writeFileSync(changelog(sb), `${readFileSync(changelog(sb), "utf8")}- a bullet that shipped in no release\n`);
    writeFileSync(join(sb.main, "CHANGELOG.amendments"), "0.0.1 some other correction entirely\n");

    const r = run(sb, "release-check.sh", ["--ci"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`released section '## ${V}'`));
  });
});

/**
 * `scripts/release.sh` advertises itself for its whole span (#299).
 *
 * Measured 2026-09-13/14, two sessions on one repo: "is a release in flight?" was asked by
 * message four times in a day, because the release wrote nothing anyone could wait on — the
 * `maintain` skill said so in as many words ("there is NO detector"). A merge wave in the
 * middle of a release is the half-released state `docs/RELEASING.md` exists to prevent, and
 * `scripts/merge-wave.sh` now waits on this marker exactly as it waits on its own lock. So the
 * marker has to be there from before the first edit to after the tag push, and gone on EVERY
 * exit path — a marker left behind by a red gate would freeze merges until a human noticed.
 */
/** What the release marker said while a gate ran (#299) — empty when no gate ever saw one. */
const seenByGates = (sb: Sandbox): string => {
  try { return readFileSync(`${sb.gateLog}.marker`, "utf8"); } catch { return ""; }
};

describe("release.sh writes a .RELEASE-IN-PROGRESS marker for its whole span, and removes it on every exit (#299)", () => {
  const marker = (sb: Sandbox) => join(sb.main, ".RELEASE-IN-PROGRESS");

  test("green path: the gates ran under the marker, and it is gone once the tag is pushed", () => {
    const sb = sandbox();
    const r = run(sb, "release.sh", [V, "--tag", "beta"]);
    expect(r.code).toBe(0);
    const seen = seenByGates(sb);
    expect(seen, "no gate ever saw the marker — it was not written before the gate ran").not.toBe("");
    expect(seen).toContain(`version: ${V}`);
    expect(seen).toMatch(/^pid:\s+\d+$/m);
    expect(seen).toMatch(/^started:\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    expect(existsSync(marker(sb))).toBe(false);
    expect(originTags(sb)).toEqual([`v${V}`]);           // and the release itself still landed
  });

  test("the marker does not dirty the tree the gate asserts clean", () => {
    const sb = sandbox();
    // Only the ignore rule stands between the marker and `working tree not clean`.
    const r = run(sb, "release.sh", [V, "--tag", "beta"]);
    expect(r.code).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/working tree not clean/);
  });

  test("red gate: the marker leaves with the failed release, not after a human notices", () => {
    const sb = sandbox();
    const r = run(sb, "release.sh", [V, "--tag", "beta"], { GATE_RED: "test" });
    expect(r.code).not.toBe(0);
    expect(seenByGates(sb)).toContain(`version: ${V}`);   // it WAS there while the gate ran
    expect(existsSync(marker(sb))).toBe(false);           // and is not there now
  });

  test("a refused precondition — no unreleased heading — leaves no marker either", () => {
    const sb = sandbox();
    writeFileSync(join(sb.main, "CHANGELOG.md"), "# Changelog\n\n## 0.0.1 — 2026-01-01\n\n- nothing staged\n");
    git(sb.main, "commit", "-q", "-am", "no heading staged");
    const r = run(sb, "release.sh", [V, "--tag", "beta"]);
    expect(r.code).toBe(1);
    expect(existsSync(marker(sb))).toBe(false);
  });

  test("the repo's .gitignore carries the rule", () => {
    const ignored = execFileSync("git", ["check-ignore", "-v", "--", ".RELEASE-IN-PROGRESS"], { cwd: REPO, encoding: "utf8" });
    expect(ignored).toContain(".gitignore");
  });
});

/**
 * `scripts/release.sh` WAITS on a running wave, the way the wave waits on it (#304).
 *
 * #299 made one direction mechanical: the wave polls `.RELEASE-IN-PROGRESS`. The reverse did
 * not exist — measured by reading `scripts/release.sh` at `a341b4f`: it sourced `merge-lock.sh`
 * only to name its own marker, and nothing between its first line and `git commit` read
 * `merge-wave.lock`. A release started mid-wave therefore edited CHANGELOG/README/package.json
 * in a checkout another process was gating, and the only thing that stopped the commit was the
 * ref-transaction hook — which aborts the COMMIT and leaves the three edits dirty in the shared
 * tree, with nothing rolling them back. So the wait has to come BEFORE the marker and before the
 * first edit, with the wave's own knobs and its own dead-owner rule, and give up with a code of
 * its own (14 — the merge-wave table owns 1–13, and one number per condition across both scripts
 * keeps a bare "exit 14" in a log unambiguous).
 *
 * The lock is planted exactly as `scripts/merge-wave.sh` writes it (owner `<pid> <host> <epoch>`
 * plus a token), inside `.git/`, and the wave's marker at the root — the real .gitignore is in
 * the sandbox, so the marker cannot fail the clean-tree gate either.
 */
describe("release.sh waits on a running merge wave before it touches the tree (#304)", () => {
  const MERGE_WAVE = join(REPO, "scripts", "merge-wave.sh");
  const lockDir = (sb: Sandbox) => join(sb.main, ".git", "merge-wave.lock");
  const waveMarker = (sb: Sandbox) => join(sb.main, ".MERGE-WAVE-IN-PROGRESS");
  const releaseMarker = (sb: Sandbox) => join(sb.main, ".RELEASE-IN-PROGRESS");

  /** A lock held by SOMEONE ELSE — `merge-wave.sh`'s own shape, owner line last. */
  function holdWaveLock(sb: Sandbox, pid: number = process.pid): void {
    mkdirSync(lockDir(sb), { recursive: true });
    writeFileSync(join(lockDir(sb), "token"), "token-of-another-invocation\n");
    writeFileSync(join(lockDir(sb), "branch"), "wave-elsewhere\n");
    writeFileSync(join(lockDir(sb), "phase"), "gates\n");
    writeFileSync(waveMarker(sb), "MERGE WAVE IN PROGRESS — planted by the test\n");
    writeFileSync(join(lockDir(sb), "owner"), `${pid} ${hostname()} ${Math.floor(Date.now() / 1000)}\n`);
  }

  /** The tree as `sandbox()` committed it: nothing edited, nothing committed, nothing pushed. */
  function expectUntouched(sb: Sandbox, before: string): void {
    expect(git(sb.main, "rev-parse", "HEAD")).toBe(before);
    expect(git(sb.main, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(sb.main, "CHANGELOG.md"), "utf8")).toContain(`## ${V} — unreleased`);
    expect(JSON.parse(readFileSync(join(sb.main, "package.json"), "utf8")).version).toBe("0.0.1");
    expect(originSha(sb)).toBe(before);
    expect(originTags(sb)).toEqual([]);
  }

  type Live = { done: Promise<Result>; stderrSoFar: () => string; kill: () => void };
  function runAsync(sb: Sandbox, script: string, args: string[], env: Record<string, string> = {}): Live {
    let stdout = "";
    let stderr = "";
    const child = spawn("bash", [join(sb.main, "scripts", script), ...args], {
      cwd: sb.main,
      env: { ...HOSTILE_GIT_ENV, PATH: `${sb.bin}:${process.env.PATH ?? ""}`, GATE_LOG: sb.gateLog, TMPDIR: sb.dir, ...env },
    });
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    const done = new Promise<Result>((resolve) => {
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    return { done, stderrSoFar: () => stderr, kill: () => { child.kill("SIGTERM"); } };
  }

  /**
   * A stand-in `mv` that plants a wave lock the instant the release marker lands — the ONE
   * `mv` in release.sh is the marker's (`grep -n '\\bmv\\b' scripts/*.sh`), so this is the gap
   * interleaving constructed deterministically: the lock exists before release.sh's very next
   * line runs, with no sleep on either side. The lock is `merge-wave.sh`'s own shape. Planted
   * ONCE, keyed on a once-file: the marker is rewritten by `mv` again when its phase changes.
   */
  const MV_STUB = `#!/usr/bin/env bash
/bin/mv "$@"; rc=$?
for last; do :; done
case "$last" in *.RELEASE-IN-PROGRESS)
  if [ -n "\${PLANT_WAVE_LOCK:-}" ] && [ ! -f "$PLANT_WAVE_LOCK.planted" ]; then
    : > "$PLANT_WAVE_LOCK.planted"
    mkdir -p "$PLANT_WAVE_LOCK"
    printf 'token-of-another-invocation\n' > "$PLANT_WAVE_LOCK/token"
    printf 'wave-in-the-gap\n' > "$PLANT_WAVE_LOCK/branch"
    printf 'merge\n' > "$PLANT_WAVE_LOCK/phase"
    printf '%s\n' "$PLANT_WAVE_LOCK_OWNER" > "$PLANT_WAVE_LOCK/owner"
  fi;;
esac
exit $rc
`;

  async function waitUntil(predicate: () => boolean, budgetMs: number, what: string): Promise<void> {
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  test("a live wave is respected, and the wait is bounded — exit 14, no marker, no edit, no commit", () => {
    const sb = sandbox();
    const before = git(sb.main, "rev-parse", "HEAD");
    holdWaveLock(sb);                                    // this very process: alive, on this host
    const r = run(sb, "release.sh", [V, "--tag", "beta"], { MW_LOCK_WAIT_S: "1", MW_LOCK_POLL_S: "1" });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(14);
    expect(r.stdout).toContain("FAIL merge wave in flight");
    expect(r.stdout).toContain("wave-elsewhere");        // which wave, not just "a wave"
    expect(r.stdout).toContain("nothing released");
    expect(r.stderr).toContain("waiting for a merge wave");
    expect(gateRuns(sb)).toEqual([]);                    // no gate was spent on it
    expect(existsSync(releaseMarker(sb))).toBe(false);   // it never advertised a release it did not start
    expect(existsSync(lockDir(sb))).toBe(true);          // someone else's lock is left alone
    expectUntouched(sb, before);
  });

  test("a lock whose wave is dead is broken open, said so, and the release proceeds", () => {
    const sb = sandbox();
    holdWaveLock(sb, 999999);                            // a pid nothing on this host is running
    const r = run(sb, "release.sh", [V, "--tag", "beta"], { MW_LOCK_WAIT_S: "5", MW_LOCK_POLL_S: "1" });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/dead/);
    expect(r.stderr).toContain("999999");
    expect(existsSync(lockDir(sb))).toBe(false);
    expect(originTags(sb)).toEqual([`v${V}`]);
    expect(existsSync(releaseMarker(sb))).toBe(false);
  });

  test("when the wave finishes, the queued release goes on to release — and had edited nothing while queued", async () => {
    const sb = sandbox();
    const before = git(sb.main, "rev-parse", "HEAD");
    holdWaveLock(sb);
    const live = runAsync(sb, "release.sh", [V, "--tag", "beta"], { MW_LOCK_WAIT_S: "60", MW_LOCK_POLL_S: "1" });
    await waitUntil(() => live.stderrSoFar().includes("waiting for a merge wave"), 30_000, "the release to queue behind the wave");
    expectUntouched(sb, before);                         // queued means QUEUED: the tree is as it was
    expect(existsSync(releaseMarker(sb))).toBe(false);
    rmSync(lockDir(sb), { recursive: true });            // the wave's release(), by hand
    rmSync(waveMarker(sb));
    const r = await live.done;
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(originTags(sb)).toEqual([`v${V}`]);
    expect(existsSync(releaseMarker(sb))).toBe(false);
  });

  test("precedence, not courtesy: a wave that takes the lock in the gap right after the marker lands finds the marker KEPT — the release waits it out and a wave arriving meanwhile yields (exit 13)", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.bin, "mv"), MV_STUB);
    chmodSync(join(sb.bin, "mv"), 0o755);
    const before = git(sb.main, "rev-parse", "HEAD");
    const live = runAsync(sb, "release.sh", [V, "--tag", "beta"], {
      MW_LOCK_WAIT_S: "60", MW_LOCK_POLL_S: "1",
      PLANT_WAVE_LOCK: lockDir(sb), PLANT_WAVE_LOCK_OWNER: `${process.pid} ${hostname()} ${Math.floor(Date.now() / 1000)}`,
    });
    try {
      await waitUntil(() => live.stderrSoFar().includes("waiting for a merge wave"), 30_000, "the release to queue behind the gap wave");
      // The symmetric hand-back — both sides yielding on the same cadence — is an hour of
      // ping-pong ending in 13 and 14. The doctrine is the wave's own refusal line: merges wait
      // for a release. So the marker STAYS while the release waits for the lock to clear.
      expect(existsSync(releaseMarker(sb)), "release.sh handed its marker back instead of keeping precedence").toBe(true);
      expect(existsSync(lockDir(sb))).toBe(true);
      expectUntouched(sb, before);
      // A kept marker means two things now — queued and untouched, or editing/tagging — so the
      // marker SAYS which (§7: a record never says more than the truth), and every reader prints it.
      expect(readFileSync(releaseMarker(sb), "utf8")).toMatch(/^phase:\s+waiting$/m);
      const env = { ...process.env, TMPDIR: sb.dir, MW_LOCK_WAIT_S: "1", MW_LOCK_POLL_S: "1" };
      // `--status` answers for the LOCK first (a live wave is what a human must not disturb), so in
      // this window it names the gap wave; the queued release's own state is the marker's phase.
      const status = spawnSync("bash", [MERGE_WAVE, "--status"], { cwd: sb.main, encoding: "utf8", env });
      const lines = status.stdout.trim().split("\n");
      expect(lines[0]).toMatch(/^holder=\d+ branch=wave-in-the-gap phase=merge started=/);
      // …and the queued release on a SECOND line, so a reader is not told "a wave, nothing else".
      expect(lines[1]).toMatch(/^release queued: pid \d+ version=0\.9\.9 phase=waiting$/);
      expect(lines.length).toBe(2);
      // A real wave arriving now sees the marker first and yields — the release is ahead of it.
      const wave = spawnSync("bash", [MERGE_WAVE, "some-branch", "merge some-branch"], { cwd: sb.main, encoding: "utf8", env });
      expect(wave.status, `${wave.stdout}\n${wave.stderr}`).toBe(13);
      expect(wave.stdout).toContain("FAIL release in flight");
      expect(wave.stdout).toContain("queued behind a wave, nothing edited yet");
      expect(existsSync(releaseMarker(sb))).toBe(true);   // still there after the wave looked
      rmSync(lockDir(sb), { recursive: true });            // the gap wave yielding, by hand
      const r = await live.done;
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(originTags(sb)).toEqual([`v${V}`]);
      expect(seenByGates(sb)).toContain(`version: ${V}`);  // and the gates ran under that same marker
      expect(seenByGates(sb)).toMatch(/^phase:\s+releasing$/m);   // which by then said so
      expect(seenByGates(sb)).not.toMatch(/^phase:\s+waiting$/m);
      expect(existsSync(releaseMarker(sb))).toBe(false);
    } finally {
      live.kill();
    }
  });

  test("the other direction still holds, end to end: a REAL wave waits on a REAL running release (exit 13) and --status names it", async () => {
    const sb = sandbox();
    const go = join(sb.dir, "release-go");
    // A real release, held inside its `bun test` gate: marker written, release commit made, nothing pushed.
    const live = runAsync(sb, "release.sh", [V, "--tag", "beta"], { GATE_HOLD_UNTIL: go, GATE_HOLD_ON: "test" });
    await waitUntil(() => existsSync(releaseMarker(sb)) && gateRuns(sb).some((g) => g.what.startsWith("test")), 60_000, "the release to reach its test gate");
    const env = { ...process.env, TMPDIR: sb.dir, MW_LOCK_WAIT_S: "1", MW_LOCK_POLL_S: "1" };
    const status = spawnSync("bash", [MERGE_WAVE, "--status"], { cwd: sb.main, encoding: "utf8", env });
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toMatch(new RegExp(`^release holder=\\d+ version=${V.replace(/\./g, "\\.")} phase=releasing started=`));
    const wave = spawnSync("bash", [MERGE_WAVE, "some-branch", "merge some-branch"], { cwd: sb.main, encoding: "utf8", env });
    expect(wave.status, `${wave.stdout}\n${wave.stderr}`).toBe(13);
    expect(wave.stdout).toContain("FAIL release in flight");
    expect(wave.stdout).toContain(V);
    expect(existsSync(lockDir(sb))).toBe(false);         // the wave took no lock under a live release
    writeFileSync(go, "go\n");
    const r = await live.done;
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(originTags(sb)).toEqual([`v${V}`]);
    expect(existsSync(releaseMarker(sb))).toBe(false);
  });

  test("release.sh's header names exit 14, and docs/RELEASING.md carries the code", () => {
    const src = readFileSync(join(REPO, "scripts", "release.sh"), "utf8");
    expect(src).toMatch(/exit 14\b/);
    expect(src).toMatch(/^# Exit codes:.*14/m);
    expect(readFileSync(join(REPO, "docs", "RELEASING.md"), "utf8")).toMatch(/exit 14/);
  });
});
