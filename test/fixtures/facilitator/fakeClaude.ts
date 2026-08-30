#!/usr/bin/env bun
/**
 * A fake `claude` binary, for tests that must exercise the headless path without
 * spending a cent.
 *
 * It behaves like the real thing in the two ways `tldrx next` depends on: it
 * reads the prompt from stdin and it prints a result on stdout — as a JSONL
 * `stream-json` transcript when that is what was asked for (wave K), and as the
 * old single `--output-format json` blob when it was not, so both parsers stay
 * exercised. What it writes to disk is canned, so the facilitator's "re-read the
 * outputs from disk" step has something real to find.
 *
 * Every knob is an environment variable, so one script covers success, failure,
 * a missing section and a wrong cost without any test needing its own binary.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeOutput, type FakeTool } from "../fakeStream.ts";

const argv = process.argv.slice(2);

const argvLog = process.env.FAKE_CLAUDE_ARGV_LOG;
if (argvLog !== undefined && argvLog !== "") appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);

let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);
const promptOut = process.env.FAKE_CLAUDE_PROMPT_OUT;
if (promptOut !== undefined && promptOut !== "") writeFileSync(promptOut, prompt, "utf8");

const base = process.env.FAKE_CLAUDE_RUNDIR ?? process.cwd();
const files = JSON.parse(process.env.FAKE_CLAUDE_OUTPUTS ?? "{}") as Record<string, string>;
const written: string[] = [];
for (const [rel, content] of Object.entries(files)) {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  written.push(rel);
}

const isError = process.env.FAKE_CLAUDE_IS_ERROR === "1";
const cost = Number(process.env.FAKE_CLAUDE_COST ?? "0.42");
const sessionId = process.env.FAKE_CLAUDE_SESSION ?? "5b354e40-8e99-4e0c-927f-dba7d1bdc0fc";

// One tool line per file the fake "wrote", so the progress view has real
// tool_use/tool_result pairs to summarise rather than an empty stream.
const tools: FakeTool[] = written.map((rel) => ({
  name: "Write",
  input: { file_path: join(base, rel) },
  result: "File written",
}));

process.stdout.write(claudeOutput(argv, {
  isError,
  result: isError ? "" : "wrote the declared outputs",
  sessionId,
  costUsd: cost,
  usage: { input_tokens: 1234, output_tokens: 56 },
  structured: { outputs: written, questions_asked: [], notes: "canned by fakeClaude" },
  errors: isError ? ["fake failure: the stage could not be completed"] : [],
  say: process.env.FAKE_CLAUDE_SAY,
  tools,
}));
process.exit(isError ? 1 : 0);
