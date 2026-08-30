/**
 * `.tldrx/memory/facts.yml` — seeded empty, on purpose.
 *
 * `init` measures things, but a measurement is not a fact in the §2.5 sense: a
 * fact has a human source and answers a question that was actually asked. The
 * file starts empty and the answer-capture hook fills it.
 */
import { validate, type ValidationResult } from "../schemas/index.ts";

export interface FactsDocument {
  readonly version: 1;
  readonly facts: readonly unknown[];
}

export const FACTS_FILE = ".tldrx/memory/facts.yml";

export function buildFactsDocument(): FactsDocument {
  return { version: 1, facts: [] };
}

export function validateFactsDocument(doc: FactsDocument): ValidationResult {
  return validate("facts", { version: doc.version, facts: doc.facts });
}

export const FACTS_HEADER = [
  "# Written by `tldrx init` (spec §2.5). Durable, provenanced answers.",
  "#",
  "# Append-mostly: a fact is superseded or retired, never edited in place. Before any",
  "# question is asked this file is searched — re-asking something recorded here is a",
  "# framework bug, not a stylistic lapse. A fact without a source is not a fact.",
  "",
].join("\n");
