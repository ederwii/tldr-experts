/**
 * Reading a scope preset and its stages, and normalising them into one shape.
 *
 * Two shapes exist in the wild and both have to load:
 *   - the **draft** shape the repo ships (`workflows/feature.yml` with
 *     `stages: [what, how, …]`; `stages/what/stage.yml` with `name:` and `phase: 1`)
 *   - the **spec §2.3/§2.4** shape (`stages: [{id, phase, budget_usd}]`;
 *     `id:`, `phase: 02-how`, `outputs: [{path, sections}]`)
 *
 * Everything downstream sees only `PlannedStage`. `[assumption]`: a numeric phase
 * maps positionally onto the five §1 phase folders, which is what the shipped
 * stages already assume (what=1 … watch=5).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { isRecord } from "../schemas/validation.ts";
import { PROJECT_FRAMEWORK_DIR, STAGES_DIR, WORKFLOWS_DIR } from "../paths.ts";
import { GatePolicyError, parseWorkflowGates, type GatesPolicy } from "./gatePolicy.ts";
import type { GateType } from "./RunFile.ts";
import { EFFORT_LEVELS, isEffortLevel, MAX_PRECONDITIONS, type EffortLevel } from "../schemas/stage.ts";
import { allowlistIssue } from "../schemas/commandAllowlist.ts";
import { loadWorkspace } from "../../hooks/lib/workspace.ts";

/** The five phase folders of spec §1, in order. A numeric `phase:` indexes this. */
export const PHASE_IDS = ["01-what", "02-how", "03-plan", "04-build", "05-watch"] as const;

const PHASE_SEGMENT_RE = /^0[1-5]-[a-z]+$/;
export const DEFAULT_TIMEOUT_S = 900;
/** Spec §2.3 validation: "≤20 inputs". Counted where inputs are DECLARED and where they are INLINED. */
export const MAX_STAGE_INPUTS = 20;

export interface PlannedCheck {
  readonly id: string;
  readonly on: string;
  readonly repo: string | null;
  readonly command: string | null;
  readonly expect_exit: number;
}

/**
 * A `preconditions:` entry, already checked against the workspace allowlist
 * (design §F.1). `repo` and `command` are non-null here, unlike `PlannedCheck`'s:
 * a precondition with either missing is refused at load rather than carried to
 * the call site as a failure waiting to happen.
 */
export interface PlannedPrecondition {
  readonly id: string;
  readonly repo: string;
  readonly command: string;
  readonly expect_exit: number;
}

export interface PlannedStage {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  readonly model: string | null;
  /** `--effort` for this stage's sub-agent. Null ⇒ the flag is not passed at all. */
  readonly effort: EffortLevel | null;
  readonly experts: readonly string[];
  readonly budget_usd: number;
  readonly timeout_s: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Output path -> the H2 sections spec §2.3 says must exist and be non-empty. */
  readonly sections: ReadonlyMap<string, readonly string[]>;
  readonly gateType: GateType;
  readonly checks: readonly PlannedCheck[];
  /** Empty for every stage that declares none, which is every shipped stage. */
  readonly preconditions: readonly PlannedPrecondition[];
  readonly questionsPath: string | null;
  /** Where this stage.yml was read from — cited in errors. */
  readonly source: string;
}

export interface WorkflowPreset {
  readonly name: string;
  readonly title: string;
  readonly depth: string;
  readonly defaultBudgetUsd: number;
  readonly stages: readonly PlannedStage[];
  /**
   * `skips:` — stages this scope deliberately does NOT run (spec §2.4).
   *
   * It used to be read by nothing: the schema declared the key
   * (`src/core/schemas/workflow.ts:14`) and the loader dropped it, so "docs skips
   * Plan" was a sentence in a file rather than a fact the facilitator could act
   * on. Build now needs it — a scope that skips Plan still reaches Build, and has
   * to be told the difference between "the Plan phase produced nothing yet" and
   * "no Plan phase was ever going to run" (`build/implicitPlan.ts`).
   */
  readonly skips: readonly string[];
  /**
   * `gates:` — stage id -> `human | auto | agent` (spec §2.4). Partial on purpose:
   * a stage the file does not name keeps the `human` default, so adding a stage to
   * a workflow can never silently hand its gate to the machine.
   */
  readonly gates: GatesPolicy;
  readonly source: string;
}

