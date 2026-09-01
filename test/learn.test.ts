/**
 * `tldrx learn` (#30) — the engine, and all eight chapters played for real.
 *
 * Three levels, because they fail for three different reasons:
 *
 *   UNIT      the pure parts — turn selection, progress, the chapter plan, the
 *             shim's text. No process, no disk beyond a temp dir.
 *   AGENT     the stand-in `claude` in-process: does the transcript it prints
 *             parse with the SAME reader the real spawn path uses?
 *   PLAYED    the whole tutorial — all eight chapters — driven through `runLearn`
 *             with a scripted `ask`: real `tldrx init`, `run new`, `next` (which
 *             really spawns), `answer`, `approve`, a real Build that cuts a
 *             branch and runs a real DoD, a real red DoD and the recovery, a real
 *             agent gate. The assertion is the sandbox's disk plus
 *             `progress.json`, chapter by chapter.
 *
 * And one guard that is not about the tutorial at all: **the real `claude` must
 * be unreachable**. A booby-trapped `claude` is planted on PATH that writes a
 * marker file and exits 0. The tutorial is played. The marker must not exist,
 * AND the chapters must still have completed — because a tutorial that spawned
 * nothing would pass a marker check for the wrong reason.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { claudeBin } from "../src/core/facilitator/spawnAgent.ts";
import { resolveResultDoc } from "../src/core/facilitator/agentEvents.ts";
import { palette } from "../src/core/ui/color.ts";
import {
  EMPTY_SCRIPT, mergeScripts, parseScript, recordPlay, selectTurn, stringifyScript, type AgentScript,
} from "../src/core/learn/agentScript.ts";
import {
  LEARN_AGENT_ARGV0, SCRIPT_ENV, runLearnAgent, tallyPathFor,
} from "../src/core/learn/learnAgent.ts";
import {
  assertOutsideAnyWorkspace, claudeShimScript, defaultSandboxRoot, makeSandbox, sandboxEnv,
  SandboxError, TOY_FILES, writeScript, type Sandbox,
} from "../src/core/learn/sandbox.ts";
import {
  chaptersToPlay, displayCommand, expandCommand, expandTurns, newestRunId, playChapter,
  type LearnIo, type StepResult, type StepRunner,
} from "../src/core/learn/engine.ts";
import { CHAPTERS, chapterByNumber, LEARN_HOTFIX_SLUG, LEARN_RUN_SLUG } from "../src/core/learn/chapters.ts";
import { isComplete, markComplete, NO_PROGRESS, readProgress, resumeAt, writeProgress } from "../src/core/learn/progress.ts";
import { planFrom, runLearn } from "../src/core/learn/runLearn.ts";
import type { Chapter } from "../src/core/learn/Chapter.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in the PLAYED section spawns a real `tldrx` subprocess per step —
// twenty-six of them for the whole tutorial, several of which spawn a sub-agent
// of their own. Process cost is a property of the machine, not of the code, so
// the budget scales with measured load (#43); a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const SELF: readonly [string, string] = [process.execPath, BIN];
const ORIGINAL_PATH = process.env.PATH ?? "";

let scratch: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env[SCRIPT_ENV];
  delete process.env.TLDRX_CLAUDE_BIN;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

/** An `io` that keeps everything it was told, and answers every prompt with Enter. */
function collectingIo(answers: readonly string[] = []): LearnIo & {
  readonly out: string[];
  readonly err: string[];
  readonly asked: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    out, err, asked,
    write: (text) => { out.push(text); },
    warn: (text) => { err.push(text); },
    ask: async (prompt) => { asked.push(prompt); return queue.shift() ?? ""; },
    interactive: true,
    ink: palette(false),
    scenes: false,
  };
}

// ---------------------------------------------------------------------------
// UNIT — the pure parts
// ---------------------------------------------------------------------------

