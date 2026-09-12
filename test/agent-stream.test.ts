/**
 * `--output-format stream-json`, parsed.
 *
 * The transcript in `fixtures/agent/stream-json.jsonl` is a REAL one: `claude`
 * 2.1.251, one measured call on 2026-08-29 that cost $0.0567426, with the paths
 * scrubbed and the 7 KB hook_response line dropped. Every tool_use / tool_result
 * shape asserted below is the CLI's own, not one this repo invented.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import {
  AgentStream, detectStreamFormat, permissionRefusal, resolveCodexResultDoc, resolveResultDoc, toolTarget,
  type AgentEvent,
} from "../src/core/facilitator/agentEvents.ts";
import { interpret } from "../src/core/facilitator/spawnAgent.ts";
import { codexOutput } from "../src/core/facilitator/fakeTranscript.ts";
import { readCapError } from "../src/core/facilitator/readCap.ts";
import { LineSplitter } from "../src/core/runtime/lineSplitter.ts";

const TRANSCRIPT = readFileSync(
  join(FRAMEWORK_ROOT, "test", "fixtures", "agent", "stream-json.jsonl"),
  "utf8",
);

/** Real `codex exec --ephemeral --json`, codex-cli 0.152.0, recorded 2026-09-02. */
const CODEX_TRANSCRIPT = readFileSync(
  join(FRAMEWORK_ROOT, "test", "fixtures", "agent", "codex-jsonl.jsonl"),
  "utf8",
);

/** The measured cost of the one real call that produced the fixture. */
const REAL_COST = 0.0567426;

function replay(text: string): readonly AgentEvent[] {
  const stream = new AgentStream();
  const out: AgentEvent[] = [];
  for (const line of text.split("\n")) out.push(...stream.push(line));
  return out;
}

/** The single-blob body an older `claude` (or `--output-format json`) returns. */
function legacyBlob(): string {
  return `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "sess-legacy",
    total_cost_usd: 0.25,
    usage: { input_tokens: 10, output_tokens: 2 },
    structured_output: { outputs: ["a.md"], questions_asked: [], notes: "" },
    errors: [],
  })}\n`;
}

describe("the real transcript", () => {
  test("yields start, both tools with their targets, a cost and a done", () => {
    const events = replay(TRANSCRIPT);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("start");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("tool-done");
    expect(kinds[kinds.length - 1]).toBe("done");

    const start = events.find((e) => e.kind === "start");
    expect(start).toMatchObject({ kind: "start", model: "claude-haiku-4-5-20251001" });

    const tools = events.filter((e) => e.kind === "tool");
    expect(tools).toEqual([
      { kind: "tool", id: expect.any(String), name: "Read", target: "/work/demo/tiny.md" },
      { kind: "tool", id: expect.any(String), name: "Grep", target: "Outbox" },
    ]);
  });

  test("the StructuredOutput tool is machinery, not a tool line", () => {
    const tools = replay(TRANSCRIPT).filter((e) => e.kind === "tool");
    expect(tools.map((e) => e.kind === "tool" && e.name)).not.toContain("StructuredOutput");
  });

  test("tool durations come from the stream's own timestamps, not a clock", () => {
    const done = replay(TRANSCRIPT).filter((e) => e.kind === "tool-done");
    expect(done).toHaveLength(2);
    // 00:44:02.508 -> 00:44:02.521 and 00:44:03.221 -> 00:44:03.233, verbatim.
    expect(done.map((e) => (e.kind === "tool-done" ? e.ms : null))).toEqual([13, 12]);
    expect(done.every((e) => e.kind === "tool-done" && e.ok)).toBe(true);
  });

  test("the final result carries the measured cost and the --json-schema envelope", () => {
    const events = replay(TRANSCRIPT);
    const last = events[events.length - 1];
    expect(last).toEqual({
      kind: "done",
      ok: true,
      costUsd: REAL_COST,
      structured: { outputs: ["tiny.md"], questions_asked: [], notes: "Found Outbox on line two" },
    });
    const cost = events.filter((e) => e.kind === "cost" && e.usd !== null);
    expect(cost).toHaveLength(1);
    expect(cost[0]).toMatchObject({ kind: "cost", usd: REAL_COST });
  });
});

