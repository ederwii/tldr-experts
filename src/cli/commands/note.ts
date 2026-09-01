/** `tldrx note` — write one operator annotation into the run's event log
 *
 * The smallest verb in the CLI, and deliberately so: it appends ONE
 * `operator_note` event and changes nothing else — no gate, no cursor, no
 * `run.yml`, no money. It exists because there was no honest carrier for "a
 * person did this, outside the tool, now" (issue #46), and the two carriers people
 * reached for instead were a future gate note and a `reject`.
 *
 * The grammar is `tldrx note [<run>] [--stage <id>] "text"`. Two positionals are
 * the run and the text, in the issue's own order; ONE positional is the text, and
 * the run is resolved the way every other command resolves it — except when that
 * lone argument happens to name a run, which is a half-typed command and is
 * refused rather than recorded.
 *
 * The whole of the work is in `core/run/operatorNote.ts`; this file is argv and
 * exit codes.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK } from "../exitCodes.ts";
import { parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { addOperatorNote } from "../../core/run/operatorNote.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root", "stage"];

export const noteCommand: Command = {
  name: "note",
  summary: "Record one operator annotation on a run, changing nothing else",
  usage: 'tldrx note [<run>] [--stage <id>] "<text>" [--run <id>] [--root <path>]',
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, VALUE_FLAGS);
      const positionals = args.positionals;
      // `note <run> "text"` — the issue's grammar — or `note "text"`. Arity
      // decides; nothing here guesses which of two strings is an id.
      const sole = positionals.length === 1;
      const outcome = addOperatorNote({
        root: workspaceRootFrom(args),
        note: (sole ? positionals[0] : positionals[1]) ?? "",
        runId: sole ? stringFlag(args, "run") : (positionals[0] ?? stringFlag(args, "run")),
        stage: stringFlag(args, "stage"),
        soleArgument: sole,
        actor: currentActor(),
        at: nowRfc3339(),
      });
      const text = `${outcome.lines.join("\n")}\n`;
      // A refusal is not a result: stdout stays clean for anything piping it.
      if (outcome.code === EXIT_OK) process.stdout.write(text);
      else process.stderr.write(`tldrx note: ${text}`);
      return outcome.code;
    } catch (error) {
      return fail("note", error);
    }
  },
};
