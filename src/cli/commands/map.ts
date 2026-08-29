/** `tldrx map` — Build, refresh or drift-check the code knowledge base
 *
 * Concept §4.2 and §15.2. --refresh runs the code-map tool incrementally; --check flags map entries whose cited paths no longer exist.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const mapCommand: Command = {
  name: "map",
  summary: "Build, refresh or drift-check the code knowledge base",
  usage: "tldrx map [--refresh|--check]",
  subcommands: ["--refresh", "--check"],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `map ${sub}` : "map";
    return notImplemented(label);
  },
};