describe("the real Codex transcript", () => {
  test("keeps thread identity, command pairs, structured output and token usage", () => {
    const stream = new AgentStream("codex");
    const events = CODEX_TRANSCRIPT.split("\n").flatMap((line) => stream.push(line));
    expect(events[0]).toEqual({
      kind: "start", model: null, sessionId: "01a06472-03bb-7ba3-abd2-820c96afe586",
    });
    expect(events.filter((event) => event.kind === "tool")).toEqual([{
      kind: "tool", id: "item_1", name: "Bash", target: "/bin/zsh -lc \"sed -n '1,200p' tiny.md\"",
    }]);
    expect(events.filter((event) => event.kind === "tool-done")).toEqual([{
      kind: "tool-done", id: "item_1", name: "Bash", ok: true, ms: null, countsAsRead: true,
    }]);
    expect(events.find((event) => event.kind === "cost")).toMatchObject({
      kind: "cost", usd: null, inputTokens: 37682, outputTokens: 164,
      cacheReadTokens: 18176, cacheCreationTokens: 0,
    });
    expect(events.at(-1)).toEqual({
      kind: "done",
      ok: true,
      costUsd: 0,
      structured: {
        outputs: ["tiny.md"], questions_asked: [],
        notes: "tiny.md contains one line: Outbox lives on line two.",
      },
    });
  });

  test("interpret uses the Codex thread as session identity and never invents dollars", () => {
    const outcome = interpret(0, CODEX_TRANSCRIPT, "", false, "codex");
    expect(outcome.ok).toBe(true);
    expect(outcome.metered).toBe(false);
    expect(outcome.costUsd).toBe(0);
    expect(outcome.sessionId).toBe("01a06472-03bb-7ba3-abd2-820c96afe586");
    expect(outcome.envelope?.outputs).toEqual(["tiny.md"]);
  });

  test("the shared Codex emitter produces a stream consumed by the real parser", () => {
    const stdout = codexOutput({
      sessionId: "01a06472-03bb-7ba3-abd2-820c96afe586",
      structured: { outputs: ["answer.md"], questions_asked: [], notes: "done" },
      usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 },
    });
    const outcome = interpret(0, stdout, "", false, "codex");
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionId).toBe("01a06472-03bb-7ba3-abd2-820c96afe586");
    expect(outcome.envelope?.outputs).toEqual(["answer.md"]);
    expect(outcome.usage.cache_read_input_tokens).toBe(3);
  });

  test("junk Codex lines are dropped without throwing", () => {
    const stream = new AgentStream("codex");
    for (const line of ["", "not json", "{broken", "[]", '{"type":"future.event"}']) {
      expect(stream.push(line)).toEqual([]);
    }
  });

  test("a Codex stream with no completed result event fails with a reason", () => {
    const stdout = '{"type":"thread.started","thread_id":"session-only"}\n';
    const outcome = interpret(0, stdout, "", false, "codex");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("without a parseable result event");
  });

  test("turn.failed carries the provider error and cannot report success", () => {
    const stdout = codexOutput({
      sessionId: "failed-session",
      error: "the model provider refused the turn",
    });
    const outcome = interpret(1, stdout, "", false, "codex");
    expect(outcome.ok).toBe(false);
    expect(outcome.isError).toBe(true);
    expect(outcome.error).toContain("the model provider refused the turn");
  });

  test("a timed-out Codex turn names the timeout", () => {
    const outcome = interpret(143, "", "", true, "codex");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("codex timed out (killed after the stage's timeout_s)");
  });

  test("a completed Codex turn with an unreadable envelope fails closed", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"bad-envelope"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"```json\\n{\\\"outputs\\\":[]}\\n```"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join("\n");
    const doc = resolveCodexResultDoc(stdout);
    expect(doc?.is_error).toBe(true);
    const outcome = interpret(0, stdout, "", false, "codex");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("structured output envelope was unreadable");
  });

  test("Codex max_reads reports command executions, not fictional file reads", () => {
    expect(readCapError(20, 20, "codex")).toBe(
      "stopped after 20 command executions: the stage's max_reads is 20. "
      + "Raise `max_reads` in the stage file or `--max-reads <n>` for one run, "
      + "or reduce the commands the stage needs to execute.",
    );
  });
});

