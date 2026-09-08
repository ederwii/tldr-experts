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
