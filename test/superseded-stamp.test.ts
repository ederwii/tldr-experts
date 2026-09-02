/**
 * An owner answer that lands mid-run and flips an earlier phase's design (gh #104).
 *
 * Both cases in the issue are the same shape: a question raised in `04-build`
 * cites the plan or design document whose claim it doubts, the owner answers, the
 * fact is recorded — and the document a reader actually opens still asserts the
 * flipped design, with nothing on the page to say so. The auditor's workaround
 * ("read 04-build/ rather than 03-plan/ for what actually shipped") is tribal
 * knowledge, and this is the file that stops it being that.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRunWorkspace, EMPTY_FACTS } from "./fixtures/tempRunWorkspace.ts";
import { captureAnswers, supersedeAnswer, writeAnswerSlot } from "../src/core/answers/captureAnswers.ts";
import { affectedDocs, stampSuperseded, STAMP_MARKER } from "../src/core/answers/stampSuperseded.ts";
import { parseQuestions, type QuestionBlock } from "../src/core/text/questions.ts";
import { emptySrcContext, validateCitations, validateHandoff } from "../src/core/text/handoff.ts";
import { validateEvent } from "../src/core/events/Event.ts";

const RUN = "260830-ordering-inventory";

/** The claim the shipped code refuted — the issue's case 1, near enough verbatim. */
const S4 = `---
id: S4
status: done
evidence: []
---
# S4 · Stock effect trigger

## Definition of done

- NoStockEffectTrigger returns StockEffect.None for every pair; EveryTransitionPair_ReturnsNone
  is a [Theory] proving the default is inert.
`;

const QUESTIONS = `# Questions — 04-build — run ${RUN}

## Q4 · Is the default stock-effect trigger really inert for every transition pair?
<!-- id: Q4 | status: open | area: inventory | asked_by: developer | asked_at: 2026-08-30T09:00:00Z -->
Why asked: the story asserts an inert default and the matrix disagrees [src: 03-plan/stories/S4.md:8]

- A) Inert for all 64 pairs, as the story says
- B) Restock for 5 of the 64 pairs

[Answer]:
`;

function workspace(): { root: string; runDir: string; dispose: () => void } {
  const ws = makeRunWorkspace({ facts: EMPTY_FACTS });
  const runDir = join(ws.root, "tldrx-work", RUN);
  mkdirSync(join(runDir, "03-plan", "stories"), { recursive: true });
  mkdirSync(join(runDir, "04-build"), { recursive: true });
  writeFileSync(join(runDir, "03-plan", "stories", "S4.md"), S4, "utf8");
  writeFileSync(join(runDir, "04-build", "questions.md"), QUESTIONS, "utf8");
  return { root: ws.root, runDir, dispose: ws.dispose };
}

describe("an answer that overtakes an earlier phase's document", () => {
  test("stamps the document the question cites, without touching a word of it", () => {
    const ws = workspace();
    try {
      const questions = join(ws.runDir, "04-build", "questions.md");
      writeAnswerSlot(questions, "Q4", "B — Restock for 5 of the 64 pairs");
      const captured = captureAnswers(questions, {
        root: ws.root, runDir: ws.runDir, run: RUN,
        actor: "alan", at: "2026-08-30T10:00:00Z",
      });
      expect(captured.map((c) => c.fact)).toEqual(["F001"]);

      const story = readFileSync(join(ws.runDir, "03-plan", "stories", "S4.md"), "utf8");
      expect(story).toContain("tldrx:superseded F001");
      expect(story).toContain("Superseded in part by F001");
      // Append-only: every byte the Plan phase wrote is still there.
      expect(story.startsWith(S4)).toBe(true);
    } finally {
      ws.dispose();
    }
  });
});

describe("a reversal that overtakes an earlier phase's document", () => {
  test("`--supersede` stamps the same document with the fact that replaced the first", () => {
    const ws = workspace();
    try {
      const questions = join(ws.runDir, "04-build", "questions.md");
      writeAnswerSlot(questions, "Q4", "A — inert for all 64 pairs, as the story says");
      captureAnswers(questions, {
        root: ws.root, runDir: ws.runDir, run: RUN, actor: "alan", at: "2026-08-30T10:00:00Z",
      });
      const done = supersedeAnswer(questions, "Q4", "B — Restock for 5 of the 64 pairs", {
        root: ws.root, runDir: ws.runDir, run: RUN, actor: "alan", at: "2026-08-30T12:00:00Z",
      });
      expect(done.fact).toBe("F002");

      const story = readFileSync(join(ws.runDir, "03-plan", "stories", "S4.md"), "utf8");
      expect(story).toContain("tldrx:superseded F002");
      expect(story.startsWith(S4)).toBe(true);
    } finally {
      ws.dispose();
    }
  });
});

