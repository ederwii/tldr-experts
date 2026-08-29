/**
 * "Never ask what you already know" (concept §1.2), made mechanical.
 *
 * `[assumption from spec]` — spec §4 says "Jaccard ≥ 0.6 on ≥4-char tokens" and
 * leaves the rest open. Taken here: a hit needs the SAME `area`, tokens are
 * lower-cased alphanumeric runs of ≥4 characters, retired facts are ignored, and
 * when several facts hit, the highest id (the newest) wins.
 */
import { isRetired, type Fact } from "./Fact.ts";

export const DEFAULT_JACCARD_THRESHOLD = 0.6;
export const MIN_TOKEN_LENGTH = 4;

const WORD_RE = /[a-z0-9]+/g;

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().matchAll(WORD_RE)) {
    const token = word[0];
    if (token.length >= MIN_TOKEN_LENGTH) tokens.add(token);
  }
  return tokens;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateHit {
  readonly fact: Fact;
  readonly score: number;
}

/**
 * The fact that already answers `question`, or null.
 * `area` must match exactly — the same words in a different area are a different question.
 */
export function findDuplicate(
  question: string,
  area: string,
  facts: readonly Fact[],
  threshold: number = DEFAULT_JACCARD_THRESHOLD,
): DuplicateHit | null {
  const asked = tokenize(question);
  if (asked.size === 0) return null;
  let best: DuplicateHit | null = null;
  for (const fact of facts) {
    if (fact.area !== area) continue;
    if (isRetired(fact)) continue;
    const score = jaccard(asked, tokenize(fact.fact));
    if (score < threshold) continue;
    if (best === null || score > best.score || (score === best.score && fact.id > best.fact.id)) {
      best = { fact, score };
    }
  }
  return best;
}
