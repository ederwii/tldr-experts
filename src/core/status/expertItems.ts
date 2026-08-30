/**
 * Item 4: experts a stage will load that have never been trained.
 *
 * An untrained expert is not inert. `tldrx init` seeds a folder with a level-0
 * competency and an empty `knowledge/`, the stage that names it loads it anyway,
 * and inside the prompt a stub expert reads exactly like a trained one — the only
 * difference is that it has nothing to say (`expertBundle.ts`, `untrainedNotes`).
 * `tldrx next` already whispers this on stderr for the stage it is about to run;
 * here it is asked once for the whole workspace, before any stage runs.
 *
 * Two rules come straight from the training code rather than being re-decided:
 *
 *   - "will a stage load it" is `stagesLoadingExperts`, the same derivation
 *     `tldrx expert list` prints, so this never nags about an expert nobody uses;
 *   - a ROLE expert trains in `--mode full` and only from past runs
 *     (`roleTraining.ts`). With no handoff on disk there is nothing to mine, so
 *     this reports the fact and offers NO command — a command the tool would
 *     refuse is worse than an honest "not yet".
 */
import { evidenceCount, loadExperts, stagesLoadingExperts } from "../experts/index.ts";
import { readExpertDomain } from "../experts/expertDomain.ts";
import { hasMinableFiles } from "../training/mineRuns.ts";
import type { ExpertRecord } from "../experts/ExpertRecord.ts";
import type { PendingItem } from "./PendingItem.ts";

/**
 * `[assumption]` — a fresh `tldrx init` seeds a dozen experts and every one of
 * them starts at zero, so an uncapped list would BE the report. Five, then a
 * pointer at `tldrx expert list`, which is the screen for the whole set.
 */
export const MAX_EXPERT_ITEMS = 5;

export function expertItems(root: string): readonly PendingItem[] {
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
  const items = untrained
    .slice(0, MAX_EXPERT_ITEMS)
    .map((expert) => expertItem(root, expert, loads.get(expert.name) ?? [], minable));

  if (untrained.length > MAX_EXPERT_ITEMS) {
    const rest = untrained.slice(MAX_EXPERT_ITEMS).map((expert) => expert.name);
    items.push({
      kind: "expert",
      summary: `${String(rest.length)} more expert(s) a stage will load have no evidence either`,
      command: "tldrx expert list",
      details: [rest.join(", ")],
    });
  }
  return items;
}

function expertItem(
  root: string,
  expert: ExpertRecord,
  loads: readonly { readonly stage: string }[],
  minable: boolean,
): PendingItem {
  const stages = loads.map((load) => load.stage);
  const where = `it is loaded by ${stages.join(", ")}`;
  const area = expert.areas[0];
  const isRole = readExpertDomain(root, expert.name).kind === "role";

  if (area === undefined) {
    return {
      kind: "expert",
      summary: `expert \`${expert.name}\` has no competency areas, so nothing can be trained into it`,
      command: "",
      details: [where, "give it an area in `.tldrx/experts/" + expert.name + "/competencies.yml` first"],
    };
  }

  const details = [
    where,
    `area: ${area.id} — ${area.title}`,
    "an untrained expert reads like a trained one inside the prompt; it just has nothing to say",
  ];

  if (isRole && !minable) {
    details.push(
      `\`${expert.name}\` is a role expert: it trains from past runs' handoffs, and this workspace has none yet`,
    );
    return {
      kind: "expert",
      summary: `expert \`${expert.name}\` has no evidence — nothing to mine yet, so it has to wait for a finished stage`,
      command: "",
      details,
    };
  }

  const mode = isRole ? "full" : "light";
  if (isRole) details.push("role experts train from `handoff.md`/`retro.md`, never from a grep of the code");
  return {
    kind: "expert",
    summary: `expert \`${expert.name}\` will be loaded by a stage but has no evidence behind it yet`,
    command: `tldrx expert train ${expert.name} --area ${area.id} --mode ${mode} --print-prompt`,
    details,
  };
}