/** A workspace's own copy wins over the framework's shipped default. */
export function workflowPath(root: string, scope: string): string | null {
  const local = join(root, PROJECT_FRAMEWORK_DIR, "workflows", `${scope}.yml`);
  if (existsSync(local)) return local;
  const shipped = join(WORKFLOWS_DIR, `${scope}.yml`);
  return existsSync(shipped) ? shipped : null;
}

export function stagePath(root: string, id: string): string | null {
  const local = join(root, PROJECT_FRAMEWORK_DIR, "stages", id, "stage.yml");
  if (existsSync(local)) return local;
  const shipped = join(STAGES_DIR, id, "stage.yml");
  return existsSync(shipped) ? shipped : null;
}

/** A stage that resolves to no `stage.md` at all — see `stageMdPath`. */
export class StageBodyError extends Error {}

/**
 * `stage.md` for the stage whose `stage.yml` was resolved to `source`.
 *
 * The override wins per FILE, not per directory. Before this, `stage.md` was read
 * by string-substituting `stage.yml` in the resolved path, so creating
 * `.tldrx/stages/plan/stage.yml` to tune one key moved the BODY lookup into a
 * directory that had none — and the miss was read as an empty body. Measured on
 * the 260829-scoring-leaderboard driver session (2026-08-31): the context ledger
 * printed `stage 1 B` where it had been 4.9 KB, and the sub-agent would have been
 * dispatched with the inputs, the experts and the rejection note but no
 * instructions at all. Nothing refused; it was caught by an operator reading the
 * ledger line by line (gh #39).
 *
 * So: fall back to the packaged body, and when there is none anywhere, REFUSE by
 * name. A stage body is the whole instruction set — running the stage without one
 * spends real money to produce something plausible built on nothing, which is the
 * one outcome worse than stopping.
 */
export function stageMdPath(id: string, source: string): string {
  const beside = source.replace(/stage\.yml$/, "stage.md");
  if (existsSync(beside)) return beside;
  const shipped = join(STAGES_DIR, id, "stage.md");
  if (existsSync(shipped)) return shipped;
  const looked = beside === shipped ? beside : `${beside}, not at ${shipped}`;
  throw new StageBodyError(
    `stage '${id}' has no stage.md: not at ${looked}. A stage body is the sub-agent's whole `
    + "instruction set, so this stage cannot run. Copy the packaged stages/<id>/stage.md beside "
    + "the stage.yml, or write one there.",
  );
}

export class PresetError extends Error {}

export function loadWorkflowPreset(root: string, scope: string): WorkflowPreset {
  const path = workflowPath(root, scope);
  if (path === null) throw new PresetError(`no workflow for scope '${scope}' in .tldrx/workflows/ or the shipped workflows/`);
  const doc = parseYaml(readFileSync(path, "utf8"));
  if (!isRecord(doc)) throw new PresetError(`${path}: expected a mapping at the document root`);

  const name = typeof doc.name === "string" ? doc.name : scope;
  const title = str(doc.title) ?? str(doc.description) ?? name;
  const depth = typeof doc.depth === "string" ? doc.depth : "standard";
  const defaultBudgetUsd = typeof doc.default_budget_usd === "number" ? doc.default_budget_usd : 0;
  if (defaultBudgetUsd <= 0) throw new PresetError(`${path}: default_budget_usd must be > 0`);

  const entries = Array.isArray(doc.stages) ? (doc.stages as unknown[]) : [];
  if (entries.length === 0) throw new PresetError(`${path}: the preset lists no stages`);

  // Read at most ONCE for the whole preset, and only if a stage actually declares
  // a precondition — `loadWorkflowPreset` is on the status line's path and no
  // shipped stage declares one, so the common case must stay a no-op.
  //
  // Checked at LOAD, not at run time: a stage naming a command `workspace.yml`
  // does not declare must never become a `PlannedStage`, because by the time
  // anything holds one of those the decision to run it has already been taken.
  let allowed: ReadonlySet<string> | null = null;
  const allowedCommands = (): ReadonlySet<string> => {
    if (allowed === null) allowed = loadWorkspace(root).commands;
    return allowed;
  };

  const stages = entries.map((entry, i) => {
    const id = typeof entry === "string" ? entry : isRecord(entry) ? str(entry.id) : null;
    if (id === null || id === "") throw new PresetError(`${path}: stages[${i}] has no stage id`);
    const overrides = isRecord(entry) ? entry : {};
    return loadStage(root, id, overrides, i, allowedCommands);
  });

  let gates: GatesPolicy;
  try {
    gates = parseWorkflowGates(doc.gates, stages.map((stage) => stage.id), path);
  } catch (error) {
    if (error instanceof GatePolicyError) throw new PresetError(error.message);
    throw error;
  }

  const skips = Array.isArray(doc.skips) ? (doc.skips as unknown[]).filter(isString) : [];
  return { name, title, depth, defaultBudgetUsd, stages, skips, gates, source: path };
}

