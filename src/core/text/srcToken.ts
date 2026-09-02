/**
 * The `[src: …]` grammar (spec §2.8) — tokenizer and validator.
 *
 *   token  := "[src: " src ("; " src)* "]"
 *   src    := file | doc | ans | fact | cmd | graph | absent
 *   file   := [repo ":"] path ":" line ["-" line]
 *   doc    := "https://" nonspace+
 *   ans    := "Q" digit+
 *   fact   := "F" digit{3,6}
 *   cmd    := "$ " command " → exit " digit+
 *   graph  := "graph:" nodeid
 *   absent := "absent:" path ["#" needle]   # "I looked HERE"; the needle is what for
 *   aidlc  := "aidlc:" path (":" line | "#" "Q" digit+)   # spec §6 `[assumption]`
 *
 * Everything here is string slicing plus a handful of tiny anchored regexes, so a
 * hook can validate a 256 KB handoff well inside its 50 ms budget (spec §0).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { parseYaml } from "../yaml.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";

export const SRC_KINDS = ["file", "doc", "answer", "fact", "cmd", "graph", "absent", "aidlc"] as const;
export type SrcKind = (typeof SRC_KINDS)[number];

export type SrcRef =
  | { readonly kind: "file"; readonly raw: string; readonly repo: string | null; readonly path: string; readonly startLine: number; readonly endLine: number | null }
  | { readonly kind: "doc"; readonly raw: string; readonly url: string }
  | { readonly kind: "answer"; readonly raw: string; readonly q: string }
  | { readonly kind: "fact"; readonly raw: string; readonly id: string }
  | { readonly kind: "cmd"; readonly raw: string; readonly command: string; readonly exitCode: number }
  | { readonly kind: "graph"; readonly raw: string; readonly node: string }
  | { readonly kind: "absent"; readonly raw: string; readonly path: string; readonly needle: string | null }
  | { readonly kind: "aidlc"; readonly raw: string; readonly path: string; readonly line: number | null; readonly q: string | null };

export interface SrcParseError {
  readonly raw: string;
  readonly message: string;
  /**
   * The rule that refused it (gh #77).
   *
   * A message is free to describe the symptom; the id says which RULE fired, and
   * `SRC_RULES` turns that id into the rule's own words plus a line that would
   * have passed. Run `260830-ordering-inventory` lost three story attempts to a
   * rejection that had only the symptom, and the host ended up reading
   * `dist/tldrx.js` to recover the grammar.
   */
  readonly rule: SrcRuleId;
}

export interface SrcToken {
  /** The whole `[src: …]` run, verbatim. */
  readonly raw: string;
  readonly refs: readonly SrcRef[];
  readonly errors: readonly SrcParseError[];
}

/** Context a `src` is resolved against. Everything is optional-by-emptiness. */
export interface SrcContext {
  /** Absolute workspace root; the first base a bare `file` path resolves against. */
  readonly root: string;
  /** workspace.yml repo name -> path relative to the root. */
  readonly repos: ReadonlyMap<string, string>;
  /** Every non-null command string in workspace.yml — the only commands a `cmd` src may cite. */
  readonly commands: ReadonlySet<string>;
  /**
   * Absolute `tldrx-work/<run>/` directory of the handoff being validated, when the
   * caller knows it — the second base a bare `file` path resolves against, so a
   * sub-agent may cite its own run-relative outputs (`01-what/intent.md:1`).
   */
  readonly runDir?: string | null;
  /**
   * This run's epic worktrees, tried BEFORE the working tree by a `file` src
   * (issue #16).
   *
   * The Build phase commits onto an epic branch and deliberately does not merge
   * it: the phase ends at a human gate and nothing it runs pushes or fast-forwards
   * `main`. A Watch stage then writes a handoff ABOUT that work, and every
   * `repo:src/…` citation in it named a file the working tree does not have yet —
   * so the stage's own evidence was refused for being true. The epic's checkout is
   * a real directory on disk (`.tldrx/worktrees/<repo>/_epic-<run>-<epic>`), so the
   * fix is a base, not a new kind of source: the citation is spelled exactly as it
   * always was, and it is looked for in this run's epic checkout first and in the
   * working tree after.
   *
   * Empty when the run has no epic worktree on disk, which is every stage before
   * Build and every run whose worktrees have been cleaned up.
   */
  readonly epicWorktrees?: readonly EpicWorktree[];
}

/** One epic checkout a `file` src may resolve against. */
export interface EpicWorktree {
  /** The `workspace.yml` repo it is a checkout OF. */
  readonly repo: string;
  /** Absolute path of the worktree directory. */
  readonly dir: string;
}

export function emptySrcContext(root: string, runDir?: string | null): SrcContext {
  return { root, repos: new Map(), commands: new Set(), runDir: runDir ?? null, epicWorktrees: [] };
}

const LINE_RE = /^\d{1,9}$/;
const LINE_RANGE_RE = /^(\d{1,9})-(\d{1,9})$/;
const ANSWER_RE = /^Q\d{1,6}$/;
const FACT_RE = /^F\d{3,6}$/;
const CMD_RE = /^\$ (.+) → exit (\d{1,3})$/;
const TRAILING_TOKEN_RE = /\[src: ([^\]]*)\]$/;
/**
 * Closers and terminal punctuation a bullet may carry AFTER its token.
 *
 * Measured 2026-08-29 on a real user's first `tldrx next`: 9 of 9 bullets carried
 * a citation and all 9 were reported "unsourced", because the token was anchored
 * to end-of-line and the author had written `` `[src: api:src/Foo.cs:12]` `` — a
 * backtick, a period or a closing paren after the `]` was enough to make the
 * whole handoff read as evidence-free. The token must still be the LAST semantic
 * element of the line; what may follow it is punctuation, not words.
 *
 * `]` is deliberately NOT in the set: it is the token's own terminator.
 */
