/**
 * The `[src: …]` grammar, rendered for the agent that has to write it (gh #77).
 *
 * Run `260830-ordering-inventory` lost three story attempts to one rejection.
 * The check said "no `[src: …]`" — the symptom — and the grammar it was enforcing
 * was written down in exactly one place the writer could not read: the regexes in
 * `srcToken.ts`. The host guessed twice, got it wrong twice, and finally opened
 * `dist/tldrx.js` to extract the three rules that mattered: the token must END
 * its line, a nested `]` truncates the match, and a `cmd` source needs the real
 * `→` and not ASCII `->`.
 *
 * This is the #35 answer applied to that: state the contract, and state it by
 * GENERATING it. The kinds come from `SRC_KINDS`, the patterns from
 * `SRC_PATTERNS` (printed through `readableSource`), the rules and their worked pairs
 * from `SRC_RULES`, and the document-level rules from `BULLET_RULE`,
 * `EMPTY_SECTION_RULE` and `BULLET_CAP_RULE` — the same strings the deny messages
 * quote. Nothing here is prose about a validator; it is the validator's own
 * constants, laid out.
 *
 * The guarantee is behavioural, not textual: `test/src-grammar.test.ts` pushes
 * every `bad` back through `diagnoseSrcToken` and every `good` through
 * `parseSrcToken`. Loosen a regex without touching its rule and the suite goes
 * red — a doc that has stopped being true cannot ship quietly.
 */
import {
  SRC_KINDS, SRC_PATTERNS, SRC_RULES, SRC_SEPARATOR, readableSource,
} from "./srcToken.ts";
import {
  BULLET_CAP_RULE, BULLET_RULE, EMPTY_SECTION_RULE, HANDOFF_SECTIONS, noneBullet,
} from "./handoff.ts";

/** The H2 the facilitator splices this under, in `stage.md`. */
export const SRC_GRAMMAR_HEADING = "Citation grammar — `[src: …]`";

/** One `src` kind, with the pattern that reads it and a token that parses. */
interface KindRow {
  readonly kind: string;
  readonly shape: string;
  readonly example: string;
}

/**
 * `SRC_KINDS` in the reader's own order, each with the pattern it is read by.
 *
 * `Record<SrcKind, …>` is load-bearing exactly as it is in `schemaContract.ts`:
 * add a kind to `SRC_KINDS` and this file stops compiling until the new kind has
 * a shape and an example here.
 */
const KINDS: Readonly<Record<(typeof SRC_KINDS)[number], Omit<KindRow, "kind">>> = {
  file: { shape: "`[repo:]path:line[-line]`", example: "api:src/Selector.ts:241" },
  doc: { shape: "`https://` + a non-space URL", example: "https://example.com/spec" },
  answer: { shape: `\`Q<n>\` (${readableSource(SRC_PATTERNS.answer)})`, example: "Q3" },
  fact: { shape: `\`F<nnn>\` (${readableSource(SRC_PATTERNS.fact)})`, example: "F102" },
  cmd: { shape: `\`$ <command> → exit <n>\` (${readableSource(SRC_PATTERNS.cmd)})`, example: "$ bun test → exit 0" },
  graph: { shape: "`graph:<node id>`", example: "graph:hunt-engine" },
  absent: { shape: "`absent:<the path you looked at>`", example: "absent:docs/retention.md" },
  aidlc: {
    shape: `\`aidlc:<file>:<line>\` or \`aidlc:<file>#Q<n>\` (${readableSource(SRC_PATTERNS.aidlcLine)})`,
    example: "aidlc:intents/260821/design.md:14",
  },
};

/** A table cell: a raw `|` would open a column, so it is escaped. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * The section spliced into every stage whose `checks:` include `claim-sources`
 * and whose outputs include markdown.
 *
 * Roughly 7.5 KB against a stage budget measured in dollars — and it sits in the
 * most-stable part of the prompt, so it is cached. The alternative it replaces is
 * three refused attempts at one.
 */
export function renderSrcGrammarContract(): string {
  return [
    "`claim-sources` reads every `.md` this stage declares, at WRITE time (a hook that refuses",
    "the edit) and again at the gate. What follows is GENERATED from that reader's own patterns",
    "and constants, so it is the grammar itself, not a description of it.",
    "",
    "### The token",
    "",
    `A citation is \`[src: <src>]\` — the marker, a colon, ONE space, the sources, \`]\`. Several`,
    `sources are joined by \`${SRC_SEPARATOR}\` inside one token. The reader matches it with`,
    "",
    `    /${readableSource(SRC_PATTERNS.trailingToken)}/`,
    "",
    "Two things follow from that regex, and they are what cost run `260830-ordering-inventory`",
    "three attempts:",
    "",
    "- the `$` anchor means the token must be the **last thing on the line**. A `[src: …]` written",
    "  mid-sentence is not seen at all — the line reads as an unsourced claim.",
    `- \`[^\\]]*\` means a \`]\` **inside** the token ends it early and the match fails. A citation that`,
    "  quotes an array or a list loses its whole token.",
    "",
    "Closing punctuation may follow the `]` — a trailing backtick, quote, paren or full stop is",
    "fine, because the reader strips this off the end first. WORDS after it are not.",
    "",
    `    ${readableSource(SRC_PATTERNS.trailingClosers)}`,
    "",
    "### The sources",
    "",
    "| kind | shape | a token that parses |",
    "| --- | --- | --- |",
    ...SRC_KINDS.map((kind) => {
      const row = KINDS[kind];
      return `| \`${kind}\` | ${cell(row.shape)} | \`[src: ${cell(row.example)}]\` |`;
    }),
    "",
    "### The rules, and what each one refuses",
    "",
    "Every rejection you can get on this path names one of these ids. Under each one: the pattern",
    "that enforces it, a line the reader refuses, and the same claim written so it passes.",
    "",
    // The pattern goes in an indented block, never in an inline code span: the
    // closer set contains a literal backtick, which would open a span of its own
    // and mangle the rest of the line.
    ...SRC_RULES.flatMap((rule) => [
      `**\`${rule.id}\`** — ${rule.rule}.`,
      "",
      `    enforced by: ${rule.enforcedBy.join("   ·   ")}`,
      `    refused:     ${rule.bad}`,
      `    accepted:    ${rule.good}`,
      "",
    ]),
    "### The document rules",
    "",
    `A \`handoff.md\` carries four H2 sections, in this order: ${HANDOFF_SECTIONS.join(", ")}.`,
    "",
    `- ${BULLET_RULE}.`,
    `- ${EMPTY_SECTION_RULE}. A section with genuinely nothing in it is written as one item:`,
    `  \`${noneBullet("<what you looked at>")}\`.`,
    `- ${BULLET_CAP_RULE}.`,
    `- \`$ <command> → exit <n>\` is legal in \`${HANDOFF_SECTIONS[3]}\` and nowhere else, and the`,
    "  command must be one of `.tldrx/workspace.yml`'s, verbatim.",
    "",
    "Every OTHER `.md` this stage declares carries only the second half of that: a bullet may be",
    "prose, but a `[src: …]` it does write must parse by the rules above and must resolve.",
    "",
    "A soft-wrapped bullet is joined before it is read, so the token may sit on the continuation",
    "line — the rule is about the ITEM's last element, not the file's line width.",
  ].join("\n");
}
