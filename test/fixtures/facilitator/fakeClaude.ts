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
 * a missing section, a wrong cost and a turn slow enough to interrupt, without
 * any test needing its own binary.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeOutput, toolPairLines, type FakeResult, type FakeTool } from "../fakeStream.ts";

const argv = process.argv.slice(2);

const argvLog = process.env.FAKE_CLAUDE_ARGV_LOG;
if (argvLog !== undefined && argvLog !== "") appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);

// Announce ourselves BEFORE doing anything slow: the signal tests need a pid to
// check is dead afterwards, and they must not race the sleep below.
const pidFile = process.env.FAKE_CLAUDE_PID_FILE;
if (pidFile !== undefined && pidFile !== "") {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid), "utf8");
}

let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);

// A deliberately slow turn, for the tests that interrupt one. Synchronous so the
// process is genuinely busy rather than parked on an idle event loop.
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? "0");
if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
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

const spec: FakeResult = {
  isError,
  result: isError ? "" : "wrote the declared outputs",
  sessionId,
  costUsd: cost,
  usage: { input_tokens: 1234, output_tokens: 56 },
  structured: { outputs: written, questions_asked: [], notes: "canned by fakeClaude" },
  errors: isError ? ["fake failure: the stage could not be completed"] : [],
  say: process.env.FAKE_CLAUDE_SAY,
  tools,
};

// `FAKE_CLAUDE_READS=n` emits n completed `Read` calls, ONE FLUSHED LINE AT A
// TIME, before the rest of the transcript — and then waits. That is what makes a
// live kill testable: a fake that prints everything in one write has already
// exited by the time anything could stop it.
//
// `FAKE_CLAUDE_READS_BURST=1` prints all n of them in a SINGLE write instead.
// That is the shape a loaded machine produces on its own — the reader gets one
// chunk holding many lines — and it is the shape the `max_reads` flake (issue
// #24) was made of: `LineSplitter` hands every line in a chunk to the counter
// synchronously, so a cap that stopped counting only when the child died
// overshot by however many lines the OS happened to coalesce. Deterministic
// here, a coin flip there; same code path.
const slowReads = Number(process.env.FAKE_CLAUDE_READS ?? "0");
if (Number.isFinite(slowReads) && slowReads > 0) {
  const hangMs = Number(process.env.FAKE_CLAUDE_HANG_MS ?? "5000");
  const burst = process.env.FAKE_CLAUDE_READS_BURST === "1";
  const lineFor = (i: number): readonly string[] =>
    toolPairLines(spec, { name: "Read", input: { file_path: `/x/${String(i)}.md` } }, i,
      new Date(Date.parse("2026-08-29T12:00:00.000Z") + i * 10).toISOString());
  if (burst) {
    const all: string[] = [];
    for (let i = 0; i < slowReads; i++) all.push(...lineFor(i));
    process.stdout.write(`${all.join("\n")}\n`);
  } else {
    for (let i = 0; i < slowReads; i++) {
      for (const line of lineFor(i)) process.stdout.write(`${line}\n`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, hangMs));
}

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
