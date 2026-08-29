export { FactsStore } from "./FactsStore.ts";
export { validateFactsFile, asFactsFile } from "./validateFactsFile.ts";
export { emitFactsYaml, emitFact, yamlScalar } from "./emitFactsYaml.ts";
export { findDuplicate, jaccard, tokenize, DEFAULT_JACCARD_THRESHOLD, MIN_TOKEN_LENGTH } from "./findDuplicate.ts";
export type { DuplicateHit } from "./findDuplicate.ts";
export {
  FACT_KINDS, FACT_CONFIDENCES, MAX_FACTS, MAX_FACT_CHARS,
  isRetired, factNumber, formatFactId,
} from "./Fact.ts";
export type { Fact, FactsFile, FactKind, FactConfidence, FactSource, FactRetirement, NewFact } from "./Fact.ts";