describe("format detection and result resolution", () => {
  test("the first line tells the two formats apart", () => {
    expect(detectStreamFormat(TRANSCRIPT.split("\n")[0] ?? "")).toBe("stream");
    expect(detectStreamFormat(legacyBlob().trim())).toBe("json");
    expect(detectStreamFormat("{")).toBe("json");
    expect(detectStreamFormat("")).toBe("json");
  });

  test("the result is found in a JSONL stream, a compact blob and a pretty one", () => {
    expect(resolveResultDoc(TRANSCRIPT)?.total_cost_usd).toBe(REAL_COST);
    expect(resolveResultDoc(legacyBlob())?.session_id).toBe("sess-legacy");
    const pretty = JSON.stringify(JSON.parse(legacyBlob()), null, 2);
    expect(resolveResultDoc(pretty)?.session_id).toBe("sess-legacy");
    expect(resolveResultDoc("")).toBeNull();
    expect(resolveResultDoc("not json at all")).toBeNull();
  });

  test("a stream with no result event resolves to nothing rather than to a guess", () => {
    const truncated = TRANSCRIPT.split("\n").slice(0, 5).join("\n");
    expect(resolveResultDoc(truncated)).toBeNull();
  });
});

describe("interpret, over either format", () => {
  test("reads the real stream exactly as it read the old single blob", () => {
    const streamed = interpret(0, TRANSCRIPT, "", false);
    expect(streamed.ok).toBe(true);
    expect(streamed.costUsd).toBe(REAL_COST);
    expect(streamed.sessionId).toBe("dbe28c6b-d630-487e-99e3-d02bf76895f7");
    expect(streamed.envelope).toEqual({
      outputs: ["tiny.md"], questions_asked: [], notes: "Found Outbox on line two",
    });

    const blob = interpret(0, legacyBlob(), "", false);
    expect(blob.ok).toBe(true);
    expect(blob.costUsd).toBe(0.25);
    expect(blob.envelope?.outputs).toEqual(["a.md"]);
  });

  test("a process that produced nothing parseable is still a named failure", () => {
    const outcome = interpret(1, "", "claude: command not found", false);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("without a parseable result event");
    expect(outcome.error).toContain("command not found");
  });

  /**
   * The invented `$0.00`. A Claude result event WITHOUT `total_cost_usd` is a turn
   * whose dollars nothing here saw — and `metered: true` on it made `runNext` write
   * `cost_usd: 0`, a measurement, and a false one. The field's own contract
   * (`spawnAgent.ts` `AgentOutcome.metered`) always said what this now does.
   */
  test("a Claude result with no total_cost_usd is UNMETERED, not a metered $0.00", () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "sess-nousd",
      usage: { input_tokens: 11, output_tokens: 22 },
      structured_output: { outputs: [], questions_asked: [], notes: "" },
    });

    const outcome = interpret(0, line, "", false);

    expect(outcome.ok).toBe(true);
    expect(outcome.metered).toBe(false);
    expect(outcome.costUsd).toBe(0);
    // The tokens are still real: "no dollars" is not "no turn".
    expect(outcome.usage.input_tokens).toBe(11);
    expect(outcome.usage.output_tokens).toBe(22);
  });

  test("a Claude result that DOES carry total_cost_usd is metered, including a real zero", () => {
    const withCost = interpret(0, TRANSCRIPT, "", false);
    expect(withCost.metered).toBe(true);
    expect(withCost.costUsd).toBe(REAL_COST);

    // A provider that reports an honest zero is still a MEASUREMENT — the
    // difference this fix is about is the absence of the key, not its value.
    const zero = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      total_cost_usd: 0, session_id: "sess-zero",
      structured_output: { outputs: [], questions_asked: [], notes: "" },
    });
    expect(interpret(0, zero, "", false).metered).toBe(true);
  });

  test("a process that produced no result document at all is unmetered", () => {
    // Nothing was parsed, so nothing reported a cost. `cost_usd: 0` here would be
    // the same lie in its loudest form: a crashed turn recorded as a free one.
    const outcome = interpret(1, "", "claude: command not found", false);
    expect(outcome.ok).toBe(false);
    expect(outcome.metered).toBe(false);
  });

  test("Codex is unchanged — its synthesized result doc still reports no dollars", () => {
    const outcome = interpret(0, CODEX_TRANSCRIPT, "", false, "codex");
    expect(outcome.metered).toBe(false);
    expect(outcome.costUsd).toBe(0);
  });
});

