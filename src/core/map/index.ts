export { buildMap, MAP_DIR, GRAPHIFY_OUT_DIR, type BuildMapOptions, type BuildMapResult, type MapProgress } from "./buildMap.ts";
export { checkCitations, citedDocuments, HANDOFF_FILE, type CheckOptions, type CheckResult, type CitationProblem } from "./checkCitations.ts";
export { StaticProvider, cite } from "./StaticProvider.ts";
export { GraphifyProvider, GRAPH_FILE, GRAPHIFY_SRC } from "./GraphifyProvider.ts";
export { renderMapDoc, renderBullet, renderWorkspaceMap } from "./renderMap.ts";
export { summariseGraph, type GraphSummary, type GraphNode } from "./graphJson.ts";
export { collectChurn, parseChurn, CHURN_SRC, CHURN_WINDOW_DAYS, type ChurnReport, type FileChurn } from "./gitChurn.ts";
export { detectConventionSignals, CONVENTION_GAP_PATHS, type ConventionSignal } from "./conventionSignals.ts";
export { readSourceTree, topFolder, extensionOf, type SourceTree, type FolderSummary } from "./sourceTree.ts";
export { scanTodos, type TodoScan, type TodoHit } from "./todoScan.ts";
export { plural, fileSize } from "./plural.ts";
// The `[src: …]` grammar has ONE reader (gh #80): `core/text/srcToken.ts`. The map
// re-exports it so `map/index.ts` stays the front door, and owns only `isBullet`,
// which is about DOCUMENTS and not about the token.
export { srcToken, endsWithToken } from "../text/srcToken.ts";
export { isBullet } from "./checkCitations.ts";
export { MAP_DOCS, emptyDocs, type MapDoc, type MapBullet, type MapFacts } from "./MapFacts.ts";
export type { MapProvider, MapContext } from "./Provider.ts";
