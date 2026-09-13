/** `tldrx story` — operator verbs that act on ONE Build story
 *
 * Two subcommands. `reopen`, in two shapes: plain, it gives a story that is
 * `blocked`, `review` or `in_progress` another run of developer attempts; with
 * `--for-fix` it opens a FIX ROUND on a story that is `done` (issue #58) — one
 * named defect in work a reviewer already approved, costing no attempt. And
 * `widen` (issue #171), which adds a path to a story's `touches:`. Every one is
 * signed with a `--note` and every one is the only sanctioned way to do what it
 * does — `run.yml` and the story files are the state (spec §1) and hand-editing
 * them is forbidden by design.
 *
 * `widen` exists because that rule and the boundary decision card had been
 * contradicting each other in production: the card told the operator to "add the
 * path to a story's `touches:`", which is exactly the hand edit the paragraph
 * above forbids, and no verb did it. Now the card names this one.
 *
 * Deliberately its own command rather than a flag on `reject`. `reject` is about
 * a GATE — a stage's approval, given or taken back — and a story is not a gate:
 * neither reopening one nor widening one signs anything, revokes anything, or
 * moves a cursor. Hanging them off `reject --story` would have made one verb mean
 * three decisions.
 *
 * The whole of the work is in `core/run/reopenStory.ts` and
 * `core/run/widenStory.ts`; this file is argv and exit codes.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { boolFlag, parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { reopenStory } from "../../core/run/reopenStory.ts";
import { widenStory } from "../../core/run/widenStory.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root", "note"];

export const storyCommand: Command = {
  name: "story",
  summary: "Give one Build story another run of attempts, or widen the paths it declares",
  usage:
    "tldrx story reopen <id> --note <text> [--for-fix | --as-is] [--run <id>] [--root <path>]\n" +
    "       tldrx story widen <id> <path>… --note <text> [--run <id>] [--root <path>]",
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    if (sub === "reopen") return storyReopen(rest);
    if (sub === "widen") return storyWiden(rest);
    process.stderr.write(`tldrx story: expected \`reopen\` or \`widen\`\n${storyCommand.usage}\n`);
    return EXIT_USAGE;
  },
};

/**
 * Success goes to stdout, a refusal to stderr — the same split `run unlock` and
 * `run cancel` make. A refusal is not a result, and a script that pipes stdout
 * should not have to filter one out of the other.
 */
function storyReopen(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    // Two different decisions, and typing both says neither of them (#279).
    // `--for-fix` reopens FINISHED work for one named defect, and what closes
    // that round is a developer landing the fix; `--as-is` settles UNFINISHED
    // work a person has already finished by hand, with no developer at all.
    // Refused rather than resolved in favour of one, for the same reason
    // `widen` refuses `--for-fix` below: an operator who typed both believes
    // something, and performing the other thing quietly is the CLI reporting
    // success for work it did not do. A usage error, and it writes nothing.
    if (boolFlag(args, "for-fix") && boolFlag(args, "as-is")) {
      process.stderr.write(
        "tldrx story reopen: --for-fix and --as-is answer different questions — nothing was written\n"
        + "  --for-fix opens a fix round on a `done` story: one named defect, landed by a developer.\n"
        + "  --as-is settles an UNFINISHED story from its branch as it stands, with no developer at all.\n"
        + "  Type the one you mean.\n"
        + `${storyCommand.usage}\n`,
      );
      return EXIT_USAGE;
    }
    const outcome = reopenStory({
      root: workspaceRootFrom(args),
      storyId: args.positionals[0] ?? "",
      note: stringFlag(args, "note") ?? "",
      forFix: boolFlag(args, "for-fix"),
      asIs: boolFlag(args, "as-is"),
      runId: stringFlag(args, "run"),
      actor: currentActor(),
      at: nowRfc3339(),
    });
    const text = `${outcome.lines.join("\n")}\n`;
    if (outcome.code === EXIT_OK) process.stdout.write(text);
    else process.stderr.write(`tldrx story reopen: ${text}`);
    return outcome.code;
  } catch (error) {
    return fail("story reopen", error);
  }
}

/**
 * The same split, for the same reason. The paths are POSITIONALS after the story
 * id — `tldrx story widen S3 platform/Auth.cs src/Ledger.cs --note "…"` — because
 * a repeated `--path` would let a shell glob expand into a widening nobody typed.
 */
function storyWiden(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, VALUE_FLAGS);
    // `--as-is` is `reopen`'s for exactly the reason `--for-fix` is: the argv
    // guard is COMMAND-level, so a flag scoped to the other subcommand still
    // arrives here, and silently widening instead of settling would be the same
    // lie (#279).
    if (boolFlag(args, "as-is")) {
      process.stderr.write(
        "tldrx story widen: --as-is is a flag of `reopen`, not of `widen` — nothing was written\n"
        + "  widening declares a path; `--as-is` settles a story from its branch as it stands.\n"
        + `  \`tldrx story reopen <id> --as-is --note "<what you did by hand>"\` is the verb you want.\n`
        + `${storyCommand.usage}\n`,
      );
      return EXIT_USAGE;
    }
    // `--for-fix` is `reopen`'s, and `helpText.ts` scopes it there — but the argv
    // guard (`cli/index.ts`, `declaredFlags`) is COMMAND-level, so nothing
    // upstream stops it arriving here. Refused rather than ignored: an operator
    // who typed it believes they opened a fix round on a done story, and quietly
    // performing a plain widening instead would be the CLI reporting success for
    // work it did not do. A flag this subcommand does not take is a usage error.
    if (boolFlag(args, "for-fix")) {
      process.stderr.write(
        "tldrx story widen: --for-fix is a flag of `reopen`, not of `widen` — nothing was written\n"
        + "  widening declares a path; `--for-fix` reopens finished work for one named defect.\n"
        + `  \`tldrx story reopen <id> --for-fix --note "<the defect>"\` first, then widen the reopened story.\n`
        + `${storyCommand.usage}\n`,
      );
      return EXIT_USAGE;
    }
    const outcome = widenStory({
      root: workspaceRootFrom(args),
      storyId: args.positionals[0] ?? "",
      paths: args.positionals.slice(1),
      note: stringFlag(args, "note") ?? "",
      runId: stringFlag(args, "run"),
      actor: currentActor(),
      at: nowRfc3339(),
    });
    const text = `${outcome.lines.join("\n")}\n`;
    if (outcome.code === EXIT_OK) process.stdout.write(text);
    else process.stderr.write(`tldrx story widen: ${text}`);
    return outcome.code;
  } catch (error) {
    return fail("story widen", error);
  }
}
