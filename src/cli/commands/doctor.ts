/**
 * `tldrx doctor` — the one command that does real work in v0.
 *
 * Reads env.yml, runs each declared check, prints the table.
 * Exit 0 when every REQUIRED tool is present and meets its min_version, else 1.
 * `--mcp` additionally runs `claude mcp list` (slow: live health checks per server).
 * `--json` prints the same findings as data — the results were already structured,
 * so the table was the only reason a script could not read them.
 *
 * It also names any workspace file still opening with the deprecated
 * `schema_version:` key. That is a warning and never changes the exit code: the
 * exit code is about the TOOLS this machine has.
 */
import type { Command } from "../Command.ts";
import { EXIT_FAILED } from "../exitCodes.ts";
import { runDoctor, type DoctorOutcome } from "../../core/doctor/runDoctor.ts";
import { findWorkspaceRoot } from "../../hooks/lib/workspace.ts";

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check the local environment against env.yml",
  usage: "tldrx doctor [--mcp] [--json]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const mcp = argv.includes("--mcp");
    const json = argv.includes("--json");
    try {
      const outcome = await runDoctor({ mcp, root: findWorkspaceRoot(process.cwd()) });
      process.stdout.write(json ? `${doctorJson(outcome)}\n` : outcome.output + "\n");
      return outcome.exitCode;
    } catch (error) {
      process.stderr.write(`tldrx doctor: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILED;
    }
  },
};

/**
 * `mcp: null` means NOT PROBED, which is not the same claim as "no servers"; the
 * table says as much in words and the JSON has to say it in shape, or a consumer
 * would read a missing `--mcp` as an empty machine.
 */
export function doctorJson(outcome: DoctorOutcome): string {
  return JSON.stringify(
    {
      healthy: outcome.healthy,
      tools: outcome.results.map((result) => ({
        id: result.id,
        required: result.required,
        found: result.found,
        minVersion: result.minVersion,
        status: result.status,
        purpose: result.purpose,
        installHint: result.status === "ok" ? null : result.installHint,
      })),
      legacyVersionFiles: outcome.legacyVersionFiles,
      mcp: outcome.mcp === null
        ? null
        : {
          ran: outcome.mcp.ran,
          error: outcome.mcp.error,
          servers: outcome.mcp.servers.map((server) => ({
            name: server.name,
            transport: server.transport,
            status: server.status,
          })),
        },
    },
    null,
    2,
  );
}
