/**
 * What `tldrx expert train` does when the expert is a ROLE.
 *
 * The training pipeline has one shape (`Training.ts`): a deterministic pre-pass
 * picks files, one sub-agent reads only those, the framework re-reads what it
 * wrote and derives evidence. Light mode's pre-pass is `selectFiles`, and its
 * whole input is a keyword grep over the expert's repos, seeded from the AREA ID
 * and its title (`selectFiles.ts:53-66,126-160`).
 *
 * For a stack or a domain expert that is exactly right: `checkout` names a folder
 * and the grep finds it. For a role expert it is not right at all — `architect`
 * is not a folder, and a file scores here because it contains the *word*. Two
 * outcomes, both bad, and they are what this module exists to prevent:
 *
 *  - nothing scores, `renderInlined` prints "_No file scored above zero for this
 *    area_" (`trainingPrompt.ts:320-322`), the sub-agent writes four `absent:`
 *    sections, the file validates, and NO evidence is derived — the level stays 0
 *    and the $0.25-floor spawn is spent for a file that says nothing;
 *  - something scores by coincidence, and the role expert's knowledge becomes a
 *    summary of whichever files happen to say "architect".
 *
 * So light mode is REFUSED for a role expert, before any money is committed, and
 * the refusal names the mode that does work. Full mode's second pre-pass is
 * `mineRuns`, which reads `tldrx-work/<run>/**\/{handoff,retro}.md` — the record
 * of how this workflow actually ran, which IS a role's domain. On a role expert
 * full mode drops the code pass entirely and spawns one sub-agent, not two.
 *
 * And when there is nothing to mine either, that is refused too. A run that
 * spawns an agent to write `- none [src: absent:tldrx-work]` costs real money to
 * learn what the pre-pass already knew.
 */
import { readExpertDomain } from "../experts/expertDomain.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import type { TrainingMode } from "./Training.ts";

/** Does this expert's own `expert.md` declare `kind: role`? */
export function isRoleExpertOnDisk(root: string, name: string): boolean {
  return readExpertDomain(root, name).kind === "role";
}

/**
 * The refusal lines for `--mode light` on a role expert, or `null` when the run
 * may proceed. The caller exits 1 with these; nothing is spawned and nothing is
 * written.
 */
export function lightModeRefusal(
  expert: string,
  area: string,
  mode: TrainingMode,
  isRole: boolean,
): readonly string[] | null {
  if (!isRole || mode !== "light") return null;
  return [
    `${expert} is a role expert (\`kind: role\`) — \`--mode light\` is refused, and nothing was spent.`,
    "  Light mode greps this workspace's repos for the area id and inlines what scores. A role's",
    `  subject is not a folder of code: \`${expert}\` speaks for a stage of this workflow — what it`,
    "  is accountable for, what it refuses, and what it hands to the next stage. A grep would rank",
    "  files because they contain the word, and the sub-agent would cite them as if that were",
    "  expertise.",
    "  Train it from the workflow instead:",
    `    tldrx expert train ${expert} --area ${area} --mode full`,
    `  Full mode mines \`${PROJECT_WORK_DIR}/<run>/**/{handoff,retro}.md\` — what this team's runs`,
    "  actually decided — and on a role expert it skips the code pass, so it is one sub-agent, not two.",
  ];
}

/**
 * The refusal for full mode on a role expert with no past run to mine.
 *
 * `null` when there is something to read. `minedFiles` is what the deterministic
 * pre-pass found, so this is a fact, not a guess.
 */
export function nothingToMineRefusal(
  expert: string,
  area: string,
  minedFiles: number,
  isRole: boolean,
): readonly string[] | null {
  if (!isRole || minedFiles > 0) return null;
  return [
    `${expert}/${area}: nothing to train from, and nothing was spent.`,
    `  A role expert learns from this workspace's own runs, and no \`${PROJECT_WORK_DIR}/<run>/\` holds a`,
    "  handoff or a retro this expert's repos match. Spawning a sub-agent now would buy one file",
    "  saying `- none [src: absent:tldrx-work]`, which earns no evidence and moves no level.",
    "  Finish a run first (`tldrx run new …`, then `tldrx next` through its stages); its handoffs",
    "  are what this expert is for. Until then, edit the body directly:",
    `    .tldrx/experts/${expert}/expert.md`,
  ];
}
