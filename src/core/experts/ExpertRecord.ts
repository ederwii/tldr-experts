/** What `expert list` and the dashboard read out of `.tldrx/experts/<name>/`. */
import type { CompetencyEvidence } from "../init/competencyLevel.ts";

export const EXPERT_STATUSES = ["created", "training", "in-use", "inactive"] as const;
export type ExpertStatus = (typeof EXPERT_STATUSES)[number];

export interface AreaRecord {
  readonly id: string;
  readonly title: string;
  /** The number that was on disk. Never trusted — `level` is what is shown. */
  readonly storedLevel: number | null;
  /** Recomputed from `evidence` by the §2.6 formula, at read time. */
  readonly level: number;
  readonly trainPrompt: string;
  readonly evidence: readonly CompetencyEvidence[];
  /** `YYYY-MM-DD` of the newest evidence item, or null when there is none. */
  readonly newestEvidence: string | null;
}

export interface ExpertRecord {
  readonly name: string;
  readonly dir: string;
  readonly status: string;
  readonly lastTrained: string | null;
  readonly areas: readonly AreaRecord[];
  /** Areas whose stored level disagrees with the computed one. */
  readonly drifted: readonly AreaRecord[];
  /** Set when competencies.yml is missing or unreadable. */
  readonly error: string | null;
}
