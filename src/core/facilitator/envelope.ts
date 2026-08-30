/**
 * The sub-agent's result envelope (spec §5, decision (a)).
 *
 * "Stage artefacts are Markdown validated by hooks; the sub-agent's *result
 * envelope* is structured via `--json-schema` so `next` parses deterministically."
 * This file is that schema and the parser for what comes back.
 *
 * The envelope is a REPORT, never the evidence. `next` re-reads every declared
 * output from disk regardless of what `outputs` claims — an agent saying it wrote
 * a file is not the same as a file existing.
 */

/** Passed verbatim to `claude --json-schema` (flag verified in `claude --help`). */
export const ENVELOPE_SCHEMA = {
  type: "object",
  properties: {
    outputs: { type: "array", items: { type: "string" } },
    questions_asked: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["outputs", "questions_asked", "notes"],
  additionalProperties: false,
} as const;

export interface AgentEnvelope {
  readonly outputs: readonly string[];
  readonly questions_asked: readonly string[];
  readonly notes: string;
}

/** The `claude -p --output-format json` result object, as far as we rely on it. */
export interface ClaudeResultJson {
  readonly result?: unknown;
  readonly session_id?: unknown;
  readonly total_cost_usd?: unknown;
  readonly usage?: unknown;
  readonly structured_output?: unknown;
  readonly is_error?: unknown;
  readonly subtype?: unknown;
  readonly errors?: unknown;
}

export interface AgentUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  /**
   * Prompt-cache accounting, both measured off the `result` event of one real
   * call (`test/fixtures/agent/stream-json.jsonl:13`, `claude` 2.1.251,
   * 2026-08-29): `cache_creation_input_tokens: 25610`,
   * `cache_read_input_tokens: 25106`.
   *
   * They are the whole reason prompt ORDER matters. A cache WRITE is billed at
   * 1.25x an input token and a cache READ at 0.1x, so a prompt whose big stable
   * blocks sit at the front is read back on the next turn instead of re-written.
   * Before wave N these two numbers were parsed away and never recorded, which
   * made "did the reorder help?" an argument rather than a measurement.
   */
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

export function parseClaudeJson(text: string): ClaudeResultJson | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const doc: unknown = JSON.parse(trimmed);
    return typeof doc === "object" && doc !== null ? (doc as ClaudeResultJson) : null;
  } catch {
    return null;
  }
}

/** Narrow anything into the envelope shape, or null when it is not one. */
export function toEnvelope(value: unknown): AgentEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const outputs = stringArray(doc.outputs);
  const questions = stringArray(doc.questions_asked);
  if (outputs === null || questions === null) return null;
  return { outputs, questions_asked: questions, notes: typeof doc.notes === "string" ? doc.notes : "" };
}

/**
 * Spec §2.9 caps event payloads at 4 KB and nesting at 3, and its own example
 * records exactly two usage numbers. So the full `usage` object is narrowed here
 * rather than at the event, which is where it would be a validation failure.
 *
 * Wave N added the two cache counters to that narrowing. They are four numbers
 * rather than two, still one flat object, and still far inside the 4 KB payload
 * cap — and without them the cost of a re-sent prefix cannot be told from the
 * cost of a cached one.
 */
export function toUsage(value: unknown): AgentUsage {
  if (typeof value !== "object" || value === null) return EMPTY_USAGE;
  const doc = value as Record<string, unknown>;
  return {
    input_tokens: number(doc.input_tokens),
    output_tokens: number(doc.output_tokens),
    cache_creation_input_tokens: number(doc.cache_creation_input_tokens),
    cache_read_input_tokens: number(doc.cache_read_input_tokens),
  };
}

export const EMPTY_USAGE: AgentUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return (value as unknown[]).filter((entry): entry is string => typeof entry === "string");
}
