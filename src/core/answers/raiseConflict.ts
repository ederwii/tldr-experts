/**
 * The §2.7 question a detected contradiction raises (#169).
 *
 * It RAISES; it never refuses. The answer stands, the command exits 0, and the
 * disagreement becomes a block a person can answer — the issue's own words,
 * "Raise, do not refuse". A refusal here could deadlock an unattended run over a
 * lexical near-match nobody has measured a false-positive rate for.
 *
 * The block is rendered through `renderQuestionBlock` (`text/questions.ts`),
 * which is the canonical §2.7 authoring renderer and the ONE implementation of
 * the block. `renderDistill.renderQuestions` is deliberately NOT used: it renders
 * a whole FILE, opening with an H1 and numbering ids from `Q1`, so appending its
 * output to a file that already has a Q1 would mint a duplicate id — and
 * `answer.ts`'s `locateQuestion` scans every phase for an id, so a duplicate
 * makes the wrong block answerable.
 *
 * Ids are minted across the WHOLE run, not the file, for that same reason.
 *
 * DATA in, per AGENTS §12: paths, ids and strings. No `ctx`, no session, no store.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuestions, renderQuestionBlock } from "../text/questions.ts";
import { QUESTION_PHASES } from "../run/questionCards.ts";
import { formatJaccard } from "../facts/findDuplicate.ts";

export interface RaisedConflict {
  /** The id of the question this raised. */
  readonly q: string;
  /** The fact just recorded. */
  readonly fact: string;
  /** The fact it was detected to contradict. */
  readonly conflictsWith: string;
  readonly score: number;
}

export interface RaiseConflictArgs {
  readonly runDir: string;
  /** The `questions.md` the answered block lives in — the block is appended here. */
  readonly questionsPath: string;
  readonly area: string;
  readonly askedBy: string;
  readonly at: string;
  readonly newFactId: string;
  readonly oldFactId: string;
  readonly oldFactText: string;
  readonly score: number;
  /** The question whose answer triggered this. */
  readonly answeredQ: string;
}

/**
 * The next free `Qn` across every phase's `questions.md` in the run.
 *
 * Run-wide, not per file: `answer.ts`'s `locateQuestion` resolves an id by
 * scanning every phase of the run and taking the first hit, so two files sharing
 * an id make one of them unanswerable.
 */
export function nextQuestionId(runDir: string): string {
  let highest = 0;
  for (const phase of QUESTION_PHASES) {
    const path = join(runDir, phase, "questions.md");
    if (!existsSync(path)) continue;
    let blocks;
    try {
      blocks = parseQuestions(readFileSync(path, "utf8")).blocks;
    } catch {
      continue;   // an unreadable file cannot lend us an id; it is reported elsewhere
    }
    for (const block of blocks) {
      const n = Number.parseInt(block.id.slice(1), 10);
      if (Number.isFinite(n) && n > highest) highest = n;
    }
  }
  return `Q${String(highest + 1)}`;
}

export function raiseConflictQuestion(args: RaiseConflictArgs): RaisedConflict {
  const id = nextQuestionId(args.runDir);
  const block = renderQuestionBlock({
    id,
    title: `Which is right about ${args.area}: ${args.newFactId} or ${args.oldFactId}?`,
    metadata: {
      id, status: "open", area: args.area, asked_by: args.askedBy, asked_at: args.at, extra: [],
    },
    metadataIndex: -1,
    whyAsked:
      `answering ${args.answeredQ} recorded ${args.newFactId}, which overlaps ${args.oldFactId} `
      + `at Jaccard ${formatJaccard(args.score)} in the same area and says something different — `
      + `${args.oldFactId}: "${oneLine(args.oldFactText)}" [src: ${args.oldFactId}]`,
    whySrc: null,
    options: [
      { letter: "A", text: `${args.newFactId} is right — supersede ${args.oldFactId}` },
      { letter: "B", text: `${args.oldFactId} is right — supersede ${args.newFactId}` },
      { letter: "C", text: "Both are partly right — write the correction below" },
    ],
    answer: "",
    answerIndex: -1,
    footer: null,
    startLine: -1,
    lines: [],
  });
  appendFileSync(args.questionsPath, `\n${block}\n`, "utf8");
  return { q: id, fact: args.newFactId, conflictsWith: args.oldFactId, score: args.score };
}

/**
 * The quoted fact text, on ONE line.
 *
 * `Why asked:` is a single-line field (`WHY_RE`, `questions.ts`), so a fact whose
 * text carries a newline would split the block into lines the §2.7 parser reads as
 * loose prose — and the raise would be invisible to every reader of the file it
 * was written into. Nothing is dropped: whitespace runs collapse to one space.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
