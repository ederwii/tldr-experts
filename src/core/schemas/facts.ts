/**
 * Schema for `.tldrx/memory/facts.yml` — durable facts with provenance.
 * Principle 2: never ask what you already know. Every fact carries who/when/run.
 */
import {
  asDocument, requireArray, requireKeys, result, isRecord,
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
  readonly schema_version: number;
  readonly facts: readonly Fact[];
}

export function validateFacts(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, ["schema_version", "facts"], "", issues);
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
  return result(issues);
}
