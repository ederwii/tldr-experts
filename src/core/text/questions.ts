/**
 * `tldrx-work/<run>/<phase>/questions.md` (spec §2.7).
 *
 * The Interview artefact. Parsing is line-exact and non-destructive: a block keeps
 * its raw lines, so a hook that records one answer rewrites one metadata line and
 * appends one footer, and every other byte of the user's file survives untouched.
 */
import { parseSrcToken, type SrcToken } from "./srcToken.ts";

export const QUESTION_STATUSES = ["open", "answered", "withdrawn"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const REQUIRED_METADATA_KEYS = ["id", "status", "area", "asked_by", "asked_at"] as const;

/** Cap from spec §2.7. */
export const MAX_BLOCK_LINES = 40;

export interface QuestionMetadata {
  readonly id: string;
  readonly status: string;
  readonly area: string;
  readonly asked_by: string;
  readonly asked_at: string;
  /** Keys beyond the required five, in file order. */
  readonly extra: readonly (readonly [string, string])[];
}

export interface QuestionOption {
  readonly letter: string;
  readonly text: string;
}

export interface AnswerFooter {
  readonly answered_by: string;
  readonly answered_at: string;
  readonly fact: string;
}

export interface QuestionBlock {
  readonly id: string;
  readonly title: string;
  readonly metadata: QuestionMetadata | null;
  /** Index into `lines` of the metadata comment, or -1. */
  readonly metadataIndex: number;
  readonly whyAsked: string | null;
  readonly whySrc: SrcToken | null;
  readonly options: readonly QuestionOption[];
  /** The `[Answer]:` capture — "" when the slot is empty. */
  readonly answer: string;
  /** Index into `lines` of the `[Answer]:` line, or -1. */
  readonly answerIndex: number;
  readonly footer: AnswerFooter | null;
  /** 1-based line of the `## Q…` heading in the whole file. */
  readonly startLine: number;
  /** Raw lines of this block, heading first. */
  readonly lines: readonly string[];
}

export interface QuestionsDoc {
  /** Everything before the first `## Q…` heading, verbatim. */
  readonly preamble: readonly string[];
  readonly blocks: readonly QuestionBlock[];
  /** True when the source text ended with a newline. */
  readonly trailingNewline: boolean;
}

const HEADING_RE = /^##\s+(Q\d{1,6})\s+·\s+(.+?)\s*$/;
/**
 * Anything that LOOKS like a question heading, at any H2–H4 depth and with any
 * separator. The §2.7 parser reads exactly one shape; this one reads every shape
 * an agent has actually written, so "your file has questions the parser cannot
 * see" is a sentence the framework can say instead of silently finding none.
 *
 * Measured 2026-08-29: a real stage wrote `### Q1 — Where does state live?` and
 * `**Answer:**`, copied from `templates/questions.md`, which did not match the
 * parser it was written for. Four questions, zero parsed, gate auto-closed.
 */
const LOOSE_HEADING_RE = /^(#{2,4})\s*(Q\d{1,6})\b[ \t]*(.*)$/;
/**
 * The prose answer slot the old template taught. The emphasis markers sit on both
 * sides of the colon (`**Answer:**`), so they are stripped on both sides — reading
 * only the left pair captured a literal `**` as the answer and flipped an
 * unanswered block to `answered`.
 */
const PROSE_ANSWER_RE = /^\s*\*{0,2}Answer\*{0,2}\s*:\*{0,2}\s*(.*)$/;
/** `- **Other:** _______` — an option with no letter. It keeps its words. */
const PROSE_OTHER_RE = /^\s*-\s*(?:\*\*)?Other(?:\*\*)?\s*:?(?:\*\*)?\s*(.*)$/i;
/** The prose "why" line the old template taught. */
const PROSE_WHY_RE = /^\s*\*?(?:Why it is being asked|Why asked)\*?:?\*?\s*(.*)$/;
/** The prose option shape: `- **A)** text`. */
const PROSE_OPTION_RE = /^\s*-\s*(?:\*\*)?([A-E])\)(?:\*\*)?\s*(.*)$/;
const METADATA_RE = /^<!--\s*(.*?)\s*-->$/;
const WHY_RE = /^Why asked:\s*(.*)$/;
const OPTION_RE = /^-\s+([A-E])\)\s*(.*)$/;
const ANSWER_RE = /^\[Answer\]:[ \t]*(\S.*)$/;
const ANSWER_SLOT_RE = /^\[Answer\]:/;
const FOOTER_KEYS = ["answered_by", "answered_at", "fact"] as const;

