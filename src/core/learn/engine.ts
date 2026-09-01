/**
 * The tutorial engine: narrate, run the REAL command, check the disk, debrief.
 *
 * It knows nothing about any particular chapter. Everything chapter-shaped lives
 * in `chapters.ts` as data plus one `assert()` — see `Chapter.ts` for the note on
 * adding chapters 3-8, which must need no change here.
 *
 * Two decisions worth keeping:
 *
 * **The displayed command IS the executed command.** `step.command` is printed as
 * `$ tldrx …` and then spawned, from the same array. A tutorial whose transcript
 * and whose behaviour are two different strings is the exact failure this whole
 * design exists to avoid.
 *
 * **A step is judged by its exit code, and a chapter by the disk.** The exit code
 * says the command ran as intended (a `next` that stops at a human gate is a 4,
 * and that is a pass); `assert()` says the lesson actually happened. Both are
 * needed: a command can exit 0 having taught nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { isFinished } from "../run/RunFile.ts";
import type { Palette } from "../ui/color.ts";
import { mergeScripts, type AgentScript, type AgentTurn } from "./agentScript.ts";
import { sandboxEnv, selfCommand, writeScript, type Sandbox } from "./sandbox.ts";
import type { Chapter, ChapterStep } from "./Chapter.ts";

/** What the learner types to stop. Anything else advances. */
export const QUIT_ANSWERS: readonly string[] = ["q", "quit", "exit"];

export interface LearnIo {
  /** The lesson: narration, the commands, and the real output. Goes to stdout. */
  readonly write: (text: string) => void;
  /** Refusals and mismatches. Goes to stderr. */
  readonly warn: (text: string) => void;
  /** Wait for the learner. Returns what they typed, trimmed. */
  readonly ask: (prompt: string) => Promise<string>;
  /**
   * False when nobody can answer — a pipe, a CI job, `< /dev/null`. The chapters
   * then play straight through instead of waiting forever at the first prompt,
   * which is how `tldrx learn > lesson.txt` degrades rather than hangs.
   */
  readonly interactive: boolean;
  readonly ink: Palette;
  /** Draw the ASCII chapter cards. False in `plain`/`off`, exactly as `init` decides it. */
  readonly scenes: boolean;
}

export interface StepResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How a step's command is actually executed. Injected by the engine's unit tests. */
export type StepRunner = (step: ChapterStep, sandbox: Sandbox, onLine: (line: string) => void) => Promise<StepResult>;

export interface ChapterOutcome {
  readonly chapter: number;
  /** Every step ran as intended and every assertion held. */
  readonly ok: boolean;
  /** The learner typed `q`. Not a failure — the chapter is simply not finished. */
  readonly quit: boolean;
  /** One sentence per thing that did not hold. Empty when `ok`. */
  readonly failures: readonly string[];
}

/**
 * Play one chapter end to end.
 *
 * The agent script is REPLACED, not appended to, at the start of every step: a
 * turn scripted for chapter 4 that is still lying around when chapter 5 runs
 * would answer a prompt chapter 5 meant to fail, and the tutorial would teach a
 * retry that never happened.
 */
