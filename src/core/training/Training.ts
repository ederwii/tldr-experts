/**
 * `tldrx expert train` — the shape of a training run (concept §6, spec §2.6).
 *
 * Training is the only thing in this framework that RAISES a competency level, so
 * the whole module is built around one rule: a level moves because a file was
 * read and cited, never because an agent said it learned something. Every step
 * below is arranged to keep that true.
 *
 *   1. a DETERMINISTIC pre-pass picks the candidate files (`selectFiles.ts`) —
 *      no model is asked what to read, because the map and a grep already know;
 *   2. ONE sub-agent reads only what was inlined and writes one knowledge file;
 *   3. the framework re-reads that file off disk, validates every `[src: …]`
 *      with the SHARED handoff parser, and derives the evidence itself
 *      (`knowledgeFile.ts`);
 *   4. `competencies.yml` is rewritten with the new evidence and every level
 *      recomputed by the §2.6 formula (`competenciesWrite.ts`).
 *
 * A knowledge file that does not validate is rejected whole: nothing is written,
 * the status does not change, and the money that was spent is still recorded.
 * Half-credit for an unsourced claim is exactly the failure mode training exists
 * to prevent.
 */

export const TRAINING_MODES = ["light", "full"] as const;
export type TrainingMode = (typeof TRAINING_MODES)[number];

export function isTrainingMode(value: string): value is TrainingMode {
  return (TRAINING_MODES as readonly string[]).includes(value);
}

/** `--max-usd` when the operator does not say. */
export const DEFAULT_TRAIN_USD = 2.0;

/**
 * The floor one sub-agent may be given, in dollars.
 *
 * Measured 2026-08-29 (spec §7) and reused from the Watch executor: a cold
 * `claude -p` pays 10–26k cache-creation tokens before its first reply, so a
 * ceiling under ~$0.25 fails as `error_max_budget_usd` before any work happens.
 * Refusing is honest; spawning something that cannot succeed is not.
 */
export const MIN_TRAIN_USD = 0.25;

/** How many candidate files may be inlined into one training prompt. */
export const MAX_INLINE_FILES = 40;
/** How many bytes of those files may be inlined. */
export const MAX_INLINE_BYTES = 96 * 1024;
/** Per-file cap, so one 400 KB generated file cannot eat the whole budget. */
export const MAX_FILE_BYTES = 24 * 1024;

/** Sub-agent keys — one bundle, one prompt and one result per key. */
export const CODE_TASK = "code";
export const RUNS_TASK = "runs";

export const KNOWLEDGE_DIRNAME = "knowledge";
export const TRAINING_LOG_FILE = "training.jsonl";

export function knowledgeRelPath(area: string): string {
  return `${KNOWLEDGE_DIRNAME}/${area}.md`;
}

export function fromRunsRelPath(area: string): string {
  return `${KNOWLEDGE_DIRNAME}/from-runs-${area}.md`;
}

/** What one sub-agent cost and produced, for the log and the CLI report. */
export interface TrainingTask {
  readonly key: string;
  readonly model: string | null;
  readonly costUsd: number;
  readonly sessionId: string | null;
  readonly error: string | null;
  readonly outputs: readonly string[];
}
