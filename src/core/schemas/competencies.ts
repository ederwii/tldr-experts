/**
 * Schema for `.tldrx/experts/<name>/competencies.yml`.
 * `level` is COMPUTED from evidence count + recency (concept §6), never self-declared;
 * this validator only checks the shape, not the arithmetic.
 */
import {
  asDocument, requireArray, requireKeys, requireNumber, requireString,
  requireVersion, result, isRecord, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export const COMPETENCY_LEVEL_MIN = 0;
export const COMPETENCY_LEVEL_MAX = 5;

export interface Competency {
  readonly area: string;
  readonly level: number;
  readonly evidence: readonly string[];
  readonly last_trained?: string | null;
}

export interface CompetenciesFile {
  /**
   * `version: 1`. A file still saying `schema_version` loads and is reported;
   * see `requireVersion` in `./validation.ts`.
   */
  readonly version: number;
  /** @deprecated the pre-spec spelling of `version`. Accepted for one release. */
  readonly schema_version?: number;
  readonly expert: string;
  readonly areas: readonly Competency[];
}

export function validateCompetencies(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["expert", "areas"], "", issues);
  requireString(doc.expert, "expert", issues);

  if (requireArray(doc.areas, "areas", issues)) {
    (doc.areas as unknown[]).forEach((area, i) => {
      const path = `areas[${i}]`;
      if (!isRecord(area)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(area, ["area", "level", "evidence"], path, issues);
      requireNumber(area.level, `${path}.level`, issues);
      if (
        typeof area.level === "number" &&
        (area.level < COMPETENCY_LEVEL_MIN || area.level > COMPETENCY_LEVEL_MAX)
      ) {
        issues.push({
          path: `${path}.level`,
          message: `expected ${COMPETENCY_LEVEL_MIN}-${COMPETENCY_LEVEL_MAX}, got ${area.level}`,
        });
      }
      requireArray(area.evidence, `${path}.evidence`, issues);
    });
  }
  return result(issues, deprecations);
}
