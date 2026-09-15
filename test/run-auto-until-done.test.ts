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
 *   NEVER TWICE THE SAME   an attempt refused by the SAME WORDS as the one before it is a
 *                          deterministic refusal repeating — one relaunch proves it, then stop.
 *                          What is compared is the refusal `next` NAMES (gh #297): every stage
 *                          death ends with the same advice literal, so comparing last lines
 *                          compared a constant to itself and stopped a run making progress.
 *   BOUNDED, BY NAME       `n` past `MAX_UNTIL_DONE` and a fraction are exit 1, nothing spawned;
 *                          the bare flag means `MAX_UNTIL_DONE`, said in the event's `of`.
 *
 * Hermetic: one `mkdtemp` workspace per case, the fake `claude` is the only thing spawned,
 * and every attempt is counted off that fake's own argv log rather than off a log line.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import {
  runAuto, budgetBlockedReason, LAST_LINE_CHARS, MAX_UNTIL_DONE, type AutoOptions,
} from "../src/core/facilitator/runAuto.ts";
import { runCommand } from "../src/cli/commands/run.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { WATCH_PHASE } from "../src/core/watch/index.ts";
import { GATE_SIGNER_MARKER } from "../src/core/facilitator/gateSigner.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { revoke } from "../src/core/run/gates.ts";
import { buildBudgetView, renderBudget } from "../src/core/budget/budgetView.ts";
import { planRebalance } from "../src/core/budget/rebalance.ts";
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
  "FAKE_CLAUDE_ALT_MATCH", "FAKE_CLAUDE_ALT_OUTPUTS",
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

/**
 * Label one phase `host-tokens` in the file on disk, exactly as `test/economy.test.ts` does —
 * the one way to a real host-tokens `budget.blocked`, since `run new` prices in dollars.
 */
function priceInHostTokens(ws: Made, phaseId: string): void {
  const path = join(ws.runDir, "budget.yml");
  const marker = new RegExp(`id: "?${phaseId}"?,`);
  const text = readFileSync(path, "utf8");
  const next = text.split("\n").map((line) =>
    marker.test(line) ? line.replace(/}\s*$/, ", economy: host-tokens}") : line,
  ).join("\n");
  if (next === text) throw new Error(`priceInHostTokens() did not match a phase row for ${phaseId}`);
  writeFileSync(path, next, "utf8");
}

