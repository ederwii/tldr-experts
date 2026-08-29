/** `tldrx --version` / `tldrx version`. Implemented. */
import type { Command } from "../Command.ts";
import { EXIT_OK } from "../exitCodes.ts";
import { frameworkVersion } from "../../core/frameworkVersion.ts";

export const versionCommand: Command = {
  name: "version",
  summary: "Print the tldrx version",
  usage: "tldrx --version",
  subcommands: [],
  implemented: true,
  async run(): Promise<number> {
    process.stdout.write((await frameworkVersion()) + "\n");
    return EXIT_OK;
  },
};
