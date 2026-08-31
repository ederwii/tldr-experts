/** `tldrx story` — operator verbs that act on ONE Build story
 *
 * One subcommand today: `reopen`. It gives a story that is `blocked`, `review` or
 * `in_progress` another run of developer attempts, signed with a `--note`, and it
 * is the only sanctioned way to do that — `run.yml` and the story files are the
 * state (spec §1) and hand-editing them is forbidden by design.
 *
 * Deliberately its own command rather than a flag on `reject`. `reject` is about
 * a GATE — a stage's approval, given or taken back — and a story is not a gate:
 * reopening one signs nothing, revokes nothing, and moves no cursor. Hanging it
 * off `reject --story` would have made one verb mean two decisions.
 *
 * The whole of the work is in `core/run/reopenStory.ts`; this file is argv and
 * exit codes.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { parseArgs, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { reopenStory } from "../../core/run/reopenStory.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["run", "root", "note"];

export const storyCommand: Command = {
  name: "story",
  summary: "Give one Build story another run of attempts",
  usage: "tldrx story reopen <id> --note <text> [--run <id>] [--root <path>]",
  subcommands: ["reopen"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    const [sub, ...rest] = argv;
    if (sub === "reopen") return storyReopen(rest);
    process.stderr.write(`tldrx story: expected \`reopen\`\n${storyCommand.usage}\n`);
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