/** beta on `gates_policy: agent`, with the fake gate-signer writing a note that signs it. */
function agentGateWorkspace(): Made {
  const made = makeFacilitatorWorkspace({
    scope: "demo", budgetUsd: 10, gates: { alpha: "auto", beta: "agent" },
    stages: [{ ...ALPHA, checks: "[claim-sources]" }, { ...BETA, checks: "[claim-sources]" }],
  });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
    "01-what/intent.md": cannedIntent(), "01-what/handoff.md": cannedHandoff(), "02-how/handoff.md": cannedHandoff(),
  });
  process.env.FAKE_CLAUDE_COST = "0.42";
  process.env.FAKE_CLAUDE_ALT_MATCH = GATE_SIGNER_MARKER;
  const gate = "02-how/beta";
  process.env.FAKE_CLAUDE_ALT_OUTPUTS = JSON.stringify({
    ".agent/beta/evidence.md": [
      "---", "version: 1", `gate: ${gate}`, "role: agent", "by: fable", "at: 2026-08-28T22:14:03Z", "verdict: sign",
      'read: ["02-how/handoff.md"]', "citations: {sampled: 2, of: 4, resolved: 2, refuted: 0}",
      "touches: {audited: 3, outside_surface: 0, new_areas: []}", "diff_vs_stories: n-a", "caveats: []", "recommend: []",
      "---", "", `# Gate evidence — ${gate}`, "", "## Read", "- the handoff [src: 02-how/handoff.md:1]", "",
      "## Citations checked", "- 2 of 4 spot-checked [src: 02-how/handoff.md:4]", "",
      "## Touches audited", "- 3 paths, all inside the surface [src: .tldrx/workspace.yml:1]", "",
      "## Verdict", "- SIGN — every declared output is on disk [src: .tldrx/workspace.yml:1]", "",
    ].join("\n"),
  });
  const argvLog = join(made.root, "spawns.jsonl");
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  return { ...made, argvLog, outbox: join(made.root, "notified.jsonl") };
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

  /**
   * gh #270. The dollar case above is only HALF the refusals `budgetBlockedReason` sees: a
   * phase priced in `host-tokens` is blocked by a row that carries no `remaining_usd` and no
   * `estimate_usd` at all, and the reason rendered `$0.00 < $0.00` off `number()`'s default —
   * a confident figure nothing measured, plus `tldrx budget raise`, a dollar command for a
   * ceiling that is a token allowance. The row's OWN words are the ones a person can act on.
   */
  test("a host-tokens budget.blocked names tokens and the row's reason — no invented dollars", async () => {
    const ws = workspace();
    priceInHostTokens(ws, "01-what");
    const outcome = await auto(ws, { untilDone: 5 });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(0);
    expect(relaunched(ws)).toEqual([]);
    const blocked = events(ws).filter((event) => event.type === "budget.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ phase: "01-what", economy: "host-tokens" });
    expect(blocked[0]?.payload.remaining_usd).toBeUndefined();
    expect(blocked[0]?.payload.estimate_usd).toBeUndefined();
    const last = outcome.lines[outcome.lines.length - 1] ?? "";
    expect(last).toContain("budget.blocked on 01-what (host-tokens)");
    expect(last).toContain(`ceiling_tokens ${String(blocked[0]?.payload.ceiling_tokens)}`);
    expect(last).toContain(String(blocked[0]?.payload.reason));
    // The two wrongs the issue names, both absent: no dollar figure, no dollar command.
    expect(last).not.toContain("$");
    expect(last).not.toContain("tldrx budget raise");
  });

  /**
   * The other `host-tokens` writer (`hostTokensNote`) carries the pair, and the reason must
   * name BOTH sides — the comparison whose two numbers share a unit. Read straight off the
   * function, because reaching this row through the loop needs a declared-token run.
   */
  test("a host-tokens row carrying the pair names host_tokens of ceiling_tokens", () => {
    const reason = budgetBlockedReason([{
      version: 1, ts: "2026-09-14T09:00:00Z", run: "260914-x", actor: "alan", stage: "build",
      type: "budget.blocked",
      payload: {
        phase: "04-build", economy: "host-tokens", host_tokens: 210000, ceiling_tokens: 150000,
        reason: "declared host tokens are over the phase ceiling",
      },
    } as unknown as TldrxEvent]);
    expect(reason).toContain("budget.blocked on 04-build (host-tokens)");
    expect(reason).toContain("host_tokens 210000 of ceiling_tokens 150000");
    expect(reason).toContain("declared host tokens are over the phase ceiling");
    expect(reason).not.toContain("$");
  });

  /**
   * gh #270's other half: the DOLLAR reason must not invent its figures either. A row with no
   * `remaining_usd`/`estimate_usd` is absent-with-reason, never a confident `$0.00`.
   */
  test("a dollar row missing its figures says so, and never prints $0.00", () => {
    const reason = budgetBlockedReason([{
      version: 1, ts: "2026-09-14T09:00:00Z", run: "260914-x", actor: "alan", stage: "build",
      type: "budget.blocked",
      payload: { phase: "04-build", reason: "the ceiling refused" },
    } as unknown as TldrxEvent]);
    expect(reason).toContain("budget.blocked on 04-build");
    expect(reason).not.toContain("$0.00");
    expect(reason).toContain("not recorded");
    expect(reason).toContain("the ceiling refused");
  });

  /**
   * gh #314. Measured on a field run: 04-build refused $11.07 short while 01-what had finished
   * $16.25 under, and a person typed `budget raise 04-build 12 --take-from 01-what`. With the
   * opt-OUT (gh #330: on by default) nothing moves — the launcher said a phase
   * ceiling means exactly what it was set to — but the refusal still names the finished phase
   * holding the money and the exact move.
   */
  test("with --no-rebalance-finished the refusal stands, and names the finished phase holding unspent ceiling", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const outcome = await auto(ws, { untilDone: 5, rebalanceFinished: false });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(1);
    expect(events(ws).filter((event) => event.type === "budget.raised")).toEqual([]);
    const blocked = events(ws).filter((event) => event.type === "budget.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ short_usd: 1, finished_unspent_usd: 5.58 });
    const text = outcome.lines.join("\n");
    expect(text).toContain(`tldrx budget raise 02-how 1.00 --run ${ws.runId} --take-from 01-what`);
    expect(text).toContain("--rebalance-finished");
    expect(readFileSync(join(ws.runDir, "budget.yml"), "utf8")).toContain('{id: "02-how", ceiling_usd: 1.00');
  });

  test("with --rebalance-finished the shortfall moves out of the finished phase, on the record, and the run finishes", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const outcome = await auto(ws, { untilDone: 5, rebalanceFinished: true });
    expect(outcome.code).toBe(0);
    expect(attempts(ws)).toBe(2);
    const raised = events(ws).filter((event) => event.type === "budget.raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.actor).toBe("alan");
    expect(raised[0]?.payload).toMatchObject({
      phase: "02-how", amount_usd: 1, take_from: "01-what",
      phase_ceiling_before: 1, phase_ceiling_after: 2,
      take_from_ceiling_before: 6, take_from_ceiling_after: 5,
      run_ceiling_before: 10, run_ceiling_after: 10,
      source: "run auto --rebalance-finished",
    });
    expect(String(raised[0]?.payload.note)).toContain("01-what");
    expect(events(ws).filter((event) => event.type === "budget.blocked")).toEqual([]);
    const budgetText = readFileSync(join(ws.runDir, "budget.yml"), "utf8");
    expect(budgetText).toContain("ceiling_usd: 10.00");
    expect(budgetText).toContain('{id: "01-what", ceiling_usd: 5.00');
    expect(budgetText).toContain('{id: "02-how", ceiling_usd: 2.00');
    expect(outcome.lines.join("\n")).toContain("moved $1.00 from 01-what");
  });

  test("with --rebalance-finished but too little unspent, nothing moves and the refusal says how short", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const outcome = await auto(ws, {
      untilDone: 5,
      rebalanceFinished: true,
      // After alpha settles at $0.42, leave 01-what only $0.08 unspent.
      onLine: (line) => {
        if (line.startsWith("01-what/alpha") && line.includes("done")) starve(ws, "01-what", 0.5);
      },
    });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(1);
    expect(events(ws).filter((event) => event.type === "budget.raised")).toEqual([]);
    const blocked = events(ws).filter((event) => event.type === "budget.blocked");
    expect(blocked[0]?.payload).toMatchObject({ short_usd: 1, finished_unspent_usd: 0.08, uncovered_usd: 0.92 });
    expect(outcome.lines.join("\n")).toContain("$0.92 short");
    expect(outcome.lines[outcome.lines.length - 1]).toContain("$0.92 short");
  });

  test("with --rebalance-finished, a move that would pass the owner's grant is not made — not even under warn", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const path = join(ws.runDir, "budget.yml");
    const text = readFileSync(path, "utf8")
      .replace('{id: "02-how", ceiling_usd: 1.00, spent_usd: 0.00}', '{id: "02-how", ceiling_usd: 1.00, spent_usd: 0.00, authorized_usd: 1.50}')
      .replace("on_exceed: block", "on_exceed: block\nauthorized_by: F001\nauthorized_at: \"2026-09-14T00:00:00Z\"\non_grant_exceed: warn");
    writeFileSync(path, text, "utf8");
    const outcome = await auto(ws, { untilDone: 5, rebalanceFinished: true });
    expect(outcome.code).toBe(2);
    expect(events(ws).filter((event) => event.type === "budget.raised")).toEqual([]);
    expect(outcome.lines.join("\n")).toContain("F001");
  });

  /**
   * gh #330 (owner-approved 2026-09-15): the rebalance is ON by default under `run auto`. The
   * audit behind it: 22 intervention episodes on stage/phase sizing, 27 `budget.raised`, none of
   * which changed the work. No flag given ⇒ the same move `--rebalance-finished` made, under the
   * same rules and the same `source`.
   */
  test("by default (no flag) the shortfall moves out of the finished phase, on the record, and the run finishes (#330)", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const outcome = await auto(ws, { untilDone: 5 });
    expect(outcome.code).toBe(0);
    const raised = events(ws).filter((event) => event.type === "budget.raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.payload).toMatchObject({
      phase: "02-how", amount_usd: 1, take_from: "01-what", run_ceiling_before: 10, run_ceiling_after: 10,
      source: "run auto --rebalance-finished",
    });
    expect(events(ws).filter((event) => event.type === "budget.blocked")).toEqual([]);
  });

  test("the CLI default reaches the loop: a bare `tldrx run auto` moves the money and finishes (#330)", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const code = await runCommand.run(["auto", "--root", ws.root, "--ui", "off"]);
    expect(code).toBe(0);
    expect(events(ws).filter((event) => event.type === "budget.raised")).toHaveLength(1);
  });

  test("`tldrx run auto --no-rebalance-finished` opts out: nothing moves and the refusal is exit 2 (#330)", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const code = await runCommand.run(["auto", "--no-rebalance-finished", "--root", ws.root, "--ui", "off"]);
    expect(code).toBe(2);
    expect(events(ws).filter((event) => event.type === "budget.raised")).toEqual([]);
    expect(events(ws).filter((event) => event.type === "budget.blocked")).toHaveLength(1);
  });

  test("both `--rebalance-finished` and `--no-rebalance-finished` is a usage refusal, exit 1, nothing spawned (#330)", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const code = await runCommand.run(["auto", "--rebalance-finished", "--no-rebalance-finished", "--root", ws.root, "--ui", "off"]);
    expect(code).toBe(1);
    expect(attempts(ws)).toBe(0);
  });

  test("the CLI flag reaches the loop: `tldrx run auto --rebalance-finished` moves the money and finishes", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    const code = await runCommand.run(["auto", "--rebalance-finished", "--root", ws.root, "--ui", "off"]);
    expect(code).toBe(0);
    expect(events(ws).filter((event) => event.type === "budget.raised")).toHaveLength(1);
  });

  test("the move is written through a fresh store: a long-lived store adopts it without its ceilings winning later saves (#236)", () => {
    const ws = workspace();
    const longLived = RunStore.open(ws.runDir);
    const other = RunStore.open(ws.runDir);
    other.mutateBudget((b) => ({ ...b, phases: b.phases.map((p) => p.id === "02-how" ? { ...p, ceiling_usd: 2 } : p) }));
    other.save();
    longLived.refreshCeilings();
    expect(longLived.budget.phases.find((p) => p.id === "02-how")?.ceiling_usd).toBe(2);
    // A person's raise AFTER the adoption must survive the long-lived store's next save.
    starve(ws, "01-what", 5.5);
    longLived.save();
    expect(readFileSync(join(ws.runDir, "budget.yml"), "utf8")).toContain('{id: "01-what", ceiling_usd: 5.50');
  });

  /**
   * gh #314, measured before this fix: with beta on `gates_policy: agent` and a signing note, the
   * control run self-signs beta (`by: fable`); the same run with `--rebalance-finished` moving
   * $1.00 into 02-how fell to a person with "a ceiling a PERSON moved" and a decision card
   * headed "a person moved the ceiling" — while the event's actor was the loop's launcher and
   * its `source` was the flag. The fall-through itself stands (a move made to unblock a stage is
   * still a budget decision in its window — `started_at` is the loop's `at`, so the move is
   * always inside it); what it SAYS must name who and what moved the money.
   */
  test("an agent gate on the stage a rebalance unblocked falls to a person, attributing the move to the flag, not to a person", async () => {
    const control = agentGateWorkspace();
    const signed = await auto(control, { rebalanceFinished: true });
    expect(signed.code).toBe(0);
    expect(RunStore.open(control.runDir).run.phases[1]?.stages[0]?.gate.by).toBe("fable");

    const ws = agentGateWorkspace();
    starve(ws, "02-how", 1);
    const outcome = await auto(ws, { rebalanceFinished: true });
    expect(outcome.code).toBe(4);
    expect(RunStore.open(ws.runDir).run.phases[1]?.stages[0]?.gate.status).toBe("pending");
    const text = outcome.lines.join("\n");
    const reason = outcome.lines.find((line) => line.includes("budget-event:")) ?? "";
    expect(reason).toContain("run auto --rebalance-finished");
    expect(reason).toContain("launched by alan");
    expect(reason).toContain("$1.00 from finished 01-what");
    expect(text).not.toContain("a person moved");
    expect(text).not.toContain("a ceiling a person moved");
  });

  /**
   * Review finding on 2d8917f: a donor that STOPS being finished (its gate revoked) keeps the
   * ceiling it gave away, and nothing said so. Nothing moves the money back on its own — the
   * recipient may have spent it — but the revoke, the refusal on that phase and `budget show`
   * name the earlier move and the exact `--take-from` that returns what is still unspent, and a
   * later rebalance never takes from the phase again while it is unfinished.
   */
  test("a donor re-opened after a rebalance: the move and the give-back command are named, and it is not a donor again", async () => {
    const ws = workspace();
    starve(ws, "02-how", 1);
    expect((await auto(ws, { rebalanceFinished: true })).code).toBe(0);
    const moved = events(ws).find((event) => event.type === "budget.raised");
    const giveBack = `tldrx budget raise 01-what 1.00 --run ${ws.runId} --take-from 02-how`;

    const store = RunStore.open(ws.runDir);
    const revoked = revoke(store, { root: ws.root, actor: "alan", at: "2026-09-14T21:00:00Z", note: "redo" }, "01-what/alpha");
    const said = revoked.givenAway.join("\n");
    expect(said).toContain(`01-what gave $1.00 to 02-how`);
    expect(said).toContain(String(moved?.ts));
    expect(said).toContain(giveBack);

    const reopened = RunStore.open(ws.runDir);
    expect(renderBudget(buildBudgetView(reopened.run, reopened.budget, reopened.runDir))).toContain(giveBack);
    const plan = planRebalance(reopened.budget, reopened.run, "02-how", 1);
    expect(plan.donors.map((d) => d.phaseId)).not.toContain("01-what");
    expect(plan.excluded.find((e) => e.phaseId === "01-what")?.reason).toContain("not finished");

    // The re-opened donor is now short itself: its refusal names the move it made.
    starve(ws, "01-what", 0.5);
    const refused = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan", at: "2026-09-14T21:00:01Z",
    });
    expect(refused.code).toBe(2);
    expect(refused.lines.join("\n")).toContain(giveBack);
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

