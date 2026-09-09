/**
 * #164 — the Build entry no longer stops for somebody else's uncommitted work.
 *
 * The measured failure, twice on two consecutive days and then again across three
 * real workspaces on 0.14.2: `04-build` refused with `refusing to cut an epic
 * branch from a dirty tree` over paths no story was going to write — seed docs, a
 * data export, one untracked note — and the printed remedy was wrong in two ways
 * (a bare `git stash push -u` swept the run's OWN untracked records under
 * `tldrx-work/<run>/` into the stash, and `tldrx next` is the cursor verb while
 * the owner was in `run auto`).
 *
 * Everything here runs the REAL pipeline against a REAL git repo — only `claude`
 * is faked — because every claim in this change is about what git actually does.
 * The `test` script is the instrument: it runs `git status --porcelain` from
 * inside the base pre-flight, in the repo's own checkout, and appends what it saw
 * to a file. That is what makes "the epic branch is cut from a CLEAN tree" a
 * measurement taken DURING the run rather than an inference from the outside
 * afterwards.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import {
  classifyDirty, notRestoredSummary, pendingAsides, restoreForeignWork, stashCommand, stashMessage,
} from "../src/core/build/foreignWork.ts";
import { runEndNotification, stageDoneNotification } from "../src/core/notify/notifications.ts";
import { dirtyEntries, stashPushPaths } from "../src/core/build/git.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `node`, the fake agent.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_PROMPT_DIR",
] as const;

/** The run id `createRun` derives from the fixture's pinned clock. */
const RUN_ID = "260829-build";

/** `.log` is gitignored in both fixture shapes, so the instrument is never dirt. */
const PROBE_FILE = "probe.log";
const APPEND_MARK = "append-here.log";

/**
 * The instrument, and it writes to a path relative to its own cwd on purpose: the
 * DoD spawn does not carry this process's `process.env` to the child (the runtime
 * seam passes the environment as it was at process START — `runtime/Runtime.ts`),
 * so an env var would have been a probe that could not observe the thing.
 *
 * It records the cwd it ran in, whether that cwd is the repo's own checkout or a
 * story worktree, what `git status --porcelain` said there, and whether the run's
 * own untracked scratch file was still on disk at that moment. In the base
 * checkout only, and only when a test has planted the marker, it also writes to a
 * tracked file — which is how a restore is made to fail for a real reason.
 */
const PROBE_SCRIPT =
  "node -e \"const cp=require('child_process'),fs=require('fs');"
  + "const base=!process.cwd().includes('worktrees');"
  + `fs.appendFileSync('${PROBE_FILE}',JSON.stringify({`
  + "cwd:process.cwd(),base,"
  + "st:cp.execSync('git status --porcelain').toString(),"
  + `probe:fs.existsSync('tldrx-work/${RUN_ID}/scratch.txt')`
  + "})+'\\n');"
  + `if(base&&fs.existsSync('${APPEND_MARK}'))fs.appendFileSync('notes.md','dod\\n')\"`;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace({ testScript: PROBE_SCRIPT, ...options });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}) {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-29T09:00:00Z",
    ...overrides,
  });
}

function git(ws: BuildWorkspace, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: ws.repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function eventsOfType(ws: BuildWorkspace, type: string): readonly Record<string, unknown>[] {
  return events(ws).filter((event) => event.type === type).map((event) => event.payload);
}

/**
 * What the base pre-flight saw: the DoD records whose cwd is NOT a story
 * worktree. There is exactly one repo checkout and every other record comes from
 * `.tldrx/worktrees/`, so the filter is total rather than a guess.
 */
function baseProbes(ws: BuildWorkspace): readonly { cwd: string; base: boolean; st: string; probe: boolean }[] {
  const path = join(ws.repoDir, PROBE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { cwd: string; base: boolean; st: string; probe: boolean })
    .filter((row) => row.base);
}

/** The instrument's own output is gitignored, so it is never counted as dirt. */
const IGNORE = `${PROBE_FILE}\n${APPEND_MARK}\n`;

const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
  repoFiles: { ".gitignore": IGNORE },
};

