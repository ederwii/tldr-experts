/** `tldrx status` — What is waiting on me, in this workspace, right now
 *
 * Spec §3. A REPORT, so it exits `0` whatever it finds: "there are four things
 * pending" and "there is nothing pending" are both complete answers, and a
 * non-zero exit on either would make the one command a session opens with look
 * like a failure. The single non-zero is `3` — no `.tldrx/` here at all, which is
 * the absence of the thing being reported on, not a finding about it.
 *
 * Deterministic and read-only: files in, lines out. Nothing is spawned, nothing is
 * written, no run is advanced.
 */
import type { Command } from "../Command.ts";
import { EXIT_NOT_FOUND, EXIT_OK } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { findWorkspaceRoot } from "../../hooks/lib/workspace.ts";
import { PROJECT_FRAMEWORK_DIR } from "../../core/paths.ts";
import { fail } from "../report.ts";
import { resolve } from "node:path";
import {
  buildWorkspaceStatus, renderWorkspaceStatus, workspaceStatusJson,
} from "../../core/status/index.ts";

export const statusCommand: Command = {
  name: "status",
  summary: "What is pending in this workspace, and the command for each",
  usage: "tldrx status [--json] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, ["root"]);
      const explicit = stringFlag(args, "root");
      const root = findWorkspaceRoot(explicit === undefined ? process.cwd() : resolve(explicit));
      if (root === null) {
        process.stderr.write(
          `tldrx status: no ${PROJECT_FRAMEWORK_DIR}/ found in `
          + `${explicit ?? process.cwd()} or any parent — run \`tldrx init\` first\n`,
        );
        return EXIT_NOT_FOUND;
      }
      const status = buildWorkspaceStatus(root);
      process.stdout.write(
        boolFlag(args, "json")
          ? `${workspaceStatusJson(status)}\n`
          : `${renderWorkspaceStatus(status)}\n`,
      );
      return EXIT_OK;
    } catch (error) {
      return fail("status", error);
    }
  },
};
