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
  | {
      readonly kind: "tool-done";
      readonly id: string | null;
      readonly name: string;
      readonly ok: boolean;
      readonly ms: number | null;
      /** A provider may expose repository reads through a coarser command event. */
      readonly countsAsRead?: boolean;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "question"; readonly index: number; readonly text: string }
  /**
   * Tokens (every assistant turn) and dollars (the final `result` only).
   * `cacheCreationTokens`/`cacheReadTokens` are the prompt-cache halves, read off
   * the same `usage` object — a write costs 1.25x an input token and a read 0.1x,
   * so which of the two a turn did is the difference the reorder is measured by.
   */
  | {
      readonly kind: "cost";
      readonly usd: number | null;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheCreationTokens: number;
      readonly cacheReadTokens: number;
    }
  | { readonly kind: "done"; readonly ok: boolean; readonly structured: unknown; readonly costUsd: number }
  | { readonly kind: "error"; readonly message: string }
  /**
   * How many `Read`/`Glob`/`Grep` calls have COMPLETED, against the stage's
   * `max_reads` (0 = uncapped). Published by `spawnAgent`, which is the only
   * place that knows the cap; the parser below never emits one.
   */
  | { readonly kind: "reads"; readonly count: number; readonly cap: number }
  /**
   * The provider's own quota frame, arriving WHILE the turn is still working
   * (gh #298). Additive: it was parsed as noise until this event existed.
   *
   * MEASURED, `test/fixtures/agent/stream-json.jsonl:9` (`claude` 2.1.251), one
   * `{"type":"rate_limit_event","rate_limit_info":{…}}` line per frame:
   * `status` is the provider's own word — `allowed` there, and `allowed_warning`
   * at `utilization: 0.92` on a live turn (gh #298's thread, the owner's
   * measurement, cited as his) — `rateLimitType` names the window (`five_hour`,
   * `seven_day`), `utilization` is 0..1 of it and `resetsAt` is EPOCH SECONDS, so
   * a reader has a real deadline and never parses English.
   *
   * Every field but `status` is nullable because a frame may omit it: the
   * measured `allowed` sample carries no top-level `utilization` at all. A
   * missing number is null — never a zero, which would read as "none used".
   */
  | {
      readonly kind: "rate-limit";
      readonly status: string;
      readonly window: string | null;
      readonly utilization: number | null;
      readonly resetsAt: number | null;
    };

/**
 * The provider's own quota words for one frame, with nothing added (gh #298).
 *
 * ONE derivation of this sentence (AGENTS.md §7): the progress view and the
 * executor that parks a run on it must not describe the same frame differently.
 * Every figure is the provider's or it is left out entirely — a window it did
 * not name, a utilization it did not state and a reset it did not give are
 * absent, never a default. `resetsAt` is epoch SECONDS.
 */