export function parseQuestions(text: string): QuestionsDoc {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = body === "" ? [] : body.split("\n");

  const preamble: string[] = [];
  const blocks: QuestionBlock[] = [];
  let pending: { start: number; lines: string[] } | null = null;

  const close = (): void => {
    if (pending === null) return;
    blocks.push(buildBlock(pending.start + 1, pending.lines));
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (HEADING_RE.test(line)) {
      close();
      pending = { start: i, lines: [line] };
      continue;
    }
    if (pending === null) preamble.push(line);
    else pending.lines.push(line);
  }
  close();
  return { preamble, blocks, trailingNewline };
}

function buildBlock(startLine: number, lines: readonly string[]): QuestionBlock {
  const heading = HEADING_RE.exec(lines[0] ?? "");
  const id = heading?.[1] ?? "";
  const title = heading?.[2] ?? "";

  let metadata: QuestionMetadata | null = null;
  let metadataIndex = -1;
  let whyAsked: string | null = null;
  let whySrc: SrcToken | null = null;
  const options: QuestionOption[] = [];
  let answer = "";
  let answerIndex = -1;
  let footer: AnswerFooter | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const comment = METADATA_RE.exec(line);
    if (comment !== null && comment[1] !== undefined) {
      const pairs = parsePipeComment(comment[1]);
      if (metadata === null && pairs.some(([k]) => k === "id")) {
        metadata = toMetadata(pairs);
        metadataIndex = i;
      } else if (footer === null && pairs.some(([k]) => k === "answered_by")) {
        footer = toFooter(pairs);
      }
      continue;
    }
    const why = WHY_RE.exec(line);
    if (why !== null && whyAsked === null) {
      whyAsked = why[1] ?? "";
      whySrc = parseSrcToken(line);
      continue;
    }
    const option = OPTION_RE.exec(line);
    if (option !== null && option[1] !== undefined && option[2] !== undefined) {
      options.push({ letter: option[1], text: option[2] });
      continue;
    }
    if (ANSWER_SLOT_RE.test(line) && answerIndex === -1) {
      answerIndex = i;
      const captured = ANSWER_RE.exec(line);
      answer = (captured?.[1] ?? "").trim();
    }
  }

  return {
    id, title, metadata, metadataIndex, whyAsked, whySrc, options,
    answer, answerIndex, footer, startLine, lines: [...lines],
  };
}

function parsePipeComment(inner: string): (readonly [string, string])[] {
  const pairs: (readonly [string, string])[] = [];
  for (const part of inner.split("|")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    pairs.push([part.slice(0, colon).trim(), part.slice(colon + 1).trim()] as const);
  }
  return pairs;
}

function toMetadata(pairs: readonly (readonly [string, string])[]): QuestionMetadata {
  const map = new Map(pairs);
  const extra = pairs.filter(([k]) => !(REQUIRED_METADATA_KEYS as readonly string[]).includes(k));
  return {
    id: map.get("id") ?? "",
    status: map.get("status") ?? "",
    area: map.get("area") ?? "",
    asked_by: map.get("asked_by") ?? "",
    asked_at: map.get("asked_at") ?? "",
    extra,
  };
}

function toFooter(pairs: readonly (readonly [string, string])[]): AnswerFooter {
  const map = new Map(pairs);
  return {
    answered_by: map.get("answered_by") ?? "",
    answered_at: map.get("answered_at") ?? "",
    fact: map.get("fact") ?? "",
  };
}

/** Byte-exact reconstruction of a parsed document. */
export function serializeQuestions(doc: QuestionsDoc): string {
  const out: string[] = [...doc.preamble];
  for (const block of doc.blocks) out.push(...block.lines);
  const text = out.join("\n");
  return doc.trailingNewline ? `${text}\n` : text;
}

