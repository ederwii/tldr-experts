/**
 * The Build DoD gate is a DELTA gate — issue #41.
 *
 * A `dod` block proves one thing: *this story did not break the tree*. That claim
 * is only meaningful if the tree was unbroken to begin with, and until 2026-08-31
 * nothing checked. Measured on the live run `260829-scoring-leaderboard`: two of
 * the three commands `workspace.yml` declared exited non-zero on **pristine main**
 * (a bare `dotnet test` ran two paid `Live` tests the repo's own CI excludes;
 * `dotnet format --verify-no-changes` flagged 336 files), so all 15 stories in the
 * plan would have blocked identically — each one charged a developer turn for a
 * workspace-configuration error, and each one told the operator the STORY was red.
 *
 * So: run the gate commands on the untouched base tree once, at Build entry,
 * before a single story is dispatched. Nonzero there is a config error and it
 * halts Build by name. Every test below runs the real pipeline against a real git
 * repo — only the two sub-agents are faked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import {
  baseResultFor, emitPreflightYaml, failedOnBase, loadPreflight, parsePreflight,
  preExistingFailureReason, PREFLIGHT_REL as SOURCE_PREFLIGHT_REL, savePreflight, withResult,
  type BaseCommandResult, type BasePreflight,
} from "../src/core/build/preflight.ts";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";

/** Where the run keeps what it learned about the base tree (files are the state). */
const PREFLIGHT_REL = "04-build/preflight.yml";

const ORIGINAL_PATH = process.env.PATH ?? "";

/**
 * Red wherever it runs, and it counts its own runs.
 *
 * The tick file is what proves the base check is paid for ONCE per run: a second
 * `tldrx next` on the same run must read the cache, not the repo. `TICKS_MARK` is
 * substituted for a real path by `workspace()` below — an env var cannot carry it,
 * because a `process.env` key SET AT RUNTIME does not reach a `Bun.spawn` child
 * (measured here: the child read `undefined`), and the whole point of this file is
 * not to trust an instrument that cannot observe the thing.
 */
const TICKS_MARK = "__TICKS__";
const RED_ON_BASE =
  `node -e "require('fs').appendFileSync('${TICKS_MARK}', 'x'); process.exit(1)"`;

/**
 * Green on the untouched tree, red once a developer has written its story file.
 *
 * This is what the fixture's old `process.exit(1)` script MEANT — "the story
 * broke it" — and could not express: a command that fails on main too is now a
 * workspace-config error, so a test about a story that cannot prove itself has to
 * fail for the story's own reason.
 */
const RED_ONLY_AFTER_DEVELOPER =
  'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"';

let open: BuildWorkspace[] = [];
let ticks: string | null = null;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_BUILD_COST;
  delete process.env.FAKE_BUILD_STATE;
  for (const ws of open) ws.dispose();
  open = [];
  if (ticks !== null) rmSync(ticks, { force: true });
  ticks = null;
});

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  ticks = join(mkdtempSync(join(tmpdir(), "tldrx-ticks-")), "ticks");
  const made = makeBuildWorkspace(
    options.testScript === undefined
      ? options
      : { ...options, testScript: options.testScript.replaceAll(TICKS_MARK, ticks) },
  );
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
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

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

function events(ws: BuildWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function tickCount(): number {
  return ticks !== null && existsSync(ticks) ? readFileSync(ticks, "utf8").length : 0;
}

const ONE: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

// ---------------------------------------------------------------------------

describe("the base-tree pre-flight", () => {
  test("a gate command that already fails on pristine main refuses Build, and no story is dispatched", async () => {
    const ws = workspace({ ...ONE, testScript: RED_ON_BASE });

    const outcome = await next(ws);

    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    // The error names the COMMAND and its EXIT CODE, and blames workspace.yml.
    expect(text).toContain("npm run test");
    expect(text).toContain("exited 1");
    expect(text).toContain(".tldrx/workspace.yml");
    expect(text).toContain("base tree");
    // Nothing was dispatched, nothing was charged, nothing was cut.
    expect(story(ws, "S1")).toContain("status: todo");
    expect(events(ws).filter((e) => e.type === "task.started")).toEqual([]);
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0);
    expect(() => git(ws, ["rev-parse", "--verify", "epic/e1"])).toThrow();
  }, 60_000);

  test("the base check is paid for once per run and cached in the run's own files", async () => {
    const ws = workspace({ ...ONE, testScript: RED_ON_BASE });

    await next(ws);
    expect(tickCount()).toBe(1);
    expect(existsSync(join(ws.runDir, PREFLIGHT_REL))).toBe(true);
    const cached = readFileSync(join(ws.runDir, PREFLIGHT_REL), "utf8");
    expect(cached).toContain("npm run test");

    // A second invocation refuses again — from the cache, without re-running it.
    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });
    expect(again.code).toBe(2);
    expect(tickCount()).toBe(1);
  }, 90_000);

  test("gates green on base and red on the story tree block the story, exactly as before", async () => {
    const ws = workspace({ ...ONE, testScript: RED_ONLY_AFTER_DEVELOPER });

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    expect(story(ws, "S1")).toContain("status: blocked");
    const failed = events(ws).filter((e) => e.type === "check.failed" && e.payload.check === "dod");
    expect(failed[0]?.payload.command).toBe("npm run test");
    expect(failed[0]?.payload.story).toBe("S1");
    // And the pre-flight recorded that the base itself was fine.
    expect(readFileSync(join(ws.runDir, PREFLIGHT_REL), "utf8")).toContain("exit_code: 0");
  }, 60_000);

  test("a green base leaves the run exactly where it was — the story still reaches done", async () => {
    const ws = workspace(ONE);

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    expect(story(ws, "S1")).toContain("status: done");
  }, 60_000);
});

