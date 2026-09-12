/**
 * `tldrx run auto --until-done [<n>]` — an in-process supervisor over the loop (gh #252).
 *
 * The measurement behind it (2026-09-12, two workspaces, tldrx 0.16.1): one run spent 18 of
 * its 28 wall hours waiting for a person to read an exit, decide it was safe, and type
 * `tldrx run auto` again — five times. `--retry-failed` covered none of the five: it bounds
 * exit 5 INSIDE the loop, and every one of the five was the loop itself ending — a throw
 * that reached `fail()` as a bare 1, a stage failure past the bound, a refusal whose remedy
 * was to run the same command again.
 *
 * What these tests hold:
 *
 *   UNCHANGED BY DEFAULT   no flag ⇒ one attempt, the lines byte-identical to `--until-done 0`,
 *                          and no `run.relaunched` anywhere on the ledger.
 *   RELAUNCH ON 5          past `--retry-failed`, the loop is run again — every relaunch is a
 *                          `run.relaunched {reason, exit, attempt, of}` on the ledger.
 *   RELAUNCH ON 1          a throw that used to escape as a bare exit 1 is caught and relaunched;
 *                          `run.failed` is never sent for an attempt that was relaunched, and
 *                          `run.finished` goes out ONCE, from the last attempt.
 *   NEVER OVER MONEY       exit 2 with a `budget.blocked` behind it is attempted once however
 *                          large the bound — nothing in-process moves a ceiling (#232/#244) —
 *                          and the stop names the two figures. The loop's own `--max-usd`
 *                          spans the whole supervised run: a relaunch does not reset it.
 *   NEVER OVER A PERSON    exit 4 is a person's; `--wait-*` own it; zero relaunches.
 *   NEVER TWICE THE SAME   an attempt whose last line equals the previous attempt's is a
 *                          deterministic refusal repeating — one relaunch proves it, then stop.
 *   BOUNDED, BY NAME       `n` past `MAX_UNTIL_DONE` and a fraction are exit 1, nothing spawned;
 *                          the bare flag means `MAX_UNTIL_DONE`, said in the event's `of`.
 *
 * Hermetic: one `mkdtemp` workspace per case, the fake `claude` is the only thing spawned,
 * and every attempt is counted off that fake's own argv log rather than off a log line.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { runAuto, LAST_LINE_CHARS, MAX_UNTIL_DONE, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { runCommand } from "../src/cli/commands/run.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import { deliveredTo, writeNotifier, workspaceYamlWithNotify } from "./fixtures/facilitator/notifier.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

setDefaultTimeout(spawnTestTimeout(120_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR",
  "FAKE_CLAUDE_FAIL_SEQ", "FAKE_CLAUDE_FAIL_COUNTER", "FAKE_CLAUDE_ARGV_LOG", "TLDRX_AGENT_PROVIDER",
] as const;
let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const ALPHA: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
  ],
};
const BETA: StageOptions = {
  id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve",
  outputs: [{ path: "02-how/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
};

interface Made extends FacilitatorWorkspace {
  /** Every spawn of the fake agent, one JSON argv line each — the attempt counter. */
  readonly argvLog: string;
  /** Where the declared notifier appends what it was handed; empty when none was declared. */
  readonly outbox: string;
}

/**
 * `failures`: one 0/1 per spawn, in order. Omitted ⇒ every spawn succeeds.
 * `gates`: the workflow's gate policy per stage — `auto` unless a test parks on a person.
 * `notifier`: declare the §2.18 hook, so `run.finished` / `run.failed` can be counted.
 */
