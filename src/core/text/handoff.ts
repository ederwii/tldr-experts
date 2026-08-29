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
  parseSrcToken, resolveSrc, type SrcContext, type SrcRef, type SrcToken,
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

/** True when the four required sections are all present, in order. */
export function isHandoff(text: string): boolean {
  return missingSections(parseHandoff(text)).length === 0;
}

/** The required sections that are absent or out of order. */
export function missingSections(handoff: Handoff): readonly string[] {
  const present = handoff.headings;
  const missing: string[] = [];
  let cursor = 0;
  for (const required of HANDOFF_SECTIONS) {
    const at = present.indexOf(required, cursor);
    if (at === -1) missing.push(required);
    else cursor = at + 1;
  }
  return missing;
}

export interface HandoffIssue {
  readonly line: number;
  readonly message: string;
}

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
  /** List items with no `[src: …]` token at all. */
  readonly unsourced: readonly number[];
  /** Bullets whose token is malformed, or cites something that does not resolve. */
  readonly unresolved: readonly HandoffIssue[];
  readonly bulletCount: number;
}

/** Cap from spec §2.8; beyond it the handoff is a document, not a handoff. */
export const MAX_BULLETS = 200;

export function validateHandoff(text: string, ctx: SrcContext): HandoffValidation {
  const handoff = parseHandoff(text);
  const missing = missingSections(handoff);
  const emptySections: EmptySection[] = [];
  const unsourced: number[] = [];
  const unresolved: HandoffIssue[] = [];
  let bulletCount = 0;

  const required = new Set<string>(HANDOFF_SECTIONS);
  for (const section of handoff.sections) {
    if (!required.has(section.name)) continue;
    if (section.bullets.length === 0) {
      emptySections.push({ name: section.name, line: section.headingLine });
    }
    for (const bullet of section.bullets) {
      bulletCount++;
      if (bullet.token === null) {
        unsourced.push(bullet.line);
        continue;
      }
      for (const error of bullet.token.errors) {
        unresolved.push({ line: bullet.line, message: `[src: ${error.raw}] — ${error.message}` });
      }
      for (const ref of bullet.token.refs) {
        const resolution = resolveSrc(ref, ctx, section.name);
        if (!resolution.ok) {
          unresolved.push({ line: bullet.line, message: `[src: ${ref.raw}] — ${resolution.message ?? "unresolvable"}` });
        }
      }
    }
  }
  if (bulletCount > MAX_BULLETS) {
    unresolved.push({ line: 0, message: `${bulletCount} bullets exceeds the ${MAX_BULLETS} cap` });
  }
  return {
    ok: missing.length === 0 && emptySections.length === 0 && unsourced.length === 0 && unresolved.length === 0,
    missingSections: missing,
    emptySections,
    unsourced,
    unresolved,
    bulletCount,
  };
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

export { parseSrcToken, classifySrc, resolveSrc, emptySrcContext } from "./srcToken.ts";
export type { SrcContext, SrcRef, SrcToken, SrcKind, SrcParseError } from "./srcToken.ts";

/** The line a genuinely empty section is written as (spec §2.8). */
export function noneBullet(lookedAt: string): string {
  return `- none [src: absent:${lookedAt}]`;
}
