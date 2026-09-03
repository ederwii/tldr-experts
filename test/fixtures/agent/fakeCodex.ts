#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexOutput, codexPromptMarker } from "../../../src/core/facilitator/fakeTranscript.ts";

const argv = process.argv.slice(2);
const argvLog = process.env.FAKE_CODEX_ARGV_LOG;
if (argvLog !== undefined && argvLog !== "") appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);

let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);

// The prompt is DELIVERED on stdin and appears nowhere in argv, so a fake that
// dropped it was indistinguishable from a spawn that never sent one. Echo a
// digest of what actually arrived into the transcript — through the shared
// emitter, which owns the fold for the synthesized and the replayed path alike.
const echo = codexPromptMarker(prompt);

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
  process.stdout.write(codexOutput({ sessionId, structured: JSON.parse(structured) }, echo));
  process.exit(0);
}

process.stdout.write(codexOutput(readFileSync(join(import.meta.dir, "codex-jsonl.jsonl"), "utf8"), echo));
