/**
 * The bits of `stage.yml` and `workflows/<scope>.yml` that `PlannedStage` drops.
 *
 * `src/core/run/workflowPreset.ts` normalises the two stage shapes into one thing
 * the gates and `run new` can use, and in doing so it merges `inputs.required`
 * with `inputs.optional` and forgets `skip_if`. The facilitator needs both back:
 * a missing REQUIRED input is exit 1, a missing optional one is just absent, and
 * `skip_if` decides whether the stage runs at all.
 *
 * This overlay re-reads the same two files rather than widening `PlannedStage`,
 * so nothing outside `src/core/facilitator/` changes shape.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseYaml } from "../yaml.ts";
import { isRecord } from "../schemas/validation.ts";
import {
  loadWorkflowPreset, stagePath, workflowPath, PresetError, type PlannedStage, type WorkflowPreset,
} from "../run/workflowPreset.ts";

/** Spec §2.3 default when `stage.yml` is silent. */
export const DEFAULT_STACK_EXPERTS = true;
export const DEFAULT_DRY_RUN_ALLOWED = true;

export interface StageSpec {
  readonly planned: PlannedStage;
  /** Must exist before the sub-agent is spawned; a gap is exit 1 (spec §5). */
  readonly requiredInputs: readonly string[];
  /** Passed only when present on disk. */
  readonly optionalInputs: readonly string[];
  readonly stackExperts: boolean;
  readonly dryRunAllowed: boolean;
  /** From the WORKFLOW entry (spec §2.4), not from stage.yml. */
  readonly skipIf: string | null;
  readonly questionsMax: number | null;
}

export function loadStageSpec(root: string, scope: string, stageId: string): StageSpec {
  const preset = loadWorkflowPreset(root, scope);
  const planned = preset.stages.find((s) => s.id === stageId);
  if (planned === undefined) {
    throw new PresetError(`stage '${stageId}' is not in workflow '${preset.name}' (${preset.source})`);
  }
  return { planned, ...overlay(root, scope, stageId), ...inputSplit(root, stageId) };
}

/** The stage ids of a scope, in execution order — used by `next` for guard rails. */
export function stageOrder(preset: WorkflowPreset): readonly string[] {
  return preset.stages.map((s) => s.id);
}

function overlay(
  root: string,
  scope: string,
  stageId: string,
): { stackExperts: boolean; dryRunAllowed: boolean; skipIf: string | null; questionsMax: number | null } {
  const stageDoc = readDoc(stagePath(root, stageId));
  const workflowDoc = readDoc(workflowPath(root, scope));

  let skipIf: string | null = null;
  const entries = isRecord(workflowDoc) && Array.isArray(workflowDoc.stages) ? (workflowDoc.stages as unknown[]) : [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.id !== stageId) continue;
    if (typeof entry.skip_if === "string" && entry.skip_if !== "") skipIf = entry.skip_if;
  }

  const questions = isRecord(stageDoc) && isRecord(stageDoc.questions) ? stageDoc.questions : null;
  return {
    stackExperts: isRecord(stageDoc) && typeof stageDoc.stack_experts === "boolean"
      ? stageDoc.stack_experts
      : DEFAULT_STACK_EXPERTS,
    dryRunAllowed: isRecord(stageDoc) && typeof stageDoc.dry_run_allowed === "boolean"
      ? stageDoc.dry_run_allowed
      : DEFAULT_DRY_RUN_ALLOWED,
    skipIf,
    questionsMax: questions !== null && typeof questions.max === "number" ? questions.max : null,
  };
}

/**
 * `[assumption]` — the DRAFT stage shape writes `inputs:` as a bare list with no
 * required/optional split, and its entries are prose placeholders like
 * `"<free text, a PRD, any document>"`. Treating those as required would make
 * every draft stage exit 1 forever, so a bare list is read as ALL OPTIONAL.
 */
function inputSplit(root: string, stageId: string): { requiredInputs: string[]; optionalInputs: string[] } {
  const doc = readDoc(stagePath(root, stageId));
  const inputs = isRecord(doc) ? doc.inputs : undefined;
  if (isRecord(inputs)) {
    return {
      requiredInputs: strings(inputs.required),
      optionalInputs: strings(inputs.optional),
    };
  }
  return { requiredInputs: [], optionalInputs: strings(inputs) };
}

function readDoc(path: string | null): unknown {
  if (path === null || !existsSync(path)) return null;
  try {
    return parseYaml(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [];
}
