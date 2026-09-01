/**
 * `tldrx questions cards [<run>]` — the parked-to-asked arc (gh #59).
 *
 * Measured on run 260830-ordering-inventory, 2026-09-01: the host parked four
 * product questions with notes and reported them in its tl;dr. The owner's live
 * reaction was "cuales preguntas? no las veo?" — the questions were in the run's
 * files and in `tldrx questions <run>`, and nothing WALKED the owner through them
 * as answerable items. Counted is not presented.
 *
 * The owner decision of 2026-09-01: printable decision cards, no interactive loop,
 * answers still flowing through the existing `tldrx answer`. So this is a READER,
 * and these tests hold that line hard:
 *
 *   - it renders OPEN questions and only those;
 *   - what the binding docs already decide comes from the question's OWN note —
 *     the §2.7 `Why asked:` line, verbatim, citation and all. Never summarised,
 *     never invented, and when the note carries no citation the card says so;
 *   - a question parked with no options gets a NEEDS-OPTIONS marker rather than a
 *     manufactured A/B/C, because inventing the choices is deciding the question;
 *   - nothing is written, and no open questions is a sentence and an exit 0.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { createRun } from "../src/core/run/newRun.ts";
import {
  collectQuestionCards, noOpenQuestions, NEEDS_OPTIONS, renderQuestionCards,
} from "../src/core/run/questionCards.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
let open: TempRunWorkspace[] = [];

afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

const QUESTIONS = [
  "# Questions — 01-what — run 260901-ordering",
  "",
  "## Q3 · Does a back-ordered line hold the whole order?",
  "<!-- id: Q3 | status: open | area: product | asked_by: product | asked_at: 2026-09-01T09:40:00Z -->",
  "Why asked: the ordering ADR settles partial shipment and says nothing about back-order [src: docs/adr/ADR-7.md:31]",
  "",
  "- A) hold the order — one shipment, simplest for support",
  "- B) ship what is there — two shipments, more freight",
  "- C) other — write it below",
  "",
  "[Answer]:",
  "",
  "## Q4 · Which warehouse is authoritative for stock?",
  "<!-- id: Q4 | status: open | area: product | asked_by: product | asked_at: 2026-09-01T09:40:01Z -->",
  "Why asked: nothing on record picks one",
  "",
  "[Answer]:",
  "",
  "## Q5 · What currency does the invoice total use?",
  "<!-- id: Q5 | status: answered | area: billing | asked_by: product | asked_at: 2026-09-01T09:40:02Z -->",
  "Why asked: the pricing doc names two [src: docs/adr/ADR-7.md:1]",
  "",
  "- A) GBP",
  "- B) EUR",
  "",
  "[Answer]: GBP, always",
  "",
].join("\n");

/** A run dir on disk with one phase's questions.md. No run.yml needed to READ. */
function runDir(text: string = QUESTIONS, phase = "01-what"): string {
  const ws = makeRunWorkspace();
  open.push(ws);
  const dir = join(ws.root, "tldrx-work", "260901-ordering");
  mkdirSync(join(dir, phase), { recursive: true });
  writeFileSync(join(dir, phase, "questions.md"), text, "utf8");
  return dir;
}

function render(text: string = QUESTIONS): string {
  const dir = runDir(text);
  return renderQuestionCards("260901-ordering", collectQuestionCards(dir, "260901-ordering"));
}

describe("open questions, and only those", () => {
  test("every OPEN question becomes a card", () => {
    const cards = collectQuestionCards(runDir(), "260901-ordering");
    expect(cards.map((card) => card.id)).toEqual(["Q3", "Q4"]);
  });

  test("an answered question is not a decision anybody still owes", () => {
    expect(render()).not.toContain("Q5");
  });

  test("each card names the question in the file's own words", () => {
    expect(render()).toContain("Q3 · Does a back-ordered line hold the whole order?");
  });
});