describe("never twice over the same refusal", () => {
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

  /**
   * gh #297. Every `EXIT_AGENT_FAILED` report ends with the SAME advice line — a string
   * literal with no interpolation (`runNext.ts` `failStage`) — so a guard that compares
   * the attempt's last line compares a constant to itself and stops the loop on the
   * second stage death whatever killed it. Here the two deaths are different refusals
   * (`## Scope` missing, then `## Intent`), so both relaunches must happen and the third
   * attempt finishes the run.
   */
  test("two stage deaths with DIFFERENT reasons are two relaunches — the advice line they share is not the comparison", async () => {
    const ws = workspace();
    const without = (heading: string): string => cannedIntent().split(`## ${heading}`).join(`## not-${heading}`);
    const outputs = (intent: string): string => JSON.stringify({
      "01-what/intent.md": intent,
      "01-what/handoff.md": cannedHandoff(),
      "02-how/handoff.md": cannedHandoff(),
    });
    process.env.FAKE_CLAUDE_OUTPUTS = outputs(without("Scope"));
    let seen = 0;
    const outcome = await auto(ws, {
      untilDone: 3,
      onLine: (line) => {
        if (!line.startsWith("relaunching")) return;
        seen += 1;
        process.env.FAKE_CLAUDE_OUTPUTS = seen === 1 ? outputs(without("Intent")) : outputs(cannedIntent());
      },
    });
    expect(outcome.code).toBe(0);
    const relaunches = relaunched(ws);
    expect(relaunches).toHaveLength(2);
    expect(relaunches.map((event) => event.payload.exit)).toEqual([5, 5]);
    // The refusals themselves, not the advice both of them end with: the first death is
    // about `## Scope` and the second about `## Intent`, and the relaunch record says so.
    expect(String(relaunches[0]?.payload.reason)).toContain("## Scope");
    expect(String(relaunches[1]?.payload.reason)).toContain("## Intent");
  });

  /**
   * The other direction of the same guard, and the one it was built for: two stage deaths
   * with the SAME refusal are one relaunch — the proof that it repeats — and then a stop.
   */
  test("two stage deaths with the SAME reason is one relaunch, then the stop names the repeat", async () => {
    const ws = workspace();
    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
      "01-what/intent.md": cannedIntent().split("## Scope").join("## not-Scope"),
      "01-what/handoff.md": cannedHandoff(),
      "02-how/handoff.md": cannedHandoff(),
    });
    const outcome = await auto(ws, { untilDone: 3 });
    expect(outcome.code).toBe(5);
    expect(relaunched(ws)).toHaveLength(1);
    expect(outcome.lines[outcome.lines.length - 1]).toContain("same as the previous attempt");
  });
});

