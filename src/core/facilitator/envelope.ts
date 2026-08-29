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
 */
export function toUsage(value: unknown): AgentUsage {
  if (typeof value !== "object" || value === null) return { input_tokens: 0, output_tokens: 0 };
  const doc = value as Record<string, unknown>;
  return {
    input_tokens: typeof doc.input_tokens === "number" ? doc.input_tokens : 0,
    output_tokens: typeof doc.output_tokens === "number" ? doc.output_tokens : 0,
  };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return (value as unknown[]).filter((entry): entry is string => typeof entry === "string");
}
