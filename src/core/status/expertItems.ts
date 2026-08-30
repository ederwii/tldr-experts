/**
 * The advice line: experts a stage will load that have never been trained.
 *
 * An untrained expert is not inert. `tldrx init` seeds a folder with a level-0
 * competency and an empty `knowledge/`, the stage that names it loads it anyway,
 * and inside the prompt a stub expert reads exactly like a trained one — the only
 * difference is that it has nothing to say (`expertBundle.ts`, `untrainedNotes`).
 * So it is worth saying once, for the whole workspace, before any stage runs.
 *
 * ONE item, and NOT a blocker. A fresh `tldrx init` seeds a dozen experts at
 * level 0, and the first `tldrx status` used to open with "7 things waiting on
 * you" of which five were experts and only one was actionable — the same five
 * lines, five times, under a headline that made a new workspace look broken. An
 * untrained expert degrades a stage's output; it does not stop one. It belongs
 * beside the blockers, not among them, and it belongs on one line.
 *
 * Two rules come straight from the training code rather than being re-decided:
 *
 *   - "will a stage load it" is `stagesLoadingExperts`, the same derivation
 *     `tldrx expert list` prints, so this never nags about an expert nobody uses;
 *   - a ROLE expert trains in `--mode full` and only from past runs
 *     (`roleTraining.ts`). With no handoff on disk there is nothing to mine, so
 *     it is COUNTED and named as waiting, never offered a command — a command the
 *     tool would refuse is worse than an honest "not yet".
 */
import { evidenceCount, loadExperts, stagesLoadingExperts } from "../experts/index.ts";
import { readExpertDomain } from "../experts/expertDomain.ts";
import { hasMinableFiles } from "../training/mineRuns.ts";
import type { ExpertRecord } from "../experts/ExpertRecord.ts";
import type { PendingItem } from "./PendingItem.ts";

/**
 * How many trainable names the one line carries before it stops listing them.
 * `tldrx expert list` is the screen for the whole set; this is a nudge, and a
 * nudge that prints twelve names is a report nobody reads.
 */
export const MAX_EXPERT_NAMES = 5;

/** At most one item, and never a blocker. Empty when every loaded expert has evidence. */
export function expertAdvice(root: string): readonly PendingItem[] {
  const loads = stagesLoadingExperts(root);
  const untrained = loadExperts(root)
    .filter((expert) => expert.error === null)
    .filter((expert) => (loads.get(expert.name) ?? []).length > 0)
    .filter((expert) => evidenceCount(expert) === 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (untrained.length === 0) return [];

  // Asked once, not once per expert: it is a walk of `tldrx-work/`, and the
  // answer is the same for every role expert in the workspace.
  const minable = hasMinableFiles(root);
  const trainable: string[] = [];
  const waiting: string[] = [];
  const arealess: string[] = [];
  for (const expert of untrained) {
    if (expert.areas[0] === undefined) arealess.push(expert.name);
    else if (isRole(root, expert) && !minable) waiting.push(expert.name);
    else trainable.push(expert.name);
  }

  const details: string[] = [];
  if (trainable.length > 0) {
    const shown = trainable.slice(0, MAX_EXPERT_NAMES);
    const more = trainable.length - shown.length;
    details.push(
      `train the ones a stage will load: ${shown.join(", ")}`
      + (more === 0 ? "" : ` (and ${String(more)} more)`),
    );
    const first = untrained.find((expert) => expert.name === shown[0]);
    const area = first?.areas[0];
    if (first !== undefined && area !== undefined) {
      const mode = isRole(root, first) ? "full" : "light";
      details.push(`e.g. tldrx expert train ${first.name} --area ${area.id} --mode ${mode} --print-prompt`);
    }
  }
  if (waiting.length > 0) {
    details.push(
      waiting.length === 1
        ? `${waiting[0] ?? ""} is a role expert: it trains from past runs' handoffs, `
          + "and this workspace has none yet"
        : `${waiting.join(", ")} are role experts: they train from past runs' handoffs, `
          + "and this workspace has none yet",
    );
  }
  if (arealess.length > 0) {
    details.push(
      `${arealess.join(", ")} ${arealess.length === 1 ? "has" : "have"} no competency areas, `
      + "so nothing can be trained into them yet",
    );
  }
  details.push("an untrained expert reads like a trained one inside the prompt; it just has nothing to say");

  return [{
    kind: "expert",
    summary: `${String(untrained.length)} expert(s) a stage will load have no evidence yet`,
    command: "tldrx expert list",
    details,
  }];
}

function isRole(root: string, expert: ExpertRecord): boolean {
  return readExpertDomain(root, expert.name).kind === "role";
}
