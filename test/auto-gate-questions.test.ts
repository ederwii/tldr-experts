/**
 * gh #203 — an auto gate held only by open questions.
 *
 * Measured on a real workspace, tldrx 0.14.0, first `run auto` with the notify hook:
 * the `what` stage finished for $1.98, its declared checks all passed, the gate policy
 * was `auto` — and the gate did not close. The owner's phone got "waiting at a auto gate
 * that did not close by itself — a person signs it", with no reason, BEFORE the four
 * question cards that were the only thing holding it. After he answered all four,
 * nothing closed the gate for him.
 *
 * Four defects, one story, and this file holds all four ends:
 *
 *   WHY TRAVELS     `gate.requested` carries the auto verdict's `why` and the ids of
 *                   the conditions that held it, and the notification renders them.
 *   ORDER           when the questions are the ONLY thing holding an auto gate, the
 *                   questions are notified first and the gate's notification is
 *                   deferred — the questions are what a person can act on, the gate is
 *                   downstream of them.
 *   SELF-CLOSE      `--wait-gates` re-runs the seven conditions each poll for an `auto`
 *                   policy and signs through the same `approve` door `next` uses. Never
 *                   for `human` or `agent`.
 *   RECOMMENDATION  a question block may carry its own `Recommended:` line, and the card
 *                   uses it when no evidence note supplies one.
 *
 * Hermetic: every workspace is its own temp directory, the notifier is a script inside
 * it, and the only processes spawned are that script and the fake `claude`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { deliveredTo, writeNotifier, workspaceYamlWithNotify } from "./fixtures/facilitator/notifier.ts";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import { parseQuestions } from "../src/core/text/questions.ts";
import { questionsCard } from "../src/core/run/decisionCards.ts";
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

/** Two open questions, in §2.7 grammar, one of them carrying a `Recommended:` line. */
const QUESTIONS = [
  "# Questions — 01-what",
  "",
  "## Q1 · Should hunts a player abandoned count toward the leaderboard?",
  "<!-- id: Q1 | status: open | area: product | asked_by: product | asked_at: 2026-08-30T09:40:00Z -->",
  "Why asked: no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) count them — simplest, but rewards quitting early",
  "- B) drop them — matches how players talk about their score",
  "",
  "Recommended: B — every player sentence in the intake drops them [src: 01-what/handoff.md:1]",
  "",
  "[Answer]:",
  "",
  "## Q2 · How long is a hunt allowed to stay open?",
  "<!-- id: Q2 | status: open | area: product | asked_by: product | asked_at: 2026-08-30T09:41:00Z -->",
  "Why asked: no expiry is recorded anywhere [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) 24 hours",
  "- B) 7 days",
  "",
  "[Answer]:",
  "",
].join("\n");

/** The same file after a person answered both, exactly as `tldrx answer` leaves it. */
const ANSWERED = QUESTIONS
  .replace(/status: open/g, "status: answered")
  .replace(
    "[Answer]:\n\n## Q2",
    "[Answer]: B\n<!-- answered_by: alan | answered_at: 2026-08-30T10:00:00Z | fact: F01 -->\n\n## Q2",
  )
  .replace(
    /\[Answer\]:\n$/,
    "[Answer]: A\n<!-- answered_by: alan | answered_at: 2026-08-30T10:00:00Z | fact: F02 -->\n",
  );

/** A handoff whose Findings cite an https doc — well formed, and unverifiable offline. */
function unverifiableHandoff(): string {
  return cannedHandoff().replace(
    "- The fixture workspace declares its repos [src: .tldrx/workspace.yml:1]",
    "- The scoring rule is published upstream [src: https://example.invalid/scoring]",
  );
}

interface Made extends FacilitatorWorkspace {
  readonly outbox: string;
}

function workspace(options: {
  gates: Readonly<Record<string, string>>;
  /** Written by the fake agent during the stage, the way a real stage writes one. */
  questions?: string | null;
  handoff?: string;
}): Made {
  const outbox = "notified.jsonl";
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates: options.gates,
  });
  open.push(made);
  const script = writeNotifier(made.root);
  writeFileSync(
    join(made.root, ".tldrx", "workspace.yml"),
    workspaceYamlWithNotify(`${script} ${join(made.root, outbox)}`),
    "utf8",
  );
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  const handoff = options.handoff ?? cannedHandoff();
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": handoff,
    "02-how/handoff.md": handoff,
    ...(options.questions === undefined || options.questions === null
      ? {}
      : { "01-what/questions.md": options.questions }),
  });
  process.env.FAKE_CLAUDE_COST = "0.42";
  return { ...made, outbox: join(made.root, outbox) };
}

function auto(ws: Made, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides });
}

function delivered(ws: Made): readonly Record<string, unknown>[] {
  return deliveredTo(ws.outbox);
}

function events(ws: Made): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

/** The kinds the notifier was handed, in delivery order. */
function order(ws: Made): readonly string[] {
  return delivered(ws).map((payload) => String(payload.kind));
}

