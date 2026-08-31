/**
 * The decision card — the shape an interrupt takes when a run stops for a person
 * (design §F.3).
 *
 * Measured 2026-08-30: an unattended run stopped on two owner questions. The host
 * did NOT show the owner the dashboard, or the `2 open question(s) in
 * 01-what/questions.md` line the framework actually prints. It hand-composed, in
 * chat, the question, the options, and a recommendation with one line of why —
 * and the owner answered both in seconds. The card is what made the interrupt
 * cheap, and hand-composing it is what the framework was making the host pay for.
 *
 * **This module renders. It reads nothing and decides nothing.** Every field it
 * prints already exists somewhere else and is gathered by
 * `src/core/run/decisionCards.ts`:
 *
 *   the question, its `Why asked:` line and its 2–5 lettered options
 *       → `questions.md`, the §2.7 grammar, parsed by the §2.7 parser. Untouched:
 *         nothing here changes what a question block may look like.
 *   the recommendation
 *       → the evidence note's optional `recommend:` front-matter array (§A.5),
 *         `{q, option, why, src}`, which Wave 2A already landed and validates.
 *
 * **A question with no recommendation renders without that line.** Not with a
 * manufactured one, and not with a placeholder: the whole value of the line is
 * that an agent stood behind it with a citation, and a card that invents one is
 * worse than a card that omits it.
 *
 * Budget and boundary fallthroughs get their own card over the same frame — the
 * measured fact, then the commands — because those two are also decisions a
 * person has to make and the frame is what makes them cheap to read.
 */

/** One lettered option, exactly as `questions.md` wrote it. */
export interface DecisionOption {
  readonly letter: string;
  /** The option's first line, verbatim. */
  readonly text: string;
}

/**
 * What the agent would do, and why. Rendered only when an evidence note actually
 * carried one for this question id.
 */
export interface DecisionRecommendation {
  /** The letter, e.g. `B`. */
  readonly option: string;
  /** One line. Empty is legal and drops the clause rather than printing a dash. */
  readonly why: string;
  /** The §2.8 citation the recommendation rests on. */
  readonly src: string;
}

export interface DecisionQuestion {
  readonly id: string;
  readonly title: string;
  /** The text after `Why asked: `, `[src: …]` token included. Null when absent. */
  readonly whyAsked: string | null;
  readonly options: readonly DecisionOption[];
  readonly recommendation: DecisionRecommendation | null;
  /** `tldrx answer Q2 "…" --run <id>` — the one thing to type. */
  readonly answerCommand: string;
}

/**
 * Which fallthrough this card is about.
 *
 * `questions` is the one design §F.3 draws; `budget` and `boundary` are the two
 * it names as "their own card shapes over the same frame"; `gate` is every other
 * reason an agent gate fell to a person, carried with its reason rather than
 * silently dropped.
 */
export const DECISION_KINDS = ["questions", "budget", "boundary", "gate"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface DecisionCard {
  readonly kind: DecisionKind;
  /** The run id, so a card pasted into chat says which run it came from. */
  readonly run: string;
  /** `<phase>/<stage>` — where the run stopped. */
  readonly gate: string;
  /** The heading under the frame, for every kind but `questions`. */
  readonly headline: string;
  /** The open questions, for `kind: "questions"`. Empty otherwise. */
  readonly questions: readonly DecisionQuestion[];
  /** The measured facts, one per line, for every kind but `questions`. */
  readonly detail: readonly string[];
  /** What a person may do about it. Rendered last, indented, verbatim. */
  readonly commands: readonly string[];
}

/** The frame's first line. `DECISION` because that is what is being asked for. */
export function decisionHeader(card: DecisionCard): string {
  return `DECISION — ${card.run} · ${card.gate}`;
}

/**
 * The card, as lines. No colour, no width-fitting and no terminal detection: this
 * goes to a terminal, into `tldrx status --json`, and into a chat message pasted
 * by a host, and all three want the same bytes.
 */
export function renderDecisionCard(card: DecisionCard): readonly string[] {
  const lines = [decisionHeader(card)];
  if (card.kind === "questions") {
    card.questions.forEach((question, index) => {
      if (index > 0) lines.push("");
      lines.push(...renderQuestion(question));
    });
    return lines;
  }
  if (card.headline !== "") lines.push(card.headline);
  for (const line of card.detail) lines.push(`  ${line}`);
  for (const command of card.commands) lines.push(`  ${command}`);
  return lines;
}

/**
 * One question: the title, the reason it was asked, every option's first line,
 * the recommendation if there is one, and the command that answers it.
 *
 * The order is the order the host used in chat and the order the design draws:
 * what is being asked, why, what the choices are, what the agent would pick, how
 * to say so. The recommendation sits BELOW the options on purpose — a reader who
 * disagrees has already read the alternatives by the time they reach it.
 */
export function renderQuestion(question: DecisionQuestion): readonly string[] {
  const lines = [`${question.id} · ${question.title}`];
  if (question.whyAsked !== null) lines.push(`  Why asked: ${question.whyAsked}`);
  for (const option of question.options) lines.push(`  ${option.letter}) ${option.text}`);
  const recommendation = renderRecommendation(question.recommendation);
  if (recommendation !== null) lines.push(recommendation);
  lines.push(`  ${question.answerCommand}`);
  return lines;
}

/**
 * `Recommends B — one screen, correct for everyone [src: 01-what/handoff.md:22]`
 *
 * The `why` clause is dropped when the note left it empty, so the line degrades to
 * design §F.3's own `Recommends B [src: …]` rather than to a dangling dash. Null
 * when there is no recommendation at all — the caller omits the line entirely.
 */
export function renderRecommendation(recommendation: DecisionRecommendation | null): string | null {
  if (recommendation === null) return null;
  const why = recommendation.why.trim();
  const head = `Recommends ${recommendation.option}${why === "" ? "" : ` — ${why}`}`;
  return recommendation.src.trim() === "" ? head : `${head} [src: ${recommendation.src.trim()}]`;
}
