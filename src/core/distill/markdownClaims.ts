/**
 * Turning AI-DLC prose into claims.
 *
 * Spec §6: "every markdown bullet/paragraph under a heading becomes a Finding".
 * The two rules that matter: content before the first heading is not a claim (it
 * has no subject), and a claim carries the line its first line sat on, because the
 * `[src: aidlc:<file>:<line>]` tag has to point somewhere a human can look.
 *
 * AI-DLC's own grounding tags (`[Q3]`, `[desc]`, `[scope]`, `[memory]`) are stripped:
 * they are provenance in *its* notation, and the imported claim carries provenance
 * in ours.
 */
import { unclosedSrcMarker } from "../text/srcToken.ts";

/** A claim longer than this is truncated — a handoff bullet has to stay readable. */
export const MAX_CLAIM_CHARS = 240;

export interface ProseClaim {
  readonly text: string;
  /** 1-based line of the claim's first line. */
  readonly line: number;
  /** The nearest preceding heading, verbatim. */
  readonly heading: string;
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;
const BULLET_RE = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+(\S.*)$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const GROUNDING_TAG_RE = /\[(?:Q\d{1,6}|desc|scope|memory)\]/g;

export interface ProseOptions {
  /**
   * Heading to attribute content that appears BEFORE the first heading.
   * AI-DLC artefacts always open with one, so `--from` leaves this unset and
   * pre-heading prose is dropped as subject-less. A hand-written requirements
   * document often does not, and dropping its first paragraph would lose the
   * only sentence that says what the project is — so `--seed` passes the file
   * name. `[assumption]`
   */
  readonly fallbackHeading?: string;
}

export function extractProseClaims(text: string, options: ProseOptions = {}): readonly ProseClaim[] {
  const lines = text.split("\n");
  const claims: ProseClaim[] = [];
  let heading: string | null = options.fallbackHeading ?? null;
  let inFence = false;
  /** The claim currently being accumulated — a bullet or a paragraph, same thing here. */
  let open: { line: number; parts: string[] } | null = null;

  const flush = (): void => {
    if (open === null) return;
    const claim = clean(open.parts.join(" "));
    if (claim !== "" && heading !== null) claims.push({ text: claim, line: open.line, heading });
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    if (FENCE_RE.test(raw)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const isHeading = HEADING_RE.exec(raw);
    if (isHeading !== null && isHeading[1] !== undefined) {
      flush();
      heading = isHeading[1];
      continue;
    }
    if (raw.trim() === "") {
      flush();
      continue;
    }
    if (heading === null) continue;

    // Tables, HTML comments and AI-DLC's own answer slots are layout, not claims.
    const head = raw.trimStart();
    if (head.startsWith("|") || head.startsWith("<!--") || head.startsWith("[Answer]:")) {
      flush();
      continue;
    }

    const bullet = BULLET_RE.exec(raw);
    if (bullet !== null && bullet[1] !== undefined) {
      flush();
      open = { line: i + 1, parts: [bullet[1]] };
      continue;
    }

    // A hard-wrapped continuation belongs to the claim above it, not to a new one.
    if (open === null) open = { line: i + 1, parts: [raw.trim()] };
    else open.parts.push(raw.trim());
  }
  flush();
  return claims;
}

/**
 * Strip AI-DLC grounding tags, collapse whitespace, truncate, drop a trailing full stop run.
 *
 * The cut never lands inside a `[src: …]` citation (gh #275). It used to: a seed
 * bullet of 248 characters was cut at 239, leaving `… [src: notes/desi…`, and
 * `renderSeed` then appended the importer's own token — whose `]` closed the
 * dangling marker, so the reader saw ONE file ref whose path was two citations
 * glued together. `tldrx run new --seed` refused three field seeds in a row
 * naming a path that appears nowhere in the document, which tells the author
 * nothing about the cure.
 *
 * So when the cut falls inside a citation, it moves BACK to that citation's
 * start: the over-long bullet loses the citation it could not fit rather than
 * half of it, and the importer cites the seed line on the rendered bullet anyway,
 * so the provenance that matters survives. Truncation is unchanged for every
 * claim whose cut lands in prose — the alternative (strip citations before
 * measuring) would rewrite short claims too, which are not broken.
 *
 * A claim that is NOTHING but a citation has no prose to keep: it is returned
 * whole rather than cut to an ellipsis, because an invented path and a vanished
 * claim are both worse than one long bullet.
 */
export function clean(text: string): string {
  const stripped = text
    .replace(GROUNDING_TAG_RE, "")
    .replace(/\s+/g, " ")
    .replace(/\*\*/g, "")
    .trim();
  if (stripped.length <= MAX_CLAIM_CHARS) return stripped;
  const cut = stripped.slice(0, MAX_CLAIM_CHARS - 1);
  const open = unclosedSrcMarker(cut);
  if (open === null) return `${cut.trimEnd()}…`;
  const kept = cut.slice(0, open).trimEnd();
  return kept === "" ? stripped : `${kept}…`;
}
