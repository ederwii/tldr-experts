/**
 * `questions_policy: recommended` — the loop answers a question that carries its own
 * `Recommended:` line, and escalates only the ones that do not (gh #251).
 *
 * The measurement behind it, 2026-09-12, two headless runs at 0.16.1: ten owner questions,
 * nine carrying a `Recommended:` line the asking agent had written, every one of them a
 * park — the run's clock ran for 22 h and 2.5 h on the two runs while the agents' clock
 * did not. The pick was on disk, in a parsed field (`RECOMMENDED_RE`), carried onto the
 * decision card and into the `question.raised` payload, and nothing acted on it.
 *
 * What these tests hold:
 *
 *   THE FLAG        `--questions` parses exactly as `--gates` does — same `all`/`none`, same
 *                   bare-means-human, same refusals — and lands in `run.yml` additively:
 *                   a run opened without it carries no key at all and reads `human`.
 *   THE PICK        one derivation of "which option did the asker recommend": the letter must
 *                   name an option that exists, the alternatives are the rest, and a block
 *                   tagged `irreversible: true` / `money: true` is nobody's to take.
 *   THE RECORD      the answer goes through the SAME `captureAnswers` path `tldrx answer`
 *                   uses, so `question.answered` + `fact.added` are byte-for-byte the events a
 *                   person's answer writes — and the fact says WHO decided (`agent-default`,
 *                   a third value, never `owner`), what it did not take (`alternatives`) and
 *                   the asker's own reason (`recommended_why`).
 *   THE LOOP        under `recommended` a parked stage with a recommended question resumes
 *                   with ZERO `question.raised` and ONE `question.auto_answered`; without a
 *                   `Recommended:` line, or with `money: true`, or under the default policy,
 *                   it parks exactly as it always did — exit 4, one `question.raised`.
 *   THE SIGNATURE   `run questions set` mirrors `run gates set`: one stage, qualified,
 *                   `--note` required, no-op refused, one `questions.policy_changed` event.
 *
 * Hermetic: every workspace is its own `mkdtemp` directory and the only processes spawned
 * are the notifier script inside it and the fake `claude` on a PATH holding nothing else.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { FACT_DECIDERS, type Fact } from "../src/core/facts/Fact.ts";
import { validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
import { emitFactsYaml } from "../src/core/facts/emitFactsYaml.ts";
import { factsPath } from "../src/hooks/lib/workspace.ts";
import { NOTIFY_KINDS } from "../src/core/notify/payload.ts";
import { EVENT_TYPES, type TldrxEvent } from "../src/core/events/Event.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import {
  IRREVERSIBLE_KEY, MONEY_KEY, parseQuestions, pinnedToPerson, recommendedPick,
} from "../src/core/text/questions.ts";
import {
  QUESTION_POLICIES, QuestionsPolicyError, parseQuestionsFlag, questionsPolicyFor,
} from "../src/core/run/questionsPolicy.ts";
import { setQuestionsPolicy } from "../src/core/run/setQuestionsPolicy.ts";
import { validateRunFile } from "../src/core/run/RunFile.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { createRun, NewRunError } from "../src/core/run/newRun.ts";
import { deliveredTo, writeNotifier, workspaceYamlWithNotify } from "./fixtures/facilitator/notifier.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

setDefaultTimeout(spawnTestTimeout(60_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST"] as const;
let open: FacilitatorWorkspace[] = [];
let plain: TempRunWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  for (const ws of plain) ws.dispose();
  open = [];
  plain = [];
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

const STAGES = ["alpha", "beta"] as const;

const WHY = "matches how players talk about their score";
const OPTION_A = "count them — simplest, but rewards quitting early";
const OPTION_B = "drop them — matches how players talk about their score";
const OPTION_C = "other — write it below";

/** A three-option question whose asker recommended B, with the asker's reason on the line. */
function questionsFile(options: { recommended?: boolean; extra?: string } = {}): string {
  const extra = options.extra === undefined ? "" : ` | ${options.extra}`;
  return [
    "# Questions — 01-what — run demo",
    "",
    "## Q1 · Should hunts a player abandoned count toward the leaderboard?",
    `<!-- id: Q1 | status: open | area: product | asked_by: product | asked_at: 2026-08-30T09:40:00Z${extra} -->`,
    "Why asked: no rule for abandoned hunts exists in memory [src: absent:.tldrx/memory/facts.yml]",
    "",
    `- A) ${OPTION_A}`,
    `- B) ${OPTION_B}`,
    `- C) ${OPTION_C}`,
    ...(options.recommended === false ? [] : [`Recommended: B — ${WHY} [src: absent:.tldrx/memory/facts.yml]`]),
    "",
    "[Answer]:",
    "",
  ].join("\n");
}

