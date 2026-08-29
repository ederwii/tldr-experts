/** `tldrx answer` — Answer the open interview questions
 *
 * Concept §2. Answers land in memory/facts.yml with provenance (who / when / run / question id). The questions file is the contract, not the channel.
 */
import type { Command } from "../Command.ts";
import { notImplemented } from "../notImplemented.ts";

export const answerCommand: Command = {
  name: "answer",
  summary: "Answer the open interview questions",
  usage: "tldrx answer [<question-id> <answer>]",
  subcommands: [],
  implemented: false,
  async run(argv: readonly string[]): Promise<number> {
    const sub = argv[0];
    const label = sub !== undefined && !sub.startsWith("-") ? `answer ${sub}` : "answer";
    return notImplemented(label);
  },
};
