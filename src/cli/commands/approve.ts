/** `tldrx approve` — Approve the current gate
 *
 * Concept §2. Records the approval in run.yml and events.jsonl, then releases the next stage.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const approveCommand: Command = {
  name: "approve",
  summary: "Approve the current gate",
  usage: "tldrx approve [--note <text>]",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `approve ${sub}` : "approve";
    return notImplemented(label);
  },
};
