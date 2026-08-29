/** `tldrx expert` — Manage the expert files
 *
 * Concept §6. Experts are files: expert.md + competencies.yml. Training (light/full) is v1.1; v0 ships files only.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const expertCommand: Command = {
  name: "expert",
  summary: "Manage the expert files",
  usage: "tldrx expert <list|create|train> [name]",
  subcommands: ["list", "create", "train"],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `expert ${sub}` : "expert";
    return notImplemented(label);
  },
};
