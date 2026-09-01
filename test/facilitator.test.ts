/**
 * `tldrx next` — the facilitator (spec §5).
 *
 * Every test here runs the REAL algorithm against a real run on disk. The only
 * thing faked is the sub-agent: a `claude` script first on PATH that reads the
 * prompt from stdin, writes canned files, and prints a canned
 * `--output-format json` body. So the outputs are validated off disk, the events
 * are appended for real, and the cost rolls up through `RunStore` exactly as it
 * would with the real binary — for $0.00.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { buildClaudeArgs, allowedTools } from "../src/core/facilitator/spawnAgent.ts";
import { EFFORT_LEVELS } from "../src/core/schemas/stage.ts";
import { effortFlag } from "../src/cli/effort.ts";
import { parseArgs, UsageError } from "../src/cli/argv.ts";
import { ENVELOPE_SCHEMA } from "../src/core/facilitator/envelope.ts";
import { evaluateSkipIf, SkipIfError } from "../src/core/facilitator/skipIf.ts";
import { isAlive } from "../src/core/facilitator/Lock.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { reject } from "../src/core/run/gates.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR",
  "FAKE_CLAUDE_SESSION", "FAKE_CLAUDE_ARGV_LOG", "FAKE_CLAUDE_PROMPT_OUT",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const workspace of open) workspace.dispose();
  open = [];
});

function workspace(stages: readonly StageOptions[], extra: Partial<Parameters<typeof makeFacilitatorWorkspace>[0]> = {}): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10, ...extra });
  open.push(made);
  return made;
}

/**
 * Make the fake `claude` the ONLY one on PATH and tell it what to write.
 *
 * Only-ness matters: if PATH still held the real binary and the fake failed to
 * resolve, these tests would quietly spawn a real Claude session and bill for it.
 * The fake's shebang wrapper uses absolute paths, so an empty rest-of-PATH costs
 * nothing.
 */
function fakeClaude(ws: FacilitatorWorkspace, env: Readonly<Record<string, string>> = {}): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function next(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-28T09:00:00Z",
    ...overrides,
  });
}

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

function types(ws: FacilitatorWorkspace): readonly string[] {
  return events(ws).map((e) => e.type);
}

const TWO_STAGE: readonly StageOptions[] = [
  {
    id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
    outputs: [
      { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
      { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    ],
  },
  { id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto", outputs: [{ path: "02-how/handoff.md" }] },
];

const ALPHA_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});

describe("a stage that succeeds", () => {
  test("validates outputs from disk, records cost, appends events and advances the cursor", async () => {
    const ws = workspace(TWO_STAGE);
    const argvLog = join(ws.root, "argv.log");
    const promptOut = join(ws.root, "prompt.txt");
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS,
      FAKE_CLAUDE_COST: "0.42",
      FAKE_CLAUDE_SESSION: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      FAKE_CLAUDE_ARGV_LOG: argvLog,
      FAKE_CLAUDE_PROMPT_OUT: promptOut,
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(0);

    const store = RunStore.open(ws.runDir);
    const alpha = store.run.phases[0]?.stages[0];
    expect(alpha?.status).toBe("done");
    expect(alpha?.cost_usd).toBe(0.42);
    expect(alpha?.tasks).toHaveLength(1);
    expect(alpha?.tasks[0]?.session_id).toBe("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    expect(alpha?.tasks[0]?.error).toBeNull();

    // the cost rolled all the way up, into run.yml and budget.yml
    expect(store.run.budget.spent_usd).toBe(0.42);
    expect(store.budget.phases.find((p) => p.id === "01-what")?.spent_usd).toBe(0.42);

    // and the cursor moved on, marking the next stage ready
    expect(store.run.cursor).toMatchObject({ phase: "02-how", stage: "beta" });
    expect(store.run.phases[1]?.stages[0]?.status).toBe("ready");

    expect(types(ws)).toEqual(
      expect.arrayContaining(["stage.started", "agent.spawned", "agent.result", "stage.done"]),
    );
    const result = events(ws).find((e) => e.type === "agent.result");
    expect(result?.cost_usd).toBe(0.42);
    expect(result?.payload).toMatchObject({ phase: "01-what", task: "t1" });
  });

  test("spawns claude with only flags that exist in `claude --help`", async () => {
    const ws = workspace(TWO_STAGE);
    const argvLog = join(ws.root, "argv.log");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_ARGV_LOG: argvLog });

    await next(ws);
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim()) as string[];
    // wave K: the format is `stream-json`, and `--verbose` is not optional with it
    // (measured — `claude -p --output-format stream-json` refuses without it).
    expect(argv.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(argv).toContain("--model");
    expect(argv).toContain("--max-budget-usd");
    expect(argv).toContain("--json-schema");
    expect(argv).toContain("--allowedTools");
    // No --yolo was asked for, so permissions are NOT skipped.
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1] ?? "{}")).toEqual(ENVELOPE_SCHEMA);
  });

  test("substitutes every placeholder by code and inlines only the declared inputs", async () => {
    const ws = workspace([
      {
        ...(TWO_STAGE[0] as StageOptions),
        optional: [".tldrx/memory/facts.yml"],
      },
      TWO_STAGE[1] as StageOptions,
    ]);
    const promptOut = join(ws.root, "prompt.txt");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_PROMPT_OUT: promptOut });

    await next(ws);
    const prompt = readFileSync(promptOut, "utf8");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain(ws.runId);
    expect(prompt).toContain("api, lab");
    expect(prompt).toContain("$6.00");
    expect(prompt).toContain("Done means proven.");            // {{conventions}}
    expect(prompt).toContain("# Product expert");              // the expert.md body
    expect(prompt).toContain("### `.tldrx/memory/facts.yml`"); // the input, inlined
  });
});

