/** One row of `.tldrx/memory/facts.yml` (spec §2.5). */

export const FACT_KINDS = ["answer", "observed", "derived"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_CONFIDENCES = ["measured", "inferred", "stated"] as const;
export type FactConfidence = (typeof FACT_CONFIDENCES)[number];

/** Spec §2.5: beyond this `tldrx` shards by `area`. */
export const MAX_FACTS = 5000;
/**
 * Spec §2.5: `fact` is one assertion, ≤2000 chars.
 *
 * It was 300, and 300 lost the sentence that mattered. `captureAnswers` writes a
 * fact as `"<question> — <answer>"`, so on the aparece run of 2026-08-30 every
 * one of the six answers was cut mid-clause and four of them lost the very words
 * — "Accepts ADR-D009 as written." — that name the document the answer settles.
 * The developer downstream never saw them.
 *
 * 2000 is still a cap: a fact is one assertion, not a document. Facts already on
 * disk stay valid, because the bound only moved outwards.
 */
export const MAX_FACT_CHARS = 2000;

export interface FactSource {
  readonly who: string;
  readonly when: string;
  readonly run: string | null;
  readonly q: string | null;
}

export interface FactRetirement {
  readonly at: string | null;
  readonly by: string | null;
  readonly reason: string | null;
}

export interface Fact {
  readonly id: string;
  readonly fact: string;
  readonly area: string;
  readonly repos: readonly string[];
  readonly kind: FactKind;
  readonly confidence: FactConfidence;
  readonly source: FactSource;
  readonly supersedes: string | null;
  readonly superseded_by: string | null;
  readonly retired: FactRetirement | null;
  /**
   * True when `fact` is the head of a longer text, cut at `MAX_FACT_CHARS`.
   *
   * Additive and optional: every row written before this field existed is still
   * valid, and its absence means "not known to be cut", never "whole". A reader
   * that sees it knows to go to `01-what/questions.md` for the rest.
   */
  readonly truncated?: boolean;
}

export interface FactsFile {
  readonly version: number;
  readonly facts: readonly Fact[];
}

/** Everything but the id, which the store assigns. */
export type NewFact = Omit<Fact, "id" | "supersedes" | "superseded_by" | "retired"> &
  Partial<Pick<Fact, "supersedes" | "superseded_by" | "retired">>;

export function isRetired(fact: Fact): boolean {
  return fact.retired !== null && fact.retired.at !== null;
}

/**
 * A fact a later answer replaced. Its text is still true OF THE MOMENT it was
 * recorded, which is why supersession never edits it — but it is no longer what
 * the workspace believes, so nothing that FEEDS a decision may read it.
 */
export function isSuperseded(fact: Fact): boolean {
  return fact.superseded_by !== null;
}

/**
 * The one predicate every consumer of facts should filter on.
 *
 * Measured 2026-08-31: `superseded_by` was in the §2.5 schema from the first
 * draft and no command wrote it, so every reader in `src/` filtered on
 * `isRetired` alone. The day an owner reversed an answered decision, the reversal
 * had to be hand-edited into facts.yml — and had the old row kept
 * `superseded_by: null`, the no-re-ask hook, every `{{facts}}` block and the
 * training miner would have gone on serving the reversed decision as
 * never-re-ask truth. Retirement and supersession are two ways for a fact to stop
 * being current; a reader that only knows one of them is a reader with a hole in
 * it.
 *
 * History readers — `tldrx replay`, `tldrx retro` — deliberately do NOT use this:
 * a superseded fact is shown, labelled with what replaced it.
 */
export function isLive(fact: Fact): boolean {
  return !isRetired(fact) && !isSuperseded(fact);
}

export function factNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

export function formatFactId(n: number): string {
  return `F${String(n).padStart(3, "0")}`;
}
