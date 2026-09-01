/**
 * `tldrx questions cards [<run>]` — a parked question, as something to decide (gh #59).
 *
 * Measured on run 260830-ordering-inventory, 2026-09-01. The host parked four
 * product questions with notes and reported them in its tl;dr. The owner's live
 * words were "cuales preguntas? no las veo? por que no me guió por las preguntas
 * Claude?" — the questions were on disk, they were in `tldrx questions <run>`,
 * and the count was in the summary. None of that PRESENTED them. Counted is not
 * asked, and the gap was never in the data; it was in the arc from parked to
 * answerable.
 *
 * ## What this is, and what it deliberately is not
 *
 * Owner decision, 2026-09-01: printable decision cards, **no interactive loop in
 * v1**, answers still flowing through the existing `tldrx answer`. So this module
 * READS. It opens no run, spawns nothing, records no fact, and does not touch one
 * byte of `questions.md` — a test asserts the file is identical across a render.
 * The §2.7 grammar is not extended either: every field on a card is one the
 * parser already produces, for the same reason `decisionCards.ts` gives — that
 * grammar is exact, hard-won and not worth touching to buy a screen.
 *
 * ## The three slots, and why each is a refusal
 *
 *   context          two lines: which run and file the question is parked in, and
 *                    who asked it, when, in what area. A card is pasted into chat
 *                    and has to stand up away from the terminal that printed it.
 *   already decided  the question's OWN `Why asked:` note, verbatim, its
 *                    `[src: …]` included. This is the slot the brief calls "what
 *                    the binding docs already decide", and the grammar carries it
 *                    — so it is quoted, never summarised. A note with no citation
 *                    is FLAGGED as citing nothing rather than presented as
 *                    settled; a question with no note at all says so.
 *   options          the file's lettered options, verbatim. When there are none,
 *                    a NEEDS-OPTIONS marker and nothing else. Manufacturing A/B/C
 *                    here would be answering the question in the act of asking
 *                    it, which is the one thing a presentation layer must not do.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBlocks, parseQuestions, type QuestionBlock } from "../text/questions.ts";
import { answerCommand } from "./decisionCards.ts";
import type { DecisionOption } from "../ui/decisionCard.ts";

/**
 * The phases a run keeps questions in, in run order.
 *
 * The same list `questions lint` walks (`cli/commands/questions.ts`). Kept in one
 * place so the two verbs of `tldrx questions` cannot disagree about which files
 * they are talking about — a linter that reads five files and a card renderer
 * that reads four would make "0 open" mean two different things.
 */
export const QUESTION_PHASES = ["01-what", "02-how", "03-plan", "04-build", "05-watch"] as const;

/** Printed in place of options when the file carries none. Loud on purpose. */
export const NEEDS_OPTIONS = "NEEDS OPTIONS";

/** One open question, ready to print. Every field is read, none is computed. */
export interface QuestionCard {
  readonly id: string;
  readonly title: string;
  /** `<phase>/questions.md` — where a reader goes to see it in place. */
  readonly path: string;
  /** 1-based line of the `## Q…` heading within that file. */
  readonly line: number;
  readonly area: string;
  readonly askedBy: string;
  readonly askedAt: string;
  /** The `Why asked:` text, `[src: …]` and all. Null when the block carries none. */
  readonly note: string | null;
  /** True when that note actually cites something the §2.8 grammar can read. */
  readonly noteCited: boolean;
  readonly options: readonly DecisionOption[];
  /** `tldrx answer Q3 "…" --run <id>` — the one thing to type. */
  readonly answerCommand: string;
}

/**
 * Every OPEN question in the run, in phase order then file order.
 *
 * An unreadable or absent file contributes nothing rather than throwing: this is
 * a presentation path, and a run whose `03-plan/questions.md` is malformed still
 * has three other phases of questions somebody is owed. `questions lint` is the
 * verb that says a file cannot be parsed, and it says it with an exit code.
 */
export function collectQuestionCards(runDir: string, runId: string): readonly QuestionCard[] {
  const cards: QuestionCard[] = [];
  for (const phase of QUESTION_PHASES) {
    const path = join(runDir, phase, "questions.md");
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const rel = `${phase}/questions.md`;
    for (const block of openBlocks(parseQuestions(text).blocks)) {
      cards.push(toCard(block, rel, runId));
    }
  }
  return cards;
}

