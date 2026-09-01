/**
 * `tldrx retro <run> [--apply]` — write `retro.md` (concept §13).
 *
 * Always writes exactly one file, `tldrx-work/<run>/retro.md`. `--apply` is the
 * only thing that touches team memory, and it appends — it never rewrites what
 * practices.md already says.
 *
 * `--all` is the other direction and the opposite kind of command (#64): it reads
 * EVERY run in the workspace and writes nothing at all. The two are refused
 * together rather than composed, because they disagree about the two things that
 * matter — how many runs are in scope, and whether anything is written.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { renderAmbiguous } from "../resolveRun.ts";
import { resolveWorkspaceRoot } from "../../core/experts/index.ts";
import { listRuns, loadRun } from "../../core/replay/index.ts";
import { applyPractices, buildRetro, mineAll, renderTrends, RETRO_FILE } from "../../core/retro/index.ts";

export const retroCommand: Command = {
  name: "retro",
  summary: "Close a run and capture what was learned",
  usage: "tldrx retro [<run-id>] [--apply] [--root <path>]\n"
    + "tldrx retro --all [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const root = resolveWorkspaceRoot(option(argv, "--root"));
    const named = positional(argv);

    if (argv.includes("--all")) {
      // Both refusals happen before a single file is opened. `--all --apply` in
      // particular must not append half a practices.md and then complain.
      if (argv.includes("--apply")) {
        process.stderr.write(
          "tldrx retro: --all and --apply do not compose — --all is a reader across every run"
          + " and writes nothing; --apply appends one run's proposals to practices.md.\n",
        );
        return EXIT_USAGE;
      }
      if (named !== null) {
        process.stderr.write(
          `tldrx retro: --all reads every run, so naming one ('${named}') asks for two`
          + " different things. Drop the id, or drop --all.\n",
        );
        return EXIT_USAGE;
      }
      process.stdout.write(`${renderTrends(mineAll(root))}\n`);
      return EXIT_OK;
    }

    // With no id and several runs open there is no defensible default: retro
    // writes a file INTO one of them. Named run, else today's fallback (the
    // newest run of any status — a retro is usually written for a finished one).
    if (named === null && RunStore.resolve(root).kind === "ambiguous") {
      process.stderr.write(renderAmbiguous("tldrx retro", RunStore.findOpen(root)));
      return EXIT_GATE_REFUSED;
    }
    const id = named ?? listRuns(root)[0] ?? null;
    if (id === null) {
      process.stderr.write("tldrx retro: no run id given and no runs found under tldrx-work/\n");
      return EXIT_FAILED;
    }

    const loaded = loadRun(root, id);
    if (loaded === null) {
      process.stderr.write(`tldrx retro: run '${id}' not found under ${root}/tldrx-work\n`);
      return EXIT_NOT_FOUND;
    }

    const report = buildRetro(loaded);
    const path = join(loaded.dir, RETRO_FILE);
    writeFileSync(path, report.markdown, "utf8");

    const lines = [
      `wrote ${path}`,
      `  ${report.facts.length} fact(s) · ${report.practices.length} practice proposal(s) `
        + `· ${report.stages.length} proposed stage(s)`,
    ];

    if (argv.includes("--apply")) {
      const applied = applyPractices(root, id, report.practices);
      lines.push(applied.appended
        ? `  appended ${report.practices.length} proposal(s) to ${applied.path}`
        : `  practices.md unchanged: ${applied.reason ?? "nothing to append"}`);
    } else if (report.practices.length > 0) {
      lines.push("  re-run with --apply to append the proposals to .tldrx/memory/practices.md");
    }

    process.stdout.write(`${lines.join("\n")}\n`);
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
