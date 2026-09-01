/**
 * Wave 4A — decision cards (design §F.3).
 *
 * The interrupt surface. When an unattended run stops for a person, what it hands
 * over is the DECISION — the question, its options, and the agent's
 * recommendation — not a dashboard and not two ids in brackets.
 *
 * The grounding is measured, 2026-08-30: a host stopped an unattended run for two
 * owner questions and hand-composed exactly this card in chat. The owner answered
 * both in seconds. The card is what made the interrupt cheap; hand-composing it is
 * what the framework was making the host pay for.
 *
 * These tests hold two lines hard:
 *
 *   PURE RENDERING       every field on a card already existed. `questions.md` is
 *                        read with the §2.7 parser and nothing here changes the
 *                        §2.7 grammar — asserted by round-tripping the fixture
 *                        byte-for-byte after a card has been rendered from it.
 *   NEVER INVENTED       a question with no `recommend:` entry renders WITHOUT the
 *                        recommendation line, rather than with a manufactured one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetCard, boundaryCard, cardForTriggers, gateCard, questionsCard, readRecommendations,
  type CardContext,
} from "../src/core/run/decisionCards.ts";
import {
  decisionHeader, renderDecisionCard, renderRecommendation, DECISION_KINDS,
} from "../src/core/ui/decisionCard.ts";
import { parseQuestions, serializeQuestions } from "../src/core/text/questions.ts";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { evidencePath, gateEvidencePath } from "../src/core/facilitator/paths.ts";
import { buildWorkspaceStatus } from "../src/core/status/index.ts";
import { renderWorkspaceStatus } from "../src/core/status/renderWorkspaceStatus.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST"] as const;

let open: FacilitatorWorkspace[] = [];
let temps: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  open = [];
  temps = [];
});

// ---------------------------------------------------------------------------
// The fixture: a real §2.7 questions.md, in the shape tonight's run actually
// stopped on — two owner questions, one of which an agent had a view about.
// ---------------------------------------------------------------------------

const QUESTIONS = [
  "# Questions — 01-what — run 260830-tenancy",
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
  "## Q2 · Should an existing customer's tenant be inferred or asked for?",
  "<!-- id: Q2 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-30T09:40:01Z -->",
  "Why asked: no tenant column on the customer aggregate [src: absent:api:src/Places/Place.cs]",
  "",
  "- A) infer from the invoice email domain — no new UI, wrong for resellers",
  "- B) ask once at first login — one screen, correct for everyone",
  "- C) other — write it below",
  "",
  "[Answer]:",
  "",
  "## Q3 · Which currency does the invoice total use?",
  "<!-- id: Q3 | status: answered | area: billing | asked_by: product | asked_at: 2026-08-30T09:40:02Z -->",
  "Why asked: two currencies appear in the fixtures [src: absent:api:src/Billing/Invoice.cs]",
  "",
  "- A) USD only",
  "- B) the tenant's own",
  "",
  "[Answer]: B",
  "<!-- answered_by: alan | answered_at: 2026-08-30T10:00:00Z | fact: F021 -->",
  "",
].join("\n");

/** A note that parses, carrying one recommendation — for Q2 and only Q2. */
function noteWithRecommendation(recommend: readonly string[] = [
  '  - {q: Q2, option: "B", why: "one screen, correct for everyone", src: "01-what/handoff.md:22"}',
]): string {
  return [
    "---",
    "version: 1",
    "gate: 01-what/what",
    "role: agent",
    "by: fable",
    "at: 2026-08-30T22:14:03Z",
    "verdict: sign",
    'read: ["01-what/handoff.md"]',
    "citations: {sampled: 2, of: 4, resolved: 2, refuted: 0}",
    "touches: {audited: 0, outside_surface: 0, new_areas: []}",
    "diff_vs_stories: n-a",
    "caveats: []",
    ...(recommend.length === 0 ? ["recommend: []"] : ["recommend:", ...recommend]),
    "---",
    "",
    "# Gate evidence — 01-what/what",
    "",
    "## Read",
    "- the handoff [src: 01-what/handoff.md:1]",
    "",
    "## Citations checked",
    "- 2 of 4 spot-checked [src: 01-what/handoff.md:4]",
    "",
    "## Touches audited",
    "- nothing built yet [src: 01-what/handoff.md:1]",
    "",
    "## Verdict",
    "- SIGN [src: 01-what/handoff.md:1]",
    "",
  ].join("\n");
}

