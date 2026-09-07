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
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import {
  baseRefusalLines, baseResultFor, commandHash, emitPreflightYaml, failedOnBase, loadPreflight, parsePreflight,
  preExistingFailureReason, PREFLIGHT_REL as SOURCE_PREFLIGHT_REL, PREFLIGHT_RED_TTL_MS, savePreflight, withResult,
  type BaseCommandResult, type BasePreflight,
} from "../src/core/build/preflight.ts";
import { loadWorkspace, type WorkspaceContext } from "../src/hooks/lib/workspace.ts";
import type { CommandProbeRecord } from "../src/core/schemas/workspace.ts";
import { PreflightCache } from "../src/core/build/dodRunner.ts";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

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
 * Green wherever it runs, and it counts its own runs — `RED_ON_BASE`'s mirror.
 *
 * The red cases pin that a stale red is re-measured; nothing pinned the other
 * half END TO END, and the green rule is the one the cache leans on hardest: a
 * green survives the 30-minute red TTL, a changed command hash and `--prepare`,
 * all three of which invalidate a red. `baseResultFor`'s unit tests assert that
 * from a hand-built `BasePreflight`; this asserts the real pipeline reads it
 * back off `04-build/preflight.yml` and does not touch the repo again.
 */
const GREEN_ON_BASE =
  `node -e "require('fs').appendFileSync('${TICKS_MARK}', 'x'); process.exit(0)"`;

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

  test("a fresh cached red refuses again without re-running the command", async () => {
    const ws = workspace({ ...ONE, testScript: RED_ON_BASE });

    await next(ws);
    expect(tickCount()).toBe(1);
    expect(existsSync(join(ws.runDir, PREFLIGHT_REL))).toBe(true);
    const cached = readFileSync(join(ws.runDir, PREFLIGHT_REL), "utf8");
    expect(cached).toContain("npm run test");
    expect(cached).toContain("command_hash:");

    // Five minutes later, same workspace: the cache answers and the repo is not touched.
    const again = await next(ws, { at: "2026-08-29T09:05:00Z" });
    expect(again.code).toBe(2);
    expect(tickCount()).toBe(1);
  }, 90_000);

  test("a red older than the TTL is measured again rather than trusted", async () => {
    // The whole point: a base tree moves, and a red is the answer that costs the
    // most to be wrong about — it blocks every story in the plan.
    const ws = workspace({ ...ONE, testScript: RED_ON_BASE });

    await next(ws);
    expect(tickCount()).toBe(1);

    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });
    expect(again.code).toBe(2);
    expect(tickCount()).toBe(2);
  }, 90_000);

  test("a cached GREEN is not re-measured either — a second invocation never touches the repo", async () => {
    // `--prepare`, deliberately: it is the mode that ALWAYS re-probes a red, so
    // a green surviving it is the strongest form of the rule — and it is also
    // the only mode that leaves the story pending, which is what keeps this
    // instrument honest. `refuseOnRedBase` walks `pendingStories()`, so if the
    // story had settled, tick count 1 would mean "nothing asked", not "the cache
    // answered". S1 is still `in_progress` on the second call, so the question
    // IS asked both times.
    const ws = workspace({ ...ONE, testScript: GREEN_ON_BASE });

    const first = await next(ws, { mode: "prepare" });
    expect(first.code).toBe(0);
    expect(tickCount()).toBe(1);
    const cached = readFileSync(join(ws.runDir, PREFLIGHT_REL), "utf8");
    expect(cached).toContain("npm run test");
    expect(cached).toContain("exit_code: 0");
    expect(story(ws, "S1")).toContain("status: in_progress");

    // Fourteen hours later — well past the 30-minute TTL that invalidates a RED.
    const again = await next(ws, { mode: "prepare", at: "2026-08-29T23:00:00Z" });

    expect(tickCount()).toBe(1);
    // Not a refusal, and not because nothing was asked: the story is still the
    // pending one this invocation looked the base up for.
    expect(again.code).not.toBe(2);
    expect(story(ws, "S1")).toContain("status: in_progress");
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
  // The builder obeys the rule the type states (#165): a row that was REFUSED
  // carries no exit code, so an override saying so gets none rather than the
  // default 1. One builder, not two, so every caller is the same shape.
  const refused = over.refusedBecause !== undefined;
  return {
    repo: "app",
    command: "npm run test",
    baseRef: "main",
    baseSha: "68e4d21",
    ...(refused ? {} : { exitCode: 1 }),
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
      row({ command: "npm run lint", status: "unmeasured", refusedBecause: "needs a shell", tail: "needs a shell" }),
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

describe("when a cached RED may still be trusted", () => {
  const HASH = "0123456789ab";
  const red: BasePreflight = {
    checkedAt: "2026-08-31T09:00:00Z",
    results: [row({ commandHash: HASH, checkedAt: "2026-08-31T09:00:00Z" })],
  };
  const green: BasePreflight = {
    checkedAt: "2026-08-31T09:00:00Z",
    results: [row({
      exitCode: 0, status: "ok", tail: "",
      commandHash: HASH, checkedAt: "2026-08-31T09:00:00Z",
    })],
  };

  test("a fresh red, same command hash, is served from the cache", () => {
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-08-31T09:20:00Z",
    });
    expect(failedOnBase(hit)).toBe(true);
  });

  test("a red older than the TTL is null, so the caller re-probes", () => {
    // 30 minutes. A base tree is a moving thing and a red is the answer that
    // costs the most to be wrong about: every story blocks for it.
    expect(PREFLIGHT_RED_TTL_MS).toBe(30 * 60 * 1000);
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-08-31T09:31:00Z",
    });
    expect(hit).toBeNull();
  });

  test("a red measured under a different command hash is null — the operator's fix is visible", () => {
    // The refusal tells the operator to fix `.tldrx/workspace.yml`. The command
    // string can come back byte-identical from that edit while everything AROUND
    // it changed, and joining on the string alone made the fix invisible.
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: "ffffffffffff", at: "2026-08-31T09:01:00Z",
    });
    expect(hit).toBeNull();
  });

  test("under --prepare a red is always re-probed, however fresh", () => {
    // A `--prepare` that returns a refusal in 0 seconds over a base nobody
    // measured today is the lie this is about.
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-08-31T09:00:30Z", prepare: true,
    });
    expect(hit).toBeNull();
  });

  test("a cached GREEN keeps today's rule — hash, age and --prepare change nothing", () => {
    for (const freshness of [
      { commandHash: "ffffffffffff", at: "2026-09-30T09:00:00Z" },
      { commandHash: HASH, at: "2026-09-30T09:00:00Z", prepare: true },
    ]) {
      expect(baseResultFor(green, "app", "npm run test", "", freshness)?.exitCode).toBe(0);
    }
  });

  test("an unmeasured row is not re-probed either — the gate declined to run it", () => {
    const unmeasured: BasePreflight = {
      checkedAt: "2026-08-31T09:00:00Z",
      results: [row({ status: "unmeasured", refusedBecause: "needs a shell", tail: "needs a shell" })],
    };
    expect(baseResultFor(unmeasured, "app", "npm run test", "", {
      at: "2026-09-30T09:00:00Z", prepare: true,
    })?.status).toBe("unmeasured");
  });

  test("a row with no clock and no hash is never invalidated by their absence", () => {
    // The same rule the sha comparison already follows: a missing answer is not a
    // mismatch. Every preflight.yml written before these fields existed is in
    // exactly this shape.
    const old: BasePreflight = { checkedAt: "", results: [row()] };
    expect(failedOnBase(baseResultFor(old, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-09-30T09:00:00Z",
    }))).toBe(true);
  });

  test("the hash covers the workspace allowlist, not only the command string", () => {
    expect(commandHash("npm run test", ["npm run test"]))
      .not.toBe(commandHash("npm run test", ["npm run test", "npm run lint"]));
    expect(commandHash("npm run test", ["a", "b"])).toBe(commandHash("npm run test", ["b", "a"]));
    expect(commandHash("npm run test", [])).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the new keys round-trip and are written only when present", () => {
    const text = emitPreflightYaml(red);
    expect(text).toContain("command_hash:");
    expect(parsePreflight(text)).toEqual(red);

    const bare = emitPreflightYaml({ checkedAt: "", results: [row()] });
    expect(bare).not.toContain("command_hash");
    expect(parsePreflight(bare)?.results[0]?.commandHash).toBeUndefined();
  });

  test("a hash that looks like scientific notation still round-trips as a string", () => {
    // Measured: fed 200,000 random 12-hex hashes through emit → parse, 0.428% came
    // back wrong when `command_hash` was written raw — a digit-leading hex string
    // that also contains an `e` (hex is 0-9a-f, so this is common) is a valid YAML
    // float literal in scientific notation. `123456789e12` parsed back as the
    // NUMBER 123456789e12, not the string. Two shapes of the same bug, pinned so
    // emitting it raw again reddens both.
    const withE: BasePreflight = {
      checkedAt: "2026-08-31T09:00:00Z",
      results: [row({ commandHash: "123456789e12", checkedAt: "2026-08-31T09:00:00Z" })],
    };
    expect(parsePreflight(emitPreflightYaml(withE))).toEqual(withE);

    const zeroE: BasePreflight = {
      checkedAt: "2026-08-31T09:00:00Z",
      results: [row({ commandHash: "0e1234567890", checkedAt: "2026-08-31T09:00:00Z" })],
    };
    expect(parsePreflight(emitPreflightYaml(zeroE))).toEqual(zeroE);
  });
});

