/**
 * What one line typed at an interview prompt means.
 *
 * Deliberately small and deliberately literal. The one rule that matters: an
 * answer is never *guessed*. A letter that has no option behind it is not silently
 * turned into the text "C" — that would put a meaningless fact in `facts.yml`,
 * which every future run then cites (concept §1.2). It is reported and skipped.
 */
import type { QuestionBlock } from "../text/questions.ts";

export type Reply =
  /** Record `text`. `option` is the letter it came from, or null for free text. */
  | { readonly kind: "answer"; readonly text: string; readonly option: string | null }
  | { readonly kind: "skip" }
  | { readonly kind: "quit" }
  /** A letter A–E this question does not offer. */
  | { readonly kind: "unknown-option"; readonly letter: string }
  /** Input ran out — the remaining questions stay open. */
  | { readonly kind: "eof" };

const LETTER_RE = /^[A-Ea-e]$/;

export function interpret(line: string | null, block: QuestionBlock): Reply {
  if (line === null) return { kind: "eof" };
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "skip" };

  const lower = trimmed.toLowerCase();
  if (lower === "s" || lower === "skip") return { kind: "skip" };
  if (lower === "q" || lower === "quit") return { kind: "quit" };

  if (LETTER_RE.test(trimmed)) {
    const letter = trimmed.toUpperCase();
    const option = block.options.find((o) => o.letter === letter);
    if (option === undefined) return { kind: "unknown-option", letter };
    return { kind: "answer", text: option.text, option: letter };
  }
  return { kind: "answer", text: trimmed, option: null };
}

/**
 * `--yes-to-defaults`. `[assumption]` — nothing in the spec says which option is
 * the default, so it is **A**, the first one the question lists, and a question
 * with no options is skipped rather than answered with something invented.
 */
export function defaultReply(block: QuestionBlock): Reply {
  const first = block.options[0];
  if (first === undefined) return { kind: "skip" };
  return { kind: "answer", text: first.text, option: first.letter };
}
