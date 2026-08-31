#!/usr/bin/env bun
/**
 * A fake `claude` for the Build executor's tests: it plays BOTH sub-agents.
 *
 * Which one it is playing is read off the prompt's first line — `# Build — story
 * S1 …` is the developer, `# Review — story S1 …` is the reviewer — because that
 * is the same thing the real model would key on, and it means a prompt that lost
 * its heading fails the test instead of passing it quietly.
 *
 * `FAKE_BUILD_FAIL` narrows failure to one role, one story, one attempt — see
 * `shouldFail` at the bottom. `FAKE_BUILD_IS_ERROR=1` still fails everything.
 *
 * As the developer it writes files into its CWD, which the executor has set to the
 * story's worktree; it does NOT commit, so the "commit what the agent left behind"
 * step is exercised for real. As the reviewer it returns a verdict from a per-story
 * queue held in a state file, so `changes` then `approve` across two attempts (and
 * across two processes, in the `--prepare`/`--commit` tests) is expressible.
 *
 * **`FAKE_BUILD_LIVE_DIR` is how the parallel tests observe concurrency without a
 * clock.** Each instance drops a marker file for as long as it is "working",
 * appends `{story, role, event, live}` to a shared `timeline.jsonl`, and removes
 * the marker on the way out. The FILE'S LINE ORDER is the happens-before record
 * and `live` is how many markers existed at that moment — so "two ran at once"
 * and "the third waited" are read off what the processes themselves saw, not off
 * elapsed milliseconds, which is the one thing a Linux CI box will not reproduce.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeOutput } from "../fakeStream.ts";

const argv = process.argv.slice(2);
const argvLog = process.env.FAKE_BUILD_ARGV_LOG;
if (argvLog !== undefined && argvLog !== "") appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);

let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);

const heading = prompt.split("\n")[0] ?? "";
const role = heading.startsWith("# Review") ? "reviewer" : "developer";
const storyId = /story (S\d+)/.exec(heading)?.[1] ?? "S?";

const liveDir = process.env.FAKE_BUILD_LIVE_DIR;
const liveMarker = liveDir === undefined || liveDir === "" ? null : join(liveDir, `${role}-${storyId}`);
if (liveMarker !== null && liveDir !== undefined) {
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(liveMarker, String(process.pid), "utf8");
  note(liveDir, { story: storyId, role, event: "start", live: liveCount(liveDir) });
}

const pidDir = process.env.FAKE_BUILD_PID_DIR;
if (pidDir !== undefined && pidDir !== "") {
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(join(pidDir, `${role}-${storyId}.pid`), String(process.pid), "utf8");
}

await sleepFor(storyId);

const promptDir = process.env.FAKE_BUILD_PROMPT_DIR;
if (promptDir !== undefined && promptDir !== "") {
  mkdirSync(promptDir, { recursive: true });
  const n = attemptCount(`prompt:${role}:${storyId}`);
  writeFileSync(join(promptDir, `${role}-${storyId}-${String(n)}.md`), prompt, "utf8");
}

const cost = Number(process.env.FAKE_BUILD_COST ?? "0.10");
const failing = shouldFail();
const written: string[] = [];

if (role === "developer" && !failing) {
  const plan = JSON.parse(process.env.FAKE_BUILD_WRITE ?? "{}") as Record<string, Record<string, string>>;
  const attempt = attemptCount(`dev:${storyId}`);
  const files = plan[`${storyId}#${String(attempt)}`] ?? plan[storyId] ?? {
    [`${storyId.toLowerCase()}.txt`]: `${storyId} was here\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const path = join(process.cwd(), rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    written.push(rel);
  }
}

// A failing instance produces NOTHING — no verdict, no envelope. That is the
// point: `Reached maximum budget` kills the process mid-turn, and a fake that
// still returned a verdict on the way out would be testing the wrong thing.
const structured = failing
  ? null
  : role === "reviewer"
    ? { verdict: nextVerdict(storyId), summary: `reviewed ${storyId}`, findings: verdictFindings(storyId) }
    : { outputs: written, questions_asked: [], notes: `fake developer for ${storyId}` };

if (liveMarker !== null && liveDir !== undefined) {
  note(liveDir, { story: storyId, role, event: "end", live: liveCount(liveDir) });
  rmSync(liveMarker, { force: true });
}

process.stdout.write(claudeOutput(argv, {
  isError: failing,
  result: `fake ${role} for ${storyId}`,
  sessionId: `fake-${role}-${storyId}`,
  costUsd: cost,
  usage: { input_tokens: 100, output_tokens: 10 },
  structured,
  errors: failing ? [failureReason(argv)] : [],
  tools: written.map((rel) => ({ name: "Write", input: { file_path: rel }, result: "File written" })),
}));
process.exit(failing ? 1 : 0);

/**
 * Should THIS instance die?
 *
 * `FAKE_BUILD_IS_ERROR=1` fails every sub-agent, as it always did.
 * `FAKE_BUILD_FAIL` is the narrow one, a comma-separated list of selectors:
 *
 *   reviewer          every reviewer
 *   reviewer:S1       every reviewer of S1
 *   reviewer:S1#1     the FIRST reviewer of S1, and no later one
 *
 * The third form is what the review-error tests are made of: a reviewer that
 * dies once and then works is the only way to prove the story picked its review
 * back up rather than restarting its developer.
 */
