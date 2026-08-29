/**
 * `tldrx-work/<run>/retro.md` — three sections, exactly as concept §13 names them:
 * what to remember, how to work differently, what stage to add or change.
 *
 * Every practice bullet ends in a source token pointing at the events.jsonl line
 * that justifies it. A retro that cannot cite the log is a retrospective opinion,
 * and this file does not write those.
 */
import { factsFromRun, type RunFact } from "./factsFromRun.ts";
import { practiceProposals, proposedStages } from "./proposals.ts";
import { renderProposal, type Proposal } from "./Proposal.ts";
import type { LoadedRun } from "../replay/index.ts";

export const RETRO_FILE = "retro.md";
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
      : facts.map((fact) => `- ${fact.id} — ${fact.text}${fact.retired ? " (retired)" : ""} ${fact.src}`)),
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
  ];

  return { markdown: lines.join("\n"), facts, practices, stages };
}
