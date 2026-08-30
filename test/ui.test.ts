/**
 * The progress view: summaries, the three renderers, mode resolution, and the
 * driver's two promises — stdout is never touched, and the cursor always comes
 * back.
 *
 * Every frame here is a pure function of `(snapshot, cols, rows, tick)`, so
 * there is not one timer in this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_USAGE } from "../src/cli/exitCodes.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace,
} from "./fixtures/facilitator/workspace.ts";
import { TinyTerminal } from "./fixtures/tinyTerminal.ts";
import type { AgentEvent } from "../src/core/facilitator/agentEvents.ts";
import { setProgressSink } from "../src/core/ui/bus.ts";
import { renderCompact, SPINNER } from "../src/core/ui/compact.ts";
import { startProgress } from "../src/core/ui/driver.ts";
import { resolveUiMode, UiModeError } from "../src/core/ui/mode.ts";
import { plainLine } from "../src/core/ui/plain.ts";
import { renderScene, MIN_SCENE_COLS, MIN_SCENE_ROWS } from "../src/core/ui/scene.ts";
import { UiState, RING_CAPACITY } from "../src/core/ui/state.ts";
import { summarize, shortPath, command, duration, clockFace, firstSentence } from "../src/core/ui/summary.ts";

/** A fixed epoch, so every elapsed time in this file is a subtraction. */
const T0 = 1_756_468_800_000;
const ROOT = "/work/scavtopia";

/** The events behind the frame in README § "What you see while it runs". */
const SCRIPT: readonly (readonly [AgentEvent, number])[] = [
  [{ kind: "start", model: "claude-fable-5-20260501", sessionId: "s" }, 400],
  [{ kind: "tool", id: "1", name: "Read", target: `${ROOT}/api/src/Outbox.cs` }, 1200],
  [{ kind: "tool-done", id: "1", name: "Read", ok: true, ms: 22 }, 1300],
  [{ kind: "tool", id: "2", name: "Grep", target: "Outbox" }, 2000],
  [{ kind: "tool-done", id: "2", name: "Grep", ok: true, ms: 90 }, 2100],
  [{ kind: "text", text: "The tenancy boundary is the row filter, not the schema." }, 3000],
  [{ kind: "tool", id: "3", name: "Bash", target: "dotnet test tests/Unit" }, 4000],
  [{ kind: "tool-done", id: "3", name: "Bash", ok: true, ms: 12400 }, 16400],
  [{ kind: "tool", id: "4", name: "Write", target: `${ROOT}/tldrx-work/260829-tenancy/01-what/handoff.md` }, 200000],
];

function scripted(): UiState {
  const state = new UiState({
    root: ROOT,
    ceilingUsd: 6,
    title: "what · 260829-tenancy · attempt 1",
    startedAt: T0,
    width: 44,
  });
  for (const [event, at] of SCRIPT) state.apply(event, T0 + at);
  return state;
}

