/**
 * `tldrx-work/<run>/run.yml` (spec §2.2) — the execution path and the only resume
 * point.
 *
 * Note for archaeologists: `src/core/schemas/run.ts` validates the *draft*
 * skeleton shape (`schema_version`, `run_id`, flat `phases[]`) that shipped before
 * the spec settled. This file is the spec §2.2 shape — `version: 1`, `run`,
 * `cursor`, phases-of-stages-of-tasks — which is what `run new` writes, the
 * fixtures carry, and the hooks already read. Do not merge the two: the old one
 * still guards the old templates.
 */
import {
  asDocument, isRecord, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  result, type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";
import { validateGatesPolicy, type GatesPolicy } from "./gatePolicy.ts";

/** One enum, all three levels (spec §2.2). */
export const STAGE_STATUSES = [
  "pending", "ready", "running", "awaiting_answer", "awaiting_gate", "blocked",
  "done", "failed", "skipped", "cancelled",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const TERMINAL_STATUSES: readonly StageStatus[] = ["done", "failed", "skipped", "cancelled"];

export const GATE_TYPES = ["approve", "checks", "auto"] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const GATE_STATUSES = ["pending", "approved", "rejected", "n-a"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const RUN_ID_RE = /^\d{6}-[a-z0-9-]{1,40}$/;
export const PHASE_ID_RE = /^0[1-5]-[a-z]+$/;

/** Spec §2.2 caps. */
export const MAX_PHASES = 5;
export const MAX_STAGES = 40;
export const MAX_TASKS = 200;

export interface RunGate {
  readonly type: GateType;
  readonly status: GateStatus;
  readonly by: string | null;
  readonly at: string | null;
  readonly note: string;
}

export interface RunTask {
  readonly id: string;
  readonly status: StageStatus;
  readonly expert: string | null;
  readonly model: string | null;
  /**
   * What the turn cost — or `null` when nobody could say.
   *
   * `null` is the in-session case (spec §5, `--commit`): the sub-agent ran inside
   * the host's own session, its usage was billed to that session, and unless the
   * host DECLARES a number with `--cost-usd` there is none to record. That used to
   * be written as `0`, which is a measurement, and a false one — a run's ledger
   * added up to `$0.00 spent` after real money had been spent (2026-08-29 audit,
   * §A). `null` says "unmetered"; every sum treats it as contributing nothing,
   * which is the only honest arithmetic, and every REPORT says so out loud.
   */
  readonly cost_usd: number | null;
  /**
   * False when this task's cost is unmetered. ADDITIVE and optional: absent means
   * metered, which is every task written before this existed and every headless
   * spawn, where the envelope's `total_cost_usd` is a real reconciled number.
   */
  readonly metered?: boolean;
  readonly error: string | null;
  readonly session_id: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly outputs: readonly string[];
  /** Tokens the host declared with `--tokens`, when it knew them. */
  readonly tokens?: number;
}

export interface RunStage {
  readonly id: string;
  readonly status: StageStatus;
  readonly expert: string | null;
  readonly model: string | null;
  readonly budget_usd: number;
  readonly cost_usd: number;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly gate: RunGate;
  readonly tasks: readonly RunTask[];
  /**
   * True when an EARLIER stage's gate was revoked (`tldrx reject --stage`) after
   * this one had already run. ADDITIVE and optional: absent on every run written
   * before revocation existed, and absent again the moment the stage re-runs.
   *
   * The stage's outputs are deliberately left on disk — money was spent producing
   * them and they are often still 90% right — but they were derived from a
   * decision that has since been withdrawn, and nothing may quietly treat them as
   * current. `run status` says so; `next` re-runs the stage and clears the flag.
   */
  readonly stale?: boolean;
}

export interface RunPhase {
  readonly id: string;
  readonly status: StageStatus;
  readonly stages: readonly RunStage[];
}

export interface RunCursor {
  readonly phase: string;
  readonly stage: string;
  readonly task: string | null;
}

export interface RunBudgetMirror {
  readonly ceiling_usd: number;
  readonly spent_usd: number;
  readonly per_agent_max_usd: number;
}

/**
 * Where this run came from, when `tldrx seed apply` created it (spec §6.2).
 *
 * Optional and additive: a run created by `run new` has no `triage:` key at all,
 * every reader that never heard of it is unaffected, and `run status` does not
 * mention it. It exists so a run can say which split proposed it and which of its
 * siblings were meant to land first — the one piece of the triage that would
 * otherwise live only in a file nobody opens again.
 */
export interface RunTriage {
  /** Workspace-relative path of the `split.yml` this run came out of. */
  readonly split: string;
  /** Slugs of the sibling runs this one was proposed to follow. */
  readonly depends_on: readonly string[];
}

export interface RunFile {
  readonly version: number;
  readonly run: string;
  readonly title: string;
  readonly scope: string;
  readonly workflow: string;
  readonly repos: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: StageStatus;
  readonly cursor: RunCursor;
  readonly budget: RunBudgetMirror;
  /** Present only on a run created by `tldrx seed apply`. */
  readonly triage?: RunTriage;
  /**
   * Who approves each stage's gate (spec §2.2). ADDITIVE and optional: a run.yml
   * written before this key existed has no policy, and `gatePolicyFor` reads that
   * absence as `human` for every stage — exactly the behaviour it had.
   */
  readonly gates_policy?: GatesPolicy;
  readonly phases: readonly RunPhase[];
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Finished for good — nothing an operator can do will move it.
 *
 * `failed` is terminal for the ATTEMPT but not for the run: spec §5's failure
 * path gives the operator `next` (retry) and `reject --note`, so a failed run is
 * still the live run and must stay findable. Everything that asks "is this run
 * over?" asks this, not `isTerminal`.
 */
export function isFinished(status: string): boolean {
  return status === "done" || status === "cancelled";
}

/** Every stage in execution order, paired with its phase. */
export function flatten(run: RunFile): readonly { phase: RunPhase; stage: RunStage }[] {
  const out: { phase: RunPhase; stage: RunStage }[] = [];
  for (const phase of run.phases) for (const stage of phase.stages) out.push({ phase, stage });
  return out;
}

export function stageAt(run: RunFile, cursor: RunCursor): { phase: RunPhase; stage: RunStage } | null {
  return flatten(run).find((e) => e.phase.id === cursor.phase && e.stage.id === cursor.stage) ?? null;
}

/**
 * Spec §2.2: "Run status = status of the stage at cursor, or done when every phase
 * is terminal." A failed stage is checked FIRST, because a run holding one is not
 * done — calling it done hides the failure and makes `next` refuse the retry the
 * spec's failure path promises.
 */
export function deriveRunStatus(run: RunFile): StageStatus {
  const all = flatten(run);
  if (all.some((e) => e.stage.status === "failed")) return "failed";
  if (all.length > 0 && all.every((e) => isTerminal(e.stage.status))) return "done";
  return stageAt(run, run.cursor)?.stage.status ?? "pending";
}

/** A phase wears a failure first, is done when every stage is terminal, else its first live stage's status. */
export function derivePhaseStatus(phase: RunPhase): StageStatus {
  if (phase.stages.length === 0) return "skipped";
  if (phase.stages.some((s) => s.status === "failed")) return "failed";
  if (phase.stages.every((s) => isTerminal(s.status))) return "done";
  const live = phase.stages.find((s) => !isTerminal(s.status));
  return live?.status ?? "pending";
}

export function validateRunFile(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(
    doc,
    ["version", "run", "title", "scope", "workflow", "repos", "created_at", "updated_at", "status", "cursor", "budget", "phases"],
    "",
    issues,
  );
  if (doc.version !== undefined && doc.version !== 1) {
    issues.push({ path: "version", message: `unknown schema version ${String(doc.version)} (expected 1)` });
  }
  if (typeof doc.run !== "string" || !RUN_ID_RE.test(doc.run)) {
    issues.push({ path: "run", message: "run id must match ^\\d{6}-[a-z0-9-]{1,40}$" });
  }
  requireString(doc.title, "title", issues);
  requireString(doc.scope, "scope", issues);
  requireString(doc.workflow, "workflow", issues);
  requireString(doc.created_at, "created_at", issues);
  requireString(doc.updated_at, "updated_at", issues);
  requireEnum(doc.status, STAGE_STATUSES, "status", issues);
  requireArray(doc.repos, "repos", issues);

  let cursor: RunCursor | null = null;
  if (isRecord(doc.cursor)) {
    requireKeys(doc.cursor, ["phase", "stage", "task"], "cursor", issues);
    cursor = {
      phase: String(doc.cursor.phase ?? ""),
      stage: String(doc.cursor.stage ?? ""),
      task: typeof doc.cursor.task === "string" ? doc.cursor.task : null,
    };
  } else if (doc.cursor !== undefined) {
    issues.push({ path: "cursor", message: "expected a mapping" });
  }

  if (isRecord(doc.budget)) {
    requireKeys(doc.budget, ["ceiling_usd", "spent_usd", "per_agent_max_usd"], "budget", issues);
    requireNumber(doc.budget.ceiling_usd, "budget.ceiling_usd", issues);
    requireNumber(doc.budget.spent_usd, "budget.spent_usd", issues);
    requireNumber(doc.budget.per_agent_max_usd, "budget.per_agent_max_usd", issues);
  } else if (doc.budget !== undefined) {
    issues.push({ path: "budget", message: "expected a mapping" });
  }

  // Optional, additive (§6.2): absent on every run `run new` creates. Present it
  // must still be well formed — a half-written provenance block is worse than none.
  if (doc.triage !== undefined) {
    if (isRecord(doc.triage)) {
      requireKeys(doc.triage, ["split", "depends_on"], "triage", issues);
      requireString(doc.triage.split, "triage.split", issues);
      if (requireArray(doc.triage.depends_on, "triage.depends_on", issues)) {
        (doc.triage.depends_on as unknown[]).forEach((slug, i) => {
          requireString(slug, `triage.depends_on[${i}]`, issues);
        });
      }
    } else {
      issues.push({ path: "triage", message: "expected a mapping" });
    }
  }

  if (!requireArray(doc.phases, "phases", issues)) return result(issues);
  const phases = doc.phases as unknown[];
  if (phases.length > MAX_PHASES) {
    issues.push({ path: "phases", message: `${phases.length} phases exceeds the ${MAX_PHASES} cap` });
  }

  const declaredStageIds: string[] = [];
  for (const phase of phases) {
    if (!isRecord(phase) || !Array.isArray(phase.stages)) continue;
    for (const stage of phase.stages as unknown[]) {
      if (isRecord(stage) && typeof stage.id === "string") declaredStageIds.push(stage.id);
    }
  }
  validateGatesPolicy(doc.gates_policy, declaredStageIds, issues);

  let stageCount = 0;
  let taskCount = 0;
  let running = 0;
  let cursorResolves = false;
  let spentFromTasks = 0;
  const phaseIds = new Set<string>();

  phases.forEach((phase, i) => {
    const base = `phases[${i}]`;
    if (!isRecord(phase)) {
      issues.push({ path: base, message: "expected a mapping" });
      return;
    }
    requireKeys(phase, ["id", "status", "stages"], base, issues);
    const phaseId = typeof phase.id === "string" ? phase.id : "";
    if (!PHASE_ID_RE.test(phaseId)) {
      issues.push({ path: `${base}.id`, message: "phase id must match ^0[1-5]-[a-z]+$" });
    }
    if (phaseIds.has(phaseId)) issues.push({ path: `${base}.id`, message: `duplicate phase id ${phaseId}` });
    phaseIds.add(phaseId);
    requireEnum(phase.status, STAGE_STATUSES, `${base}.status`, issues);
    if (!requireArray(phase.stages, `${base}.stages`, issues)) return;

    const stageIds = new Set<string>();
    (phase.stages as unknown[]).forEach((stage, j) => {
      const path = `${base}.stages[${j}]`;
      stageCount++;
      if (!isRecord(stage)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(
        stage,
        ["id", "status", "expert", "model", "budget_usd", "cost_usd", "started_at", "ended_at", "inputs", "outputs", "gate", "tasks"],
        path,
        issues,
      );
      const stageId = typeof stage.id === "string" ? stage.id : "";
      if (stageIds.has(stageId)) issues.push({ path: `${path}.id`, message: `duplicate stage id ${stageId}` });
      stageIds.add(stageId);
      requireEnum(stage.status, STAGE_STATUSES, `${path}.status`, issues);
      if (stage.status === "running") running++;
      requireNumber(stage.budget_usd, `${path}.budget_usd`, issues);
      requireNumber(stage.cost_usd, `${path}.cost_usd`, issues);
      requireArray(stage.inputs, `${path}.inputs`, issues);
      requireArray(stage.outputs, `${path}.outputs`, issues);
      if (stage.stale !== undefined && typeof stage.stale !== "boolean") {
        issues.push({ path: `${path}.stale`, message: "expected true or false" });
      }
      checkOrder(stage.started_at, stage.ended_at, path, issues);
      if (cursor !== null && cursor.phase === phaseId && cursor.stage === stageId) cursorResolves = true;

      if (isRecord(stage.gate)) {
        const gate = stage.gate;
        requireKeys(gate, ["type", "status", "by", "at", "note"], `${path}.gate`, issues);
        requireEnum(gate.type, GATE_TYPES, `${path}.gate.type`, issues);
        requireEnum(gate.status, GATE_STATUSES, `${path}.gate.status`, issues);
        if (gate.status === "approved" && (typeof gate.by !== "string" || typeof gate.at !== "string")) {
          issues.push({ path: `${path}.gate`, message: "an approved gate needs both `by` and `at`" });
        }
      } else if (stage.gate !== undefined) {
        issues.push({ path: `${path}.gate`, message: "expected a mapping" });
      }

      if (requireArray(stage.tasks, `${path}.tasks`, issues)) {
        const taskIds = new Set<string>();
        (stage.tasks as unknown[]).forEach((task, k) => {
          const tp = `${path}.tasks[${k}]`;
          taskCount++;
          if (!isRecord(task)) {
            issues.push({ path: tp, message: "expected a mapping" });
            return;
          }
          requireKeys(task, ["id", "status", "cost_usd", "error", "session_id"], tp, issues);
          const taskId = typeof task.id === "string" ? task.id : "";
          if (!/^t\d+$/.test(taskId)) issues.push({ path: `${tp}.id`, message: "task id must match ^t\\d+$" });
          if (taskIds.has(taskId)) issues.push({ path: `${tp}.id`, message: `duplicate task id ${taskId}` });
          taskIds.add(taskId);
          requireEnum(task.status, STAGE_STATUSES, `${tp}.status`, issues);
          // `null` is legal and means unmetered (an in-session turn nobody costed).
          // It contributes nothing to the total, which is why `budget.spent_usd`
          // can be below what was really spent and why every report says so.
          if (task.cost_usd !== null) requireNumber(task.cost_usd, `${tp}.cost_usd`, issues);
          if (task.metered !== undefined && typeof task.metered !== "boolean") {
            issues.push({ path: `${tp}.metered`, message: "expected true or false" });
          }
          if (task.cost_usd === null && task.metered !== false) {
            issues.push({ path: `${tp}.metered`, message: "a null cost_usd must be marked `metered: false`" });
          }
          if (typeof task.cost_usd === "number") spentFromTasks += task.cost_usd;
          checkOrder(task.started_at, task.ended_at, tp, issues);
        });
      }
    });
  });

  if (stageCount > MAX_STAGES) issues.push({ path: "phases", message: `${stageCount} stages exceeds the ${MAX_STAGES} cap` });
  if (taskCount > MAX_TASKS) issues.push({ path: "phases", message: `${taskCount} tasks exceeds the ${MAX_TASKS} cap` });
  if (running > 1) issues.push({ path: "phases", message: `${running} stages are running; tldrx is single-writer` });
  if (cursor !== null && !cursorResolves) {
    issues.push({ path: "cursor", message: `cursor ${cursor.phase}/${cursor.stage} does not resolve to a stage` });
  }
  if (isRecord(doc.budget) && typeof doc.budget.spent_usd === "number") {
    if (Math.abs(doc.budget.spent_usd - spentFromTasks) > 0.01) {
      issues.push({
        path: "budget.spent_usd",
        message: `${doc.budget.spent_usd} does not match the task total ${round(spentFromTasks)} (tolerance 0.01)`,
      });
    }
  }
  return result(issues);
}

function checkOrder(started: unknown, ended: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof started === "string" && typeof ended === "string" && ended < started) {
    issues.push({ path: `${path}.ended_at`, message: "ended_at is before started_at" });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Narrow a validated document. Call `validateRunFile` first. */
export function asRunFile(input: unknown): RunFile {
  return input as RunFile;
}