describe("stopping for a human", () => {
  test("a gate stage ends awaiting_gate with gate.requested and exit 4", async () => {
    const ws = workspace([{ ...(TWO_STAGE[0] as StageOptions), gate: "approve" }]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("gate pending: tldrx approve");

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.status).toBe("awaiting_gate");
    expect(store.run.phases[0]?.stages[0]?.gate.status).toBe("pending");
    expect(types(ws)).toContain("gate.requested");
    // the cursor did NOT move: approve owns that
    expect(store.run.cursor.stage).toBe("alpha");
  });

  test("awaiting_answer exits 4 while a question is open, then flips to ready once it is not", async () => {
    const ws = workspace(TWO_STAGE);
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), questionsMd("open"), "utf8");
    stall(ws, "awaiting_answer");

    const blocked = await next(ws);
    expect(blocked.code).toBe(4);
    expect(blocked.lines.join("\n")).toContain("1 open question(s) in 01-what/questions.md (Q1)");

    // answer it, and the same command walks straight through
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), questionsMd("answered"), "utf8");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });
    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("every question is answered");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("done");
  });
});

describe("refusing to start", () => {
  test("a phase with less left than the stage costs blocks with exit 2 and budget.blocked", async () => {
    const ws = workspace(TWO_STAGE);
    starve(ws, "01-what", 1);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("refusing to start stage \"alpha\"");

    const blocked = events(ws).find((e) => e.type === "budget.blocked");
    expect(blocked?.payload).toMatchObject({ phase: "01-what", estimate_usd: 6 });
    // nothing was spawned, so nothing was spent
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0);
    expect(types(ws)).not.toContain("agent.spawned");
  });

  test("a missing REQUIRED input is exit 1, before any spend", async () => {
    const ws = workspace([{ ...(TWO_STAGE[0] as StageOptions), required: ["01-what/nowhere.md"] }]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("01-what/nowhere.md");
    expect(types(ws)).not.toContain("agent.spawned");
  });
});

describe("failure", () => {
  test("is_error from the agent fails the stage with exit 5 and keeps the cost", async () => {
    const ws = workspace(TWO_STAGE);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });

    const outcome = await next(ws);
    expect(outcome.code).toBe(5);

    const store = RunStore.open(ws.runDir);
    const alpha = store.run.phases[0]?.stages[0];
    expect(alpha?.status).toBe("failed");
    expect(alpha?.tasks[0]?.error).toContain("fake failure");
    // spec §5: "stage.failed never advances the cursor and never rolls back cost"
    expect(store.run.cursor.stage).toBe("alpha");
    expect(store.run.budget.spent_usd).toBe(0.42);
    expect(types(ws)).toContain("stage.failed");
  });

  test("an output missing a declared section fails the stage, however cheerful the agent was", async () => {
    const ws = workspace(TWO_STAGE);
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({
        "01-what/intent.md": "# Intent\n\n## Intent\nShip it.\n",   // no `## Scope`
        "01-what/handoff.md": cannedHandoff(),
      }),
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(5);
    expect(outcome.lines.join("\n")).toContain("`## Scope`");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("failed");
  });

  test("a declared `cmd` check that exits non-zero fails the stage", async () => {
    const ws = workspace([
      {
        ...(TWO_STAGE[0] as StageOptions),
        checks: `[{id: cmd, on: post-write, repo: api, command: "false", expect_exit: 0}]`,
      },
    ]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(5);
    expect(types(ws)).toContain("check.failed");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("failed");
  });

  test("a declared `cmd` check that passes lets the stage finish", async () => {
    const ws = workspace([
      {
        ...(TWO_STAGE[0] as StageOptions),
        checks: `[{id: cmd, on: post-write, repo: api, command: "true", expect_exit: 0}]`,
      },
    ]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(types(ws)).toContain("check.passed");
  });
});

