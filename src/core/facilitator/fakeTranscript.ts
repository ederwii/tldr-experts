/**
 * The fake `claude`'s output, in whichever format it was actually asked for.
 *
 * Shared by every stand-in for `claude` in this repo — the four test fakes and
 * the tutorial's sandbox agent (`core/learn/learnAgent.ts`) — so there is ONE
 * place that knows what `--output-format stream-json` looks like, and so a fake
 * can never drift into emitting a shape the real CLI does not.
 *
 * It lives in `src/` rather than in `test/fixtures/` because `tldrx learn` needs
 * it at RUNTIME and `test/` is not shipped (package.json `files`). It sits beside
 * `agentEvents.ts`, which is the READER of this format: the two are a matched
 * pair, and a writer that drifts from its reader is the only bug either can have.
 * `test/fixtures/fakeStream.ts` re-exports it, so the four fakes are unchanged.
 *
 * The JSONL shapes below are copied from one real, measured call (2026-08-29,
 * `claude` 2.1.251) — see `src/core/facilitator/agentEvents.ts` for the argv and
 * the line-by-line inventory. Fields the parser never reads are trimmed; the
 * ones it does read (`type`, `subtype`, `message.content[].type`, `tool_use.id`,
 * `tool_result.tool_use_id`, `timestamp`, `structured_output`, `total_cost_usd`,
 * `usage`, `is_error`, `session_id`, `result`, `errors`) are verbatim.
 *
 * The single-blob `json` branch is byte-for-byte what these fakes printed before
 * wave K, so the fallback parser is exercised by every test that runs an older
 * format — which is the same guarantee an older `claude` gets.
 */

export interface FakeTool {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** The tool_result body. Defaults to "ok". */
  readonly result?: string;
  /** Milliseconds between the tool_use and its result, for a stable duration. */
  readonly ms?: number;
}

export interface FakeResult {
  readonly isError: boolean;
  readonly result: string;
  readonly sessionId: string;
  readonly costUsd: number;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly structured: unknown;
  readonly errors: readonly string[];
  readonly model?: string;
  /** Assistant prose, emitted as a `text` block before the tools. */
  readonly say?: string;
  readonly tools?: readonly FakeTool[];
}

/** True when the caller asked for the streaming format. */
export function wantsStream(argv: readonly string[]): boolean {
  const at = argv.indexOf("--output-format");
  return at !== -1 && argv[at + 1] === "stream-json";
}

/** Everything the fake prints on stdout, in the requested format. */
export function claudeOutput(argv: readonly string[], spec: FakeResult): string {
  const final = {
    type: "result",
    subtype: spec.isError ? "error_during_execution" : "success",
    is_error: spec.isError,
    result: spec.result,
    session_id: spec.sessionId,
    total_cost_usd: spec.costUsd,
    usage: spec.usage,
    structured_output: spec.structured,
    errors: [...spec.errors],
  };
  if (!wantsStream(argv)) return `${JSON.stringify(final)}\n`;

  // A fixed epoch so every duration a test sees is the same number twice.
  const epoch = Date.parse("2026-08-29T12:00:00.000Z");
  let clock = epoch;
  const stamp = (): string => new Date(clock).toISOString();
  const lines: unknown[] = [
    { type: "system", subtype: "hook_started", hook_name: "SessionStart", session_id: spec.sessionId },
    {
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: spec.sessionId,
      model: spec.model ?? "claude-fake-1",
      permissionMode: "default",
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    },
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 64, session_id: spec.sessionId },
  ];

  if (spec.say !== undefined && spec.say !== "") {
    lines.push(assistant([{ type: "text", text: spec.say }], stamp(), spec));
  }

  let toolIndex = 0;
  for (const tool of spec.tools ?? []) {
    const id = `toolu_fake${String(toolIndex).padStart(4, "0")}`;
    toolIndex += 1;
    lines.push(assistant(
      [{ type: "tool_use", id, name: tool.name, input: tool.input, caller: { type: "direct" } }],
      stamp(),
      spec,
    ));
    clock += tool.ms ?? 1000;
    lines.push({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: tool.result ?? "ok" }] },
      parent_tool_use_id: null,
      session_id: spec.sessionId,
      timestamp: stamp(),
      tool_use_result: { type: "text", content: tool.result ?? "ok" },
    });
  }

  // The `--json-schema` handshake, as the real CLI does it: a `StructuredOutput`
  // tool_use carrying the envelope, then its acknowledgement.
  const structuredId = "toolu_fakestructured";
  lines.push(assistant(
    [{ type: "tool_use", id: structuredId, name: "StructuredOutput", input: spec.structured, caller: { type: "direct" } }],
    stamp(),
    spec,
  ));
  lines.push({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: structuredId, type: "tool_result", content: "Structured output provided successfully" }],
    },
    session_id: spec.sessionId,
    timestamp: stamp(),
    tool_use_result: "Structured output provided successfully",
  });
  lines.push(final);

  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/**
 * The two JSONL lines for one completed tool call, ready to print on their own.
 *
 * Exported so a fake can emit tools SLOWLY, one flushed line at a time, which is
 * the only way to test something that reacts to the stream while the process is
 * still running — `max_reads` kills a live child, and a fake that prints its
 * whole transcript in one write has already exited before anyone could.
 */
export function toolPairLines(
  spec: FakeResult,
  tool: FakeTool,
  index: number,
  timestamp: string,
): readonly string[] {
  const id = `toolu_slow${String(index).padStart(4, "0")}`;
  return [
    JSON.stringify(assistant(
      [{ type: "tool_use", id, name: tool.name, input: tool.input, caller: { type: "direct" } }],
      timestamp,
      spec,
    )),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: tool.result ?? "ok" }] },
      parent_tool_use_id: null,
      session_id: spec.sessionId,
      timestamp,
      tool_use_result: { type: "text", content: tool.result ?? "ok" },
    }),
  ];
}

function assistant(content: readonly unknown[], timestamp: string, spec: FakeResult): unknown {
  return {
    type: "assistant",
    message: {
      model: spec.model ?? "claude-fake-1",
      id: "msg_fake",
      type: "message",
      role: "assistant",
      content: [...content],
      stop_reason: null,
      usage: { input_tokens: spec.usage.input_tokens, output_tokens: spec.usage.output_tokens },
    },
    parent_tool_use_id: null,
    session_id: spec.sessionId,
    timestamp,
    request_id: "req_fake",
  };
}
