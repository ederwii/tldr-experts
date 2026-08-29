/**
 * `tldrx doctor` — the one command that does real work in v0.
 *
 * Reads env.yml, runs each declared check, prints the table.
 * Exit 0 when every REQUIRED tool is present and meets its min_version, else 1.
 * `--mcp` additionally runs `claude mcp list` (slow: live health checks per server).
 */
import type { Command } from "../Command.ts";
import { EXIT_FAILED } from "../exitCodes.ts";
import { runDoctor } from "../../core/doctor/runDoctor.ts";

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check the local environment against env.yml",
  usage: "tldrx doctor [--mcp]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const mcp = argv.includes("--mcp");
    try {
      const outcome = await runDoctor({ mcp });
      process.stdout.write(outcome.output + "\n");
      return outcome.exitCode;
    } catch (error) {
      process.stderr.write(`tldrx doctor: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILED;
    }
  },
};