/**
 * `--dry-run` (issue #17).
 *
 * It used to RUN the stage — one real `claude -p`, one `agent.spawned`, one
 * `agent.result`, the cost on the ledger (measured $0.42 on the 2026-08-30
 * pilot) — and then revert the non-handoff files. A flag named "dry run" that
 * calls a paid model is a cost bug however it is documented, and `tldrx --help`
 * had already been written the other way round ("Spawns nothing and writes
 * nothing").
 *
 * So it spawns nothing now. It assembles the prompt, prices it, and prints what
 * WOULD be dispatched: the bundle, the prompt size, and the exact command. The
 * proof that it does not spawn is `FAKE_CLAUDE_ARGV_LOG` — the fake `claude`
 * appends one line per invocation, so the file's ABSENCE is the assertion.
 */
describe("--dry-run", () => {
  test("spawns nothing: the fake `claude` is never invoked, and no cost is recorded", async () => {
    const ws = workspace(TWO_STAGE);
    const argvLog = join(ws.root, "argv.log");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_ARGV_LOG: argvLog });

    const outcome = await next(ws, { dryRun: true });
    expect(outcome.code).toBe(0);
    // The whole issue, in one line: nothing ran the binary.
    expect(existsSync(argvLog)).toBe(false);
    expect(types(ws)).not.toContain("agent.spawned");
    expect(types(ws)).not.toContain("agent.result");

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.cost_usd).toBe(0);
    expect(store.budget.phases[0]?.spent_usd).toBe(0);
  });

  test("writes nothing and leaves the stage exactly where it was", async () => {
    const ws = workspace(TWO_STAGE);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });
    const before = RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status;

    const outcome = await next(ws, { dryRun: true });
    expect(outcome.code).toBe(0);
    // No stage output, and no prompt bundle either: a dry run leaves no bundle
    // for a later `--commit` to mistake for a prepared turn.
    expect(existsSync(join(ws.runDir, "01-what", "handoff.md"))).toBe(false);
    expect(existsSync(join(ws.runDir, "01-what", "intent.md"))).toBe(false);
    expect(existsSync(join(ws.runDir, ".agent", "alpha", "prompt.md"))).toBe(false);
    expect(existsSync(join(ws.runDir, ".agent", "alpha", "pending.json"))).toBe(false);

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.status).toBe(before);
    expect(types(ws)).not.toContain("stage.started");
    expect(types(ws)).not.toContain("stage.skipped");
  });

  test("shows what WOULD be dispatched: the bundle, the prompt size and the command", async () => {
    const ws = workspace(TWO_STAGE);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws, { dryRun: true });
    const said = outcome.lines.join("\n");
    expect(said).toContain("dry run: nothing was spawned and nothing was written");
    expect(said).toContain("would dispatch 01-what/alpha");
    // The context ledger — which is where the prompt size lives — is printed on a
    // dry run exactly as it is on a `--prepare`.
    expect(said).toMatch(/context \d+ B of /);
    expect(said).toMatch(/prompt: \d+ B/);
    // The command, verbatim enough to recognise — with the schema blob elided.
    expect(said).toContain("claude -p --output-format stream-json --verbose");
    expect(said).toContain("--max-budget-usd");
    expect(said).toContain("<envelope-schema>");
    // The outputs the sub-agent would have been allowed to write.
    expect(said).toContain("01-what/handoff.md");
    // And the way to actually do it.
    expect(said).toContain("--prepare");
  });

  test("is refused when the stage sets dry_run_allowed: false", async () => {
    const ws = workspace([{ ...(TWO_STAGE[0] as StageOptions), dryRunAllowed: false }]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws, { dryRun: true });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("dry_run_allowed: false");
  });
});

/**
 * The `{{facts}}` section of a prepared prompt — the widest-reaching reader of
 * `facts.yml` there is, since every stage of every run gets one.
 *
 * A superseded fact is what the workspace USED to believe. Putting it on the page
 * hands a sub-agent a decision its owner has already reversed, and the sub-agent
 * has no way to tell which of the two rows is current. Until 2026-08-31 the
 * filter here was retirement only.
 */
