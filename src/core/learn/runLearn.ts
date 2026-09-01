/**
 * `tldrx learn`, above the engine: which chapters to play, in what order, and
 * what to record when one finishes.
 *
 * The whole of the command's behaviour is here and takes its IO as a value, so a
 * test plays the tutorial by handing it a scripted `ask` and reading back the
 * transcript — no terminal, no pty, no expect script. `commands/learn.ts` is the
 * thin half: argv in, a real `LearnIo` built from the real streams, out.
 */
import { EXIT_FAILED, EXIT_OK } from "../../cli/exitCodes.ts";
import { renderChapterCard, renderFinale } from "./scene.ts";
import { chaptersToPlay, playChapter, realStepRunner, type LearnIo, type StepRunner } from "./engine.ts";
import { CHAPTERS } from "./chapters.ts";
import { isComplete, markComplete, readProgress, resumeAt, writeProgress } from "./progress.ts";
import { makeSandbox, SandboxError, type Sandbox } from "./sandbox.ts";
import type { Chapter } from "./Chapter.ts";

export interface LearnOptions {
  /** `--sandbox <path>`. Undefined means `~/.tldrx-learn`. */
  readonly sandboxRoot?: string;
  /** `--chapter <n>`. Undefined means "wherever progress.json says you were". */
  readonly chapter?: number;
  /** `--reset`: delete the sandbox and build it again. */
  readonly reset: boolean;
  /** `--list`: print the chapters and their state, run nothing. */
  readonly list: boolean;
  /** Terminal width, for the chapter cards. */
  readonly cols: number;
  /** Injected by tests, which are not being run by the CLI entry script. */
  readonly selfCommand?: readonly [string, string];
  /** Injected by tests that do not want a real subprocess. Defaults to the real one. */
  readonly runner?: StepRunner;
  /** Injected by tests so `updated_at` is a given string rather than a clock. */
  readonly now?: () => string;
}

export async function runLearn(options: LearnOptions, io: LearnIo): Promise<number> {
  let sandbox: Sandbox;
  try {
    sandbox = await makeSandbox({
      root: options.sandboxRoot,
      reset: options.reset,
      ...(options.selfCommand === undefined ? {} : { selfCommand: options.selfCommand }),
    });
  } catch (error) {
    if (error instanceof SandboxError) {
      io.warn(`tldrx learn: ${error.message}\n`);
      return EXIT_FAILED;
    }
    throw error;
  }

  let progress = readProgress(sandbox.progressPath);

  if (options.list) {
    io.write(renderChapterList(progress.completed, sandbox));
    return EXIT_OK;
  }

  const numbers = CHAPTERS.map((chapter) => chapter.n);
  if (options.chapter !== undefined && !numbers.includes(options.chapter)) {
    io.warn(
      `tldrx learn: there is no chapter ${String(options.chapter)} `
      + `(this build has ${String(numbers[0] ?? 0)}-${String(numbers[numbers.length - 1] ?? 0)}; `
      + "run `tldrx learn --list`)\n",
    );
    return EXIT_FAILED;
  }

  /**
   * A chapter that is already played cannot be played again on this sandbox.
   *
   * Measured 2026-09-01 (#30 QA): `tldrx learn --chapter 5` on a finished sandbox
   * printed the card, the intro and the first narration and THEN died at `tldrx
   * run new: tldrx-work/260901-price-typo already exists`. Every chapter's
   * commands really ran, and most of them refuse to run twice — so this is
   * refused BEFORE a line is narrated, and the refusal names both ways forward.
   */
  if (options.chapter !== undefined && isComplete(progress, options.chapter)) {
    const next = resumeAt(progress, numbers);
    io.warn(
      `tldrx learn: chapter ${String(options.chapter)} is already played, and its commands really ran `
      + "against this sandbox — most of them refuse to run twice (`run new` on a run that already "
      + "exists, `approve` on a gate that is already signed), so replaying it would die halfway "
      + "through.\n"
      + "  `tldrx learn --reset` rebuilds the sandbox and plays it from the start.\n"
      + (next === null
        ? "  Every chapter is played, so there is nothing to pick up.\n"
        : `  \`tldrx learn\` picks up where you left off, at chapter ${String(next)}.\n`),
    );
    return EXIT_FAILED;
  }

  const start = options.chapter ?? resumeAt(progress, numbers);
  if (start === null) {
    io.write(
      `All ${String(CHAPTERS.length)} chapters are played. The sandbox is still at ${sandbox.root} — `
      + "`tldrx learn --reset` rebuilds it and starts over.\n",
    );
    return EXIT_OK;
  }

  const run = options.runner ?? realStepRunner(options.selfCommand);
  const now = options.now ?? ((): string => new Date().toISOString());

  for (const chapter of planFrom(start, (n) => isComplete(progress, n))) {
    if (io.scenes) {
      for (const line of renderChapterCard({
        n: chapter.n,
        total: CHAPTERS.length,
        title: chapter.title,
        palette: io.ink,
        cols: options.cols,
      })) io.write(`${line}\n`);
    } else {
      io.write(`\n${io.ink.bold(`chapter ${String(chapter.n)}/${String(CHAPTERS.length)} — ${chapter.title}`)}\n\n`);
    }

    const outcome = await playChapter(chapter, sandbox, io, run);
    if (outcome.quit) {
      io.write(`Stopped at chapter ${String(chapter.n)}. \`tldrx learn\` picks up here.\n`);
      return EXIT_OK;
    }
    if (!outcome.ok) {
      io.warn(
        `\ntldrx learn: chapter ${String(chapter.n)} did not complete. `
        + `The sandbox is at ${sandbox.root} — nothing outside it was touched. `
        + "`tldrx learn --reset` rebuilds it.\n",
      );
      return EXIT_FAILED;
    }
    progress = markComplete(progress, chapter.n, now());
    writeProgress(sandbox.progressPath, progress);
  }

  if (io.scenes) for (const line of renderFinale(io.ink)) io.write(`${line}\n`);
  io.write(ending(sandbox.root, io));
  return EXIT_OK;
}

