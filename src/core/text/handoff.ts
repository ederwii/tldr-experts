/**
 * `tldrx-work/<run>/<phase>/handoff.md` (spec §2.8).
 *
 * Four H2 sections, in order; **each contains at least one list item**; and
 * **every list item inside them — `- `, `1. ` or `1) ` — ends with a `[src: …]`
 * token**. This module splits the sections, finds the bullets, and reports the
 * offending line numbers — the claim-sources hook turns that report into a deny
 * message and nothing else.
 *
 * The "at least one item" rule is spec §2.8, and it is there because a prose-only
 * section is how an unsourced claim gets written anyway: a paragraph carries no
 * bullet for the checker to look at, so "Unknowns: none that we can see" used to
 * validate clean. A section with genuinely nothing in it is written as
 * `- none [src: absent:<what was looked at>]` — which names what was checked, and
 * is a claim like any other.
 */
import {
  diagnoseSrcToken, hasSrcMarker, parseSrcToken, resolveSrc,
  type SrcContext, type SrcRef, type SrcRuleId, type SrcToken,
} from "./srcToken.ts";

export const HANDOFF_SECTIONS = ["Findings", "Decisions", "Unknowns", "Evidence ledger"] as const;
export type HandoffSectionName = (typeof HANDOFF_SECTIONS)[number];

export interface HandoffBullet {
  /** 1-based line number in the file. */
  readonly line: number;
  readonly text: string;
  readonly token: SrcToken | null;
}

export interface HandoffSection {
  readonly name: string;
  readonly headingLine: number;
  readonly bullets: readonly HandoffBullet[];
}

export interface Handoff {
  readonly sections: readonly HandoffSection[];
  /** H2 headings in the order they appear, including ones outside the required four. */
  readonly headings: readonly string[];
}

const H2_RE = /^##\s+(.+?)\s*$/;
/**
 * A list item. Both markers count: `- text` and `1. text` / `1) text`.
 *
 * Spec §2.8 says *every list item* in the four sections carries a `[src: …]`.
 * Reading only `- ` let an ordered list smuggle unsourced claims past the check —
 * the measured case being the pilot's Decisions section, 15 numbered claims that
 * nothing validated.
 *
 * The two markers get different indent rules on purpose. A `- ` tolerates up to
 * three spaces (CommonMark's rule for a top-level item) because an indented `- `
 * is unambiguously a marker. An ordered marker must sit at column 0, because an
 * indented digit run is far more often a wrapped line — "…global since\n  2019.
 * That has not changed" — and reading that as a new, unsourced item would deny a
 * handoff for its line width. Ordered items in a handoff start at column 0.
 */
const BULLET_RE = /^(?: {0,3}-|\d{1,9}[.)])\s+(\S.*)$/;
/**
 * A wrapped bullet's continuation: an indented, non-empty line that is not itself
 * a bullet. Spec §2.8 says the bullet ends with a `[src: …]` token — a soft-wrapped
 * bullet still does, just one line down, and treating that as an unsourced claim
 * would punish line width rather than missing evidence. A bullet therefore runs to
 * the next line that starts at column 0 (or to the next bullet).
 */
const CONTINUATION_RE = /^\s+\S/;

export function parseHandoff(text: string): Handoff {
  const lines = text.split("\n");
  const sections: HandoffSection[] = [];
  const headings: string[] = [];
  let current: { name: string; headingLine: number; bullets: HandoffBullet[] } | null = null;
  let pending: { line: number; parts: string[] } | null = null;

  const flushBullet = (): void => {
    if (pending === null) return;
    if (current !== null) {
      const joined = pending.parts.join(" ");
      current.bullets.push({ line: pending.line, text: joined, token: parseSrcToken(joined) });
    }
    pending = null;
  };
  const flush = (): void => {
    flushBullet();
    if (current !== null) sections.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = H2_RE.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      flush();
      headings.push(heading[1]);
      current = { name: heading[1], headingLine: i + 1, bullets: [] };
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      continue;
    }
    if (current === null) continue;
    const bullet = BULLET_RE.exec(line);
    if (bullet !== null && bullet[1] !== undefined) {
      flushBullet();
      pending = { line: i + 1, parts: [bullet[1]] };
      continue;
    }
    if (pending !== null && CONTINUATION_RE.test(line)) {
      pending.parts.push(line.trim());
      continue;
    }
    flushBullet();
  }
  flush();
  return { sections, headings };
}