export async function playChapter(
  chapter: Chapter,
  sandbox: Sandbox,
  io: LearnIo,
  run: StepRunner,
): Promise<ChapterOutcome> {
  await chapter.prepare?.(sandbox);
  for (const line of chapter.intro) io.write(`${line}\n`);
  io.write("\n");

  for (const step of chapter.steps) {
    // Expanded ONCE, here, so the line that is printed and the argv that is
    // spawned are the same array — the property `displayCommand` exists for.
    const command = expandCommand(step.command, sandbox);
    for (const line of step.narrate) io.write(`  ${line}\n`);
    io.write(`\n  ${io.ink.bold(`$ tldrx ${displayCommand(command)}`)}\n`);

    if (io.interactive) {
      const answer = await io.ask(`  ${io.ink.dim("[Enter] to run it, q to quit ")}`);
      if (QUIT_ANSWERS.includes(answer.trim().toLowerCase())) {
        return { chapter: chapter.n, ok: false, quit: true, failures: [] };
      }
    }
    io.write("\n");

    writeScript(sandbox, scriptFor(expandTurns(step.agentTurns ?? [], sandbox)));
    const result = await run({ ...step, command }, sandbox, (line) => { io.write(`${line}\n`); });
    if (result.stderr !== "") io.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);

    const expected = step.expectExit ?? [0];
    if (!expected.includes(result.exitCode)) {
      const failure = `\`tldrx ${displayCommand(command)}\` exited ${String(result.exitCode)}, `
        + `and this chapter expected ${expected.join(" or ")}.`;
      io.warn(`\n  ${io.ink.red("✗")} ${failure}\n`);
      return { chapter: chapter.n, ok: false, quit: false, failures: [failure] };
    }
    io.write("\n");
  }

  const failures = await chapter.assert(sandbox);
  if (failures.length > 0) {
    io.warn(`  ${io.ink.red("✗")} the commands ran, but the chapter's claim does not hold:\n`);
    for (const failure of failures) io.warn(`      ${failure}\n`);
    return { chapter: chapter.n, ok: false, quit: false, failures };
  }

  for (const line of chapter.debrief) io.write(`  ${line}\n`);
  io.write("\n");
  return { chapter: chapter.n, ok: true, quit: false, failures: [] };
}

/**
 * The command as a line somebody could retype, from the SAME array that is
 * spawned — quoting is added only where a shell would need it.
 *
 * Not a second string: a tutorial whose transcript and whose behaviour are two
 * different literals is exactly the drift this design exists to prevent. What is
 * printed is a pure function of what runs.
 */
export function displayCommand(command: readonly string[]): string {
  return command.map((arg) => (/^[\w.,:/@=-]+$/.test(arg) ? arg : `"${arg}"`)).join(" ");
}

function scriptFor(turns: readonly AgentTurn[]): AgentScript {
  return mergeScripts({ version: 1, turns: [] }, { version: 1, turns });
}

/**
 * `{run}` and `{runDir}`, substituted in a turn's file paths and file contents.
 *
 * A sub-agent's working directory is the WORKSPACE ROOT (`runNext.ts:559`), and a
 * stage's declared outputs resolve run-relative first — so the files a turn must
 * write are `tldrx-work/<run>/01-what/handoff.md`, and `<run>` is
 * `<yymmdd>-<slug>` in UTC (`run/newRun.ts:145`). A chapter cannot know that
 * string: it does not exist until the chapter's own first command has run.
 *
 * So the chapter writes `{runDir}/01-what/handoff.md` and this reads the id off
 * the disk, at the last possible moment, from the run that is actually there.
 * Recomputing the date instead would be a second implementation of the id rule
 * that disagrees with the first one for one second in every 86,400.
 */
export function expandTurns(turns: readonly AgentTurn[], sandbox: Sandbox): readonly AgentTurn[] {
  const run = newestRunId(sandbox);
  if (run === null) return turns;
  const swap = (text: string): string => expandPlaceholders(text, run);
  return turns.map((turn) => {
    if (turn.writes === undefined) return turn;
    const writes: Record<string, string> = {};
    for (const [rel, content] of Object.entries(turn.writes)) writes[swap(rel)] = swap(content);
    return { ...turn, writes };
  });
}

/**
 * The same two placeholders, in a step's ARGV.
 *
 * A chapter cannot spell a run id: it is `<yymmdd>-<slug>` in UTC and does not
 * exist until a command in some earlier chapter has run. That is fine while one
 * run is open — every command finds it — but the moment a second one is (chapter
 * 5 opens a hotfix beside the feature), `next`, `approve` and the rest refuse to
 * guess (exit 2) and want the id spelled out. So a chapter writes
 * `["next", "{run}"]` and this fills it in from the disk, at the same moment and
 * from the same reading `expandTurns` uses.
 *
 * `{run}` is the NEWEST run — which is the one the chapter that opened it is
 * talking about, and stays so for the chapters after it, because ids sort by day
 * and then by slug and a later chapter's run is created later. A chapter that
 * needs an OLDER run must wait for the newer one to be finished (chapter 7 signs
 * the hotfix off; chapter 8 then finds one open run again and needs no id at all).
 */
export function expandCommand(command: readonly string[], sandbox: Sandbox): readonly string[] {
  const run = newestRunId(sandbox);
  if (run === null) return command;
  return command.map((arg) => expandPlaceholders(arg, run));
}

