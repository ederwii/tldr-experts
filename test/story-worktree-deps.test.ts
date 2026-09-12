/**
 * A story worktree's DEPENDENCIES (gh #209).
 *
 * The measured failure this file is written against, on two real workspaces at
 * tldrx 0.14.2: the Build-entry pre-flight ran `npm run test` in the human's
 * checkout and recorded **exit 0**, `Ran all test suites.`; minutes later the
 * same command, same repo, in the story's fresh worktree recorded
 * `{"check":"dod","story":"S1","command":"npm run test","exit_code":127,`
 * `"detail":"sh: jest: command not found"}` and the story blocked — after a full
 * developer turn had been paid for. The base tree has `node_modules`; a fresh
 * `git worktree` does not, and nothing installed anything in one.
 *
 * The fixture reproduces exactly that gap rather than describing it: the repo's
 * `test:` script calls a BARE binary (`dodbin`) that lives only in
 * `node_modules/.bin`, the BASE tree has one (so the pre-flight is honestly
 * green, as it was live), `node_modules` is gitignored, and the story's worktree
 * — a real `git worktree add` — therefore has none. The declared `install:` is a
 * committed `node install.js` that creates it, which is what a real `npm ci`
 * does in one line and without a network.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { developerTools, REVIEWER_TOOLS } from "../src/core/facilitator/executors/build.ts";
import { bashGrantsFor, allowedTools } from "../src/core/facilitator/spawnAgent.ts";
import {
  BINARY_ABSENT_MARKER, INSTALL_SLOT, installFailureReason, notFoundBinary, WORKTREE_TREE,
} from "../src/core/build/worktreeDeps.ts";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file runs the REAL executor: git worktrees, a real `npm run test`, a real
// install script. Process cost is a property of the machine (#43).
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_STATE", "FAKE_BUILD_COST", "FAKE_BUILD_ARGV_LOG", "FAKE_BUILD_PROMPT_DIR",
] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/** The binary the `test:` script calls — present ONLY under `node_modules/.bin`. */
const DODBIN = "dodbin";

/** What a real `npm ci` does, minus the network: put the binary in the tree. */
const INSTALL_JS = [
  "const fs = require('node:fs');",
  "fs.mkdirSync('node_modules/.bin', {recursive: true});",
  `fs.writeFileSync('node_modules/.bin/${DODBIN}', '#!/bin/sh\\nexit 0\\n');`,
  `fs.chmodSync('node_modules/.bin/${DODBIN}', 0o755);`,
  "",
].join("\n");

/** An install that fails the way a real one does: something on stderr, exit 1. */
const INSTALL_FAIL_JS = [
  "process.stderr.write('npm ERR! code ERESOLVE\\nnpm ERR! could not resolve dependency\\n');",
  "process.exit(1);",
  "",
].join("\n");

const ONE_STORY = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
} satisfies Partial<BuildWorkspaceOptions>;

/**
 * A workspace whose `test:` needs a binary only an install provides.
 *
 * `installScript` null declares NO `install:` — the undeclared case, which is
 * the one the live run was in.
 */
function depsWorkspace(installScript: string | null, extra: Partial<BuildWorkspaceOptions> = {}): BuildWorkspace {
  const made = makeBuildWorkspace({
    ...ONE_STORY,
    testScript: DODBIN,
    repoFiles: {
      ".gitignore": "node_modules/\n",
      "install.js": INSTALL_JS,
      "install-fail.js": INSTALL_FAIL_JS,
    },
    commands: {
      build: null,
      test: "npm run test",
      lint: null,
      typecheck: null,
      ...(installScript === null ? {} : { install: installScript }),
    },
    ...extra,
  });
  open.push(made);
  // The BASE tree has its dependencies — as the live one did, which is why its
  // pre-flight was green while the story's worktree was 127. Gitignored, so the
  // dirty-tree refusal does not see it and no worktree inherits it.
  mkdirSync(join(made.repoDir, "node_modules", ".bin"), { recursive: true });
  const bin = join(made.repoDir, "node_modules", ".bin", DODBIN);
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(bin, 0o755);

  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  process.env.FAKE_BUILD_COST = "0.10";
  return made;
}

function next(ws: BuildWorkspace): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-29T09:00:00Z",
  }) as never;
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function checksNamed(ws: BuildWorkspace, check: string): readonly { type: string; payload: Record<string, unknown> }[] {
  return events(ws).filter((e) => e.type.startsWith("check.") && e.payload.check === check);
}

function storyFile(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function reviewLog(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.runDir, "04-build", "log", `${id}.md`), "utf8");
}

// ---------------------------------------------------------------------------

