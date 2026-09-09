/**
 * The owner-declared notify hook — `notify:` in `.tldrx/workspace.yml` (§2.18).
 *
 * The measurement behind it, 2026-09-07: every run that week was driven in HOST mode,
 * because a host session can reach the owner's phone and `tldrx run auto` cannot. The
 * loop's answer to a question or a gate is exit 4 and a decision card on stdout, and
 * stdout is in a terminal nobody is looking at. So the framework loses the three things
 * only the unattended runner has — a metered budget, an enforced model, parallel stories
 * — to a notification problem.
 *
 * The fix names no chat tool (`drive/mandate.ts` explains at length why it must not).
 * The workspace declares ONE command; the loop hands it one JSON object on stdin at the
 * moments a person is needed; its exit code is recorded and changes nothing.
 *
 * What these tests hold:
 *
 *   TOLERANT READ     a `workspace.yml` with no `notify:` loads exactly as before, and a
 *                     loop over such a workspace spawns nothing.
 *   FIRES FIRST       the hook is invoked BEFORE the loop returns, and the loop still
 *                     returns exit 4 — no existing behaviour moves.
 *   NEVER A REFUSAL   a notifier that exits non-zero is a `notify.failed` event with the
 *                     reason in it, and the run's outcome is byte-identical.
 *
 * Hermetic: every workspace is its own `mkdtemp` directory, the notifier is a script
 * inside it, and the only process spawned is that script and the fake `claude`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { validateWorkspace } from "../src/core/schemas/workspace.ts";
import { NOTIFY_KINDS, NOTIFY_PAYLOAD_VERSION } from "../src/core/notify/payload.ts";
import { readNotifyDeclaration } from "../src/core/notify/declaration.ts";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { approve, reject } from "../src/core/run/gates.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { WORKSPACE_YML } from "./fixtures/tempRunWorkspace.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

setDefaultTimeout(spawnTestTimeout(60_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST"] as const;
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
  checks: "[claim-sources]",
};
const BETA: StageOptions = {
  id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve",
  outputs: [{ path: "02-how/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
  checks: "[claim-sources]",
};

const QUESTIONS = [
  "# Questions — 01-what — run demo",
  "",
  "## Q1 · Should hunts a player abandoned count toward the leaderboard?",
  "<!-- id: Q1 | status: open | area: product | asked_by: product | asked_at: 2026-08-30T09:40:00Z -->",
  "Why asked: no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) count them — simplest, but rewards quitting early",
  "- B) drop them — matches how players talk about their score",
  "- C) other — write it below",
  "",
  "[Answer]:",
  "",
].join("\n");

const ANSWERED = QUESTIONS
  .replace("status: open", "status: answered")
  .replace("[Answer]:", "[Answer]: B\n<!-- answered_by: alan | answered_at: 2026-08-30T10:00:00Z -->");

/**
 * A notifier that appends its whole stdin to `<root>/notified.jsonl`, one JSON per line,
 * and exits with `exitCode`.
 *
 * A real script on disk, executed as argv — not a shell string the framework assembled.
 * The declaration below names its absolute path, which is what an owner's own
 * `slack-say` wrapper would be.
 */
