/**
 * Reading graphify's `graph.json` without trusting it.
 *
 * Shape measured on graphify 0.8.x (`graphify update <path> --no-cluster`, exit 0):
 * `{nodes: [{id, label, file_type, source_file, source_location: "L<n>", _origin}],
 *   links: [{source, target, relation, confidence, …}]}`. `edges` is accepted as an
 * alias because older exports use it. Anything else degrades to "no graph facts"
 * rather than to a guess.
 *
 * Nodes carry `source_file` + `source_location`, so graph claims cite a real
 * file:line as well as `graph:<id>` — both halves are checkable by `map --check`.
 */

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly type: string | null;
  /** Repo-relative path this node was extracted from, when graphify recorded one. */
  readonly sourceFile: string | null;
  readonly sourceLine: number | null;
  /** Links touching this node. */
  readonly degree: number;
}

export interface GraphSummary {
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Highest-degree nodes ("god nodes"), degree desc then id asc. */
  readonly hubs: readonly GraphNode[];
  /** Relation -> count, count desc then relation asc. */
  readonly relations: readonly (readonly [string, number])[];
}

const MAX_HUBS = 8;
const LINE_RE = /^L(\d+)/;

export function summariseGraph(parsed: unknown): GraphSummary | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const rawNodes = record.nodes;
  if (!Array.isArray(rawNodes)) return null;

  const rawLinks = Array.isArray(record.links) ? record.links
    : Array.isArray(record.edges) ? record.edges : [];

  const degree = new Map<string, number>();
  const relations = new Map<string, number>();
  for (const link of rawLinks) {
    for (const endpoint of endpointsOf(link)) degree.set(endpoint, (degree.get(endpoint) ?? 0) + 1);
    const relation = relationOf(link);
    if (relation !== null) relations.set(relation, (relations.get(relation) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [];
  for (const raw of rawNodes) {
    const node = toNode(raw, degree);
    if (node !== null) nodes.push(node);
  }
  if (nodes.length === 0) return null;

  const hubs = [...nodes]
    .filter((node) => node.degree > 0)
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_HUBS);

  return {
    nodeCount: nodes.length,
    edgeCount: rawLinks.length,
    hubs,
    relations: [...relations.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  };
}

function toNode(raw: unknown, degree: ReadonlyMap<string, number>): GraphNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = firstString(record, ["id", "name", "label"]);
  if (id === null) return null;
  return {
    id,
    label: firstString(record, ["label", "name", "id"]) ?? id,
    type: firstString(record, ["file_type", "type", "kind"]),
    sourceFile: firstString(record, ["source_file", "file", "path"]),
    sourceLine: parseLine(firstString(record, ["source_location", "line"])),
    degree: degree.get(id) ?? 0,
  };
}

function parseLine(value: string | null): number | null {
  if (value === null) return null;
  const match = LINE_RE.exec(value);
  const digits = match?.[1];
  if (digits !== undefined) return Number(digits);
  return /^\d+$/.test(value) ? Number(value) : null;
}

export function endpointsOf(link: unknown): string[] {
  if (typeof link !== "object" || link === null) return [];
  const record = link as Record<string, unknown>;
  const from = firstString(record, ["source", "from", "src"]);
  const to = firstString(record, ["target", "to", "dst"]);
  return [from, to].filter((value): value is string => value !== null);
}

function relationOf(link: unknown): string | null {
  if (typeof link !== "object" || link === null) return null;
  return firstString(link as Record<string, unknown>, ["relation", "type", "kind"]);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * The k-hop path neighbourhood of a set of paths (wave N).
 *
 * A domain expert is relevant to a stage when the code it speaks for is near what
 * the stage cites — and "near" is a question the graph already answers. Seed
 * nodes are the ones whose `source_file` intersects a cited path; the walk then
 * expands `hops` levels along the links and returns the `source_file`s reached.
 *
 * Undirected on purpose: `A imports B` makes B relevant to a change in A and A
 * relevant to a change in B, and the relation names in graphify's export
 * (`contains`, `imports`, …) do not distinguish "depends on" from "is depended
 * on" consistently enough to be trusted with the difference.
 *
 * Everything is bounded: `MAX_NEIGHBOURHOOD_NODES` stops a hub-heavy graph from
 * expanding to the whole repository, which would make every expert relevant and
 * therefore none of them. Degrades to an empty set rather than to a guess.
 */
export const MAX_NEIGHBOURHOOD_NODES = 4000;

export function neighbourhoodPaths(
  parsed: unknown,
  seedPaths: readonly string[],
  hops: number,
  intersects: (declared: string, cited: string) => boolean,
): ReadonlySet<string> {
  const found = new Set<string>();
  if (typeof parsed !== "object" || parsed === null || seedPaths.length === 0 || hops < 0) return found;
  const record = parsed as Record<string, unknown>;
  const rawNodes = Array.isArray(record.nodes) ? record.nodes : [];
  if (rawNodes.length === 0) return found;
  const rawLinks = Array.isArray(record.links) ? record.links
    : Array.isArray(record.edges) ? record.edges : [];

  const fileOf = new Map<string, string>();
  for (const raw of rawNodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const node = raw as Record<string, unknown>;
    const id = firstString(node, ["id", "name", "label"]);
    const file = firstString(node, ["source_file", "file", "path"]);
    if (id !== null && file !== null) fileOf.set(id, file);
  }

  const neighbours = new Map<string, string[]>();
  for (const link of rawLinks) {
    const [from, to] = endpointsOf(link);
    if (from === undefined || to === undefined) continue;
    push(neighbours, from, to);
    push(neighbours, to, from);
  }

  let frontier: string[] = [];
  const seen = new Set<string>();
  for (const [id, file] of fileOf) {
    if (seedPaths.some((cited) => intersects(file, cited))) {
      seen.add(id);
      frontier.push(id);
    }
  }

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of neighbours.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
        if (seen.size >= MAX_NEIGHBOURHOOD_NODES) return collect(seen, fileOf);
      }
    }
    frontier = next;
  }
  return collect(seen, fileOf);
}

function collect(ids: ReadonlySet<string>, fileOf: ReadonlyMap<string, string>): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const id of ids) {
    const file = fileOf.get(id);
    if (file !== undefined) paths.add(file);
  }
  return paths;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