/**
 * Every list item in a document, wherever it sits — no H2 sections required.
 *
 * `parseHandoff` above answers "what is in the four required sections"; this one
 * answers "what did this file assert, as items", for a document that is a list
 * and not a handoff — `01-what/success-metrics.md`, whose items are numbered and
 * sit under a single H1.
 *
 * It shares `BULLET_RE` and `CONTINUATION_RE` with the parser above on purpose:
 * two readers of "what is a bullet" would drift, and the whole reason this lives
 * here rather than beside its caller is that the rule has exactly one home.
 * Wrapped items are joined the same way, so an item keeps its trailing
 * `[src: …]` token whatever the line width was.
 */
export function listItems(text: string): readonly string[] {
  return parseItems(text).map((item) => item.text);
}

/** One list item anywhere in a document, with what a resolver needs to judge it. */
export interface DocumentItem {
  /** 1-based line number in the file. */
  readonly line: number;
  /** The item, wrapped continuation lines joined, marker removed. */
  readonly text: string;
  /** The nearest H2 heading above it, or `""` before the first one. */
  readonly section: string;
  readonly token: SrcToken | null;
}

/**
 * Every list item in a document, with its line and the H2 it sits under.
 *
 * `parseHandoff` answers "what is in the four required sections", which is the
 * §2.8 handoff rule; this answers "what did this file assert, as items, and
 * where" — the question a stage's OTHER declared outputs raise (issue #34).
 * `design.md` has no required sections and never will, but a `[src: …]` it does
 * write is a citation like any other, and until now nothing read it.
 *
 * It shares `BULLET_RE`, `CONTINUATION_RE` and `H2_RE` with the parser above for
 * the reason the comment there gives: two readers of "what is a bullet" drift,
 * and the looser one wins the argument at exactly the wrong moment. `section` is
 * carried because the §2.8 resolver's verdict depends on it — `$ … → exit n` is
 * legal in an `Evidence ledger` and nowhere else, whatever file it appears in.
 */
export function parseItems(text: string): readonly DocumentItem[] {
  const items: DocumentItem[] = [];
  let section = "";
  let pending: { line: number; parts: string[]; section: string } | null = null;
  const flush = (): void => {
    if (pending === null) return;
    const joined = pending.parts.join(" ");
    items.push({ line: pending.line, text: joined, section: pending.section, token: parseSrcToken(joined) });
    pending = null;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = H2_RE.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      flush();
      section = heading[1];
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet !== null && bullet[1] !== undefined) {
      flush();
      pending = { line: i + 1, parts: [bullet[1]], section };
      continue;
    }
    if (pending !== null && CONTINUATION_RE.test(line)) {
      pending.parts.push(line.trim());
      continue;
    }
    flush();
  }
  flush();
  return items;
}

/** True when the four required sections are all present, in order. */
export function isHandoff(text: string): boolean {
  return missingSections(parseHandoff(text)).length === 0;
}

/**
 * The required sections that are absent or out of order.
 *
 * `required` is a parameter rather than a constant because the four-section rule
 * is not the only place it applies: a gate evidence note (design §A.5) declares
 * its own four, in its own order, and reads them with this same function. The
 * default keeps every existing caller reading exactly the handoff's four.
 */
export function missingSections(
  handoff: Handoff,
  required: readonly string[] = HANDOFF_SECTIONS,
): readonly string[] {
  const present = handoff.headings;
  const missing: string[] = [];
  let cursor = 0;
  for (const name of required) {
    const at = present.indexOf(name, cursor);
    if (at === -1) missing.push(name);
    else cursor = at + 1;
  }
  return missing;
}