const TRAILING_CLOSER_RE = /[`'"’”»)\s.,;:!?]+$/;
/** Anything with a `[src:` in it is an ATTEMPTED citation, however it is spelled. */
const SRC_MARKER = "[src:";
/** `aidlc:<file>:<line>` (prose) or `aidlc:<file>#Q<n>` (an answered question). */
const AIDLC_LINE_RE = /^(.+):(\d{1,9})$/;
const AIDLC_Q_RE = /^(.+)#(Q\d{1,6})$/;
/** What joins two sources inside ONE token. Split on it, and documented from it. */
export const SRC_SEPARATOR = "; ";

/**
 * Render `srcs` as ONE token — the write side of this grammar (gh #80).
 *
 * It lived in `core/map/srcToken.ts`, beside a second reader that has now been
 * deleted; the builder had no equivalent here, so it moved rather than went. It
 * belongs next to the parser for the reason the parser exists at all: the
 * separator a writer joins on and the separator a reader splits on are the same
 * constant, and cannot drift apart into two spellings of `"; "`.
 *
 * Callers pass PAYLOADS (`"api:src/Sel.ts:41"`), never a pre-built token.
 */
export function srcToken(srcs: readonly string[]): string {
  return `[src: ${srcs.join(SRC_SEPARATOR)}]`;
}

/**
 * True when `line` ends with a token that parses clean and cites at least one
 * source — the whole-line predicate, for callers that only need a yes.
 *
 * A thin read of `parseSrcToken`, so it strips trailing closers and refuses a
 * mid-line citation for the same reasons the parser does. Callers wanting to
 * know WHY a line failed want `diagnoseSrcToken` instead.
 */
export function endsWithToken(line: string, repos?: ReadonlySet<string>): boolean {
  const token = parseSrcToken(line, repos);
  return token !== null && token.errors.length === 0 && token.refs.length > 0;
}

/**
 * A pattern's source with its `\uXXXX` escapes decoded, for printing.
 *
 * `RegExp.prototype.source` re-escapes non-ASCII, so `CMD_RE.source` comes back
 * spelling the arrow as a six-character escape rather than as the arrow. Printing
 * THAT into the grammar contract would document the one rule gh #77 was filed
 * over — "the arrow is the real one, not `->`" — with the arrow itself written as
 * an escape sequence, which is a fourth way to get it wrong; the drift trap in
 * `test/src-grammar.test.ts` caught it before it shipped. Display only: the
 * pattern the reader runs is untouched.
 */
export function readableSource(pattern: RegExp): string {
  return pattern.source.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

/**
 * The patterns the reader actually runs, published so the DOCUMENTATION can be
 * generated from them rather than copied beside them (gh #35's precedent applied
 * to gh #77).
 *
 * None is global, so none carries a `lastIndex` — sharing them with a renderer is
 * safe. `renderSrcGrammarContract` prints them through `readableSource`: loosen a
 * regex and the published grammar moves with it in the same commit, and the
 * examples below are re-run against the new one by `test/src-grammar.test.ts`.
 */
export const SRC_PATTERNS = {
  trailingToken: TRAILING_TOKEN_RE,
  trailingClosers: TRAILING_CLOSER_RE,
  cmd: CMD_RE,
  answer: ANSWER_RE,
  fact: FACT_RE,
  line: LINE_RE,
  lineRange: LINE_RANGE_RE,
  aidlcLine: AIDLC_LINE_RE,
  aidlcQuestion: AIDLC_Q_RE,
} as const;

/**
 * Every way a `[src: …]` can be refused, as an ID.
 *
 * An id rather than a sentence because three readers need the same answer in
 * three shapes: the hook's deny block, the gate's one-line detail, and the
 * generated grammar contract. A sentence copied into all three drifts; an id
 * looked up in `SRC_RULES` cannot.
 */
export const SRC_RULE_IDS = [
  "trailing-position",
  "no-bracket-inside",
  "marker-spelling",
  "empty-token",
  "empty-source",
  "cmd-arrow",
  "doc-https",
  "file-shape",
  "line-range",
  "line-number",
  "no-parent-dir",
  "id-shape",
  "graph-node",
  "absent-path",
  "absent-needle",
  "aidlc-shape",
] as const;
export type SrcRuleId = (typeof SRC_RULE_IDS)[number];

export interface SrcRule {
  readonly id: SrcRuleId;
  /** What the rule requires, in one clause. Quoted verbatim by every rejection. */
  readonly rule: string;
  /**
   * The live pattern(s) or constant(s) that enforce it — `.source` and all.
   * Printed into the contract, so a regex edit shows up in the documentation.
   */
  readonly enforcedBy: readonly string[];
  /** A whole line this rule refuses, verbatim. Re-run by the drift trap. */
  readonly bad: string;
  /** The same claim, written so the reader accepts it. Also re-run. */
  readonly good: string;
}

/**
 * The rules, with a worked pair each.
 *
 * `bad` and `good` are whole BULLETS, not token fragments, because the failure
 * being fixed is a line-level one: `citesSomething` and the handoff parser both
 * read whole lines, which is exactly why a mid-sentence `[src: …]` was invisible
 * and unexplained. Every pair is pushed back through `diagnoseSrcToken` and
 * `parseSrcToken` in `test/src-grammar.test.ts` — a `bad` that stops failing, or
 * a `good` that stops parsing, is a red suite and not a stale doc.
 */
export const SRC_RULES: readonly SrcRule[] = [
  {
    id: "trailing-position",
    rule: "the `[src: …]` token is the LAST thing on the line — a citation written "
      + "mid-sentence is invisible to the reader, which anchors the token to end-of-line",
    enforcedBy: [readableSource(TRAILING_TOKEN_RE), readableSource(TRAILING_CLOSER_RE)],
    bad: "- it drops places [src: api:src/Sel.ts:2] before ranking",
    good: "- it drops places before ranking [src: api:src/Sel.ts:2]",
  },
  {
    id: "no-bracket-inside",
    rule: "no `]` anywhere INSIDE the token — the reader stops at the first one, so a "
      + "quoted list or an array in the citation truncates the match and the whole token is lost",
    enforcedBy: [readableSource(TRAILING_TOKEN_RE)],
    bad: "- four pids skipped [src: api:src/Sweep.ts:88 (pids: [119,120])]",
    good: "- four pids skipped, 119 and 120 among them [src: api:src/Sweep.ts:88]",
  },
  {
    id: "marker-spelling",
    rule: "the token opens with `[src: ` — the marker, a colon and ONE space; `[src:x]` is not a token",
    enforcedBy: [readableSource(TRAILING_TOKEN_RE)],
    bad: "- hints are synchronous [src:api:src/Hints.ts:12]",
    good: "- hints are synchronous [src: api:src/Hints.ts:12]",
  },
  {
    id: "empty-token",
    rule: "a token names at least one source — `[src: ]` cites nothing and is refused like an uncited claim",
    enforcedBy: [readableSource(TRAILING_TOKEN_RE)],
    bad: "- no retention policy is recorded [src: ]",
    good: "- no retention policy is recorded [src: absent:docs/retention.md]",
  },
  {
    id: "empty-source",
    rule: `sources inside one token are joined by \`${SRC_SEPARATOR}\` and none of them may be empty`,
    enforcedBy: [`${SRC_SEPARATOR}`],
    bad: "- two things happened [src: api:src/A.ts:1; ]",
    good: "- two things happened [src: api:src/A.ts:1; api:src/B.ts:2]",
  },
  {
    id: "cmd-arrow",
    rule: "a command source reads `$ <command> → exit <n>` with the REAL arrow → (U+2192) — "
      + "ASCII `->` is not the arrow and is refused",
    enforcedBy: [readableSource(CMD_RE)],
    bad: "- the suite is green [src: $ bun test -> exit 0]",
    good: "- the suite is green [src: $ bun test → exit 0]",
  },
  {
    id: "doc-https",
    rule: "a `doc` source is `https://` followed by a non-space URL — `http://` is refused",
    enforcedBy: ["https://"],
    bad: "- the SDK is generated from the spec [src: http://example.com/spec]",
    good: "- the SDK is generated from the spec [src: https://example.com/spec]",
  },
  {
    id: "file-shape",
    rule: "a `file` source is `[repo:]path:line[-line]` — a path with no line number cites a file, not a fact",
    enforcedBy: [readableSource(LINE_RE), readableSource(LINE_RANGE_RE)],
    bad: "- the API binds to all interfaces [src: src/Program.cs]",
    good: "- the API binds to all interfaces [src: src/Program.cs:41]",
  },
  {
    id: "line-range",
    rule: "what follows the LAST `:` is a line number or a `line-line` range, and the range ascends",
    enforcedBy: [readableSource(LINE_RE), readableSource(LINE_RANGE_RE)],
    bad: "- the handler validates the token [src: api:src/Auth.ts:12-x]",
    good: "- the handler validates the token [src: api:src/Auth.ts:12-18]",
  },
  {
    id: "line-number",
    rule: "line numbers are 1-based — there is no line 0",
    enforcedBy: [readableSource(LINE_RE)],
    bad: "- the file opens with a fence [src: api:src/Auth.ts:0]",
    good: "- the file opens with a fence [src: api:src/Auth.ts:1]",
  },
  {
    id: "no-parent-dir",
    rule: "`..` is not allowed in a source path — cite from the repo root, not from where you stood",
    enforcedBy: [".."],
    bad: "- the config lives one level up [src: api:../shared/config.ts:3]",
    good: "- the config lives one level up [src: api:shared/config.ts:3]",
  },
  {
    id: "id-shape",
    rule: `an answer is \`Q<n>\` (${readableSource(ANSWER_RE)}) and a fact is \`F<nnn>\` (${readableSource(FACT_RE)})`,
    enforcedBy: [readableSource(ANSWER_RE), readableSource(FACT_RE)],
    bad: "- the owner picked option (a) [src: Q]",
    good: "- the owner picked option (a) [src: Q3]",
  },
  {
    id: "graph-node",
    rule: "`graph:` carries a non-empty node id with no spaces in it",
    enforcedBy: ["graph:"],
    bad: "- the hunt module owns selection [src: graph:]",
    good: "- the hunt module owns selection [src: graph:hunt-engine]",
  },
  {
    id: "absent-path",
    rule: "`absent:` carries the path you looked at — an absence names what was checked or it is not evidence",
    enforcedBy: ["absent:"],
    bad: "- no retention policy is recorded [src: absent:]",
    good: "- no retention policy is recorded [src: absent:docs/retention.md]",
  },
  {
    id: "absent-needle",
    rule: "`absent:<path>#<needle>` carries the words you searched for — `#` with nothing after it "
      + "says you searched for nothing",
    enforcedBy: ["absent:", "#"],
    bad: "- no retention policy is recorded [src: absent:docs/retention.md#]",
    good: "- no retention policy is recorded [src: absent:docs/retention.md#retention]",
  },
  {
    id: "aidlc-shape",
    rule: "an `aidlc` source is `aidlc:<file>:<line>` or `aidlc:<file>#Q<n>`",
    enforcedBy: [readableSource(AIDLC_LINE_RE), readableSource(AIDLC_Q_RE)],
    bad: "- the intent named two personas [src: aidlc:intents/260821/design.md]",
    good: "- the intent named two personas [src: aidlc:intents/260821/design.md:14]",
  },
];

const RULES_BY_ID = new Map<SrcRuleId, SrcRule>(SRC_RULES.map((rule) => [rule.id, rule]));

/** The rule behind an id. Every id in `SRC_RULE_IDS` has one; the map is total. */
export function srcRule(id: SrcRuleId): SrcRule {
  const found = RULES_BY_ID.get(id);
  // Unreachable while the drift trap is green: it asserts the two lists agree.
  if (found === undefined) throw new Error(`no src rule '${id}'`);
  return found;
}

/**
 * A refusal that carries its rule.
 *
 * `message` IS the rule's own clause, so a caller that prints nothing but the
 * message still says what was enforced — the property gh #77 is about. `detail`
 * adds the one thing the rule cannot know: which of its halves this line broke.
 */
function refuse(raw: string, rule: SrcRuleId, detail?: string): SrcParseError {
  const clause = srcRule(rule).rule;
  return { raw, message: detail === undefined ? clause : `${clause} — ${detail}`, rule };
}

/** A line that TRIED to cite something, and the rule that refused it. */
export interface SrcFailure {
  readonly rule: SrcRule;
  /** The offending line, as written (trimmed, and capped for a deny block). */
  readonly line: string;
  /** The piece of the token that failed, when the failure is inside one. */
  readonly piece: string | null;
}

/** Longest offending line a rejection quotes back before it becomes noise. */
const MAX_QUOTED_CHARS = 200;

function quotable(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= MAX_QUOTED_CHARS ? trimmed : `${trimmed.slice(0, MAX_QUOTED_CHARS)}…`;
}

/**
 * Why this line's citation could not be read — by RULE, not by symptom (gh #77).
 *
 * Returns null for a line that never attempted a citation (nothing to explain)
 * and for one whose token parses (nothing wrong). Everything else lands on
 * exactly one rule, and the three the live run paid to discover are the first
 * three branches: the token is not last, a `]` sits inside it, or the marker is
 * misspelled. Anything that DID tokenise is diagnosed from the piece that failed,
 * whose own error already carries the rule id.
 */
export function diagnoseSrcToken(line: string, repos?: ReadonlySet<string>): SrcFailure | null {
  if (!hasSrcMarker(line)) return null;
  const token = parseSrcToken(line, repos);
  if (token !== null) {
    const error = token.errors[0];
    if (error === undefined) return null;
    return { rule: srcRule(error.rule), line: quotable(line), piece: error.raw === "" ? null : error.raw };
  }
  const trimmed = trimTrailingClosers(line);
  const at = trimmed.lastIndexOf(SRC_MARKER);
  const after = at === -1 ? "" : trimmed.slice(at);
  const opener = `${SRC_MARKER} `;
  let id: SrcRuleId = "trailing-position";
  if (at === -1 || !after.startsWith(opener)) {
    id = "marker-spelling";
  } else if (trimmed.endsWith("]") && after.slice(opener.length, -1).includes("]")) {
    id = "no-bracket-inside";
  }
  return { rule: srcRule(id), line: quotable(line), piece: null };
}

/**
 * A failure as a reader sees it: the rule in its own words, the line as written,
 * and a line that would pass. Three lines, because the two-attempt guessing game
 * in #77 was played against a message that had only the first half of one.
 */
export function describeSrcFailure(failure: SrcFailure): string {
  return [
    `rule \`${failure.rule.id}\`: ${failure.rule.rule}`,
    `      you wrote: ${failure.line}`,
    `      corrected: ${failure.rule.good}`,
  ].join("\n");
}

/**
 * The `[src: …]` token a line ends with, or null when there is none.
 * Trailing whitespace is ignored; anything after the `]` means "no token".
 */
export function parseSrcToken(line: string, repos?: ReadonlySet<string>): SrcToken | null {
  const trimmed = trimTrailingClosers(line);
  const match = TRAILING_TOKEN_RE.exec(trimmed);
  if (match === null) return null;
  const inner = match[1] ?? "";
  const refs: SrcRef[] = [];
  const errors: SrcParseError[] = [];
  for (const piece of inner.split(SRC_SEPARATOR)) {
    const parsed = classifySrc(piece, repos);
    if ("message" in parsed) errors.push(parsed);
    else refs.push(parsed);
  }
  if (inner.trim() === "") {
    return {
      raw: match[0], refs: [],
      errors: [{ raw: "", message: srcRule("empty-token").rule, rule: "empty-token" }],
    };
  }
  return { raw: match[0], refs, errors };
}

/**
 * Strip trailing whitespace, then any run of closing quotes/parens and terminal
 * punctuation, so the `]` of a wrapped token becomes the end of the line.
 * Applied once — `` `[src: x]`. `` and `([src: x]).` both reduce in one pass.
 */
function trimTrailingClosers(line: string): string {
  const trimmed = line.replace(/\s+$/, "");
  if (trimmed.endsWith("]")) return trimmed;
  const stripped = trimmed.replace(TRAILING_CLOSER_RE, "");
  return stripped.endsWith("]") ? stripped : trimmed;
}

/**
 * The line minus its `[src: …]` token: the CLAIM, without its evidence.
 *
 * Lives here rather than at the call site because this file is the ONE place that
 * may hold the grammar (#80) — a caller that needs the prose half of a bullet
 * gets it from the same parse everything else uses, and writes no second regex.
 *
 * A token says where a claim was CHECKED, not what it is about, so anything that
 * classifies a bullet by its words has to read the prose alone: "In scope: one
 * `questions.md` block per open ADR [src: app:docs/adr/ADR-D008-AUTH.md:1]" is
 * about the What stage's own file and cites an ADR, and the reverse pairing is
 * just as common (#111).
 *
 * A line with no parseable trailing token comes back unchanged.
 */
export function withoutSrcToken(line: string): string {
  const token = parseSrcToken(line);
  return token === null ? line : line.replace(token.raw, " ");
}

/**
 * True when the line TRIED to cite something — it holds a `[src:` marker — even if
 * the token does not parse. The two failures need different advice: "you wrote no
 * citation" and "your citation is malformed" are not the same mistake.
 */
export function hasSrcMarker(line: string): boolean {
  return line.includes(SRC_MARKER);
}

/** One `src` production. Returns a ref, or an error describing why it is not one. */
export function classifySrc(src: string, repos?: ReadonlySet<string>): SrcRef | SrcParseError {
  const raw = src;
  if (raw === "") return refuse(raw, "empty-source");

  if (raw.startsWith("https://")) {
    if (raw.length <= "https://".length || /\s/.test(raw)) return refuse(raw, "doc-https");
    return { kind: "doc", raw, url: raw };
  }
  if (raw.startsWith("http://")) return refuse(raw, "doc-https");
  if (raw.startsWith("$ ")) {
    const m = CMD_RE.exec(raw);
    // The arrow is the failure this names first: `->` is the spelling every host
    // reaches for, and until gh #77 the refusal printed the shape without ever
    // saying which character in it was wrong.
    if (m === null || m[1] === undefined || m[2] === undefined) return refuse(raw, "cmd-arrow");
    return { kind: "cmd", raw, command: m[1], exitCode: Number(m[2]) };
  }
  if (raw.startsWith("graph:")) {
    const node = raw.slice("graph:".length);
    if (node === "" || /\s/.test(node)) return refuse(raw, "graph-node");
    return { kind: "graph", raw, node };
  }
  if (raw.startsWith("aidlc:")) return parseAidlcSrc(raw);
  if (raw.startsWith("absent:")) {
    const rest = raw.slice("absent:".length);
    // The FIRST `#` splits, so a needle may itself contain one. A path that holds
    // a `#` cannot be cited, and that trade is deliberate: a searched-for phrase
    // is the thing an absence is actually about, and `#` is already the framework's
    // separator for "inside this file" (`aidlc:<file>#Q<n>`).
    const hash = rest.indexOf("#");
    const path = hash === -1 ? rest : rest.slice(0, hash);
    const needle = hash === -1 ? null : rest.slice(hash + 1);
    if (path === "") return refuse(raw, "absent-path");
    if (needle !== null && needle.trim() === "") return refuse(raw, "absent-needle");
    return { kind: "absent", raw, path, needle };
  }
  if (ANSWER_RE.test(raw)) return { kind: "answer", raw, q: raw };
  if (FACT_RE.test(raw)) return { kind: "fact", raw, id: raw };
  if (raw.startsWith("Q") || raw.startsWith("F")) {
    // Looks like an id but is not one — say so rather than falling through to `file`.
    if (!raw.includes(":")) return refuse(raw, "id-shape");
  }
  return parseFileSrc(raw, repos);
}

/**
 * `aidlc:<file>:<line>` / `aidlc:<file>#Q<n>` — provenance for a `--from` distill
 * (spec §6). `[assumption]`: the AI-DLC intent folder is OUTSIDE the workspace and
 * may be gone by the time anyone reads the handoff, so an `aidlc` src is never
 * resolved against the filesystem. It records where a claim came from; it is not
 * a promise the file is still there.
 */
function parseAidlcSrc(raw: string): SrcRef | SrcParseError {
  const rest = raw.slice("aidlc:".length);
  if (rest === "") return refuse(raw, "aidlc-shape", "`aidlc:` carries no path at all");
  if (rest.includes("..")) return refuse(raw, "no-parent-dir");

  const question = AIDLC_Q_RE.exec(rest);
  if (question !== null && question[1] !== undefined && question[2] !== undefined) {
    return { kind: "aidlc", raw, path: question[1], line: null, q: question[2] };
  }
  const located = AIDLC_LINE_RE.exec(rest);
  if (located !== null && located[1] !== undefined && located[2] !== undefined) {
    const line = Number(located[2]);
    if (line < 1) return refuse(raw, "line-number");
    return { kind: "aidlc", raw, path: located[1], line, q: null };
  }
  return refuse(raw, "aidlc-shape");
}

/** `[repo ":"] path ":" line ["-" line]`, split from the right so paths may contain colons. */
function parseFileSrc(raw: string, repos?: ReadonlySet<string>): SrcRef | SrcParseError {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon <= 0) return refuse(raw, "file-shape", "there is no `:<line>` on the end");
  const lineSpec = raw.slice(lastColon + 1);
  const head = raw.slice(0, lastColon);
  let startLine: number;
  let endLine: number | null = null;
  if (LINE_RE.test(lineSpec)) {
    startLine = Number(lineSpec);
  } else {
    const range = LINE_RANGE_RE.exec(lineSpec);
    if (range === null || range[1] === undefined || range[2] === undefined) {
      return refuse(raw, "line-range", `\`${lineSpec}\` is neither`);
    }
    startLine = Number(range[1]);
    endLine = Number(range[2]);
    if (endLine < startLine) return refuse(raw, "line-range", "this range ends before it starts");
  }
  if (startLine < 1) return refuse(raw, "line-number");

  let repo: string | null = null;
  let path = head;
  const firstColon = head.indexOf(":");
  if (firstColon > 0) {
    const candidate = head.slice(0, firstColon);
    // A repo prefix is a slug; with no repo list to check against, treat any slug as one.
    if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(candidate) && (repos === undefined || repos.has(candidate))) {
      repo = candidate;
      path = head.slice(firstColon + 1);
    }
  }
  if (path === "") return refuse(raw, "file-shape", "the path is empty");
  if (path.includes("..")) return refuse(raw, "no-parent-dir");
  return { kind: "file", raw, repo, path, startLine, endLine };
}

/**
 * Four outcomes (gh #110; three since the 2026-08-29 audit, gap 2).
 *
 * `ok` — checked, and it holds. `refused` — checked, and it does NOT; the claim is
 * denied. `unverified` — the citation is well formed and the thing it names cannot
 * be checked from disk at all (an https URL nothing in the workspace mentions, a
 * `cmd` with no workspace commands to check against). An `unverified` citation
 * never fails a stage, and an auto gate will not close over one.
 *
 * `noted` is the fourth, and it exists because `unverified` was being read as two
 * different sentences by the two checkers that share this resolver. An
 * `absent:<path>` over a path that EXISTS with content is a claim about that
 * path's CONTENT — legal, honest, and the framework's own documented spelling of
 * an empty section (`- none [src: absent:.tldrx/memory/facts.yml]`). Measured
 * live 2026-09-02: `claim-sources` waved it through in silence while the auto
 * gate on the very same file refused to close over it (gh #110, absorbing #105).
 * `noted` is the ONE answer both now give — it never fails a stage and never
 * blocks a gate, and it is named, by path, in every line either of them prints.
 * Before any of this existed, six of the eight src kinds returned `ok`
 * unconditionally: a handoff citing `F999`, `Q42` and `graph:i-made-this-up`
 * validated clean and auto-approved itself.
 */
export type SrcOutcome = "ok" | "noted" | "unverified" | "refused";

export interface SrcResolution {
  /** False only for `refused`. An `unverified` src does not fail the stage. */
  readonly ok: boolean;
  readonly outcome: SrcOutcome;
  /** Absolute path a `file` src resolved to, when it is a `file` src. */
  readonly resolved?: string;
  readonly message?: string;
}

const lineCountCache = new Map<string, number>();

const OK: SrcResolution = { ok: true, outcome: "ok" };

function refused(message: string, resolved?: string): SrcResolution {
  return resolved === undefined
    ? { ok: false, outcome: "refused", message }
    : { ok: false, outcome: "refused", message, resolved };
}

function unverified(message: string): SrcResolution {
  return { ok: true, outcome: "unverified", message };
}

/** Legal, never fatal, never blocking — and never silent. See `SrcOutcome`. */
function noted(message: string): SrcResolution {
  return { ok: true, outcome: "noted", message };
}

/**
 * Resolve one ref against the workspace.
 *
 * `claim` is the bullet's own text, which only `absent:` needs: an absence can
 * source a NEGATIVE claim ("no retention policy is recorded") and nothing else.
 * The audit's probe sourced "we removed the auth check from /admin" with
 * `absent:ops/backup.yml`, and that is the shape being refused.
 */
export function resolveSrc(ref: SrcRef, ctx: SrcContext, section: string, claim = ""): SrcResolution {
  switch (ref.kind) {
    case "file": {
      if (ref.repo !== null && !ctx.repos.has(ref.repo)) {
        return refused(`unknown repo \`${ref.repo}\` (not in workspace.yml)`);
      }
      const bases = pathBases(ref.repo, ref.path, ctx);
      // Every base is tried, and a base where the file EXISTS but is too short no
      // longer ends the search. Since issue #16 added the epic worktree ahead of
      // the working tree, stopping at the first existing copy would refuse a
      // citation that resolves perfectly well one base later — a file truncated on
      // the epic branch would deny a claim about the line it still has on `main`.
      // The short copy is remembered so the failure message stays the precise one
      // when NO base can carry the line.
      let short: SrcResolution | null = null;
      for (const base of bases) {
        if (!existsSync(base.abs) || !statSync(base.abs).isFile()) continue;
        const lines = countLines(base.abs);
        const highest = ref.endLine ?? ref.startLine;
        if (highest > lines) {
          short ??= refused(`${ref.path} has ${lines} line(s); cited line ${highest}`, base.abs);
          continue;
        }
        return { ok: true, outcome: "ok", resolved: base.abs };
      }
      if (short !== null) return short;
      const tried = bases.map((b) => b.label).join(", ");
      return refused(`no such file: ${ref.path} — tried ${tried}`, bases[0]?.abs);
    }
    case "cmd": {
      if (section !== "Evidence ledger") {
        return refused("`$ … → exit n` sources are only allowed in the Evidence ledger");
      }
      // `[assumption]` — with no workspace.yml commands to check against (no file, or
      // an empty one) a `cmd` src cannot be checked. That used to read as `ok`; it is
      // `unverified` now, because "there was nothing to check against" and "it checks
      // out" are different sentences and only one of them may close a gate.
      if (ctx.commands.size === 0) {
        return unverified("no workspace.yml commands to check `$ … → exit n` against");
      }
      if (!ctx.commands.has(ref.command)) {
        return refused(`command \`${ref.command}\` is not one of workspace.yml's commands`);
      }
      // Membership is checked; the EXIT CODE is the agent's word and is not re-run here.
      return OK;
    }
    case "fact":
      return resolveFact(ref.id, ctx);
    case "answer":
      return resolveAnswer(ref.q, ctx);
    case "graph":
      return resolveGraph(ref.node, ctx);
    case "doc":
      return resolveDoc(ref.url, ctx);
    case "absent":
      return resolveAbsent(ref, ctx, section, claim);
    case "aidlc":
      // Unchanged by design (§6): the AI-DLC intent folder is OUTSIDE the workspace
      // and may be gone. An `aidlc:` src records where a claim came from; it was
      // never a promise the file is still there, so it is not made one now.
      return OK;
  }
}

// --- verifying the five kinds that used to wave through ---------------------

/** `F<n>` must be a row in `.tldrx/memory/facts.yml`, and must not be retired. */
function resolveFact(id: string, ctx: SrcContext): SrcResolution {
  const facts = loadFacts(ctx.root);
  if (facts === null) {
    return unverified(`no ${PROJECT_FRAMEWORK_DIR}/memory/facts.yml to check ${id} against`);
  }
  if (facts.retired.has(id)) {
    return refused(`${id} is RETIRED in facts.yml — a retired fact is not evidence`);
  }
  if (!facts.live.has(id)) {
    const known = facts.live.size === 0 ? "it has no live facts" : `it has ${String(facts.live.size)} live fact(s)`;
    return refused(`no such fact ${id} in ${PROJECT_FRAMEWORK_DIR}/memory/facts.yml — ${known}`);
  }
  return OK;
}

/** `Q<n>` must be a question block in one of this run's `questions.md` files. */
function resolveAnswer(q: string, ctx: SrcContext): SrcResolution {
  const runDir = ctx.runDir ?? null;
  if (runDir === null || runDir === "") {
    return unverified(`no run directory in context to look ${q} up in`);
  }
  const ids = loadQuestionIds(runDir);
  if (ids === null) return refused(`no questions.md anywhere in this run — ${q} cites a question nobody asked`);
  if (!ids.has(q)) {
    const known = ids.size === 0 ? "none are declared" : `declared: ${[...ids].sort().join(", ")}`;
    return refused(`no such question ${q} in this run's questions.md — ${known}`);
  }
  return OK;
}

/** `graph:<node>` must be a node id in `graphify-out/graph.json`, or named in the map. */
function resolveGraph(node: string, ctx: SrcContext): SrcResolution {
  const graph = loadGraphNodes(ctx.root);
  if (graph !== null) {
    if (graph.has(node)) return OK;
    return refused(`no node \`${node}\` in graphify-out/graph.json (${String(graph.size)} node(s))`);
  }
  const map = loadMapTokens(ctx.root);
  if (map === null) {
    return unverified(`no graphify-out/graph.json and no ${PROJECT_FRAMEWORK_DIR}/map/ to check \`${node}\` against`);
  }
  if (map.has(node)) return OK;
  return refused(`\`${node}\` is not a node id or a path named anywhere in ${PROJECT_FRAMEWORK_DIR}/map/`);
}

/**
 * `https://…` cannot be fetched — a hook has no network and a gate must not gain
 * one. So the check is provenance rather than content: the URL is accepted when
 * something in the workspace ALREADY names it (a knowledge file, the map, a
 * declared input of this run). Otherwise it is `unverified`: not a lie, not a
 * check either, and never enough on its own to close a gate.
 */
function resolveDoc(url: string, ctx: SrcContext): SrcResolution {
  const known = loadDeclaredUrls(ctx);
  if (known.has(url) || known.has(url.replace(/[/#?]+$/, ""))) return OK;
  return unverified(`${url} is not fetched offline and no input, map or knowledge file cites it`);
}

/**
 * `absent:<path>[#<needle>]` — "I looked HERE, and it is not there" (gh #110).
 *
 * ONE semantic, because both checkers that matter — `claim-sources` and the auto
 * gate's condition 5 — resolve through this function and had been reading its old
 * `unverified` answer as two different sentences (gh #110, absorbing #105).
 *
 *  1. **The claim must be NEGATIVE.** An absence can source "no retention policy
 *     is recorded"; it cannot source "we removed the auth check from /admin".
 *     Refused. `## Unknowns` is exempt, because that heading IS the negation:
 *     §2.8's own example, `- Retention period for historical rankings
 *     [src: absent:…]`, reads as a positive noun phrase and means "we do not know
 *     it". A word-level rule applied there would outlaw the spec's own shape.
 *  2. **The path is resolved against the same bases a `file` src is.** This is
 *     the mechanism behind #105: `absent:` used to try the workspace root and
 *     nothing else, so the run-relative `absent:04-build/log` never even SAW the
 *     directory it named — seven files sitting there, and the citation resolved
 *     to a silent, literal `ok`. It is reached now, and answered.
 *  3. **Nothing there to have missed ⇒ `ok`.** No such path, an empty or
 *     whitespace-only file, a directory with no entries: the absence is literal,
 *     and a reader confirms it in one look.
 *  4. **A needle ⇒ the absence is actually SEARCHED.** `absent:<path>#<needle>`
 *     says what was looked for, so this can look for it too: not found is a
 *     verified `ok`, and found is a `refused` that names the line. This is the
 *     only form in which an absence over a file with content is *checked*, and it
 *     is the upgrade path out of (5).
 *  5. **Otherwise ⇒ `noted`.** The path exists, holds content, and the citation
 *     names no needle, so "it is not in there" is a claim about content that
 *     nothing here read. It is legal — `- none [src: absent:.tldrx/memory/facts.yml]`
 *     is the spec's own spelling of an empty section, and refusing it would
 *     outlaw the negative-case discipline the mandate asks for. It never fails a
 *     stage and never blocks a gate. What it does not do is pass in silence:
 *     `noted` is counted and named, by path, wherever either checker prints.
 */
function resolveAbsent(
  ref: Extract<SrcRef, { kind: "absent" }>,
  ctx: SrcContext,
  section: string,
  claim: string,
): SrcResolution {
  const { path, needle } = ref;
  if (section !== "Unknowns" && claim !== "" && !isNegativeClaim(claim)) {
    return refused(
      `absent:${path} sources a positive claim — an absence can only support a negative one ` +
        "(say what is NOT there: `no`, `not`, `never`, `none`, `absent`), or move it under Unknowns",
    );
  }
  const found = firstExisting(absentBases(path, ctx));
  // (3a) nothing anywhere it could have been — the absence is literal.
  if (found === null) return OK;
  if (needle !== null) return searchForNeedle(found, needle, path);
  const held = whatIsThere(found);
  // (3b) it is there and it is empty, which is the same absence one level down.
  if (held === null) return OK;
  return noted(
    `${path} EXISTS (${held}) — "it is not in there" is a claim about its CONTENT, unchecked here. ` +
      `Cite \`absent:${path}#<what you searched for>\` to have it checked, or cite the line that proves it.`,
  );
}

/** Cap on a file an `absent:…#<needle>` search will read. Beyond it, `noted`. */
const NEEDLE_MAX_BYTES = 512 * 1024;

/**
 * Cap on the read that decides whether a bare `absent:` target is EMPTY.
 *
 * Deliberately much lower than the needle cap. Searching is opt-in — an author
 * wrote `#<needle>` and asked for it — while this read happens on every bare
 * `absent:` in every handoff, inside a hook with a 50 ms budget (§0). Anything
 * bigger than this is not whitespace, so its size is answer enough.
 */
const EMPTY_PROBE_MAX_BYTES = 64 * 1024;

/**
 * Search `abs` for `needle`, case-insensitively.
 *
 * Case-insensitive on purpose: "you said it is not there" is disproved by the
 * thing being there in ANY casing, and the direction that costs less is the one
 * that sends a writer back to look again.
 */
function searchForNeedle(abs: string, needle: string, path: string): SrcResolution {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return OK;
  }
  if (stat.isDirectory()) {
    return refused(
      `absent:${path}#${needle} searches a DIRECTORY — a needle is searched in one file. ` +
        `Cite the file you read (\`absent:${path}/<file>#${needle}\`), or drop the needle.`,
    );
  }
  if (stat.size > NEEDLE_MAX_BYTES) {
    return noted(`${path} is ${String(stat.size)} bytes — too large to search here for \`${needle}\``);
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return noted(`${path} could not be read here to search for \`${needle}\``);
  }
  const wanted = needle.toLowerCase();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").toLowerCase().includes(wanted)) {
      return refused(
        `\`${needle}\` IS at ${path}:${String(i + 1)} — that is a presence, not an absence`,
        abs,
      );
    }
  }
  // The one shape in which an absence over an existing file is genuinely CHECKED.
  return OK;
}

/**
 * What the path holds, phrased for the message — or `null` when it holds nothing,
 * which is the same absence one level down and resolves `ok`.
 */
function whatIsThere(abs: string): string | null {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    let entries: readonly string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return "a directory this check could not read";
    }
    if (entries.length === 0) return null;
    return `${String(entries.length)} entr${entries.length === 1 ? "y" : "ies"}`;
  }
  if (!stat.isFile()) return "a path that is neither a file nor a directory";
  if (stat.size === 0) return null;
  if (stat.size > EMPTY_PROBE_MAX_BYTES) return `${String(stat.size)} bytes`;
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return `${String(stat.size)} bytes`;
  }
  if (text.trim() === "") return null;
  const lines = text.split("\n").length;
  return `${String(lines)} line${lines === 1 ? "" : "s"}`;
}