// ---------------------------------------------------------------------------

/** One measured row, with a tail nasty enough to be worth escaping. */
function row(over: Partial<BaseCommandResult> = {}): BaseCommandResult {
  return {
    repo: "app",
    command: "npm run test",
    baseRef: "main",
    baseSha: "68e4d21",
    exitCode: 1,
    timedOut: false,
    tail: 'FAIL "two" lines\nand a second one',
    status: "failed",
    ...over,
  };
}

describe("the pre-flight cache file", () => {
  test("lives where this file's integration tests look for it", () => {
    expect(SOURCE_PREFLIGHT_REL).toBe(PREFLIGHT_REL);
  });

  test("round-trips a tail with newlines and quotes — issue #13 does not come back", () => {
    const preflight: BasePreflight = {
      checkedAt: "2026-08-31T09:00:00Z",
      results: [row(), row({ command: "npm run build", exitCode: 0, tail: "", status: "ok" })],
    };

    const text = emitPreflightYaml(preflight);

    // The tail is one YAML scalar, not two lines of broken document.
    expect(text.split("\n").filter((line) => line.includes("and a second one")).length).toBe(1);
    expect(parsePreflight(text)).toEqual(preflight);
  });

  test("a sha of all digits survives the round trip", () => {
    const preflight: BasePreflight = { checkedAt: "", results: [row({ baseSha: "1234567" })] };
    expect(parsePreflight(emitPreflightYaml(preflight))?.results[0]?.baseSha).toBe("1234567");
  });

  test("a missing or unreadable cache is null, never a throw — an in-flight run keeps working", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-preflight-"));
    // The shape every run that entered Build on an older binary is in.
    expect(loadPreflight(dir)).toBeNull();

    mkdirSync(join(dir, "04-build"), { recursive: true });
    writeFileSync(join(dir, PREFLIGHT_REL), "results: [broken\n", "utf8");
    expect(loadPreflight(dir)).toBeNull();

    writeFileSync(join(dir, PREFLIGHT_REL), "version: 1\nresults:\n  - repo: app\n", "utf8");
    expect(loadPreflight(dir)).toBeNull();

    savePreflight(dir, { checkedAt: "2026-08-31T09:00:00Z", results: [row()] });
    expect(loadPreflight(dir)?.results[0]?.command).toBe("npm run test");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("attributing a red DoD command", () => {
  const preflight: BasePreflight = {
    checkedAt: "2026-08-31T09:00:00Z",
    results: [
      row(),
      row({ command: "npm run build", exitCode: 0, tail: "", status: "ok" }),
      row({ command: "npm run lint", exitCode: 126, tail: "needs a shell", status: "unmeasured" }),
    ],
  };

  test("a command red on base too is the BASE's fault, and the reason says so", () => {
    const hit = baseResultFor(preflight, "app", "npm run test");
    expect(failedOnBase(hit)).toBe(true);
    const reason = preExistingFailureReason(hit as BaseCommandResult);
    expect(reason).toContain("pre-existing failure on the base tree");
    expect(reason).toContain(".tldrx/workspace.yml");
    expect(reason).toContain("npm run test");
  });

  test("a command green on base leaves the story to answer for itself", () => {
    expect(failedOnBase(baseResultFor(preflight, "app", "npm run build"))).toBe(false);
  });

  test("a command the gate declined to run excuses nothing — `unmeasured` is not evidence", () => {
    expect(failedOnBase(baseResultFor(preflight, "app", "npm run lint"))).toBe(false);
  });

  test("nothing measured is null, so the caller measures it rather than guessing", () => {
    expect(baseResultFor(preflight, "app", "npm run typecheck")).toBeNull();
    expect(baseResultFor(preflight, "other", "npm run test")).toBeNull();
    expect(baseResultFor(null, "app", "npm run test")).toBeNull();
  });

  test("a result taken at a base that has since moved is not reused", () => {
    expect(baseResultFor(preflight, "app", "npm run test", "68e4d21")?.exitCode).toBe(1);
    expect(baseResultFor(preflight, "app", "npm run test", "aaaaaaa")).toBeNull();
  });

  test("a re-measurement replaces the row it supersedes rather than stacking on it", () => {
    const updated = withResult(preflight, row({ exitCode: 0, status: "ok", tail: "" }), "2026-08-31T10:00:00Z");
    expect(updated.results.filter((r) => r.command === "npm run test").length).toBe(1);
    expect(failedOnBase(baseResultFor(updated, "app", "npm run test"))).toBe(false);
    expect(updated.checkedAt).toBe("2026-08-31T10:00:00Z");
  });
});
