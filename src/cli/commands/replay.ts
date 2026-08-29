/** `tldrx replay` — Render a run's events.jsonl as a narrative
 *
 * Concept §15.4. The stakeholder view of what happened, built from the append-only log.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const replayCommand: Command = {
  name: "replay",
  summary: "Render a run's events.jsonl as a narrative",
  usage: "tldrx replay <run-id>",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `replay ${sub}` : "replay";
    return notImplemented(label);
  },
};
