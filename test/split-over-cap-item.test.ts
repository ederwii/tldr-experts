/**
 * `splitOverCapItem` (gh #352, part of the #345 family) — the mechanical,
 * VERIFIED split of one over-cap acceptance/test_plan item, never a guess.
 */
import { describe, expect, test } from "bun:test";
import { splitOverCapItem } from "../src/core/text/listSplit.ts";
import { parseSrcToken } from "../src/core/text/srcToken.ts";

const CAP = 512;
const TOKEN = "[src: api:src/Leaderboard.cs:3]";

/** A sentence at least `min` characters, padded with `filler` words, ending `.`. */
function sentence(lead: string, min: number, filler = "word"): string {
  let s = lead;
  while (s.length < min) s += ` ${filler}`;
  return s.endsWith(".") ? s : `${s}.`;
}

describe("splitOverCapItem", () => {
  test("a two-sentence item with a trailing [src:] token splits into two pieces, each carrying the token", () => {
    const first = sentence("First sentence explains the criterion in detail", 300);
    const second = sentence("Second sentence adds the rest of the criterion", 300);
    const item = `${first} ${second} ${TOKEN}`;
    expect(item.length).toBeGreaterThan(CAP);

    const pieces = splitOverCapItem(item, CAP);

    expect(pieces).not.toBeNull();
    expect(pieces).toHaveLength(2);
    const [p1, p2] = pieces ?? [];
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    for (const piece of pieces ?? []) {
      expect(piece.length).toBeLessThanOrEqual(CAP);
      expect(piece.endsWith(TOKEN)).toBe(true);
      // Every piece still carries a token that PARSES — never a guess, never a
      // fragment of the original citation.
      const parsed = parseSrcToken(piece);
      expect(parsed?.errors ?? ["no token"]).toEqual([]);
    }
    // The citation was copied VERBATIM, never invented: both pieces cite the
    // same evidence the original single item did.
    expect(p1?.endsWith(TOKEN)).toBe(true);
    expect(p2?.endsWith(TOKEN)).toBe(true);
    // The claim text survives, split at the sentence boundary — nothing lost.
    expect(`${p1} ${p2}`).toContain(first.slice(0, 20));
    expect(`${p1} ${p2}`).toContain(second.slice(0, 20));
  });

  test("a single run-on sentence with no boundary returns null — no partial credit", () => {
    const item = `${sentence("One long run-on claim with no sentence break at all, just commas and words", 600)} ${TOKEN}`;
    expect(item.length).toBeGreaterThan(CAP);

    expect(splitOverCapItem(item, CAP)).toBeNull();
  });

  test("an item already at or under the cap returns null — nothing to split", () => {
    expect(splitOverCapItem("short and fine [src: api:src/Leaderboard.cs:3]", CAP)).toBeNull();
  });

  test("a split whose token pushes a piece back over the cap returns null", () => {
    // Two short sentences, but the cap is set so tight that even one sentence
    // plus the token cannot fit.
    const item = `Short one. Short two. ${TOKEN}`;
    expect(splitOverCapItem(item, 5)).toBeNull();
  });

  test("a boundary found ONLY inside the [src:] token span is never used — the token is set aside first", () => {
    // The token's own text contains no boundary punctuation the regex would
    // fire on, but this guards the mechanism itself: the body handed to the
    // boundary search excludes the token span entirely.
    const body = sentence("A single claim with no internal boundary", 550);
    const item = `${body} ${TOKEN}`;
    const pieces = splitOverCapItem(item, CAP);
    // No mid-sentence boundary exists in `body` itself (padding is one long
    // run of "word" tokens with no `. ` `; ` `? ` `! ` before a capital or a
    // list marker), so this must refuse rather than manufacture a cut inside
    // the token.
    expect(pieces).toBeNull();
  });

  /**
   * A boundary that DOES exist, but only inside the token span — a `[src:]`
   * marker's content is free text to `trailingTokenSpan` (it only finds the
   * span, never validates what is inside it), so `A. B` inside a token is a
   * real match for `BOUNDARY_RE`. If the exclusion in `splitOverCapItem` ever
   * regresses to searching the WHOLE item instead of the body outside the
   * token span, this is what would slice the token itself into two ragged
   * halves — caught here at the unit level, before `repairOverCapItems`'s own
   * re-validate guard would have to catch the malformed result downstream.
   */
  test("a sentence boundary sitting INSIDE the token span is never counted as a cut point", () => {
    const first = sentence("First real sentence before the token", 250);
    const second = sentence("Second real sentence before the token", 250);
    // The token's own inner text carries a `. ` + uppercase — a boundary shape
    // — that must never be used as a cut point.
    const trickyToken = "[src: A. Ragged-inner-boundary-that-must-never-be-cut]";
    const item = `${first} ${second} ${trickyToken}`;
    expect(item.length).toBeGreaterThan(CAP);

    const pieces = splitOverCapItem(item, CAP);

    // Exactly ONE real boundary exists outside the token (between `first` and
    // `second`), so a correct split produces exactly two pieces — the token's
    // own internal ". R" is never treated as a second cut point, and every
    // piece carries the WHOLE, unbroken token.
    expect(pieces).not.toBeNull();
    expect(pieces).toHaveLength(2);
    for (const piece of pieces ?? []) expect(piece.endsWith(trickyToken)).toBe(true);
  });
});