// ---------------------------------------------------------------------------

describe("(a) foreign work is set aside, and given back", () => {
  test("the epic branch is cut from a clean tree and the files come back byte-identical", async () => {
    const ws = workspace({ ...ONE_STORY, repoFiles: { ".gitignore": IGNORE, "notes.md": "owner base\n" } });
    // Two shapes of foreign dirt: a tracked file the operator modified, and an
    // untracked one. Neither is `s1.txt`, which is what the story declares.
    writeFileSync(join(ws.repoDir, "notes.md"), "owner base\nowner edit\n", "utf8");
    writeFileSync(join(ws.repoDir, "export.csv"), "id,value\n1,2\n", "utf8");

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");
    expect(said).not.toContain("refusing to cut an epic branch");
    expect(outcome.code, said).toBe(4);    // awaiting the human gate — the story ran
    expect(said).toContain("✓ S1 → `done`");

    // The record: one aside, naming BOTH paths and a stash hash.
    const aside = eventsOfType(ws, "worktree.foreign_work_aside");
    expect(aside).toHaveLength(1);
    expect(aside[0]?.repo).toBe("app");
    expect([...(aside[0]?.paths as string[])].sort()).toEqual(["export.csv", "notes.md"]);
    expect(aside[0]?.stash_ref).toMatch(/^[0-9a-f]{40}$/);
    expect(aside[0]?.reason).toContain("no pending story declares");

    // MEASURED INSIDE THE RUN: the base pre-flight ran on a clean checkout.
    const probes = baseProbes(ws);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]?.st).toBe("");

    // And the work is back, unchanged, with the stash gone.
    expect(readFileSync(join(ws.repoDir, "notes.md"), "utf8")).toBe("owner base\nowner edit\n");
    expect(readFileSync(join(ws.repoDir, "export.csv"), "utf8")).toBe("id,value\n1,2\n");
    const restored = eventsOfType(ws, "worktree.foreign_work_restored");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.restored).toBe(true);
    expect(restored[0]?.stash_ref).toBe(aside[0]?.stash_ref);
    expect(git(ws, ["stash", "list"])).toBe("");
  });
});

describe("(b) the framework's own state is never stashed", () => {
  test("an untracked file under tldrx-work/ is still there while the run is running", async () => {
    const ws = workspace({ ...ONE_STORY, rootIsRepo: true });
    const scratch = join(ws.runDir, "scratch.txt");
    writeFileSync(scratch, "the run's own untracked record\n", "utf8");
    writeFileSync(join(ws.repoDir, "export.csv"), "id,value\n1,2\n", "utf8");

    const outcome = await next(ws);
    expect(outcome.lines.join("\n")).not.toContain("refusing to cut an epic branch");

    // The probe ran INSIDE the run, after the stash: the file was never moved.
    const probes = baseProbes(ws);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]?.probe).toBe(true);
    expect(existsSync(scratch)).toBe(true);

    const aside = eventsOfType(ws, "worktree.foreign_work_aside");
    expect(aside).toHaveLength(1);
    for (const path of aside[0]?.paths as string[]) {
      expect(path.startsWith("tldrx-work/")).toBe(false);
      expect(path.startsWith(".tldrx/")).toBe(false);
    }
  });
});