describe("the declared `install:` runs in the story's fresh worktree", () => {
  test("(a) it is recorded as its own check with an exit code and a duration, and the DoD then passes", async () => {
    const ws = depsWorkspace("node install.js");

    await next(ws);

    const install = checksNamed(ws, INSTALL_SLOT);
    expect(install).toHaveLength(1);
    expect(install[0]?.type).toBe("check.passed");
    expect(install[0]?.payload).toMatchObject({
      check: INSTALL_SLOT,
      story: "S1",
      repo: ws.repoName,
      command: "node install.js",
      exit_code: 0,
      tree: WORKTREE_TREE,
    });
    // The COST of the install, which #209 says was invisible: a real number, in
    // ms, measured around the spawn. Asserted as a number rather than a value —
    // a duration compared against a constant is a clock test, not a guard.
    expect(typeof install[0]?.payload.duration_ms).toBe("number");
    expect(install[0]?.payload.duration_ms as number).toBeGreaterThanOrEqual(0);

    // And the whole point: with the tree installed, the SAME command that 127s
    // without it is green, and the story settles.
    const dod = checksNamed(ws, "dod");
    expect(dod.map((e) => e.type)).toEqual(["check.passed"]);
    expect(dod[0]?.payload).toMatchObject({ command: "npm run test", exit_code: 0 });
    expect(storyFile(ws, "S1")).toContain("status: done");
  }, 120_000);

  /**
   * MOVED EARLIER BY #254, deliberately — read this before "fixing" it back.
   *
   * Until #254 an install that fails in a fresh worktree was discovered PER
   * STORY: `openStory` had already run, the story had a row, a branch and a
   * worktree, and the failure arrived one line before the paid turn. That is the
   * shape this test used to freeze, and it is the shape the live 18-hour run
   * (#254) spent five relaunches on — the same install failing identically in
   * story after story.
   *
   * Build entry now runs the declared `install:` in a throwaway worktree of the
   * base sha before anything is dispatched, so a DETERMINISTIC install failure
   * is caught THERE: exit 2, once, with no story opened and no story row. Every
   * claim the old assertions made is still made below — nothing spawned, the
   * install's own stderr in front of the operator, the command named — against
   * the door that now answers first.
   *
   * The per-story install has NOT been removed and is not dead: an install that
   * passes on the base and fails on a story's branch, or one that fails
   * intermittently, still fails where it always did. `(c)` above pins the
   * story-level `check: install` event end to end, and `installFailureReason`
   * still writes that story's sentence.
   */
  test("(d) an install that FAILS is refused at BUILD ENTRY (#254) with what it printed, and no story is opened", async () => {
    const ws = depsWorkspace("node install-fail.js");

    const outcome = await next(ws);

    // Exit 2: a gate refusal, not a failed stage — nothing was dispatched.
    expect(outcome.code).toBe(2);
    const said = outcome.lines.join("\n");
    expect(said).toContain("node install-fail.js");
    // The stderr tail, not a sentence about it.
    expect(said).toContain("could not resolve dependency");

    // Earlier than the old door in the one way that matters: the story never
    // opened at all, so there is no story-level install check and no story row.
    expect(checksNamed(ws, INSTALL_SLOT)).toEqual([]);
    expect(storyFile(ws, "S1")).toContain("status: todo");
    // No developer was dispatched into a tree that did not install.
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toEqual([]);
  }, 120_000);

  test("(d2) the story-level sentence for a failed install is still there, for the failure entry cannot see", () => {
    // A guard, not a proof: it passed before #254 too. It exists because #254
    // moved the DETERMINISTIC case to Build entry, and an unreferenced message is
    // one refactor away from being deleted as dead — while the story-level path
    // it speaks for (an install that fails only on a story's branch) is live.
    const reason = installFailureReason(
      { command: "npm ci", exitCode: 1, timedOut: false, tail: "npm ERR! ERESOLVE", durationMs: 12 },
      "app",
    );
    expect(reason).toContain("npm ci");
    expect(reason).toContain("npm ERR! ERESOLVE");
    expect(reason).toContain(INSTALL_SLOT);
  });
});