/**
 * The bases an `absent:` path is tried against — the SAME ones a `file` src uses,
 * plus the `repo:path` spelling the guide already documents
 * (`absent:api:src/Places/Place.cs`). An absence is true only when it holds at
 * EVERY base, so the first base where the path exists is the one that answers.
 */
function absentBases(path: string, ctx: SrcContext): readonly FileBase[] {
  const colon = path.indexOf(":");
  if (colon > 0) {
    const repo = path.slice(0, colon);
    if (ctx.repos.has(repo)) return pathBases(repo, path.slice(colon + 1), ctx);
  }
  return pathBases(null, path, ctx);
}

function firstExisting(bases: readonly FileBase[]): string | null {
  for (const base of bases) {
    if (existsSync(base.abs)) return base.abs;
  }
  return null;
}

/** Word-boundary negation. Substring matching would read "nothing" out of "notation". */
const NEGATIVE_RE =
  /\b(no|not|none|never|nothing|nobody|nowhere|neither|nor|absent|absence|missing|lacks?|lacking|without|unknown|undocumented|unrecorded|untracked|zero|n\/a)\b|n't\b/i;

export function isNegativeClaim(text: string): boolean {
  return NEGATIVE_RE.test(text);
}

interface FileBase {
  /** Human-readable name of the base, for the "tried …" half of a failure message. */
  readonly label: string;
  readonly abs: string;
}