export function rateLimitLine(frame: {
  readonly status: string;
  readonly window: string | null;
  readonly utilization: number | null;
  readonly resetsAt: number | null;
}): string {
  const parts = [frame.status];
  if (frame.utilization !== null) parts.push(`${String(Math.round(frame.utilization * 100))}% of`);
  parts.push(frame.window === null ? "the provider's window" : `the ${frame.window} window`);
  if (frame.resetsAt !== null) parts.push(`· resets ${new Date(frame.resetsAt * 1000).toISOString()}`);
  return parts.join(" ");
}

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
 * What `resolveCodexResultDoc` says when a turn COMPLETED but its structured
 * envelope did not parse. Exported (gh #348) so `spawnAgent.ts`'s failure
 * classifier can name this exact shape `malformed_result` by matching the one
 * string this function writes, rather than a second copy of the sentence.
 */
export const CODEX_ENVELOPE_UNREADABLE = "the Codex structured output envelope was unreadable";

/** Normalize a completed Codex JSONL turn into the result shape the facilitator consumes. */
export function resolveCodexResultDoc(stdout: string): Record<string, unknown> | null {
  let threadId: string | null = null;
  let result = "";
  let structured: Record<string, unknown> | null = null;
  let usage: Record<string, unknown> | null = null;
  let failure: string | null = null;
  let completed = false;

  for (const line of stdout.trim().split("\n")) {
    const doc = parseLine(line);
    if (doc === null) continue;
    if (doc.type === "thread.started") threadId = str(doc.thread_id);
    if (doc.type === "turn.failed") failure = str(obj(doc.error)?.message) ?? "the Codex turn failed";
    if (doc.type === "turn.completed") {
      completed = true;
      usage = obj(doc.usage);
    }
    if (doc.type !== "item.completed") continue;
    const item = obj(doc.item);
    if (item?.type !== "agent_message") continue;
    const text = str(item.text);
    if (text === null) continue;
    result = text;
    const parsed = parseLine(text);
    if (parsed !== null) structured = parsed;
  }
  if (completed && structured === null && failure === null) {
    failure = CODEX_ENVELOPE_UNREADABLE;
  }
  if (!completed && failure === null) return null;
  return {
    result,
    session_id: threadId,
    total_cost_usd: 0,
    usage: {
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_creation_input_tokens: num(usage?.cache_write_input_tokens),
      cache_read_input_tokens: num(usage?.cached_input_tokens),
    },
    structured_output: structured,
    is_error: failure !== null,
    errors: failure === null ? [] : [failure],
  };
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
  private readonly provider: "claude" | "codex";
  private codexStructured: unknown = null;
  private questionCount = 0;

  constructor(provider: "claude" | "codex" = "claude") {
    this.provider = provider;
  }

  /** Parse one line. Returns [] for a line that is noise, unparseable, or unknown. */
  push(line: string): readonly AgentEvent[] {
    const doc = parseLine(line);
    if (doc === null) return [];
    if (this.provider === "codex") return this.codex(doc);
    switch (doc.type) {
      case "system": return this.system(doc);
      case "assistant": return this.assistant(doc);
      case "user": return this.user(doc);
      case "result": return this.result(doc);
      case "rate_limit_event": return this.rateLimit(doc);
      default: return [];
    }
  }

  /** `codex exec --json`, measured from codex-cli 0.152.0 on 2026-09-02. */
  private codex(doc: Record<string, unknown>): readonly AgentEvent[] {
    if (doc.type === "thread.started") {
      return [{ kind: "start", model: null, sessionId: str(doc.thread_id) }];
    }
    if (doc.type === "turn.failed") {
      return [{ kind: "error", message: str(obj(doc.error)?.message) ?? "the Codex turn failed" }];
    }
    if (doc.type === "turn.completed") {
      const usage = obj(doc.usage);
      const structured = this.codexStructured;
      return [
        {
          kind: "cost",
          usd: null,
          inputTokens: num(usage?.input_tokens),
          outputTokens: num(usage?.output_tokens),
          cacheCreationTokens: num(usage?.cache_write_input_tokens),
          cacheReadTokens: num(usage?.cached_input_tokens),
        },
        ...this.questions(obj(structured)?.questions_asked),
        { kind: "done", ok: true, structured, costUsd: 0 },
      ];
    }
    if (doc.type !== "item.started" && doc.type !== "item.completed") return [];
    const item = obj(doc.item);
    if (item === null) return [];
    const id = str(item.id);
    if (item.type === "agent_message") {
      const message = str(item.text);
      if (message === null) return [];
      const structured = parseLine(message);
      if (structured !== null) this.codexStructured = structured;
      return [{ kind: "text", text: message }];
    }
    if (item.type !== "command_execution") return [];
    const command = str(item.command);
    if (doc.type === "item.started") {
      return [{ kind: "tool", id, name: "Bash", target: command }];
    }
    return [{
      kind: "tool-done",
      id,
      name: "Bash",
      ok: item.status === "completed" && (item.exit_code === 0 || item.exit_code === null),
      ms: null,
      // Codex reports one command primitive rather than separate Read/Glob/Grep
      // tools. Counting completions is conservative, provider-enforceable, and
      // keeps max_reads meaningful without pretending the command was a Read.
      countsAsRead: true,
    }];
  }

  private system(doc: Record<string, unknown>): readonly AgentEvent[] {
    // `init` is the only system subtype worth a line: it names the model that is
    // about to spend money. `hook_started`, `hook_response`, `thinking_tokens`
    // and the rest are machinery.
    if (doc.subtype !== "init") return [];
    return [{ kind: "start", model: str(doc.model), sessionId: str(doc.session_id) }];
  }

  /**
   * One `rate_limit_event` line (gh #298).
   *
   * `utilization` and `resetsAt` are read from the frame's top level first and
   * from `unifiedWindows[rateLimitType]` only as the fallback the measured
   * samples require — the `allowed` frame states them per window and not at the
   * top, the two `allowed_warning` frames state the same number in both places.
   * A frame this cannot read a `status` off is DROPPED, like every other
   * unrecognised shape here: a quota claim nobody can name is not a signal.
   */
  private rateLimit(doc: Record<string, unknown>): readonly AgentEvent[] {
    const info = obj(doc.rate_limit_info);
    const status = str(info?.status);
    if (info === null || status === null) return [];
    const window = str(info.rateLimitType);
    const named = window === null ? null : obj(obj(info.unifiedWindows)?.[window]);
    return [{
      kind: "rate-limit",
      status,
      window,
      utilization: maybeNum(info.utilization) ?? maybeNum(named?.utilization),
      resetsAt: maybeNum(info.resetsAt) ?? maybeNum(named?.resetsAt),
    }];
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
        cacheCreationTokens: num(usage.cache_creation_input_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
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
      cacheCreationTokens: num(usage?.cache_creation_input_tokens),
      cacheReadTokens: num(usage?.cache_read_input_tokens),
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

/**
 * What the agent CLI's own permission layer says when a call is not on the
 * allowance and nobody is there to approve it (gh #209, gh #261).
 *
 * MEASURED twice, in two different workspaces and two different years of the
 * defect: "This command requires approval to run" (#209, a developer granted
 * only the exact `Bash(npm run test)` form) and "This command requires
 * approval" (#261, a developer asking for `git rm`). The SUBSTRING is what is
 * matched, because those two readings differ in their tail and agreeing on a
 * whole sentence would be a guess about a string this repo does not own.
 *
 * It is NOT a hook `deny` — a hook refusal is this framework's own doing and
 * already lands in the story's record. This one is the provider's, it happens
 * before any hook, and in `-p` mode the approval it waits for never comes.
 */
export const PERMISSION_REFUSAL_MARK = "requires approval";

/**
 * The STRUCTURAL half, and the one that is actually load-bearing.
 *
 * MEASURED, `claude` 2.1.270, 2026-09-12, on the probes that measured the
 * `Bash(git rm *)` grant: a `user` line whose tool call the permission layer
 * refused carries a sibling
 * `tool_result_meta: [{ id, non_execution_kind: "user-rejected" }]`. It was
 * present on BOTH refusals — the unlisted `git -C … rm` ("This command requires
 * approval") and the `cd … && git rm` safety check, whose sentence is entirely
 * different — and ABSENT (`null`) on all three commands that ran, including
 * `git rm -- <path outside the repo>`, which the layer allowed and GIT refused
 * with `is_error: true`. So this field separates "the layer would not run it"
 * from "it ran and failed", which the sentence alone cannot do.
 */
const NON_EXECUTION_REJECTED = "user-rejected";

/**
 * The FIRST command a turn was refused approval for, or null.
 *
 * Why here: this file is the one that knows the `stream-json` shapes, and the
 * command lives on the `tool_use` while the refusal lives on the matching
 * `tool_result` — pairing them is the same `tool_use_id` join `AgentStream`
 * already does, off the same `parseLine`/`obj`/`toolTarget` helpers, so there is
 * no second opinion here about what a tool call looks like.
 *
 * TWO signals, in this order, and the ordering is the fix for a real defect that
 * pre-merge review caught. FIRST the structural `non_execution_kind:
 * "user-rejected"` above, which is the host telling us in a field rather than in
 * a paragraph. SECOND, as a FALLBACK for a host that does not emit that field,
 * the `requires approval` sentence — and only when the call was a `Bash` one AND
 * the result is `is_error: true`.
 *
 * Why the fallback is fenced that way: the first version of this function
 * matched the sentence anywhere in any `tool_result`, so a plain `Read` of a
 * file CONTAINING the phrase read as a refusal — and this repo's own
 * `docs/spec.md`, `CHANGELOG.md` and two docs-site guides contain it, so
 * "a developer greps the docs" was enough. The direction that costs is the false
 * POSITIVE, not the miss: the caller blocks the story BEFORE the DoD and before
 * the commit, so a wrong reading throws away work the developer really did, with
 * no diff and the attempt spent. Both measured refusals are `Bash` and
 * `is_error: true`, so the fence loses no coverage.
 *
 * **The fallback depends on prose the HOST writes and can change without
 * warning** — that is stated rather than papered over. The structural field is
 * the one to trust, the sentence is a net under it, and a refusal that has
 * neither is a miss this function will take over a false positive.
 *
 * Claude only. `[inferred]` for Codex: `codex exec` is run under `--sandbox`
 * rather than a per-tool allowance, its `command_execution` items carry an exit
 * code and no approval result, and nothing measured has shown either signal on a
 * Codex stream — so rather than match a shape nobody has seen, this returns null
 * and says so.
 */
export function permissionRefusal(
  stdout: string,
  provider: "claude" | "codex" = "claude",
): string | null {
  if (provider === "codex") return null;
  // Per `tool_use` id: which tool it was, and what it asked for.
  const calls = new Map<string, { name: string; target: string }>();
  for (const line of stdout.split("\n")) {
    const doc = parseLine(line);
    if (doc === null) continue;
    if (doc.type === "assistant") {
      const blocks = Array.isArray(obj(doc.message)?.content) ? (obj(doc.message)?.content as unknown[]) : [];
      for (const raw of blocks) {
        const block = obj(raw);
        if (block === null || block.type !== "tool_use") continue;
        const id = str(block.id);
        const name = str(block.name) ?? "tool";
        if (id === null) continue;
        calls.set(id, { name, target: toolTarget(name, obj(block.input)) ?? name });
      }
      continue;
    }
    if (doc.type !== "user") continue;
    const rejected = rejectedIds(doc.tool_result_meta);
    const blocks = Array.isArray(obj(doc.message)?.content) ? (obj(doc.message)?.content as unknown[]) : [];
    for (const raw of blocks) {
      const block = obj(raw);
      if (block === null || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const call = id === null ? undefined : calls.get(id);
      const structural = id !== null && rejected.has(id);
      // The fallback, fenced: a `Bash` call, an errored result, and the sentence.
      // A successful call, or any other tool, is never a refusal however its
      // output reads.
      const byPhrase = call?.name === "Bash"
        && block.is_error === true
        && resultText(block.content).toLowerCase().includes(PERMISSION_REFUSAL_MARK);
      if (!structural && !byPhrase) continue;
      // The command it ASKED for. A refusal whose `tool_use` never arrived names
      // no command, and this says so rather than inventing one (§7).
      return call?.target ?? "a command this transcript does not name";
    }
  }
  return null;
}

/** The `tool_use` ids a `user` line's `tool_result_meta` marks as never executed. */
function rejectedIds(meta: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!Array.isArray(meta)) return ids;
  for (const raw of meta) {
    const row = obj(raw);
    if (row === null || row.non_execution_kind !== NON_EXECUTION_REJECTED) continue;
    const id = str(row.id);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** A `tool_result.content`: a string, or the blocks the API wraps one in. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((raw) => str(obj(raw)?.text) ?? "").join("\n");
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

/**
 * The same read as `num`, except that ABSENT stays absent (gh #298).
 *
 * A quota figure is the one place a defaulted `0` is a lie in the dangerous
 * direction — "nothing of this window is used" — so a frame that did not state
 * one says null and whoever records it says why (AGENTS.md §7).
 */
function maybeNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An RFC3339 timestamp as epoch millis, or null when it is neither. */
function millis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