export interface HandoffIssue {
  readonly line: number;
  readonly message: string;
  /**
   * The `[src: …]` rule that refused it, when one did (gh #77).
   *
   * Optional because a RESOLUTION failure — "no such file", "that fact is
   * retired" — breaks no grammar rule; its message already names the thing that
   * was not there. A GRAMMAR failure carries the id, and every message builder
   * on this path turns it into the rule's own words plus a line that would pass.
   */
  readonly rule?: SrcRuleId;
  /**
   * The `src` this issue is about, VERBATIM — `ref.raw`, carried rather than
   * re-extracted (gh #110).
   *
   * `claim-sources` names the path behind every unchecked absence in its detail
   * line, and the only other way to get it there is a second regex over the
   * `[src: …]` marker. That is #80 exactly — one grammar, in one file — and
   * `test/map-citations.test.ts` refuses it on shape. So the reader that already
   * parsed the token hands the answer forward.
   */
  readonly src?: string;
}

/**
 * The three rules this module enforces that are about the DOCUMENT rather than
 * the token, written once, from the constants that enforce them.
 *
 * They are exported for the same reason `SRC_RULES` is: the deny message, the
 * gate's detail and the generated grammar contract must say the same sentence,
 * and three copies of a sentence is how they stop doing so.
 */
export const BULLET_RULE =
  `every list item under ${HANDOFF_SECTIONS.join(" / ")} ends with a \`[src: …]\` token`;
export const EMPTY_SECTION_RULE =
  `each of ${HANDOFF_SECTIONS.join(" / ")} holds at least one list item — prose alone is not a claim`;

/** A required section that is present but carries no list item. */
export interface EmptySection {
  readonly name: string;
  /** 1-based line of the `## <name>` heading. */
  readonly line: number;
}

export interface HandoffValidation {
  readonly ok: boolean;
  readonly missingSections: readonly string[];
  /** Required sections present but holding only prose (spec §2.8). */
  readonly emptySections: readonly EmptySection[];
  /** List items with no `[src:` marker at all — no citation was attempted. */
  readonly unsourced: readonly number[];
  /**
   * Items that DID try to cite (`[src:` is on the line) but whose token could not
   * be read as one — backticks around it, words after it, a stray bracket. Split
   * from `unsourced` because the fix is different and the old message sent a user
   * hunting for a citation that was already there.
   */
  readonly malformed: readonly HandoffIssue[];
  /** Bullets whose token is malformed, or cites something that does not resolve. */
  readonly unresolved: readonly HandoffIssue[];
  /**
   * Citations that are well formed and could NOT be checked from disk (spec §2.8,
   * `unverified`). These do not fail the stage; they are what an auto gate refuses
   * to close over.
   */
  readonly unverified: readonly HandoffIssue[];
  /**
   * `absent:` citations over a path that exists and holds content (spec §2.8,
   * `noted`). Legal and never fatal — but never silent either: this is the one
   * list `claim-sources` and the auto gate BOTH print, so an unchecked absence
   * cannot be waved through by one and refused by the other (gh #110).
   */
  readonly noted: readonly HandoffIssue[];
  readonly bulletCount: number;
}

/**
 * What `validateSections` measured over one document's required sections. The
 * handoff's own report is this plus `missingSections` and an `ok`; an evidence
 * note's report is this plus its front-matter findings.
 */
export interface SectionReport {
  /** Required sections present but holding only prose (spec §2.8). */
  readonly emptySections: readonly EmptySection[];
  /** Lines of list items with no `[src:` marker at all — no citation was attempted. */
  readonly unsourced: readonly number[];
  readonly malformed: readonly HandoffIssue[];
  readonly unresolved: readonly HandoffIssue[];
  readonly unverified: readonly HandoffIssue[];
  readonly noted: readonly HandoffIssue[];
  readonly bulletCount: number;
}

/** Cap from spec §2.8; beyond it the handoff is a document, not a handoff. */
export const MAX_BULLETS = 200;
export const BULLET_CAP_RULE =
  `a handoff carries at most ${String(MAX_BULLETS)} list items across the four sections — `
  + "beyond that cap it is a document, not a handoff";

