/**
 * `claude --output-format stream-json`, turned into a small typed event stream.
 *
 * Every shape in this file was read off ONE real, measured call (2026-08-29,
 * `claude` 2.1.251), not from memory or documentation:
 *
 *   claude -p --output-format stream-json --verbose --max-budget-usd 0.30 \
 *          --model haiku --json-schema <ENVELOPE_SCHEMA> --allowedTools Read,Grep
 *
 * 25 JSONL lines: `system/hook_started`, `system/hook_response`, `system/init`,
 * a run of `system/thinking_tokens`, `assistant` messages whose `message.content`
 * holds `thinking` / `text` / `tool_use` blocks, `user` messages whose
 * `message.content` holds `tool_result` blocks (plus a sibling `tool_use_result`
 * with the tool's own richer payload), one `rate_limit_event`, and last a single
 * `type: "result"` carrying `structured_output`, `total_cost_usd`, `usage`,
 * `session_id`, `is_error` and `result`.
 *
 * TWO facts that decide the design:
 *
 * 1. `--verbose` is MANDATORY. Without it `claude -p --output-format stream-json`
 *    refuses before spending anything: "When using --print,
 *    --output-format=stream-json requires --verbose".
 * 2. `--json-schema` and `stream-json` coexist. The structured envelope arrives
 *    twice — early, as a `StructuredOutput` tool_use, and finally in the last
 *    `result` event's `structured_output` field, which is byte-identical to what
 *    `--output-format json` used to put there. So the existing validation path is
 *    fed exactly what it was fed before; only the transport changed.
 *
 * A line that does not parse, or an event shape nobody here recognises, is
 * DROPPED. This is a progress view: it may never be the reason a stage fails.
 */

/** One thing worth telling a waiting human about. */
export type AgentEvent =
  | { readonly kind: "start"; readonly model: string | null; readonly sessionId: string | null }
  | { readonly kind: "tool"; readonly id: string | null; readonly name: string; readonly target: string | null }
  /**
   * The other half of `tool`. Two events rather than one because the interesting
   * moment is BOTH — "`$ bun test` → running" is what you want on screen for the
   * ninety seconds it runs, and "→ ok (92 s)" is what you want after.
   */
  | { readonly kind: "tool-done"; readonly id: string | null; readonly name: string; readonly ok: boolean; readonly ms: number | null }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "question"; readonly index: number; readonly text: string }
  | { readonly kind: "cost"; readonly usd: number | null; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "done"; readonly ok: boolean; readonly structured: unknown; readonly costUsd: number }
  | { readonly kind: "error"; readonly message: string };

/**
 * The tool the model calls to satisfy `--json-schema`. It is an implementation
 * detail of structured output, not work the human asked for, so it never appears
 * as a tool line — its INPUT is mined for questions instead.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** Which output format a stdout stream is, decided on its first line. */
export type StreamFormat = "stream" | "json";

/**
 * `stream-json` and `json` differ in exactly one observable way on line 1: the
 * single-blob format's first line IS the result. An older `claude` that ignored
 * `--output-format stream-json`, or a fixture still emitting one object, is
 * therefore detected rather than mis-parsed.
 */
export function detectStreamFormat(firstLine: string): StreamFormat {
  const doc = parseLine(firstLine);
  if (doc === null) return "json";
  return doc.type === "result" ? "json" : "stream";
}

/**
 * The `result` object, whichever format produced it.
 *
 * Whole-buffer `JSON.parse` first, so a pretty-printed single blob (which has no
 * usable "first line" at all) still resolves; then the LAST `type: "result"`
 * line of a JSONL stream. Null when the process produced neither — which is what
 * `interpret` already turns into "claude exited N without parseable output".
 */
export function resolveResultDoc(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    const whole: unknown = JSON.parse(trimmed);
    if (typeof whole === "object" && whole !== null && !Array.isArray(whole)) {
      return whole as Record<string, unknown>;
    }
  } catch {
    // Not one object — fall through to JSONL.
  }
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const doc = parseLine(lines[i] ?? "");
    if (doc !== null && doc.type === "result") return doc;
  }
  return null;
}

/**
 * The stateful half: a JSONL line in, zero or more `AgentEvent`s out.
 *
 * State is only what a line cannot carry by itself — which tool a `tool_result`
 * belongs to (matched on `tool_use_id`), when that tool started (so a duration is
 * a subtraction of two timestamps the stream already carries, never a clock this
 * process read), and which questions have already been announced.
 */
export class AgentStream {
  private readonly openTools = new Map<string, { name: string; at: number | null }>();
  private readonly seenQuestions = new Set<string>();
  private questionCount = 0;

  /** Parse one line. Returns [] for a line that is noise, unparseable, or unknown. */
  push(line: string): readonly AgentEvent[] {
    const doc = parseLine(line);
    if (doc === null) return [];
    switch (doc.type) {
      case "system": return this.system(doc);
      case "assistant": return this.assistant(doc);
      case "user": return this.user(doc);
      case "result": return this.result(doc);
      default: return [];
    }
  }