/**
 * A Watch stage whose refusal comes out of the EXECUTOR door (gh #297, round two).
 *
 * `runNext` returns every `refused: true` outcome through one pass-through, and Watch's
 * branch-incoherence refusal is the one producer behind it that carries no `error` and
 * whose LAST LINE is a literal — `  \`tldrx doctor\` reports every repo whose recorded
 * default_branch does not resolve.` — identical for two different repos or two different
 * recorded values. Everything below `01-what` here is the smallest shape that reaches it:
 * one done story, its epic, a real git repo carrying the recorded epic branch, and a
 * `default_branch` in `.tldrx/workspace.yml` that the repo has never had.
 */
const EPIC_BRANCH = "epic/260901-leaderboard-v2";

function git(dir: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function watchWorkspace(): Made {
  const made = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{
      id: "watch",
      phase: WATCH_PHASE,
      budgetUsd: 2,
      gate: "auto",
      outputs: [{ path: "handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
    }],
  });
  open.push(made);
  const plan: Record<string, string> = {
    "03-plan/stories/S1.md": [
      "---", "version: 1", "id: S1", "epic: E1", 'title: "S1 on E1"', "repo: api", "status: done",
      "depends_on: []", 'touches: ["src/"]', 'acceptance: ["it works"]', 'test_plan: ["a unit test"]',
      'evidence: ["npm run test exited 0"]', "---", "", "# S1", "", "## Definition of done", "",
      "```dod", "true", "```", "",
    ].join("\n"),
    "03-plan/epics/E1.md": [
      "---", "version: 1", "id: E1", 'title: "E1 — a shipped thing"', "repos: [api]",
      "stories: [S1]", `branch: ${EPIC_BRANCH}`, "status: done", "---", "", "# E1", "",
    ].join("\n"),
  };
  for (const [rel, content] of Object.entries(plan)) {
    const path = join(made.runDir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  const store = RunStore.open(made.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: [EPIC_BRANCH], branch_model: "integration" } }));
  store.save();
  // A real repo carrying the epic branch: the ONLY thing incoherent is the recorded
  // `default_branch`, so the refusal is the base-missing one and nothing else.
  const dir = join(made.root, "api");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "Fixture"]);
  writeFileSync(join(dir, "README.md"), "# api\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["branch", EPIC_BRANCH]);
  process.env.PATH = made.binDir;
  const argvLog = join(made.root, "spawns.jsonl");
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  return { ...made, argvLog, outbox: join(made.root, "notified.jsonl") };
}