describe("(c) a path a story declares still refuses", () => {
  test("the remedy is pathspec-limited and names the engine's own verb", async () => {
    const ws = workspace({
      ...ONE_STORY,
      stories: [{ id: "S1", epic: "E1", title: "First story", touches: ["src/app.ts"] }],
      repoFiles: { ".gitignore": IGNORE, "src/app.ts": "export const a = 1;\n" },
    });
    writeFileSync(join(ws.repoDir, "src/app.ts"), "export const a = 2;\n", "utf8");
    writeFileSync(join(ws.repoDir, "export.csv"), "id,value\n1,2\n", "utf8");

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");
    expect(said).toContain("refusing to cut an epic branch from a dirty tree");
    expect(said).toContain("a pending story declares this path in its `touches:`");
    // The corrected remedy: a `--` with exactly the listed path, and never a bare `-u`.
    // Quoted for a SHELL and `:(literal)` for git — the same string the engine
    // itself passes, from the same function (review round 1, Important 1).
    expect(said).toContain(
      `git -C '${ws.repoDir}' stash push -u -m 'tldrx ${ws.runId} foreign work' -- ':(literal)src/app.ts'`,
    );
    // The verb is the ENGINE's, because this invocation is the engine.
    expect(said).toContain(`tldrx run auto ${ws.runId}`);
    expect(said).not.toContain("    tldrx next");
    // The other dirty path is named as something the engine would have handled.
    expect(said).toContain("are nobody's story");
    // Nothing was stashed, nothing was cut.
    expect(git(ws, ["stash", "list"])).toBe("");
    expect(eventsOfType(ws, "worktree.foreign_work_aside")).toHaveLength(0);
    expect(() => git(ws, ["rev-parse", "--verify", "epic/e1"])).toThrow();
  });

  test("in cursor mode the same refusal names `tldrx next`", async () => {
    const ws = workspace({
      ...ONE_STORY,
      stories: [{ id: "S1", epic: "E1", title: "First story", touches: ["src/app.ts"] }],
      repoFiles: { ".gitignore": IGNORE, "src/app.ts": "export const a = 1;\n" },
    });
    writeFileSync(join(ws.repoDir, "src/app.ts"), "export const a = 2;\n", "utf8");
    const outcome = await next(ws, { mode: "prepare" });
    const said = outcome.lines.join("\n");
    expect(said).toContain("refusing to cut an epic branch from a dirty tree");
    expect(said).toContain("    tldrx next");
    expect(said).not.toContain("tldrx run auto");
  });
});

describe("(d) a restore git refuses is recorded and said out loud", () => {
  test("`restored: false`, the stash survives, the handoff names it, the exit code does not move", async () => {
    const ws = workspace({ ...ONE_STORY, repoFiles: { ".gitignore": IGNORE, "notes.md": "owner base\n" } });
    writeFileSync(join(ws.repoDir, "notes.md"), "owner base\nowner edit\n", "utf8");
    // The marker makes the DoD command write to the very file the operator had
    // modified, in the repo's OWN checkout — so by the time the stash is popped,
    // the tree has its own version of that path and git refuses the pop rather
    // than overwriting anything. The marker is gitignored, so it is not dirt.
    writeFileSync(join(ws.repoDir, APPEND_MARK), "yes\n", "utf8");

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");

    // The run's own outcome is untouched by the restore: still the human gate.
    expect(outcome.code).toBe(4);
    const restored = eventsOfType(ws, "worktree.foreign_work_restored");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.restored).toBe(false);
    expect(restored[0]?.command).toContain("stash pop stash@{0}");

    // The line is the LAST thing the stage says, and it names the stash.
    expect(said).toContain("foreign work NOT restored in app — stash ");
    expect(outcome.lines[outcome.lines.length - 1]).toContain("foreign work NOT restored");

    // The stash is still there. Nothing was dropped and nothing was forced.
    expect(git(ws, ["stash", "list"])).toContain(stashMessage(ws.runId));

    // And the handoff carries it into `## Unknowns`, which is what a PR body reads.
    const handoff = readFileSync(join(ws.runDir, "04-build/handoff.md"), "utf8");
    expect(handoff).toContain("was NOT restored and needs a human");
    expect(handoff).toContain("notes.md");
  });
});

