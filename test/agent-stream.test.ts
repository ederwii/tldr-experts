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
  AgentStream, detectStreamFormat, resolveResultDoc, toolTarget, type AgentEvent,
} from "../src/core/facilitator/agentEvents.ts";
import { interpret } from "../src/core/facilitator/spawnAgent.ts";
import { LineSplitter } from "../src/core/runtime/lineSplitter.ts";

const TRANSCRIPT = readFileSync(
  join(FRAMEWORK_ROOT, "test", "fixtures", "agent", "stream-json.jsonl"),
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
