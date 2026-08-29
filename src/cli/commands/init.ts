/** `tldrx init` — Detect the workspace, build the code map, interview the gaps
 *
 * Concept §4. Runs the loop once against the whole workspace: detect repos/stack/commands -> workspace.yml, run the code map -> map/*.md, write install-handoff.md, interview only the gaps -> memory/facts.yml, seed experts, write conventions.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const initCommand: Command = {
  name: "init",
  summary: "Detect the workspace, build the code map, interview the gaps",
  usage: "tldrx init [--refresh] [--process <file>]",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `init ${sub}` : "init";
    return notImplemented(label);
  },
};
