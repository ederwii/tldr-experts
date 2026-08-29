/**
 * The `run.yml` (§2.2) and `budget.yml` (§2.11) shapes the read-only views need.
 *
 * Read tolerantly, on purpose. `src/core/schemas/run.ts` and
 * `src/core/schemas/budget.ts` still validate the v0 draft shape — `schema_version`,
 * `run_id`, `budget_usd`, flat `phases[].stage`, `awaiting-gate` with a hyphen —
 * and they REJECT a spec-shaped run.yml, including this repo's own fixture
 * (measured 2026-08-28: `validate("run", …)` on `test/fixtures/workspace/…/run.yml`
 * returns 7 issues). A viewer must not refuse to show a file the facilitator
 * wrote, so the shape below follows the spec and the older validators are left
 * for whoever reconciles them. `[assumption]`
 *
 * This module only projects an already-parsed YAML document; reading files is
 * `loadRun.ts`.
 */

export interface RunGate {
  readonly type: string;
  readonly status: string;
  readonly by: string | null;
  readonly at: string | null;
  readonly note: string;
}

export interface RunTask {
  readonly id: string;
  readonly status: string;
  readonly cost_usd: number;
  readonly error: string | null;
}

export interface RunStage {
  readonly id: string;
  readonly status: string;
  readonly expert: string | null;
  readonly model: string | null;
  readonly budget_usd: number | null;
  readonly cost_usd: number;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly gate: RunGate | null;
  readonly tasks: readonly RunTask[];
}

export interface RunPhase {
  readonly id: string;
  readonly status: string;
  readonly stages: readonly RunStage[];
}

export interface RunCursor {
  readonly phase: string;
  readonly stage: string;
  readonly task: string | null;
}

export interface RunDocument {
  readonly run: string;
  readonly title: string;
  readonly scope: string;
  readonly workflow: string;
  readonly repos: readonly string[];
  readonly status: string;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly cursor: RunCursor | null;
  readonly ceiling_usd: number | null;
  readonly spent_usd: number | null;
  readonly phases: readonly RunPhase[];
}

export interface BudgetPhase {
  readonly id: string;
  readonly ceiling_usd: number | null;
  readonly spent_usd: number | null;
}

export interface BudgetDocument {
  readonly ceiling_usd: number | null;
  readonly per_agent_max_usd: number | null;
  readonly warn_at_pct: number | null;
  readonly on_exceed: string | null;
  readonly phases: readonly BudgetPhase[];
}

/** Terminal statuses from spec §2.2. */
export const TERMINAL_STATUSES = ["done", "failed", "skipped", "cancelled"] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function toRunDocument(input: unknown, fallbackId: string): RunDocument | null {
  const doc = record(input);
  if (doc === null) return null;
  const budget = record(doc.budget);
  const cursor = record(doc.cursor);

  return {
    // `run_id` is the draft key; `run` is the spec key. Accept both.
    run: str(doc.run) !== "" ? str(doc.run) : str(doc.run_id) !== "" ? str(doc.run_id) : fallbackId,
    title: str(doc.title),
    scope: str(doc.scope),
    workflow: str(doc.workflow),
    repos: strings(doc.repos),
    status: str(doc.status),
    created_at: nullableStr(doc.created_at),
    updated_at: nullableStr(doc.updated_at),
    cursor: cursor === null
      ? null
      : { phase: str(cursor.phase), stage: str(cursor.stage), task: nullableStr(cursor.task) },
    ceiling_usd: num(budget?.ceiling_usd) ?? num(doc.budget_usd),
    spent_usd: num(budget?.spent_usd),
    phases: array(doc.phases).map(toPhase).filter((phase): phase is RunPhase => phase !== null),
  };
}

export function toBudgetDocument(input: unknown): BudgetDocument | null {
  const doc = record(input);
  if (doc === null) return null;
  return {
    ceiling_usd: num(doc.ceiling_usd),
    per_agent_max_usd: num(doc.per_agent_max_usd),
    warn_at_pct: num(doc.warn_at_pct),
    on_exceed: nullableStr(doc.on_exceed),
    phases: array(doc.phases)
      .map(record)
      .filter((phase): phase is Record<string, unknown> => phase !== null)
      .map((phase) => ({
        id: str(phase.id),
        ceiling_usd: num(phase.ceiling_usd),
        spent_usd: num(phase.spent_usd),
      })),
  };
}

function toPhase(input: unknown): RunPhase | null {
  const phase = record(input);
  if (phase === null) return null;
  return {
    id: str(phase.id),
    status: str(phase.status),
    stages: array(phase.stages).map(toStage).filter((stage): stage is RunStage => stage !== null),
  };
}

function toStage(input: unknown): RunStage | null {
  const stage = record(input);
  if (stage === null) return null;
  const gate = record(stage.gate);
  return {
    id: str(stage.id),
    status: str(stage.status),
    expert: nullableStr(stage.expert),
    model: nullableStr(stage.model),
    budget_usd: num(stage.budget_usd),
    cost_usd: num(stage.cost_usd) ?? 0,
    started_at: nullableStr(stage.started_at),
    ended_at: nullableStr(stage.ended_at),
    inputs: strings(stage.inputs),
    outputs: strings(stage.outputs),
    gate: gate === null
      ? null
      : {
          type: str(gate.type),
          status: str(gate.status),
          by: nullableStr(gate.by),
          at: nullableStr(gate.at),
          note: str(gate.note),
        },
    tasks: array(stage.tasks)
      .map(record)
      .filter((task): task is Record<string, unknown> => task !== null)
      .map((task) => ({
        id: str(task.id),
        status: str(task.status),
        cost_usd: num(task.cost_usd) ?? 0,
        error: nullableStr(task.error),
      })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): readonly string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}
