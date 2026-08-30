/**
 * `tldrx replay <run>` — render a run's events as a narrative (concept §15.4).
 *
 * Read-only: it writes nothing, and every line it prints comes from an event
 * that was actually logged.
 */
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK } from "../exitCodes.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { renderAmbiguous } from "../resolveRun.ts";
import { resolveWorkspaceRoot } from "../../core/experts/index.ts";
import { listRuns, loadRun, renderReplay } from "../../core/replay/index.ts";

export const replayCommand: Command = {
  name: "replay",
  summary: "Render a run's events.jsonl as a narrative",
  usage: "tldrx replay [<run-id>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const root = resolveWorkspaceRoot(option(argv, "--root"));
    const named = positional(argv);
    // Read-only, but still an answer ABOUT one run: narrating the wrong run's
    // history is the same lie as acting on it. Named run, else today's fallback.
    if (named === null && RunStore.resolve(root).kind === "ambiguous") {
      process.stderr.write(renderAmbiguous("tldrx replay", RunStore.findOpen(root)));
      return EXIT_GATE_REFUSED;
    }
    const id = named ?? listRuns(root)[0] ?? null;
    if (id === null) {
      process.stderr.write("tldrx replay: no run id given and no runs found under tldrx-work/\n");
      return EXIT_FAILED;
    }

    const loaded = loadRun(root, id);
    if (loaded === null) {
      process.stderr.write(`tldrx replay: run '${id}' not found under ${root}/tldrx-work\n`);
      return EXIT_NOT_FOUND;
    }

    process.stdout.write(renderReplay(loaded));
    return EXIT_OK;
  },
};

function positional(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i] ?? "";
    if (current.startsWith("--")) {
      if (current === "--root") i += 1;
      continue;
    }
    return current;
  }
  return null;
}

function option(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}
