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
import type { GateType } from "./RunFile.ts";

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

export interface PlannedStage {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  readonly model: string | null;
  readonly experts: readonly string[];
  readonly budget_usd: number;
  readonly timeout_s: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Output path -> the H2 sections spec §2.3 says must exist and be non-empty. */
  readonly sections: ReadonlyMap<string, readonly string[]>;
  readonly gateType: GateType;
  readonly checks: readonly PlannedCheck[];
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

  const stages = entries.map((entry, i) => {
    const id = typeof entry === "string" ? entry : isRecord(entry) ? str(entry.id) : null;
    if (id === null || id === "") throw new PresetError(`${path}: stages[${i}] has no stage id`);
    const overrides = isRecord(entry) ? entry : {};
    return loadStage(root, id, overrides, i);
  });

  return { name, title, depth, defaultBudgetUsd, stages, source: path };
}

function loadStage(
  root: string,
  id: string,
  overrides: Record<string, unknown>,
  index: number,
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
    experts,
    budget_usd: budget,
    timeout_s: typeof doc.timeout_s === "number" ? doc.timeout_s : DEFAULT_TIMEOUT_S,
    inputs: normaliseInputs(doc.inputs),
    outputs,
    sections,
    gateType: normaliseGate(doc.gate),
    checks: normaliseChecks(doc.checks),
    questionsPath: normaliseQuestionsPath(doc.questions, phase),
    source: path,
  };
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
