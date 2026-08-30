#!/usr/bin/env bun
/**
 * A fake `claude` for the seed-triage tests.
 *
 * Same contract the real binary has where `tldrx seed triage --propose` depends
 * on it: read the prompt from stdin, print a result on stdout with the proposal
 * in `structured_output` — streaming JSONL or the single blob, whichever was
 * asked for. What it returns is canned per
 * test, so every validation path — a bad scope, an unknown seed, a cycle, a
 * malformed src — can be exercised for $0.00.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { claudeOutput } from "../fakeStream.ts";

const argv = process.argv.slice(2);
const argvLog = process.env.FAKE_TRIAGE_ARGV_LOG;
if (argvLog !== undefined && argvLog !== "") appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);

let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);
const promptOut = process.env.FAKE_TRIAGE_PROMPT_OUT;
if (promptOut !== undefined && promptOut !== "") writeFileSync(promptOut, prompt, "utf8");

const isError = process.env.FAKE_TRIAGE_IS_ERROR === "1";
const cost = Number(process.env.FAKE_TRIAGE_COST ?? "0.11");
const structured: unknown = JSON.parse(process.env.FAKE_TRIAGE_OUTPUT ?? "null");

process.stdout.write(claudeOutput(argv, {
  isError,
  result: isError ? "" : "proposed a split",
  sessionId: process.env.FAKE_TRIAGE_SESSION ?? "9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b",
  costUsd: cost,
  usage: { input_tokens: 4321, output_tokens: 210 },
  structured,
  errors: isError ? ["fake failure: the triage could not be completed"] : [],
  tools: [{ name: "Read", input: { file_path: "seed/inventory.md" }, result: "1\tone\n" }],
}));
process.exit(isError ? 1 : 0);