describe("(f) the pathspec is literal, never a glob", () => {
  test("a filename with a space, a leading dash and a bracket is the file that moves", async () => {
    const hostile = ["a b[1].txt", "-dash.txt", "plain.txt"];
    const ws = workspace(ONE_STORY);
    for (const name of hostile) writeFileSync(join(ws.repoDir, name), `${name}\n`, "utf8");

    const outcome = await next(ws);
    expect(outcome.lines.join("\n")).not.toContain("refusing to cut an epic branch");

    const aside = eventsOfType(ws, "worktree.foreign_work_aside");
    expect(aside).toHaveLength(1);
    expect([...(aside[0]?.paths as string[])].sort()).toEqual([...hostile].sort());

    // The proof that `:(literal)` did its job: a glob `a b[1].txt` matches
    // `a b1.txt` and NOT the file actually called `a b[1].txt`, so without it
    // that file would still have been in the tree the pre-flight measured.
    const probes = baseProbes(ws);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]?.st).toBe("");

    for (const name of hostile) {
      expect(readFileSync(join(ws.repoDir, name), "utf8")).toBe(`${name}\n`);
    }
  });
});

describe("(g) `touches:` cannot promote framework state to something stashable", () => {
  test("a story that declares tldrx-work/ still leaves it alone", async () => {
    const ws = workspace({
      ...ONE_STORY,
      rootIsRepo: true,
      stories: [{ id: "S1", epic: "E1", title: "First story", touches: ["s1.txt", "tldrx-work", ".tldrx"] }],
    });
    const scratch = join(ws.runDir, "scratch.txt");
    writeFileSync(scratch, "the run's own untracked record\n", "utf8");
    writeFileSync(join(ws.repoDir, "export.csv"), "id,value\n1,2\n", "utf8");

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");
    // Not a refusal either: state is not dirt, whatever a story declared.
    expect(said).not.toContain("refusing to cut an epic branch");
    const aside = eventsOfType(ws, "worktree.foreign_work_aside");
    expect(aside).toHaveLength(1);
    expect(aside[0]?.paths).toEqual(["export.csv"]);
    expect(existsSync(scratch)).toBe(true);
  });
});

describe("(h) a repo in the middle of something is never stashed into", () => {
  test("a merge in progress refuses, names the operation, and moves nothing", async () => {
    const ws = workspace({ ...ONE_STORY, repoFiles: { ".gitignore": IGNORE, "notes.md": "base\n" } });
    // A real conflicted merge: two branches that changed the same line.
    git(ws, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(ws.repoDir, "notes.md"), "side\n", "utf8");
    git(ws, ["commit", "-qam", "side"]);
    git(ws, ["checkout", "-q", "main"]);
    writeFileSync(join(ws.repoDir, "notes.md"), "main\n", "utf8");
    git(ws, ["commit", "-qam", "main"]);
    expect(() => git(ws, ["merge", "side"])).toThrow();
    expect(existsSync(join(ws.repoDir, ".git", "MERGE_HEAD"))).toBe(true);

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");
    expect(said).toContain("is in the middle of a merge");
    expect(said).toContain("refusing to stash anything into that state");
    expect(said).toContain(`tldrx run auto ${ws.runId}`);
    expect(git(ws, ["stash", "list"])).toBe("");
    expect(eventsOfType(ws, "worktree.foreign_work_aside")).toHaveLength(0);
  });
});

describe("(i) a dirty submodule refuses rather than being stashed", () => {
  test("a submodule's uncommitted state is another repository's, and a stash here would not carry it", () => {
    const verdict = classifyDirty({
      entries: [
        { code: " M", path: "vendor/lib", entry: " M vendor/lib" },
        { code: "??", path: "export.csv", entry: "?? export.csv" },
      ],
      statePrefixes: [],
      touches: [],
      submodules: new Set(["vendor/lib"]),
    });
    expect(verdict.overlapping.map((row) => row.entry.path)).toEqual(["vendor/lib"]);
    expect(verdict.overlapping[0]?.why).toContain("is a submodule");
    expect(verdict.foreign.map((row) => row.path)).toEqual(["export.csv"]);
  });
});

