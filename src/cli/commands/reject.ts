/** `tldrx reject` — Request changes at the current gate
 *
 * Concept §2. Records the rejection and what was asked for; the stage re-runs with that as input.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const rejectCommand: Command = {
  name: "reject",
  summary: "Request changes at the current gate",
  usage: "tldrx reject [--note <text>]",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `reject ${sub}` : "reject";
    return notImplemented(label);
  },
};