describe("what a tool is doing to", () => {
  test("the named field per tool, and a generic fallback for an unknown one", () => {
    expect(toolTarget("Read", { file_path: "/a/b.cs" })).toBe("/a/b.cs");
    expect(toolTarget("Write", { file_path: "/a/b.md" })).toBe("/a/b.md");
    expect(toolTarget("Edit", { file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
    expect(toolTarget("Bash", { command: "dotnet test", description: "run tests" })).toBe("dotnet test");
    expect(toolTarget("Grep", { pattern: "Outbox", path: "/a" })).toBe("Outbox");
    expect(toolTarget("Glob", { pattern: "**/*.cs" })).toBe("**/*.cs");
    expect(toolTarget("WebFetch", { url: "https://x.dev", prompt: "read it" })).toBe("https://x.dev");
    expect(toolTarget("TodoWrite", { todos: [] })).toBeNull();
    expect(toolTarget("SomethingNew", { whatever: "the value" })).toBe("the value");
    expect(toolTarget("Read", null)).toBeNull();
  });
});

describe("questions", () => {
  test("are announced once each, numbered, from the envelope", () => {
    const stream = new AgentStream();
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      structured_output: {
        outputs: [],
        questions_asked: ["Which repo owns the outbox?", "Which repo owns the outbox?", "Redis or Postgres?"],
        notes: "",
      },
    });
    const events = stream.push(line).filter((e) => e.kind === "question");
    expect(events).toEqual([
      { kind: "question", index: 1, text: "Which repo owns the outbox?" },
      { kind: "question", index: 2, text: "Redis or Postgres?" },
    ]);
  });
});

describe("noise and damage", () => {
  test("unparseable, empty and unknown lines produce nothing and throw nothing", () => {
    const stream = new AgentStream();
    for (const line of ["", "   ", "not json", "{broken", "[1,2,3]", '{"type":"rate_limit_event"}']) {
      expect(stream.push(line)).toEqual([]);
    }
  });

  test("a tool_result with no matching tool_use is dropped, not invented", () => {
    const stream = new AgentStream();
    const orphan = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: "toolu_nope", type: "tool_result", content: "ok" }] },
      timestamp: "2026-08-29T12:00:01.000Z",
    });
    expect(stream.push(orphan)).toEqual([]);
  });
});

describe("LineSplitter", () => {
  test("a JSON object split across three chunks arrives as one line", () => {
    const seen: string[] = [];
    const splitter = new LineSplitter((line) => seen.push(line));
    splitter.push('{"type":"sys');
    splitter.push('tem","subtype":"in');
    splitter.push('it"}\n{"type":"result"}\n');
    expect(seen).toEqual(['{"type":"system","subtype":"init"}', '{"type":"result"}']);
  });

  test("a last line with no newline is flushed by end(), and \\r\\n is normalised", () => {
    const seen: string[] = [];
    const splitter = new LineSplitter((line) => seen.push(line));
    splitter.push("one\r\ntwo");
    expect(seen).toEqual(["one"]);
    splitter.end();
    expect(seen).toEqual(["one", "two"]);
    splitter.end();
    expect(seen).toEqual(["one", "two"]);
  });
});