  private system(doc: Record<string, unknown>): readonly AgentEvent[] {
    // `init` is the only system subtype worth a line: it names the model that is
    // about to spend money. `hook_started`, `hook_response`, `thinking_tokens`
    // and the rest are machinery.
    if (doc.subtype !== "init") return [];
    return [{ kind: "start", model: str(doc.model), sessionId: str(doc.session_id) }];
  }

  private assistant(doc: Record<string, unknown>): readonly AgentEvent[] {
    const message = obj(doc.message);
    const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    const at = millis(doc.timestamp);
    const events: AgentEvent[] = [];

    for (const raw of blocks) {
      const block = obj(raw);
      if (block === null) continue;
      if (block.type === "text") {
        const text = str(block.text);
        if (text !== null && text.trim() !== "") events.push({ kind: "text", text: text.trim() });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const name = str(block.name) ?? "tool";
      const id = str(block.id);
      if (name === STRUCTURED_OUTPUT_TOOL) {
        // The envelope, arriving early. Its `questions_asked` is the only place a
        // waiting human can learn a question was asked before the run ends.
        events.push(...this.questions(obj(block.input)?.questions_asked));
        continue;
      }
      if (id !== null) this.openTools.set(id, { name, at });
      events.push({ kind: "tool", id, name, target: toolTarget(name, obj(block.input)) });
    }

    const usage = obj(message?.usage);
    if (usage !== null) {
      events.push({
        kind: "cost",
        usd: null,
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
      });
    }
    return events;
  }

  private user(doc: Record<string, unknown>): readonly AgentEvent[] {
    const message = obj(doc.message);
    const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    const at = millis(doc.timestamp);
    const events: AgentEvent[] = [];
    for (const raw of blocks) {
      const block = obj(raw);
      if (block === null || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const open = id === null ? undefined : this.openTools.get(id);
      if (id !== null) this.openTools.delete(id);
      if (open === undefined) continue;
      events.push({
        kind: "tool-done",
        id,
        name: open.name,
        // `is_error` is the Anthropic tool_result flag; absent means it worked.
        ok: block.is_error !== true,
        ms: at === null || open.at === null ? null : Math.max(0, at - open.at),
      });
    }
    return events;
  }

  private result(doc: Record<string, unknown>): readonly AgentEvent[] {
    const events: AgentEvent[] = [];
    const structured = doc.structured_output ?? null;
    events.push(...this.questions(obj(structured)?.questions_asked));

    const cost = typeof doc.total_cost_usd === "number" ? doc.total_cost_usd : 0;
    const usage = obj(doc.usage);
    events.push({
      kind: "cost",
      usd: cost,
      inputTokens: num(usage?.input_tokens),
      outputTokens: num(usage?.output_tokens),
    });

    const ok = doc.is_error !== true;
    if (!ok) {
      const errors = Array.isArray(doc.errors) ? (doc.errors as unknown[]) : [];
      const first = errors.find((entry): entry is string => typeof entry === "string");
      events.push({ kind: "error", message: first ?? str(doc.subtype) ?? "the sub-agent reported an error" });
    }
    events.push({ kind: "done", ok, structured, costUsd: cost });
    return events;
  }

  /** Announce each question once, however many times the envelope repeats it. */
  private questions(value: unknown): readonly AgentEvent[] {
    if (!Array.isArray(value)) return [];
    const events: AgentEvent[] = [];
    for (const entry of value as unknown[]) {
      if (typeof entry !== "string" || entry.trim() === "") continue;
      const text = entry.trim();
      if (this.seenQuestions.has(text)) continue;
      this.seenQuestions.add(text);
      this.questionCount += 1;
      events.push({ kind: "question", index: this.questionCount, text });
    }
    return events;
  }
}

/**
 * What a tool is DOING TO, in one string.
 *
 * Keyed on the tool name because the interesting field is named differently in
 * each one, and a generic "first string in the input" would print a Bash
 * `description` where the command belongs. Unknown tools fall back to exactly
 * that generic rule, so a new tool degrades to something rather than nothing.
 */
export function toolTarget(name: string, input: Record<string, unknown> | null): string | null {
  if (input === null) return null;
  const named = ((): unknown => {
    switch (name) {
      case "Read": case "Write": case "NotebookEdit": return input.file_path ?? input.notebook_path;
      case "Edit": case "MultiEdit": return input.file_path;
      case "Bash": case "BashOutput": return input.command;
      case "Grep": case "Glob": return input.pattern;
      case "WebFetch": return input.url;
      case "WebSearch": return input.query;
      case "Task": case "Agent": return input.description;
      case "TodoWrite": return null;
      default: return null;
    }
  })();
  if (typeof named === "string" && named !== "") return named;
  if (named !== null && named !== undefined) return null;
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  try {
    const doc: unknown = JSON.parse(trimmed);
    return typeof doc === "object" && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** An RFC3339 timestamp as epoch millis, or null when it is neither. */
function millis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