describe("{{facts}} in a prepared prompt", () => {
  const REVERSED = `version: 1
facts:
  - id: F001
    fact: "Leaderboard state lives in a new Postgres table."
    area: data-model
    repos: [api]
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-30T09:00:00Z", run: 260830-x, q: Q1}
    supersedes: null
    superseded_by: F002
    retired: null
  - id: F002
    fact: "Leaderboard state lives in a Redis sorted set."
    area: data-model
    repos: [api]
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-31T09:00:00Z", run: 260830-x, q: Q1}
    supersedes: F001
    superseded_by: null
    retired: null
`;

  test("renders the superseding fact and NOT the one it replaced", async () => {
    const ws = workspace(TWO_STAGE, { facts: REVERSED });
    const prepared = await next(ws, { mode: "prepare" });
    expect(prepared.code).toBe(0);

    const prompt = readFileSync(join(ws.runDir, ".agent", "alpha", "prompt.md"), "utf8");
    expect(prompt).toContain("[F002] Leaderboard state lives in a Redis sorted set.");
    expect(prompt).not.toContain("F001");
    expect(prompt).not.toContain("new Postgres table");
  });
});

describe("in-session mode", () => {
  test("--prepare writes the bundle and stops; --commit picks it up from a hand-written result.json", async () => {
    const ws = workspace(TWO_STAGE);
    // No fake claude on PATH at all: in-session mode must never spawn one.
    const prepared = await next(ws, { mode: "prepare" });
    expect(prepared.code).toBe(0);
    // One line per loaded expert, then the three instruction lines. The count is
    // not asserted: what matters is that the instructions are all there and that
    // the experts are named, not that the block is exactly N lines long.
    expect(prepared.lines.join("\n")).toContain("expert product (stage)");
    expect(prepared.lines.at(-1)).toContain("tldrx next --commit");
    expect(prepared.lines.at(-2)).toContain("dispatch ONE sub-agent");
    expect(prepared.lines.at(-3)).toContain("prepared 01-what/alpha");

    const agent = join(ws.runDir, ".agent", "alpha");
    expect(existsSync(join(agent, "prompt.md"))).toBe(true);
    const pending = JSON.parse(readFileSync(join(agent, "pending.json"), "utf8")) as {
      stage: string; outputs: string[]; max_budget_usd: number; sections: Record<string, string[]>;
    };
    expect(pending.stage).toBe("alpha");
    expect(pending.outputs).toEqual(["01-what/intent.md", "01-what/handoff.md"]);
    expect(pending.max_budget_usd).toBe(6);
    expect(pending.sections["01-what/intent.md"]).toEqual(["Intent", "Scope"]);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("running");

    // the host session does the work…
    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(
      join(agent, "result.json"),
      JSON.stringify({
        outputs: ["01-what/intent.md", "01-what/handoff.md"],
        questions_asked: [],
        notes: "written by the Claude Code session",
        cost_usd: 0.19,
        session_id: "c9f1a2b0-1f2e-4c3d-9a10-6b7c8d9e0f11",
      }),
      "utf8",
    );

    const committed = await next(ws, { mode: "commit" });
    expect(committed.code).toBe(0);

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.status).toBe("done");
    expect(store.run.budget.spent_usd).toBe(0.19);
    expect(store.run.phases[0]?.stages[0]?.tasks[0]?.session_id).toBe("c9f1a2b0-1f2e-4c3d-9a10-6b7c8d9e0f11");
    expect(store.run.cursor.stage).toBe("beta");
  });

  test("--commit without a result.json is a usage error, not a silent pass", async () => {
    const ws = workspace(TWO_STAGE);
    await next(ws, { mode: "prepare" });
    const outcome = await next(ws, { mode: "commit" });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("result.json");
  });
});

describe("the lock", () => {
  test("a live pid refuses the run with exit 2", async () => {
    const ws = workspace(TWO_STAGE);
    writeFileSync(join(ws.runDir, ".lock"), JSON.stringify({ pid: process.pid + 0, at: "2026-08-28T09:00:00Z" }), "utf8");
    // our own pid is skipped by design, so borrow the parent's: it is alive too
    writeFileSync(join(ws.runDir, ".lock"), JSON.stringify({ pid: process.ppid, at: "2026-08-28T09:00:00Z" }), "utf8");
    expect(isAlive(process.ppid)).toBe(true);

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("another next is running");
  });

  test("a dead pid demotes the running stage back to ready and carries on", async () => {
    const ws = workspace(TWO_STAGE);
    const deadPid = 4194303;
    expect(isAlive(deadPid)).toBe(false);
    stall(ws, "running");
    writeFileSync(join(ws.runDir, ".lock"), JSON.stringify({ pid: deadPid, at: "2026-08-28T09:00:00Z" }), "utf8");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("demoted 01-what/alpha from running to ready");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("done");
    expect(existsSync(join(ws.runDir, ".lock"))).toBe(false);
  });
});