describe("two lines of context, so the card stands alone", () => {
  test("the card says which run and which file the question is parked in", () => {
    const out = render();
    expect(out).toContain("260901-ordering");
    expect(out).toContain("01-what/questions.md");
  });

  test("it says who asked and in what area — a card pasted into chat carries both", () => {
    const out = render();
    expect(out).toContain("product");
    expect(out).toContain("2026-09-01T09:40:00Z");
  });
});

describe("what the binding docs already decide", () => {
  test("the question's own note is carried verbatim, citation and all", () => {
    expect(render()).toContain(
      "the ordering ADR settles partial shipment and says nothing about back-order [src: docs/adr/ADR-7.md:31]",
    );
  });

  test("a note with no citation is FLAGGED rather than dressed up as one", () => {
    const out = render();
    expect(out).toContain("nothing on record picks one");
    expect(out.toLowerCase()).toContain("cites nothing");
  });

  test("a question parked with no note at all says so, and invents none", () => {
    const bare = [
      "## Q9 · Should we do the thing?",
      "<!-- id: Q9 | status: open | area: product | asked_by: product | asked_at: 2026-09-01T10:00:00Z -->",
      "",
      "[Answer]:",
      "",
    ].join("\n");
    const out = render(bare);
    expect(out.toLowerCase()).toContain("no note");
  });
});

describe("options are a slot, never a guess", () => {
  test("the options the file carries are printed verbatim, with their letters", () => {
    const out = render();
    expect(out).toContain("A) hold the order — one shipment, simplest for support");
    expect(out).toContain("B) ship what is there — two shipments, more freight");
  });

  test("a question with none is marked NEEDS-OPTIONS, not given A/B/C", () => {
    const out = render();
    expect(out).toContain(NEEDS_OPTIONS);
    expect(out).not.toContain("A) other");
  });
});

describe("answers keep flowing through `tldrx answer`", () => {
  test("every card prints the one command that answers it", () => {
    expect(render()).toContain('tldrx answer Q3 "…" --run 260901-ordering');
  });
});

describe("it is a reader", () => {
  test("no open questions is a sentence, not an empty frame", () => {
    const said = noOpenQuestions("260901-ordering", 1);
    expect(said).toContain("260901-ordering");
    expect(said.toLowerCase()).toContain("no open question");
  });

  test("it says when there is no questions.md at all, which is a different thing", () => {
    expect(noOpenQuestions("260901-ordering", 0).toLowerCase()).toContain("no questions.md");
  });

  test("rendering a run changes not one byte of it", () => {
    const dir = runDir();
    const path = join(dir, "01-what", "questions.md");
    const before = readFileSync(path, "utf8");
    renderQuestionCards("260901-ordering", collectQuestionCards(dir, "260901-ordering"));
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("through the CLI", () => {
  test("`questions cards` exits 0 and prints the cards", () => {
    const ws = makeRunWorkspace();
    open.push(ws);
    const made = createRun({
      root: ws.root, slug: "ordering", scope: "feature",
      actor: "alan", now: new Date("2026-09-01T09:00:00Z"),
    });
    mkdirSync(join(made.runDir, "01-what"), { recursive: true });
    writeFileSync(join(made.runDir, "01-what", "questions.md"), QUESTIONS, "utf8");
    const out = execFileSync("bun", [BIN, "questions", "cards", "--run", made.runId, "--root", ws.root], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toContain("Q3");
    expect(out).toContain(NEEDS_OPTIONS);
  });

  test("a run with no open question exits 0 and says so", () => {
    const ws = makeRunWorkspace();
    open.push(ws);
    const made = createRun({
      root: ws.root, slug: "quiet", scope: "feature",
      actor: "alan", now: new Date("2026-09-01T09:00:00Z"),
    });
    const out = execFileSync("bun", [BIN, "questions", "cards", "--run", made.runId, "--root", ws.root], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out.toLowerCase()).toContain("no questions.md");
  });
});
