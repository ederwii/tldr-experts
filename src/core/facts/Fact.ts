/** One row of `.tldrx/memory/facts.yml` (spec §2.5). */

export const FACT_KINDS = ["answer", "observed", "derived"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_CONFIDENCES = ["measured", "inferred", "stated"] as const;
export type FactConfidence = (typeof FACT_CONFIDENCES)[number];

/** Spec §2.5: beyond this `tldrx` shards by `area`. */
export const MAX_FACTS = 5000;
/** Spec §2.5: `fact` is one assertion, ≤300 chars. */
export const MAX_FACT_CHARS = 300;

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

export function factNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

export function formatFactId(n: number): string {
  return `F${String(n).padStart(3, "0")}`;
}