describe("the classifier and the log reader", () => {
  test("state wins over `touches`, `touches` wins over foreign", () => {
    const verdict = classifyDirty({
      entries: [
        { code: "??", path: "tldrx-work/260829-x/run.yml", entry: "?? tldrx-work/260829-x/run.yml" },
        { code: " M", path: "src/app.ts", entry: " M src/app.ts" },
        { code: "??", path: "export.csv", entry: "?? export.csv" },
      ],
      statePrefixes: ["tldrx-work", ".tldrx"],
      touches: ["src", "tldrx-work"],
      submodules: new Set(),
    });
    expect(verdict.own.map((row) => row.path)).toEqual(["tldrx-work/260829-x/run.yml"]);
    expect(verdict.overlapping.map((row) => row.entry.path)).toEqual(["src/app.ts"]);
    expect(verdict.foreign.map((row) => row.path)).toEqual(["export.csv"]);
  });

  test("a stash whose restore succeeded is not pending; one that failed still is", () => {
    const aside = (hash: string) => JSON.stringify({
      type: "worktree.foreign_work_aside",
      payload: { repo: "app", paths: ["export.csv"], stash_ref: hash, reason: "r" },
    });
    const restored = (hash: string, ok: boolean) => JSON.stringify({
      type: "worktree.foreign_work_restored",
      payload: { repo: "app", paths: ["export.csv"], stash_ref: hash, restored: ok },
    });
    const text = [aside("a".repeat(40)), aside("b".repeat(40)), restored("a".repeat(40), true),
      restored("b".repeat(40), false), "{not json", ""].join("\n");
    const open = pendingAsides(text, () => "/repo");
    expect(open.map((row) => row.hash)).toEqual(["b".repeat(40)]);
    expect(open[0]?.repoDir).toBe("/repo");
    // A repo `workspace.yml` no longer names is not a stash this claims exists.
    expect(pendingAsides(text, () => null)).toEqual([]);
  });
});

describe("the notification carries it — in an existing kind's summary, never a new kind", () => {
  const ctx = { runId: "260829-build", root: "/w", at: "2026-08-29T09:00:00Z", stage: "04-build/build" };
  const log = [JSON.stringify({
    type: "worktree.foreign_work_restored",
    payload: {
      repo: "app", paths: ["notes.md"], stash_ref: "c".repeat(40), restored: false,
      command: "git -C /w/app stash pop stash@{0}", detail: "Aborting",
    },
  })].join("\n");

  test("`notRestoredSummary` is null on an ordinary run and a sentence when a pop was refused", () => {
    expect(notRestoredSummary("")).toBeNull();
    const summary = notRestoredSummary(log);
    expect(summary).toContain("foreign work NOT restored in app");
    expect(summary).toContain("stash cccccccccccc still holds notes.md");
    expect(summary).toContain("git -C /w/app stash pop stash@{0}");
    // A later successful restore of the same stash retires it.
    expect(notRestoredSummary(`${log}\n${JSON.stringify({
      type: "worktree.foreign_work_restored",
      payload: { repo: "app", stash_ref: "c".repeat(40), restored: true },
    })}`)).toBeNull();
  });

  test("`stage.done` and `run.finished` say it, and say nothing new when there is nothing to say", () => {
    const note = notRestoredSummary(log);
    expect(stageDoneNotification(ctx, 0.1, 0, note).kind).toBe("stage.done");
    expect(stageDoneNotification(ctx, 0.1, 0, note).summary).toContain("foreign work NOT restored in app");
    expect(stageDoneNotification(ctx, 0.1, 0).summary).toContain("No decision is waiting on you.");
    const ended = runEndNotification(ctx, 0, 0.1, "done", undefined, note);
    expect(ended.kind).toBe("run.finished");
    expect(ended.summary).toContain("foreign work NOT restored in app");
    expect(runEndNotification(ctx, 0, 0.1, "done").summary).not.toContain("foreign work");
  });
});

