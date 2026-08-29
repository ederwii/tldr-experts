/** `tldrx run` — Create or inspect a piece of work
 *
 * Concept §5. `run new` creates tldrx-work/<yymmdd>-<slug>/ with run.yml + events.jsonl. `run status` renders the current execution path. `--from` runs the distill step over a PRD / Jira epic / aidlc intent dir.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const runCommand: Command = {
  name: "run",
  summary: "Create or inspect a piece of work",
  usage: "tldrx run <new|status> [--scope <scope>] [--from <path>]",
  subcommands: ["new", "status"],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `run ${sub}` : "run";
    return notImplemented(label);
  },
};