describe("the base pre-flight is read from disk once per process", () => {
  /**
   * `basePreflight()` was lazy AND memoised: first call loads
   * `04-build/preflight.yml`, every later one reads memory. A `PreflightCache`
   * that reloaded per call would make a resumed run re-pay for the exact command
   * the file exists to remember — a `dotnet test` charged twice, silently. The
   * counter is on the class for this test and for nothing else.
   */
  test("ten reads and a write are one disk load", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-preflight-"));
    const cache = new PreflightCache(dir);
    for (let i = 0; i < 10; i++) cache.read();
    cache.remember({
      repo: "app", command: "npm run test", baseRef: "main", baseSha: "abc1234",
      exitCode: 0, timedOut: false, tail: "", status: "ok",
      commandHash: commandHash("npm run test", ["npm run test"]),
    }, "2026-08-29T09:00:00Z");
    cache.read();
    expect(cache.loads).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * #165 — the base side of a REFUSED command.
 *
 * `baseResultOf` used to write `exit_code: 126` beside `status: unmeasured`:
 * nothing ran, so the number was a fabrication that `preflight.yml` then carried
 * as a record. `unmeasured` already means "nothing was learned about the base",
 * and it now carries no exit code and the gate's own sentence instead.
 *
 * Both directions of the `version: 1` rule are pinned here: a file written
 * BEFORE this change still loads with its 126 intact (rewriting history is not
 * this change's job), and a file written after it round-trips without growing one.
 */
describe("#165 · a refused base probe carries no exit code", () => {
  test("the base side records a refusal as `unmeasured` with no exit code either", () => {
    const preflight: BasePreflight = {
      checkedAt: "2026-08-31T09:00:00Z",
      results: [row({ command: "npm run lint", status: "unmeasured", refusedBecause: "needs a shell" })],
    };
    const hit = baseResultFor(preflight, "app", "npm run lint");
    expect(hit?.status).toBe("unmeasured");
    expect(hit?.exitCode).toBeUndefined();
    // `unmeasured` still excuses nothing — the rule this file already pins.
    expect(failedOnBase(hit)).toBe(false);
  });

  test("a preflight.yml written BEFORE this — `exit_code: 126` + unmeasured — still loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-preflight-compat-"));
    mkdirSync(join(dir, "04-build"), { recursive: true });
    writeFileSync(join(dir, PREFLIGHT_REL),
      "version: 1\nchecked_at: '2026-08-31T09:00:00Z'\nresults:\n"
      + "  - repo: app\n    command: npm run lint\n    base_ref: main\n    base_sha: abc1234\n"
      + "    exit_code: 126\n    timed_out: false\n    tail: needs a shell\n    status: unmeasured\n",
      "utf8");
    const loaded = loadPreflight(dir);
    expect(loaded?.results[0]?.status).toBe("unmeasured");
    expect(loaded?.results[0]?.command).toBe("npm run lint");
    expect(loaded?.results[0]?.exitCode).toBe(126);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a refused row round-trips through the file without growing an exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-preflight-refused-"));
    mkdirSync(join(dir, "04-build"), { recursive: true });
    savePreflight(dir, {
      checkedAt: "2026-09-06T09:00:00Z",
      results: [row({ command: "npm run lint", status: "unmeasured", refusedBecause: "needs a shell" })],
    });
    const back = loadPreflight(dir)?.results[0];
    expect(back?.exitCode).toBeUndefined();
    expect(back?.refusedBecause).toBe("needs a shell");
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * #165 fix round 1 — the tolerance is EXACTLY the hole the ruling opened.
 *
 * The first version dropped `exit_code` from the row guard entirely, which let
 * two corrupt shapes through where the file used to be rejected and re-measured:
 * a PRESENT but non-numeric `exit_code`, and an `exit_code`-less `status: ok`.
 * The second is the dangerous one — `baseResultFor` returns every non-`failed`
 * row as a cached answer, so a hand-edited or truncated `status: ok` row became
 * a cached GREEN base and the Build-entry gate skipped that command.
 *
 * The rule: a row is valid iff it carries a finite INTEGER `exit_code`, or it is
 * `unmeasured` with a non-empty `refused_because` and no `exit_code` at all.
 * Anything else invalidates the whole file, exactly as before.
 */
describe("#165 · only a refusal may lack an exit code", () => {
  /** One `results:` entry, as raw YAML lines under a `version: 1` header. */
  function fileWith(lines: readonly string[]): string {
    return `version: 1\nchecked_at: '2026-08-31T09:00:00Z'\nresults:\n${lines.join("\n")}\n`;
  }

  const HEAD = ["  - repo: app", "    command: npm run test", "    base_ref: main", "    base_sha: abc1234"];

  test("a PRESENT but non-numeric `exit_code` invalidates the file, as it always did", () => {
    for (const junk of ['    exit_code: "0"', "    exit_code: null", "    exit_code: not-a-number"]) {
      expect(parsePreflight(fileWith([...HEAD, junk, "    timed_out: false", "    status: ok", "    tail: ''"])))
        .toBeNull();
    }
  });

  test("a fractional exit code is not an exit code either", () => {
    expect(parsePreflight(fileWith([...HEAD, "    exit_code: 1.5", "    timed_out: false", "    status: failed", "    tail: ''"])))
      .toBeNull();
  });

  test("an `exit_code`-less `status: ok` row invalidates the file — it would read as a cached GREEN base", () => {
    for (const status of ["ok", "failed"]) {
      expect(parsePreflight(fileWith([...HEAD, "    timed_out: false", `    status: ${status}`, "    tail: ''"])))
        .toBeNull();
    }
  });

  test("an `exit_code`-less `unmeasured` row with NO reason is malformed too — absent-WITH-REASON or nothing", () => {
    expect(parsePreflight(fileWith([...HEAD, "    timed_out: false", "    status: unmeasured", "    tail: ''"])))
      .toBeNull();
  });

  test("a well-formed refused row loads, and is neither a pass nor a failure", () => {
    const loaded = parsePreflight(fileWith([
      ...HEAD, "    timed_out: false", "    status: unmeasured", "    tail: needs a shell",
      "    refused_because: needs a shell",
    ]));
    const only = loaded?.results[0];
    expect(only?.status).toBe("unmeasured");
    expect(only?.exitCode).toBeUndefined();
    expect(only?.refusedBecause).toBe("needs a shell");
    // Not green, and not red: `baseResultFor` hands it back as "nothing was
    // learned", which excuses nothing and refuses nothing.
    expect(failedOnBase(baseResultFor(loaded, "app", "npm run test"))).toBe(false);
    expect(baseResultFor(loaded, "app", "npm run test")?.exitCode).toBeUndefined();
  });
});

/**
 * The refusal cites `tldrx init`'s own probe when there is one (#168).
 *
 * The base-tree refusal already tells the operator WHICH command is red. When
 * `workspace.yml` carries a `command_probes:` row saying `init` measured the same
 * command red on the day the workspace was created, saying so costs one line and saves
 * the search. It changes no verdict, and it is silent for every file written before the
 * key existed.
 */
describe("the base refusal cites init's probe when one exists", () => {
  const failure: BaseCommandResult = {
    repo: "app", command: "npm run test", status: "failed", exitCode: 1, timedOut: false,
    baseRef: "main", baseSha: "abc1234", tail: "1 failing",
  };

  function context(probes: Record<string, CommandProbeRecord>): WorkspaceContext {
    return {
      root: "/w",
      repos: new Map([["app", "."]]),
      commands: new Set(["npm run test"]),
      repoCommands: new Map([["app", ["npm run test"]]]),
      commandRoles: new Map([["app", new Map([["test", "npm run test"]])]]),
      commandProbes: new Map([["app", new Map(Object.entries(probes))]]),
      defaultBranches: new Map([["app", "main"]]),
      seedTriageThresholdTokens: null,
    };
  }

  test("a probe that measured the same command red is quoted, once", () => {
    const lines = baseRefusalLines([failure], context({
      test: {
        status: "failed", verified: false, exit_code: 1, at: "2026-09-06T09:00:00Z",
        reason: "not verified: `npm run test` exited 1",
      },
    }));
    const cited = lines.filter((line) => line.includes("`tldrx init` measured this red too"));
    expect(cited).toHaveLength(1);
    expect(cited[0]).toContain("2026-09-06T09:00:00Z");
    expect(cited[0]).toContain("not verified: `npm run test` exited 1");
  });

  /**
   * TWO slots can declare the same command (`test:` and `lint:` both `npm run
   * test`), and `probeCommands` writes a row per SLOT — so the probe that
   * measured this command red may sit in the second one. `initProbeLine`
   * returned `null` from inside the loop on the first slot that matched by
   * command, which read as "scan the slots" and behaved as "consult one".
   * Cosmetic — a missing line, never a wrong one — but a loop that stops on its
   * first match is the shape a later reader trusts to be a scan.
   */
  test("the same command in TWO slots is cited from whichever slot was probed red", () => {
    const twoSlots: WorkspaceContext = {
      ...context({}),
      commandRoles: new Map([["app", new Map([["test", "npm run test"], ["lint", "npm run test"]])]]),
      commandProbes: new Map([["app", new Map(Object.entries({
        // `test:` was skipped, so it corroborates nothing; `lint:` ran the SAME
        // command and measured it red.
        test: {
          status: "skipped", verified: false, exit_code: null, at: "2026-09-06T09:00:00Z",
          reason: "skipped: --no-probe",
        },
        lint: {
          status: "failed", verified: false, exit_code: 1, at: "2026-09-06T09:30:00Z",
          reason: "not verified: `npm run test` exited 1",
        },
      }))]]),
    };

    const cited = baseRefusalLines([failure], twoSlots)
      .filter((line) => line.includes("`tldrx init` measured this red too"));
    expect(cited).toHaveLength(1);
    expect(cited[0]).toContain("2026-09-06T09:30:00Z");
  });

  test("a green probe, an unrun one, and no workspace at all each say nothing", () => {
    const green = baseRefusalLines([failure], context({
      test: {
        status: "ok", verified: true, exit_code: 0, at: "2026-09-06T09:00:00Z", reason: "verified: exited 0",
      },
    }));
    // `exit_code: null` is "we did not look" — a timeout, a skip. Not corroboration.
    const unrun = baseRefusalLines([failure], context({
      test: {
        status: "skipped", verified: false, exit_code: null, at: "2026-09-06T09:00:00Z",
        reason: "skipped: --no-probe",
      },
    }));
    const none = baseRefusalLines([failure]);
    for (const lines of [green, unrun, none]) {
      expect(lines.some((line) => line.includes("measured this red too"))).toBe(false);
    }
    // And the refusal itself is unchanged in every case — the citation is additive.
    expect(none).toEqual(baseRefusalLines([failure], context({})));
  });
});

/**
 * The whole path, off disk: `workspace.yml` → `loadWorkspace` → the refusal line (#168).
 *
 * Everything above builds a `WorkspaceContext` by hand, so nothing proved that
 * `command_probes:` written by `init` is read back the way the refusal expects — and the
 * loader's "a malformed row is skipped, never defaulted" claim was a docstring, not a
 * result. This writes the YAML, reads it with the shipped loader, and feeds the context
 * it produces to the shipped refusal.
 */
describe("command_probes survives the round trip from workspace.yml", () => {
  const AT = "2026-09-06T09:00:00Z";
  let root = "";

  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function workspaceWith(probes: string): string {
    root = mkdtempSync(join(tmpdir(), "tldrx-probe-load-"));
    mkdirSync(join(root, ".tldrx"), { recursive: true });
    writeFileSync(join(root, ".tldrx", "workspace.yml"),
      "version: 1\nmode: single-repo\nroot: .\nrepos:\n"
      + "  - name: app\n    path: .\n    default_branch: main\n"
      + "    commands:\n      build: npm run build\n      test: npm run test\n"
      + probes, "utf8");
    return root;
  }

  test("a well-formed row is read into the context and reaches the refusal line", () => {
    const dir = workspaceWith(
      "    command_probes:\n"
      + "      test:\n        status: failed\n        verified: false\n        exit_code: 1\n"
      + `        at: ${AT}\n        reason: "not verified: npm run test exited 1"\n`,
    );
    const workspace = loadWorkspace(dir);
    const probe = workspace.commandProbes.get("app")?.get("test");
    expect(probe?.status).toBe("failed");
    expect(probe?.exit_code).toBe(1);
    expect(probe?.at).toBe(AT);

    const failure: BaseCommandResult = {
      repo: "app", command: "npm run test", status: "failed", exitCode: 1, timedOut: false,
      baseRef: "main", baseSha: "abc1234", tail: "1 failing",
    };
    const cited = baseRefusalLines([failure], workspace)
      .filter((line) => line.includes("`tldrx init` measured this red too"));
    expect(cited).toHaveLength(1);
    expect(cited[0]).toContain(AT);
  });

  test("a malformed row is skipped, never defaulted into a verdict", () => {
    // Every one of these is a hand edit that must not become a `status` the refusal trusts:
    // no reason, an empty `at`, a status outside the vocabulary, and a scalar where a
    // mapping belongs. The good row beside them still loads, so this is not a blanket skip.
    const dir = workspaceWith(
      "    command_probes:\n"
      // no `reason` — something happened, and the row does not say what
      + `      build:\n        status: failed\n        verified: false\n        exit_code: 1\n        at: ${AT}\n`
      // an empty `at` — the case the two readers used to disagree about
      + "      test:\n        status: failed\n        verified: false\n        exit_code: 1\n"
      + '        at: ""\n        reason: "red"\n'
      // a status outside the closed vocabulary
      + `      lint:\n        status: green\n        verified: true\n        exit_code: 0\n        at: ${AT}\n        reason: "ok"\n`
      // a scalar where a mapping belongs
      + "      typecheck: broken\n"
      // …and one good row, so this is a per-row skip and not a blanket one
      + `      run:\n        status: not-probed\n        verified: false\n        exit_code: null\n        at: ${AT}\n        reason: "not probed"\n`,
    );
    const probes = loadWorkspace(dir).commandProbes.get("app") ?? new Map();
    expect([...probes].map(([slot]) => slot)).toEqual(["run"]);
    expect(probes.get("run")?.status).toBe("not-probed");
  });

  test("a workspace.yml with no command_probes at all loads to an empty map, not to undefined", () => {
    const workspace = loadWorkspace(workspaceWith(""));
    expect(workspace.commandProbes.get("app")).toEqual(new Map());
    // And the allowlist it shares the file with is untouched.
    expect(workspace.commandRoles.get("app")?.get("build")).toBe("npm run build");
  });
});