/** How many `questions.md` files the run has at all — 0 tells two silences apart. */
export function countQuestionFiles(runDir: string): number {
  let found = 0;
  for (const phase of QUESTION_PHASES) {
    if (existsSync(join(runDir, phase, "questions.md"))) found++;
  }
  return found;
}

function toCard(block: QuestionBlock, path: string, runId: string): QuestionCard {
  const note = block.whyAsked === null || block.whyAsked.trim() === "" ? null : block.whyAsked.trim();
  return {
    id: block.id,
    title: block.title,
    path,
    line: block.startLine,
    area: block.metadata?.area ?? "",
    askedBy: block.metadata?.asked_by ?? "",
    askedAt: block.metadata?.asked_at ?? "",
    note,
    // A token that PARSED but resolved to no refs is not a citation. `[src: ]`
    // and a bare sentence get the same flag, because the reader's next move is
    // the same in both cases: go and find what actually settles this.
    noteCited: note !== null && block.whySrc !== null && block.whySrc.refs.length > 0,
    options: block.options.map((option) => ({
      letter: option.letter,
      text: option.text.split("\n")[0] ?? "",
    })),
    answerCommand: answerCommand(block.id, runId),
  };
}

/**
 * Why there is nothing to present. Two silences, told apart.
 *
 * "This run has no questions.md" is a run that never asked anything — usually one
 * that has not reached a stage that asks. "It has files and nothing open" is a run
 * whose questions are all answered, which is the good outcome and reads as one.
 * A single "no open questions" line would have made the first look like the
 * second, and the first is the one where somebody should go and look.
 */
export function noOpenQuestions(runId: string, fileCount: number): string {
  if (fileCount === 0) {
    return `run ${runId} has no questions.md in any phase — no stage has parked a question,`
      + " so there is nothing to decide.\n";
  }
  return `run ${runId}: no open question in ${String(fileCount)} questions.md file(s)`
    + " — every one of them is answered or withdrawn.\n";
}

// --- the screen --------------------------------------------------------------

/**
 * The cards. One block each, separated by a rule, in the order they were found.
 *
 * No colour, no width fitting and no terminal detection — this goes to a
 * terminal, to a pipe, and into a chat message a host pastes, and all three want
 * the same bytes. Same decision, same reason, as `ui/decisionCard.ts`.
 */
export function renderQuestionCards(runId: string, cards: readonly QuestionCard[]): string {
  // Deliberately NOT `noOpenQuestions(runId, 0)`: that sentence claims the run has
  // no questions.md at all, and this function cannot know. The caller counts the
  // files and says which silence it is; this is the neutral fallback.
  if (cards.length === 0) return `run ${runId}: no open question to show.\n`;
  const out: string[] = [
    `Open questions — run ${runId} · ${String(cards.length)} to decide`,
    "",
    "One card per parked question. Read it, pick, and type the command at the foot of the card;",
    "nothing here answers anything on your behalf.",
    "",
  ];
  cards.forEach((card, index) => {
    out.push(...cardBlock(card, index + 1, cards.length), "");
  });
  return `${out.join("\n")}`;
}

function cardBlock(card: QuestionCard, n: number, total: number): readonly string[] {
  const out = [
    "─".repeat(72),
    `${card.id} · ${card.title}`,
    `  ${String(n)} of ${String(total)} · parked in ${card.path}:${String(card.line)}`,
    `  asked by ${card.askedBy || "(unrecorded)"} on ${card.askedAt || "(undated)"}`
      + `${card.area === "" ? "" : ` · area ${card.area}`}`,
    "",
    "  What the binding docs already decide",
  ];
  if (card.note === null) {
    out.push(
      "    no note — this question was parked without a `Why asked:` line, so nothing on record",
      "    says what already settles it. Treat it as unresearched.",
    );
  } else {
    out.push(`    ${card.note}`);
    if (!card.noteCited) {
      out.push("    (the note cites nothing — it is somebody's recollection until you check it)");
    }
  }

  out.push("", "  Options");
  if (card.options.length === 0) {
    out.push(
      `    ${NEEDS_OPTIONS} — the file carries none, and this card will not invent them.`,
      "    Write 2-5 lettered options into the block, or answer in free text below.",
    );
  } else {
    for (const option of card.options) out.push(`    ${option.letter}) ${option.text}`);
  }

  out.push("", `  ${card.answerCommand}`);
  return out;
}
