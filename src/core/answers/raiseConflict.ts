/**
 * The §2.7 question a detected contradiction raises (#169).
 *
 * It RAISES; it never refuses. The answer stands, the command exits 0, and the
 * disagreement becomes a block a person can answer — the issue's own words,
 * "Raise, do not refuse". A refusal here could deadlock an unattended run over a
 * lexical near-match nobody has measured a false-positive rate for.
 *
 * ## And the block is `advisory: true`, because an open question is not free
 *
 * Exiting 0 is not the whole of "it does not block". Until this key existed, the
 * question minted here was an ordinary `status: open` block, and `autoGate`'s
 * `questions` condition counts those — so the raise stopped the next auto gate for
 * a human. That is the same unattended deadlock the paragraph above says a refusal
 * would cause, arriving by a different door, and on the same unmeasured near-match.
 * `isAdvisory` (`text/questions.ts`) is the one predicate, and every reader that
 * COUNTS an open question goes through it: the auto gate, `runNext`'s
 * `awaiting_answer` branch, the `skip_if: questions<=N` counter and `waiting.ts`'s
 * "what is this run waiting on" — the last three via `skipIf.blockingQuestionIds`.
 * The readers that LIST — the run close, `tldrx questions`, the decision cards,
 * `replay`, the status line — all go on naming the block, because declining to stop
 * for a question is not the same as hiding it, and the gate's own detail names what
 * it did not count.
 *
 * The enumeration above is the corrected one: until the wave's final review it read
 * "the gate is its ONE reader", and three counting readers were neither listed nor
 * advisory-aware. Nothing parked in practice — nothing in `src/` ever wrote
 * `awaiting_answer` and no shipped preset uses `skip_if` — so the guard held for a
 * reason other than the one stated, which is the failure this paragraph exists to
 * stop repeating.
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
 * WHO ANNOUNCES IT. Both capture routes RAISE — the block, the `conflicts_with`
 * link and the `fact.conflict_raised` event are written whether the answer came
 * through `tldrx answer` or through the `answer-capture` hook. Only the CLI path
 * PRINTS a sentence about it (`cli/commands/answer.ts`); the hook records the
 * fact and the question block and says nothing, so on that route the raise is
 * read off `questions.md` and `events.jsonl`.
 *
 * DATA in, per AGENTS §12: paths, ids and strings. No `ctx`, no session, no store.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVISORY_KEY, parseQuestions, renderQuestionBlock } from "../text/questions.ts";
import { QUESTION_PHASES } from "../run/questionCards.ts";
import { formatJaccard } from "../facts/findDuplicate.ts";

/**
 * `asked_by` on a block the FRAMEWORK raised.
 *
 * Never the operator: they answered a question, and tldrx detected the overlap and
 * minted this one. `questionCards.ts` puts this value straight onto the decision
 * card as the asker, so their name here shows them as having asked a question they
 * never asked — the "absent-with-reason, never invented" rule pointed at
 * attribution. The sibling that mints machine questions off the very same
 * `conflictOf` derivation already does this: `renderDistill.ts` writes
 * `asked_by: distill`, and `init/questions.ts` writes `asked_by: facilitator`.
 */
export const RAISED_BY = "tldrx";

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

/**
 * Mint the block and append it. Returns what was raised, for the caller to log and print.
 *
 * The `QuestionBlock` below is filled with sentinels — `metadataIndex: -1`,
 * `answerIndex: -1`, `startLine: -1`, `lines: []`, `whySrc: null` — purely to
 * satisfy the parameter type. `renderQuestionBlock` reads NONE of them (they are
 * the parsed-position fields, meaningless for a block that has never been in a
 * file). They mean nothing; a narrower authoring type would be a change to
 * `text/questions.ts` that nothing else in this wave needs.
 */
export function raiseConflictQuestion(args: RaiseConflictArgs): RaisedConflict {
  const id = nextQuestionId(args.runDir);
  const block = renderQuestionBlock({
    id,
    title: `Which is right about ${args.area}: ${args.newFactId} or ${args.oldFactId}?`,
    metadata: {
      id, status: "open", area: args.area, asked_by: RAISED_BY, asked_at: args.at,
      // The one thing that keeps this advisory rather than blocking. See
      // `isAdvisory` for the four readers that count open questions and
      // therefore honour it, and the ones that only list and do not.
      extra: [[ADVISORY_KEY, "true"]],
    },
    metadataIndex: -1,
    // Says exactly what the number measures. The score compares this question's
    // TITLE with the old fact's WHOLE TEXT, so it reads 1.00 whenever the title's
    // tokens are a subset of the fact's — which is the common case, since the fact
    // IS "<title> — <answer>". "overlaps F002 at Jaccard 1.00 … and says something
    // different" therefore read as a contradiction in terms; measured in review on
    // a real two-clash sweep, where the discriminating token (`SQS`) had been
    // dropped by `MIN_TOKEN_LENGTH` anyway.
    whyAsked:
      `answering ${args.answeredQ} recorded ${args.newFactId}, which overlaps ${args.oldFactId}'s `
      + `text at Jaccard ${formatJaccard(args.score)} on the question's wording, in the same area, `
      + `and answers it differently — ${args.oldFactId}: "${oneLine(args.oldFactText)}" `
      + `[src: ${args.oldFactId}]`,
    whySrc: null,
    options: [
      { letter: "A", text: `${args.newFactId} is right — supersede ${args.oldFactId}` },
      { letter: "B", text: `${args.oldFactId} is right — supersede ${args.newFactId}` },
      { letter: "C", text: "Both are partly right — write the correction below" },
    ],
    // The framework raised this one, so it has nothing to recommend: the whole
    // question is which of two recorded facts a PERSON stands behind (#203).
    recommended: null,
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
