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

/** `gate.evidence` (spec §2.2, design §A.5), read as tolerantly as the rest. */
export interface RunGateEvidence {
  readonly path: string;
  readonly role: string;
  readonly verdict: string;
  readonly sampled: number | null;
  readonly of: number | null;
  readonly resolved: number | null;
  readonly refuted: number | null;
  readonly outside_surface: number | null;
}

export interface RunGate {
  readonly type: string;
  readonly status: string;
  readonly by: string | null;
  readonly at: string | null;
  readonly note: string;
  /** Present only on a gate an `agent` policy closed. */
  readonly evidence: RunGateEvidence | null;
}

export interface RunTask {
  readonly id: string;
  readonly status: string;
  readonly cost_usd: number;
  readonly error: string | null;
  /**
   * False when nobody declared what this turn cost (spec §5, `--commit`).
   *
   * `cost_usd` above is coerced to `0` for arithmetic, which is the right number
   * to add up and the wrong one to READ: a run whose every turn a host session
   * paid for sums to `$0.00`, and a viewer that only had the coerced number could
   * not tell that from a run that genuinely spent nothing. So the null survives
   * as this boolean. Same rule as `runSpend` in `src/hooks/lib/runFile.ts`: a
   * turn is unmetered when `metered` is false OR `cost_usd` is null.
   */
  readonly metered: boolean;
  /** Host-session tokens declared with `--tokens`. Never converted to dollars. */
  readonly tokens: number | null;
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
  /**
   * True when an EARLIER stage's gate was revoked after this one had already run
   * (`RunFile.stale`). Its outputs are still on disk and still look current; the
   * decision they were derived from has been withdrawn.
   */
  readonly stale: boolean;
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

/** Where this run came from, when `tldrx seed apply` created it (spec §2.2). */
export interface RunTriage {
  /** Workspace-relative path of the `split.yml` this run came out of. */
  readonly split: string;
  /** SLUGS of the sibling runs this one was proposed to follow. */
  readonly depends_on: readonly string[];
}

/**
 * What the Build claimed on disk (`RunFile.build`), read as tolerantly as the rest.
 *
 * `branch_model` is null on every run.yml written before issue #57 — which is not
 * the same as `per-epic`, and is not guessed at here.
 */
export interface RunBuildDocument {
  readonly epic_branch: readonly string[];
  readonly branch_model: string | null;
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
  /** Absent on a run `tldrx run new` created — it depends on nothing. */
  readonly triage: RunTriage | null;
  /**
   * Stage id -> `human` | `auto` | `agent` (spec §2.2 `gates_policy`). An absent
   * key, or a run.yml written before the key existed, reads as `human` — the same
   * default `gatePolicyFor` applies, spelled here so a reader never has to know it.
   */
  readonly gates_policy: Readonly<Record<string, string>>;
  /**
   * `host` when a host session drives the turns (`RunFile.attended_by`), null on
   * every run the framework may spawn on — which is every run.yml written before
   * the key existed.
   */
  readonly attended_by: string | null;
  /** Null until a Build stage cuts or adopts an epic branch. */
  readonly build: RunBuildDocument | null;
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
    triage: toTriage(doc.triage),
    gates_policy: toGatesPolicy(doc.gates_policy),
    attended_by: nullableStr(doc.attended_by),
    build: toBuild(doc.build),
    phases: array(doc.phases).map(toPhase).filter((phase): phase is RunPhase => phase !== null),
  };
}

/** Absent on every run until a Build stage cuts a branch, which is most runs. */
function toBuild(input: unknown): RunBuildDocument | null {
  const build = record(input);
  if (build === null) return null;
  return { epic_branch: strings(build.epic_branch), branch_model: nullableStr(build.branch_model) };
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

function toTriage(input: unknown): RunTriage | null {
  const triage = record(input);
  if (triage === null) return null;
  return { split: str(triage.split), depends_on: strings(triage.depends_on) };
}

/** Read tolerantly: a value outside the three policies is dropped, not shown. */
const READABLE_POLICIES: readonly string[] = ["human", "auto", "agent"];

function toGatesPolicy(input: unknown): Readonly<Record<string, string>> {
  const policy = record(input);
  if (policy === null) return {};
  const out: Record<string, string> = {};
  for (const [stage, value] of Object.entries(policy)) {
    if (typeof value === "string" && READABLE_POLICIES.includes(value)) out[stage] = value;
  }
  return out;
}

/** Absent on every gate but an agent-closed one, which is most gates ever written. */
function toGateEvidence(input: unknown): RunGateEvidence | null {
  const evidence = record(input);
  if (evidence === null) return null;
  return {
    path: str(evidence.path),
    role: str(evidence.role),
    verdict: str(evidence.verdict),
    sampled: num(evidence.sampled),
    of: num(evidence.of),
    resolved: num(evidence.resolved),
    refuted: num(evidence.refuted),
    outside_surface: num(evidence.outside_surface),
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
          evidence: toGateEvidence(gate.evidence),
        },
    // Optional and additive: absent on every run.yml written before revocation
    // existed, and absent again the moment the stage re-runs.
    stale: stage.stale === true,
    tasks: array(stage.tasks)
      .map(record)
      .filter((task): task is Record<string, unknown> => task !== null)
      .map((task) => ({
        id: str(task.id),
        status: str(task.status),
        cost_usd: num(task.cost_usd) ?? 0,
        error: nullableStr(task.error),
        // Read BEFORE the `?? 0` above throws the null away. `metered: false` and
        // a null cost are the same fact recorded two ways, and either one alone
        // means the number in `cost_usd` is not a measurement.
        metered: task.metered !== false && num(task.cost_usd) !== null,
        tokens: num(task.tokens),
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
