/**
 * `(owner: <name>)` on one watcher-card item (gh #70).
 *
 * `watch check` v1 answered "who owns this signal" by DERIVING a repo from the
 * item's own citation — `[src: api:src/Leaderboard.cs:64]` → `api`. That was the
 * right call for v1 and it is still the fallback, but it answers a different
 * question from the one #70 was filed about: which repo EMITS a signal is not who
 * gets paged when it stops.
 *
 * The owner decision of 2026-09-01 made the name optional and per item. So it is
 * an annotation on the bullet rather than a second required key: a card written
 * before this module existed carries none, still validates, and still prints the
 * derived line unchanged.
 *
 * ## Why it sits BEFORE the `[src: …]` token
 *
 * Not a style choice. §2.8 says the token is the last thing on the line, and
 * `handoff.ts` enforces exactly that — an annotation after it would make every
 * annotated item a malformed citation. So the grammar is
 * `- <claim> (owner: <name>) [src: …]`, and the claim keeps its own words: the
 * annotation is left IN the text `watch check` prints, because a checklist item is
 * quoted, never paraphrased.
 *
 * ## Why an empty one is an error rather than an absence
 *
 * `(owner: )` is not a card that declined to name somebody — it is a card that
 * TRIED and lost the name. Reading it as "nobody declared" would hand the reader a
 * repo name in place of a human the author meant to write, which is the exact
 * substitution this whole issue is about. So it is a shape issue, and the stage
 * that wrote it is told.
 */

/** How long a name may be. A card is a document; this is a name, not a paragraph. */
export const MAX_OWNER_CHARS = 64;

/** `(owner: <name>)` — anywhere on the line, but in practice before the token. */
const OWNER_RE = /\(owner:\s*([^)\n]*)\)/i;
/** An `(owner:` that never closes. Caught so it is reported, not ignored. */
const OWNER_OPENED_RE = /\(owner:/i;

export interface ItemOwner {
  /** The declared name, or null when the item declares none. */
  readonly owner: string | null;
  /** True when a name was attempted and cannot be read. */
  readonly malformed: boolean;
  /** Why it is malformed, ready for a card issue. "" when it is not. */
  readonly reason: string;
}

const NONE: ItemOwner = { owner: null, malformed: false, reason: "" };

/**
 * The owner one item declares — never a guess, and never the card's.
 *
 * The card-level fallback and the repo-derived one are applied by the caller
 * (`signalChecklist.ts`), which is the only place that knows both. This function
 * answers exactly one question: what does THIS line say.
 */
export function itemOwner(text: string): ItemOwner {
  const match = OWNER_RE.exec(text);
  if (match === null) {
    if (!OWNER_OPENED_RE.test(text)) return NONE;
    return {
      owner: null,
      malformed: true,
      reason: "`(owner:` is never closed — write `(owner: <name>)` before the `[src: …]` token",
    };
  }
  const name = (match[1] ?? "").trim();
  if (name === "") {
    return {
      owner: null,
      malformed: true,
      reason: "`(owner: …)` names nobody — write a name, or leave the annotation off entirely",
    };
  }
  if (name.length > MAX_OWNER_CHARS) {
    return {
      owner: null,
      malformed: true,
      reason: `the owner name is ${String(name.length)} characters, over the ${String(MAX_OWNER_CHARS)}-character cap`,
    };
  }
  return { owner: name, malformed: false, reason: "" };
}