describe("the agent script picks a turn by what the PROMPT says", () => {
  const script: AgentScript = {
    version: 1,
    turns: [
      { match: "# Review", times: 1, structured: { verdict: "changes" } },
      { match: "# Review", structured: { verdict: "approve" } },
      { match: "# What", writes: { "a.md": "a" } },
    ],
  };

  test("the first matching turn wins, and a non-matching prompt is a refusal", () => {
    expect(selectTurn(script, "# What — story\n…")?.index).toBe(2);
    expect(selectTurn(script, "# Plan — nobody scripted this")).toBeNull();
    expect(selectTurn(EMPTY_SCRIPT, "anything")).toBeNull();
  });

  test("`times:` spends a turn so the next one takes over — the retry shape", () => {
    const first = selectTurn(script, "# Review — story S1");
    expect(first?.index).toBe(0);
    const tally = recordPlay({}, first?.index ?? -1);
    expect(selectTurn(script, "# Review — story S1", tally)?.index).toBe(1);
    // and it stays there, however many times it is asked
    expect(selectTurn(script, "# Review — story S1", recordPlay(tally, 1))?.index).toBe(1);
  });

  test("`*` matches any prompt", () => {
    expect(selectTurn({ version: 1, turns: [{ match: "*" }] }, "literally anything")?.index).toBe(0);
  });

  test("a malformed script throws rather than degrading into an empty one", () => {
    expect(() => parseScript("{}")).toThrow("no `turns` array");
    expect(() => parseScript("not json")).toThrow();
    expect(parseScript(stringifyScript(script)).turns).toHaveLength(3);
    expect(mergeScripts(script, EMPTY_SCRIPT).turns).toHaveLength(3);
  });
});

describe("progress is a file, and `learn` resumes from it", () => {
  test("an absent file is no progress, and a corrupt one is no progress either", () => {
    const dir = temp("tldrx-learn-progress-");
    const path = join(dir, "progress.json");
    expect(readProgress(path)).toEqual(NO_PROGRESS);
    writeFileSync(path, "{ not json", "utf8");
    expect(readProgress(path)).toEqual(NO_PROGRESS);
  });

  test("a completed chapter round-trips, and is recorded once however often it is replayed", () => {
    const dir = temp("tldrx-learn-progress-");
    const path = join(dir, "progress.json");
    let progress = markComplete(NO_PROGRESS, 2, "2026-09-01T09:00:00Z");
    progress = markComplete(progress, 1, "2026-09-01T09:01:00Z");
    progress = markComplete(progress, 2, "2026-09-01T09:02:00Z");
    writeProgress(path, progress);

    const back = readProgress(path);
    expect(back.completed).toEqual([1, 2]);
    expect(back.updatedAt).toBe("2026-09-01T09:02:00Z");
    expect(isComplete(back, 1)).toBe(true);
    expect(isComplete(back, 3)).toBe(false);
  });

  test("resume is the first UNFINISHED chapter, not the one after the last finished", () => {
    const jumped = markComplete(NO_PROGRESS, 2, "t");
    expect(resumeAt(jumped, [1, 2, 3])).toBe(1);
    expect(resumeAt(markComplete(jumped, 1, "t"), [1, 2])).toBeNull();
  });
});

describe("which chapters a jump plays", () => {
  const fake = (n: number, requires: readonly number[] = []): Chapter => ({
    n, id: `c${String(n)}`, title: `chapter ${String(n)}`, intro: [], steps: [], debrief: [], requires,
    assert: async (): Promise<readonly string[]> => [],
  });
  const list = [fake(1), fake(2, [1]), fake(3, [2])];

  test("an unfinished prerequisite is played first", () => {
    expect(chaptersToPlay(list, 3, () => false).map((c) => c.n)).toEqual([1, 2, 3]);
  });

  test("a finished prerequisite is not replayed", () => {
    expect(chaptersToPlay(list, 3, (n) => n === 1 || n === 2).map((c) => c.n)).toEqual([3]);
  });

  test("`--chapter n` carries on to the end, it does not play n alone", () => {
    expect(planFrom(1, () => false).map((c) => c.n)).toEqual(CHAPTERS.map((c) => c.n));
    expect(planFrom(999, () => false)).toEqual([]);
  });
});

describe("the command that is shown is the command that runs", () => {
  test("quoting is added only where a shell would need it, from the same array", () => {
    expect(displayCommand(["init", "--provider", "static"])).toBe("init --provider static");
    expect(displayCommand(["run", "new", "x", "--title", "Bulk SKUs"])).toBe('run new x --title "Bulk SKUs"');
  });
});

// ---------------------------------------------------------------------------
// The one guarantee that matters most: the real `claude` is out of reach
// ---------------------------------------------------------------------------

