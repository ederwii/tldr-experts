/**
 * Turning seed documents into Findings.
 *
 * The rule is the same one `--from` uses (`distill/markdownClaims.ts`): every
 * bullet and every paragraph under a heading is one claim, carrying the line it
 * started on. Two differences, both because a hand-written requirements document
 * is not an AI-DLC artefact:
 *
 *  1. Prose before the first heading is kept, attributed to the file name.
 *     A requirements doc that opens with a paragraph says what the project IS,
 *     and dropping it as subject-less would lose the most important sentence.
 *     `[assumption]`
 *  2. A heading with nothing under it still becomes a Finding. "Every heading,
 *     bullet and paragraph is distilled" has to mean nothing is dropped in
 *     silence — an empty `## Open questions` is itself information. A heading
 *     followed immediately by a DEEPER heading is not empty, it is a container
 *     (every document's `# Title` is one), and reporting those would add a noise
 *     bullet to every import. A heading followed by one at the same or a shallower
 *     level really is an empty section. `[assumption]`
 *
 * The `src` is `<workspace-relative path>:<line>`, the §2.8 `file` production with
 * no repo prefix, which resolves against the workspace root.
 */
import { extractProseClaims } from "../distill/markdownClaims.ts";
import type { SeedDocument } from "./collectSeed.ts";

export interface SeedHeading {
  readonly text: string;
  /** 1-based. */
  readonly line: number;
  readonly file: string;
  /** 1–6, from the number of `#`. */
  readonly level: number;
  /** True when the next heading is DEEPER: a container, not an empty section. */
  readonly container: boolean;
}

export interface SeedClaim {
  readonly text: string;
  /** The `[src: …]` token body: `<path>:<line>`. */
  readonly src: string;
  readonly file: string;
  readonly line: number;
  readonly heading: string;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(?:```|~~~)/;

/** Headings of one document, in file order, ignoring fenced code. */
export function seedHeadings(document: SeedDocument): readonly SeedHeading[] {
  const headings: SeedHeading[] = [];
  const lines = document.text.split("\n");
  let inFence = false;
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = HEADING_RE.exec(line);
    if (match?.[2] === undefined) return;
    const level = (match[1] ?? "#").length;
    headings.push({
      text: match[2],
      line: index + 1,
      file: document.rel,
      level,
      container: (nextHeadingLevel(lines, index) ?? 0) > level,
    });
  });
  return headings;
}

/** Depth of the next non-blank line when it is a heading, else null. */
function nextHeadingLevel(lines: readonly string[], from: number): number | null {
  for (let i = from + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const match = HEADING_RE.exec(line);
    return match?.[1] === undefined ? null : match[1].length;
  }
  return null;
}

export function seedClaims(documents: readonly SeedDocument[]): readonly SeedClaim[] {
  const claims: SeedClaim[] = [];
  for (const document of documents) {
    const fileName = document.rel.split("/").pop() ?? document.rel;
    const extracted = extractProseClaims(document.text, { fallbackHeading: fileName });
    const covered = new Set(extracted.map((claim) => claim.heading));

    for (const claim of extracted) {
      claims.push({
        text: claim.text,
        src: `${document.rel}:${claim.line}`,
        file: document.rel,
        line: claim.line,
        heading: claim.heading,
      });
    }
    // Headings that produced nothing: kept, so the handoff accounts for the whole
    // document rather than only its populated sections.
    for (const heading of seedHeadings(document)) {
      if (covered.has(heading.text) || heading.container) continue;
      claims.push({
        text: `Section "${heading.text}" is declared in the seed with no content under it`,
        src: `${document.rel}:${heading.line}`,
        file: document.rel,
        line: heading.line,
        heading: heading.text,
      });
    }
  }
  return claims.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/** Every heading across the seed, used by the coverage check. */
export function allSeedHeadings(documents: readonly SeedDocument[]): readonly SeedHeading[] {
  return documents.flatMap((document) => seedHeadings(document));
}