describe("skip_if", () => {
  test("a stage whose condition holds is skipped and the cursor moves past it", async () => {
    const ws = workspace([
      { ...(TWO_STAGE[0] as StageOptions), skipIf: "repos<=9" },
      TWO_STAGE[1] as StageOptions,
    ]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: JSON.stringify({ "02-how/handoff.md": cannedHandoff() }) });

    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("skipped 01-what/alpha (skip_if: repos<=9)");

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.status).toBe("skipped");
    expect(store.run.phases[1]?.stages[0]?.status).toBe("done");
    expect(types(ws)).toContain("stage.skipped");
  });

  test("the grammar is closed", () => {
    const counts = { stories: 3, repos: 2, questions: 0 };
    expect(evaluateSkipIf("stories<=1", counts)).toBe(false);
    expect(evaluateSkipIf("stories>=3", counts)).toBe(true);
    expect(evaluateSkipIf("questions==0", counts)).toBe(true);
    expect(() => evaluateSkipIf("stories<=one", counts)).toThrow(SkipIfError);
    expect(() => evaluateSkipIf("budget>1", counts)).toThrow(SkipIfError);
  });
});

describe("argv construction", () => {
  const ARGV_BASE = {
    prompt: "…", model: "sonnet", maxBudgetUsd: 3, workspaceCommands: ["npm run test"],
    cwd: "/tmp", timeoutMs: 1000, yolo: false,
  };

  test("--dangerously-skip-permissions appears only with --yolo", () => {
    const base = {
      prompt: "…", model: "sonnet", maxBudgetUsd: 3, workspaceCommands: ["npm run test"],
      cwd: "/tmp", timeoutMs: 1000,
    };
    expect(buildClaudeArgs({ ...base, yolo: false })).not.toContain("--dangerously-skip-permissions");
    expect(buildClaudeArgs({ ...base, yolo: true })).toContain("--dangerously-skip-permissions");
  });

  test("--effort is absent unless the request sets one", () => {
    expect(buildClaudeArgs(ARGV_BASE)).not.toContain("--effort");
    expect(buildClaudeArgs({ ...ARGV_BASE, effort: null })).not.toContain("--effort");
  });

  for (const level of EFFORT_LEVELS) {
    test(`--effort ${level} is passed as its own flag and value`, () => {
      const argv = buildClaudeArgs({ ...ARGV_BASE, effort: level });
      expect(argv[argv.indexOf("--effort") + 1]).toBe(level);
    });
  }

  test("the tool allowance is the file tools plus one Bash grant per workspace command", () => {
    expect(allowedTools(["npm run test", "dotnet build"])).toEqual([
      "Read", "Write", "Edit", "Glob", "Grep", "Bash(npm run test)", "Bash(dotnet build)",
    ]);
  });
});

describe("--effort", () => {
  /** The argv the fake `claude` was actually spawned with, for the first call. */
  function spawnedArgv(argvLog: string): readonly string[] {
    return JSON.parse((readFileSync(argvLog, "utf8").trim().split("\n")[0]) ?? "[]") as string[];
  }

  test("a stage's own `effort:` reaches the sub-agent", async () => {
    const ws = workspace([{ ...(TWO_STAGE[0] as StageOptions), effort: "low" }, TWO_STAGE[1] as StageOptions]);
    const argvLog = join(ws.root, "argv.log");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_ARGV_LOG: argvLog });

    expect((await next(ws)).code).toBe(0);
    const argv = spawnedArgv(argvLog);
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
  });

  test("a stage with no `effort:` spawns with no --effort flag at all", async () => {
    const ws = workspace(TWO_STAGE);
    const argvLog = join(ws.root, "argv.log");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_ARGV_LOG: argvLog });

    expect((await next(ws)).code).toBe(0);
    expect(spawnedArgv(argvLog)).not.toContain("--effort");
  });

  test("the CLI override wins over the stage default", async () => {
    const ws = workspace([{ ...(TWO_STAGE[0] as StageOptions), effort: "low" }, TWO_STAGE[1] as StageOptions]);
    const argvLog = join(ws.root, "argv.log");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_ARGV_LOG: argvLog });

    expect((await next(ws, { effort: "xhigh" })).code).toBe(0);
    const argv = spawnedArgv(argvLog);
    expect(argv[argv.indexOf("--effort") + 1]).toBe("xhigh");
    expect(argv).not.toContain("low");
  });

  test("the effort is recorded on agent.spawned and agent.result, so cost can be compared per level", async () => {
    const ws = workspace([{ ...(TWO_STAGE[0] as StageOptions), effort: "low" }, TWO_STAGE[1] as StageOptions]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });

    expect((await next(ws, { effort: "high" })).code).toBe(0);
    const spawned = events(ws).find((e) => e.type === "agent.spawned");
    const result = events(ws).find((e) => e.type === "agent.result");
    expect(spawned?.payload).toMatchObject({ effort: "high" });
    expect(result?.payload).toMatchObject({ effort: "high" });
    expect(result?.cost_usd).toBe(0.42);
  });

  test("the CLI refuses a level that is not one of the five, before spawning anything", () => {
    const parse = (value: string) => effortFlag(parseArgs(["--effort", value], ["effort"]));
    expect(parse("low")).toBe("low");
    expect(parse("max")).toBe("max");
    expect(() => parse("turbo")).toThrow(UsageError);
    expect(effortFlag(parseArgs([], ["effort"]))).toBeUndefined();
  });

  test("--prepare writes the effort into the bundle and says so", async () => {
    const ws = workspace([{ ...(TWO_STAGE[0] as StageOptions), effort: "low" }, TWO_STAGE[1] as StageOptions]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws, { mode: "prepare" });
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("effort low");
    const pending = JSON.parse(
      readFileSync(join(ws.runDir, ".agent", "alpha", "pending.json"), "utf8"),
    ) as { effort: string };
    expect(pending.effort).toBe("low");
  });
});

