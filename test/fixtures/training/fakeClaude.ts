#!/usr/bin/env bun
/**
 * A fake `claude` for the training tests.
 *
 * Same contract as the facilitator's fake: read the prompt off stdin, write
 * canned files, print a result in whichever format was asked for. The one addition
 * is a CALL COUNTER on disk, because full-mode training spawns two sub-agents and
 * each must be able to write a different file — which is also the only way a test
 * can prove the second one ran at all.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeOutput } from "../fakeStream.ts";

const argv = process.argv.slice(2);
const argvLog = process.env.FAKE_TRAIN_ARGV_LOG;
if (argvLog !== undefined && argvLog !== "") appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);

let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);

const statePath = process.env.FAKE_TRAIN_STATE ?? "";
let call = 0;
if (statePath !== "") {
  call = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) || 0 : 0;
  writeFileSync(statePath, String(call + 1), "utf8");
}

const promptDir = process.env.FAKE_TRAIN_PROMPT_DIR;
if (promptDir !== undefined && promptDir !== "") {
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(join(promptDir, `prompt-${String(call)}.md`), prompt, "utf8");
}

const root = process.env.FAKE_TRAIN_ROOT ?? process.cwd();
const plans = JSON.parse(process.env.FAKE_TRAIN_OUTPUTS ?? "[{}]") as Record<string, string>[];
const files = plans[Math.min(call, plans.length - 1)] ?? {};
const written: string[] = [];
for (const [rel, content] of Object.entries(files)) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  written.push(rel);
}

const isError = process.env.FAKE_TRAIN_IS_ERROR === "1";
const cost = Number(process.env.FAKE_TRAIN_COST ?? "0.37");
process.stdout.write(claudeOutput(argv, {
  isError,
  result: isError ? "" : "wrote the knowledge file",
  sessionId: `session-${String(call)}`,
  costUsd: cost,
  usage: { input_tokens: 9001, output_tokens: 210 },
  structured: { outputs: written, questions_asked: [], notes: "canned by the training fake" },
  errors: isError ? ["fake failure: the sub-agent could not finish"] : [],
  tools: written.map((rel) => ({ name: "Write", input: { file_path: join(root, rel) }, result: "File written" })),
}));
process.exit(isError ? 1 : 0);
