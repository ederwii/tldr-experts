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
import { BUILD_PHASE } from "../../build/plan.ts";
import type { StageSpec } from "../stageSpec.ts";
import type { NextMode } from "../runNext.ts";
import type { GateType } from "../../run/RunFile.ts";
import type { EventType } from "../../events/Event.ts";
import type { EffortLevel } from "../../schemas/stage.ts";
import { watchExecutor } from "./watch.ts";
import { buildExecutor } from "./build.ts";

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
  /**
   * `--effort` for every sub-agent this executor spawns: `--effort` if the
   * operator gave one, else the stage's `effort:`, else null (flag omitted).
   */
  readonly effort: EffortLevel | null;
  /** The stage's own ceiling, as scaled into `run.yml`. */
  readonly budgetUsd: number;
  /** `min(stage share, per_agent_max_usd, --max-usd)` — what one sub-agent may spend. */
  readonly maxBudgetUsd: number;
  readonly yolo: boolean;
  readonly at: string;
  /** `--keep-worktrees` — Build keeps its story worktrees after a story settles. */
  readonly keepWorktrees: boolean;
  /**
   * `--reuse-epic` — adopt an `epic/<slug>` branch this run did not create.
   *
   * Off by default: two runs stacking commits on one epic branch is how four
   * runs ended up sharing `epic/leaderboard` (2026-08-29 audit, §B), and the
   * fourth reused the third's live worktree. It has to be a deliberate word.
   */
  readonly reuseEpic: boolean;
  /**
   * `--parallel N` — how many stories of ONE wave may run at once (spec §5).
   *
   * 1 (the default) is the v1 path, story by story, unchanged. `waves.yml`
   * already guarantees a dependency is in an earlier wave, so a wave's stories
   * are independent by construction and the number is safe to raise.
   */
  readonly parallel: number;
  /**
   * `--discard-pending` — throw away the prepared bundle and start this stage's
   * cycle again.
   *
   * `runNext.preparedRefusal` handles it for every ordinary stage and returns
   * early for a phase with an executor, because an executor decides for itself
   * which of its per-story bundles is live. So the flag is passed down instead:
   * Build reads it as "bin the bundle, and re-derive the implicit plan if
   * nothing has been built off it yet".
   */
  readonly discardPending: boolean;
  /**
   * `min(stage budget × share, per_agent_max_usd, --max-usd)`, to the cent.
   * `agentCap(1)` is `maxBudgetUsd`; an executor that splits the stage between N
   * sub-agents asks for `agentCap(1 / N)` rather than dividing `maxBudgetUsd`,
   * which has already been capped once. (wave5)
   */
  readonly agentCap: (share?: number) => number;
  /**
   * Append one event to `events.jsonl` **while the stage is still running**.
   *
   * `ExecutorOutcome.tasks` is enough accounting for a stage that finishes in one
   * call. A Build stage does not: it can spend twenty minutes over a dozen
   * sub-agents, and an operator watching `run status` needs the per-story ledger
   * as it happens, not once at the end. `agent.result` is still emitted by
   * `runNext` from `tasks`, so an executor must NOT emit that one itself. (wave5)
   */
  readonly emit: (
    type: EventType,
    payload: Record<string, unknown>,
    costUsd?: number,
    actor?: string | null,
  ) => void;
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
  /**
   * Advisory lines for stderr — never a reason to stop, and kept off `lines` so
   * `--prepare`'s stdout stays a machine-readable instruction for the host
   * session. Today: a touched path the story's worktree cannot read.
   */
  readonly stderr?: readonly string[];
  /**
   * Epic branches this run now owns — cut by it, or adopted with `--reuse-epic`.
   *
   * `runNext` merges them into `run.yml`'s `build.epic_branch`, which is how the
   * NEXT invocation tells "I cut this" from "someone else did". The executor
   * cannot write run.yml itself: `runNext` saves its own store afterwards and
   * would overwrite anything written behind its back.
   */
  readonly epicBranches?: readonly string[];
  /** One line, for `stage.error`. Null when `ok`. */
  readonly error: string | null;
  /**
   * Force the gate type, whatever the stage file says. Build sets `approve`:
   * concept §9 ends the phase at "epic merges to main after integration tests +
   * human gate", and a stage file spelling `gate: auto` would otherwise let a run
   * walk past the one decision a person has to make. (wave5)
   */
  readonly gate?: GateType;
  /**
   * The executor did nothing, and the stage must NOT be marked failed — a
   * precondition the operator can fix (spec §3 exit 2, e.g. a dirty repo). The
   * stage goes back to `ready` and `lines` says what to do. (wave5)
   */
  readonly refused?: boolean;
}

export type StageExecutor = (ctx: ExecutorContext) => Promise<ExecutorOutcome>;

/**
 * Phase id -> executor. Keyed on the phase rather than the stage id so a team that
 * renames `watch` to `observe` in its own `.tldrx/stages/` keeps the behaviour:
 * the phase folder is what spec §1 fixes, the stage slug is not.
 */
export const EXECUTORS: ReadonlyMap<string, StageExecutor> = new Map<string, StageExecutor>([
  [BUILD_PHASE, buildExecutor],
  [WATCH_PHASE, watchExecutor],
]);

export function executorFor(phaseId: string): StageExecutor | null {
  return EXECUTORS.get(phaseId) ?? null;
}

export { watchExecutor } from "./watch.ts";
export { buildExecutor } from "./build.ts";