/**
 * The bases a path in a citation is resolved against, in order — first existing
 * wins (spec §2.8). A `file` src and an `absent:` src share them, and that
 * sharing is the fix for #105: an `absent:` that tried only the workspace root
 * could not see a run-relative directory, so it reported an absence it had never
 * looked for.
 *
 * A bare `path:line` is ambiguous by design: the sub-agent writing a handoff thinks
 * run-relatively (`01-what/intent.md:1`) while the workspace thinks root-relatively
 * (`.tldrx/memory/facts.yml:4`). Both are legal, so both are tried:
 *
 *   (a) this run's epic worktree for the repo, when there is one (issue #16),
 *   (b) the workspace root,
 *   (c) the run directory of the handoff being validated (when the caller knows it),
 *   (d) the repo dir, when the path starts with a known repo name + `/` — i.e.
 *       `api/src/Hunt.cs` is accepted as a spelling of `api:src/Hunt.cs`.
 *
 * (a) comes first because the epic branch is the code the run is ABOUT: at Watch
 * time the working tree is deliberately behind it, and "the file is not on `main`
 * yet" is the expected state rather than a bad citation. A repo-qualified
 * `repo:path` and an absolute path still resolve to exactly one place in the
 * working tree; the epic worktree adds one more, never a different repo's.
 */