describe("the pathspec magic itself, measured against git", () => {
  /**
   * The one assertion that can tell `:(literal)` from a bare pathspec.
   *
   * Measured 2026-09-09 in a scratch repo: `git stash push -u -- 'a[b].txt'`
   * treats the name as a character class and takes the NEIGHBOUR `ab.txt` with
   * it — the tree came back empty. `:(literal)` takes exactly the file that was
   * named. The end-to-end case above cannot see this (there, both files are
   * foreign and both come back), which is why the seam is measured here directly:
   * an assertion that cannot fail is not a guard.
   */
  test("a bracket in a filename does not sweep the neighbour it would glob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-stash-"));
    try {
      const run = (args: readonly string[]) =>
        execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      run(["init", "-q", "."]);
      run(["config", "user.email", "t@example.com"]);
      run(["config", "user.name", "t"]);
      writeFileSync(join(dir, "seed"), "seed\n", "utf8");
      run(["add", "seed"]);
      run(["commit", "-qm", "seed"]);
      writeFileSync(join(dir, "a[b].txt"), "bracketed\n", "utf8");
      writeFileSync(join(dir, "ab.txt"), "neighbour\n", "utf8");

      const pushed = await stashPushPaths(dir, "tldrx x foreign work", ["a[b].txt"]);
      expect(pushed.ok).toBe(true);
      expect(pushed.hash).toMatch(/^[0-9a-f]{40}$/);
      // The neighbour a glob would have swallowed is untouched, on disk and in git.
      expect((await dirtyEntries(dir)).map((entry) => entry.path)).toEqual(["ab.txt"]);
      expect(readFileSync(join(dir, "ab.txt"), "utf8")).toBe("neighbour\n");
      expect(existsSync(join(dir, "a[b].txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** `-z` is what makes those names come back as bytes rather than as git's quoting. */
  test("`dirtyEntries` returns the real path, not a quoted-and-escaped one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-status-"));
    try {
      const run = (args: readonly string[]) =>
        execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      run(["init", "-q", "."]);
      writeFileSync(join(dir, "we ird[1].txt"), "x\n", "utf8");
      writeFileSync(join(dir, "-dash.txt"), "x\n", "utf8");
      const entries = await dirtyEntries(dir);
      expect(entries.map((entry) => entry.path).sort()).toEqual(["-dash.txt", "we ird[1].txt"]);
      expect(entries.every((entry) => entry.code === "??")).toBe(true);
      expect(entries.some((entry) => entry.path.startsWith('"'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a refusal AFTER the stash gives the work back before it returns", () => {
  /**
   * The reviewer's Critical, reproduced (2026-09-09). The stash used to be taken at
   * the FIRST door, so the second and third doors — the foreign-epic refusal and
   * the base pre-flight — could refuse with the operator's files already in a
   * stash, through a return path that never restored and never even printed the
   * line saying they had been moved. Re-running refused forever, in a tree that was
   * now missing the file.
   *
   * Two halves, and they are different fixes. The epic door now runs BEFORE the
   * stash, so it can no longer strand anything: nothing is moved at all. The base
   * pre-flight is the one refusal that must stay AFTER the stash — a pre-flight
   * over a dirty tree is the measurement this whole guard exists to protect — so
   * that path is the one that has to restore on its way out.
   */
  test("the foreign-epic refusal never reaches the stash: nothing is moved and nothing is left behind", async () => {
    const ws = workspace(ONE_STORY);
    writeFileSync(join(ws.repoDir, "export.csv"), "id,value\n1,2\n", "utf8");
    // An `epic/e1` this run did not cut — the second door.
    git(ws, ["branch", "epic/e1"]);

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");
    expect(outcome.code, said).toBe(2);
    expect(said).toContain("did not cut it");
    // The operator's file never moved, and there is no stash to find.
    expect(readFileSync(join(ws.repoDir, "export.csv"), "utf8")).toBe("id,value\n1,2\n");
    expect(git(ws, ["stash", "list"])).toBe("");
    expect(eventsOfType(ws, "worktree.foreign_work_aside")).toHaveLength(0);
  });

  test("the base pre-flight refusal restores on its way out, and says both halves", async () => {
    const ws = workspace({ ...ONE_STORY, testScript: `${PROBE_SCRIPT} && node -e "process.exit(1)"` });
    writeFileSync(join(ws.repoDir, "export.csv"), "id,value\n1,2\n", "utf8");

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");
    // Exit 2, the workspace-config refusal — unchanged by any of this.
    expect(outcome.code, said).toBe(2);
    expect(said).toContain("already fail on the untouched base tree");
    // The pre-flight measured a CLEAN tree, which is why the stash happens first.
    expect(baseProbes(ws)[0]?.st).toBe("");
    // And the refusal carries both sentences, so the operator is never told a
    // stash was taken by silence.
    expect(said).toContain("set aside in stash ");
    expect(said).toContain("foreign work restored from stash ");
    // The file is back and the stash is gone.
    expect(readFileSync(join(ws.repoDir, "export.csv"), "utf8")).toBe("id,value\n1,2\n");
    expect(git(ws, ["stash", "list"])).toBe("");
    const restored = eventsOfType(ws, "worktree.foreign_work_restored");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.restored).toBe(true);
  });
});

describe("the PRINTED remedy is the same command the engine runs", () => {
  /**
   * The reviewer's Important 1, reproduced: the printed line joined RAW paths
   * while the engine passed `:(literal)`, so the docstring's promise — "printed by
   * the refusal and RUN by the engine from the same function" — was false, and the
   * printed line for `[x].txt` moved `x.txt` instead.
   */
  test("running the printed line verbatim in a shell moves exactly the named files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-remedy-"));
    try {
      const run = (args: readonly string[]) =>
        execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      run(["init", "-q", "."]);
      run(["config", "user.email", "t@example.com"]);
      run(["config", "user.name", "t"]);
      writeFileSync(join(dir, "seed"), "seed\n", "utf8");
      run(["add", "seed"]);
      run(["commit", "-qm", "seed"]);
      for (const name of ["[x].txt", "x.txt", "a b.txt", "-dash.txt"]) {
        writeFileSync(join(dir, name), `${name}\n`, "utf8");
      }

      const printed = stashCommand(dir, "260829-build", ["[x].txt", "a b.txt", "-dash.txt"]);
      execFileSync("sh", ["-c", printed], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      // `x.txt` is the file a glob would have taken instead. It is still here.
      expect(execFileSync("git", ["status", "--porcelain", "-z"], { cwd: dir, encoding: "utf8" }))
        .toBe("?? x.txt\0");
      expect(readFileSync(join(dir, "x.txt"), "utf8")).toBe("x.txt\n");
      for (const name of ["[x].txt", "a b.txt", "-dash.txt"]) {
        expect(existsSync(join(dir, name))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the index survives the round trip", () => {
  /**
   * The reviewer's Important 2, reproduced: the restore popped without `--index`,
   * so a path that was STAGED at one version and modified further in the worktree
   * — the shape one of the three measured workspaces actually had, a script and a
   * `package.json` line staged in a sub-repo — came back with the staging gone.
   * Measured: `git show :f.txt` read `A` (the commit) instead of `B` (what was
   * staged), and `git status` read ` M` instead of `MM`.
   */
  test("HEAD A, staged B, worktree C comes back staged B and worktree C", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-index-"));
    try {
      const run = (args: readonly string[]) =>
        execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      run(["init", "-q", "."]);
      run(["config", "user.email", "t@example.com"]);
      run(["config", "user.name", "t"]);
      writeFileSync(join(dir, "f.txt"), "A\n", "utf8");
      run(["add", "f.txt"]);
      run(["commit", "-qm", "A"]);
      writeFileSync(join(dir, "f.txt"), "B\n", "utf8");
      run(["add", "f.txt"]);
      writeFileSync(join(dir, "f.txt"), "C\n", "utf8");
      expect(run(["status", "--porcelain"]).trim()).toBe("MM f.txt");

      const pushed = await stashPushPaths(dir, "tldrx x foreign work", ["f.txt"]);
      expect(pushed.ok).toBe(true);
      expect(run(["status", "--porcelain"]).trim()).toBe("");

      const back = await restoreForeignWork({
        repo: "app", repoDir: dir, paths: ["f.txt"], hash: pushed.hash, message: pushed.message,
      });
      expect(back.restored).toBe(true);
      expect(back.indexRestored).toBe(true);
      expect(run(["status", "--porcelain"]).trim()).toBe("MM f.txt");
      expect(run(["show", ":f.txt"])).toBe("B\n");
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("C\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
