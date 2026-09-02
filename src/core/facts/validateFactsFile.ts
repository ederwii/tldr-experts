/**
 * Spec §2.5 validation for `.tldrx/memory/facts.yml`.
 *
 * Ids unique and ascending; supersede links reciprocal and resolvable within this
 * file; no fact both superseded and retired; ≤5000 facts.
 */
import {
  asDocument, isRecord, requireArray, requireEnum, requireKeys, requireString, requireVersion, result,
  type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";
import {
  FACT_CONFIDENCES, FACT_KINDS, MAX_FACTS, MAX_FACT_CHARS, factNumber,
  type Fact, type FactsFile,
} from "./Fact.ts";
import { readableSource, SRC_PATTERNS } from "../text/srcToken.ts";

/**
 * The two id shapes, TAKEN from the `[src: …]` grammar rather than respelled here (#81).
 *
 * They used to be two local literals respelling the same two shapes, agreeing with
 * `SRC_PATTERNS.fact` / `.answer` character for character, with nothing asserting that
 * they must. (They are not written out again even here: the shapes are one import away,
 * and a comment that spells them is one more copy to drift — it also trips the kind sweep
 * in `test/map-citations.test.ts`, which reads a quoted regex literal as a second reader.)
 * They must agree, and in one direction in particular: **every id this file accepts
 * has to be citable.** One string makes one trip. `formatFactId` mints `F102`, this
 * validator admits it into `.tldrx/memory/facts.yml`, and `classifySrc` has to read that
 * same `F102` back out of a `[src: F102]` token before `knowledgeFile` can resolve the
 * citation against the store. A row this file accepted and the grammar refused would be a
 * fact that exists and cannot be cited — invisible to every reader downstream — and the
 * drift would be silent, because no code path runs both readers on the same string.
 *
 * So it is one constant, not two that happen to match. `SRC_PATTERNS` is published for
 * exactly this reuse (see its doc comment): none of its patterns is global, so none
 * carries a `lastIndex` and sharing one is safe. The correspondence is asserted
 * behaviourally in `test/map-citations.test.ts`, so re-typing either shape as a local
 * literal — which one file-level sweep alone would not catch — goes red.
 */
const ID_RE = SRC_PATTERNS.fact;
const Q_RE = SRC_PATTERNS.answer;

export function validateFactsFile(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["facts"], "", issues);
  if (!requireArray(doc.facts, "facts", issues)) return result(issues, deprecations);

  const rows = doc.facts as unknown[];
  if (rows.length > MAX_FACTS) {
    issues.push({ path: "facts", message: `${rows.length} facts exceeds the ${MAX_FACTS} cap` });
  }

  const byId = new Map<string, Record<string, unknown>>();
  let previous = 0;
  rows.forEach((row, i) => {
    const path = `facts[${i}]`;
    if (!isRecord(row)) {
      issues.push({ path, message: "expected a mapping" });
      return;
    }
    requireKeys(row, ["id", "fact", "area", "repos", "kind", "confidence", "source", "supersedes", "superseded_by", "retired"], path, issues);
    const id = typeof row.id === "string" ? row.id : "";
    if (!ID_RE.test(id)) issues.push({ path: `${path}.id`, message: `id must match ${readableSource(ID_RE)}` });
    else if (byId.has(id)) issues.push({ path: `${path}.id`, message: `duplicate fact id ${id}` });
    else {
      const n = factNumber(id);
      if (n <= previous) issues.push({ path: `${path}.id`, message: `fact ids must ascend (${id} follows F${previous})` });
      previous = n;
      byId.set(id, row);
    }
    requireString(row.fact, `${path}.fact`, issues);
    if (typeof row.fact === "string" && row.fact.length > MAX_FACT_CHARS) {
      issues.push({ path: `${path}.fact`, message: `fact is ${row.fact.length} chars (max ${MAX_FACT_CHARS})` });
    }
    requireString(row.area, `${path}.area`, issues);
    requireArray(row.repos, `${path}.repos`, issues);
    requireEnum(row.kind, FACT_KINDS, `${path}.kind`, issues);
    requireEnum(row.confidence, FACT_CONFIDENCES, `${path}.confidence`, issues);

    if (isRecord(row.source)) {
      requireKeys(row.source, ["who", "when", "run", "q"], `${path}.source`, issues);
      const q = row.source.q;
      if (typeof q === "string" && !Q_RE.test(q)) {
        // Generated, not typed: this said `^Q\d+$` while the reader ran `^Q\d{1,6}$` — the
        // shape's third spelling, and the one that had already drifted (#81).
        issues.push({ path: `${path}.source.q`, message: `expected ${readableSource(Q_RE)} or null` });
      }
    } else if (row.source !== undefined) {
      issues.push({ path: `${path}.source`, message: "expected a mapping" });
    }

    // Additive since 2026-08-30, so absence is fine and only a wrong TYPE is an
    // issue: a row written before the field existed must keep validating.
    if (row.truncated !== undefined && typeof row.truncated !== "boolean") {
      issues.push({ path: `${path}.truncated`, message: "expected true, false or absent" });
    }

    const superseded = typeof row.superseded_by === "string";
    const retired = isRecord(row.retired) && row.retired.at !== null && row.retired.at !== undefined;
    if (superseded && retired) {
      issues.push({ path, message: "a fact may be superseded or retired, not both" });
    }
  });

  // Reciprocity: F007.superseded_by = F019 <=> F019.supersedes = F007.
  for (const [id, row] of byId) {
    const forward = row.superseded_by;
    if (typeof forward === "string") {
      const target = byId.get(forward);
      if (target === undefined) {
        issues.push({ path: `facts.${id}.superseded_by`, message: `${forward} is not in this file` });
      } else if (target.supersedes !== id) {
        issues.push({ path: `facts.${id}.superseded_by`, message: `${forward}.supersedes must be ${id} (links are reciprocal)` });
      }
    }
    const back = row.supersedes;
    if (typeof back === "string") {
      const target = byId.get(back);
      if (target === undefined) {
        issues.push({ path: `facts.${id}.supersedes`, message: `${back} is not in this file` });
      } else if (target.superseded_by !== id) {
        issues.push({ path: `facts.${id}.supersedes`, message: `${back}.superseded_by must be ${id} (links are reciprocal)` });
      }
    }
  }
  return result(issues, deprecations);
}

/** Narrow a validated document. Call `validateFactsFile` first. */
export function asFactsFile(input: unknown): FactsFile {
  const doc = input as { version: number; facts: Fact[] };
  return { version: doc.version, facts: doc.facts };
}