function loadStage(
  root: string,
  id: string,
  overrides: Record<string, unknown>,
  index: number,
  allowedCommands: () => ReadonlySet<string>,
): PlannedStage {
  const path = stagePath(root, id);
  if (path === null) throw new PresetError(`stage '${id}' has no stage.yml in .tldrx/stages/ or the shipped stages/`);
  const doc = parseYaml(readFileSync(path, "utf8"));
  if (!isRecord(doc)) throw new PresetError(`${path}: expected a mapping at the document root`);

  const phase = normalisePhase(str(overrides.phase) ?? doc.phase, index, path);
  const budget = typeof overrides.budget_usd === "number"
    ? overrides.budget_usd
    : typeof doc.budget_usd === "number" ? doc.budget_usd : 0;
  if (budget <= 0) throw new PresetError(`${path}: budget_usd must be > 0`);

  const experts = Array.isArray(doc.experts) ? (doc.experts as unknown[]).filter(isString) : [];
  const { outputs, sections } = normaliseOutputs(doc.outputs, phase);

  return {
    id,
    title: str(doc.title) ?? id,
    phase,
    model: str(doc.model),
    effort: normaliseEffort(overrides.effort ?? doc.effort, path),
    experts,
    budget_usd: budget,
    timeout_s: typeof doc.timeout_s === "number" ? doc.timeout_s : DEFAULT_TIMEOUT_S,
    inputs: normaliseInputs(doc.inputs),
    outputs,
    sections,
    gateType: normaliseGate(doc.gate),
    checks: normaliseChecks(doc.checks),
    preconditions: normalisePreconditions(doc.preconditions, path, allowedCommands),
    questionsPath: normaliseQuestionsPath(doc.questions, phase),
    source: path,
  };
}

/**
 * A typo here would silently spend at the CLI's default effort — which is exactly
 * the cost the flag exists to control — so an unrecognised level is refused, not
 * dropped. Absent stays absent: the flag is then never passed.
 */