function workspace(
  failures: readonly number[] = [],
  options: { gates?: Readonly<Record<string, string>>; notifier?: boolean } = {},
): Made {
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10,
    gates: options.gates ?? { alpha: "auto", beta: "auto" },
  });
  open.push(made);
  const outbox = join(made.root, "notified.jsonl");
  if (options.notifier === true) {
    const script = writeNotifier(made.root, 0);
    writeFileSync(
      join(made.root, ".tldrx", "workspace.yml"),
      workspaceYamlWithNotify(`${script} ${outbox}`),
      "utf8",
    );
  }
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": cannedHandoff(),
    "02-how/handoff.md": cannedHandoff(),
  });
  process.env.FAKE_CLAUDE_COST = "0.42";
  const argvLog = join(made.root, "spawns.jsonl");
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  if (failures.length > 0) {
    process.env.FAKE_CLAUDE_FAIL_SEQ = failures.join(",");
    process.env.FAKE_CLAUDE_FAIL_COUNTER = join(made.root, "spawn-count");
  }
  return { ...made, argvLog, outbox };
}

function auto(ws: Made, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-09-12T09:00:00Z", ...overrides });
}

/** How many times the agent was actually spawned — measured, not inferred from stdout. */
function attempts(ws: Made): number {
  if (!existsSync(ws.argvLog)) return 0;
  return readFileSync(ws.argvLog, "utf8").split("\n").filter((line) => line !== "").length;
}

function events(ws: Made): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

function relaunched(ws: Made): readonly TldrxEvent[] {
  return events(ws).filter((event) => event.type === "run.relaunched");
}

/** The notify kinds delivered, in order — `[]` when no hook was declared. */
function kinds(ws: Made): readonly string[] {
  return deliveredTo(ws.outbox).map((payload) => String(payload.kind));
}

/**
 * A phase ceiling lowered by hand, exactly as `test/facilitator.test.ts` starves one: the
 * one way to a real `budget.blocked` on a fresh run, since `run new` prices every phase to
 * hold its own stages.
 */
function starve(ws: Made, phaseId: string, ceiling: number): void {
  const path = join(ws.runDir, "budget.yml");
  const text = readFileSync(path, "utf8");
  const pattern = new RegExp(`(\\{id: "?${phaseId}"?, ceiling_usd: )[0-9.]+`);
  const next = text.replace(pattern, `$1${ceiling.toFixed(2)}`);
  if (next === text) throw new Error(`starve() did not match a phase row for ${phaseId} in budget.yml`);
  writeFileSync(path, next, "utf8");
}

/** The loop's lines with the two per-workspace strings normalised, so two runs compare. */
function normalised(ws: Made, lines: readonly string[]): readonly string[] {
  return lines.map((line) => line.split(ws.root).join("<root>").split(ws.runId).join("<run>"));
}

describe("with no flag, nothing moves — the guard", () => {
  test("one attempt, exit 5, no run.relaunched, and the lines are the lines `--until-done 0` prints", async () => {
    const bare = workspace([1, 1, 1]);
    const bareOutcome = await auto(bare);
    expect(bareOutcome.code).toBe(5);
    expect(attempts(bare)).toBe(1);
    expect(relaunched(bare)).toEqual([]);
    expect(bareOutcome.lines.some((line) => line.includes("relaunch"))).toBe(false);

    const zero = workspace([1, 1, 1]);
    const zeroOutcome = await auto(zero, { untilDone: 0 });
    expect(zeroOutcome.code).toBe(5);
    expect(attempts(zero)).toBe(1);
    expect(relaunched(zero)).toEqual([]);
    expect(normalised(zero, zeroOutcome.lines)).toEqual(normalised(bare, bareOutcome.lines));
  });
});

describe("exit 5 past --retry-failed is relaunched, and the ledger says so", () => {
  test("`--until-done 2` over a stage that fails once with `--retry-failed 0`: relaunched once, then done", async () => {
    const ws = workspace([1, 0, 0]);
    const outcome = await auto(ws, { untilDone: 2, retryFailedStages: 0 });
    expect(outcome.code).toBe(0);
    expect(attempts(ws)).toBe(3);
    const relaunches = relaunched(ws);
    expect(relaunches).toHaveLength(1);
    expect(relaunches[0]?.payload).toMatchObject({ exit: 5, attempt: 1, of: 2 });
    expect(typeof relaunches[0]?.payload.reason).toBe("string");
    expect(String(relaunches[0]?.payload.reason)).not.toBe("");
    expect(outcome.lines.some((line) => line.startsWith("relaunching"))).toBe(true);
  });
});