// --- helpers ---------------------------------------------------------------

/** Force the cursor stage into a status the fixture cannot reach on its own. */
function stall(ws: FacilitatorWorkspace, status: "awaiting_answer" | "running"): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase, i) => (i !== 0 ? phase : {
      ...phase,
      stages: phase.stages.map((stage, j) => (j !== 0 ? stage : { ...stage, status })),
    })),
  }));
  store.save();
}

/** Lower one phase's ceiling so the next stage cannot possibly fit. */
function starve(ws: FacilitatorWorkspace, phaseId: string, ceiling: number): void {
  const path = join(ws.runDir, "budget.yml");
  const text = readFileSync(path, "utf8");
  const pattern = new RegExp(`(\\{id: "?${phaseId}"?, ceiling_usd: )[0-9.]+`);
  const next = text.replace(pattern, `$1${ceiling.toFixed(2)}`);
  if (next === text) throw new Error(`starve() did not match a phase row for ${phaseId} in budget.yml`);
  writeFileSync(path, next, "utf8");
}

function questionsMd(state: "open" | "answered"): string {
  const status = state === "open" ? "open" : "answered";
  const answer = state === "open" ? "[Answer]:" : "[Answer]: A — Postgres";
  return [
    `# Questions — 01-what`,
    "",
    "## Q1 · Where does leaderboard state live?",
    `<!-- id: Q1 | status: ${status} | area: data-model | asked_by: product | asked_at: 2026-08-28T09:00:00Z -->`,
    "Why asked: no ranking store exists [src: absent:.tldrx/memory/facts.yml]",
    "",
    "- A) A new Postgres table",
    "- B) A Redis sorted set",
    "",
    answer,
    "",
  ].join("\n");
}

/**
 * Spec §5, failure path: "`stage.failed` never advances the cursor … the
 * operator's options are `next` (retry, re-spending), `reject --note` (send the
 * stage back to `ready` with the note fed into the next prompt)".
 *
 * Before this block the cursor was walked PAST a failed stage, so `next` ran the
 * following stage on a foundation that had failed, and `reject` refused because
 * the stage was not `awaiting_gate`.
 */