describe("the sandbox cannot reach the real `claude`", () => {
  test("`sandboxEnv` names the stand-in AND puts it first on PATH — both doors", async () => {
    const sandbox = await makeSandbox({ root: temp("tldrx-learn-env-"), selfCommand: SELF });
    const env = sandboxEnv(sandbox, { PATH: "/usr/bin:/bin" });

    expect(env.TLDRX_CLAUDE_BIN).toBe(sandbox.claudeBin);
    expect(env.PATH?.startsWith(`${sandbox.binDir}:`)).toBe(true);
    expect(env[SCRIPT_ENV]).toBe(sandbox.scriptPath);
  });

  test("that env is the one `spawnAgent` actually obeys", async () => {
    const sandbox = await makeSandbox({ root: temp("tldrx-learn-bin-"), selfCommand: SELF });
    process.env.TLDRX_CLAUDE_BIN = sandboxEnv(sandbox).TLDRX_CLAUDE_BIN;
    // `claudeBin()` is what `spawnAgent` executes (spawnAgent.ts:55). If this ever
    // stops reading the variable the sandbox sets, the tutorial spends money.
    expect(claudeBin()).toBe(sandbox.claudeBin);
  });

  test("the shim execs THIS runtime on THIS entry, and never the name `claude`", () => {
    const text = claudeShimScript(["/opt/bun", "/x/bin/tldrx.ts"], "/x/script.json");
    expect(text).toContain(`exec '/opt/bun' '/x/bin/tldrx.ts' ${LEARN_AGENT_ARGV0} "$@"`);
    expect(text).toContain(`${SCRIPT_ENV}='/x/script.json'`);
    // nothing in it could resolve a `claude` off PATH
    expect(text).not.toMatch(/\bclaude\b(?!`)/);
  });

  test("a path with a quote in it cannot break out of the shim", () => {
    expect(claudeShimScript(["/bun", "/a'b/tldrx.ts"], "/s.json")).toContain(`'/a'\\''b/tldrx.ts'`);
  });
});

// ---------------------------------------------------------------------------
// AGENT — the stand-in, in-process
// ---------------------------------------------------------------------------

describe("the stand-in agent", () => {
  const CLAUDE_ARGV = ["-p", "--output-format", "stream-json", "--verbose"];

  async function play(scriptPath: string, prompt: string, cwd: string): Promise<{
    code: number; out: string; err: string;
  }> {
    let out = "";
    let err = "";
    const code = await runLearnAgent({
      argv: CLAUDE_ARGV,
      env: { [SCRIPT_ENV]: scriptPath },
      cwd,
      readStdin: async () => prompt,
      stdout: (text) => { out += text; },
      stderr: (text) => { err += text; },
    });
    return { code, out, err };
  }

  test("it writes the turn's files and prints a transcript the REAL reader parses", async () => {
    const dir = temp("tldrx-learn-agent-");
    const scriptPath = join(dir, "script.json");
    writeFileSync(scriptPath, stringifyScript({
      version: 1,
      turns: [{ match: "# What", costUsd: 0.31, writes: { "out/handoff.md": "# Handoff\n" } }],
    }), "utf8");

    const played = await play(scriptPath, "# What — stage\nbody", dir);

    expect(played.code).toBe(0);
    expect(readFileSync(join(dir, "out", "handoff.md"), "utf8")).toBe("# Handoff\n");
    // The same function `spawnAgent.interpret` uses on a real transcript.
    const doc = resolveResultDoc(played.out) as Record<string, unknown> | null;
    expect(doc).not.toBeNull();
    expect(doc?.is_error).toBe(false);
    expect(doc?.total_cost_usd).toBe(0.31);
    expect((doc?.structured_output as { outputs?: string[] }).outputs).toEqual(["out/handoff.md"]);
  });

  test("a failing turn returns NO envelope and exits 1 — what a killed turn leaves", async () => {
    const dir = temp("tldrx-learn-agent-");
    const scriptPath = join(dir, "script.json");
    writeFileSync(scriptPath, stringifyScript({
      version: 1,
      turns: [{ match: "*", fails: true, error: "Reached maximum budget ($0.10)" }],
    }), "utf8");

    const played = await play(scriptPath, "# Build — story S1", dir);

    expect(played.code).toBe(1);
    const doc = resolveResultDoc(played.out) as Record<string, unknown> | null;
    expect(doc?.is_error).toBe(true);
    expect(doc?.structured_output).toBeNull();
    expect(doc?.errors).toEqual(["Reached maximum budget ($0.10)"]);
  });

  test("it is fail-closed: no script, a broken script and an unmatched prompt all refuse", async () => {
    const dir = temp("tldrx-learn-agent-");
    const missing = await play(join(dir, "nope.json"), "# What", dir);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("cannot read");

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{}", "utf8");
    expect((await play(broken, "# What", dir)).code).toBe(1);

    const narrow = join(dir, "narrow.json");
    writeFileSync(narrow, stringifyScript({ version: 1, turns: [{ match: "# Review" }] }), "utf8");
    const unmatched = await play(narrow, "# What — nobody scripted this", dir);
    expect(unmatched.code).toBe(1);
    expect(unmatched.err).toContain("no scripted turn matches");
    // and it says what it DID have, so the hole is actionable
    expect(unmatched.err).toContain('"# Review"');
  });

  test("`SCRIPT_ENV` unset is a refusal, not a default turn", async () => {
    let err = "";
    const code = await runLearnAgent({
      argv: CLAUDE_ARGV, env: {}, cwd: temp("tldrx-learn-agent-"),
      readStdin: async () => "# What", stdout: () => undefined, stderr: (t) => { err += t; },
    });
    expect(code).toBe(1);
    expect(err).toContain("is not set");
  });

  test("the tally survives across processes, so `times:` means something", async () => {
    const dir = temp("tldrx-learn-agent-");
    const scriptPath = join(dir, "script.json");
    writeFileSync(scriptPath, stringifyScript({
      version: 1,
      turns: [{ match: "# Review", times: 1, structured: { verdict: "changes" } }, { match: "# Review", structured: { verdict: "approve" } }],
    }), "utf8");

    const first = await play(scriptPath, "# Review — story S1", dir);
    const second = await play(scriptPath, "# Review — story S1", dir);

    expect((resolveResultDoc(first.out) as { structured_output?: { verdict?: string } })?.structured_output?.verdict).toBe("changes");
    expect((resolveResultDoc(second.out) as { structured_output?: { verdict?: string } })?.structured_output?.verdict).toBe("approve");
    expect(existsSync(tallyPathFor(scriptPath))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The sandbox itself
// ---------------------------------------------------------------------------

describe("the sandbox", () => {
  test("it builds a git repo with the four files and a test script that exits 0", async () => {
    const sandbox = await makeSandbox({ root: temp("tldrx-learn-box-"), selfCommand: SELF });

    for (const rel of Object.keys(TOY_FILES)) {
      expect(existsSync(join(sandbox.workspace, rel))).toBe(true);
    }
    expect(existsSync(join(sandbox.workspace, ".git"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(sandbox.workspace, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe("exit 0");
    // the tutorial's own state is OUTSIDE the workspace, or `init` would map it
    expect(sandbox.progressPath.startsWith(sandbox.workspace)).toBe(false);
    expect(sandbox.scriptPath.startsWith(sandbox.workspace)).toBe(false);
  });

  test("re-opening it keeps the repo and the progress — that is what resume is", async () => {
    const root = temp("tldrx-learn-box-");
    const first = await makeSandbox({ root, selfCommand: SELF });
    writeFileSync(join(first.workspace, "src", "stock.ts"), "// changed by the learner\n", "utf8");
    writeProgress(first.progressPath, markComplete(NO_PROGRESS, 1, "t"));

    const again = await makeSandbox({ root, selfCommand: SELF });

    expect(readFileSync(join(again.workspace, "src", "stock.ts"), "utf8")).toContain("changed by the learner");
    expect(readProgress(again.progressPath).completed).toEqual([1]);
  });

  test("`--reset` really rebuilds it", async () => {
    const root = temp("tldrx-learn-box-");
    const first = await makeSandbox({ root, selfCommand: SELF });
    writeProgress(first.progressPath, markComplete(NO_PROGRESS, 1, "t"));
    writeFileSync(join(first.workspace, "src", "stock.ts"), "// changed\n", "utf8");

    const fresh = await makeSandbox({ root, reset: true, selfCommand: SELF });

    expect(readProgress(fresh.progressPath)).toEqual(NO_PROGRESS);
    expect(readFileSync(join(fresh.workspace, "src", "stock.ts"), "utf8")).not.toContain("changed");
  });

  test("it refuses to sit inside a real workspace, and says how to move", () => {
    const outer = temp("tldrx-learn-real-");
    mkdirSync(join(outer, ".tldrx"), { recursive: true });
    expect(() => assertOutsideAnyWorkspace(join(outer, "deep", "sandbox")))
      .toThrow(SandboxError);
    try {
      assertOutsideAnyWorkspace(join(outer, "deep", "sandbox"));
    } catch (error) {
      expect((error as Error).message).toContain("--sandbox");
    }
  });

  test("`{runDir}` expands to the run that is really on disk", async () => {
    const sandbox = await makeSandbox({ root: temp("tldrx-learn-box-"), selfCommand: SELF });
    expect(newestRunId(sandbox)).toBeNull();
    expect(expandTurns([{ match: "x", writes: { "{runDir}/a.md": "in {run}" } }], sandbox)[0]?.writes)
      .toEqual({ "{runDir}/a.md": "in {run}" });

    mkdirSync(join(sandbox.workspace, "tldrx-work", "260901-alpha"), { recursive: true });
    expect(newestRunId(sandbox)).toBe("260901-alpha");
    expect(expandTurns([{ match: "x", writes: { "{runDir}/a.md": "in {run}" } }], sandbox)[0]?.writes)
      .toEqual({ "tldrx-work/260901-alpha/a.md": "in 260901-alpha" });
  });

  test("`{run}` expands in a step's argv too — the id a chapter cannot spell", async () => {
    const sandbox = await makeSandbox({ root: temp("tldrx-learn-argv-"), selfCommand: SELF });
    expect(expandCommand(["next", "{run}"], sandbox)).toEqual(["next", "{run}"]);

    mkdirSync(join(sandbox.workspace, "tldrx-work", "260901-alpha"), { recursive: true });
    expect(expandCommand(["next", "{run}"], sandbox)).toEqual(["next", "260901-alpha"]);
    expect(expandCommand(["cat", "{runDir}/run.yml"], sandbox))
      .toEqual(["cat", "tldrx-work/260901-alpha/run.yml"]);
  });

  /**
   * The half of `{run}` that only matters once chapter 5 has opened a second run:
   * a FINISHED run is not what the next command will resolve to, so it must not
   * be what the placeholder means either. Chapter 7 signs the hotfix off and
   * chapter 8 then has to be talking about the feature run again.
   */
  test("`{run}` is the newest run that is still OPEN, and falls back when none is", async () => {
    const sandbox = await makeSandbox({ root: temp("tldrx-learn-open-"), selfCommand: SELF });
    const work = join(sandbox.workspace, "tldrx-work");
    for (const [id, status] of [["260901-alpha", "ready"], ["260901-beta", "ready"]] as const) {
      mkdirSync(join(work, id), { recursive: true });
      writeFileSync(join(work, id, "run.yml"), `version: 1\nrun: "${id}"\nstatus: ${status}\n`, "utf8");
    }
    expect(newestRunId(sandbox)).toBe("260901-beta");

    writeFileSync(join(work, "260901-beta", "run.yml"), "version: 1\nrun: \"260901-beta\"\nstatus: done\n", "utf8");
    expect(newestRunId(sandbox)).toBe("260901-alpha");

    // Every run finished: the newest is still the honest answer, not null.
    writeFileSync(join(work, "260901-alpha", "run.yml"), "version: 1\nrun: \"260901-alpha\"\nstatus: done\n", "utf8");
    expect(newestRunId(sandbox)).toBe("260901-beta");
  });
});

// ---------------------------------------------------------------------------
// The engine, with a stubbed runner
// ---------------------------------------------------------------------------

describe("playChapter", () => {
  const okResult: StepResult = { exitCode: 0, stdout: "", stderr: "" };

  function chapter(overrides: Partial<Chapter> = {}): Chapter {
    return {
      n: 1, id: "x", title: "a chapter", intro: ["intro"], debrief: ["debrief"],
      steps: [{ narrate: ["do this"], command: ["status"] }],
      assert: async (): Promise<readonly string[]> => [],
      ...overrides,
    };
  }

  async function box(): Promise<Sandbox> {
    return makeSandbox({ root: temp("tldrx-learn-play-"), selfCommand: SELF });
  }

  test("it narrates, shows the command, waits, runs it and debriefs", async () => {
    const io = collectingIo();
    const seen: string[][] = [];
    const runner: StepRunner = async (step) => { seen.push([...step.command]); return okResult; };

    const outcome = await playChapter(chapter(), await box(), io, runner);

    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([["status"]]);
    const said = io.out.join("");
    expect(said).toContain("intro");
    expect(said).toContain("$ tldrx status");
    expect(said).toContain("debrief");
    expect(io.asked).toHaveLength(1);
  });

  test("`q` stops without running the command", async () => {
    const io = collectingIo(["q"]);
    let ran = 0;
    const runner: StepRunner = async () => { ran += 1; return okResult; };

    const outcome = await playChapter(chapter(), await box(), io, runner);

    expect(outcome.quit).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(ran).toBe(0);
  });

  test("a step that exits the wrong way fails the chapter and says both codes", async () => {
    const io = collectingIo();
    const runner: StepRunner = async () => ({ exitCode: 1, stdout: "", stderr: "boom\n" });

    const outcome = await playChapter(chapter(), await box(), io, runner);

    expect(outcome.ok).toBe(false);
    expect(outcome.failures[0]).toContain("exited 1");
    expect(outcome.failures[0]).toContain("expected 0");
  });

  test("an expected non-zero exit is a PASS — exit 4 is `awaiting a human`", async () => {
    const io = collectingIo();
    const runner: StepRunner = async () => ({ exitCode: 4, stdout: "", stderr: "" });
    const four = chapter({ steps: [{ narrate: [], command: ["next"], expectExit: [4] }] });

    expect((await playChapter(four, await box(), io, runner)).ok).toBe(true);
  });

  test("commands can exit 0 and still not have taught the lesson — assert() decides", async () => {
    const io = collectingIo();
    const runner: StepRunner = async () => okResult;
    const lying = chapter({ assert: async (): Promise<readonly string[]> => ["facts.yml holds no fact"] });

    const outcome = await playChapter(lying, await box(), io, runner);

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toEqual(["facts.yml holds no fact"]);
    expect(io.err.join("")).toContain("facts.yml holds no fact");
  });

  test("each step's agent turns REPLACE the last step's, they do not accumulate", async () => {
    const sandbox = await box();
    const io = collectingIo();
    const scripts: AgentScript[] = [];
    const runner: StepRunner = async () => {
      scripts.push(parseScript(readFileSync(sandbox.scriptPath, "utf8")));
      return okResult;
    };
    const two = chapter({
      steps: [
        { narrate: [], command: ["a"], agentTurns: [{ match: "# One" }] },
        { narrate: [], command: ["b"], agentTurns: [{ match: "# Two" }] },
      ],
    });

    await playChapter(two, sandbox, io, runner);

    expect(scripts.map((s) => s.turns.map((t) => t.match))).toEqual([["# One"], ["# Two"]]);
  });

  test("`prepare()` runs before the first step — the hook chapters 3-8 need for shell", async () => {
    const sandbox = await box();
    const order: string[] = [];
    const runner: StepRunner = async () => { order.push("step"); return okResult; };
    const prepared = chapter({
      prepare: async (given): Promise<void> => {
        order.push("prepare");
        writeFileSync(join(given.workspace, "prepared.txt"), "yes", "utf8");
      },
    });

    const outcome = await playChapter(prepared, sandbox, collectingIo(), runner);

    expect(outcome.ok).toBe(true);
    expect(order).toEqual(["prepare", "step"]);
    expect(readFileSync(join(sandbox.workspace, "prepared.txt"), "utf8")).toBe("yes");
  });

  test("a step with no turns leaves the stand-in with nothing to say", async () => {
    const sandbox = await box();
    writeScript(sandbox, { version: 1, turns: [{ match: "*" }] });
    const runner: StepRunner = async () => okResult;

    await playChapter(chapter(), sandbox, collectingIo(), runner);

    expect(parseScript(readFileSync(sandbox.scriptPath, "utf8")).turns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The chapter registry
// ---------------------------------------------------------------------------

describe("the chapters this build ships", () => {
  test("they are numbered from 1, contiguous, and uniquely identified", () => {
    expect(CHAPTERS.map((c) => c.n)).toEqual(CHAPTERS.map((_, i) => i + 1));
    expect(new Set(CHAPTERS.map((c) => c.id)).size).toBe(CHAPTERS.length);
    expect(CHAPTERS.length).toBeGreaterThanOrEqual(2);
  });

  test("every step names a real tldrx command, so no chapter can teach a typo", async () => {
    const { lookup } = await import("../src/cli/index.ts");
    for (const chapter of CHAPTERS) {
      for (const step of chapter.steps) {
        expect(lookup(step.command[0] ?? "")).toBeDefined();
      }
    }
  });

  test("every `requires:` names a chapter that exists and comes first", () => {
    for (const chapter of CHAPTERS) {
      for (const required of chapter.requires ?? []) {
        expect(chapterByNumber(required)).toBeDefined();
        expect(required).toBeLessThan(chapter.n);
      }
    }
  });

  test("chapter 2's run slug is a legal one — `run new` refuses anything else", () => {
    expect(LEARN_RUN_SLUG).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });
});

// ---------------------------------------------------------------------------
// PLAYED — chapters 1 and 2, for real
// ---------------------------------------------------------------------------

describe("all eight chapters, played end to end", () => {
  /**
   * A `claude` on PATH that would be a catastrophe to reach: it writes a marker
   * and exits 0, so if the tutorial ever resolved the NAME rather than the
   * sandbox's shim, the marker is there to prove it.
   */
  function boobyTrap(): { readonly dir: string; readonly marker: string } {
    const dir = temp("tldrx-learn-trap-");
    const marker = join(dir, "THE-REAL-CLAUDE-RAN");
    const shim = join(dir, "claude");
    writeFileSync(shim, `#!/bin/sh\necho ran > ${marker}\nexit 0\n`, "utf8");
    chmodSync(shim, 0o755);
    return { dir, marker };
  }

  /** The run ids the chapters made, found the way the chapters' own asserts do. */
  function runDirs(workspace: string): { readonly feature: string; readonly hotfix: string } {
    const work = join(workspace, "tldrx-work");
    const ids = readdirSync(work);
    const find = (slug: string): string => {
      const hit = ids.find((id) => id.endsWith(`-${slug}`));
      if (hit === undefined) throw new Error(`no run for ${slug} in ${ids.join(", ")}`);
      return join(work, hit);
    };
    return { feature: find(LEARN_RUN_SLUG), hotfix: find(LEARN_HOTFIX_SLUG) };
  }

  /**
   * ONE playthrough, asserted chapter by chapter.
   *
   * Every chapter already carries its own `assert()` and `runLearn` refuses to
   * record a chapter whose claim did not hold — so a green run here is already
   * eight assertions deep. What this adds is the half a chapter cannot check
   * about itself: that the state it left is the state the NEXT chapter was
   * written against, and that the transcript actually said the things the
   * debriefs send the learner to look at.
   *
   * It is one test rather than eight because it is one 5-second tutorial: eight
   * tests would be eight tutorials, and the eighth chapter would still only be
   * reachable by playing the seven before it.
   */
  test("the whole tutorial runs, records progress, and never reaches the real `claude`", async () => {
    const trap = boobyTrap();
    process.env.PATH = `${trap.dir}:${ORIGINAL_PATH}`;
    const root = temp("tldrx-learn-played-");
    const io = collectingIo();

    const code = await runLearn({
      sandboxRoot: root, reset: true, list: false, cols: 80, selfCommand: SELF,
      now: () => "2026-09-01T09:00:00Z",
    }, io);

    const said = `${io.out.join("")}\n--stderr--\n${io.err.join("")}`;
    expect(code, said).toBe(0);

    // 1. the marker must not exist — nothing spawned the real CLI …
    expect(existsSync(trap.marker), said).toBe(false);
    // 2. … and every chapter really completed, so (1) is not true for the wrong reason
    expect(readProgress(join(root, "progress.json")).completed, said).toEqual(CHAPTERS.map((c) => c.n));

    const workspace = join(root, "inventory");
    const { feature, hotfix } = runDirs(workspace);
    const read = (...parts: string[]): string => readFileSync(join(...parts), "utf8");

    // --- 1: init really detected -------------------------------------------
    expect(read(workspace, ".tldrx", "workspace.yml")).toContain("npm run test");
    expect(existsSync(join(workspace, ".tldrx", "conventions", "shared.md"))).toBe(true);

    // --- 2: the answer became a fact ---------------------------------------
    const facts = read(workspace, ".tldrx", "memory", "facts.yml");
    expect(facts).toContain("kind: answer");
    expect(facts).toContain("q: Q1");
    expect(facts).toContain("F001");

    // --- 3: the gate is a record, with who / when / why ---------------------
    const featureRun = read(feature, "run.yml");
    expect(featureRun).toContain("a price change should be a data change");
    expect(featureRun).toMatch(/status: approved, by: \S+, at: "\d{4}-/);

    // --- 4: one story built, proven, committed, merged and reviewed ---------
    const story = read(feature, "03-plan", "stories", "S1.md");
    expect(story).toContain("status: done");
    expect(story).toContain("npm run test → exit 0");
    expect(story).toMatch(/commit [0-9a-f]{7}/);
    expect(read(feature, "04-build", "log", "S1.md")).toContain("Verdict: **approve**");
    // the branch was really cut, and `main` was really left alone
    expect(said).toContain("cut `epic/bulk-pricing` from `main`");
    expect(read(workspace, "src", "pricing.ts")).toContain("500 : 1200");

    // --- 5: a red DoD, in the ledger, in its own words ----------------------
    const hotfixEvents = read(hotfix, "events.jsonl");
    expect(hotfixEvents).toContain("FAIL: a BULK- SKU costs 1720");
    for (const type of ["story.reopened", "gate.rejected", "budget.raised"]) {
      expect(hotfixEvents, `events.jsonl has no ${type}`).toContain(type);
    }
    // and then it went green, on the second attempt and no later
    expect(read(hotfix, "04-build", "log", "S1.md")).toContain("`npm run test` → exit 0");

    // --- 6: attended flipped on and back off -------------------------------
    expect(said).toContain("the framework does not spawn on this run");
    expect(said).toContain("tldrx next --prepare");
    expect(read(hotfix, "run.yml")).not.toContain("attended_by: host");

    // --- 7: an agent gate, closed over an evidence note ---------------------
    expect(read(hotfix, "05-watch", "gate-evidence", "watch.md")).toContain("verdict: sign");
    expect(read(hotfix, "run.yml")).toContain("by: operations");

    // --- 8: the ledger, and the brake ---------------------------------------
    expect(read(feature, "05-watch", "watchers", "bulk-pricing.md")).toContain("## Signal");
    expect(read(feature, "events.jsonl")).toContain("budget.blocked");
    expect(said).toContain("refusing to start stage");

    // the transcript names the files the debriefs tell the learner to open
    for (const path of [
      ".tldrx/workspace.yml", ".tldrx/memory/facts.yml", "03-plan/stories/S1.md",
      "04-build/log/S1.md", "events.jsonl", "05-watch/gate-evidence/watch.md",
    ]) expect(said, `the transcript never names ${path}`).toContain(path);
  });

  /**
   * #30's acceptance, stated as a test: "nothing written outside the sandbox dir".
   *
   * Checked at the two places a stray write would actually land — the framework
   * checkout the CLI is being run from (which is this process's cwd), and the
   * default sandbox root under `$HOME`, which `--sandbox` must have taken out of
   * play entirely.
   */
  test("nothing is written outside the sandbox — not the repo, not the default root", async () => {
    const before = readdirSync(FRAMEWORK_ROOT).sort();
    const home = defaultSandboxRoot();
    const homeExisted = existsSync(home);

    const code = await runLearn({
      sandboxRoot: temp("tldrx-learn-outside-"), reset: true, list: false, cols: 80, selfCommand: SELF,
    }, collectingIo());

    expect(code).toBe(0);
    expect(readdirSync(FRAMEWORK_ROOT).sort()).toEqual(before);
    if (!homeExisted) expect(existsSync(home)).toBe(false);
  });

  test("a second `learn` over the same sandbox says there is nothing left", async () => {
    const root = temp("tldrx-learn-done-");
    writeProgress(join(root, "progress.json"), {
      version: 1, completed: CHAPTERS.map((c) => c.n), updatedAt: "t",
    });
    const io = collectingIo();

    const code = await runLearn({ sandboxRoot: root, reset: false, list: false, cols: 80, selfCommand: SELF }, io);

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("--reset");
  });

  test("`--list` prints every chapter and runs nothing", async () => {
    const root = temp("tldrx-learn-list-");
    const io = collectingIo();

    const code = await runLearn({ sandboxRoot: root, reset: false, list: true, cols: 80, selfCommand: SELF }, io);

    expect(code).toBe(0);
    for (const chapter of CHAPTERS) expect(io.out.join("")).toContain(chapter.title);
    expect(existsSync(join(root, "inventory", ".tldrx"))).toBe(false);
  });

  test("a chapter number this build does not have is refused, and says the range", async () => {
    const io = collectingIo();
    const code = await runLearn({
      sandboxRoot: temp("tldrx-learn-badn-"), chapter: 99, reset: false, list: false, cols: 80, selfCommand: SELF,
    }, io);

    expect(code).toBe(1);
    expect(io.err.join("")).toContain("no chapter 99");
    expect(io.err.join("")).toContain("--list");
  });

  test("a sandbox inside a real workspace is refused before anything is written", async () => {
    const outer = temp("tldrx-learn-inside-");
    mkdirSync(join(outer, ".tldrx"), { recursive: true });
    const io = collectingIo();

    const code = await runLearn({
      sandboxRoot: join(outer, "sandbox"), reset: false, list: false, cols: 80, selfCommand: SELF,
    }, io);

    expect(code).toBe(1);
    expect(io.err.join("")).toContain("inside a tldrx workspace");
    expect(existsSync(join(outer, "sandbox"))).toBe(false);
  });
});