interface Made extends FacilitatorWorkspace {
  readonly outbox: string;
}

function workspace(options: { questionsFlag?: string } = {}): Made {
  const outbox = "notified.jsonl";
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10,
    gates: { alpha: "auto", beta: "auto" },
    ...(options.questionsFlag === undefined ? {} : { questionsFlag: options.questionsFlag }),
  });
  open.push(made);
  const script = writeNotifier(made.root, 0);
  writeFileSync(
    join(made.root, ".tldrx", "workspace.yml"),
    workspaceYamlWithNotify(`${script} ${join(made.root, outbox)}`),
    "utf8",
  );
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

function delivered(ws: Made, kind: string): readonly Record<string, unknown>[] {
  return deliveredTo(ws.outbox).filter((payload) => payload.kind === kind);
}

function events(ws: Made, type: string): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read().filter((event) => event.type === type);
}

function facts(ws: Made): readonly Fact[] {
  return FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
}

/** Park the cursor stage on the question it asked, the way a real run does. */
function parkOnQuestions(ws: Made, questions: string): void {
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
// (a) `--questions` — parsed exactly as `--gates` is
// ---------------------------------------------------------------------------

describe("--questions parsing", () => {
  test("the policies are a closed pair, and the default is the one that stops", () => {
    expect([...QUESTION_POLICIES]).toEqual(["human", "recommended"]);
    expect(questionsPolicyFor(undefined, "alpha")).toBe("human");
    expect(questionsPolicyFor({ beta: "recommended" }, "alpha")).toBe("human");
    expect(questionsPolicyFor({ alpha: "recommended" }, "alpha")).toBe("recommended");
  });

  test("`all` is every stage human; `none` is every stage recommended", () => {
    expect(parseQuestionsFlag("all", STAGES)).toEqual({ alpha: "human", beta: "human" });
    expect(parseQuestionsFlag("none", STAGES)).toEqual({ alpha: "recommended", beta: "recommended" });
  });

  test("a bare entry means human and everything else recommended; a qualified entry says so outright", () => {
    expect(parseQuestionsFlag("alpha", STAGES)).toEqual({ alpha: "human", beta: "recommended" });
    expect(parseQuestionsFlag(" beta:recommended , alpha:human ", STAGES))
      .toEqual({ alpha: "human", beta: "recommended" });
  });

  test("an unknown stage, an unknown policy and an empty value are each refused by name", () => {
    expect(() => parseQuestionsFlag("alpha,nosuch", STAGES)).toThrow(/--questions: nosuch is not a stage/);
    expect(() => parseQuestionsFlag("alpha:sometimes", STAGES)).toThrow(/not one of human \| recommended/);
    expect(() => parseQuestionsFlag("", STAGES)).toThrow(QuestionsPolicyError);
    expect(() => parseQuestionsFlag("", STAGES)).toThrow(/--questions needs a value/);
  });
});

// ---------------------------------------------------------------------------
// (b) `questions_policy` in run.yml — additive, absent by default
// ---------------------------------------------------------------------------

describe("questions_policy in run.yml", () => {
  test("a run opened without the flag carries NO key at all, and reads human everywhere", () => {
    const ws = workspace();
    const store = RunStore.open(ws.runDir);
    expect(store.run.questions_policy).toBeUndefined();
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).not.toContain("questions_policy");
    expect(questionsPolicyFor(store.run.questions_policy, "alpha")).toBe("human");
    expect(emitRunYaml(store.run)).not.toContain("questions_policy");
  });

  test("`run new --questions` freezes the resolved map, one entry per stage, and it survives a save", () => {
    const ws = workspace({ questionsFlag: "beta" });
    const store = RunStore.open(ws.runDir);
    expect(store.run.questions_policy).toEqual({ alpha: "recommended", beta: "human" });
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8"))
      .toContain("questions_policy: {alpha: recommended, beta: human}");
    // Beside the gates policy, never instead of it.
    expect(store.run.gates_policy).toEqual({ alpha: "auto", beta: "auto" });

    store.save();
    expect(RunStore.open(ws.runDir).run.questions_policy).toEqual({ alpha: "recommended", beta: "human" });
  });

  test("`run new --questions` with an unknown stage refuses to create the run", () => {
    const made = makeRunWorkspace();
    plain.push(made);
    expect(() => createRun({
      root: made.root, slug: "nope", scope: "feature", questions: "what,nosuch",
      actor: "alan", now: new Date("2026-08-29T09:00:00Z"),
    })).toThrow(NewRunError);
  });

  test("a value outside the closed pair fails validation at its own path", () => {
    const ws = workspace({ questionsFlag: "none" });
    const raw = readFileSync(join(ws.runDir, "run.yml"), "utf8")
      .replace("questions_policy: {alpha: recommended, beta: recommended}", "questions_policy: {alpha: sometimes, beta: recommended}");
    const validation = validateRunFile(parseYaml(raw));
    expect(validation.ok).toBe(false);
    expect(validation.issues[0]?.path).toBe("questions_policy.alpha");
  });
});