describe("after a failure", () => {
  /**
   * `cost` matters to the tests that then RETRY: this fixture's phase ceiling is
   * exactly the stage's own estimate, so a failure that spent anything leaves the
   * phase unable to afford a second attempt and the budget gate refuses it with
   * exit 2 — spec §5, and asserted on its own below. The retry tests therefore
   * fail the stage for $0.00; the "cost is kept" property is asserted separately.
   */
  async function failAlpha(ws: FacilitatorWorkspace, cost = "0.42"): Promise<void> {
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: cost });
    expect((await next(ws)).code).toBe(5);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("failed");
  }

  test("`next` retries the failed stage instead of walking the cursor past it", async () => {
    const ws = workspace(TWO_STAGE);
    await failAlpha(ws, "0.00");

    delete process.env.FAKE_CLAUDE_IS_ERROR;
    process.env.FAKE_CLAUDE_OUTPUTS = ALPHA_OUTPUTS;
    const retry = await next(ws);

    expect(retry.lines.join("\n")).toContain("retrying 01-what/alpha");
    expect(retry.code).toBe(0);
    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.status).toBe("done");
    // Two attempts at alpha, and beta was never started on a failed foundation.
    const started = events(ws).filter((e) => e.type === "stage.started");
    expect(started.filter((e) => e.stage === "alpha")).toHaveLength(2);
  });

  test("a run holding a failed stage is still the run `next` finds without an id", async () => {
    const ws = workspace(TWO_STAGE);
    await failAlpha(ws);

    const store = RunStore.open(ws.runDir);
    expect(store.run.status).toBe("failed");
    expect(RunStore.findOpen(ws.root)[0]?.runId).toBe(ws.runId);
  });

  test("`run status` shows the failure rather than counting it as progress", async () => {
    const ws = workspace(TWO_STAGE);
    await failAlpha(ws);

    const store = RunStore.open(ws.runDir);
    const view = buildStatus(store.run, store.budget, store.runDir);
    const phase = view.phases[0];
    expect(phase?.done).toBe(0);
    expect(phase?.failed).toBe(1);
    expect(phase?.bar.startsWith("✗")).toBe(true);
    expect(view.waiting.kind).toBe("failed");

    const text = renderStatus(view);
    expect(text).toContain("[✗░░░░] 0/1 stages");
    expect(text).toContain("· failed:");
    expect(text).toContain("retry: `tldrx next`");
    expect(text).toContain('or: `tldrx reject --note "…"`');
    expect(text).not.toContain("every stage is terminal");
  });

  test("`reject --note` is allowed on a failed stage and sends it back to ready", async () => {
    const ws = workspace(TWO_STAGE);
    await failAlpha(ws);

    const store = RunStore.open(ws.runDir);
    const outcome = reject(store, {
      root: ws.root, actor: "alan", at: "2026-08-28T10:00:00Z",
      note: "write handoff.md with a src token on every finding",
    });
    expect(outcome.from).toBe("failed");

    const after = RunStore.open(ws.runDir);
    const alpha = after.run.phases[0]?.stages[0];
    expect(alpha?.status).toBe("ready");
    expect(alpha?.gate.status).toBe("rejected");
    expect(alpha?.gate.note).toContain("src token");
    expect(after.run.cursor.stage).toBe("alpha");
    const rejected = events(ws).find((e) => e.type === "gate.rejected");
    expect(rejected?.payload.from).toBe("failed");
  });

  test("the reject note reaches the next prompt under `## Previous attempt`", async () => {
    const ws = workspace(TWO_STAGE);
    await failAlpha(ws, "0.00");
    reject(RunStore.open(ws.runDir), {
      root: ws.root, actor: "alan", at: "2026-08-28T10:00:00Z",
      note: "write handoff.md with a src token on every finding",
    });

    const promptOut = join(ws.root, "prompt.txt");
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    process.env.FAKE_CLAUDE_OUTPUTS = ALPHA_OUTPUTS;
    process.env.FAKE_CLAUDE_PROMPT_OUT = promptOut;
    expect((await next(ws)).code).toBe(0);

    const prompt = readFileSync(promptOut, "utf8");
    expect(prompt).toContain("## Previous attempt");
    expect(prompt).toContain("src token on every finding");
    expect(prompt).toContain("The previous attempt at this stage FAILED");
  });

  test("a retry the phase can no longer afford is refused by the budget gate, not run", async () => {
    const ws = workspace(TWO_STAGE);
    await failAlpha(ws, "0.42");

    delete process.env.FAKE_CLAUDE_IS_ERROR;
    process.env.FAKE_CLAUDE_OUTPUTS = ALPHA_OUTPUTS;
    const retry = await next(ws);

    expect(retry.code).toBe(2);
    expect(retry.lines.join("\n")).toContain("retrying 01-what/alpha");
    expect(retry.lines.join("\n")).toContain("budget");
    // The money from the failed attempt is still on the record.
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0.42);
  });

  test("a first attempt carries no `## Previous attempt` section", async () => {
    const ws = workspace(TWO_STAGE);
    const promptOut = join(ws.root, "prompt.txt");
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_PROMPT_OUT: promptOut });
    expect((await next(ws)).code).toBe(0);
    expect(readFileSync(promptOut, "utf8")).not.toContain("## Previous attempt");
  });
});

/**
 * The 2026-08-30 live failure, end to end.
 *
 * A stage whose `stage.yml` declares `stories/<id>.md` cannot name its outputs —
 * Plan does not know how many stories there will be until it has written them.
 * The first `feature`-scope run to reach Plan wrote one epic and seven stories and
 * was refused with "`03-plan/stories/<id>.md` … does not exist on disk", because
 * the shape went to `existsSync` verbatim. These run the whole facilitator, off
 * the same fake `claude`, against the same seam.
 */
