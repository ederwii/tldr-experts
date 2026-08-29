/** `tldrx next` — Advance the active run to its next stage
 *
 * Concept §7. Reads run.yml, decides the next stage, spawns one sub-agent per task, writes results back to files, stops at gates.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const nextCommand: Command = {
  name: "next",
  summary: "Advance the active run to its next stage",
  usage: "tldrx next [--dry-run]",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `next ${sub}` : "next";
    return notImplemented(label);
  },
};
