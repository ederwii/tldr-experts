/**
 * `.tldrx/experts/<name>/competencies.yml`, shaped by spec §2.6.
 *
 * Seeded experts have `status: created` and zero evidence, so every level is 0.
 * That is the point: an expert starts by admitting it knows nothing about this
 * codebase, and `tldrx expert train` is what changes the number.
 */
import { competencyLevel, type CompetencyEvidence } from "./competencyLevel.ts";

export interface CompetencyArea {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly train_prompt: string;
  readonly evidence: readonly CompetencyEvidence[];
}

export interface CompetenciesDocument {
  readonly version: 1;
  readonly expert: string;
  readonly status: string;
  readonly last_trained: string | null;
  readonly areas: readonly CompetencyArea[];
}

export interface AreaSeed {
  readonly id: string;
  readonly title: string;
  readonly evidence?: readonly CompetencyEvidence[];
}

export function buildCompetenciesDocument(
  expert: string,
  areas: readonly AreaSeed[],
  now: Date = new Date(),
): CompetenciesDocument {
  return {
    version: 1,
    expert,
    status: "created",
    last_trained: null,
    areas: areas.map((area) => {
      const evidence = area.evidence ?? [];
      return {
        id: area.id,
        title: area.title,
        level: competencyLevel(evidence, now),
        train_prompt: `tldrx expert train ${expert} --area ${area.id} --mode light`,
        evidence,
      };
    }),
  };
}
