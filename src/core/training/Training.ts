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

/**
 * The three execution modes a training run has, exactly as `tldrx next` does:
 * `headless` spawns `claude -p` itself, `prepare` writes the prompt bundle and
 * stops, `commit` picks the validation path up from the host session's
 * `result.json`.
 *
 * It lives here rather than in `runTraining.ts` because the pre-start check
 * (`trainPreflight.ts`) has to branch on it, and `runTraining` imports THAT —
 * so the type has to sit below both. `runTraining.ts` re-exports it, so every
 * existing importer is unchanged.
 */
export type TrainingRunMode = "headless" | "prepare" | "commit";

export const TRAINING_MODES = ["light", "full"] as const;
export type TrainingMode = (typeof TRAINING_MODES)[number];

export function isTrainingMode(value: string): value is TrainingMode {
  return (TRAINING_MODES as readonly string[]).includes(value);
}

/** `--max-usd` for `--mode light` when the operator does not say. */
export const DEFAULT_TRAIN_USD = 2.0;

/**
 * `--max-usd` for `--mode full` when the operator does not say — $3.00, raised
 * from the $2.00 light mode uses (#96).
 *
 * **Why $2.00 was the wrong number for full mode.** Full mode spawns TWO
 * sub-agents and splits the ceiling between them (`runTraining.ts`), so $2.00
 * handed each pass $1.00. A real full training costs `MEASURED_FULL_TRAIN_USD`
 * END TO END on a mid model — $0.60-$0.80 per sub-agent — so $1.00 was 25% over
 * the measured worst case, and the one repair round a rejected knowledge file
 * earns comes out of that same share (`repairRound`). It was a ceiling with no
 * room in it, and on 2026-09-02 a run hit it at $1.31 and threw the work away.
 *
 * **Why $3.00 and not more.** $1.50 per sub-agent is ~2x the measured per-agent
 * mean, which leaves the repair round somewhere to live without turning the
 * default into a number nobody would type. It is deliberately NOT scaled up for
 * a premium model: `--max-budget-usd` is a stop after the turn, not a cap
 * (spec 2.6.1), so a bigger default cannot make a premium turn affordable — it
 * only raises what a single overshooting turn may lose. A premium tier in full
 * mode is refused up front instead (`trainPreflight.ts`).
 */
export const DEFAULT_FULL_TRAIN_USD = 3.0;

/**
 * What a full training run has actually COST, end to end, on a mid model.
 *
 * Measured, not assumed: `docs/audits/2026-08-29/experts-knowledge.md` section E
 * reads two lines straight off `training.jsonl` on `aparece-platform` — $1.21
 * (platform, 15k output tokens) and $1.29 (abstractions). The top of the band is
 * the $1.60 the owner reports for full runs in #96. Every number this framework
 * quotes about the cost of training comes from here, so the figure and its
 * provenance cannot drift apart.
 */
export const MEASURED_FULL_TRAIN_USD = { low: 1.21, high: 1.6 } as const;

/** The ceiling for a mode when `--max-usd` is absent. */
export function defaultTrainUsd(mode: TrainingMode): number {
  return mode === "full" ? DEFAULT_FULL_TRAIN_USD : DEFAULT_TRAIN_USD;
}

/**
 * The floor one sub-agent may be given, in dollars.
 *
 * Measured 2026-08-29 (spec §7) and reused from the Watch executor: a cold
 * `claude -p` pays 10–26k cache-creation tokens before its first reply, so a
 * ceiling under ~$0.25 fails as `error_max_budget_usd` before any work happens.
 * Refusing is honest; spawning something that cannot succeed is not.
 */
export const MIN_TRAIN_USD = 0.25;

/**
 * `--effort` for a training sub-agent when the operator names none.
 *
 * `[assumption]` — nothing measures the quality/cost curve of training at each
 * level yet. `medium` is taken because training is a READ-and-summarise job over
 * a pre-selected, capped file set (≤40 files / 96 KB): the hard thinking was done
 * by the deterministic pre-pass, so the sub-agent is not reasoning its way to the
 * evidence, it is citing what it was handed. Revisit when `training.jsonl` holds
 * runs at more than one level — which is why the level is now recorded on every
 * line of it.
 */
export const DEFAULT_TRAIN_EFFORT = "medium" as const;

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

export const PARTIAL_SUFFIX = ".partial";

/**
 * Where a training sub-agent actually writes: `<area>.md.partial`.
 *
 * A knowledge file is INLINED into every later prompt for its area, and the
 * inliner globs `knowledge/*.md` (excluding `*.rejected.md`). So a training run
 * killed halfway used to leave a torn, unvalidated file sitting at exactly the
 * name that gets inlined — half a knowledge file, read as if it were whole
 * (2026-08-29 audit). The sub-agent now writes the partial, and `expert train`
 * renames it onto the real name only after the file has VALIDATED. `.md.partial`
 * does not match `*.md`, so nothing half-written can ever be inlined.
 */
export function partialOf(rel: string): string {
  return `${rel}${PARTIAL_SUFFIX}`;
}

/** What one sub-agent cost and produced, for the log and the CLI report. */
export interface TrainingTask {
  readonly key: string;
  readonly model: string | null;
  readonly costUsd: number;
  readonly sessionId: string | null;
  readonly error: string | null;
  readonly outputs: readonly string[];
  readonly metered?: boolean;
}