/** The issue's case 2: `02-how/handoff.md` said "no order_number column is created". */
const HANDOFF = `# Handoff — 02-how / design — run ${RUN}

## Findings

- No order_number column is created; ordering is positional [src: absent:api/Migrations]

## Decisions

- No order_number column is added; ordering stays positional [src: absent:api/Migrations]

## Unknowns

- none [src: absent:api/Migrations]

## Evidence ledger

- no migration adds an order_number column [src: absent:api/Migrations]
`;

describe("the stamp is append-only and lands once", () => {
  test("a second recording of the same fact does not stamp a second time", () => {
    const ws = workspace();
    try {
      const questions = join(ws.runDir, "04-build", "questions.md");
      const block = parseQuestions(readFileSync(questions, "utf8")).blocks[0] as QuestionBlock;
      const story = join(ws.runDir, "03-plan", "stories", "S4.md");

      const first = stampSuperseded(ws.runDir, questions, block, "F001", "2026-08-30T10:00:00Z");
      expect(first.map((d) => d.rel)).toEqual(["03-plan/stories/S4.md"]);
      const once = readFileSync(story, "utf8");

      const second = stampSuperseded(ws.runDir, questions, block, "F001", "2026-08-30T11:00:00Z");
      expect(second).toEqual([]);
      expect(readFileSync(story, "utf8")).toBe(once);
      expect(once.split(STAMP_MARKER).length - 1).toBe(1);

      // A DIFFERENT fact is a different claim, and stacks under the first.
      stampSuperseded(ws.runDir, questions, block, "F007", "2026-08-30T12:00:00Z");
      const twice = readFileSync(story, "utf8");
      expect(twice.startsWith(once)).toBe(true);
      expect(twice.split(STAMP_MARKER).length - 1).toBe(2);
    } finally {
      ws.dispose();
    }
  });
});

describe("a stamped document still passes the checks that guard it", () => {
  test("claim-sources reads a stamped handoff exactly as it read the unstamped one", () => {
    const ws = workspace();
    try {
      mkdirSync(join(ws.runDir, "02-how"), { recursive: true });
      const handoff = join(ws.runDir, "02-how", "handoff.md");
      writeFileSync(handoff, HANDOFF, "utf8");
      const ctx = emptySrcContext(ws.root, ws.runDir);

      // The premise: this handoff is clean BEFORE anything is appended to it.
      const before = validateHandoff(HANDOFF, ctx);
      expect(before.ok).toBe(true);

      const questions = join(ws.runDir, "04-build", "questions.md");
      const block = parseQuestions(readFileSync(questions, "utf8")).blocks[0] as QuestionBlock;
      // `affects:` is not on the fixture block, so name the handoff directly.
      const named: QuestionBlock = {
        ...block,
        metadata: { ...(block.metadata as NonNullable<QuestionBlock["metadata"]>), extra: [["affects", "02-how/handoff.md"]] },
      };
      const stamped = stampSuperseded(ws.runDir, questions, named, "F022", "2026-08-30T10:00:00Z");
      expect(stamped.map((d) => d.rel)).toContain("02-how/handoff.md");

      const text = readFileSync(handoff, "utf8");
      expect(text).toContain("Superseded in part by F022");
      const after = validateHandoff(text, ctx);
      expect(after.ok).toBe(true);
      expect(after.unsourced).toEqual([]);
      expect(after.malformed).toEqual([]);
      expect(after.emptySections).toEqual([]);
      // The stamp adds no bullet, so §2.8 counts exactly what it counted before.
      expect(after.bulletCount).toBe(before.bulletCount);
      // And it is not a citation either — the non-handoff rule sees nothing new.
      expect(validateCitations(text, ctx).malformed).toEqual([]);
      expect(validateCitations(text, ctx).unresolved).toEqual([]);
    } finally {
      ws.dispose();
    }
  });
});