const PATTERN_STAGES: readonly StageOptions[] = [
  {
    id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
    outputs: [
      { path: "01-what/epics/<epic>.md" },
      { path: "01-what/stories/<id>.md", sections: ["Acceptance"] },
      { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    ],
  },
  {
    id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto",
    required: ["01-what/stories/<id>.md"],
    outputs: [{ path: "02-how/handoff.md" }],
  },
];

function storyFile(id: string): string {
  return `# ${id}\n\n## Acceptance\n- the ${id} behaviour is proven by a test\n`;
}

const PLAN_OUTPUTS = JSON.stringify({
  "01-what/epics/E1.md": "# E1 — the epic\n",
  "01-what/stories/S1.md": storyFile("S1"),
  "01-what/stories/S2.md": storyFile("S2"),
  "01-what/stories/S3.md": storyFile("S3"),
  "01-what/handoff.md": cannedHandoff(),
});

describe("a stage whose declared outputs are patterns", () => {
  test("passes with one epic and three stories on disk", async () => {
    const ws = workspace(PATTERN_STAGES);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: PLAN_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).not.toContain("does not exist on disk");

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.status).toBe("done");
    expect(store.run.cursor).toMatchObject({ phase: "02-how", stage: "beta" });
  });

  test("fails when the pattern matched nothing, and says `no file matches it`", async () => {
    const ws = workspace(PATTERN_STAGES);
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({ "01-what/handoff.md": cannedHandoff() }),
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(5);
    const said = outcome.lines.join("\n");
    expect(said).toContain("01-what/epics/<epic>.md was declared as an output but no file matches it on disk");
    expect(said).toContain("01-what/stories/<id>.md was declared as an output but no file matches it on disk");
    expect(said).not.toContain("does not exist on disk");
  });

  test("`sections:` binds every matched file, and the failure names the file not the shape", async () => {
    const ws = workspace(PATTERN_STAGES);
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({
        "01-what/epics/E1.md": "# E1\n",
        "01-what/stories/S1.md": storyFile("S1"),
        "01-what/stories/S2.md": "# S2 — no acceptance criteria at all\n",
        "01-what/handoff.md": cannedHandoff(),
      }),
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(5);
    const said = outcome.lines.join("\n");
    expect(said).toContain("01-what/stories/S2.md is missing the required section `## Acceptance`");
    expect(said).not.toContain("01-what/stories/S1.md is missing");
    expect(said).not.toContain("<id>.md is missing");
  });

  test("the NEXT stage takes them as inputs: the gap check passes and the prompt gets the files", async () => {
    const ws = workspace(PATTERN_STAGES);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: PLAN_OUTPUTS });
    expect((await next(ws)).code).toBe(0);

    const promptOut = join(ws.root, "prompt.txt");
    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({ "02-how/handoff.md": cannedHandoff() });
    process.env.FAKE_CLAUDE_PROMPT_OUT = promptOut;
    const beta = await next(ws);
    expect(beta.code).toBe(0);

    // Not a literal-path refusal, and not an empty inline either: the sub-agent is
    // handed the three concrete stories, cited by their real names.
    const prompt = readFileSync(promptOut, "utf8");
    for (const id of ["S1", "S2", "S3"]) {
      expect(prompt).toContain(`01-what/stories/${id}.md`);
      expect(prompt).toContain(`the ${id} behaviour is proven by a test`);
    }
    expect(prompt).not.toContain("<id>.md");
  });

  test("a pattern input nothing satisfies is a usage refusal, reported AS THE PATTERN", async () => {
    const ws = workspace([
      { ...(PATTERN_STAGES[0] as StageOptions), outputs: [{ path: "01-what/handoff.md" }] },
      PATTERN_STAGES[1] as StageOptions,
    ]);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: JSON.stringify({ "01-what/handoff.md": cannedHandoff() }) });
    expect((await next(ws)).code).toBe(0);

    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({ "02-how/handoff.md": cannedHandoff() });
    const beta = await next(ws);
    expect(beta.code).toBe(1);
    expect(beta.lines.join("\n")).toContain("requires 1 input(s) that do not exist: 01-what/stories/<id>.md");
  });

  /**
   * A pattern output is a SHAPE, not a file, and on a dry run no file exists yet
   * to resolve it against. So the dispatch report names the declared pattern —
   * `01-what/stories/<id>.md` — which is exactly what the sub-agent would be told
   * it may write. Nothing is written either way (issue #17).
   */
  test("--dry-run names the declared outputs, patterns included, and writes none of them", async () => {
    const ws = workspace(PATTERN_STAGES);
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: PLAN_OUTPUTS });

    const outcome = await next(ws, { dryRun: true });
    expect(outcome.code).toBe(0);
    const said = outcome.lines.join("\n");
    expect(said).toContain("01-what/stories/<id>.md");
    expect(said).toContain("01-what/epics/<epic>.md");
    for (const id of ["S1", "S2", "S3"]) {
      expect(existsSync(join(ws.runDir, "01-what", "stories", `${id}.md`))).toBe(false);
    }
    expect(existsSync(join(ws.runDir, "01-what", "epics", "E1.md"))).toBe(false);
    expect(existsSync(join(ws.runDir, "01-what", "handoff.md"))).toBe(false);
  });
});
