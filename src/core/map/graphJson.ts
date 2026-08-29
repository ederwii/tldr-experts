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

function endpointsOf(link: unknown): string[] {
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
