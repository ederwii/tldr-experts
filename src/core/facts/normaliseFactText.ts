/**
 * Text-equality dedupe for `.tldrx/memory/facts.yml` (gh #216 parts A/B).
 *
 * ONE derivation of "same fact, different typing": trim, collapse internal
 * whitespace runs to a single space, case-fold. `FactsStore.append` (part A) and
 * `tldrx facts dedupe` (part B) both compare on this — a driver's paraphrase of
 * spacing or case must never fork into two rows nobody notices, and a second,
 * slightly different comparator in the dedupe command would be exactly the
 * "second derivation" §7 refuses.
 *
 * Deliberately NOT a fuzzy match: `findDuplicate.ts`'s Jaccard/token comparison
 * already exists for "these two probably mean the same thing" (question vs.
 * fact, for the no-re-ask hook) and stays untouched. This is narrower and
 * mechanical — "these two are the same sentence, typed twice."
 */
export function normaliseFactText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