/** Canonical §2.7 rendering — used when authoring a block, not when rewriting one. */
export function renderQuestionBlock(block: QuestionBlock): string {
  const meta = block.metadata;
  const metaLine = meta === null
    ? ""
    : `<!-- ${[
        `id: ${meta.id}`, `status: ${meta.status}`, `area: ${meta.area}`,
        `asked_by: ${meta.asked_by}`, `asked_at: ${meta.asked_at}`,
        ...meta.extra.map(([k, v]) => `${k}: ${v}`),
      ].join(" | ")} -->`;
  const lines = [`## ${block.id} · ${block.title}`];
  if (metaLine !== "") lines.push(metaLine);
  if (block.whyAsked !== null) lines.push(`Why asked: ${block.whyAsked}`);
  lines.push("");
  for (const option of block.options) lines.push(`- ${option.letter}) ${option.text}`);
  lines.push("");
  lines.push(block.answer === "" ? "[Answer]:" : `[Answer]: ${block.answer}`);
  if (block.footer !== null) {
    lines.push(`<!-- answered_by: ${block.footer.answered_by} | answered_at: ${block.footer.answered_at} | fact: ${block.footer.fact} -->`);
  }
  return lines.join("\n");
}

export interface FixDefaults {
  readonly area: string;
  readonly askedBy: string;
  readonly askedAt: string;
}

/**
 * Rewrite one loose block into §2.7 grammar. **Not a word of the author's text is
 * changed** — the title, the `Why asked:` sentence, every option and any answer
 * already typed come across verbatim. What is added is the shape the parser
 * needs: the `·` heading, the metadata comment, and the `[Answer]:` slot.
 *
 * A block with no `Why asked:` gets one that names the conversion, because §2.7
 * requires the line to end with a `[src: …]` token and inventing a citation would
 * be worse than admitting where the line came from.
 */
export function renderFixedBlock(block: LooseBlock, defaults: FixDefaults): string {
  const status = block.answer === "" ? "open" : "answered";
  const lines = [
    `## ${block.id} · ${block.title === "" ? "(untitled — the prose form carried no question)" : block.title}`,
    `<!-- id: ${block.id} | status: ${status} | area: ${defaults.area} | ` +
      `asked_by: ${defaults.askedBy} | asked_at: ${defaults.askedAt} -->`,
    block.why === ""
      ? "Why asked: converted from the prose question form; the original carried no reason " +
        "[src: absent:tldrx questions lint --fix]"
      : whyLine(block.why),
    "",
  ];
  const options = block.options.length >= 2
    ? block.options
    : [...block.options, ...FALLBACK_OPTIONS.slice(block.options.length)];
  for (const option of options) lines.push(`- ${option.letter}) ${option.text}`);
  lines.push("", block.answer === "" ? "[Answer]:" : `[Answer]: ${block.answer}`);
  return lines.join("\n");
}

/**
 * §2.7 requires 2–5 options. A prose block that offered fewer keeps the ones it
 * had and is topped up with these, which say what they are.
 */
const FALLBACK_OPTIONS: readonly QuestionOption[] = [
  { letter: "A", text: "(the prose form listed no options — write the first here)" },
  { letter: "B", text: "other — write it below" },
];

/** `Why asked:` must end with a `[src: …]` token; one already there is kept. */
function whyLine(why: string): string {
  const text = `Why asked: ${why}`;
  if (parseSrcToken(text) !== null) return text;
  return `${text} [src: absent:tldrx questions lint --fix]`;
}

/**
 * Spec §2.7: a block is answered iff its metadata says `status: open` **and** the
 * `[Answer]:` line has a non-empty capture.
 */
export function detectAnswered(blocks: readonly QuestionBlock[]): readonly QuestionBlock[] {
  return blocks.filter((b) => b.metadata?.status === "open" && b.answer !== "");
}

export function openBlocks(blocks: readonly QuestionBlock[]): readonly QuestionBlock[] {
  return blocks.filter((b) => b.metadata?.status === "open");
}

