/**
 * Schema for `.tldrx/memory/facts.yml` — durable facts with provenance.
 * Principle 2: never ask what you already know. Every fact carries who/when/run.
 */
import {
  asDocument, requireArray, requireKeys, requireVersion, result, isRecord,
  type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export interface FactSource {
  readonly who: string;
  readonly when: string;
  readonly run?: string | null;
  readonly q?: string | null;
}

export interface Fact {
  readonly id: string;
  readonly fact: string;
  readonly source: FactSource;
}

export interface FactsFile {
  /**
   * `version: 1`. A file still saying `schema_version` loads and is reported;
   * see `requireVersion` in `./validation.ts`.
   */
  readonly version: number;
  /** @deprecated the pre-spec spelling of `version`. Accepted for one release. */
  readonly schema_version?: number;
  readonly facts: readonly Fact[];
}

export function validateFacts(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["facts"], "", issues);
  if (requireArray(doc.facts, "facts", issues)) {
    (doc.facts as unknown[]).forEach((fact, i) => {
      const path = `facts[${i}]`;
      if (!isRecord(fact)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(fact, ["id", "fact", "source"], path, issues);
      if (isRecord(fact.source)) {
        requireKeys(fact.source, ["who", "when"], `${path}.source`, issues);
      } else if (fact.source !== undefined) {
        issues.push({ path: `${path}.source`, message: "expected a mapping" });
      }
    });
  }
  return result(issues, deprecations);
}