describe("summaries", () => {
  const ctx = { root: ROOT, elapsedMs: 190_000, width: 64 };

  test("one line per tool, in the tool's own words", () => {
    const line = (event: AgentEvent): string | null => summarize(event, ctx);
    expect(line({ kind: "tool", id: "a", name: "Read", target: `${ROOT}/api/src/Outbox.cs` }))
      .toBe("reading api/src/Outbox.cs");
    expect(line({ kind: "tool", id: "a", name: "Write", target: `${ROOT}/01-what/handoff.md` }))
      .toBe("writing 01-what/handoff.md");
    expect(line({ kind: "tool", id: "a", name: "Edit", target: `${ROOT}/lab/src/rank.ts` }))
      .toBe("editing lab/src/rank.ts");
    expect(line({ kind: "tool", id: "a", name: "Bash", target: "dotnet test" }))
      .toBe("$ dotnet test → running");
    expect(line({ kind: "tool", id: "a", name: "Grep", target: "Outbox" })).toBe('grep "Outbox"');
    expect(line({ kind: "tool", id: "a", name: "Glob", target: "**/*.cs" })).toBe("glob **/*.cs");
  });

  test("a tool that finished fast is not worth a second line; a slow one is", () => {
    expect(summarize({ kind: "tool-done", id: "a", name: "Read", ok: true, ms: 22 }, ctx)).toBeNull();
    expect(summarize({ kind: "tool-done", id: "a", name: "Bash", ok: true, ms: 12400 }, ctx))
      .toBe("  → ok (12 s)");
    expect(summarize({ kind: "tool-done", id: "a", name: "Bash", ok: false, ms: 900 }, ctx))
      .toBe("  → failed (1 s)");
  });

  test("prose is cut to its first sentence, questions are numbered", () => {
    expect(summarize({ kind: "text", text: "Found it. Now I will check the tests." }, ctx))
      .toBe("Found it.");
    expect(summarize({ kind: "question", index: 1, text: "Which repo owns the outbox?" }, ctx))
      .toBe("asked Q1: Which repo owns the outbox?");
  });

  test("a dollar figure is only claimed once one has arrived", () => {
    expect(summarize({ kind: "cost", usd: null, inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }, ctx)).toBeNull();
    expect(summarize({ kind: "cost", usd: 0, inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }, ctx)).toBeNull();
    expect(summarize({ kind: "cost", usd: 0.42, inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }, ctx))
      .toBe("$0.42 so far · 3m10s");
  });

  test("errors are said; `done` is not said twice", () => {
    expect(summarize({ kind: "done", ok: true, structured: null, costUsd: 1 }, ctx)).toBeNull();
    expect(summarize({ kind: "error", message: "the sub-agent failed" }, ctx))
      .toBe("error: the sub-agent failed");
  });

  test("the small helpers", () => {
    expect(shortPath(`${ROOT}/a/b.cs`, ROOT)).toBe("a/b.cs");
    expect(shortPath("/elsewhere/x.cs", ROOT)).toBe("/elsewhere/x.cs");
    // Too long: cut back to whole segments, never mid-name.
    expect(shortPath(`${ROOT}/${"deep/".repeat(20)}x.cs`, ROOT)).toBe("…/deep/deep/deep/deep/deep/deep/deep/x.cs");
    expect(shortPath(`/elsewhere/${"z".repeat(60)}.cs`, ROOT)).toStartWith("…z");
    expect(command("bun   test --coverage")).toBe("bun test --coverage");
    expect(command("bun test\nsecond line")).toBe("bun test");
    expect(command("x".repeat(80))).toEndWith("…");
    expect(duration(900)).toBe("1 s");
    expect(duration(190_000)).toBe("3m10s");
    expect(duration(3_900_000)).toBe("1h05m");
    expect(clockFace(190_000)).toBe("03:10");
    expect(firstSentence("  one two.  three ")).toBe("one two.");
    expect(firstSentence("no stop here")).toBe("no stop here");
  });
});