describe("an undeclared `install:` — the 127 is named, not called a red test", () => {
  test("(b) the DoD's 127 blocks with the binary-absent reason, and it says which edit fixes it", async () => {
    const ws = depsWorkspace(null);

    await next(ws);

    // Nothing installed, because nothing was declared — and that is stated, not
    // silent.
    expect(checksNamed(ws, INSTALL_SLOT)).toEqual([]);

    const dod = checksNamed(ws, "dod");
    expect(dod).toHaveLength(1);
    expect(dod[0]?.type).toBe("check.failed");
    expect(dod[0]?.payload).toMatchObject({
      check: "dod", story: "S1", command: "npm run test", exit_code: 127,
      tree: WORKTREE_TREE, absent_binary: DODBIN,
    });

    expect(storyFile(ws, "S1")).toContain("status: blocked");
    const log = reviewLog(ws, "S1");
    // The exported marker, not an English word that innocent prose can match (§8).
    expect(log).toContain(BINARY_ABSENT_MARKER);
    expect(log).toContain(DODBIN);
    // The one edit that fixes it, and the refusal to guess an installer.
    expect(log).toContain("`install:`");
    expect(log).toContain("does not guess an installer");
    // The cheapest honest sharing, named as an OPTION the framework does not take.
    expect(log).toContain("symlink");
    // NOT rendered as an ordinary red exit — that sentence is what blamed the
    // story for the environment.
    expect(log).not.toContain("`npm run test` exited 127 in repo app — `dodbin");
  }, 120_000);

  test("the base tree stayed green, so the two trees are the whole difference", async () => {
    const ws = depsWorkspace(null);

    await next(ws);

    // The pre-flight ran in the repo's checkout, which HAS node_modules. If this
    // were red the build would have refused at entry and (b) above would be
    // measuring a different bug — the live run's own shape was green base, 127
    // story, and this is the line that keeps the fixture on it.
    const preflight = readFileSync(join(ws.runDir, "04-build", "preflight.yml"), "utf8");
    expect(preflight).toContain("npm run test");
    expect(preflight).toContain("status: ok");
  }, 120_000);
});

describe("`tree:` says which tree a check ran in", () => {
  test("(e) every story DoD check carries `tree: worktree`", async () => {
    const ws = depsWorkspace("node install.js");

    await next(ws);

    const dod = checksNamed(ws, "dod");
    expect(dod.length).toBeGreaterThan(0);
    for (const event of dod) expect(event.payload.tree).toBe(WORKTREE_TREE);
  }, 120_000);
});

describe("a declared command may be run WITH ARGUMENTS", () => {
  /**
   * The second measured half of #209: the developer in the same live run never
   * ran its own DoD command either. Every attempt — `npx jest …`,
   * `npm run test -- app/dev/__tests__/x.test.ts`, three times bare — came back
   * `"This command requires approval to run"`, because the only grant was
   * `Bash(npm run test)` and Claude Code's permission grammar makes that EXACT:
   * https://code.claude.com/docs/en/permissions — "`Bash(npm run build)` …
   * Doesn't match `npm run build --watch`".
   */
  test("(c) the developer's allowance carries both the exact and the trailing-wildcard form", async () => {
    const ws = depsWorkspace("node install.js");
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_BUILD_ARGV_LOG = argvLog;

    await next(ws);

    const calls = readFileSync(argvLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const granted = (calls[0]?.[calls[0].indexOf("--allowedTools") + 1] ?? "").split(",");
    for (const command of ["npm run test", "node install.js"]) {
      expect(granted).toContain(`Bash(${command})`);
      expect(granted).toContain(`Bash(${command} *)`);
    }
    // The reviewer's list is UNCHANGED and still read-only — the role that found
    // the defects holds no pen, and `Bash(git diff *)` was already the
    // trailing-wildcard grammar.
    expect(calls[1]?.[calls[1].indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash(git diff *)");
  }, 120_000);

  test("both forms come from ONE derivation, used by both tool lists", () => {
    expect(bashGrantsFor("npm run test")).toEqual(["Bash(npm run test)", "Bash(npm run test *)"]);
    expect(developerTools(["npm run test"])).toEqual([
      "Read", "Write", "Edit", "Glob", "Grep",
      "Bash(npm run test)", "Bash(npm run test *)",
      "Bash(git add *)", "Bash(git commit *)",
      // The file-lifecycle verbs (#261) — git verbs on the story's own index,
      // never a bare `rm`.
      "Bash(git rm *)", "Bash(git mv *)", "Bash(git restore *)",
    ]);
    expect(allowedTools(["npm run test"])).toEqual([
      "Read", "Write", "Edit", "Glob", "Grep",
      "Bash(npm run test)", "Bash(npm run test *)",
    ]);
    // Never `git push`, whatever the grammar.
    expect(developerTools([]).some((tool) => tool.startsWith("Bash(git push"))).toBe(false);
    expect(REVIEWER_TOOLS).toEqual(["Read", "Grep", "Glob", "Bash(git diff *)"]);
  });
});

describe("reading a `command not found` tail", () => {
  test("both shells' spellings, and nothing invented from a tail that names none", () => {
    // The live tail, verbatim from `04-build/log/S1.md` in the #209 report.
    expect(notFoundBinary("sh: jest: command not found")).toBe("jest");
    expect(notFoundBinary("zsh: command not found: jest")).toBe("jest");
    expect(notFoundBinary("Ran all test suites.")).toBeNull();
  });
});