/**
 * Answer both questions once the loop is demonstrably parked on the gate.
 *
 * The signal is the loop's OWN heartbeat, exactly as `notify-hook.test.ts` learned to
 * do it: a `status` payload carrying `waiting_on_gate` is written only while the loop
 * is parked at a gate, which is the state under test. A bare `setTimeout` raced it.
 *
 * The answered file is written directly rather than through `tldrx answer` — it is the
 * same bytes that verb leaves behind (`status: answered` plus the footer), and it is
 * what the gate's `questions` condition reads.
 */
async function answerWhenWaiting(ws: Made): Promise<void> {
  for (let i = 0; i < 800; i++) {
    const parked = delivered(ws).some(
      (payload) => payload.kind === "status"
        && (payload.detail as { waiting_on_gate?: unknown }).waiting_on_gate !== undefined,
    );
    if (parked) {
      writeFileSync(join(ws.runDir, "01-what", "questions.md"), ANSWERED, "utf8");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function gateRequested(ws: Made): TldrxEvent | undefined {
  return events(ws).find((e) => e.type === "gate.requested");
}

// ---------------------------------------------------------------------------
// (a) `why` travels, and the questions are notified first
// ---------------------------------------------------------------------------

describe("an auto gate held only by open questions", () => {
  test("`gate.requested` carries the verdict's why and the conditions that held it", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, questions: QUESTIONS });

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);

    const requested = gateRequested(ws);
    expect(requested).toBeDefined();
    expect(requested?.payload.held_by).toEqual(["questions"]);
    expect(String(requested?.payload.why)).toContain("questions=");
    expect(String(requested?.payload.why)).toContain("Q1");
    expect(String(requested?.payload.why)).toContain("Q2");
  });

  test("the questions reach the phone FIRST, and no gate notification goes out at all", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, questions: QUESTIONS });

    expect((await auto(ws)).code).toBe(4);

    const kinds = order(ws);
    expect(kinds).toContain("question.raised");
    // The gate is a consequence of the questions, not a second ask. The EVENT is on
    // the log either way — that is the audit trail — but nothing was sent about it.
    expect(kinds).not.toContain("gate.requested");
    expect(gateRequested(ws)).toBeDefined();
    const first = kinds.indexOf("question.raised");
    expect(first).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) the gate closes itself once the answers land
// ---------------------------------------------------------------------------

describe("--wait-gates re-runs the auto conditions and signs when they hold", () => {
  test("answers landing while the loop waits close the gate and the run carries on", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, questions: QUESTIONS });
    const answering = answerWhenWaiting(ws);

    const outcome = await auto(ws, { waitGatesMs: 20_000, notifyEveryMs: 40 });
    await answering;

    expect(outcome.lines.some((line) => line.includes("is approved, resuming"))).toBe(true);
    const approved = events(ws).filter((e) => e.type === "gate.approved" && e.stage === "alpha");
    expect(approved.length).toBe(1);
    // The SAME actor `next` records when an auto gate closes at the end of a stage.
    expect(approved[0]?.payload.by).toBe("auto");
    // It went ON to the next stage, not just past the gate.
    expect(events(ws).some((e) => e.type === "stage.started" && e.stage === "beta")).toBe(true);
    // Nobody was told to sign something the framework then signed itself.
    expect(order(ws)).not.toContain("gate.requested");
    expect(order(ws)).not.toContain("gate.timeout");
  });
});

// ---------------------------------------------------------------------------
// (c) a NON-question condition is notified at once, named, and never self-closed
// ---------------------------------------------------------------------------