/**
 * The last screen, and the only part of this command that is about a repo the
 * tutorial has never seen.
 *
 * The #30 QA finished the tutorial "fluent and unsure of the first command to
 * type": eight chapters of real commands and no door out of the sandbox. So the
 * ending names the four verbs that start the same loop on real work, in the order
 * somebody would actually type them — including the warning that `tldrx init`
 * runs an interview by default, which is the one surprise a learner who has only
 * ever seen `--no-interview` would walk into.
 *
 * One `write`, so a test can assert on the ending rather than on the whole
 * transcript — half of these words also appear in chapters 4 and 5.
 */
export function ending(root: string, io: LearnIo): string {
  const ink = io.ink;
  return [
    `You ran ${String(CHAPTERS.length)} chapters of real commands for $0.00. `
      + `The sandbox is at ${root}; delete it whenever you like.`,
    "",
    ink.bold("Now the same loop on a repo you care about:"),
    "",
    `  ${ink.cyan("cd ~/your-repo && tldrx init")}`,
    "      Detection only — no model, no network, nothing spent. It ends by offering",
    "      `tldrx interview --init` — the questions detection could not answer, and there",
    "      are always some.",
    "      `--no-interview` skips them, and every gap they would have closed stays",
    "      unrecorded — the tutorial used it because this repo was a toy. Read",
    "      `.tldrx/init-handoff.md` either way; it is the file that says what was",
    "      measured, what was inferred and what is still assumed.",
    "",
    `  ${ink.cyan("tldrx run new <slug> --scope hotfix --title \"…\"")}`,
    "      Start small. `hotfix` is What → Build → Watch: three stages, no How and no",
    "      Plan, one story, and a cheap first mistake. `--scope feature` is chapter 4.",
    "",
    `  ${ink.cyan("tldrx next")}`,
    "      One stage, then it stops at the gate and names the command that comes next.",
    "      Every refusal in this framework names the command that would fix it.",
    "",
    `  ${ink.cyan("tldrx ship")}`,
    "      When the epic branch is green: opens the PR from it, with the run's handoff",
    "      as the body. Nothing merges to your default branch without it.",
    "",
    `${ink.dim("`tldrx learn --reset` plays it all again. `tldrx --help` is the whole verb list.")}`,
    "",
  ].join("\n");
}

/**
 * The chapters to play, starting at `start`: any unfinished prerequisite first,
 * then everything from `start` to the end.
 *
 * `--chapter 6` means "take me to 6 and carry on", not "play 6 alone" — the
 * tutorial is one story and stopping dead after the chapter somebody jumped to
 * would strand them mid-run with no way to be told so.
 */
export function planFrom(start: number, isDone: (n: number) => boolean): readonly Chapter[] {
  const target = CHAPTERS.find((chapter) => chapter.n === start);
  if (target === undefined) return [];
  const wanted = new Set<number>(chaptersToPlay(CHAPTERS, start, isDone).map((chapter) => chapter.n));
  for (const chapter of CHAPTERS) if (chapter.n >= start) wanted.add(chapter.n);
  return CHAPTERS.filter((chapter) => wanted.has(chapter.n));
}

/** `--list`: the chapter table, and where the sandbox is. */
export function renderChapterList(completed: readonly number[], sandbox: Sandbox): string {
  const lines = [`  sandbox: ${sandbox.root}`, ""];
  for (const chapter of CHAPTERS) {
    const mark = completed.includes(chapter.n) ? "done" : "    ";
    lines.push(`  ${mark}  ${String(chapter.n)}. ${chapter.title}`);
  }
  lines.push("", "  `tldrx learn` resumes at the first unfinished chapter.", "");
  return lines.join("\n");
}
