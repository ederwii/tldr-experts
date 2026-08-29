/**
 * `tldrx-work/<run>/<phase>/handoff.md` (spec §2.8).
 *
 * Four H2 sections, in order, and **every `- ` bullet inside them ends with a
 * `[src: …]` token**. This module splits the sections, finds the bullets, and
 * reports the offending line numbers — the claim-sources hook turns that report
 * into a deny message and nothing else.
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
/** A bullet: `- text`, tolerating up to three spaces of indent. [assumption] */
const BULLET_RE = /^ {0,3}-\s+(\S.*)$/;

export function parseHandoff(text: string): Handoff {
  const lines = text.split("\n");
  const sections: HandoffSection[] = [];
  const headings: string[] = [];
  let current: { name: string; headingLine: number; bullets: HandoffBullet[] } | null = null;

  const flush = (): void => {
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
      current.bullets.push({ line: i + 1, text: bullet[1], token: parseSrcToken(line) });
    }
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

export interface HandoffValidation {
  readonly ok: boolean;
  readonly missingSections: readonly string[];
  /** Bullets with no `[src: …]` token at all. */
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
  const unsourced: number[] = [];
  const unresolved: HandoffIssue[] = [];
  let bulletCount = 0;

  const required = new Set<string>(HANDOFF_SECTIONS);
  for (const section of handoff.sections) {
    if (!required.has(section.name)) continue;
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
    ok: missing.length === 0 && unsourced.length === 0 && unresolved.length === 0,
    missingSections: missing,
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
