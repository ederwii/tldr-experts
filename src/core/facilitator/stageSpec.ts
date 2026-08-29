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
import { DEFAULT_EXPERT_KNOWLEDGE_BYTES } from "../experts/expertKnowledge.ts";

/** Spec §2.3 default when `stage.yml` is silent. */
export const DEFAULT_STACK_EXPERTS = true;
export const DEFAULT_DRY_RUN_ALLOWED = true;

export interface StageSpec {
  readonly planned: PlannedStage;
  /** Must exist before the sub-agent is spawned; a gap is exit 1 (spec §5). */
  readonly requiredInputs: readonly string[];
  /** Passed only when present on disk. */
  readonly optionalInputs: readonly string[];
  /**
   * `inputs.seed: true` — this stage also takes THE RUN'S SEED DOCUMENTS, the
   * files `tldrx run new --seed` recorded in `run.yml` for it. They cannot be
   * named in `stage.yml` (they differ per run), so the stage opts in and the
   * facilitator reads the list off `run.yml`.
   *
   * Two spellings, both accepted: `inputs: {seed: true, …}` is the §2.3 shape,
   * and a top-level `seed: true` is the draft shape, whose `inputs` must stay a
   * bare array for the v0 skeleton validator. `[assumption]`
   */
  readonly seedInputs: boolean;
  readonly stackExperts: boolean;
  /**
   * `expert_knowledge_bytes:` — how much of each loaded expert's TRAINED KNOWLEDGE
   * this stage inlines (spec §2.3, §5). Per-stage and nowhere else: a Watch card
   * wants a page of gotchas and a Build story wants everything the expert knows
   * about the files it is editing, and a single workspace-wide number could not be
   * right for both. Absent or unusable ⇒ `DEFAULT_EXPERT_KNOWLEDGE_BYTES` (64 KB).
   */
  readonly expertKnowledgeBytes: number;
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
): {
  stackExperts: boolean;
  expertKnowledgeBytes: number;
  dryRunAllowed: boolean;
  skipIf: string | null;
  questionsMax: number | null;
} {
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
    expertKnowledgeBytes: isRecord(stageDoc)
      && typeof stageDoc.expert_knowledge_bytes === "number"
      && Number.isFinite(stageDoc.expert_knowledge_bytes)
      && stageDoc.expert_knowledge_bytes >= 0
      ? Math.trunc(stageDoc.expert_knowledge_bytes)
      : DEFAULT_EXPERT_KNOWLEDGE_BYTES,
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
function inputSplit(
  root: string,
  stageId: string,
): { requiredInputs: string[]; optionalInputs: string[]; seedInputs: boolean } {
  const doc = readDoc(stagePath(root, stageId));
  const inputs = isRecord(doc) ? doc.inputs : undefined;
  const topLevelSeed = isRecord(doc) && doc.seed === true;
  if (isRecord(inputs)) {
    return {
      requiredInputs: strings(inputs.required),
      optionalInputs: strings(inputs.optional),
      seedInputs: inputs.seed === true || topLevelSeed,
    };
  }
  return { requiredInputs: [], optionalInputs: strings(inputs), seedInputs: topLevelSeed };
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
