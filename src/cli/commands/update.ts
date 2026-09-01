/** `tldrx update` — install the latest published tldrx and print what changed
 *
 * Issue #62. Every outcome it can have — no npm, a failed install, an install it
 * cannot read back, nothing new to install — comes back as an `UpdateOutcome` with
 * a sentence in it rather than as a thrown error, the same contract `tldrx ship`
 * has. The work is in `core/update/update.ts`; this file is argv and exit codes.
 */
import { homedir } from "node:os";
import type { Command } from "../Command.ts";
import { EXIT_FAILED, EXIT_OK } from "../exitCodes.ts";
import { boolFlag, parseArgs } from "../argv.ts";
import { fail } from "../report.ts";
import { frameworkVersion } from "../../core/frameworkVersion.ts";
import { realUpdateTransport, updateRun } from "../../core/update/update.ts";

export const updateCommand: Command = {
  name: "update",
  summary: "Update tldrx to the latest published version, and print what changed",
  usage: "tldrx update [--dry-run]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv);
      const outcome = await updateRun({
        current: await frameworkVersion(),
        home: process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
        transport: realUpdateTransport(),
        dryRun: boolFlag(args, "dry-run"),
      });
      const text = `${outcome.lines.join("\n")}\n`;
      if (outcome.code === EXIT_OK) process.stdout.write(text);
      else process.stderr.write(`tldrx update: ${text}`);
      return outcome.code;
    } catch (error) {
      return fail("update", error, EXIT_FAILED);
    }
  },
};