/**
 * The half of the §2.8 rule that is about SECTIONS and their bullets, over any
 * set of required headings.
 *
 * Split out of `validateHandoff` because the handoff is no longer the only
 * document the rule governs. A gate evidence note (design §A.5) puts the same
 * rule on its own four sections — "a checklist whose own claims are unsourced is
 * the thing `claim-sources` exists to refuse, and an evidence note is a claim
 * about a claim". The one thing that must not happen is a SECOND implementation
 * of "is this bullet sourced": two readers of that question drift, and the looser
 * one would win the argument at exactly the moment a gate is being signed.
 *
 * `lineOffset` is added to every line number reported, for a document whose
 * sections begin partway down the file — an evidence note's body sits under its
 * YAML front matter. A handoff starts at line 1 and passes 0.
 */
/**
 * The one place a "you cited something I could not read" issue is built (gh #77).
 *
 * It used to be two copies of one sentence — "the token must be the last thing on
 * the line" — which is the right advice for ONE of the three ways a token fails
 * to tokenise and misleading for the other two. A nested `]` truncates the match
 * with the token sitting exactly where the message says it should; a live run
 * spent two guesses on that before reading the bundle. `diagnoseSrcToken` names
 * the rule that actually fired, and the id travels with the issue so every
 * renderer downstream can say it too.
 */
function citationIssue(line: number, text: string): HandoffIssue {
  const failure = diagnoseSrcToken(text);
  if (failure === null) {
    // `hasSrcMarker` was true, so something was attempted; the diagnosis only
    // returns null for a clean token, which this is not.
    return { line, message: "malformed citation — the `[src: …]` token could not be read" };
  }
  return { line, message: `malformed citation — ${failure.rule.rule}`, rule: failure.rule.id };
}

export function validateSections(
  handoff: Handoff,
  required: readonly string[],
  ctx: SrcContext,
  lineOffset = 0,
): SectionReport {
  const emptySections: EmptySection[] = [];
  const unsourced: number[] = [];
  const malformed: HandoffIssue[] = [];
  const unresolved: HandoffIssue[] = [];
  const unverified: HandoffIssue[] = [];
  const noted: HandoffIssue[] = [];
  let bulletCount = 0;

  const wanted = new Set<string>(required);
  for (const section of handoff.sections) {
    if (!wanted.has(section.name)) continue;
    if (section.bullets.length === 0) {
      emptySections.push({ name: section.name, line: section.headingLine + lineOffset });
    }
    for (const bullet of section.bullets) {
      bulletCount++;
      const line = bullet.line + lineOffset;
      if (bullet.token === null) {
        if (hasSrcMarker(bullet.text)) malformed.push(citationIssue(line, bullet.text));
        else unsourced.push(line);
        continue;
      }
      for (const error of bullet.token.errors) {
        unresolved.push({ line, message: `[src: ${error.raw}] — ${error.message}`, rule: error.rule });
      }
      // The claim is the bullet WITHOUT its citation. `absent:` reads this text to
      // decide whether the claim is negative, and `[src: absent:…]` contains the
      // word "absent" — leaving the token in would have every absence vouch for
      // itself.
      const claim = bullet.text.replace(bullet.token.raw, " ").trim();
      for (const ref of bullet.token.refs) {
        const resolution = resolveSrc(ref, ctx, section.name, claim);
        const issue = { line, message: `[src: ${ref.raw}] — ${resolution.message ?? "unresolvable"}` };
        if (resolution.outcome === "refused") unresolved.push(issue);
        else if (resolution.outcome === "unverified") unverified.push(issue);
        else if (resolution.outcome === "noted") noted.push({ ...issue, src: ref.raw });
      }
    }
  }
  return { emptySections, unsourced, malformed, unresolved, unverified, noted, bulletCount };
}