function normaliseEffort(value: unknown, path: string): EffortLevel | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isEffortLevel(value)) {
    throw new PresetError(`${path}: effort must be one of ${EFFORT_LEVELS.join(" | ")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function normalisePhase(value: unknown, index: number, path: string): string {
  if (typeof value === "string" && PHASE_SEGMENT_RE.test(value)) return value;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= PHASE_IDS.length) return PHASE_IDS[n - 1] as string;
  const fallback = PHASE_IDS[Math.min(index, PHASE_IDS.length - 1)];
  if (fallback === undefined) throw new PresetError(`${path}: cannot place stage in a phase`);
  return fallback;
}

/** Draft outputs are bare filenames; spec outputs already carry their phase folder. */
function normaliseOutputs(
  value: unknown,
  phase: string,
): { outputs: string[]; sections: Map<string, readonly string[]> } {
  const outputs: string[] = [];
  const sections = new Map<string, readonly string[]>();
  if (!Array.isArray(value)) return { outputs, sections };
  for (const entry of value as unknown[]) {
    const raw = typeof entry === "string" ? entry : isRecord(entry) ? str(entry.path) : null;
    if (raw === null || raw === "") continue;
    const path = qualify(raw, phase);
    outputs.push(path);
    if (isRecord(entry) && Array.isArray(entry.sections)) {
      sections.set(path, (entry.sections as unknown[]).filter(isString));
    }
  }
  return { outputs, sections };
}

function normaliseInputs(value: unknown): string[] {
  if (Array.isArray(value)) return (value as unknown[]).filter(isString);
  if (isRecord(value)) {
    const required = Array.isArray(value.required) ? (value.required as unknown[]).filter(isString) : [];
    const optional = Array.isArray(value.optional) ? (value.optional as unknown[]).filter(isString) : [];
    return [...required, ...optional];
  }
  return [];
}

function normaliseGate(value: unknown): GateType {
  const type = isRecord(value) ? str(value.type) : typeof value === "string" ? value : null;
  switch (type) {
    case "approve":
    case "human-approval":
      return "approve";
    case "checks":
    case "checks-green":
      return "checks";
    case "auto":
    case "none":
      return "auto";
    default:
      return "approve";
  }
}

function normaliseChecks(value: unknown): PlannedCheck[] {
  if (!Array.isArray(value)) return [];
  const checks: PlannedCheck[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry === "string") {
      checks.push({ id: entry, on: "post-write", repo: null, command: null, expect_exit: 0 });
      continue;
    }
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    if (id === null) continue;
    checks.push({
      id,
      on: str(entry.on) ?? "post-write",
      repo: str(entry.repo),
      command: str(entry.command),
      expect_exit: typeof entry.expect_exit === "number" ? entry.expect_exit : 0,
    });
  }
  return checks;
}

/**
 * Design §F.1, and the one line of it that matters: **refused at load.**
 *
 * A precondition is a command run as the user, before anything else, on every
 * dispatch. So an unparseable one, or one naming a command `.tldrx/workspace.yml`
 * does not declare, is a `PresetError` here — the same refusal shape a bad
 * `effort:` gets, for the same reason. Deferring it to run time would mean the
 * refusal arrives after the operator already believed the stage was runnable, and
 * a safety rule that fires late is a safety rule that gets argued with.
 *
 * The comparison itself is `allowlistIssue` — the same function the story dod
 * block and the `cmd` check call, not a second reading of the same sentence.
 */
function normalisePreconditions(
  value: unknown,
  path: string,
  allowed: () => ReadonlySet<string>,
): PlannedPrecondition[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PresetError(`${path}: preconditions must be a list of {id, repo, command} entries`);
  }
  const entries = value as unknown[];
  if (entries.length > MAX_PRECONDITIONS) {
    throw new PresetError(`${path}: ${entries.length} preconditions exceeds the cap of ${MAX_PRECONDITIONS}`);
  }
  const preconditions: PlannedPrecondition[] = [];
  entries.forEach((entry, i) => {
    const where = `${path}: preconditions[${i}]`;
    if (!isRecord(entry)) throw new PresetError(`${where} must be a mapping of {id, repo, command}`);
    const id = str(entry.id);
    const repo = str(entry.repo);
    const command = str(entry.command);
    if (id === null) throw new PresetError(`${where} has no \`id\``);
    if (repo === null) throw new PresetError(`${where} (${id}) has no \`repo\``);
    if (command === null) throw new PresetError(`${where} (${id}) has no \`command\``);
    const refusal = allowlistIssue(command, allowed(), "stage");
    if (refusal !== null) throw new PresetError(`${where} (${id}): ${refusal}`);
    preconditions.push({
      id,
      repo,
      command,
      expect_exit: typeof entry.expect_exit === "number" ? entry.expect_exit : 0,
    });
  });
  return preconditions;
}

function normaliseQuestionsPath(value: unknown, phase: string): string | null {
  if (!isRecord(value)) return null;
  const path = str(value.path);
  return path === null ? null : qualify(path, phase);
}

function qualify(path: string, phase: string): string {
  const head = path.split("/")[0] ?? "";
  return PHASE_SEGMENT_RE.test(head) ? path : `${phase}/${path}`;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
