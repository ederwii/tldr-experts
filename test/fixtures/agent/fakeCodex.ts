#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const argvLog = process.env.FAKE_CODEX_ARGV_LOG;
if (argvLog !== undefined && argvLog !== "") appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);

let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);

const base = process.env.FAKE_CLAUDE_RUNDIR;
const configured = process.env.FAKE_CLAUDE_OUTPUTS;
if (base !== undefined && configured !== undefined) {
  const files = JSON.parse(configured) as Record<string, string>;
  for (const [rel, content] of Object.entries(files)) {
    const path = join(base, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  const sessionId = process.env.FAKE_CODEX_SESSION ?? "01a06472-03bb-7ba3-abd2-820c96afe586";
  const structured = JSON.stringify({
    outputs: Object.keys(files), questions_asked: [], notes: "canned by fakeCodex",
  });
  const lines = [
    { type: "thread.started", thread_id: sessionId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: structured } },
    { type: "turn.completed", usage: { input_tokens: 1234, cached_input_tokens: 0, output_tokens: 56 } },
  ];
  process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  process.exit(0);
}

void prompt;

process.stdout.write(readFileSync(join(import.meta.dir, "codex-jsonl.jsonl"), "utf8"));