describe("prompt-cache accounting (wave N)", () => {
  test("the real result event's cache counters reach the cost event", () => {
    const events = replay(TRANSCRIPT);
    const final = [...events].reverse().find((e) => e.kind === "cost");
    // Measured, not assumed: `usage.cache_creation_input_tokens: 25610` and
    // `cache_read_input_tokens: 25106` are on line 13 of the real transcript.
    expect(final).toMatchObject({
      kind: "cost",
      usd: REAL_COST,
      cacheCreationTokens: 25610,
      cacheReadTokens: 25106,
    });
  });

  test("interpret() carries both counters onto the outcome's usage", () => {
    const outcome = interpret(0, TRANSCRIPT, "", false);
    expect(outcome.usage.cache_creation_input_tokens).toBe(25610);
    expect(outcome.usage.cache_read_input_tokens).toBe(25106);
  });

  test("a usage object without the cache keys reports zero, never undefined", () => {
    const outcome = interpret(0, legacyBlob(), "", false);
    expect(outcome.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

/**
 * `permissionRefusal` — the detector that decides whether a story blocks and an
 * attempt is NOT spent (gh #261).
 *
 * Its dangerous direction is the false POSITIVE, not the miss: `buildHalf` cuts
 * before the DoD and before the commit, so a wrong "refused" throws away work a
 * developer really did, with no diff and the attempt gone. Pre-merge review found
 * exactly that — the first version matched the sentence anywhere in any
 * `tool_result`, so a plain `Read` of a file that CONTAINS the phrase read as a
 * refusal. The phrase is in this repo's own `docs/spec.md`, `CHANGELOG.md` and
 * two docs-site guides, so "a developer greps the docs" is the ordinary case.
 *
 * Every shape below is measured, `claude` 2.1.270, 2026-09-12, from the probes
 * that also measured the `Bash(git rm *)` grant.
 */
describe("permissionRefusal (gh #261)", () => {
  const PHRASE = "This command requires approval";

  function transcript(
    toolUse: Record<string, unknown>,
    result: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): string {
    return [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [toolUse] },
        timestamp: "2026-09-12T22:20:53.000Z",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", ...result }] },
        timestamp: "2026-09-12T22:20:54.000Z",
        ...extra,
      }),
    ].join("\n");
  }

  /**
   * MEASURED: `git -C <elsewhere> rm -- o.txt` under `Bash(git rm *)` as the only
   * grant. Both signals are on it — the structural `non_execution_kind` and the
   * sentence — so it is matched whichever path the reader takes.
   */
  test("a real Bash refusal names the command it asked for", () => {
    const text = transcript(
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "git rm -- unused.txt" } },
      { content: PHRASE, is_error: true },
      { tool_result_meta: [{ id: "t1", non_execution_kind: "user-rejected" }] },
    );
    expect(permissionRefusal(text)).toBe("git rm -- unused.txt");
  });

  /**
   * The false positive, and the reason this describe exists. A `Read` that
   * SUCCEEDS and whose content merely contains the sentence is not a refusal, and
   * must not cost a story its attempt.
   */
  test("a successful Read of a file that CONTAINS the sentence is not a refusal", () => {
    const text = transcript(
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "docs/spec.md" } },
      { content: `…every \`npm run test -- <file>\` denied with "${PHRASE} to run" and never ran…` },
    );
    expect(permissionRefusal(text)).toBeNull();
  });

  /**
   * The other half of the same guard, and realistic precisely because of what
   * this branch added to the docs: a Bash command that RAN, exit 0, and printed
   * the sentence because it grepped it out of a file.
   */
  test("a Bash command that RAN and printed the sentence is not a refusal", () => {
    const text = transcript(
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "grep -rn 'requires approval' docs/" } },
      { content: `docs/spec.md:3338:   "${PHRASE} to run" and never ran its own Definition of Done.`, is_error: false },
    );
    expect(permissionRefusal(text)).toBeNull();
  });

  /**
   * The `Bash` half of the fence on its own. This transcript is CONSTRUCTED, not
   * measured — a non-`Bash` result that both errors and repeats the sentence is a
   * shape nobody has recorded — and it is here because the condition it pins is
   * real: the permission layer refuses COMMANDS, the only door this framework
   * grants commands through is `Bash`, and a hook `deny` on a file tool is a
   * different thing the issue names explicitly. Without it, dropping
   * `call?.name === "Bash"` passes every other case in this file.
   */
  test("a NON-Bash tool whose result errored and repeats the sentence is still not a refusal", () => {
    const text = transcript(
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "docs/spec.md" } },
      { content: `a hook refused this edit: it quotes "${PHRASE} to run" from the spec`, is_error: true },
    );
    expect(permissionRefusal(text)).toBeNull();
  });

  /**
   * The STRUCTURAL signal on its own, without the sentence. MEASURED: the
   * `cd <elsewhere> && git rm` safety check refuses with a completely different
   * paragraph and the same `non_execution_kind: "user-rejected"`.
   */
  test("the structural marker is enough — the host's prose is the fallback, not the test", () => {
    const text = transcript(
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "cd /elsewhere && git rm -- o.txt" } },
      {
        content: "This command changes directory before running git, which can execute untrusted "
          + "hooks from the target directory. Approve only if you trust it.",
        is_error: true,
      },
      { tool_result_meta: [{ id: "t1", non_execution_kind: "user-rejected" }] },
    );
    expect(permissionRefusal(text)).toBe("cd /elsewhere && git rm -- o.txt");
  });

  /**
   * MEASURED: `git rm -- <path outside the repo>` was ALLOWED by the rule and
   * failed in git. `is_error: true`, no marker, no sentence — a command that ran
   * and failed, which is the DoD's business and never this detector's.
   */
  test("a command the layer allowed and GIT refused is not a permission refusal", () => {
    const text = transcript(
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "git rm -- /elsewhere/o.txt" } },
      { content: "Command completed with an error: the file is outside the repository boundary.", is_error: true },
    );
    expect(permissionRefusal(text)).toBeNull();
  });

  test("Codex is not guessed at: the same bytes report nothing", () => {
    const text = transcript(
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "git rm -- unused.txt" } },
      { content: PHRASE, is_error: true },
      { tool_result_meta: [{ id: "t1", non_execution_kind: "user-rejected" }] },
    );
    expect(permissionRefusal(text, "codex")).toBeNull();
  });

  test("the real recorded transcript carries no refusal", () => {
    expect(permissionRefusal(TRANSCRIPT)).toBeNull();
  });
});
