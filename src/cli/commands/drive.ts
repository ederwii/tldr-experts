/**
 * `tldrx drive --attended|--unattended` — print the session mandate (issue #63).
 *
 * It writes nothing, spawns nothing and needs no workspace: the output is text a
 * human pastes into the session that will drive a run, or reads themselves before
 * they start. That is the whole command.
 *
 * The one thing it reads is `tldrx-work/` (#75), and only to answer a question it
 * is allowed to fail at: which id goes in the mandate's `<run>` slots. An explicit
 * id — positional or `--run`, `ship`'s order — is substituted textually and never
 * validated; an id that names no run is the operator's typo to notice, exactly as
 * it would be had they typed it into each command themselves. Without one, the
 * ONE open run of the workspace it is standing in is used, and anything less
 * decidable than that — no workspace, no run, two open runs, an unreadable
 * `tldrx-work/` — leaves `<run>` standing and still exits 0. Two open runs get a
 * line on stderr naming them, because a mandate silently aimed at the wrong run is
 * the failure this was fixing.
 *
 * A direction is REQUIRED and never guessed — the same refusal `tldrx run attend`
 * makes, for the same reason. The two mandates differ in exactly the place a
 * wrong guess would hurt most: who may close a gate. Handing somebody the
 * unattended text when a person is at the keyboard tells a session to sign gates
 * that were never its to sign.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { DRIVE_MODES, renderMandate, type DriveMode } from "../../core/drive/index.ts";
import { frameworkVersion } from "../../core/frameworkVersion.ts";
import { findWorkspaceRoot } from "../../hooks/lib/workspace.ts";
import { RunStore } from "../../core/run/RunStore.ts";

export const driveCommand: Command = {
  name: "drive",
  summary: "Print the session mandate for driving a run",
  usage: "tldrx drive <--attended|--unattended> [--tldr] [<run>] [--run <id>]",
  subcommands: [],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv, ["run"]);
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
    const run = args.positionals[0] ?? stringFlag(args, "run") ?? theOneOpenRun();
    // `--tldr` is orthogonal to the mode on purpose: it changes what the session
    // WRITES, not who may sign, and an owner at the keyboard may want the status
    // block instead of the essay just as much as one who is not reading at all.
    const tldr = boolFlag(args, "tldr");
    process.stdout.write(`${renderMandate(mode, await frameworkVersion(), run, tldr)}\n`);
    return EXIT_OK;
  },
};

/**
 * The one open run of the workspace this is being run inside, or undefined.
 *
 * `RunStore.resolve`'s rule, not "the newest open one": where every other command
 * REFUSES to choose between two open runs, this declines to substitute and leaves
 * the placeholder — filling in the wrong id silently is worse than the hand
 * find-replace #75 is removing. Two open runs get named on stderr so the operator
 * can pass one, and stdout stays exactly the mandate either way.
 *
 * Every failure is swallowed on purpose. `tldrx drive` printing a mandate must not
 * become conditional on a workspace being readable — it is the one command that
 * has always run anywhere, and an unreadable `tldrx-work/` is not a reason to
 * withhold text that has nothing to do with it.
 */
function theOneOpenRun(): string | undefined {
  try {
    const root = findWorkspaceRoot(process.cwd());
    if (root === null) return undefined;
    const resolution = RunStore.resolve(root);
    if (resolution.kind === "one") return resolution.store.runId;
    if (resolution.kind === "ambiguous") {
      process.stderr.write(
        `tldrx drive: ${String(resolution.open.length)} runs are open, so <run> is left as it is`
        + ` — pass one to fill it in: ${resolution.open.map((store) => store.runId).join(", ")}\n`,
      );
    }
    return undefined;
  } catch {
    return undefined;
  }
}