/** Rewrite `api`'s recorded `default_branch` — #92's whole setup. */
function recordDefaultBranch(root: string, branch: string): void {
  const path = join(root, ".tldrx", "workspace.yml");
  const text = readFileSync(path, "utf8");
  let inRepo = false;
  const out = text.split("\n").map((line) => {
    if (line.trim().startsWith("- name:")) inRepo = line.trim() === "- name: api";
    return inRepo && line.trim().startsWith("default_branch:")
      ? line.replace(/default_branch:.*/, `default_branch: ${branch}`)
      : line;
  });
  writeFileSync(path, out.join("\n"), "utf8");
}

describe("an executor refusal is compared by what refused, not by the literal under it", () => {
  test("two DIFFERENT incoherence refusals sharing a last line are two relaunches", async () => {
    const ws = watchWorkspace();
    recordDefaultBranch(ws.root, "trunk-one");
    const outcome = await auto(ws, {
      untilDone: 2,
      onLine: (line) => {
        // A different recorded value on the relaunch: a different refusal, naming a
        // different branch — and printing the same `tldrx doctor` line at the end.
        if (line.startsWith("relaunching")) recordDefaultBranch(ws.root, "trunk-two");
      },
    });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(0);
    const relaunches = relaunched(ws);
    expect(relaunches).toHaveLength(2);
    expect(String(relaunches[0]?.payload.reason)).toContain("trunk-one");
    expect(String(relaunches[1]?.payload.reason)).toContain("trunk-two");
    // The instrument: both attempts really did end on the same printed line, which is
    // what made the old comparison blind here.
    expect(String(relaunches[0]?.payload.last_line)).toBe(String(relaunches[1]?.payload.last_line));
  });

  test("the SAME incoherence refusal twice is one relaunch, then the stop names the repeat", async () => {
    const ws = watchWorkspace();
    recordDefaultBranch(ws.root, "trunk-one");
    const outcome = await auto(ws, { untilDone: 2 });
    expect(outcome.code).toBe(2);
    expect(relaunched(ws)).toHaveLength(1);
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