/** `{runDir}` → `tldrx-work/<run>`, `{run}` → `<run>`. The one substitution, once. */
function expandPlaceholders(text: string, run: string): string {
  return text.replaceAll("{runDir}", `${PROJECT_WORK_DIR}/${run}`).replaceAll("{run}", run);
}

/**
 * The run `{run}` and `{runDir}` mean: the newest one that is still OPEN.
 *
 * Newest first, because `<yymmdd>-<slug>` sorts by day and a chapter that opens a
 * run is talking about the one it just opened. Open second, and it is the half
 * that matters once there is more than one: chapter 5 opens a hotfix beside the
 * feature run and chapters 6 and 7 carry it to its end — and the moment chapter 7
 * signs it off, `{run}` has to mean the feature run again, because that is the
 * one every remaining command will resolve to. "Open" is `!isFinished` — not
 * `done`, not `cancelled` — which is exactly the set `resolveRun` picks from
 * (`run/RunStore.ts:165`), so the placeholder and the CLI can never disagree.
 *
 * Falls back to the newest of all when every run is finished, so this returns
 * null only when there is no run at all.
 */
export function newestRunId(sandbox: Sandbox): string | null {
  const workDir = join(sandbox.workspace, PROJECT_WORK_DIR);
  if (!existsSync(workDir)) return null;
  const runs = readdirSync(workDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const open = runs.filter((run) => !runIsFinished(join(workDir, run)));
  const pick = open.length > 0 ? open : runs;
  return pick[pick.length - 1] ?? null;
}

/** `status:` in a run.yml, read as text. An unreadable run is treated as open. */
function runIsFinished(runDir: string): boolean {
  try {
    const status = /^status:\s*(\S+)/m.exec(readFileSync(join(runDir, "run.yml"), "utf8"))?.[1] ?? "";
    return isFinished(status);
  } catch {
    return false;
  }
}

/**
 * Run a step's command as a REAL `tldrx` subprocess, in the toy workspace.
 *
 * Re-enters THIS interpreter on THIS entry script rather than resolving `tldrx`
 * on a PATH: the tutorial must teach the version the learner just installed, not
 * whichever one a global bin happens to hold.
 *
 * The environment is the sandbox's (`sandboxEnv`), which is where the real
 * `claude` becomes unreachable — `TLDRX_CLAUDE_BIN` names the stand-in and the
 * sandbox's `bin/` is first on PATH.
 */
export function realStepRunner(selfCmd: readonly [string, string] = selfCommand()): StepRunner {
  const [interpreter, entry] = selfCmd;
  return async (step, sandbox, onLine): Promise<StepResult> => {
    const cwd = step.cwd === undefined ? sandbox.workspace : join(sandbox.workspace, step.cwd);
    const result = await runtime.spawn(interpreter, [entry, ...step.command], {
      cwd,
      env: sandboxEnv(sandbox),
      onStdoutLine: onLine,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

/**
 * The chapters to play to reach `target`, prerequisites first.
 *
 * `--chapter 6` on a fresh sandbox is the case this exists for: chapter 6 needs a
 * workspace, a run and a gate, and refusing would make the flag useless while
 * playing it alone would fail three commands in with a message about the wrong
 * thing. So an unfinished prerequisite is simply played first.
 */
export function chaptersToPlay(
  chapters: readonly Chapter[],
  target: number,
  isDone: (n: number) => boolean,
): readonly Chapter[] {
  const byNumber = new Map(chapters.map((chapter) => [chapter.n, chapter]));
  const needed = new Set<number>([target]);
  const queue = [target];
  for (let guard = 0; queue.length > 0 && guard < chapters.length * 4; guard++) {
    const at = queue.shift();
    if (at === undefined) break;
    for (const required of byNumber.get(at)?.requires ?? []) {
      if (isDone(required) || needed.has(required)) continue;
      needed.add(required);
      queue.push(required);
    }
  }
  return chapters.filter((chapter) => needed.has(chapter.n));
}

/** True when `path` (relative to the toy workspace) exists. The assertions' common case. */
export function sandboxHas(sandbox: Sandbox, rel: string): boolean {
  return existsSync(join(sandbox.workspace, rel));
}