function writeNotifier(root: string, exitCode = 0): string {
  // Node, reached by absolute path, exactly the way the fixture's fake `claude` is: these
  // tests put ONLY the fake bin directory on PATH, so a notifier written as a shell script
  // calling `cat` would depend on whether the host's `sh` happens to find one. It measured
  // differently in two tests of this very file, which is the instrument being wrong about
  // the thing under test.
  const impl = join(root, "notifier.js");
  writeFileSync(
    impl,
    [
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  require('node:fs').appendFileSync(process.argv[2], Buffer.concat(chunks).toString('utf8') + '\\n');",
      `  process.exit(${String(exitCode)});`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const path = join(root, "notifier.sh");
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(impl)} "$@"\n`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

/** `.tldrx/workspace.yml` with a `notify:` block appended to the shared fixture. */
function workspaceYamlWithNotify(command: string, events?: readonly string[]): string {
  const list = events === undefined ? "" : `\n  events: [${events.join(", ")}]`;
  return `${WORKSPACE_YML}notify:\n  command: "${command}"${list}\n`;
}

interface Made extends FacilitatorWorkspace {
  readonly outbox: string;
}

function workspace(options: {
  gates: Readonly<Record<string, string>>;
  notifier?: { exitCode?: number; events?: readonly string[] } | null;
}): Made {
  const outbox = "notified.jsonl";
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates: options.gates,
  });
  open.push(made);
  // Omitted ⇒ DECLARED with defaults; only an explicit `null` means "no notify block",
  // which is the shape every workspace written before this feature has.
  if (options.notifier !== null) {
    const declared = options.notifier ?? {};
    const script = writeNotifier(made.root, declared.exitCode ?? 0);
    writeFileSync(
      join(made.root, ".tldrx", "workspace.yml"),
      workspaceYamlWithNotify(`${script} ${join(made.root, outbox)}`, declared.events),
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
  return { ...made, outbox: join(made.root, outbox) };
}

function auto(ws: Made, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides });
}

function delivered(ws: Made): readonly Record<string, unknown>[] {
  if (!existsSync(ws.outbox)) return [];
  return readFileSync(ws.outbox, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(ws: Made): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

/** Park the cursor stage on the questions it asked, the way a real run does. */
function parkOnQuestions(ws: Made, questions = QUESTIONS): void {
  mkdirSync(join(ws.runDir, "01-what"), { recursive: true });
  writeFileSync(join(ws.runDir, "01-what", "questions.md"), questions, "utf8");
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase, i) => (i !== 0 ? phase : {
      ...phase,
      stages: phase.stages.map((stage) => ({ ...stage, status: "awaiting_answer" as const })),
    })),
  }));
  store.save();
}

// ---------------------------------------------------------------------------
// (a) The declaration — additive, and absent by default
// ---------------------------------------------------------------------------

/** The smallest `workspace.yml` `validateWorkspace` accepts — the baseline every case adds to. */
const MINIMAL = "version: 1\nmode: multi\nroot: .\nrepos: []\n";

describe("`notify:` is an additive `version: 1` key", () => {
  test("a workspace.yml with no notify block is valid and declares nothing", () => {
    const parsed = parseYaml(MINIMAL);
    expect(validateWorkspace(parsed).issues).toEqual([]);
    expect((parsed as Record<string, unknown>).notify).toBeUndefined();
  });

  test("a workspace.yml WITH the block is valid, and reads back command and events", () => {
    const text = `${MINIMAL}notify:\n  command: "/opt/bin/notify --to owner"\n`
      + "  events: [question.raised, gate.requested]\n";
    const validation = validateWorkspace(parseYaml(text));
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  test("an unknown event kind is refused by name, not silently kept", () => {
    const text = `${MINIMAL}notify:\n  command: "/opt/bin/notify"\n`
      + "  events: [question.raised, carrier.pigeon]\n";
    const validation = validateWorkspace(parseYaml(text));
    expect(validation.ok).toBe(false);
    expect(JSON.stringify(validation.issues)).toContain("carrier.pigeon");
  });

  test("a block with no command is refused", () => {
    expect(validateWorkspace(parseYaml(`${MINIMAL}notify:\n  events: [status]\n`)).ok).toBe(false);
  });

  test("`events:` omitted means every kind — an owner who declares a command gets told everything", () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    const declaration = readNotifyDeclaration(ws.root);
    expect(declaration).not.toBeNull();
    expect([...(declaration?.events ?? [])].sort()).toEqual([...NOTIFY_KINDS].sort());
  });

  test("no block ⇒ no declaration at all, which is what every existing workspace has", () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, notifier: null });
    expect(readNotifyDeclaration(ws.root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) `question.raised` — the payload, and the unchanged exit code
// ---------------------------------------------------------------------------

describe("run auto fires the hook at an open question and still exits 4", () => {
  test("one invocation, kind question.raised, carrying the id and the literal answer command", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    parkOnQuestions(ws);

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);

    const sent = delivered(ws).filter((p) => p.kind === "question.raised");
    expect(sent.length).toBe(1);
    const payload = sent[0] ?? {};
    expect(payload.version).toBe(NOTIFY_PAYLOAD_VERSION);
    expect(payload.run).toBe(ws.runId);
    expect(payload.stage).toBe("01-what/alpha");
    expect(typeof payload.summary).toBe("string");
    expect(String(payload.summary)).toContain("Q1");
    expect(payload.command).toBe(`tldrx answer Q1 "…" --run ${ws.runId}`);
    const detail = payload.detail as { questions?: readonly Record<string, unknown>[] };
    const first = detail.questions?.[0] ?? {};
    expect(first.id).toBe("Q1");
    expect(first.answer_command).toBe(`tldrx answer Q1 "…" --run ${ws.runId}`);
    expect(first.options).toEqual([
      { letter: "A", text: "count them — simplest, but rewards quitting early" },
      { letter: "B", text: "drop them — matches how players talk about their score" },
      { letter: "C", text: "other — write it below" },
    ]);
  });

  test("the stop block is byte-identical to the one an undeclared workspace gets", async () => {
    const declared = workspace({ gates: { alpha: "auto", beta: "auto" } });
    parkOnQuestions(declared);
    const withHook = await auto(declared);

    const bare = workspace({ gates: { alpha: "auto", beta: "auto" }, notifier: null });
    parkOnQuestions(bare);
    const without = await auto(bare);

    expect(withHook.code).toBe(without.code);
    expect(withHook.lines).toEqual(without.lines);
    expect(delivered(bare)).toEqual([]);
  });

  test("a successful invocation is one `notify.sent` event carrying the kind and the exit code", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    parkOnQuestions(ws);
    await auto(ws);

    const sent = events(ws).filter((e) => e.type === "notify.sent");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const raised = sent.find((e) => e.payload.kind === "question.raised");
    expect(raised).toBeDefined();
    expect(raised?.payload.exit_code).toBe(0);
    expect(raised?.cost_usd).toBe(0);
    expect(events(ws).some((e) => e.type === "notify.failed")).toBe(false);
  });

  test("a kind the owner did not subscribe to is not delivered", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, notifier: { events: ["gate.requested"] } });
    parkOnQuestions(ws);
    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(delivered(ws)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) A failing notifier is a recorded absence, never a refusal
// ---------------------------------------------------------------------------

describe("a notifier that fails never changes the run", () => {
  test("non-zero exit ⇒ `notify.failed` with the reason, and the same exit 4", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, notifier: { exitCode: 3 } });
    parkOnQuestions(ws);

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);

    // Every notification this run makes goes through the same broken notifier, so the
    // count is scoped to the one this test is about rather than to the whole log.
    const failed = events(ws).filter((e) => e.type === "notify.failed");
    const raised = failed.filter((e) => e.payload.kind === "question.raised");
    expect(raised.length).toBe(1);
    expect(String(raised[0]?.payload.reason)).toContain("exit 3");
    expect(events(ws).some((e) => e.type === "notify.sent")).toBe(false);
  });

  test("a command that cannot be started is named, not swallowed", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    writeFileSync(
      join(ws.root, ".tldrx", "workspace.yml"),
      workspaceYamlWithNotify(join(ws.root, "no-such-notifier")),
      "utf8",
    );
    parkOnQuestions(ws);

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    const failed = events(ws).filter((e) => e.type === "notify.failed");
    const raised = failed.filter((e) => e.payload.kind === "question.raised");
    expect(raised.length).toBe(1);
    expect(String(raised[0]?.payload.reason)).toContain("could not be started");
  });

  test("a command needing a shell is refused before anything is spawned", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    writeFileSync(
      join(ws.root, ".tldrx", "workspace.yml"),
      workspaceYamlWithNotify("notify.sh | tee out.log"),
      "utf8",
    );
    parkOnQuestions(ws);

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    const failed = events(ws).filter((e) => e.type === "notify.failed");
    const raised = failed.filter((e) => e.payload.kind === "question.raised");
    expect(raised.length).toBe(1);
    expect(String(raised[0]?.payload.reason)).toContain("metacharacter");
  });
});

// ---------------------------------------------------------------------------
// (d) `--notify-every` — the periodic status
// ---------------------------------------------------------------------------

describe("--notify-every", () => {
  test("a loop that runs longer than the interval delivers at least one `status`", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    const outcome = await auto(ws, { notifyEveryMs: 20 });
    expect(outcome.code).toBe(0);

    const status = delivered(ws).filter((p) => p.kind === "status");
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(String(status[0]?.summary)).toContain(ws.runId);
    expect(typeof (status[0]?.detail as { status_text?: unknown }).status_text).toBe("string");
  });

  test("without the flag no status is ever delivered", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    const outcome = await auto(ws);
    expect(outcome.code).toBe(0);
    expect(delivered(ws).some((p) => p.kind === "status")).toBe(false);
  });

  test("the run's end is delivered as `run.finished` with the exit code and its family", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    await auto(ws);
    const finished = delivered(ws).filter((p) => p.kind === "run.finished");
    expect(finished.length).toBe(1);
    const detail = finished[0]?.detail as { exit_code?: unknown; exit_family?: unknown };
    expect(detail.exit_code).toBe(0);
    expect(typeof detail.exit_family).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// (d2) The heartbeat must not contradict the interrupt
// ---------------------------------------------------------------------------

describe("a heartbeat over a parked run says the run is parked", () => {
  test("no `status` claims nothing is waiting, and one carries the answer command", async () => {
    // Reviewer-reproduced, 2026-09-07: with both flags on, `question.raised` went out and
    // then the heartbeat kept telling the same person "Nothing is waiting on you" every
    // interval — false reassurance aimed squarely at the person the feature exists to reach.
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    parkOnQuestions(ws);

    const outcome = await auto(ws, { waitAnswersMs: 400, notifyEveryMs: 40 });
    expect(outcome.code).toBe(4);

    const status = delivered(ws).filter((p) => p.kind === "status");
    expect(status.length).toBeGreaterThanOrEqual(1);
    for (const beat of status) {
      expect(String(beat.summary)).not.toContain("Nothing is waiting on you");
    }
    expect(status.some((beat) => beat.command === `tldrx answer Q1 "…" --run ${ws.runId}`)).toBe(true);
    expect(status.some((beat) => String(beat.summary).includes("Q1"))).toBe(true);
    const waiting = status.map((beat) => (beat.detail as { waiting_on?: unknown }).waiting_on);
    expect(waiting.every((w) => Array.isArray(w) && (w as unknown[]).includes("Q1"))).toBe(true);
  });

  test("a heartbeat over a run nobody is waiting on still says so", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    const outcome = await auto(ws, { notifyEveryMs: 20 });
    expect(outcome.code).toBe(0);
    const status = delivered(ws).filter((p) => p.kind === "status");
    expect(status.length).toBeGreaterThanOrEqual(1);
    for (const beat of status) {
      expect(String(beat.summary)).toContain("Nothing is waiting on you");
      expect((beat.detail as { waiting_on?: unknown }).waiting_on).toEqual([]);
    }
  });

  test("no `status` is enqueued after the run has ended", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    await auto(ws, { notifyEveryMs: 20 });
    const kinds = delivered(ws).map((p) => p.kind);
    const last = kinds.lastIndexOf("run.finished");
    expect(last).toBe(kinds.length - 1);
  });
});

// ---------------------------------------------------------------------------
// (e) `--wait-answers`
// ---------------------------------------------------------------------------

describe("--wait-answers", () => {
  test("an answer written while the loop waits resumes it rather than exiting 4", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    parkOnQuestions(ws);
    const path = join(ws.runDir, "01-what", "questions.md");
    const answer = setTimeout(() => writeFileSync(path, ANSWERED, "utf8"), 150);

    const outcome = await auto(ws, { waitAnswersMs: 8_000 });
    clearTimeout(answer);
    expect(outcome.code).toBe(0);
    expect(delivered(ws).some((p) => p.kind === "question.timeout")).toBe(false);
  });

  test("a lapsed wait exits 4 exactly as before, after one `question.timeout`", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" } });
    parkOnQuestions(ws);

    const outcome = await auto(ws, { waitAnswersMs: 120 });
    expect(outcome.code).toBe(4);
    const timeouts = delivered(ws).filter((p) => p.kind === "question.timeout");
    expect(timeouts.length).toBe(1);
    expect(timeouts[0]?.command).toBe(`tldrx answer Q1 "…" --run ${ws.runId}`);
  });
});

// ---------------------------------------------------------------------------
// (f) `--wait-gates` — the same wait, for the other half of exit 4 (gh #197)
// ---------------------------------------------------------------------------

/**
 * Park the cursor stage on its GATE, the way a stage that finished under a
 * `human` policy leaves it — without spawning, so every heartbeat a test takes
 * fires while the run is parked rather than while a stage is running.
 */
function parkOnGate(ws: Made): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase, i) => (i !== 0 ? phase : {
      ...phase,
      stages: phase.stages.map((stage) => ({ ...stage, status: "awaiting_gate" as const })),
    })),
  }));
  store.save();
}

/**
 * Sign the gate once the LOOP is demonstrably waiting on it.
 *
 * Three earlier shapes of this helper raced the thing they were testing. A bare
 * `setTimeout` signed while the stage was still running; polling `waitingFor` signed
 * before `auto` had even started (a parked fixture is parked before the loop reads it),
 * and both left the loop with nothing to wait for — measured, three runs of three.
 *
 * So the signal is the loop's OWN heartbeat: a `status` payload carrying
 * `waiting_on_gate` is written by the notifier only while the loop is parked at a gate,
 * which is the state under test. Every caller therefore passes `notifyEveryMs`.
 */
async function signWhenWaiting(ws: Made, sign: () => Promise<void> | void): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const parked = delivered(ws).some(
      (payload) => payload.kind === "status"
        && (payload.detail as { waiting_on_gate?: unknown }).waiting_on_gate !== undefined,
    );
    if (parked) {
      await sign();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every task row of the run, so "nothing was spent while it waited" can be measured. */
function taskRows(ws: Made): readonly unknown[] {
  return RunStore.open(ws.runDir).run.phases.flatMap((phase) => phase.stages.flatMap((stage) => stage.tasks));
}

describe("--wait-gates", () => {
  test("a signature that lands while the loop waits resumes it rather than exiting 4", async () => {
    const ws = workspace({ gates: { alpha: "human", beta: "auto" } });
    const signature = signWhenWaiting(ws, async () => {
      await approve(RunStore.open(ws.runDir), {
        root: ws.root, actor: "alan", at: "2026-09-08T09:00:00Z", note: "reads right",
      });
    });

    const outcome = await auto(ws, { waitGatesMs: 8_000, notifyEveryMs: 40 });
    await signature;
    expect(outcome.code).toBe(0);
    expect(outcome.lines.some((line) => line.includes("is approved, resuming"))).toBe(true);
    const requested = delivered(ws).filter((p) => p.kind === "gate.requested");
    expect(requested.length).toBe(1);
    expect(String(requested[0]?.summary)).toContain("human gate");
    expect((requested[0]?.detail as { gate_policy?: unknown }).gate_policy).toBe("human");
    expect(delivered(ws).some((p) => p.kind === "gate.timeout")).toBe(false);
    // The loop went ON to the next stage, not just past the gate.
    expect(events(ws).some((e) => e.type === "stage.started" && e.stage === "beta")).toBe(true);
  });

  test("a lapsed wait exits 4 after one `gate.timeout`, having spent nothing", async () => {
    const ws = workspace({ gates: { alpha: "human", beta: "auto" } });
    parkOnGate(ws);
    const before = taskRows(ws).length;

    const outcome = await auto(ws, { waitGatesMs: 200 });
    expect(outcome.code).toBe(4);
    const timeouts = delivered(ws).filter((p) => p.kind === "gate.timeout");
    expect(timeouts.length).toBe(1);
    expect(timeouts[0]?.command).toBe(`tldrx approve --run ${ws.runId}`);
    const detail = timeouts[0]?.detail as { waited_ms?: unknown; reject_command?: unknown };
    expect(typeof detail.waited_ms).toBe("number");
    expect(detail.reject_command).toBe(`tldrx reject --run ${ws.runId} --note "<why>"`);
    expect(taskRows(ws).length).toBe(before);
  });

  test("a rejection stops the loop with the note, and is not a timeout", async () => {
    const ws = workspace({ gates: { alpha: "human", beta: "auto" } });
    parkOnGate(ws);
    const refusal = signWhenWaiting(ws, () => {
      reject(RunStore.open(ws.runDir), {
        root: ws.root, actor: "alan", at: "2026-09-08T09:00:00Z", note: "the scope is wrong",
      });
    });

    const outcome = await auto(ws, { waitGatesMs: 8_000, notifyEveryMs: 40 });
    await refusal;
    expect(outcome.code).toBe(4);
    expect(outcome.lines.some((line) => line.includes("the scope is wrong"))).toBe(true);
    expect(delivered(ws).some((p) => p.kind === "gate.timeout")).toBe(false);
    const failed = delivered(ws).filter((p) => p.kind === "run.failed");
    expect(failed.length).toBe(1);
    expect(String(failed[0]?.summary)).toContain("the scope is wrong");
  });

  test("a heartbeat over a GATE-parked run says a signature is waiting", async () => {
    const ws = workspace({ gates: { alpha: "human", beta: "auto" } });
    parkOnGate(ws);

    const outcome = await auto(ws, { waitGatesMs: 500, notifyEveryMs: 40 });
    expect(outcome.code).toBe(4);

    const status = delivered(ws).filter((p) => p.kind === "status");
    expect(status.length).toBeGreaterThanOrEqual(1);
    for (const beat of status) {
      expect(String(beat.summary)).not.toContain("Nothing is waiting on you");
    }
    expect(status.some((beat) => beat.command === `tldrx approve --run ${ws.runId}`)).toBe(true);
    expect(status.some((beat) => String(beat.summary).includes("human gate"))).toBe(true);
    const waiting = status.map((beat) => (beat.detail as { waiting_on_gate?: unknown }).waiting_on_gate);
    expect(waiting.every((gate) => gate === "01-what/alpha")).toBe(true);
  });

  test("an `agent`-policy gate waits the same way, and a person's plain approve resumes it", async () => {
    // gh #197, scope note: there is no engine-side signing in `run auto` — an `agent`
    // policy says who MAY sign, not that the loop will. So the wait is policy-agnostic,
    // and the signature it waits for is whoever's: `tldrx approve` with no flag on an
    // agent gate is a recorded override and is valid (`tldrx approve --help`).
    const ws = workspace({ gates: { alpha: "agent", beta: "auto" } });
    const signature = signWhenWaiting(ws, async () => {
      await approve(RunStore.open(ws.runDir), {
        root: ws.root, actor: "alan", at: "2026-09-08T09:00:00Z", note: "signed by a person over the agent policy",
      });
    });

    const outcome = await auto(ws, { waitGatesMs: 8_000, notifyEveryMs: 40 });
    await signature;
    expect(outcome.code).toBe(0);
    expect(outcome.lines.some((line) => line.includes("is approved, resuming"))).toBe(true);
    // The heartbeat said WHICH tap the owner is doing.
    const status = delivered(ws).filter((p) => p.kind === "status");
    expect(status.some((beat) => String(beat.summary).includes("agent gate"))).toBe(true);
  });

  test("WITHOUT the flag a gate still exits 4 on the spot, with the lines it always had", async () => {
    const ws = workspace({ gates: { alpha: "human", beta: "auto" } });
    parkOnGate(ws);

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines).toContain("  gate pending: tldrx approve");
    expect(outcome.lines).toContain("    at 01-what/alpha");
    expect(delivered(ws).some((p) => p.kind === "gate.timeout")).toBe(false);
    // An unparked heartbeat is untouched: no gate, no new key.
    const clean = workspace({ gates: { alpha: "auto", beta: "auto" } });
    expect((await auto(clean, { notifyEveryMs: 20 })).code).toBe(0);
    for (const beat of delivered(clean).filter((p) => p.kind === "status")) {
      expect(Object.keys(beat.detail as Record<string, unknown>)).toEqual(["status_text", "waiting_on"]);
    }
  });
});