function pathBases(repo: string | null, path: string, ctx: SrcContext): readonly FileBase[] {
  if (isAbsolute(path)) {
    return [{ label: "the absolute path as written", abs: normalize(path) }];
  }
  if (repo !== null) {
    const rel = ctx.repos.get(repo) ?? "";
    return [
      ...epicBases(ctx, repo, path),
      { label: repoLabel(repo, rel), abs: normalize(join(ctx.root, rel, path)) },
    ];
  }
  const bases: FileBase[] = [];
  const slash = path.indexOf("/");
  const named = slash > 0 ? path.slice(0, slash) : "";
  const rel = named === "" ? undefined : ctx.repos.get(named);
  if (rel !== undefined) bases.push(...epicBases(ctx, named, path.slice(slash + 1)));
  bases.push({ label: "workspace root", abs: normalize(join(ctx.root, path)) });
  const runDir = ctx.runDir ?? null;
  if (runDir !== null && runDir !== "") {
    bases.push({ label: `run dir ${displayPath(ctx.root, runDir)}`, abs: normalize(join(runDir, path)) });
  }
  if (rel !== undefined) {
    bases.push({
      label: repoLabel(named, rel),
      abs: normalize(join(ctx.root, rel, path.slice(slash + 1))),
    });
  }
  return bases;
}

