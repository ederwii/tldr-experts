/**
 * Wave M · M2 — an auto gate cannot be closed by silence.
 *
 * The measured failure, 2026-08-29: a stage that declares `questions.md` as an
 * output followed `templates/questions.md`, wrote `### Q1 — …` and `**Answer:**`,
 * and the §2.7 parser — which reads exactly `## Qn · Title` — found ZERO blocks.
 * "0 open questions" was recorded as satisfied and the gate signed itself over
 * four unanswered questions. Nothing anywhere said the file was unreadable.
 *
 * The prose fixture below is that file's real shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixQuestions, parseLooseQuestions, parseQuestions, unreadableQuestionHeadings,
  validateQuestions,
} from "../src/core/text/questions.ts";
import { declaresQuestions, evaluateAutoGate, NO_PARSEABLE_QUESTIONS } from "../src/core/run/autoGate.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { questionsCommand } from "../src/cli/commands/questions.ts";
import { TEMPLATES_DIR } from "../src/core/paths.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

/** The real shape a stage wrote on 2026-08-29, from the old template. */
const PROSE_QUESTIONS = [
  "# Open questions — `260829-probe` / `01-what`",
  "",
  "You may answer any subset.",
  "",
  "---",
  "",
  "### Q1 — Where does leaderboard state live?",
  "",
  "*Why it is being asked:* no ranking store exists in the map",
  "",
  "- **A)** New Postgres table — *implies:* a migration",
  "- **B)** Redis sorted set — *implies:* a new dependency",
  "- **Other:** _______",
  "",
  "**Answer:**",
  "",
  "---",
  "",
  "### Q2 — Is per-tenant isolation required?",
  "",
  "*Why it is being asked:* Place.TenantId is nullable",
  "",
  "- **A)** Yes, per tenant",
  "- **B)** No, global",
  "",
  "**Answer:** B — rankings are global",
  "",
].join("\n");

const GRAMMAR_QUESTIONS = [
  "# Questions",
  "",
  "## Q1 · Where does leaderboard state live?",
  "<!-- id: Q1 | status: open | area: domain | asked_by: alpha | asked_at: 2026-08-29T09:00:00Z -->",
  "Why asked: not in facts.yml [src: absent:.tldrx/memory/facts.yml]",
  "",
  "- A) In the API",
  "- B) In the lab",
  "",
  "[Answer]:",
  "",
].join("\n");

const ORIGINAL_PATH = process.env.PATH ?? "";
let open: FacilitatorWorkspace[] = [];
let scratch: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const ws of open) ws.dispose();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  open = [];
  scratch = [];
});

/** A stage that DECLARES questions.md as an output — the shape (b) applies to. */
const ASKER: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    { path: "01-what/questions.md" },
  ],
  checks: "[claim-sources]",
};

function workspace(stages: readonly StageOptions[], gates?: Record<string, string>): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10, gates });
  open.push(made);
  process.env.PATH = made.binDir;
  return made;
}

function inputs(ws: FacilitatorWorkspace): never {
  const store = RunStore.open(ws.runDir);
  return {
    root: ws.root,
    runDir: ws.runDir,
    phaseId: "01-what",
    stage: store.run.phases[0]?.stages[0],
    planned: loadWorkflowPreset(ws.root, store.run.scope).stages[0],
    budget: store.budget,
    checks: [{ id: "claim-sources", status: "passed", detail: "1 handoff(s) sourced" }],
  } as never;
}

describe("M2 · the parser's grammar, and what misses it", () => {
  test("the prose form parses as ZERO questions — the whole failure in one line", () => {
    expect(parseQuestions(PROSE_QUESTIONS).blocks).toHaveLength(0);
  });

  test("but the headings are visible as unreadable, by id", () => {
    expect(unreadableQuestionHeadings(PROSE_QUESTIONS)).toEqual(["Q1", "Q2"]);
  });

  test("a file already in the grammar reports nothing unreadable", () => {
    expect(unreadableQuestionHeadings(GRAMMAR_QUESTIONS)).toEqual([]);
    expect(parseQuestions(GRAMMAR_QUESTIONS).blocks).toHaveLength(1);
  });

  test("the loose reader salvages the title, the reason, the options and the answer", () => {
    const [q1, q2] = parseLooseQuestions(PROSE_QUESTIONS);
    expect(q1?.id).toBe("Q1");
    expect(q1?.title).toBe("Where does leaderboard state live?");
    expect(q1?.why).toBe("no ranking store exists in the map");
    // `- **Other:** _______` had no letter; it keeps its words and gets the next one.
    expect(q1?.options.map((o) => o.letter)).toEqual(["A", "B", "C"]);
    expect(q1?.options[2]?.text).toContain("other");
    expect(q1?.answer).toBe("");
    expect(q2?.options.map((o) => o.letter)).toEqual(["A", "B"]);
    expect(q2?.answer).toBe("B — rankings are global");
  });
});

describe("M2 · the shipped template is the grammar", () => {
  const template = readFileSync(join(TEMPLATES_DIR, "questions.md"), "utf8");

  test("templates/questions.md parses as real question blocks", () => {
    const doc = parseQuestions(template);
    expect(doc.blocks.map((b) => b.id)).toEqual(["Q1", "Q2"]);
  });

  test("its first block satisfies every §2.7 rule", () => {
    const doc = parseQuestions(template);
    const q1 = doc.blocks.filter((b) => b.id === "Q1");
    const issues = validateQuestions({ ...doc, blocks: q1 });
    expect(issues).toEqual([]);
  });

  test("it carries no heading the parser cannot read", () => {
    expect(unreadableQuestionHeadings(template)).toEqual([]);
  });
});