describe("which documents a question names", () => {
  test("a citation into the question's OWN phase is not a supersession", () => {
    const ws = workspace();
    try {
      const questions = join(ws.runDir, "04-build", "questions.md");
      writeFileSync(join(ws.runDir, "04-build", "notes.md"), "# notes\n", "utf8");
      writeFileSync(questions, QUESTIONS.replace(
        "[src: 03-plan/stories/S4.md:8]", "[src: 04-build/notes.md:1]",
      ), "utf8");
      const block = parseQuestions(readFileSync(questions, "utf8")).blocks[0] as QuestionBlock;
      expect(affectedDocs(ws.runDir, questions, block)).toEqual([]);
    } finally {
      ws.dispose();
    }
  });

  test("`affects:` names a document the citation does not, and is honoured in any phase", () => {
    const ws = workspace();
    try {
      const questions = join(ws.runDir, "04-build", "questions.md");
      mkdirSync(join(ws.runDir, "02-how"), { recursive: true });
      writeFileSync(join(ws.runDir, "02-how", "design.md"), "# design\n", "utf8");
      writeFileSync(join(ws.runDir, "04-build", "notes.md"), "# notes\n", "utf8");
      writeFileSync(questions, QUESTIONS.replace(
        "asked_at: 2026-08-30T09:00:00Z -->",
        "asked_at: 2026-08-30T09:00:00Z | affects: 02-how/design.md, 04-build/notes.md -->",
      ), "utf8");
      const block = parseQuestions(readFileSync(questions, "utf8")).blocks[0] as QuestionBlock;
      const docs = affectedDocs(ws.runDir, questions, block);
      expect(docs.map((d) => d.rel).sort()).toEqual([
        "02-how/design.md", "03-plan/stories/S4.md", "04-build/notes.md",
      ]);
      expect(docs.find((d) => d.rel === "03-plan/stories/S4.md")?.by).toBe("cited");
      expect(docs.find((d) => d.rel === "02-how/design.md")?.by).toBe("affects");
    } finally {
      ws.dispose();
    }
  });

  test("a citation into source code, or outside the run, names no phase document", () => {
    const ws = workspace();
    try {
      const questions = join(ws.runDir, "04-build", "questions.md");
      writeFileSync(questions, QUESTIONS.replace(
        "[src: 03-plan/stories/S4.md:8]", "[src: api:src/Orders/Trigger.cs:22; ../../etc/passwd:1]",
      ), "utf8");
      const block = parseQuestions(readFileSync(questions, "utf8")).blocks[0] as QuestionBlock;
      expect(affectedDocs(ws.runDir, questions, block)).toEqual([]);
    } finally {
      ws.dispose();
    }
  });

  test("a questions file outside a run — `tldrx interview --init` — names nothing", () => {
    // `--init` passes `.tldrx/` as the run dir and `.tldrx/init-questions.md` as the
    // file. There are no phases there, so there is nothing an answer can overtake.
    const ws = workspace();
    try {
      const initDir = join(ws.root, ".tldrx");
      const questions = join(initDir, "init-questions.md");
      writeFileSync(questions, QUESTIONS, "utf8");
      const block = parseQuestions(readFileSync(questions, "utf8")).blocks[0] as QuestionBlock;
      expect(affectedDocs(initDir, questions, block)).toEqual([]);
    } finally {
      ws.dispose();
    }
  });
});

describe("the log says what was stamped", () => {
  test("`doc.superseded` carries the document, the fact and how it was found", () => {
    const ws = workspace();
    try {
      const questions = join(ws.runDir, "04-build", "questions.md");
      writeAnswerSlot(questions, "Q4", "B — Restock for 5 of the 64 pairs");
      captureAnswers(questions, {
        root: ws.root, runDir: ws.runDir, run: RUN, actor: "alan", at: "2026-08-30T10:00:00Z",
      });
      const events = readFileSync(join(ws.runDir, "events.jsonl"), "utf8")
        .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
      const stamp = events.find((e) => e.type === "doc.superseded");
      expect(stamp).toBeDefined();
      expect(validateEvent(stamp).ok).toBe(true);
      expect(stamp?.payload).toEqual({
        doc: "03-plan/stories/S4.md", fact: "F001", q: "Q4", by: "cited",
      });
    } finally {
      ws.dispose();
    }
  });
});
