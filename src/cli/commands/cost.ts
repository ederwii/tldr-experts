/** `tldrx cost` — What the work actually cost, per attempt, per stage, per run.
 *
 * Reads `events.jsonl` and nothing else. Every dollar it prints is one the Claude
 * CLI reported on an `agent.result` line; nothing here multiplies a token count by
 * a price. `tldrx run estimate` is the command that is allowed to guess, and it
 * says "ESTIMATE" in words when it does.
 *
 * Spends nothing, spawns nothing, advances nothing.
 */
import type { Command } from "../Command.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { ambiguousRunLines } from "../../core/run/openRuns.ts";
import {
  buildProgramCost, buildRunCost, renderProgramCost, renderRunCost,
} from "../../core/budget/costView.ts";

const VALUE_FLAGS = ["run", "root"];

export const costCommand: Command = {
  name: "cost",
  summary: "What has been spent — per attempt, per stage, per run",
  usage: "tldrx cost [<run>] [--run <id>] [--all] [--json] [--root <path>]",
  subcommands: [],
  implemented: true,
  run(argv: readonly string[]): Promise<number> {
    return Promise.resolve(costReport(argv));
  },
};

function costReport(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    const root = workspaceRootFrom(args);
    const json = boolFlag(args, "json");

    // `--all` is the PROGRAM view: every run under tldrx-work/, open or finished.
    // A workspace's total is the number an operator is asked about, and it was
    // not available anywhere before this command.
    if (boolFlag(args, "all")) {
      const program = buildProgramCost(root);
      process.stdout.write(
        json ? `${JSON.stringify(program, null, 2)}\n` : `${renderProgramCost(program)}\n`,
      );
      return EXIT_OK;
    }

    const runId = args.positionals[0] ?? stringFlag(args, "run");
    const resolution = RunStore.resolve(root, runId);
    if (resolution.kind === "ambiguous") {
      // The same refusal `next` gives, for the same reason: with two runs open,
      // guessing quietly reports the wrong one's money.
      process.stderr.write(`tldrx cost: ${ambiguousRunLines(resolution.open).join("\n  ")}\n`);
      return EXIT_USAGE;
    }
    if (resolution.kind === "none") {
      process.stderr.write(
        `tldrx cost: ${runId === undefined
          ? "no open run — name one, or use `--all` for every run in this workspace"
          : `no run '${runId}' in tldrx-work/`}\n`,
      );
      return EXIT_NOT_FOUND;
    }

    const cost = buildRunCost(resolution.store.runDir);
    if (cost === null) {
      process.stderr.write(`tldrx cost: ${resolution.store.runId} has no readable run.yml or events.jsonl\n`);
      return EXIT_NOT_FOUND;
    }
    process.stdout.write(json ? `${JSON.stringify(cost, null, 2)}\n` : `${renderRunCost(cost)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) return fail("cost", error, EXIT_USAGE);
    return fail("cost", error);
  }
}
