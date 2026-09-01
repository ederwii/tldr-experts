/**
 * `tldrx drive --attended|--unattended` — print the session mandate (issue #63).
 *
 * It reads nothing, writes nothing, spawns nothing and needs no workspace: the
 * output is text a human pastes into the session that will drive a run, or reads
 * themselves before they start. That is the whole command.
 *
 * A direction is REQUIRED and never guessed — the same refusal `tldrx run attend`
 * makes, for the same reason. The two mandates differ in exactly the place a
 * wrong guess would hurt most: who may close a gate. Handing somebody the
 * unattended text when a person is at the keyboard tells a session to sign gates
 * that were never its to sign.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs } from "../argv.ts";
import { DRIVE_MODES, renderMandate, type DriveMode } from "../../core/drive/index.ts";
import { frameworkVersion } from "../../core/frameworkVersion.ts";

export const driveCommand: Command = {
  name: "drive",
  summary: "Print the session mandate for driving a run",
  usage: "tldrx drive <--attended|--unattended>",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    const attended = boolFlag(args, "attended");
    const unattended = boolFlag(args, "unattended");

    if (attended && unattended) {
      process.stderr.write(
        "tldrx drive: pass one of --attended or --unattended, not both — they are two"
        + " different mandates, and the difference is who may close a gate.\n",
      );
      return EXIT_USAGE;
    }
    if (!attended && !unattended) {
      process.stderr.write(
        `tldrx drive: name the mode — ${DRIVE_MODES.map((mode) => `--${mode}`).join(" or ")}.\n`
        + "  --attended    a person is at the keyboard and closes every gate\n"
        + "  --unattended  nobody is watching; the session signs agent gates over a written check\n",
      );
      return EXIT_USAGE;
    }

    const mode: DriveMode = attended ? "attended" : "unattended";
    process.stdout.write(`${renderMandate(mode, await frameworkVersion())}\n`);
    return EXIT_OK;
  },
};
