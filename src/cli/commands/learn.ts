/** `tldrx learn` — a playable tutorial that runs the real commands (#30)
 *
 * Zero cost, zero risk, and it cannot drift: every output the learner sees is
 * produced by the shipped code against a throwaway workspace, not written down
 * by a doc author. `core/learn/sandbox.ts` builds the world, `core/learn/engine.ts`
 * plays a chapter, `core/learn/chapters.ts` IS the chapters.
 *
 * This file is deliberately the thin half: argv, a palette, a way to wait for a
 * keypress, and the exit code. Everything that decides anything is in
 * `runLearn`, which takes its IO as a value so the whole tutorial is playable
 * from a test without a terminal.
 *
 * **Nothing here can reach the real `claude`.** The sandbox names a stand-in in
 * `TLDRX_CLAUDE_BIN` and puts it first on the child's PATH — see
 * `core/learn/sandbox.ts` and the test that plants a booby-trapped `claude` to
 * prove it.
 */
import { createInterface } from "node:readline";
import type { Command } from "../Command.ts";
import { EXIT_FAILED } from "../exitCodes.ts";
import { boolFlag, numberFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { colorEnabled, palette } from "../../core/ui/color.ts";
import { resolveUiMode, UiModeError } from "../../core/ui/mode.ts";
import { runLearn } from "../../core/learn/runLearn.ts";
import type { LearnIo } from "../../core/learn/engine.ts";

/** Flags that always take a value, so `--sandbox` never swallows the next flag. */
const VALUE_FLAGS: readonly string[] = ["chapter", "sandbox", "ui"];

/** Default terminal geometry when stdout will not say — a plain 80x24. */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

export const learnCommand: Command = {
  name: "learn",
  summary: "Play the framework: a sandbox tutorial that runs the real commands",
  usage: "tldrx learn [--chapter <n>] [--reset] [--list] [--sandbox <path>] [--ui scene|compact|plain|off]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv, VALUE_FLAGS);
    try {
      const chapter = numberFlag(args, "chapter");
      const ui = stringFlag(args, "ui");
      const isTty = process.stdout.isTTY === true;
      const cols = process.stdout.columns ?? FALLBACK_COLS;
      const mode = resolveUiMode({
        flag: ui,
        env: process.env,
        isTty,
        cols,
        rows: process.stdout.rows ?? FALLBACK_ROWS,
      });
      const ink = palette(mode !== "plain" && mode !== "off"
        && colorEnabled({ isTty, env: process.env }));

      const io: LearnIo = {
        write: (text) => { process.stdout.write(text); },
        warn: (text) => { process.stderr.write(text); },
        // Nobody to ask when stdin is not a terminal — a pipe, a CI job,
        // `< /dev/null`. The chapters then play straight through instead of
        // waiting forever at the first prompt, which is how `tldrx learn >
        // lesson.txt` degrades rather than hangs.
        ask: process.stdin.isTTY === true ? askOnStdin : async (): Promise<string> => "",
        interactive: process.stdin.isTTY === true,
        ink,
        scenes: mode === "scene",
      };

      return await runLearn({
        ...(stringFlag(args, "sandbox") === undefined ? {} : { sandboxRoot: stringFlag(args, "sandbox") }),
        ...(chapter === undefined ? {} : { chapter }),
        reset: boolFlag(args, "reset"),
        list: boolFlag(args, "list"),
        cols,
      }, io);
    } catch (error) {
      if (error instanceof UsageError || error instanceof UiModeError) {
        process.stderr.write(`tldrx learn: ${error.message}\n${this.usage}\n`);
        return EXIT_FAILED;
      }
      throw error;
    }
  },
};

/**
 * Wait for one line on stdin.
 *
 * `node:readline` rather than a raw-mode keypress reader: both runtimes have it,
 * it gives back Ctrl-C and Ctrl-D for free, and `q` — which the engine treats as
 * quit — needs a line anyway. The interface is opened and closed per question so
 * nothing is left holding stdin while a chapter's subprocess runs.
 */
async function askOnStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      // Ctrl-D closes stdin without a line: read that as "stop", never as "yes".
      rl.on("close", () => { resolve("q"); });
      rl.question(prompt, (answer) => { resolve(answer); });
    });
  } finally {
    rl.close();
  }
}
