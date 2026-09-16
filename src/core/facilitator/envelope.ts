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

/**
 * `result_schema` for a DEVELOPER bundle — what `--commit` reads back, stated so
 * a host does not have to read this file for it.
 *
 * Measured on a real workspace, 2026-09: the reviewer bundle carried its schema
 * and the developer bundle beside it carried none, so one handshake made two
 * different promises — the reviewer prompt says "read the shape out of
 * `result_schema` and never from memory", and the developer had nothing to read
 * it out of. A host guessed the shape by copying a sibling story's file.
 *
 * DERIVED from `ENVELOPE_SCHEMA` rather than retyped, because the spawned half of
 * this same path is handed `ENVELOPE_SCHEMA` verbatim through
 * `claude --json-schema`: one grammar, one file, and a change to the envelope
 * cannot reach the spawn without reaching the bundle.
 *
 * The two added keys are the ones a HOST may declare and the framework reads
 * back (`readResult`: `cost_usd`, `session_id`). They are not part of what a
 * sub-agent returns — which is exactly why the spawned schema does not carry
 * them and this one does. `--commit`'s own reader is TOLERANT: it coerces a
 * missing `outputs` to `[]` rather than refusing, so this schema is the contract
 * asked for and enforced literally on the spawned path, and
 * `tldrx next --commit --check` is what says which parts of it a host's file is
 * about to have coerced.
 */
export const DEVELOPER_RESULT_SCHEMA = {
  ...ENVELOPE_SCHEMA,
  properties: {
    ...ENVELOPE_SCHEMA.properties,
    cost_usd: { type: ["number", "null"] },
    session_id: { type: ["string", "null"] },
  },
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
  /**
   * The JSONL event tag (`"result"` on every doc `resolveResultDoc`'s stream
   * branch returns). ADDITIVE (gh #348): only `resolveResultDoc`'s whole-buffer
   * fallback can hand `interpret` a parsed object that lacks this or carries some
   * other value — real `stream-json` output never does — and that shape is
   * exactly what `spawnAgent.ts`'s `describeFailure` calls `malformed_result`.
   */
  readonly type?: unknown;
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

/**
 * The four counters as ONE `agent.result` payload block, in ONE key order, for
 * every emitter (gh #222).
 *
 * Three call sites write this block — the stage spawn, the gate signer, and
 * (since #222) the executor path that had been dropping all four — and the event
 * log is diffed by humans and frozen byte-for-byte by `test/build-golden.test.ts`,
 * so "the same four keys in the same order" is a property that has to live in one
 * place rather than be retyped correctly three times.
 *
 * The block is the provider's frame VERBATIM: a turn that read nothing from the
 * cache says `0` here, because the event's job is to record what came back. The
 * run.yml ROW is the surface where a `0` is refused instead of written
 * (`runNext.ts`'s `tokenSplit`/`cacheSplit`) — there a zero is indistinguishable
 * from "no usage object at all" and would be a number nobody measured.
 */
export function usagePayload(usage: AgentUsage): Record<string, number> {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  };
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
  return { outputs, questions_asked: questions, notes: readNotes(doc.notes).notes };
}

/**
 * The ONE test for "is this array element a string the reader will keep?".
 *
 * `pending.ts`'s `strings()` filters `outputs`/`questions_asked` through it, and
 * `readNotes` below filters a `notes` array through the same one — silently, in
 * both cases: an element that fails it is simply not in what the reader returns.
 * `tldrx next --commit --check` names those elements before the turn is spent,
 * and it must name exactly the ones the reader drops, so it CALLS this rather
 * than restating `typeof v === "string"` a second time (`checkDeveloper`,
 * resultCheck.ts). One implementation per derivation: a second predicate is the
 * only bug any of the three sides can have.
 *
 * It lives here, in the file that holds the schema those readers are reading
 * against, because `envelope.ts` imports nothing — the leaf both the spawned path
 * and the host path can reach without a cycle.
 */
export function isResultStringElement(value: unknown): value is string {
  return typeof value === "string";
}

/** What `readNotes` did, so `--check` can say it without re-deriving it. */
export interface NotesRead {
  /** What the reader returns for this field. */
  readonly notes: string;
  /** `string`: taken as written. `joined`: an array, joined. `empty`: neither. */
  readonly kind: "string" | "joined" | "empty";
  /** `joined` only: how many elements survived, and the indices that did not. */
  readonly kept: number;
  readonly dropped: readonly number[];
}

/**
 * The ONE reader for the envelope's `notes` (gh #217).
 *
 * Measured on a 0.14.3 security-patch run: an in-session developer wrote `notes`
 * as an ARRAY of strings, one per note, and both readers' `typeof … === "string"`
 * ternaries read the whole field as `""`. A turn's stated caveats — what it could
 * not verify, what the reviewer should look at, on that run a security patch's —
 * vanished from `run.yml`, the story log and the handoff, and nothing on the
 * `--commit` line said so. That record is wrong in the dangerous direction (§7):
 * "no notes" reads as "nothing to say".
 *
 * An array of strings IS the notes, so it is JOINED with newlines rather than
 * refused. The alternative — exit 1, "join them yourself" — spends the turn
 * again over a file whose CONTENT is not in doubt, on the path that is tolerant
 * by design (a missing `outputs` reads as `[]` here, `envelope.ts` header). What
 * is NOT tolerable is doing it silently, so `--check` names the join and names
 * any dropped element, through this same return value.
 *
 * Anything else — a number, an object, absent — still reads as `""`: absent with
 * a reason `--check` states, never invented (§7).
 */
export function readNotes(value: unknown): NotesRead {
  if (typeof value === "string") return { notes: value, kind: "string", kept: 1, dropped: [] };
  if (Array.isArray(value)) {
    const elements = value as unknown[];
    const dropped = elements.flatMap((entry, index) => (isResultStringElement(entry) ? [] : [index]));
    const kept = elements.filter(isResultStringElement);
    return { notes: kept.join("\n"), kind: "joined", kept: kept.length, dropped };
  }
  return { notes: "", kind: "empty", kept: 0, dropped: [] };
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