describe("a throw that used to be a bare exit 1", () => {
  test("the shape is real: with no flag the same throw still escapes runAuto, having spawned nothing", async () => {
    const ws = workspace();
    process.env.TLDRX_AGENT_PROVIDER = "bogus";
    await expect(auto(ws)).rejects.toThrow("TLDRX_AGENT_PROVIDER must be one of");
    expect(attempts(ws)).toBe(0);
  });

  test("thrown on the first attempt only: relaunched, done, `run.finished` once and no `run.failed`", async () => {
    const ws = workspace([], { notifier: true });
    // A bad provider name throws out of `spawnAgent` before a byte of the turn exists —
    // the same shape any other throw takes out of a non-Build stage (the Build executor
    // has its own seam, `test/payload-cap.test.ts`). Cleared the moment the supervisor
    // says it is relaunching, so the SECOND attempt spawns the fake for real.
    process.env.TLDRX_AGENT_PROVIDER = "bogus";
    const outcome = await auto(ws, {
      untilDone: 3,
      onLine: (line) => {
        if (line.startsWith("relaunching")) delete process.env.TLDRX_AGENT_PROVIDER;
      },
    });
    expect(outcome.code).toBe(0);
    expect(attempts(ws)).toBe(2);
    const relaunches = relaunched(ws);
    expect(relaunches).toHaveLength(1);
    expect(relaunches[0]?.payload).toMatchObject({ exit: 1, attempt: 1, of: 3 });
    expect(String(relaunches[0]?.payload.reason)).toContain("TLDRX_AGENT_PROVIDER must be one of");
    const delivered = kinds(ws);
    expect(delivered.filter((kind) => kind === "run.finished")).toHaveLength(1);
    expect(delivered).not.toContain("run.failed");
    expect(delivered[delivered.length - 1]).toBe("run.finished");
  });
});

describe("the ledger keeps the END of a long last line — the actionable end", () => {
  test("a 600-char throw whose useful token is last: `last_line` ends with it, and stays under the cap", async () => {
    const ws = workspace();
    // The message the throw carries is `… got "<value>"`: the value is its END, which is
    // where a branch name, an exit code or a refusal's reason sits on a real line (the
    // #235 shape — a front slice keeps the boilerplate and cuts the part a person acts on).
    // Lower-case on purpose: `agentProvider()` lower-cases the value before quoting it.
    const token = "the-token-at-the-end";
    process.env.TLDRX_AGENT_PROVIDER = `${"x".repeat(600)}${token}`;
    const outcome = await auto(ws, {
      untilDone: 1,
      onLine: (line) => {
        if (line.startsWith("relaunching")) delete process.env.TLDRX_AGENT_PROVIDER;
      },
    });
    expect(outcome.code).toBe(0);
    const relaunches = relaunched(ws);
    expect(relaunches).toHaveLength(1);
    const lastLine = String(relaunches[0]?.payload.last_line);
    const reason = String(relaunches[0]?.payload.reason);
    expect(lastLine.endsWith(`${token}"`)).toBe(true);
    expect(reason.endsWith(`${token}"`)).toBe(true);
    expect(lastLine.startsWith("run auto threw:")).toBe(true);
    expect(lastLine).toContain("…");
    expect(lastLine.length).toBeLessThanOrEqual(LAST_LINE_CHARS);
    expect(reason.length).toBeLessThanOrEqual(LAST_LINE_CHARS);
  });
});

