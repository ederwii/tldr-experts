/**
 * The competency level formula (spec §2.6), implemented exactly.
 *
 * `level` is COMPUTED, never self-declared — a hand-edited value is overwritten
 * on the next write. Seeded experts have no evidence, so they start at 0, and
 * that zero is the honest answer, not a placeholder.
 *
 *   recency = 1.0 (d<=30) · 0.6 (<=90) · 0.3 (<=365) · 0.1 (else)
 *   weight  = code 1.0 · run 1.0 · test 1.0 · answer 0.8 · doc 0.5
 *   W = sum(recency * weight)
 *   level = 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <20 · else 5
 *   staleness cap: newest evidence older than 180d => level = min(level, 2)
 *   run cap:       no `kind: run` row at all       => level = min(level, 3)
 *   level 5 also needs >= 2 distinct evidence kinds, else 4
 *   distinct-source cap: level <= count(distinct src)
 *
 * The four caps are applied in that order, and the order is load-bearing: the
 * staleness cap can pull a level below the run cap, and the source cap is last
 * because it is the only one that can still cut a level 5 that earned every
 * other test.
 *
 * **Why a `run` row is required above 3.** Measured 2026-08-29: `aparece-api`
 * held 15 `code` + 2 `test` rows, all written the same afternoon by one reading
 * session, and computed 5/5 — the top of the ladder for an expert that had never
 * executed a single command in the repo it claimed to know. Reading is evidence
 * that code SAYS something; only a run is evidence that it DOES it. So the top
 * two rungs are gated on a measurement: level 4 needs at least one `run`, and
 * level 5 needs a body of work broad enough to span two kinds and heavy enough
 * to clear W >= 20.
 */

/**
 * The evidence classes a `competencies.yml` row may declare (spec §2.6).
 *
 * `test` carries the same weight as `code`: a test read or run is a direct
 * observation of behaviour, not a second-hand description of it. It was added
 * 2026-08-29 after a real in-session training wrote two `kind: test` rows for two
 * test-file citations and both were dropped without a word, so an expert showed
 * 15 evidence where its file held 17.
 */
export const EVIDENCE_KINDS = ["code", "run", "test", "doc", "answer"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** `code, run, test, doc, answer` — the list every "unknown kind" message ends with. */
export const ALLOWED_KINDS: string = EVIDENCE_KINDS.join(", ");

export function isEvidenceKind(value: string): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/**
 * One line per kind, for every prompt that has to tell a model what it may write.
 * Typed as a total record so adding a kind without explaining it fails to compile
 * — the train prompt listing `{kind, src, at}` and naming no kinds is exactly how
 * `kind: test` got written and silently dropped.
 */
export const EVIDENCE_KIND_MEANINGS: Readonly<Record<EvidenceKind, string>> = {
  code: "a `file:line` you read",
  run: "a command you executed — cite it as `$ cmd → exit n`",
  test: "a test you ran or read",
  doc: "an `https://` doc fetched fresh",
  answer: "a human answer, cited as `F<n>`",
};

export interface CompetencyEvidence {
  readonly kind: EvidenceKind;
  /** A `src` token payload (spec §2.8). */
  readonly src: string;
  /** `YYYY-MM-DD`. */
  readonly at: string;
}

const WEIGHTS: Readonly<Record<EvidenceKind, number>> = { code: 1, run: 1, test: 1, doc: 0.5, answer: 0.8 };
/**
 * The fifth threshold is 20, not 12. At 12 a single afternoon of reading — twelve
 * files, one kind, nothing executed — reached the top of the ladder; 20 makes the
 * last rung a body of work rather than one session.
 */
const THRESHOLDS: readonly number[] = [0.5, 1.5, 3, 6, 20];
const STALE_DAYS = 180;
/** Without a `kind: run` row, nothing here was ever executed: the level stops at 3. */
const NO_RUN_CAP = 3;
/** Level 5 also has to be broad: one kind of evidence, however much of it, is 4. */
const MIN_KINDS_FOR_TOP = 2;
const DAY_MS = 86_400_000;

export function competencyLevel(evidence: readonly CompetencyEvidence[], now: Date = new Date()): number {
  if (evidence.length === 0) return 0;

  let weighted = 0;
  let newestAgeDays = Number.POSITIVE_INFINITY;
  const sources = new Set<string>();
  const kinds = new Set<EvidenceKind>();

  for (const item of evidence) {
    const ageDays = daysBetween(item.at, now);
    if (ageDays === null) continue;
    weighted += recency(ageDays) * WEIGHTS[item.kind];
    newestAgeDays = Math.min(newestAgeDays, ageDays);
    sources.add(item.src);
    kinds.add(item.kind);
  }

  // The order below is the rule, and it is the order spec §2.6 states.
  let level = THRESHOLDS.filter((threshold) => weighted >= threshold).length;
  if (newestAgeDays > STALE_DAYS) level = Math.min(level, 2);
  if (!kinds.has("run")) level = Math.min(level, NO_RUN_CAP);
  if (level === 5 && kinds.size < MIN_KINDS_FOR_TOP) level = 4;
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
