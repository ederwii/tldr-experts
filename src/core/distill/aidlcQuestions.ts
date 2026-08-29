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

export interface AidlcQuestion {
  readonly id: string;
  readonly title: string;
  /** "" when the slot is empty — that block is unanswered and gets dropped. */
  readonly answer: string;
  /** 1-based line of the `## Q<n>.` heading. */
  readonly line: number;
}

const HEADING_RE = /^##\s+(Q\d{1,6})[.:)]?\s+(.+?)\s*$/;
const ANSWER_RE = /^\[Answer\]:[ \t]*(\S.*)$/;
const ANSWER_SLOT_RE = /^\[Answer\]:/;

export function parseAidlcQuestions(text: string): readonly AidlcQuestion[] {
  const lines = text.split("\n");
  const out: AidlcQuestion[] = [];
  let open: { id: string; title: string; line: number; answer: string } | null = null;

  const close = (): void => {
    if (open !== null) out.push({ id: open.id, title: open.title, answer: open.answer, line: open.line });
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const heading = HEADING_RE.exec(raw);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      close();
      open = { id: heading[1], title: heading[2], line: i + 1, answer: "" };
      continue;
    }
    if (open === null) continue;
    if (raw.startsWith("## ")) {
      close();
      continue;
    }
    if (open.answer === "" && ANSWER_SLOT_RE.test(raw)) {
      open.answer = (ANSWER_RE.exec(raw)?.[1] ?? "").trim();
    }
  }
  close();
  return out;
}

export function isAnswered(question: AidlcQuestion): boolean {
  return question.answer !== "";
}
