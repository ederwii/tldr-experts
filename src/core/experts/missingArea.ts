/**
 * `<expert> has no area '<id>'` — and then the remedy, which the framework knew
 * and never said (gh #94).
 *
 * What happened live (2026-09-02): `tldrx expert create discoverer` wrote a folder
 * with zero areas, and `tldrx expert train discoverer --area discoverer` answered
 * `discoverer has no area 'discoverer' (areas: none)` and stopped. Nothing in that
 * sentence — or in any flag, subcommand or doc — said that an area is a block in
 * `competencies.yml` that a human may add by hand. The owner found the sanctioned
 * path by reading the source. Files-as-state is the design; undiscoverable state
 * is the bug.
 *
 * So the refusal names the FILE and prints the block, indented to be pasted. The
 * `train_prompt` line is the same string `buildCompetenciesDocument` writes
 * (`init/competenciesDocument.ts`), so a hand-added area and a seeded one are the
 * same shape.
 */
import { join } from "node:path";
import { COMPETENCIES_FILE, expertDir } from "./loadExperts.ts";

export interface MissingAreaInput {
  readonly root: string;
  readonly expert: string;
  readonly areaId: string;
  /** The area ids this expert does have, in file order. */
  readonly known: readonly string[];
  /** `--mode` the printed `train_prompt` should name. */
  readonly mode?: "light" | "full";
}

/**
 * The refusal, one string per line, unindented at the top level — callers that
 * prefix continuation lines (`cli/commands/expert.ts`) keep the relative
 * indentation of the YAML block intact.
 */
export function missingAreaRefusal(input: MissingAreaInput): readonly string[] {
  const known = input.known.length === 0 ? "none" : input.known.join(", ");
  const path = join(expertDir(input.root, input.expert), COMPETENCIES_FILE);
  const mode = input.mode ?? "light";
  return [
    `${input.expert} has no area '${input.areaId}' (areas: ${known})`,
    `an area is a block under \`areas:\` in ${path} — add it there:`,
    `  - id: ${input.areaId}`,
    "    title: <the words light mode greps the code for>",
    "    level: 0",
    `    train_prompt: tldrx expert train ${input.expert} --area ${input.areaId} --mode ${mode}`,
    "    evidence: []",
    "and `tldrx expert create <name> --area <id> [--title <text>]` writes that block"
    + " for a NEW expert.",
  ];
}
