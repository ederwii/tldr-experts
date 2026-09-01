/**
 * AI-DLC's own question format, which is NOT tldrx's §2.7 format.
 *
 *   ## Q1. What is the core problem this initiative solves?
 *   …prose and lettered options…
 *   [Answer]: D
 *
 * Heading is `## Q<n>. <text>` (a full stop, not the `·` §2.7 uses) and there is no
 * metadata comment. Answered means the `[Answer]:` line has a non-empty capture —
 * the same test §2.7 applies, which is the one thing the two formats share.
 */

export interface AidlcOption {
  /** The uppercase letter as written, e.g. `C` or `X`. */
  readonly letter: string;
  readonly text: string;
}

export interface AidlcQuestion {
  readonly id: string;
  readonly title: string;
  /** "" when the slot is empty — that block is unanswered and gets dropped. */
  readonly answer: string;
  /**
   * The lettered options the block offered, in file order. Empty for a block that
   * offered none — an open question answered in prose.
   */
  readonly options: readonly AidlcOption[];
  /** 1-based line of the `## Q<n>.` heading. */
  readonly line: number;
}

const HEADING_RE = /^##\s+(Q\d{1,6})[.:)]?\s+(.+?)\s*$/;
const ANSWER_RE = /^\[Answer\]:[ \t]*(\S.*)$/;
const ANSWER_SLOT_RE = /^\[Answer\]:/;
/**
 * `- A. Confirmed — …`, AI-DLC's own option bullet. Uppercase only and a space
 * REQUIRED after the punctuation, so `- E.g. some prose` stays prose: a loose
 * pattern here would mint an option `E` out of a sentence and then "resolve" a
 * letter into it.
 */
const OPTION_RE = /^\s*[-*]\s*(?:\*\*)?([A-Z])[.):]\s+(?:\*\*)?\s*(\S.*?)\s*$/;
/** An `[Answer]:` that is nothing but an option letter, with or without its dot. */
const LETTER_ANSWER_RE = /^([A-Za-z])[.):]?$/;

export function parseAidlcQuestions(text: string): readonly AidlcQuestion[] {
  const lines = text.split("\n");
  const out: AidlcQuestion[] = [];
  let open:
    | { id: string; title: string; line: number; answer: string; options: AidlcOption[] }
    | null = null;

  const close = (): void => {
    if (open !== null) {
      out.push({ id: open.id, title: open.title, answer: open.answer, options: open.options, line: open.line });
    }
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const heading = HEADING_RE.exec(raw);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      close();
      open = { id: heading[1], title: heading[2], line: i + 1, answer: "", options: [] };
      continue;
    }
    if (open === null) continue;
    if (raw.startsWith("## ")) {
      close();
      continue;
    }
    if (open.answer === "" && ANSWER_SLOT_RE.test(raw)) {
      open.answer = (ANSWER_RE.exec(raw)?.[1] ?? "").trim();
      continue;
    }
    const option = OPTION_RE.exec(raw);
    if (option?.[1] !== undefined && option[2] !== undefined) {
      open.options.push({ letter: option[1], text: option[2] });
    }
  }
  close();
  return out;
}

export function isAnswered(question: AidlcQuestion): boolean {
  return question.answer !== "";
}

/**
 * What the answer SAYS, not what it points at (gh #18).
 *
 * AI-DLC records a chosen option as its bare letter — `[Answer]: C`. Stored as
 * written, the fact reads "<question> — C", which is a pointer into a file the
 * import does not own: two facts became unreadable once aidlc was uninstalled and
 * the source went with it (2026-08-30/31 pilots). The interview flow has always
 * resolved a letter to the option's own words before recording
 * (`interview/reply.ts:32-37`); this is the same rule on the import path, and it
 * is the same rule for the same reason — a fact every later run cites has to be
 * legible on its own.
 *
 * A letter with no option behind it is returned as typed. Nothing is invented,
 * and nothing is dropped: `interview/reply.ts` can re-prompt a person, and this
 * cannot.
 */
export function answerText(question: AidlcQuestion): string {
  const letter = LETTER_ANSWER_RE.exec(question.answer)?.[1];
  if (letter === undefined) return question.answer;
  const option = question.options.find((o) => o.letter === letter.toUpperCase());
  return option === undefined ? question.answer : option.text;
}
