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
    "tldrx story reopen <id> --note <text> [--for-fix] [--run <id>] [--root <path>]\n" +
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
    const outcome = reopenStory({
      root: workspaceRootFrom(args),
      storyId: args.positionals[0] ?? "",
      note: stringFlag(args, "note") ?? "",
      forFix: boolFlag(args, "for-fix"),
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
