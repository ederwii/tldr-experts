/**
 * The graph half of expert relevance (wave N, spec §2.3 rule 3).
 *
 * `selectExperts` scores a domain expert on how much of what the stage CITES its
 * `## Domain` contains. That is exact but narrow: a stage that cites
 * `src/Checkout/Cart.cs` is obviously relevant to the expert that owns
 * `src/Checkout`, and less obviously — but just as really — to the one that owns
 * the module Cart imports from. `graphify-out/<repo>/graph.json` already knows
 * which those are, it was extracted with no LLM, and reading it costs nothing but
 * the parse (`docs/audits/2026-08-29/token-economy-legacy.md`: the map "is NOT the
 * problem", 24 KB inlined and O(1) in repo size).
 *
 * So: seed on the cited paths, walk two hops, and hand the reached paths back as
 * weaker evidence. Everything here degrades to an EMPTY set — no graph, an
 * unparseable graph, a graph too big to read — because a missing map may make the
 * ranking coarser and must never make a stage fail.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { GRAPH_HOPS } from "./selectExperts.ts";
import { pathsIntersect } from "./expertDomain.ts";
import { neighbourhoodPaths } from "../map/graphJson.ts";

export const GRAPHIFY_OUT_DIRNAME = "graphify-out";
export const GRAPH_FILE = "graph.json";

/**
 * `[assumption]` — 64 MB. The aparece graph is 4.9 MB; this is the size at which
 * "parse it on every stage" stops being free, and the honest answer is to rank
 * without it rather than to spend a second of every prepare on it.
 */
export const MAX_GRAPH_BYTES = 64 * 1024 * 1024;

export function graphPath(root: string, repo: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, GRAPHIFY_OUT_DIRNAME, repo, GRAPH_FILE);
}

/**
 * Paths within `GRAPH_HOPS` of any of `citedPaths`, across every repo in the run.
 *
 * Returns an empty set when there is nothing to seed on, when no repo has a
 * graph, or when a graph is unreadable — never a throw, and never a partial set
 * presented as a whole one, because the caller only ever uses it to rank.
 */
export function nearbyPathsFor(
  root: string,
  repos: readonly string[],
  citedPaths: readonly string[],
  hops = GRAPH_HOPS,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (citedPaths.length === 0) return out;
  for (const repo of repos) {
    for (const path of readGraph(root, repo, citedPaths, hops)) out.add(path);
  }
  return out;
}

function readGraph(
  root: string,
  repo: string,
  citedPaths: readonly string[],
  hops: number,
): ReadonlySet<string> {
  const path = graphPath(root, repo);
  try {
    if (!existsSync(path) || statSync(path).size > MAX_GRAPH_BYTES) return new Set<string>();
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return neighbourhoodPaths(parsed, citedPaths, hops, pathsIntersect);
  } catch {
    return new Set<string>();
  }
}