describe("M2 · --fix converts without changing a word", () => {
  test("every id comes across, and the result parses", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    });
    expect(fixed.converted).toEqual(["Q1", "Q2"]);
    const doc = parseQuestions(fixed.text);
    expect(doc.blocks.map((b) => b.id)).toEqual(["Q1", "Q2"]);
    expect(unreadableQuestionHeadings(fixed.text)).toEqual([]);
  });

  test("the author's own words survive verbatim", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    }).text;
    expect(fixed).toContain("## Q1 · Where does leaderboard state live?");
    expect(fixed).toContain("Why asked: no ranking store exists in the map");
    expect(fixed).toContain("- A) New Postgres table — *implies:* a migration");
    expect(fixed).toContain("- B) No, global");
  });

  test("an answer already typed in the prose form is carried into the slot", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    }).text;
    expect(fixed).toContain("[Answer]: B — rankings are global");
    const q2 = parseQuestions(fixed).blocks.find((b) => b.id === "Q2");
    expect(q2?.metadata?.status).toBe("answered");
    expect(q2?.answer).toBe("B — rankings are global");
  });

  test("the surrounding prose is left alone", () => {
    const fixed = fixQuestions(PROSE_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    }).text;
    expect(fixed).toContain("# Open questions — `260829-probe` / `01-what`");
    expect(fixed).toContain("You may answer any subset.");
  });

  test("a file already in the grammar is returned untouched", () => {
    const result = fixQuestions(GRAMMAR_QUESTIONS, {
      area: "domain", askedBy: "alan", askedAt: "2026-08-29T09:00:00Z",
    });
    expect(result.converted).toEqual([]);
    expect(result.text).toBe(GRAMMAR_QUESTIONS);
  });
});

describe("M2 · the auto gate reads the unreadable file", () => {
  test("a stage that declares questions.md as an output is subject to the rule", () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    const planned = loadWorkflowPreset(ws.root, RunStore.open(ws.runDir).run.scope).stages[0];
    expect(declaresQuestions(planned as never)).toBe(true);
  });

  test("prose questions refuse the gate, and the reason names the grammar", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain(NO_PARSEABLE_QUESTIONS);
    expect(verdict.why).toContain("Q1, Q2");
  });

  test("an EMPTY questions.md the stage was told to write also refuses it", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), "# Questions\n\nNone.\n", "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain(NO_PARSEABLE_QUESTIONS);
  });

  test("the same file in the grammar, with the question answered, lets it through", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(
      join(ws.runDir, "01-what", "questions.md"),
      GRAMMAR_QUESTIONS.replace("status: open", "status: answered"),
      "utf8",
    );
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(true);
  });

  test("a stage that does NOT declare questions.md is unaffected", async () => {
    const quiet: StageOptions = {
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
      outputs: [
        { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
        { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
      ],
      checks: "[claim-sources]",
    };
    const ws = workspace([quiet], { alpha: "auto" });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain("questions=0 open");
  });
});

describe("M2 · --commit refuses an unreadable questions.md (exit 5)", () => {
  test("the host session is told which questions vanished, and how to fix it", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    const prepared = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    expect(prepared.code).toBe(0);

    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(
      join(ws.runDir, ".agent", "alpha", "result.json"),
      JSON.stringify({ outputs: ["01-what/intent.md"], questions_asked: [], notes: "", cost_usd: 0.4 }),
      "utf8",
    );

    const committed = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(committed.code).toBe(5);
    const text = committed.lines.join("\n");
    expect(text).toContain("the parser cannot read");
    expect(text).toContain("Q1, Q2");
    expect(text).toContain("tldrx questions lint");
  });
});

describe("M2 · tldrx questions lint", () => {
  test("exits 2 and names the unreadable blocks", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    const printed = capture();
    const code = await questionsCommand.run(["lint", "--root", ws.root]);
    const out = printed();
    expect(code).toBe(2);
    expect(out).toContain("BAD");
    expect(out).toContain("Q1, Q2");
    expect(out).toContain("--fix");
  });

  test("--fix rewrites the file in place and then lints clean (exit 0)", async () => {
    const ws = workspace([ASKER]);
    const path = join(ws.runDir, "01-what", "questions.md");
    writeFileSync(path, PROSE_QUESTIONS, "utf8");

    let printed = capture();
    expect(await questionsCommand.run(["lint", "--root", ws.root, "--fix"])).toBe(0);
    expect(printed()).toContain("converted Q1, Q2");
    expect(parseQuestions(readFileSync(path, "utf8")).blocks).toHaveLength(2);

    printed = capture();
    expect(await questionsCommand.run(["lint", "--root", ws.root])).toBe(0);
    expect(printed()).toContain("2 question(s) parse");
  });

  test("a run with no questions.md says so and exits 0", async () => {
    const ws = workspace([ASKER]);
    const printed = capture();
    expect(await questionsCommand.run(["lint", "--root", ws.root])).toBe(0);
    expect(printed()).toContain("nothing to lint");
  });
});

/** Swap stdout for a buffer; returns a reader that restores it. */
function capture(): () => string {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
    return buffer;
  };
}

/** Keeps the temp-dir helper honest if a future test needs a bare workspace. */
export function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-q-"));
  scratch.push(dir);
  return dir;
}
