/**
 * `tldrx-work/<run>/retro.md` — three sections, exactly as concept §13 names them:
 * what to remember, how to work differently, what stage to add or change.
 *
 * Every practice bullet ends in a source token pointing at the events.jsonl line
 * that justifies it. A retro that cannot cite the log is a retrospective opinion,
 * and this file does not write those.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factsFromRun, type RunFact } from "./factsFromRun.ts";
import { practiceProposals, proposedStages } from "./proposals.ts";
import { renderProposal, type Proposal } from "./Proposal.ts";
import { BUILD_RETRO_SECTION, extractBuildSection, RETRO_FILE } from "../build/retroLog.ts";
import type { LoadedRun } from "../replay/index.ts";

export { RETRO_FILE };
export const NO_STAGES_PROPOSED = "none proposed";

export const RETRO_SECTIONS = ["Facts to remember", "Practice proposals", "Proposed stages"] as const;

export interface RetroReport {
  readonly markdown: string;
  readonly facts: readonly RunFact[];
  readonly practices: readonly Proposal[];
  readonly stages: readonly Proposal[];
}

export function buildRetro(loaded: LoadedRun): RetroReport {
  const facts = factsFromRun(loaded);
  const practices = practiceProposals(loaded);
  const stages = proposedStages(loaded);
  // The Build executor appends `## Build feedback` to this same file as each
  // story settles (`build/retroLog.ts`). This renderer writes the document
  // whole, so without carrying that section it would silently delete the one
  // part of the retro nothing else can reconstruct — the reviewer verdicts and
  // failed DoD commands are gone from the tree by the time anyone runs `retro`.
  const carried = carryBuildSection(loaded.dir);

  const lines: string[] = [
    `# Retro — ${loaded.id}`,
    "",
    `${loaded.run.title === "" ? "" : `${loaded.run.title} · `}scope \`${loaded.run.scope || "?"}\``
      + ` · status ${loaded.run.status || "unknown"}`,
    "",
    "Written by `tldrx retro` from `run.yml` and `events.jsonl`. Deterministic: no model ran.",
    "",
    `## ${RETRO_SECTIONS[0]}`,
    "",
    ...(facts.length === 0
      ? ["No facts were recorded during this run."]
      : facts.map((fact) => `- ${fact.id} — ${fact.text}${factState(fact)} ${fact.src}`)),
    "",
    `## ${RETRO_SECTIONS[1]}`,
    "",
    ...(practices.length === 0
      ? ["Nothing in the log met a proposal heuristic — no rejections, overruns, question-cap breaches, failed checks or budget events."]
      : practices.map((proposal) => renderProposal(loaded.id, proposal))),
    "",
    `## ${RETRO_SECTIONS[2]}`,
    "",
    ...(stages.length === 0
      ? [NO_STAGES_PROPOSED]
      : stages.map((proposal) => renderProposal(loaded.id, proposal))),
    "",
    ...(carried === "" ? [] : [`## ${BUILD_RETRO_SECTION}`, "", carried, ""]),
  ];

  return { markdown: lines.join("\n"), facts, practices, stages };
}

/** Whatever the Build executor has already appended to this run's `retro.md`. */
function carryBuildSection(dir: string): string {
  const path = join(dir, RETRO_FILE);
  if (!existsSync(path)) return "";
  try {
    return extractBuildSection(readFileSync(path, "utf8"));
  } catch {
    return "";
  }
}

/**
 * ` (retired)` / ` (superseded by F019)` / nothing.
 *
 * The retro is the one place a fact that is no longer current still belongs on
 * the page — it is what this run decided at the time. It is labelled so a reader
 * never has to guess which of two rows the workspace still believes.
 */
function factState(fact: RunFact): string {
  if (fact.supersededBy !== null) return ` (superseded by ${fact.supersededBy})`;
  return fact.retired ? " (retired)" : "";
}