describe("state", () => {
  test("the ring buffer is bounded and the newest line is the activity", () => {
    const state = new UiState({ root: ROOT, startedAt: T0 });
    for (let i = 0; i < RING_CAPACITY + 10; i++) {
      state.apply({ kind: "tool", id: String(i), name: "Read", target: `${ROOT}/f${String(i)}.md` }, T0);
    }
    const snapshot = state.snapshot(T0);
    expect(snapshot.lines).toHaveLength(RING_CAPACITY);
    expect(snapshot.lines[RING_CAPACITY - 1]).toBe("reading f49.md");
    expect(snapshot.activity).toBe("reading f49.md");
  });

  test("busy tracks open tools; speech expires; spend accumulates", () => {
    const state = new UiState({ root: ROOT, startedAt: T0 });
    state.apply({ kind: "tool", id: "a", name: "Bash", target: "bun test" }, T0);
    expect(state.snapshot(T0).busy).toBe(true);
    state.apply({ kind: "tool-done", id: "a", name: "Bash", ok: true, ms: 10 }, T0 + 10);
    expect(state.snapshot(T0 + 10).busy).toBe(false);

    state.apply({ kind: "text", text: "Reading the schema." }, T0 + 100);
    expect(state.snapshot(T0 + 200).speech).toBe("Reading the schema.");
    expect(state.snapshot(T0 + 100_000).speech).toBeNull();

    state.apply({ kind: "cost", usd: 1.21, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, T0);
    state.apply({ kind: "cost", usd: 0.4, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, T0);
    expect(state.snapshot(T0).spentUsd).toBeCloseTo(1.61, 5);
  });

  test("a new title clears the previous stage's open tools", () => {
    const state = new UiState({ root: ROOT, startedAt: T0 });
    state.apply({ kind: "tool", id: "a", name: "Bash", target: "bun test" }, T0);
    state.setTitle("how · 260829-tenancy · attempt 1");
    expect(state.snapshot(T0).busy).toBe(false);
    expect(state.snapshot(T0).title).toBe("how · 260829-tenancy · attempt 1");
  });
});

describe("the scene", () => {
  test("80x24, tick 6 — the frame in the README, exactly", () => {
    const frame = renderScene(scripted().snapshot(T0 + 221_000), { cols: 80, rows: 24, tick: 6 });
    expect(frame).toEqual([
      "+----------------------------------------------+      .---.",
      "| what · 260829-tenancy · attempt 1            |    /       \\",
      "+----------------------------------------------+   |    ·    |",
      "| reading api/src/Outbox.cs                    |    \\ \\     /",
      "| grep \"Outbox\"                                |      '---'",
      "| The tenancy boundary is the row filter, not… |      03:41",
      "| $ dotnet test tests/Unit → running           |",
      "|   → ok (12 s)                                |",
      "| writing tldrx-work/260829-tenancy/01-what/h… |",
      "+----------------------------------------------+",
      "",
      "     ,-----.            .-------.",
      "    ( ##### )           | o   o |",
      "     '--|--'            |   -   |",
      "     /  |  |            '---+---'",
      "  __/  [~]  \\__        __/     \\__",
      " |_____________|      |___________|",
      "   ||       ||         ||       ||",
      "",
      "  $0.00 of $6.00 · Ctrl-C stops after this turn",
    ]);
  });

  test("nothing ever leaves the frame, at any size the scene is used at", () => {
    const snapshot = scripted().snapshot(T0 + 221_000);
    for (const cols of [MIN_SCENE_COLS, 80, 100, 200]) {
      for (const rows of [MIN_SCENE_ROWS, 24, 60]) {
        const frame = renderScene(snapshot, { cols, rows, tick: 3 });
        expect(frame.length).toBeLessThanOrEqual(rows);
        for (const line of frame) expect(line.length).toBeLessThanOrEqual(cols);
      }
    }
  });

  test("the hand is the elapsed second hand, and it stops when the run does", () => {
    const state = scripted();
    const at = (ms: number): string => renderScene(state.snapshot(T0 + ms), { cols: 80, rows: 24, tick: 0 })[5] ?? "";
    expect(at(0)).toContain("00:00");
    expect(at(35_000)).toContain("00:35");
    // Twelve positions, one per five seconds: 0s and 60s are the same face.
    const noon = renderScene(state.snapshot(T0), { cols: 80, rows: 24, tick: 0 });
    const minute = renderScene(state.snapshot(T0 + 60_000), { cols: 80, rows: 24, tick: 0 });
    expect(noon[1]).toBe(minute[1] ?? "");
  });

  test("the teacher speaks next to herself, and only while the line is fresh", () => {
    const state = scripted();
    state.apply({ kind: "text", text: "Checking the outbox worker first." }, T0 + 220_000);
    const speaking = renderScene(state.snapshot(T0 + 221_000), { cols: 80, rows: 24, tick: 0 });
    expect(speaking[12]).toContain("( Checking the outbox worker first. )");
    const quiet = renderScene(state.snapshot(T0 + 260_000), { cols: 80, rows: 24, tick: 0 });
    expect(quiet[12]).not.toContain("Checking");
  });

  test("the footer names the failure rather than pretending it finished", () => {
    const state = scripted();
    state.apply({ kind: "cost", usd: 0.42, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, T0 + 5000);
    state.apply({ kind: "done", ok: false, structured: null, costUsd: 0.42 }, T0 + 5000);
    const frame = renderScene(state.snapshot(T0 + 5000), { cols: 80, rows: 24, tick: 0 });
    expect(frame[frame.length - 1]).toBe("  $0.42 of $6.00 · failed");
  });
});

describe("compact", () => {
  test("one line: spinner, elapsed, activity, spend", () => {
    const snapshot = scripted().snapshot(T0 + 221_000);
    expect(renderCompact(snapshot, 80, 6))
      .toBe("⠦ 03:41 writing tldrx-work/260829-tenancy/01-what/h… · $0.00/$6.00");
    expect(renderCompact(snapshot, 80, 6 + SPINNER.length)).toBe(renderCompact(snapshot, 80, 6));
  });

  test("it fits whatever it is given, and marks the end", () => {
    const state = scripted();
    for (const cols of [30, 40, 80, 200]) {
      expect(renderCompact(state.snapshot(T0), cols, 0).length).toBeLessThanOrEqual(cols);
    }
    state.apply({ kind: "done", ok: true, structured: null, costUsd: 0.42 }, T0);
    expect(renderCompact(state.snapshot(T0), 80, 0)).toStartWith("✓ ");
  });
});

describe("plain", () => {
  test("elapsed, then the summary — no escapes, no timezone", () => {
    expect(plainLine(221_000, "reading api/src/Outbox.cs")).toBe("[03:41] reading api/src/Outbox.cs");
  });
});

describe("which mode", () => {
  const tty = { isTty: true, cols: 100, rows: 40 };

  test("auto: scene on a big terminal, compact on a small one, plain in a pipe", () => {
    expect(resolveUiMode({ ...tty, env: {} })).toBe("scene");
    expect(resolveUiMode({ isTty: true, cols: 71, rows: 40, env: {} })).toBe("compact");
    expect(resolveUiMode({ isTty: true, cols: 100, rows: 19, env: {} })).toBe("compact");
    expect(resolveUiMode({ isTty: false, cols: 100, rows: 40, env: {} })).toBe("plain");
  });

  test("NO_COLOR and CI both mean plain, however big the terminal claims to be", () => {
    expect(resolveUiMode({ ...tty, env: { NO_COLOR: "1" } })).toBe("plain");
    expect(resolveUiMode({ ...tty, env: { CI: "true" } })).toBe("plain");
    expect(resolveUiMode({ ...tty, env: { CI: "0" } })).toBe("scene");
  });

  test("an explicit mode is honoured where it can be, and degrades where it cannot", () => {
    expect(resolveUiMode({ ...tty, env: {}, flag: "compact" })).toBe("compact");
    expect(resolveUiMode({ ...tty, env: {}, flag: "plain" })).toBe("plain");
    expect(resolveUiMode({ ...tty, env: {}, flag: "off" })).toBe("off");
    // A redraw loop in a pipe helps nobody, whatever was asked for.
    expect(resolveUiMode({ isTty: false, cols: 100, rows: 40, env: {}, flag: "scene" })).toBe("plain");
    // `off` means off even in a pipe.
    expect(resolveUiMode({ isTty: false, cols: 100, rows: 40, env: {}, flag: "off" })).toBe("off");
  });

  test("TLDRX_UI is the same lever, and the flag beats it", () => {
    expect(resolveUiMode({ ...tty, env: { TLDRX_UI: "compact" } })).toBe("compact");
    expect(resolveUiMode({ ...tty, env: { TLDRX_UI: "compact" }, flag: "scene" })).toBe("scene");
  });

  test("a value nobody could have meant is a usage error", () => {
    expect(() => resolveUiMode({ ...tty, env: {}, flag: "classroom" })).toThrow(UiModeError);
  });
});

describe("the driver", () => {
  /** Run `body` with a recording driver; returns everything it wrote to stderr. */
  function withDriver(
    options: Partial<Parameters<typeof startProgress>[0]>,
    body: (handle: ReturnType<typeof startProgress>, out: string[]) => void,
  ): { out: string[]; stdout: string[] } {
    const out: string[] = [];
    const stdout: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
      stdout.push(String(chunk));
      return true;
    };
    const handle = startProgress({
      root: ROOT,
      isTty: true,
      cols: 80,
      rows: 24,
      env: {},
      startedAt: T0,
      now: () => T0 + 1000,
      write: (text) => out.push(text),
      // No timer: every frame in a test is asked for, never scheduled.
      schedule: () => null,
      ...options,
    });
    try {
      body(handle, out);
    } finally {
      handle.stop();
      (process.stdout as { write: unknown }).write = realWrite;
      setProgressSink(null);
    }
    return { out, stdout };
  }

  test("hides the cursor, and restores it — including when the body throws", () => {
    const { out } = withDriver({}, () => undefined);
    expect(out[0]).toBe("\x1b[?25l");
    expect(out[out.length - 1]).toBe("\x1b[?25h");

    const seen: string[] = [];
    expect(() => {
      const handle = startProgress({
        root: ROOT, isTty: true, cols: 80, rows: 24, env: {},
        startedAt: T0, now: () => T0, write: (t) => seen.push(t), schedule: () => null,
      });
      try {
        throw new Error("the stage blew up");
      } finally {
        handle.stop();
      }
    }).toThrow("the stage blew up");
    expect(seen).toContain("\x1b[?25h");
    setProgressSink(null);
  });

  test("writes not one byte to stdout, with the UI on or off", () => {
    for (const flag of ["scene", "compact", "plain", "off"]) {
      const { stdout } = withDriver({ flag }, (handle) => {
        for (const [event] of SCRIPT) handle.onEvent(event);
        handle.onTitle("how · 260829-tenancy · attempt 1");
      });
      expect(stdout).toEqual([]);
    }
  });

  test("a repaint rewrites only the rows that changed", () => {
    withDriver({ flag: "scene" }, (handle, out) => {
      out.length = 0;
      handle.onEvent({ kind: "tool", id: "z", name: "Read", target: `${ROOT}/one.md` });
      const before = out.length;
      handle.onEvent({ kind: "tool", id: "y", name: "Read", target: `${ROOT}/two.md` });
      const repaint = out.slice(before).join("");
      // 20 rows in the block; exactly two of them differ (a new note pushes the
      // board up by one), so exactly two carry a clear-line escape.
      expect(repaint).toStartWith("\x1b[20A");
      expect(repaint.split("\r\x1b[2K").length - 1).toBeLessThan(20);
      expect(repaint).toContain("two.md");
    });
  });

  test("plain mode is log lines on stderr and no escape sequences at all", () => {
    const { out } = withDriver({ flag: "plain", isTty: false }, (handle) => {
      handle.onTitle("what · 260829-tenancy · attempt 1");
      handle.onEvent({ kind: "tool", id: "a", name: "Read", target: `${ROOT}/api/src/Outbox.cs` });
      handle.onEvent({ kind: "cost", usd: 0.42, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 });
    });
    expect(out).toEqual([
      "[00:01] — what · 260829-tenancy · attempt 1\n",
      "[00:01] reading api/src/Outbox.cs\n",
      "[00:01] $0.42 so far · 1 s\n",
    ]);
    expect(out.join("")).not.toContain("\x1b");
  });

  /**
   * The redraw is the one part of this that an assertion on the escape STRING
   * cannot really check: cursor-ups and clear-lines can be individually correct
   * and still land the block one row out. So the bytes are replayed through a
   * terminal model and the SCREEN is compared with what `render` says it should
   * be showing. This is the test that would catch an off-by-one.
   */
  test("replaying the escape stream reconstructs exactly the frame render() describes", () => {
    const term = new TinyTerminal();
    let handle: ReturnType<typeof startProgress> | null = null;
    const stream: string[] = [];
    handle = startProgress({
      root: ROOT, isTty: true, cols: 80, rows: 24, env: {}, flag: "scene",
      startedAt: T0, now: () => T0 + 221_000, write: (t) => { stream.push(t); term.write(t); },
      schedule: () => null,
    });
    try {
      handle.onTitle("what · 260829-tenancy · attempt 1");
      for (const [event] of SCRIPT) handle.onEvent(event);
      expect(term.cursorVisible).toBe(false);
      expect(term.screen()).toEqual([...handle.frame()]);

      // A stdout line scrolling past must leave the block intact underneath it.
      handle.log(() => term.write("01-what/alpha … done $0.42\n"));
      expect(term.screen()[0]).toBe("01-what/alpha … done $0.42");
      expect(term.screen().slice(1)).toEqual([...handle.frame()]);
    } finally {
      handle.stop();
    }
    expect(term.cursorVisible).toBe(true);
    setProgressSink(null);
  });

  test("`off` draws nothing and installs no sink", () => {
    const { out } = withDriver({ flag: "off" }, (handle) => {
      handle.onEvent({ kind: "tool", id: "a", name: "Read", target: "x" });
      expect(handle.frame()).toEqual([]);
    });
    expect(out).toEqual([]);
  });

  test("log() erases the block, lets stdout through, and repaints it", () => {
    withDriver({ flag: "scene" }, (handle, out) => {
      out.length = 0;
      handle.log(() => undefined);
      const text = out.join("");
      expect(text).toStartWith("\x1b[20A\x1b[J");
      // erased, then the whole block painted again from scratch
      expect(text).toContain("Ctrl-C stops after this turn");
    });
  });
});

/**
 * Through the real CLI, with the fake `claude` first on PATH.
 *
 * The point of these is the CONTRACT, not the picture: whatever the view does,
 * stdout must be the same bytes it was before the view existed, because the chat
 * bridge and every `--json` consumer read it.
 */
describe("tldrx next, with a view", () => {
  const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
  const open: FacilitatorWorkspace[] = [];

  afterEach(() => {
    for (const ws of open) ws.dispose();
    open.length = 0;
  });

  function workspace(): FacilitatorWorkspace {
    const made = makeFacilitatorWorkspace({
      scope: "demo",
      budgetUsd: 10,
      stages: [
        {
          id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
          outputs: [
            { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
            { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
          ],
        },
        { id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto", outputs: [{ path: "02-how/handoff.md" }] },
      ],
    });
    open.push(made);
    return made;
  }

  async function next(ws: FacilitatorWorkspace, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([process.execPath, BIN, "next", ...args], {
      cwd: ws.root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // The fake FIRST, so `claude` can never resolve to the real binary; the
        // rest of PATH stays so `git` and the runtime still work.
        PATH: `${ws.binDir}:${process.env.PATH ?? ""}`,
        FAKE_CLAUDE_RUNDIR: ws.runDir,
        FAKE_CLAUDE_COST: "0.42",
        FAKE_CLAUDE_OUTPUTS: JSON.stringify({
          "01-what/intent.md": cannedIntent(),
          "01-what/handoff.md": cannedHandoff(),
        }),
      },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test("stdout is byte-identical with the view on and off", async () => {
    const off = await next(workspace(), "--ui", "off");
    const plain = await next(workspace(), "--ui", "plain");
    expect(off.code).toBe(0);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(off.stdout);
    expect(off.stdout).toContain("01-what/alpha");
  }, 30_000);

  test("plain mode says what the sub-agent did, on stderr, while off says nothing", async () => {
    const plain = await next(workspace(), "--ui", "plain");
    expect(plain.stderr).toContain("] — alpha · ");
    expect(plain.stderr).toMatch(/\] writing (…\/)?tldrx-work\/260828-demo\/01-what\/handoff\.md/); // the "…/" elision depends on how long the temp root is (macOS vs Linux)
    expect(plain.stderr).toContain("] $0.42 so far");
    expect(plain.stderr).not.toContain("\x1b");

    // `off` draws nothing. (The expert-evidence advisory is stderr too, and is
    // not part of the view — hence the shape of this assertion.)
    const off = await next(workspace(), "--ui", "off");
    expect(off.stderr).not.toMatch(/\[\d\d:\d\d\]/);
  }, 30_000);

  test("a bad --ui value is refused before any money is spent", async () => {
    const bad = await next(workspace(), "--ui", "classroom");
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.stderr).toContain("--ui must be one of");
    // The run never started: no agent event was appended.
    expect(bad.stderr).not.toContain("$0.42");
  }, 30_000);

  test("`--prepare` spawns nothing, so it gets no view even when one is asked for", async () => {
    const prepared = await next(workspace(), "--prepare", "--ui", "plain");
    expect(prepared.code).toBe(0);
    expect(prepared.stdout).toContain("prepared 01-what/alpha");
    expect(prepared.stderr).not.toMatch(/\[\d\d:\d\d\]/);
  }, 30_000);
});
