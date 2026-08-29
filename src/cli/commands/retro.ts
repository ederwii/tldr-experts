/** `tldrx retro` — Close a run and capture what was learned
 *
 * Concept §13. Writes retro.md with three sections: what to remember (-> facts), how to work differently (-> practices.md), what stage to add or change (-> stages/proposed/). Proposed stages stay inert until accepted.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const retroCommand: Command = {
  name: "retro",
  summary: "Close a run and capture what was learned",
  usage: "tldrx retro [<run-id>]",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `retro ${sub}` : "retro";
    return notImplemented(label);
  },
};
