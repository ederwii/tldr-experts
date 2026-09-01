/**
 * The tutorial's stand-in for `claude`, as a process.
 *
 * `tldrx learn` must run the REAL `tldrx next`, `run auto`, `expert train` — and
 * those spawn a sub-agent. This is the thing they spawn instead: it reads the
 * prompt on stdin exactly as the real CLI does, picks the turn the chapter
 * scripted for it (`agentScript.ts`), writes that turn's files, and prints a
 * `stream-json` transcript the facilitator's own parser reads. Nothing here is
 * special-cased in the framework: `spawnAgent` runs whatever `TLDRX_CLAUDE_BIN`
 * names, and the sandbox names this.
 *
 * **It is reached as `tldrx __learn-agent`, and that is not a command.** It is
 * intercepted at the top of `dispatch()`, before the command table and before the
 * unknown-flag guard, because the argv it is handed is CLAUDE'S argv — `-p
 * --output-format stream-json --verbose --model … --json-schema {…}` — and the
 * guard's whole job is to refuse argv a command cannot read. It is not in
 * `COMMANDS`, it is not in the help registry, and `tldrx --help` does not list
 * it: a human has no reason to type it and nothing but the sandbox's shim ever
 * does.
 *
 * **Fail-closed.** No script, an unreadable script, or a prompt no turn matches
 * all exit 1 with the reason on stderr. A stand-in that improvised past a hole in
 * the tutorial would teach the learner something the framework does not do, and
 * the failure would surface three chapters later as a mystery.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runtime } from "../runtime/index.ts";
import { claudeOutput, type FakeTool } from "../facilitator/fakeTranscript.ts";
import { parseScript, recordPlay, selectTurn, type AgentTurn, type TurnTally } from "./agentScript.ts";

/** Where the sandbox tells the stand-in to find its script. Absolute path. */
export const SCRIPT_ENV = "TLDRX_LEARN_SCRIPT";

/**
 * The first argv word the dispatcher intercepts. Two leading underscores because
 * it is not a command and never will be: `tldrx --help` does not list it, no help
 * entry declares it, and the only thing that types it is the shim in
 * `sandbox.ts:claudeShimScript`.
 */
export const LEARN_AGENT_ARGV0 = "__learn-agent";

/** What a turn costs when it does not say. Fake money; enough that a ledger is not all zeroes. */
export const DEFAULT_TURN_COST_USD = 0.12;

export interface LearnAgentIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly readStdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Play one turn. Returns the process exit code.
 *
 * Every dependency is injected so the whole stand-in is exercisable in-process:
 * a test hands it an argv, a prompt and a script path and reads back the exact
 * bytes a real spawn would have seen on stdout.
 */
export async function runLearnAgent(io: LearnAgentIo): Promise<number> {
  const scriptPath = io.env[SCRIPT_ENV]?.trim() ?? "";
  if (scriptPath === "") {
    io.stderr(`tldrx __learn-agent: ${SCRIPT_ENV} is not set — this is not a command you run by hand\n`);
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(scriptPath, "utf8");
  } catch (error) {
    io.stderr(`tldrx __learn-agent: cannot read ${scriptPath}: ${message(error)}\n`);
    return 1;
  }

  let script;
  try {
    script = parseScript(text);
  } catch (error) {
    io.stderr(`tldrx __learn-agent: ${scriptPath} is not a usable script: ${message(error)}\n`);
    return 1;
  }

  const prompt = await io.readStdin();
  const statePath = tallyPathFor(scriptPath);
  const tally = readTally(statePath);
  const chosen = selectTurn(script, prompt, tally);
  if (chosen === null) {
    io.stderr(
      `tldrx __learn-agent: no scripted turn matches this prompt (first line: ${firstLine(prompt)})\n`
      + `  script: ${scriptPath}\n`
      + `  turns:  ${script.turns.map((t) => JSON.stringify(t.match)).join(", ") || "(none)"}\n`,
    );
    return 1;
  }
  writeTally(statePath, recordPlay(tally, chosen.index));

  const turn = chosen.turn;
  const written = writeTurnFiles(turn, io.cwd);
  const failing = turn.fails === true;
  const tools: readonly FakeTool[] = written.map((rel) => ({
    name: "Write",
    input: { file_path: join(io.cwd, rel) },
    result: "File written",
  }));

  io.stdout(claudeOutput(io.argv, {
    isError: failing,
    result: failing ? "" : `the tutorial's stand-in agent answered ${JSON.stringify(turn.match)}`,
    sessionId: `learn-${String(chosen.index)}`,
    costUsd: turn.costUsd ?? DEFAULT_TURN_COST_USD,
    usage: { input_tokens: 900, output_tokens: 120 },
    // A failing turn produces NOTHING — no envelope, no verdict. That is what a
    // sub-agent killed mid-turn really leaves behind, and a fake that returned an
    // envelope on the way out would be teaching the wrong failure.
    structured: failing ? null : (turn.structured ?? defaultEnvelope(written)),
    errors: failing ? [turn.error ?? "Reached maximum budget"] : [],
    say: turn.say,
    tools,
  }));
  return failing ? 1 : 0;
}

/** The ordinary stage envelope: what it wrote, that it asked nothing, and who wrote it. */
function defaultEnvelope(written: readonly string[]): Record<string, unknown> {
  return { outputs: [...written], questions_asked: [], notes: "scripted by tldrx learn" };
}

/**
 * Write the turn's files under `cwd`, and return the relative paths in the order
 * the script declared them — which is the order the envelope names them in.
 */
export function writeTurnFiles(turn: AgentTurn, cwd: string): readonly string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(turn.writes ?? {})) {
    const path = resolve(cwd, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    written.push(rel);
  }
  return written;
}

/**
 * Where the play counts live: beside the script, named after it.
 *
 * On disk rather than in memory because every turn is its own PROCESS — the
 * facilitator spawns one per stage — so `times:` could not otherwise mean
 * anything at all.
 */
export function tallyPathFor(scriptPath: string): string {
  return `${scriptPath}.tally.json`;
}

function readTally(path: string): TurnTally {
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof doc === "object" && doc !== null ? (doc as TurnTally) : {};
  } catch {
    // No tally yet, or one somebody broke: every turn is simply unplayed. This is
    // the one degradation that is safe, because it can only make a `times:` turn
    // play again — never make an unscripted prompt succeed.
    return {};
  }
}

function writeTally(path: string, tally: TurnTally): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(tally)}\n`, "utf8");
}

function firstLine(prompt: string): string {
  const line = prompt.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The process-shaped entry `dispatch()` calls. Reads the real stdin, writes the real streams. */
export function learnAgentMain(argv: readonly string[]): Promise<number> {
  return runLearnAgent({
    argv,
    env: process.env,
    cwd: process.cwd(),
    readStdin: () => runtime.readStdin(),
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
