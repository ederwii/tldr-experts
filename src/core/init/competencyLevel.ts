/**
 * The competency level formula (spec §2.6), implemented exactly.
 *
 * `level` is COMPUTED, never self-declared — a hand-edited value is overwritten
 * on the next write. Seeded experts have no evidence, so they start at 0, and
 * that zero is the honest answer, not a placeholder.
 *
 *   recency = max(0.25, 1 - ageDays/365)          # continuous, no cliff
 *   weight  = code 1.0 · run 1.0 · test 1.0 · answer 0.8 · doc 0.5
 *             × 2 when the row is `cross: true`   # a finding spanning >= 2 files
 *             × 0.5 when `confidence: assumed`
 *   W = sum(recency * weight)
 *   level = 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <20 · else 5
 *   run cap:  no `kind: run` row at all => level = min(level, 3)
 *   level 5 also needs >= 2 distinct evidence kinds, else 4
 *   distinct-source cap: level <= count(distinct src)
 *
 * The three caps are applied in that order, and the order is load-bearing: the
 * source cap is last because it is the only one that can still cut a level 5 that
 * earned every other test.
 *
 * **Why recency decays instead of falling off a cliff.** Until 2026-08-29 there
 * were two mechanisms and both were steps: a four-band recency table (1.0 / 0.6 /
 * 0.3 / 0.1) and a hard cap that pinned any area whose newest row was over 180
 * days old at level 2. The audit's word for it was *acantilado* — a cliff. An
 * expert trained on day 179 and the same expert on day 181 knew exactly the same
 * things, and the ladder reported 4 and 2. Knowledge does not expire on a
 * Tuesday; it fades. One continuous factor, floored at 0.25 so a year-old reading
 * is worth a quarter of a fresh one rather than nothing, replaces both.
 *
 * **Why a `run` row is required above 3.** Measured 2026-08-29: `aparece-api`
 * held 15 `code` + 2 `test` rows, all written the same afternoon by one reading
 * session, and computed 5/5 — the top of the ladder for an expert that had never
 * executed a single command in the repo it claimed to know. Reading is evidence
 * that code SAYS something; only a run is evidence that it DOES it. So the top
 * two rungs are gated on a measurement: level 4 needs at least one `run`, and
 * level 5 needs a body of work broad enough to span two kinds and heavy enough
 * to clear W >= 20.
 *
 * **Why a cross-file finding counts double.** The old training prompt said
 * "reading twelve files is worth twelve", and it was describing the formula
 * accurately: breadth of FILES was the only thing measured. A model can re-derive
 * anything a single file says by reading that file; what it cannot re-derive is
 * the relationship between two of them — a default that contradicts its docstring,
 * a caller that passes the wrong key, a path nothing reaches. A row derived from a
 * bullet citing two or more distinct files is that kind of finding, and it is the
 * only shape of evidence weighted above its kind.
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

/**
 * How sure the finding's author was, carried from the knowledge bullet's own
 * `(measured)` / `(inferred)` / `(assumed)` annotation. ADDITIVE and optional: a
 * row written before this existed carries none, and an absent value is treated
 * exactly as it always was.
 */
export const EVIDENCE_CONFIDENCES = ["measured", "inferred", "assumed"] as const;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number];

export function isEvidenceConfidence(value: string): value is EvidenceConfidence {
  return (EVIDENCE_CONFIDENCES as readonly string[]).includes(value);
}

export interface CompetencyEvidence {
  readonly kind: EvidenceKind;
  /** A `src` token payload (spec §2.8). */
  readonly src: string;
  /** `YYYY-MM-DD`. */
  readonly at: string;
  /** The bullet this row came from cited two or more distinct files. Weighs double. */
  readonly cross?: boolean;
  /** The bullet's own confidence label. `assumed` halves the row's weight. */
  readonly confidence?: EvidenceConfidence;
}

const WEIGHTS: Readonly<Record<EvidenceKind, number>> = { code: 1, run: 1, test: 1, doc: 0.5, answer: 0.8 };
/** A finding that ties two files together is the one a model cannot re-derive. */
const CROSS_MULTIPLIER = 2;
/** An `assumed` claim is a hypothesis with a citation attached. Half a row. */
const ASSUMED_MULTIPLIER = 0.5;
/**
 * The fifth threshold is 20, not 12. At 12 a single afternoon of reading — twelve
 * files, one kind, nothing executed — reached the top of the ladder; 20 makes the
 * last rung a body of work rather than one session.
 */
const THRESHOLDS: readonly number[] = [0.5, 1.5, 3, 6, 20];
/** A year old is a quarter of a fresh reading, and never less. */
export const RECENCY_FLOOR = 0.25;
export const RECENCY_HALFLIFE_DAYS = 365;
/** Without a `kind: run` row, nothing here was ever executed: the level stops at 3. */
const NO_RUN_CAP = 3;
/** Level 5 also has to be broad: one kind of evidence, however much of it, is 4. */
const MIN_KINDS_FOR_TOP = 2;
const DAY_MS = 86_400_000;

export function competencyLevel(evidence: readonly CompetencyEvidence[], now: Date = new Date()): number {
  if (evidence.length === 0) return 0;

  let weighted = 0;
  const sources = new Set<string>();
  const kinds = new Set<EvidenceKind>();

  for (const item of evidence) {
    const ageDays = daysBetween(item.at, now);
    if (ageDays === null) continue;
    weighted += recency(ageDays) * weightOf(item);
    sources.add(item.src);
    kinds.add(item.kind);
  }

  // The order below is the rule, and it is the order spec §2.6 states.
  let level = THRESHOLDS.filter((threshold) => weighted >= threshold).length;
  if (!kinds.has("run")) level = Math.min(level, NO_RUN_CAP);
  if (level === 5 && kinds.size < MIN_KINDS_FOR_TOP) level = 4;
  return Math.min(level, sources.size);
}

export function weightOf(item: CompetencyEvidence): number {
  const base = WEIGHTS[item.kind];
  const cross = item.cross === true ? CROSS_MULTIPLIER : 1;
  const confidence = item.confidence === "assumed" ? ASSUMED_MULTIPLIER : 1;
  return base * cross * confidence;
}

export function recency(ageDays: number): number {
  return Math.max(RECENCY_FLOOR, 1 - ageDays / RECENCY_HALFLIFE_DAYS);
}

function daysBetween(at: string, now: Date): number | null {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (now.getTime() - then) / DAY_MS);
}