function shouldFail(): boolean {
  if (process.env.FAKE_BUILD_IS_ERROR === "1") return true;
  const selectors = (process.env.FAKE_BUILD_FAIL ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (selectors.length === 0) return false;
  // Counted once per process, before any selector is read, so a list of two
  // selectors does not advance the counter twice.
  const nth = attemptCount(`fail:${role}:${storyId}`);
  return selectors.some((selector) => {
    const [head = "", attempt = ""] = selector.split("#");
    const [wantRole = "", wantStory = ""] = head.split(":");
    if (wantRole !== role) return false;
    if (wantStory !== "" && wantStory !== storyId) return false;
    return attempt === "" || Number(attempt) === nth;
  });
}

/** The real CLI's words for the failure this fake is standing in for. */
function failureReason(args: readonly string[]): string {
  const custom = process.env.FAKE_BUILD_FAIL_REASON;
  if (custom !== undefined && custom !== "") return custom;
  const cap = args[args.indexOf("--max-budget-usd") + 1] ?? "0.00";
  return `Reached maximum budget ($${cap})`;
}

/**
 * `FAKE_BUILD_SLEEP_MS` — a number for every story, or `{"S1": 300}` per story.
 * Long enough to overlap, short enough that a slow CI box does not care.
 */
async function sleepFor(id: string): Promise<void> {
  const raw = process.env.FAKE_BUILD_SLEEP_MS ?? "";
  if (raw === "") return;
  let ms = Number(raw);
  if (!Number.isFinite(ms)) {
    const map = JSON.parse(raw) as Record<string, number>;
    ms = map[id] ?? map["*"] ?? 0;
  }
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Markers currently on disk — every instance that is inside its sleep. */
function liveCount(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => !name.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

/** One line of the shared happens-before record. Append is atomic enough for this. */
function note(dir: string, entry: Record<string, unknown>): void {
  try {
    appendFileSync(join(dir, "timeline.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // A marker that cannot be written is a lost assertion, never a failed build.
  }
}

/** Verdicts come from a per-story queue; the last one repeats once the queue runs dry. */
function nextVerdict(id: string): string {
  const queues = JSON.parse(process.env.FAKE_BUILD_VERDICTS ?? "{}") as Record<string, string[]>;
  const queue = queues[id] ?? ["approve"];
  const at = attemptCount(`review:${id}`) - 1;
  return queue[Math.min(at, queue.length - 1)] ?? "approve";
}

function verdictFindings(id: string): string[] {
  return nextVerdictPeek(id) === "changes" ? [`${id}: the acceptance criteria are not met yet`] : [];
}

function nextVerdictPeek(id: string): string {
  const queues = JSON.parse(process.env.FAKE_BUILD_VERDICTS ?? "{}") as Record<string, string[]>;
  const queue = queues[id] ?? ["approve"];
  const at = attemptCount(`review:${id}`, false) - 1;
  return queue[Math.min(at, queue.length - 1)] ?? "approve";
}

/** 1-based call count for `key`, persisted so it survives across processes. */
function attemptCount(key: string, advance = true): number {
  const path = process.env.FAKE_BUILD_STATE;
  if (path === undefined || path === "") return 1;
  let state: Record<string, number> = {};
  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
    } catch {
      state = {};
    }
  }
  const next = (state[key] ?? 0) + (advance ? 1 : 0);
  if (advance) {
    state[key] = next;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  }
  return advance ? next : (state[key] ?? 1);
}
