/**
 * The competency level formula (spec §2.6), implemented exactly.
 *
 * `level` is COMPUTED, never self-declared — a hand-edited value is overwritten
 * on the next write. Seeded experts have no evidence, so they start at 0, and
 * that zero is the honest answer, not a placeholder.
 *
 *   recency = 1.0 (d<=30) · 0.6 (<=90) · 0.3 (<=365) · 0.1 (else)
 *   weight  = code 1.0 · run 1.0 · answer 0.8 · doc 0.5
 *   W = sum(recency * weight)
 *   level = 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <12 · else 5
 *   staleness cap: newest evidence older than 180d => level = min(level, 2)
 *   distinct-source cap: level <= count(distinct src)
 */

export const EVIDENCE_KINDS = ["code", "run", "doc", "answer"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface CompetencyEvidence {
  readonly kind: EvidenceKind;
  /** A `src` token payload (spec §2.8). */
  readonly src: string;
  /** `YYYY-MM-DD`. */
  readonly at: string;
}

const WEIGHTS: Readonly<Record<EvidenceKind, number>> = { code: 1, run: 1, doc: 0.5, answer: 0.8 };
const THRESHOLDS: readonly number[] = [0.5, 1.5, 3, 6, 12];
const STALE_DAYS = 180;
const DAY_MS = 86_400_000;

export function competencyLevel(evidence: readonly CompetencyEvidence[], now: Date = new Date()): number {
  if (evidence.length === 0) return 0;

  let weighted = 0;
  let newestAgeDays = Number.POSITIVE_INFINITY;
  const sources = new Set<string>();

  for (const item of evidence) {
    const ageDays = daysBetween(item.at, now);
    if (ageDays === null) continue;
    weighted += recency(ageDays) * WEIGHTS[item.kind];
    newestAgeDays = Math.min(newestAgeDays, ageDays);
    sources.add(item.src);
  }

  let level = THRESHOLDS.filter((threshold) => weighted >= threshold).length;
  if (newestAgeDays > STALE_DAYS) level = Math.min(level, 2);
  return Math.min(level, sources.size);
}

function recency(ageDays: number): number {
  if (ageDays <= 30) return 1;
  if (ageDays <= 90) return 0.6;
  if (ageDays <= 365) return 0.3;
  return 0.1;
}

function daysBetween(at: string, now: Date): number | null {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (now.getTime() - then) / DAY_MS);
}
