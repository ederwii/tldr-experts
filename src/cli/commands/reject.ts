/** `tldrx reject` — Request changes at the current gate
 *
 * Spec §3, §5 "Failure path": the note is stored on the gate and the stage goes
 * back to `ready`, so the next `next` re-runs it with the note as input under a
 * `## Previous attempt` heading. Valid on a stage that is `awaiting_gate` OR one
 * that is `failed` — §5 gives the operator both moves after a failure. Nothing is
 * deleted and no cost is refunded — money spent stays on the record.
 */
import type { Command } from "../Command.ts";
import { EXIT_GATE_REFUSED, EXIT_OK } from "../exitCodes.ts";
import { parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, resolveRunOrExplain } from "../resolveRun.ts";
import { GateError, reject } from "../../core/run/gates.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

export const rejectCommand: Command = {
  name: "reject",
  summary: "Request changes at the current gate",
  usage: "tldrx reject --note <text> [--run <id>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, ["run", "note", "root"]);
      const note = stringFlag(args, "note") ?? args.positionals.join(" ");
      if (note.trim() === "") {
        throw new UsageError('reject needs --note: `tldrx reject --note "what to change"`');
      }
      const root = workspaceRootFrom(args);
      const wanted = stringFlag(args, "run");
      const resolved = resolveRunOrExplain("tldrx reject", root, wanted);
      if (!isResolved(resolved)) return resolved.exit;
      const store = resolved.store;

      const outcome = reject(store, {
        root,
        actor: currentActor(),
        at: nowRfc3339(),
        note,
      });
      const came = outcome.from === "failed" ? " (it had failed)" : "";
      process.stdout.write(
        `rejected ${outcome.phase}/${outcome.stage}${came} — back to \`ready\`\n` +
          `note: ${outcome.note}\nthe note goes into the next prompt — \`tldrx next\` to re-run the stage\n`,
      );
      return EXIT_OK;
    } catch (error) {
      if (error instanceof GateError) return fail("reject", error, EXIT_GATE_REFUSED);
      return fail("reject", error);
    }
  },
};