/** This run's epic checkouts of ONE repo, as bases for a path inside that repo. */
function epicBases(ctx: SrcContext, repo: string, path: string): readonly FileBase[] {
  const trees = ctx.epicWorktrees ?? [];
  const bases: FileBase[] = [];
  for (const tree of trees) {
    if (tree.repo !== repo) continue;
    bases.push({
      label: `epic worktree ${displayPath(ctx.root, tree.dir)}`,
      abs: normalize(join(tree.dir, path)),
    });
  }
  return bases;
}

function repoLabel(name: string, rel: string): string {
  const at = rel === "" || rel === "." ? "workspace root" : rel;
  return `repo \`${name}\` (${at})`;
}

/** Workspace-relative when it can be — an absolute temp path in a deny message is noise. */
function displayPath(root: string, dir: string): string {
  const rel = relative(root, dir);
  return rel === "" || rel.startsWith("..") ? dir : rel.split(sep).join("/");
}

function countLines(path: string): number {
  const cached = lineCountCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(path, "utf8");
  const count = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  lineCountCache.set(path, count);
  return count;
}

// --- the evidence indexes ---------------------------------------------------
//
// Every one of these is LAZY and memoised per process: a handoff with no `F<n>`
// never opens facts.yml, and one with forty opens it once. That is what keeps the
// hook inside its 50 ms budget (spec §0) now that it actually checks things.