export function validateHandoff(text: string, ctx: SrcContext): HandoffValidation {
  const handoff = parseHandoff(text);
  const missing = missingSections(handoff);
  const report = validateSections(handoff, HANDOFF_SECTIONS, ctx);
  const unresolved = [...report.unresolved];
  if (report.bulletCount > MAX_BULLETS) {
    unresolved.push({ line: 0, message: `${String(report.bulletCount)} bullets — ${BULLET_CAP_RULE}` });
  }
  return {
    // `unverified` is deliberately NOT here: it does not fail the stage (spec §2.8),
    // it stops an AUTO gate from closing (spec §5, condition 5).
    ok:
      missing.length === 0 && report.emptySections.length === 0 && report.unsourced.length === 0 &&
      report.malformed.length === 0 && unresolved.length === 0,
    missingSections: missing,
    emptySections: report.emptySections,
    unsourced: report.unsourced,
    malformed: report.malformed,
    unresolved,
    unverified: report.unverified,
    noted: report.noted,
    bulletCount: report.bulletCount,
  };
}

/** What `validateCitations` measured over a document that is not a handoff. */
export interface CitationReport {
  readonly malformed: readonly HandoffIssue[];
  readonly unresolved: readonly HandoffIssue[];
  readonly unverified: readonly HandoffIssue[];
  /** `absent:` over a path that exists with content — see `HandoffValidation`. */
  readonly noted: readonly HandoffIssue[];
  /** How many list items attempted a citation at all. */
  readonly cited: number;
}

/**
 * The §2.8 grammar over a document that is NOT a handoff (issue #34).
 *
 * `claim-sources` used to filter its stage's outputs down to `handoff.md`, so the
 * same violation refused the stage in one file and passed silently in the file
 * beside it — measured live 2026-08-31, where a pass-3 violation was caught only
 * because it happened to be written in the handoff. Every declared `.md` output
 * is checked now, and this is the rule applied to the ones that have no required
 * sections to check.
 *
 * It judges CITATIONS, not claims. A `design.md` bullet that cites nothing is
 * prose, and prose in a design document is not the thing §2.8 exists to refuse —
 * the four-section "every bullet is sourced" rule stays exactly where it was, on
 * the handoff. What is refused here is a citation that was WRITTEN and is not
 * true: a token nothing can parse, a file that is not there, a `$ … → exit n`
 * outside an Evidence ledger. That asymmetry is the deliberate one; the accidental
 * one — a whole file nothing looked at — is what this closes.
 */
export function validateCitations(text: string, ctx: SrcContext): CitationReport {
  const malformed: HandoffIssue[] = [];
  const unresolved: HandoffIssue[] = [];
  const unverified: HandoffIssue[] = [];
  const noted: HandoffIssue[] = [];
  let cited = 0;
  for (const item of parseItems(text)) {
    if (item.token === null) {
      if (!hasSrcMarker(item.text)) continue;
      cited++;
      malformed.push(citationIssue(item.line, item.text));
      continue;
    }
    cited++;
    for (const error of item.token.errors) {
      unresolved.push({ line: item.line, message: `[src: ${error.raw}] — ${error.message}`, rule: error.rule });
    }
    const claim = item.text.replace(item.token.raw, " ").trim();
    for (const ref of item.token.refs) {
      const resolution = resolveSrc(ref, ctx, item.section, claim);
      const issue = { line: item.line, message: `[src: ${ref.raw}] — ${resolution.message ?? "unresolvable"}` };
      if (resolution.outcome === "refused") unresolved.push(issue);
      else if (resolution.outcome === "unverified") unverified.push(issue);
      else if (resolution.outcome === "noted") noted.push({ ...issue, src: ref.raw });
    }
  }
  return { malformed, unresolved, unverified, noted, cited };
}

/** Every `src` cited anywhere in the handoff — used by `replay` and the ledger. */
export function collectSrcRefs(handoff: Handoff): readonly SrcRef[] {
  const refs: SrcRef[] = [];
  for (const section of handoff.sections) {
    for (const bullet of section.bullets) {
      if (bullet.token !== null) refs.push(...bullet.token.refs);
    }
  }
  return refs;
}

export { parseSrcToken, classifySrc, resolveSrc, emptySrcContext, hasSrcMarker } from "./srcToken.ts";
export type { SrcContext, SrcRef, SrcToken, SrcKind, SrcParseError, SrcOutcome } from "./srcToken.ts";

/** The line a genuinely empty section is written as (spec §2.8). */
export function noneBullet(lookedAt: string): string {
  return `- none [src: absent:${lookedAt}]`;
}