/**
 * Flip `status: open` to `answered` and append the footer, changing nothing else.
 * Returns a new block; the input is untouched.
 */
export function recordAnswer(block: QuestionBlock, footer: AnswerFooter): QuestionBlock {
  const lines = [...block.lines];
  if (block.metadataIndex >= 0) {
    const line = lines[block.metadataIndex] ?? "";
    lines[block.metadataIndex] = line.replace(/(\|\s*status:\s*)open(\s*\|)/, "$1answered$2");
  }
  const footerLine = `<!-- ${FOOTER_KEYS.map((k) => `${k}: ${footer[k]}`).join(" | ")} -->`;
  const insertAt = block.answerIndex >= 0 ? block.answerIndex + 1 : lines.length;
  lines.splice(insertAt, 0, footerLine);
  const metadata = block.metadata === null ? null : { ...block.metadata, status: "answered" };
  return { ...block, lines, metadata, footer };
}

/** Replace a block in a document by id, keeping every other byte. */
export function replaceBlock(doc: QuestionsDoc, block: QuestionBlock): QuestionsDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => (b.id === block.id ? block : b)),
  };
}

/**
 * Headings that name a question the parser cannot read — `### Q1 — …`, `## Q1: …`,
 * anything but `## Qn · Title`. Returns the ids, in file order, so a caller can
 * say WHICH questions were lost.
 */
export function unreadableQuestionHeadings(text: string): readonly string[] {
  const lost: string[] = [];
  for (const line of text.split("\n")) {
    const loose = LOOSE_HEADING_RE.exec(line);
    if (loose === null || loose[2] === undefined) continue;
    if (HEADING_RE.test(line)) continue;
    lost.push(loose[2]);
  }
  return lost;
}

/** One block the linter could not read, and what it managed to salvage from it. */
export interface LooseBlock {
  readonly id: string;
  /** 1-based line of the heading. */
  readonly line: number;
  readonly title: string;
  readonly why: string;
  readonly options: readonly QuestionOption[];
  readonly answer: string;
  /** The block's raw lines, heading first — everything `--fix` has to work with. */
  readonly lines: readonly string[];
}

/**
 * Read a questions.md written in the PROSE shape the old template taught, so
 * `tldrx questions lint --fix` can convert it without changing a word of it.
 * Anything already in §2.7 grammar is skipped: this only sees what the real
 * parser could not.
 */
export function parseLooseQuestions(text: string): readonly LooseBlock[] {
  const lines = text.replace(/\n$/, "").split("\n");
  const blocks: LooseBlock[] = [];
  let pending: { id: string; line: number; title: string; body: string[] } | null = null;

  const close = (): void => {
    if (pending === null) return;
    blocks.push(toLoose(pending));
    pending = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const loose = LOOSE_HEADING_RE.exec(line);
    if (loose !== null && loose[2] !== undefined && !HEADING_RE.test(line)) {
      close();
      pending = { id: loose[2], line: i + 1, title: cleanTitle(loose[3] ?? ""), body: [line] };
      continue;
    }
    // A well-formed heading ENDS a loose block: the two shapes may be mixed.
    if (HEADING_RE.test(line)) {
      close();
      continue;
    }
    if (pending !== null) pending.body.push(line);
  }
  close();
  return blocks;
}

function toLoose(pending: { id: string; line: number; title: string; body: readonly string[] }): LooseBlock {
  let why = "";
  let answer = "";
  const options: QuestionOption[] = [];
  const LETTERS = "ABCDE";
  for (const line of pending.body) {
    const option = PROSE_OPTION_RE.exec(line);
    if (option !== null && option[1] !== undefined) {
      options.push({ letter: option[1], text: stripEmphasis(option[2] ?? "") });
      continue;
    }
    // An unlettered `- Other: ___` becomes the next letter, keeping its own words:
    // dropping it would lose the escape hatch the question offered.
    const other = PROSE_OTHER_RE.exec(line);
    if (other !== null && options.length > 0 && options.length < LETTERS.length) {
      options.push({ letter: LETTERS[options.length] ?? "E", text: `other — ${stripEmphasis(other[1] ?? "")}`.trim() });
      continue;
    }
    const answered = PROSE_ANSWER_RE.exec(line);
    if (answered !== null && answer === "") {
      answer = (answered[1] ?? "").trim();
      continue;
    }
    const asked = PROSE_WHY_RE.exec(line);
    if (asked !== null && why === "") why = stripEmphasis(asked[1] ?? "");
  }
  return {
    id: pending.id, line: pending.line, title: pending.title,
    why, options, answer, lines: [...pending.body],
  };
}

