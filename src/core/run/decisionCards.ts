/**
 * Gathering the facts a decision card renders (design §F.3).
 *
 * The card itself is `src/core/ui/decisionCard.ts` and is pure. This is the half
 * that touches disk, and it reads exactly two files, both of which already exist:
 *
 *   `<phase>/questions.md`            the §2.7 question blocks — id, title,
 *                                     `Why asked:` + its `[src: …]`, 2–5 options.
 *                                     Read with the §2.7 parser. **Nothing here
 *                                     changes the questions grammar**, which is
 *                                     exact, hard-won and not worth touching.
 *   the block's own `Recommended:`   the OPTIONAL §2.7 line the asker writes, read
 *                                     by the same §2.7 parser (gh #203).
 *   the evidence note's `recommend:`  `{q, option, why, src}` per open question,
 *                                     from `.agent/<stage>/evidence.md` or, once
 *                                     a gate was signed, the committed copy at
 *                                     `<phase>/gate-evidence/<stage>.md`.
 *
 * The note is read with `parseEvidence`, not `validateEvidence`: this is a
 * rendering path, it has no `SrcContext` to hand and it must never turn a report
 * into a check. A note that does not parse simply contributes no recommendation —
 * which is the same outcome as a note that carried none, and the right one. The
 * card **never manufactures a recommendation**; the whole value of the line is
 * that an agent stood behind it with a citation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBlocks, parseQuestions, type QuestionBlock } from "../text/questions.ts";
import { parseEvidence, type EvidenceRecommendation } from "../text/evidence.ts";
import { evidencePath, gateEvidencePath } from "../facilitator/paths.ts";
import type {
  DecisionCard, DecisionOption, DecisionQuestion, DecisionRecommendation,
} from "../ui/decisionCard.ts";

/** Everything a card needs that is not on disk. */
export interface CardContext {
  readonly runDir: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly stageId: string;
}

/**
 * The open questions of the cursor phase, as a card — or null when there are
 * none.
 *
 * Null rather than an empty card on purpose: "there is nothing to decide" is a
 * different message from "here is the decision", and a caller that printed an
 * empty frame would be saying the first with the shape of the second.
 */
export function questionsCard(ctx: CardContext): DecisionCard | null {
  const blocks = openQuestionBlocks(join(ctx.runDir, ctx.phaseId, "questions.md"));
  if (blocks.length === 0) return null;
  const recommendations = readRecommendations(ctx);
  return {
    kind: "questions",
    run: ctx.runId,
    gate: `${ctx.phaseId}/${ctx.stageId}`,
    headline: "",
    questions: blocks.map((block) => toQuestion(block, ctx.runId, recommendations)),
    detail: [],
    commands: [],
  };
}

/** `budget.raised` / `budget.blocked` landed in this stage's window (design §A.2). */
export function budgetCard(ctx: CardContext, detail: string, money: Money | null): DecisionCard {
  return {
    kind: "budget",
    run: ctx.runId,
    gate: `${ctx.phaseId}/${ctx.stageId}`,
    questions: [],
    headline: "Budget — a person moved the ceiling while this stage ran",
    detail: money === null
      ? [detail]
      : [`$${money.spentUsd.toFixed(2)} spent of $${money.ceilingUsd.toFixed(2)}`, detail],
    commands: [
      `tldrx budget show --run ${ctx.runId}`,
      approveCommand(ctx.runId),
      rejectCommand(ctx.runId),
    ],
  };
}

/** Money as the card states it: two numbers off `budget.yml`, neither computed here. */
export interface Money {
  readonly spentUsd: number;
  readonly ceilingUsd: number;
}

