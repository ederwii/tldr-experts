/** `tldrx approve` — Approve the current gate
 *
 * Spec §3, §5. Only valid when the cursor stage is `awaiting_gate`. The stage's
 * declared checks are RE-RUN against what is on disk; a failure exits 2 and names
 * the check. On a pass the gate is recorded (`by`, `at`), the stage is `done`, and
 * the cursor advances to the next stage as `ready`.
 */
import type { Command } from "../Command.ts";
import { EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK } from "../exitCodes.ts";
import { parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { approve, GateError } from "../../core/run/gates.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

export const approveCommand: Command = {
  name: "approve",
  summary: "Approve the current gate",
  usage: "tldrx approve [--run <id>] [--note <text>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, ["run", "note", "root"]);
      const root = workspaceRootFrom(args);
      const wanted = stringFlag(args, "run");
      const store = RunStore.find(root, wanted);
      if (store === null) {
        process.stderr.write(
          `tldrx approve: ${wanted === undefined ? "no non-terminal run" : `no run '${wanted}'`} in tldrx-work/\n`,
        );
        return EXIT_NOT_FOUND;
      }

      const outcome = await approve(store, {
        root,
        actor: currentActor(),
        at: nowRfc3339(),
        note: stringFlag(args, "note") ?? "",
      });

      if (!outcome.ok) {
        const failed = outcome.failed;
        process.stderr.write(
          `tldrx approve: refused — check \`${failed?.id ?? "unknown"}\` failed on ` +
            `${outcome.phase}/${outcome.stage}: ${failed?.detail ?? ""}\n`,
        );
        return EXIT_GATE_REFUSED;
      }

      const lines = [`approved ${outcome.phase}/${outcome.stage} (${describe(outcome.checks)})`];
      lines.push(
        outcome.advancedTo === null
          ? outcome.runDone
            ? `run ${store.runId} is done — every stage is terminal`
            : `no stage follows ${outcome.stage}`
          : `cursor → ${outcome.advancedTo.phase}/${outcome.advancedTo.stage} (ready)`,
      );
      process.stdout.write(`${lines.join("\n")}\n`);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof GateError) return fail("approve", error, EXIT_GATE_REFUSED);
      return fail("approve", error);
    }
  },
};

function describe(checks: readonly { id: string; status: string }[]): string {
  if (checks.length === 0) return "no checks declared";
  return checks.map((c) => `${c.id}:${c.status}`).join(", ");
}