/** `— Where does state live?` / `: Where does state live?` -> the sentence. */
function cleanTitle(rest: string): string {
  return stripEmphasis(rest.replace(/^\s*[—–:·-]\s*/, ""));
}

function stripEmphasis(text: string): string {
  return text.replace(/\*\*/g, "").replace(/^\*|\*$/g, "").trim();
}

export interface FixResult {
  readonly text: string;
  /** Ids converted from the prose form, in file order. */
  readonly converted: readonly string[];
}

/**
 * Rewrite every unreadable block in a whole file, leaving readable ones and all
 * surrounding prose exactly as they are. Returns the same text when there is
 * nothing to convert, so a caller can skip the write.
 */
export function fixQuestions(text: string, defaults: FixDefaults): FixResult {
  const loose = parseLooseQuestions(text);
  if (loose.length === 0) return { text, converted: [] };
  const trailingNewline = text.endsWith("\n");
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
  const spans = loose.map((block) => ({
    block,
    start: block.line - 1,
    end: block.line - 1 + block.lines.length,
  }));

  const out: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    out.push(...lines.slice(cursor, span.start));
    out.push(...renderFixedBlock(span.block, defaults).split("\n"));
    cursor = span.end;
  }
  out.push(...lines.slice(cursor));
  const body = out.join("\n");
  return { text: trailingNewline ? `${body}\n` : body, converted: loose.map((b) => b.id) };
}

export interface QuestionIssue {
  readonly id: string;
  readonly line: number;
  readonly message: string;
}

/** Spec §2.7 validation: all six elements present, ids unique and ascending, ≤40 lines. */
export function validateQuestions(doc: QuestionsDoc, maxBlocks = Number.POSITIVE_INFINITY): readonly QuestionIssue[] {
  const issues: QuestionIssue[] = [];
  const seen = new Set<string>();
  let previous = 0;
  for (const block of doc.blocks) {
    const at = (message: string): void => { issues.push({ id: block.id, line: block.startLine, message }); };
    if (seen.has(block.id)) at(`duplicate question id ${block.id}`);
    seen.add(block.id);
    const n = Number(block.id.slice(1));
    if (n <= previous) at(`question ids must ascend (${block.id} follows Q${previous})`);
    previous = n;

    if (block.metadata === null) at("missing the metadata comment");
    else {
      for (const key of REQUIRED_METADATA_KEYS) {
        if (block.metadata[key] === "") at(`metadata is missing \`${key}\``);
      }
      if (!(QUESTION_STATUSES as readonly string[]).includes(block.metadata.status)) {
        at(`status must be one of ${QUESTION_STATUSES.join(" | ")}`);
      }
      if (block.metadata.id !== block.id) at(`metadata id ${block.metadata.id} does not match the heading`);
    }
    if (block.whyAsked === null) at("missing the `Why asked:` line");
    else if (block.whySrc === null) at("`Why asked:` must end with a [src: …] token");
    if (block.options.length < 2 || block.options.length > 5) at("expected 2–5 options, lettered A–E in order");
    else {
      const letters = block.options.map((o) => o.letter).join("");
      if (letters !== "ABCDE".slice(0, block.options.length)) at("options must be lettered A–E in order");
    }
    if (block.answerIndex === -1) at("missing the `[Answer]:` slot");
    if (block.lines.length > MAX_BLOCK_LINES) at(`block is ${block.lines.length} lines (max ${MAX_BLOCK_LINES})`);
  }
  if (doc.blocks.length > maxBlocks) {
    issues.push({ id: "", line: 0, message: `${doc.blocks.length} questions exceeds the stage cap of ${maxBlocks}` });
  }
  return issues;
}
