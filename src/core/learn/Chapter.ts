/**
 * What a chapter IS — and the contract phase 2 adds chapters 3-8 against.
 *
 * A chapter is four things and no code beyond the fourth:
 *
 *   1. `intro`      2-4 narration lines. What this chapter is about.
 *   2. `steps[]`    the EXACT commands, which really run against the sandbox.
 *   3. `assert()`   what must be true on disk afterwards, as a list of failures.
 *   4. `debrief`    1-3 lines pointing at the output and NAMING the file to open.
 *
 * ## Adding a chapter (the CONTRIBUTING note)
 *
 * Everything a new chapter needs is data plus one small function:
 *
 *   - Append a `Chapter` to `CHAPTERS` in `chapters.ts`, in `n` order.
 *   - Say what state it needs in `requires:`. The engine plays a missing
 *     prerequisite first rather than failing halfway through a chapter that was
 *     never going to work — that is what makes `--chapter 6` safe on a fresh
 *     sandbox.
 *   - If a step spawns a sub-agent, script the turn in `agentTurns:`. The engine
 *     writes those into the sandbox's script file before it runs the command, so
 *     the stand-in `claude` has something to say. Match on something the PROMPT
 *     contains — a stage heading is the honest key, because it is what the real
 *     model keys on too.
 *   - Need shell rather than a `tldrx` command — a commit, a deliberately broken
 *     check? That is `prepare()`, which runs before the chapter's first step and
 *     is not narrated. It exists so needing shell is never a reason to change the
 *     engine.
 *   - Write `assert()` against FILES. It is the chapter's claim ("the answer
 *     became a fact"), and it is the only thing standing between a tutorial and a
 *     tutorial that quietly stopped teaching what it says it teaches. Return one
 *     human sentence per failure, never a boolean.
 *
 * Nothing in `engine.ts` should need to change for a new chapter. If it does,
 * that is the bug — fix the engine, not the chapter.
 */
import type { AgentTurn } from "./agentScript.ts";
import type { Sandbox } from "./sandbox.ts";

/** One command the learner runs, and everything the engine needs to run it for real. */
export interface ChapterStep {
  /** 1-3 lines shown before the command. Why this command, in plain language. */
  readonly narrate: readonly string[];
  /**
   * The argv AFTER `tldrx`. Shown verbatim as `$ tldrx …` and then executed
   * verbatim — the displayed command and the executed one are the same array, so
   * they cannot drift.
   */
  readonly command: readonly string[];
  /**
   * Turns for the stand-in agent, merged into the sandbox script before this
   * command runs. Absent means this command spawns nothing.
   */
  readonly agentTurns?: readonly AgentTurn[];
  /**
   * Exit codes that mean this step went as the chapter intended. Defaults to
   * `[0]`. `tldrx next` stopping at a human gate is a 4 and is a SUCCESS here —
   * a tutorial that called the framework's most important exit code a failure
   * would be teaching the opposite of the lesson.
   */
  readonly expectExit?: readonly number[];
  /** Working directory, relative to the toy workspace. Defaults to its root. */
  readonly cwd?: string;
}

export interface Chapter {
  /** 1-based, and the number `--chapter` takes. */
  readonly n: number;
  /** A stable slug, for `--list` and for a test to name a chapter without its number. */
  readonly id: string;
  readonly title: string;
  readonly intro: readonly string[];
  readonly steps: readonly ChapterStep[];
  readonly debrief: readonly string[];
  /**
   * Chapters whose state this one needs. The engine plays any of them that are
   * unfinished BEFORE this one, so jumping in with `--chapter 6` on a fresh
   * sandbox works rather than failing on a workspace nobody made.
   */
  readonly requires?: readonly number[];
  /**
   * Anything the chapter needs done to the sandbox that is NOT a `tldrx` command
   * the learner should watch — committing what an earlier chapter left untracked,
   * making a check fail on purpose. Runs before the first step, silently.
   *
   * It exists so a chapter that needs shell can be added without touching the
   * engine. Use it sparingly: work that happens here is work the learner does not
   * see, and the whole point of this command is that they see everything that
   * matters.
   */
  prepare?(sandbox: Sandbox): Promise<void>;
  /**
   * What must be true on disk once the steps have run. Returns one sentence per
   * failure, and an empty array when the chapter's claim holds.
   */
  assert(sandbox: Sandbox): Promise<readonly string[]>;
}
