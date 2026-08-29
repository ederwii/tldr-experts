/**
 * How much of a repo `init` actually established.
 *
 * `low` is not an insult, it is a routing decision: spec §2.1 says a `low` repo
 * forces an interview question, so the rule has to be mechanical.
 */
import { COMMAND_SLOTS, type Confidence, type RepoCommands } from "./types.ts";

export function scoreConfidence(commands: RepoCommands, manifestCount: number): Confidence {
  const known = COMMAND_SLOTS.filter((slot) => commands[slot] !== null).length;
  if (manifestCount === 0 || known === 0) return "low";
  if (commands.build !== null && commands.test !== null) return "high";
  return "medium";
}
