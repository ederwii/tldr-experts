/**
 * Splitting one over-cap plan-list item into several under-cap ones (gh #352,
 * part of the #345 family).
 *
 * `requireStringList`'s own refusal (`planCommon.ts`) already tells a writer to
 * "split it into several items" — this is that transform, done mechanically and
 * for $0.00, the same shape #345 gave `[src:]` punctuation: a fix offered only
 * when it can be VERIFIED, never a guess.
 *
 * The one rule that makes this safe to do without a model: a split may never cut
 * INSIDE a trailing `[src: …]` citation, and it may never DROP one. `[src:]`'s
 * own span finder (`trailingTokenSpan`, `srcToken.ts`) is reused rather than
 * re-found here — one derivation (AGENTS.md §7) — so a citation this module
 * treats as "the trailing token" is exactly what `srcToken.ts` would repair or
 * refuse the same line over.
 */
import { trailingTokenSpan } from "./srcToken.ts";

/**
 * A sentence boundary a split may cut at: `.`, `;`, `?` or `!` followed by ONE
 * space and then either an uppercase letter (the next sentence) or a list
 * marker (`- `/`* `) — never a lowercase word, an abbreviation or a decimal,
 * which this pattern is deliberately blind to rather than guess at.
 */
const BOUNDARY_RE = /[.;?!] (?=[A-Z]|[-*]\s)/g;

/**
 * Split `item` into pieces all `<= cap` characters, or `null` when no split
 * this function can find would satisfy that — the caller's original refusal
 * then stands, byte-identical.
 *
 * The trailing `[src: …]` token, if there is one, is never cut and never
 * dropped: it is set aside before any boundary is looked for (so a boundary
 * inside it can never be found in the first place) and reattached, VERBATIM, to
 * every resulting piece — each piece is a full claim in its own right, citing
 * the same evidence the original line did, never a guess at a narrower one. A
 * caller that needs the piece to re-validate as a citation (grammar, and
 * whatever the original line's own validator checks) does that itself — this
 * function only guarantees the SHAPE: pieces, each `<= cap`, each carrying the
 * token the original line carried.
 *
 * `null` on: an item already `<= cap` (nothing to do), no boundary found
 * outside the token span, a "split" of fewer than two non-empty pieces, or any
 * resulting piece still over `cap` (the token itself can push a short piece
 * over — no partial credit, the same rule `repairSrcTokenLine` applies).
 */
export function splitOverCapItem(item: string, cap: number): readonly string[] | null {
  if (item.length <= cap) return null;
  const span = trailingTokenSpan(item);
  const token = span === null ? null : item.slice(span.start, span.end);
  const body = (span === null ? item : item.slice(0, span.start)).trimEnd();

  const cuts: number[] = [];
  BOUNDARY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOUNDARY_RE.exec(body)) !== null) cuts.push(match.index + 1);
  if (cuts.length === 0) return null;

  const raw: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    raw.push(body.slice(start, cut).trim());
    start = cut;
  }
  raw.push(body.slice(start).trim());
  const pieces = raw.filter((piece) => piece !== "");
  if (pieces.length < 2) return null;

  const withToken = token === null ? pieces : pieces.map((piece) => `${piece} ${token}`);
  return withToken.every((piece) => piece.length <= cap) ? withToken : null;
}
