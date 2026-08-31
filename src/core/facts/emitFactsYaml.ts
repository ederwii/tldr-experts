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

/**
 * A high surrogate with no low after it, or a low with no high before it.
 *
 * Not reachable from a terminal — argv is UTF-8 — but reachable from a string
 * sliced through the middle of an emoji, and `JSON.stringify` renders one as a
 * bare `\ud800` escape that Bun's native YAML parser then REFUSES (measured; the
 * `yaml` package accepts it). Replaced with U+FFFD, which is what encoding the
 * file as UTF-8 would do to it anyway — the byte is already not text.
 */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * One string → one YAML scalar. **Every** free-text field this framework writes
 * into YAML goes through here: gate notes, task errors, cancellation and
 * rejection reasons, evidence paths, fact text, split goals.
 *
 * ## Why `JSON.stringify`
 *
 * It used to be `"` + escape `\` and `"` + `"`, and that escaped nothing else —
 * so a newline inside a note was written as a LITERAL newline inside a
 * double-quoted flow scalar. Inside `gate: {…, note: "…"}` that is not YAML at
 * all, and the file stopped parsing: measured 2026-08-31 on a live run, where
 * `tldrx reject --note "<two paragraphs>"` produced `Missing closing " quote`
 * from the `yaml` package and `Unexpected character` from Bun's, and every
 * subsequent command on that run failed.
 *
 * JSON's string grammar is a strict subset of YAML 1.2's double-quoted scalar,
 * so `JSON.stringify` is a correct YAML emitter for this one job, and it is the
 * escaping this repo already trusted for the same purpose in
 * `adapters/external.ts` and `build/storyFile.ts`. Two properties earned it the
 * job over hand-rolled escaping:
 *
 * 1. **It round-trips.** Newlines, tabs, CR, NUL and friends come back
 *    byte-identical through BOTH parsers behind the runtime seam — Bun's
 *    native one and the `yaml` package — including inside a flow mapping.
 * 2. **It changes nothing that already worked.** Over every code point from
 *    U+0020 to U+FFFF, `JSON.stringify` and the old escaping produce the SAME
 *    bytes (measured: 63,456 checked, 0 differ). Control characters are the only
 *    inputs whose output moves — and those were the corrupt ones. So every
 *    run.yml, budget.yml, facts.yml and split.yml already on disk still
 *    round-trips byte-for-byte through a save.
 *
 * The plain-scalar fast path is kept ahead of it so the common case — an id, a
 * status, a slug — stays unquoted and the files stay readable.
 */
export function yamlScalar(value: string | number | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (PLAIN_SAFE.test(value) && !YAML_KEYWORDS.has(value.toLowerCase())) return value;
  return JSON.stringify(
    value.replace(LONE_HIGH_SURROGATE, "�").replace(LONE_LOW_SURROGATE, "�"),
  );
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
