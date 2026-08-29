/** `tldrx dashboard` — Serve or export the read-only dashboard
 *
 * Concept §12. Watches tldrx-work/** and .tldrx/**, serves a single page over SSE. Read-only by design: no writes, no launch buttons.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const dashboardCommand: Command = {
  name: "dashboard",
  summary: "Serve or export the read-only dashboard",
  usage: "tldrx dashboard [--static] [--port <n>]",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `dashboard ${sub}` : "dashboard";
    return notImplemented(label);
  },
};
