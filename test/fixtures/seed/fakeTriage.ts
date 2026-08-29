#!/usr/bin/env bun
/**
 * A fake `claude` for the seed-triage tests.
 *
 * Same contract the real binary has where `tldrx seed triage --propose` depends
 * on it: read the prompt from stdin, print one `--output-format json` object on
 * stdout with the proposal in `structured_output`. What it returns is canned per
 * test, so every validation path — a bad scope, an unknown seed, a cycle, a
 * malformed src — can be exercised for $0.00.
 */
import { appendFileSync, writeFileSync } from "node:fs";

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

process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: isError ? "" : "proposed a split",
    session_id: process.env.FAKE_TRIAGE_SESSION ?? "9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b",
    total_cost_usd: cost,
    usage: { input_tokens: 4321, output_tokens: 210 },
    structured_output: structured,
    errors: isError ? ["fake failure: the triage could not be completed"] : [],
  })}\n`,
);
process.exit(isError ? 1 : 0);