interface FactIndex {
  readonly live: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
}

const factsCache = new Map<string, FactIndex | null>();
const questionsCache = new Map<string, ReadonlySet<string> | null>();
const graphCache = new Map<string, ReadonlySet<string> | null>();
const mapCache = new Map<string, ReadonlySet<string> | null>();
const urlCache = new Map<string, ReadonlySet<string>>();

/** Files read per index, and bytes per file — a runaway workspace must not stall a hook. */
const MAX_SCAN_FILES = 400;
const MAX_SCAN_BYTES = 512 * 1024;
const MAX_SCAN_DEPTH = 4;

function loadFacts(root: string): FactIndex | null {
  const cached = factsCache.get(root);
  if (cached !== undefined) return cached;
  const index = readFacts(join(root, PROJECT_FRAMEWORK_DIR, "memory", "facts.yml"));
  factsCache.set(root, index);
  return index;
}

function readFacts(path: string): FactIndex | null {
  if (!existsSync(path)) return null;
  const live = new Set<string>();
  const retired = new Set<string>();
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    const rows = (doc as { facts?: unknown } | null)?.facts;
    if (!Array.isArray(rows)) return { live, retired };
    for (const row of rows as Record<string, unknown>[]) {
      const id = typeof row?.id === "string" ? row.id : null;
      if (id === null) continue;
      const gone = row.retired;
      const isGone =
        gone !== null && gone !== undefined && typeof gone === "object" &&
        (gone as { at?: unknown }).at !== null && (gone as { at?: unknown }).at !== undefined;
      if (isGone) retired.add(id);
      else live.add(id);
    }
  } catch {
    // An unreadable facts.yml is "cannot check", not "check failed".
    return null;
  }
  return { live, retired };
}

