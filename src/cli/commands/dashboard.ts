/**
 * `tldrx dashboard --static` — export one self-contained page (concept §12).
 *
 * The live watching server is v1. Without `--static` this exits 64 and says so,
 * rather than serving something that only looks live.
 */
import { isAbsolute, join } from "node:path";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_NOT_IMPLEMENTED, EXIT_OK } from "../exitCodes.ts";
import { resolveWorkspaceRoot } from "../../core/experts/index.ts";
import { DEFAULT_OUT_DIR, writeStaticDashboard } from "../../core/dashboard/index.ts";

export const dashboardCommand: Command = {
  name: "dashboard",
  summary: "Serve or export the read-only dashboard",
  usage: "tldrx dashboard --static [--out <dir>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    if (!argv.includes("--static")) {
      process.stderr.write(
        "tldrx dashboard: the live server is v1 — use --static to export a snapshot\n",
      );
      return EXIT_NOT_IMPLEMENTED;
    }

    const root = resolveWorkspaceRoot(option(argv, "--root"));
    const out = option(argv, "--out");
    const outDir = out === null ? join(root, DEFAULT_OUT_DIR) : isAbsolute(out) ? out : join(root, out);

    try {
      const written = writeStaticDashboard(root, outDir, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
      process.stdout.write(
        `wrote ${written.path} (${written.bytes} bytes)\n`
          + `  ${written.runs} run(s), ${written.experts} expert(s), no external requests\n`,
      );
      return EXIT_OK;
    } catch (error) {
      process.stderr.write(`tldrx dashboard: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILED;
    }
  },
};

function option(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}
