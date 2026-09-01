/** `tldrx ship` — open a PR from the run's epic branch, handoff as the body
 *
 * The last step of the loop, which until now was "merge by hand" (issue #15).
 *
 * Every refusal it can make — no epic branch, no handoff, no `gh`, no remote, an
 * unpushed branch, several epic branches — comes back as a `ShipOutcome` with a
 * sentence in it, not as a thrown error, so the operator never meets a stack
 * trace for a situation that is ordinary. The whole of the work is in
 * `core/run/ship.ts`; this file is argv and exit codes.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { shipRun, realShipTransport } from "../../core/run/ship.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root", "branch", "repo", "base"];

export const shipCommand: Command = {
  name: "ship",
  summary: "Open a PR from the run's epic branch (one per repo), handoff as the body",
  usage: "tldrx ship [<run>] [--branch <name>] [--repo <name>] [--base <branch>]\n"
    + "                  [--draft] [--dry-run] [--run <id>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, VALUE_FLAGS);
      const outcome = await shipRun({
        root: workspaceRootFrom(args),
        runId: args.positionals[0] ?? stringFlag(args, "run"),
        branch: stringFlag(args, "branch"),
        repo: stringFlag(args, "repo"),
        base: stringFlag(args, "base"),
        draft: boolFlag(args, "draft"),
        dryRun: boolFlag(args, "dry-run"),
        actor: currentActor(),
        at: nowRfc3339(),
        transport: realShipTransport(),
      });
      const text = `${outcome.lines.join("\n")}\n`;
      if (outcome.code === EXIT_OK) process.stdout.write(text);
      else process.stderr.write(`tldrx ship: ${text}`);
      return outcome.code;
    } catch (error) {
      return fail("ship", error);
    }
  },
};