/** Every `## Q<n>` heading in every `questions.md` under the run, any phase. */
function loadQuestionIds(runDir: string): ReadonlySet<string> | null {
  const cached = questionsCache.get(runDir);
  if (cached !== undefined) return cached;
  const files = findFiles(runDir, (name) => name === "questions.md", MAX_SCAN_DEPTH);
  if (files.length === 0) {
    questionsCache.set(runDir, null);
    return null;
  }
  const ids = new Set<string>();
  const heading = /^#{2,4}\s*(Q\d{1,6})\b/gm;
  for (const file of files) {
    const text = readCapped(file);
    for (const match of text.matchAll(heading)) {
      if (match[1] !== undefined) ids.add(match[1]);
    }
  }
  questionsCache.set(runDir, ids);
  return ids;
}

/**
 * Node ids from graphify's export. Both layouts are tried — `.tldrx/graphify-out/`
 * (what `map --refresh` writes) and a bare `graphify-out/` beside the workspace.
 */
function loadGraphNodes(root: string): ReadonlySet<string> | null {
  const cached = graphCache.get(root);
  if (cached !== undefined) return cached;
  const ids = readGraphNodes(root);
  graphCache.set(root, ids);
  return ids;
}

function readGraphNodes(root: string): ReadonlySet<string> | null {
  const roots = [join(root, PROJECT_FRAMEWORK_DIR, "graphify-out"), join(root, "graphify-out")];
  const files: string[] = [];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    files.push(...findFiles(dir, (name) => name === "graph.json", MAX_SCAN_DEPTH));
  }
  if (files.length === 0) return null;
  const ids = new Set<string>();
  for (const file of files) {
    try {
      const doc: unknown = JSON.parse(readCapped(file));
      const nodes = (doc as { nodes?: unknown } | null)?.nodes;
      if (!Array.isArray(nodes)) continue;
      for (const node of nodes as Record<string, unknown>[]) {
        for (const key of ["id", "name", "label"] as const) {
          const value = node?.[key];
          if (typeof value === "string" && value !== "") {
            ids.add(value);
            break;
          }
        }
      }
    } catch {
      // A graph.json we cannot parse contributes no ids; another one still may.
    }
  }
  return ids.size === 0 ? null : ids;
}

/** Words and paths the code map names — the fallback when there is no graph.json. */
function loadMapTokens(root: string): ReadonlySet<string> | null {
  const cached = mapCache.get(root);
  if (cached !== undefined) return cached;
  const dir = join(root, PROJECT_FRAMEWORK_DIR, "map");
  if (!existsSync(dir)) {
    mapCache.set(root, null);
    return null;
  }
  const tokens = new Set<string>();
  const word = /[A-Za-z0-9_./-]{2,}/g;
  for (const file of findFiles(dir, (name) => name.endsWith(".md") || name.endsWith(".json"), MAX_SCAN_DEPTH)) {
    for (const match of readCapped(file).matchAll(word)) tokens.add(match[0]);
  }
  mapCache.set(root, tokens);
  return tokens;
}

/**
 * Every https URL the workspace already names: the run's own artefacts (its
 * declared inputs and outputs all live there), the code map, and trained expert
 * knowledge. A `doc` src that appears in none of them is `unverified`.
 */
function loadDeclaredUrls(ctx: SrcContext): ReadonlySet<string> {
  const key = `${ctx.root}\0${ctx.runDir ?? ""}`;
  const cached = urlCache.get(key);
  if (cached !== undefined) return cached;
  const urls = new Set<string>();
  const url = /https:\/\/[^\s)\]"'`<>]+/g;
  const runDir = ctx.runDir ?? "";
  const dirs: readonly string[] = [
    join(ctx.root, PROJECT_FRAMEWORK_DIR, "map"),
    join(ctx.root, PROJECT_FRAMEWORK_DIR, "knowledge"),
    join(ctx.root, PROJECT_FRAMEWORK_DIR, "experts"),
    ...(runDir === "" ? [] : [runDir]),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    // handoff.md is excluded on purpose: a handoff citing its own URL would be
    // evidence for itself.
    for (const file of findFiles(dir, (name) => name.endsWith(".md") && name !== "handoff.md", MAX_SCAN_DEPTH)) {
      for (const match of readCapped(file).matchAll(url)) {
        urls.add(match[0].replace(/[.,;:]+$/, ""));
      }
    }
  }
  urlCache.set(key, urls);
  return urls;
}

/** Depth- and count-capped directory walk. Dot-directories are skipped except the two we own. */
function findFiles(dir: string, accept: (name: string) => boolean, depth: number): readonly string[] {
  const found: string[] = [];
  const walk = (current: string, left: number): void => {
    if (left < 0 || found.length >= MAX_SCAN_FILES) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found.length >= MAX_SCAN_FILES) return;
      if (name.startsWith(".") && name !== PROJECT_FRAMEWORK_DIR) continue;
      if (name === "node_modules") continue;
      const abs = join(current, name);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(abs, left - 1);
      else if (accept(name)) found.push(abs);
    }
  };
  walk(dir, depth);
  return found;
}

function readCapped(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
  } catch {
    return "";
  }
}

/** Drop every memoised index — tests that rewrite fixtures need this. */
export function clearSrcCaches(): void {
  lineCountCache.clear();
  factsCache.clear();
  questionsCache.clear();
  graphCache.clear();
  mapCache.clear();
  urlCache.clear();
}