// ---------------------------------------------------------------------------
// (c) The pick — one derivation, and the two keys that pin a question to a person
// ---------------------------------------------------------------------------

describe("recommendedPick", () => {
  const block = (text: string) => parseQuestions(text).blocks[0]!;

  test("names the recommended option, the ones not taken, and the asker's own reason", () => {
    const pick = recommendedPick(block(questionsFile()));
    expect(pick).toEqual({
      letter: "B",
      text: OPTION_B,
      alternatives: [`A) ${OPTION_A}`, `C) ${OPTION_C}`],
      why: WHY,
    });
  });

  test("a block with no `Recommended:` line yields nothing to take", () => {
    expect(recommendedPick(block(questionsFile({ recommended: false })))).toBeNull();
  });

  test("a letter that names no option is not a pick — nothing is invented", () => {
    const text = questionsFile().replace("Recommended: B —", "Recommended: E —");
    expect(recommendedPick(block(text))).toBeNull();
  });

  test("`irreversible: true` and `money: true` pin the question to a person; anything else does not", () => {
    expect(IRREVERSIBLE_KEY).toBe("irreversible");
    expect(MONEY_KEY).toBe("money");
    expect(pinnedToPerson(block(questionsFile({ extra: "money: true" })))).toBe(true);
    expect(pinnedToPerson(block(questionsFile({ extra: "irreversible: true" })))).toBe(true);
    expect(pinnedToPerson(block(questionsFile({ extra: "money: false" })))).toBe(false);
    expect(pinnedToPerson(block(questionsFile({ extra: "money: yes" })))).toBe(false);
    expect(pinnedToPerson(block(questionsFile()))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) The record — a third decider, and two additive fields
// ---------------------------------------------------------------------------

describe("a fact an agent-default answered", () => {
  const row: Fact = {
    id: "F001",
    fact: "Should hunts a player abandoned count? — B) drop them",
    area: "product",
    repos: [],
    kind: "answer",
    confidence: "stated",
    source: { who: "alan", when: "2026-08-29T09:00:00Z", run: "260828-demo", q: "Q1", decided_by: "agent-default" },
    supersedes: null,
    superseded_by: null,
    retired: null,
    alternatives: [`A) ${OPTION_A}`, `C) ${OPTION_C}`],
    recommended_why: WHY,
  };

  test("`agent-default` is a decider, beside owner and driver — never in their place", () => {
    expect([...FACT_DECIDERS]).toEqual(["owner", "driver", "agent-default"]);
  });

  test("the row validates, round-trips through facts.yml, and a row without the fields still validates", () => {
    const emitted = emitFactsYaml({ version: 1, facts: [row] });
    expect(emitted).toContain("decided_by: agent-default");
    expect(emitted).toContain(`alternatives: ["A) ${OPTION_A}", "C) ${OPTION_C}"]`);
    // `yamlScalar` quotes a string carrying spaces; the assertion is on the emitted bytes.
    expect(emitted).toContain(`recommended_why: "${WHY}"`);
    const parsed = parseYaml(emitted);
    expect(validateFactsFile(parsed).ok).toBe(true);
    const back = (parsed as { facts: Fact[] }).facts[0]!;
    expect(back.alternatives).toEqual(row.alternatives);
    expect(back.recommended_why).toBe(WHY);

    const { alternatives: _a, recommended_why: _w, ...bare } = row;
    const plainRow = { ...bare, source: { ...bare.source, decided_by: undefined } };
    const plainEmitted = emitFactsYaml({ version: 1, facts: [plainRow] });
    expect(plainEmitted).not.toContain("alternatives");
    expect(plainEmitted).not.toContain("recommended_why");
    expect(validateFactsFile(parseYaml(plainEmitted)).ok).toBe(true);
  });

  test("an empty `alternatives` list is refused — on disk it would claim a check ran", () => {
    const validation = validateFactsFile({ version: 1, facts: [{ ...row, alternatives: [] }] });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.path === "facts[0].alternatives")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) The kinds — one notify kind, one event type, both additive
// ---------------------------------------------------------------------------

describe("the new kinds are registered beside their siblings", () => {
  test("`question.auto_answered` is a notify kind an owner can subscribe to", () => {
    expect(NOTIFY_KINDS).toContain("question.auto_answered");
  });

  test("`questions.policy_changed` is an event type, beside `gate.policy_changed`", () => {
    expect(EVENT_TYPES).toContain("questions.policy_changed");
    expect(EVENT_TYPES.indexOf("questions.policy_changed")).toBe(EVENT_TYPES.indexOf("gate.policy_changed") + 1);
  });
});

// ---------------------------------------------------------------------------
// (f) The loop — what `recommended` takes, and what it still escalates
// ---------------------------------------------------------------------------

describe("run auto under questions_policy: recommended", () => {
  test("a recommended question is answered by the loop: 0 question.raised, 1 question.auto_answered, the run finishes", async () => {
    const ws = workspace({ questionsFlag: "none" });
    parkOnQuestions(ws, questionsFile());

    const outcome = await auto(ws);
    expect(outcome.code).toBe(0);
    expect(delivered(ws, "question.raised").length).toBe(0);

    const told = delivered(ws, "question.auto_answered");
    expect(told.length).toBe(1);
    const detail = told[0]?.detail as {
      question: { id: string; title: string };
      pick: { letter: string; text: string };
      alternatives: string[];
      why: string;
      fact: string;
      decided_by: string;
    };
    expect(detail.question.id).toBe("Q1");
    expect(detail.pick).toEqual({ letter: "B", text: OPTION_B });
    expect(detail.alternatives).toEqual([`A) ${OPTION_A}`, `C) ${OPTION_C}`]);
    expect(detail.why).toBe(WHY);
    expect(detail.decided_by).toBe("agent-default");
    // The one thing a person can DO about it: reverse it, through the same door.
    expect(told[0]?.command).toBe(`tldrx answer Q1 "…" --run ${ws.runId} --supersede`);

    // The SAME record `tldrx answer` writes — plus who decided and what was not taken.
    const recorded = facts(ws);
    expect(recorded.length).toBe(1);
    const fact = recorded[0]!;
    expect(fact.source.q).toBe("Q1");
    expect(fact.source.decided_by).toBe("agent-default");
    expect(fact.alternatives).toEqual([`A) ${OPTION_A}`, `C) ${OPTION_C}`]);
    expect(fact.recommended_why).toBe(WHY);
    expect(fact.fact).toContain(`B) ${OPTION_B}`);
    expect(detail.fact).toBe(fact.id);

    // `question.answered` and `fact.added` exactly as a person's answer appends them.
    const answered = events(ws, "question.answered");
    expect(answered.length).toBe(1);
    expect(answered[0]?.payload.q).toBe("Q1");
    expect(answered[0]?.payload.fact).toBe(fact.id);
    expect(events(ws, "fact.added").length).toBe(1);

    const block = parseQuestions(readFileSync(join(ws.runDir, "01-what", "questions.md"), "utf8")).blocks[0]!;
    expect(block.metadata?.status).toBe("answered");
    expect(block.footer?.fact).toBe(fact.id);
  });

  test("the loop says what it decided on stdout, so a transcript reader is not surprised later", async () => {
    const ws = workspace({ questionsFlag: "none" });
    parkOnQuestions(ws, questionsFile());
    const outcome = await auto(ws);
    expect(outcome.code).toBe(0);
    const line = outcome.lines.find((l) => l.includes("Q1") && l.includes("agent-default"));
    expect(line).toBeDefined();
    expect(line).toContain("B)");
  });

  test("a question WITHOUT a `Recommended:` line still parks: exit 4, one question.raised, nothing recorded", async () => {
    const ws = workspace({ questionsFlag: "none" });
    parkOnQuestions(ws, questionsFile({ recommended: false }));

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(delivered(ws, "question.raised").length).toBe(1);
    expect(delivered(ws, "question.auto_answered").length).toBe(0);
    expect(facts(ws).length).toBe(0);
    expect(events(ws, "question.answered").length).toBe(0);
  });

  test("a question tagged `money: true` is a person's whatever the policy says", async () => {
    const ws = workspace({ questionsFlag: "none" });
    parkOnQuestions(ws, questionsFile({ extra: "money: true" }));

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(delivered(ws, "question.raised").length).toBe(1);
    expect(delivered(ws, "question.auto_answered").length).toBe(0);
    expect(facts(ws).length).toBe(0);
  });

  test("a question tagged `irreversible: true` is a person's whatever the policy says", async () => {
    const ws = workspace({ questionsFlag: "none" });
    parkOnQuestions(ws, questionsFile({ extra: "irreversible: true" }));

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(delivered(ws, "question.raised").length).toBe(1);
    expect(delivered(ws, "question.auto_answered").length).toBe(0);
  });

  test("under the DEFAULT policy a recommended question parks exactly as it always did", async () => {
    const ws = workspace();
    parkOnQuestions(ws, questionsFile());

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    const raised = delivered(ws, "question.raised");
    expect(raised.length).toBe(1);
    // The recommendation still rides the payload — that is what a person reads.
    const detail = raised[0]?.detail as { questions: { recommendation: { option: string } | null }[] };
    expect(detail.questions[0]?.recommendation?.option).toBe("B");
    expect(delivered(ws, "question.auto_answered").length).toBe(0);
    expect(facts(ws).length).toBe(0);
  });

  test("the policy is the CURSOR stage's: `recommended` on another stage does not reach this park", async () => {
    // alpha (the parked stage) stays human; beta is recommended.
    const ws = workspace({ questionsFlag: "alpha" });
    parkOnQuestions(ws, questionsFile());

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(delivered(ws, "question.raised").length).toBe(1);
    expect(delivered(ws, "question.auto_answered").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (g) `run questions set` — the signed upgrade path, `run gates set`'s shape
// ---------------------------------------------------------------------------

describe("run questions set", () => {
  const NOTE = "the owner wants the loop to take the asker's pick on this stage";

  function setOn(ws: Made, entry: string, note = NOTE) {
    return setQuestionsPolicy({
      root: ws.root, entry, note, runId: ws.runId, actor: "alan", at: "2026-08-29T10:00:00Z",
    });
  }

  test("moves one stage's policy, writes the FULL map, and records the change with its note", () => {
    const ws = workspace();
    expect(RunStore.open(ws.runDir).run.questions_policy).toBeUndefined();

    const out = setOn(ws, "alpha:recommended");
    expect(out.code).toBe(0);
    expect(out.lines.join("\n")).toContain("alpha");
    expect(out.lines.join("\n")).toContain("recommended");

    const after = RunStore.open(ws.runDir).run;
    expect(after.questions_policy).toEqual({ alpha: "recommended", beta: "human" });
    // The gates policy is untouched.
    expect(after.gates_policy).toEqual({ alpha: "auto", beta: "auto" });

    const recorded = events(ws, "questions.policy_changed");
    expect(recorded.length).toBe(1);
    const event = recorded[0]!;
    expect(event.stage).toBe("alpha");
    expect(event.actor).toBe("alan");
    expect(event.cost_usd).toBe(0);
    expect(event.payload.from).toBe("human");
    expect(event.payload.to).toBe("recommended");
    expect(event.payload.note).toBe(NOTE);
    expect(event.payload.by).toBe("alan");
    expect(events(ws, "gate.policy_changed").length).toBe(0);
  });

  test("refuses without --note, a bare stage, a list, an unknown policy, and a no-op — writing nothing", () => {
    const ws = workspace({ questionsFlag: "none" });
    const before = readFileSync(join(ws.runDir, "run.yml"), "utf8");

    expect(setOn(ws, "alpha:human", "").code).toBe(2);
    expect(setOn(ws, "alpha").code).toBe(2);
    expect(setOn(ws, "alpha:human,beta:human").code).toBe(2);
    const unknown = setOn(ws, "alpha:sometimes");
    expect(unknown.code).toBe(2);
    expect(unknown.lines.join("\n")).toContain("sometimes");
    const noop = setOn(ws, "alpha:recommended");
    expect(noop.code).toBe(2);
    expect(noop.lines.join("\n")).toContain("already");

    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toBe(before);
    expect(events(ws, "questions.policy_changed").length).toBe(0);
  });
});
