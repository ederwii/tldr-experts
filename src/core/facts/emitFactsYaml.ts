/**
 * Block-style YAML for `.tldrx/memory/facts.yml`.
 *
 * A generic YAML serialiser is correct but not readable: the runtime seam's two
 * implementations disagree on layout, and facts.yml is a committed, human-read,
 * diffed file. This emitter knows exactly one shape — the §2.5 record — and emits
 * the layout the spec sample shows, byte-identically on every runtime.
 */
import type { Fact, FactsFile } from "./Fact.ts";

const PLAIN_SAFE = /^[A-Za-z][A-Za-z0-9_./-]*$/;
const YAML_KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

export function yamlScalar(value: string | number | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (PLAIN_SAFE.test(value) && !YAML_KEYWORDS.has(value.toLowerCase())) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function inlineList(values: readonly string[]): string {
  return `[${values.map((v) => yamlScalar(v)).join(", ")}]`;
}

export function emitFact(fact: Fact, indent = "  "): string {
  const inner = `${indent}  `;
  const lines = [
    `${indent}- id: ${yamlScalar(fact.id)}`,
    `${inner}fact: ${yamlScalar(fact.fact)}`,
    `${inner}area: ${yamlScalar(fact.area)}`,
    `${inner}repos: ${inlineList(fact.repos)}`,
    `${inner}kind: ${yamlScalar(fact.kind)}`,
    `${inner}confidence: ${yamlScalar(fact.confidence)}`,
    `${inner}source: {who: ${yamlScalar(fact.source.who)}, when: ${yamlScalar(fact.source.when)}, ` +
      `run: ${yamlScalar(fact.source.run)}, q: ${yamlScalar(fact.source.q)}}`,
    `${inner}supersedes: ${yamlScalar(fact.supersedes)}`,
    `${inner}superseded_by: ${yamlScalar(fact.superseded_by)}`,
  ];
  // Written only when it is true. A `truncated: false` on every row of a file
  // whose facts are all whole is noise in a diff nobody asked for.
  if (fact.truncated === true) lines.push(`${inner}truncated: true`);
  if (fact.retired === null) {
    lines.push(`${inner}retired: null`);
  } else {
    lines.push(
      `${inner}retired: {at: ${yamlScalar(fact.retired.at)}, by: ${yamlScalar(fact.retired.by)}, ` +
        `reason: ${yamlScalar(fact.retired.reason)}}`,
    );
  }
  return lines.join("\n");
}

export function emitFactsYaml(file: FactsFile, header?: string): string {
  const out: string[] = [];
  if (header !== undefined && header !== "") out.push(header.replace(/\n$/, ""));
  out.push(`version: ${file.version}`);
  out.push("facts:");
  for (const fact of file.facts) out.push(emitFact(fact));
  return `${out.join("\n")}\n`;
}
