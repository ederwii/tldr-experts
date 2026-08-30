/** `tldrx reject` — Request changes at the current gate, or take an approval back
 *
 * Spec §3, §5 "Failure path": the note is stored on the gate and the stage goes
 * back to `ready`, so the next `next` re-runs it with the note as input under a
 * `## Previous attempt` heading. Valid on a stage that is `awaiting_gate` OR one
 * that is `failed` — §5 gives the operator both moves after a failure. Nothing is
 * deleted and no cost is refunded — money spent stays on the record.
 *
 * With `--stage <phase>/<stage>` it does the other half, added 2026-08-29: it
 * REVOKES an approval that was already signed. The audit measured a fabricated
 * handoff closing its own auto gate and then being unrevokable — `reject` only
 * ever looked at the cursor, so the answer was "nothing to reject: 02-how/beta is
 * `ready`". An approval a person cannot take back is not a gate, whether the
 * signature says `auto` or their own name.
 */
import type { Command } from "../Command.ts";
import { EXIT_GATE_REFUSED, EXIT_OK } from "../exitCodes.ts";
import { parseArgs, stringFlag, UsageError } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { isResolved, notFound, renderAmbiguous, resolveRunOrExplain, type RunOrExit } from "../resolveRun.ts";
import { GateError, reject, revoke } from "../../core/run/gates.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { PROJECT_WORK_DIR } from "../../core/paths.ts";
import { EXIT_NOT_FOUND } from "../exitCodes.ts";

export const rejectCommand: Command = {
  name: "reject",
  summary: "Request changes at the current gate, or revoke an approval already given",
  usage: "tldrx reject --note <text> [--stage <phase>/<stage>] [--run <id>] [--root <path>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, ["run", "note", "root", "stage"]);
      const note = stringFlag(args, "note") ?? args.positionals.join(" ");
      if (note.trim() === "") {
        throw new UsageError('reject needs --note: `tldrx reject --note "what to change"`');
      }
      const root = workspaceRootFrom(args);
      const wanted = stringFlag(args, "run");
      const target = stringFlag(args, "stage");
      const resolved = target === undefined || target === ""
        ? resolveRunOrExplain("tldrx reject", root, wanted)
        : resolveIncludingFinished(root, wanted);
      if (!isResolved(resolved)) return resolved.exit;
      const store = resolved.store;
      const ctx = { root, actor: currentActor(), at: nowRfc3339(), note };

      if (target !== undefined && target !== "") {
        const outcome = revoke(store, ctx, target);
        const signed = outcome.signedBy === "auto"
          ? "it had been auto-approved by the facilitator"
          : `it had been approved by ${outcome.signedBy}`;
        const lines = [
          `REVOKED ${outcome.phase}/${outcome.stage} — ${signed}${outcome.signedAt === null ? "" : ` at ${outcome.signedAt}`}`,
          `note: ${outcome.note}`,
          `cursor → ${outcome.phase}/${outcome.stage} (ready)`,
        ];
        lines.push(
          outcome.staled.length === 0
            ? "no later stage had run, so nothing went stale"
            : `${outcome.staled.length} later stage(s) marked stale — their files are still on disk, `
              + `and they were derived from a decision that is now withdrawn: ${outcome.staled.join(", ")}`,
        );
        lines.push("nothing was deleted and no cost was refunded — `tldrx next` re-runs the stage with the note");
        process.stdout.write(`${lines.join("\n")}\n`);
        return EXIT_OK;
      }

      const outcome = reject(store, ctx);
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

/**
 * `--stage` may target a run that has already FINISHED.
 *
 * Every other command resolves an OPEN run, which is right for them: you cannot
 * advance, answer or approve a run that is over. Revocation is the one verb whose
 * whole purpose is to reopen one — the audit's case is precisely a run that walked
 * to the end on auto gates and is now suspect. So: an open run first, exactly as
 * before; and only when there is none, the newest run on disk whatever its status.
 */
function resolveIncludingFinished(root: string, wanted?: string): RunOrExit {
  const resolution = RunStore.resolve(root, wanted);
  if (resolution.kind === "one") return { store: resolution.store };
  if (resolution.kind === "ambiguous") {
    process.stderr.write(renderAmbiguous("tldrx reject", resolution.open));
    return { exit: EXIT_GATE_REFUSED };
  }
  const all: RunStore[] = [];
  for (const dir of listRunDirs(root)) {
    try {
      all.push(RunStore.open(dir));
    } catch {
      continue;
    }
  }
  const only = all[0];
  if (only === undefined) {
    process.stderr.write(`tldrx reject: ${notFound(wanted)} in ${PROJECT_WORK_DIR}/\n`);
    return { exit: EXIT_NOT_FOUND };
  }
  if (all.length > 1) {
    process.stderr.write(renderAmbiguous("tldrx reject", all));
    return { exit: EXIT_GATE_REFUSED };
  }
  return { store: only };
}