/** A bare run tree: `<phase>/questions.md` and, optionally, an evidence note. */
function tempRun(options: { questions?: string; note?: string; committedNote?: string } = {}): CardContext {
  const runDir = mkdtempSync(join(tmpdir(), "tldrx-card-"));
  temps.push(runDir);
  mkdirSync(join(runDir, "01-what"), { recursive: true });
  writeFileSync(join(runDir, "01-what", "questions.md"), options.questions ?? QUESTIONS, "utf8");
  if (options.note !== undefined) {
    const path = evidencePath(runDir, "what");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, options.note, "utf8");
  }
  if (options.committedNote !== undefined) {
    const path = gateEvidencePath(runDir, "01-what", "what");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, options.committedNote, "utf8");
  }
  return { runDir, runId: "260830-tenancy", phaseId: "01-what", stageId: "what" };
}

// ---------------------------------------------------------------------------
// A. The card, from a real questions.md
// ---------------------------------------------------------------------------

describe("the questions card", () => {
  test("reads the open blocks of a real §2.7 file, and only the open ones", () => {
    const card = questionsCard(tempRun());
    expect(card).not.toBeNull();
    expect(card?.kind).toBe("questions");
    expect(card?.questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
    expect(card?.questions[0]?.title).toBe("Should hunts a player abandoned count toward the leaderboard?");
    expect(card?.questions[0]?.options.map((o) => o.letter)).toEqual(["A", "B", "C"]);
    expect(card?.questions[0]?.options[1]?.text).toBe("drop them — matches how players talk about their score");
    expect(card?.questions[0]?.whyAsked)
      .toBe("no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]");
    expect(card?.questions[1]?.answerCommand).toBe('tldrx answer Q2 "…" --run 260830-tenancy');
  });

  test("no open question ⇒ no card at all, not an empty frame", () => {
    const answered = QUESTIONS.split("status: open").join("status: answered");
    expect(questionsCard(tempRun({ questions: answered }))).toBeNull();
  });

  test("a missing questions.md is silence, not a crash", () => {
    const runDir = mkdtempSync(join(tmpdir(), "tldrx-card-"));
    temps.push(runDir);
    expect(questionsCard({ runDir, runId: "r", phaseId: "01-what", stageId: "what" })).toBeNull();
  });

  test("the whole card renders exactly, WITHOUT a recommendation nobody wrote", () => {
    const card = questionsCard(tempRun());
    expect(card).not.toBeNull();
    expect(renderDecisionCard(card!)).toEqual([
      "DECISION — 260830-tenancy · 01-what/what",
      "Q1 · Should hunts a player abandoned count toward the leaderboard?",
      "  Why asked: no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]",
      "  A) count them — simplest, but rewards quitting early",
      "  B) drop them — matches how players talk about their score",
      "  C) other — write it below",
      '  tldrx answer Q1 "…" --run 260830-tenancy',
      "",
      "Q2 · Should an existing customer's tenant be inferred or asked for?",
      "  Why asked: no tenant column on the customer aggregate [src: absent:api:src/Places/Place.cs]",
      "  A) infer from the invoice email domain — no new UI, wrong for resellers",
      "  B) ask once at first login — one screen, correct for everyone",
      "  C) other — write it below",
      '  tldrx answer Q2 "…" --run 260830-tenancy',
    ]);
  });

  test("with a `recommend:` entry, the line appears — and ONLY on the question it names", () => {
    const card = questionsCard(tempRun({ note: noteWithRecommendation() }));
    expect(card).not.toBeNull();
    const lines = renderDecisionCard(card!);
    expect(lines).toContain("Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]");
    // Q1 got none, so Q1 shows none. The card never manufactures one.
    expect(lines.filter((line) => line.startsWith("Recommends "))).toHaveLength(1);
    expect(card?.questions[0]?.recommendation).toBeNull();
    expect(card?.questions[1]?.recommendation).toEqual({
      option: "B", why: "one screen, correct for everyone", src: "01-what/handoff.md:22",
    });
    // The recommendation sits BELOW the options: a reader who disagrees has
    // already read the alternatives by the time they reach it.
    expect(lines.indexOf("Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]"))
      .toBe(lines.indexOf("  C) other — write it below", 8) + 1);
  });

  test("an empty `recommend: []` is the same as no note", () => {
    const card = questionsCard(tempRun({ note: noteWithRecommendation([]) }));
    expect(renderDecisionCard(card!).filter((l) => l.startsWith("Recommends "))).toHaveLength(0);
  });

  test("a note that does not parse contributes nothing, and refuses nothing", () => {
    const card = questionsCard(tempRun({ note: "---\nverdict: sign\n---\n\nnot a note\n" }));
    expect(card).not.toBeNull();
    expect(card?.questions.every((q) => q.recommendation === null)).toBe(true);
  });

  test("the committed copy is read when the scratch note is absent", () => {
    const found = readRecommendations(tempRun({ committedNote: noteWithRecommendation() }));
    expect(found.get("Q2")?.option).toBe("B");
  });

  test("the scratch note wins over the committed one — it is the newer proposal", () => {
    const scratch = noteWithRecommendation(['  - {q: Q2, option: "A", why: "scratch", src: "x.md:1"}']);
    const committed = noteWithRecommendation(['  - {q: Q2, option: "C", why: "committed", src: "y.md:1"}']);
    const found = readRecommendations(tempRun({ note: scratch, committedNote: committed }));
    expect(found.get("Q2")?.option).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// B. The questions grammar is untouched
// ---------------------------------------------------------------------------

describe("§2.7 is not touched", () => {
  test("a file a card was rendered from round-trips byte-for-byte", () => {
    const ctx = tempRun();
    questionsCard(ctx);
    const text = QUESTIONS;
    expect(serializeQuestions(parseQuestions(text))).toBe(text);
  });

  test("the card reads through the §2.7 parser, so a block it cannot see it does not show", () => {
    // `### Q1 — …` is the prose shape the parser refuses (measured 2026-08-29).
    // It is not half-rendered on a card: it is absent, exactly as it is absent to
    // every other reader. The card does not become a second, looser parser.
    const loose = ["# Questions", "", "### Q1 — Where does state live?", "", "**Answer:**", ""].join("\n");
    expect(questionsCard(tempRun({ questions: loose }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. One golden card per fallthrough kind
// ---------------------------------------------------------------------------

describe("a card per fallthrough kind", () => {
  const ctx = (): CardContext => tempRun();

  test("the four kinds are exactly these", () => {
    expect([...DECISION_KINDS]).toEqual(["questions", "budget", "boundary", "gate"]);
  });

  test("questions — the kind design §F.3 draws", () => {
    const card = cardForTriggers(ctx(), [{ trigger: "questions", detail: "2 open (Q1, Q2)" }]);
    expect(card?.kind).toBe("questions");
    expect(renderDecisionCard(card!)[0]).toBe("DECISION — 260830-tenancy · 01-what/what");
  });

  test("budget — the number and the commands", () => {
    const card = budgetCard(
      ctx(),
      "1 budget event(s) in this stage's window (budget.raised at 2026-08-30T21:10:00Z)",
      { spentUsd: 8.31, ceilingUsd: 12.0 },
    );
    expect(renderDecisionCard(card)).toEqual([
      "DECISION — 260830-tenancy · 01-what/what",
      "Budget — a person moved the ceiling while this stage ran",
      "  $8.31 spent of $12.00",
      "  1 budget event(s) in this stage's window (budget.raised at 2026-08-30T21:10:00Z)",
      "  tldrx budget show --run 260830-tenancy",
      "  tldrx approve --run 260830-tenancy",
      '  tldrx reject --run 260830-tenancy --note "<why>"',
    ]);
  });

  test("budget with no phase row states no number rather than $0.00", () => {
    const lines = renderDecisionCard(budgetCard(ctx(), "budget.raised at 21:10", null));
    expect(lines.some((line) => line.includes("$0.00"))).toBe(false);
  });

  test("boundary — the paths, and the two ways out", () => {
    const detail = "13 changed path(s), 2 outside the surface: api:src/Billing/Invoice.cs, api:src/Billing/Ledger.cs";
    expect(renderDecisionCard(boundaryCard(ctx(), detail))).toEqual([
      "DECISION — 260830-tenancy · 01-what/what",
      "Boundary — the epic changed paths nobody scoped",
      `  ${detail}`,
      "  widen the scope: add the path to a story's `touches:`, or cite it in a handoff, then re-run the stage",
      "  tldrx approve --run 260830-tenancy",
      '  tldrx reject --run 260830-tenancy --note "<why>"',
    ]);
  });

  test("gate — every other reason, carried with its reason", () => {
    expect(renderDecisionCard(gateCard(ctx(), "Gate — 1 reason(s)", ["evidence: no note"]))).toEqual([
      "DECISION — 260830-tenancy · 01-what/what",
      "Gate — 1 reason(s)",
      "  evidence: no note",
      "  tldrx approve --run 260830-tenancy",
      '  tldrx reject --run 260830-tenancy --note "<why>"',
    ]);
  });

  test("an open question outranks every other trigger", () => {
    const card = cardForTriggers(ctx(), [
      { trigger: "boundary", detail: "2 outside" },
      { trigger: "questions", detail: "2 open (Q1, Q2)" },
      { trigger: "budget-event", detail: "budget.raised" },
    ]);
    expect(card?.kind).toBe("questions");
  });

  test("boundary outranks a budget event, and both outrank the generic card", () => {
    const none = tempRun({ questions: QUESTIONS.split("status: open").join("status: answered") });
    expect(cardForTriggers(none, [
      { trigger: "boundary", detail: "b" }, { trigger: "budget-event", detail: "m" },
    ])?.kind).toBe("boundary");
    expect(cardForTriggers(none, [{ trigger: "budget-event", detail: "m" }])?.kind).toBe("budget");
    expect(cardForTriggers(none, [{ trigger: "condition", detail: "c" }])?.kind).toBe("gate");
  });

  test("a `questions` trigger over a file with nothing open falls to the gate card", () => {
    const none = tempRun({ questions: QUESTIONS.split("status: open").join("status: answered") });
    const card = cardForTriggers(none, [{ trigger: "questions", detail: "questions.md does not parse" }]);
    expect(card?.kind).toBe("gate");
    expect(card?.detail).toEqual(["questions: questions.md does not parse"]);
  });

  test("no trigger ⇒ no card", () => {
    expect(cardForTriggers(ctx(), [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D. The recommendation line itself
// ---------------------------------------------------------------------------

describe("the recommendation line", () => {
  test("option, why and src", () => {
    expect(renderRecommendation({ option: "B", why: "one screen", src: "01-what/handoff.md:22" }))
      .toBe("Recommends B — one screen [src: 01-what/handoff.md:22]");
  });

  test("an empty `why` degrades to design §F.3's own shape, not to a dangling dash", () => {
    expect(renderRecommendation({ option: "B", why: "  ", src: "01-what/handoff.md:22" }))
      .toBe("Recommends B [src: 01-what/handoff.md:22]");
  });

  test("no recommendation ⇒ no line", () => {
    expect(renderRecommendation(null)).toBeNull();
  });

  test("the header names the run and the gate, so a pasted card says where it came from", () => {
    expect(decisionHeader({
      kind: "gate", run: "260830-tenancy", gate: "04-build/build",
      headline: "", questions: [], detail: [], commands: [],
    })).toBe("DECISION — 260830-tenancy · 04-build/build");
  });
});

// ---------------------------------------------------------------------------
// E. `run auto --gate-agent` — the stop
// ---------------------------------------------------------------------------

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
const ALPHA_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});

function workspace(gates: Readonly<Record<string, string>>): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates,
  });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = ALPHA_OUTPUTS;
  process.env.FAKE_CLAUDE_COST = "0.42";
  return made;
}

function auto(ws: FacilitatorWorkspace, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({
    root: ws.root, yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

/** Park the cursor stage on the questions it asked, the way a real run does. */
function parkOnQuestions(ws: FacilitatorWorkspace, questions = QUESTIONS): void {
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

describe("run auto --gate-agent", () => {
  test("the stop carries the card, and the card carries the recommendation", async () => {
    const ws = workspace({ alpha: "auto", beta: "auto" });
    parkOnQuestions(ws);
    const path = evidencePath(ws.runDir, "alpha");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, noteWithRecommendation(), "utf8");

    const outcome = await auto(ws, { gateAgent: true });
    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain(`DECISION — ${ws.runId} · 01-what/alpha`);
    expect(said).toContain("Q1 · Should hunts a player abandoned count toward the leaderboard?");
    expect(said).toContain("  B) ask once at first login — one screen, correct for everyone");
    expect(said).toContain("Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]");
    expect(said).toContain(`tldrx answer Q2 "…" --run ${ws.runId}`);
    // The answered Q3 is not a decision anybody is waiting on.
    expect(said).not.toContain("Q3 ·");
    expect(events(ws).some((e) => e.type === "agent.spawned")).toBe(false);
  });

  test("without the flag the stop is byte-identical to what it has always been", async () => {
    const ws = workspace({ alpha: "auto", beta: "auto" });
    parkOnQuestions(ws);

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines).toEqual([
      "01-what/alpha … awaiting answers: 2 open question(s) in 01-what/questions.md (Q1, Q2)",
      "  awaiting answers: 2 open question(s) in 01-what/questions.md (Q1, Q2)",
      '    answer with `tldrx answer Q1 "…"`',
    ]);
  });

  test("the ordinary status block is REPLACED, not appended to", async () => {
    const ws = workspace({ alpha: "auto", beta: "auto" });
    parkOnQuestions(ws);

    const outcome = await auto(ws, { gateAgent: true });
    // The loop's own per-stage line survives — it is the log, not the block.
    expect(outcome.lines[0]).toContain("01-what/alpha … awaiting answers:");
    expect(outcome.lines[1]).toBe(`DECISION — ${ws.runId} · 01-what/alpha`);
    expect(outcome.lines.some((line) => line.startsWith('    answer with'))).toBe(false);
  });

  test("no questions ⇒ the loop is unchanged, with the flag and without it", async () => {
    const bare = await auto(workspace({ alpha: "human", beta: "human" }));
    const carded = await auto(workspace({ alpha: "human", beta: "human" }), { gateAgent: true });
    expect(bare.code).toBe(4);
    expect(carded.code).toBe(4);
    // Same stage line; the card frames the same words rather than inventing any.
    expect(bare.lines[0]).toContain("01-what/alpha … done $0.42 · awaiting human gate");
    expect(carded.lines[0]).toContain("01-what/alpha … done $0.42 · awaiting human gate");
    expect(carded.lines).toContain("Gate — this run stopped for a person");
    expect(carded.lines.some((line) => line.includes("gate pending: tldrx approve"))).toBe(true);
    expect(bare.lines.some((line) => line.startsWith("DECISION — "))).toBe(false);
  });

  test("a run that finishes cleanly is untouched by the flag", async () => {
    const ws = workspace({ alpha: "auto", beta: "auto" });
    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
      "01-what/intent.md": cannedIntent(),
      "01-what/handoff.md": cannedHandoff(),
      "02-how/handoff.md": cannedHandoff(),
    });
    const outcome = await auto(ws, { gateAgent: true });
    expect(outcome.code).toBe(0);
    expect(outcome.lines.some((line) => line.startsWith("DECISION — "))).toBe(false);
  });

  test("on an attended run the flag changes nothing: exit 1, and nothing spawned", async () => {
    const ws = workspace({ alpha: "auto", beta: "auto" });
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({ ...run, attended_by: "host" as const }));
    store.save();

    const outcome = await auto(ws, { gateAgent: true });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("`run auto` is a loop over spawns and this run does not spawn");
    expect(outcome.lines.some((line) => line.startsWith("DECISION — "))).toBe(false);
    expect(events(ws).some((e) => e.type === "agent.spawned")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F. The agent-gate fallthrough — the card, appended to what it already said
// ---------------------------------------------------------------------------

describe("next, on an agent gate that fell through on questions", () => {
  test("the fallthrough list is unchanged and the card is appended below it", async () => {
    const ws = makeFacilitatorWorkspace({
      scope: "demo",
      budgetUsd: 10,
      gates: { alpha: "agent", beta: "human" },
      stages: [
        { ...ALPHA, outputs: [...(ALPHA.outputs ?? []), { path: "01-what/questions.md" }] },
        BETA,
      ],
    });
    open.push(ws);
    process.env.PATH = ws.binDir;
    process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
    process.env.FAKE_CLAUDE_COST = "0.42";
    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
      "01-what/intent.md": cannedIntent(),
      "01-what/handoff.md": cannedHandoff(),
      "01-what/questions.md": QUESTIONS,
    });

    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    // Byte-for-byte what it said before the card existed …
    expect(said).toContain("agent gate not taken");
    expect(said).toContain("questions: 2 open (Q1, Q2)");
    expect(said).toContain("gate pending: tldrx approve");
    // … plus the decision itself.
    expect(said).toContain(`DECISION — ${ws.runId} · 01-what/alpha`);
    expect(said).toContain("Q2 · Should an existing customer's tenant be inferred or asked for?");
    expect(said).toContain(`tldrx answer Q1 "…" --run ${ws.runId}`);
    // No note on disk, so no recommendation is invented.
    expect(outcome.lines.some((line) => line.startsWith("Recommends "))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. `tldrx status` — the same card, from the same renderer
// ---------------------------------------------------------------------------

describe("tldrx status", () => {
  test("a run waiting on answers shows the card, not two ids", () => {
    const ws = workspace({ alpha: "auto", beta: "auto" });
    parkOnQuestions(ws);
    const path = evidencePath(ws.runDir, "alpha");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, noteWithRecommendation(), "utf8");

    const rendered = renderWorkspaceStatus(buildWorkspaceStatus(ws.root));
    expect(rendered).toContain(`DECISION — ${ws.runId} · 01-what/alpha`);
    expect(rendered).toContain("Q2 · Should an existing customer's tenant be inferred or asked for?");
    expect(rendered).toContain("Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]");
    // The old ids line is gone precisely because the card names them as headings.
    expect(rendered).not.toContain("open questions: Q1, Q2");
    // The command on the item itself is unchanged.
    expect(rendered).toContain(`tldrx answer Q1 "<your answer>" --run ${ws.runId}`);
  });

  test("a run waiting on anything else is unchanged", () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    const rendered = renderWorkspaceStatus(buildWorkspaceStatus(ws.root));
    expect(rendered).not.toContain("DECISION — ");
  });
});