describe("never over money", () => {
  test("a budget.blocked is attempted once however large the bound, and the stop names remaining and estimate", async () => {
    const ws = workspace();
    starve(ws, "01-what", 1);
    const outcome = await auto(ws, { untilDone: 5 });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(0);
    expect(relaunched(ws)).toEqual([]);
    const blocked = events(ws).filter((event) => event.type === "budget.blocked");
    expect(blocked).toHaveLength(1);
    const last = outcome.lines[outcome.lines.length - 1] ?? "";
    expect(last).toContain("budget.blocked");
    // The figures are the EVENT's — the phase's $1.00 `starve` left, against one attempt of
    // alpha as the brake priced it — and the stop line must quote them, not re-derive them.
    const remaining = Number(blocked[0]?.payload.remaining_usd);
    const estimate = Number(blocked[0]?.payload.estimate_usd);
    expect(remaining).toBe(1);
    expect(estimate).toBeGreaterThan(remaining);
    expect(last).toContain(`remaining_usd $${remaining.toFixed(2)}`);
    expect(last).toContain(`estimate_usd $${estimate.toFixed(2)}`);
  });

  test("`--max-usd` spans the supervised run: a relaunch does not hand the loop a fresh ceiling", async () => {
    // alpha fails ($0.42 spent) → exit 5 → relaunched. The second attempt inherits that
    // $0.42: alpha succeeds ($0.84 by this loop), and $0.84 ≥ $0.80 stops it BETWEEN stages.
    // A supervisor that reset the loop's own figure would run beta too and exit 0 — three
    // spawns, and $0.84 spent under a ceiling of $0.80 that nobody raised.
    const ws = workspace([1, 0, 0]);
    const outcome = await auto(ws, { untilDone: 3, maxUsd: 0.8 });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(2);
    expect(relaunched(ws)).toHaveLength(1);
    expect(outcome.lines.join("\n")).toContain("--max-usd");
  });
});

describe("never over a person", () => {
  test("a human gate is exit 4, one spawn, zero relaunches, however large the bound", async () => {
    const ws = workspace([], { gates: { alpha: "human", beta: "human" } });
    const outcome = await auto(ws, { untilDone: 5 });
    expect(outcome.code).toBe(4);
    expect(attempts(ws)).toBe(1);
    expect(relaunched(ws)).toEqual([]);
  });
});

describe("never twice over the same last line", () => {
  test("a refusal that repeats verbatim is relaunched once — the proof — and then stops", async () => {
    // `promptMaxBytes: 1` is an exit 2 with no money behind it: the prompt cannot fit, the
    // same way on every attempt. One relaunch shows it repeats; a second would be the loop
    // hammering a refusal.
    const ws = workspace();
    const outcome = await auto(ws, { untilDone: 5, promptMaxBytes: 1 });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(0);
    const relaunches = relaunched(ws);
    expect(relaunches).toHaveLength(1);
    expect(relaunches[0]?.payload).toMatchObject({ exit: 2, attempt: 1, of: 5 });
    expect(outcome.lines[outcome.lines.length - 1]).toContain("same as the previous attempt");
  });
});

describe("a bound the loop will not honour is refused by name, not clamped", () => {
  test("one past the cap is a usage error (exit 1) and spawns nothing", async () => {
    const ws = workspace();
    const code = await runCommand.run(
      ["auto", "--until-done", String(MAX_UNTIL_DONE + 1), "--root", ws.root, "--ui", "off"],
    );
    expect(code).toBe(1);
    expect(attempts(ws)).toBe(0);
  });

  test("a fraction is refused too — 1.5 relaunches is not a thing", async () => {
    const ws = workspace();
    const code = await runCommand.run(["auto", "--until-done", "1.5", "--root", ws.root, "--ui", "off"]);
    expect(code).toBe(1);
    expect(attempts(ws)).toBe(0);
  });

  test("the bare flag means MAX_UNTIL_DONE, and the event's `of` says so", async () => {
    const ws = workspace([1, 0, 0]);
    const code = await runCommand.run(["auto", "--until-done", "--root", ws.root, "--ui", "off"]);
    expect(code).toBe(0);
    expect(attempts(ws)).toBe(3);
    expect(relaunched(ws)[0]?.payload).toMatchObject({ exit: 5, attempt: 1, of: MAX_UNTIL_DONE });
  });
});
