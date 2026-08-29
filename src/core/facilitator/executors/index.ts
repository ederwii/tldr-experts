/**
 * Stage executors: the part of `tldrx next` a phase is allowed to replace.
 *
 * Most stages are one sub-agent producing one set of declared files, and
 * `runNext.ts` does that inline. Two phases are not shaped like that. Build runs
 * one agent per story, in a worktree each. Watch runs one agent per shipped
 * FEATURE, and cannot name its outputs in `stage.yml` because how many there are
 * is a fact about the run, not about the stage. Both need the step between
 * "prompt assembled" and "outputs validated" to be theirs.
 *
 * So: a map from **phase id** to executor. A phase with no entry keeps the
 * default single-agent path. Everything either side of the executor — the lock,
 * the cursor, the budget gate, `run.yml`, the checks, the gate — stays in
 * `runNext.ts`, because an executor that could move the cursor would be a second
 * facilitator.
 *
 * `[assumption]` — this registry and its two types are wave 6A's reading of a
 * seam wave 5 (`04-build`) owns the other half of. If the shapes disagree at merge
 * time, THIS file is the one to change: `watch.ts` only needs `ExecutorContext` to
 * carry the run, the stage spec, the mode and the money.
 */
import { WATCH_PHASE } from "../../watch/Watcher.ts";
import type { StageSpec } from "../stageSpec.ts";
import type { NextMode } from "../runNext.ts";
import { watchExecutor } from "./watch.ts";

/** One sub-agent's worth of accounting, for `run.yml`'s `tasks[]`. */
export interface ExecutorTask {
  /** Stable within the stage — the feature or story the task was for. */
  readonly key: string;
  readonly model: string | null;
  readonly costUsd: number;
  readonly sessionId: string | null;
  readonly error: string | null;
  /** Run-relative paths the task wrote. */
  readonly outputs: readonly string[];
}

export interface ExecutorContext {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  readonly phaseId: string;
  readonly stageId: string;
  readonly spec: StageSpec;
  /** `run.repos` — the repos this run is scoped to. */
  readonly repos: readonly string[];
  readonly mode: NextMode;
  /** `--model`, when the operator overrode the stage pin. */
  readonly model: string | null;
  /** The stage's own ceiling, as scaled into `run.yml`. */
  readonly budgetUsd: number;
  /** `min(stage share, per_agent_max_usd, --max-usd)` — what one sub-agent may spend. */
  readonly maxBudgetUsd: number;
  readonly yolo: boolean;
  readonly at: string;
}

export interface ExecutorOutcome {
  readonly ok: boolean;
  /**
   * True when the executor handed work to the host session (`--prepare`) and is
   * waiting for `--commit`. The caller must NOT validate outputs or advance.
   */
  readonly awaiting: boolean;
  readonly tasks: readonly ExecutorTask[];
  readonly costUsd: number;
  /** Run-relative paths written, for the `stage.done` event. */
  readonly outputs: readonly string[];
  /** Printed by `tldrx next`, in order. */
  readonly lines: readonly string[];
  /** One line, for `stage.error`. Null when `ok`. */
  readonly error: string | null;
}

export type StageExecutor = (ctx: ExecutorContext) => Promise<ExecutorOutcome>;

/**
 * Phase id -> executor. Keyed on the phase rather than the stage id so a team that
 * renames `watch` to `observe` in its own `.tldrx/stages/` keeps the behaviour:
 * the phase folder is what spec §1 fixes, the stage slug is not.
 */
export const EXECUTORS: ReadonlyMap<string, StageExecutor> = new Map<string, StageExecutor>([
  // ["04-build", buildExecutor],  <- wave5/build's line lands here on merge.
  [WATCH_PHASE, watchExecutor],
]);

export function executorFor(phaseId: string): StageExecutor | null {
  return EXECUTORS.get(phaseId) ?? null;
}

export { watchExecutor } from "./watch.ts";