/**
 * Work landed outside the surface the run declared (design §A.4).
 *
 * The offending paths are already named in the condition's own detail, so it is
 * carried verbatim rather than scraped and re-rendered: a second parser over a
 * string the first one built is how two readings of one fact start.
 *
 * The first command is a PLACEHOLDER — `<id> <path>` and not a real story id and
 * path — and that is forced, not lazy: this function holds `runId`, `phaseId`,
 * `stageId` and one opaque detail string, so there is no story in scope to name,
 * and scraping one out of `detail` is the second parser the paragraph above
 * refuses. What changed in #171 is that the line names a real VERB: it used to
 * say "add the path to a story's `touches:`", which is precisely the hand edit
 * `cli/commands/story.ts` forbids by design.
 *
 * `--for-fix` gets a line of its OWN rather than a clause inside the widen line,
 * because it is a different command and the widen line is pinned byte-for-byte.
 * Measured (Task 4, this wave): a Build auto gate that refuses on condition 7
 * leaves its stories `done`, and `widenStory` refuses a `done` story — "its
 * evidence was written against the surface it DECLARED". So the advice as it
 * stood led an operator straight into a refusal on the commonest path there is.
 *
 * `extra` is carried findings nobody's story owns (#171), HANDED in by the
 * caller from `build/carriedRows.ts` — this card still scrapes nothing, and it
 * is an ADDITION to a card that was already going to print, never the reason one
 * prints. The default `[]` keeps every two-argument call byte-identical.
 */
export function boundaryCard(
  ctx: CardContext,
  detail: string,
  extra: readonly string[] = [],
): DecisionCard {
  return {
    kind: "boundary",
    run: ctx.runId,
    gate: `${ctx.phaseId}/${ctx.stageId}`,
    questions: [],
    headline: "Boundary — the epic changed paths nobody scoped",
    detail: [detail, ...extra],
    commands: [
      "tldrx story widen <id> <path> --note \"<why>\" \u2014 or cite the path in a handoff, then re-run the stage",
      "tldrx story reopen <id> --for-fix --note \"<the defect>\" \u2014 first, when the story is already "
        + "`done`: widening finished work is refused",
      approveCommand(ctx.runId),
      rejectCommand(ctx.runId),
    ],
  };
}

/** Every other reason a gate fell to a person, carried with its reason. */
export function gateCard(ctx: CardContext, headline: string, detail: readonly string[]): DecisionCard {
  return {
    kind: "gate",
    run: ctx.runId,
    gate: `${ctx.phaseId}/${ctx.stageId}`,
    questions: [],
    headline,
    detail,
    commands: [
      approveCommand(ctx.runId),
      rejectCommand(ctx.runId),
    ],
  };
}

/** One fallthrough, as the agent gate reports it. Structural, so no import cycle. */
export interface CardTrigger {
  readonly trigger: string;
  readonly detail: string;
}

/**
 * The ONE card for a set of fallthroughs, in the order design §A.2 lists them.
 *
 * An open question outranks everything: it is the only fallthrough where a person
 * has something to *decide* rather than something to *judge*, and it is the one
 * tonight's host actually hit. Boundary next (work nobody scoped), then a budget
 * event, then everything else as one gate card naming its reasons.
 */
export function cardForTriggers(
  ctx: CardContext,
  triggers: readonly CardTrigger[],
  money: Money | null = null,
  /**
   * Carried findings nobody's story owns, computed by the caller with
   * `build/carriedRows.ts` (#171). They reach the boundary card only, and only
   * when a boundary trigger was already going to draw one.
   *
   * A THUNK, not an array (#171, fix round 2). The derivation is a directory walk
   * plus a fix-list parse per story, on a gate path that previously did neither,
   * and four of the five branches below never look at it. Deferring the CALL
   * moves the I/O behind the branch that uses it without moving the judgement:
   * the caller still owns the derivation and this card still scrapes nothing.
   */
  carried: () => readonly string[] = () => [],
): DecisionCard | null {
  if (triggers.length === 0) return null;
  if (triggers.some((t) => t.trigger === "questions")) {
    const card = questionsCard(ctx);
    // A `questions` trigger with nothing open means the file does not parse — the
    // condition says so in its own words, so fall through to the gate card rather
    // than print a frame with no question in it.
    if (card !== null) return card;
  }
  const boundary = triggers.find((t) => t.trigger === "boundary");
  if (boundary !== undefined) return boundaryCard(ctx, boundary.detail, carried());
  const budget = triggers.find((t) => t.trigger === "budget-event");
  if (budget !== undefined) return budgetCard(ctx, budget.detail, money);
  return gateCard(
    ctx,
    `Gate — ${String(triggers.length)} reason(s) an agent gate could not close this`,
    triggers.map((t) => `${t.trigger}: ${t.detail}`),
  );
}