describe("an auto gate held by something a person must judge", () => {
  test("the gate is notified immediately, the summary names the condition, and it lapses", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, handoff: unverifiableHandoff() });

    const outcome = await auto(ws, { waitGatesMs: 400 });
    expect(outcome.code).toBe(4);

    const requested = gateRequested(ws);
    expect(requested?.payload.held_by).toEqual(["claim-sources"]);
    expect(String(requested?.payload.why)).toContain("unverified");

    const sent = delivered(ws).filter((p) => p.kind === "gate.requested");
    expect(sent.length).toBe(1);
    // (f) the article — "a auto gate" is what the owner actually read.
    expect(String(sent[0]?.summary)).toContain("an auto gate");
    expect(String(sent[0]?.summary)).toContain("unverified");
    expect((sent[0]?.detail as { held_by?: unknown }).held_by).toEqual(
      [String((gateRequested(ws)?.payload as { why?: unknown }).why)],
    );

    // Nothing signed it: the condition never came to hold.
    expect(events(ws).some((e) => e.type === "gate.approved" && e.stage === "alpha")).toBe(false);
    expect(delivered(ws).some((p) => p.kind === "gate.timeout")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) the guard — a human gate is never signed by the loop
// ---------------------------------------------------------------------------

describe("only an `auto` policy is ever self-closed", () => {
  test("a `human` gate whose every auto condition holds still waits for a person", async () => {
    const ws = workspace({ gates: { alpha: "human", beta: "auto" } });

    const outcome = await auto(ws, { waitGatesMs: 400 });
    expect(outcome.code).toBe(4);
    expect(events(ws).some((e) => e.type === "gate.approved")).toBe(false);
    const store = RunStore.open(ws.runDir);
    const alpha = store.run.phases[0]?.stages.find((stage) => stage.id === "alpha");
    expect(alpha?.gate.status).toBe("pending");
    expect(delivered(ws).some((p) => p.kind === "gate.timeout")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) the asker's own recommendation
// ---------------------------------------------------------------------------

describe("`Recommended:` in a question block", () => {
  const CTX = { runDir: "", runId: "demo", phaseId: "01-what", stageId: "alpha" };

  function cardFor(text: string): ReturnType<typeof questionsCard> {
    const dir = join(process.env.TMPDIR ?? "/tmp", `tldrx-rec-${String(process.pid)}-${String(Math.random()).slice(2)}`);
    mkdirSync(join(dir, "01-what"), { recursive: true });
    writeFileSync(join(dir, "01-what", "questions.md"), text, "utf8");
    return questionsCard({ ...CTX, runDir: dir });
  }

  test("the parser reads the letter, the why and the citation", () => {
    const block = parseQuestions(QUESTIONS).blocks[0];
    expect(block?.recommended?.option).toBe("B");
    expect(block?.recommended?.why).toBe("every player sentence in the intake drops them");
    expect(block?.recommended?.src).toBe("01-what/handoff.md:1");
    // A block without the line reads as null — absence is not an empty recommendation.
    expect(parseQuestions(QUESTIONS).blocks[1]?.recommended).toBeNull();
  });

  test("the card renders it when no evidence note supplies one", () => {
    const card = cardFor(QUESTIONS);
    expect(card?.questions[0]?.recommendation).toEqual({
      option: "B",
      why: "every player sentence in the intake drops them",
      src: "01-what/handoff.md:1",
    });
    expect(card?.questions[1]?.recommendation).toBeNull();
  });

  test("a malformed line is ignored — never a refusal, and never a guessed letter", () => {
    const malformed = QUESTIONS.replace(
      "Recommended: B — every player sentence in the intake drops them [src: 01-what/handoff.md:1]",
      "Recommended: whichever one you like best",
    );
    expect(parseQuestions(malformed).blocks[0]?.recommended).toBeNull();
    const card = cardFor(malformed);
    expect(card?.questions[0]?.recommendation).toBeNull();
    expect(card?.questions.length).toBe(2);
  });

  test("an evidence note's `recommend:` wins over the block's own line", () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `tldrx-rec-note-${String(process.pid)}-${String(Math.random()).slice(2)}`);
    mkdirSync(join(dir, "01-what"), { recursive: true });
    writeFileSync(join(dir, "01-what", "questions.md"), QUESTIONS, "utf8");
    mkdirSync(join(dir, ".agent", "alpha"), { recursive: true });
    writeFileSync(
      join(dir, ".agent", "alpha", "evidence.md"),
      [
        "---",
        "version: 1",
        "gate: 01-what/alpha",
        "role: agent",
        "by: fable",
        "at: 2026-08-30T10:00:00Z",
        "verdict: sign",
        'read: ["01-what/handoff.md"]',
        "citations: {sampled: 2, of: 7, resolved: 2, refuted: 0}",
        "touches: {audited: 3, outside_surface: 0, new_areas: []}",
        "diff_vs_stories: n-a",
        "caveats: []",
        'recommend: [{q: Q1, option: "A", why: "the note read the ledger", src: "01-what/handoff.md:9"}]',
        "---",
        "",
        "# Evidence",
        "",
      ].join("\n"),
      "utf8",
    );
    const card = questionsCard({ ...CTX, runDir: dir });
    expect(card?.questions[0]?.recommendation?.option).toBe("A");
    expect(card?.questions[0]?.recommendation?.src).toBe("01-what/handoff.md:9");
  });

  test("the notification carries the block's recommendation for the owner to read", async () => {
    const ws = workspace({ gates: { alpha: "auto", beta: "auto" }, questions: QUESTIONS });
    expect((await auto(ws)).code).toBe(4);

    const raised = delivered(ws).filter((p) => p.kind === "question.raised");
    expect(raised.length).toBe(1);
    const detail = raised[0]?.detail as { questions?: readonly Record<string, unknown>[] };
    const first = detail.questions?.[0] ?? {};
    expect(first.recommendation).toEqual({
      option: "B",
      why: "every player sentence in the intake drops them",
      src: "01-what/handoff.md:1",
    });
  });
});

// ---------------------------------------------------------------------------
// The templates ask for what the cards render
// ---------------------------------------------------------------------------

describe("the shape the stages are given asks for a recommendation", () => {
  test.each(["templates/questions.md", "stages/what/stage.md", "stages/how/stage.md", "stages/plan/stage.md"])(
    "%s teaches the `Recommended:` line with a [src: …] token",
    (path) => {
      const text = readFileSync(join(import.meta.dir, "..", path), "utf8");
      expect(text).toContain("Recommended:");
      expect(text).toMatch(/Recommended:[^\n]*\[src:/);
    },
  );
});