// --- reading -----------------------------------------------------------------

/**
 * The one thing a person types to answer a question.
 *
 * Exported because gh #59's `questions cards` prints the same line on its own
 * card, and two spellings of the command a person is told to run is exactly the
 * kind of drift that ends with somebody typing a flag the CLI does not take.
 */
export function answerCommand(questionId: string, runId: string): string {
  return `tldrx answer ${questionId} "…" --run ${runId}`;
}

/**
 * The two things a person types at a GATE — the same rule `answerCommand` follows.
 *
 * Every card here already spelled them inline, and #197 added two more callers: the
 * `gate.requested` notification and the parked heartbeat under `--wait-gates`. A
 * notification exists to be typed off a phone, so the line it carries and the line the
 * terminal prints have to be the same bytes; four literals in four files are how they
 * stop being.
 */
export function approveCommand(runId: string): string {
  return `tldrx approve --run ${runId}`;
}

export function rejectCommand(runId: string): string {
  return `tldrx reject --run ${runId} --note "<why>"`;
}

/**
 * PRECEDENCE, stated once and referenced from spec §2.17 and §2.18 (gh #203):
 *
 * **An evidence note's `recommend:` entry wins over the question block's own
 * `Recommended:` line for the same question id — the note was written and validated
 * against a `[src:]` context at the gate, while the block's line is the asker's
 * proposal — and a question with neither renders no recommendation at all.**
 *
 * The last clause is the old rule, unchanged: this card never manufactures one.
 */
function toQuestion(
  block: QuestionBlock,
  runId: string,
  recommendations: ReadonlyMap<string, EvidenceRecommendation>,
): DecisionQuestion {
  const recommended = recommendations.get(block.id);
  return {
    id: block.id,
    title: block.title,
    whyAsked: block.whyAsked,
    options: block.options.map(firstLine),
    recommendation: recommended !== undefined
      ? toRecommendation(recommended)
      : block.recommended === null
        ? null
        : { option: block.recommended.option, why: block.recommended.why, src: block.recommended.src },
    answerCommand: answerCommand(block.id, runId),
  };
}

/**
 * An option's FIRST line. §2.7 makes an option one bullet on one line, so this is
 * a no-op on every well-formed block — and a card is a summary, so a block that
 * somehow carried more is trimmed here rather than allowed to unbalance the frame.
 */
function firstLine(option: { readonly letter: string; readonly text: string }): DecisionOption {
  return { letter: option.letter, text: option.text.split("\n")[0] ?? "" };
}

function toRecommendation(entry: EvidenceRecommendation): DecisionRecommendation {
  return { option: entry.option, why: entry.why, src: entry.src };
}

function openQuestionBlocks(path: string): readonly QuestionBlock[] {
  if (!existsSync(path)) return [];
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks);
  } catch {
    return [];
  }
}

/**
 * `recommend:` entries by question id, from whichever evidence note exists.
 *
 * The scratch note is preferred over the committed one: the scratch copy is what
 * the agent wrote most recently, and the committed copy only exists once a gate
 * was already signed — at which point it is a record, not a proposal. A duplicate
 * `q:` keeps the FIRST entry, so a note cannot make one question recommend twice.
 */
export function readRecommendations(ctx: CardContext): ReadonlyMap<string, EvidenceRecommendation> {
  const out = new Map<string, EvidenceRecommendation>();
  const paths = [
    evidencePath(ctx.runDir, ctx.stageId),
    gateEvidencePath(ctx.runDir, ctx.phaseId, ctx.stageId),
  ];
  for (const path of paths) {
    const text = readOrNull(path);
    if (text === null) continue;
    const front = parseEvidence(text).front;
    if (front === null) continue;
    for (const entry of front.recommend) {
      if (!out.has(entry.q)) out.set(entry.q, entry);
    }
    if (out.size > 0) return out;
  }
  return out;
}

function readOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
