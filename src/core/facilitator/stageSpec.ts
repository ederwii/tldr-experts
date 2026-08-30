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
import { DEFAULT_KNOWLEDGE_MAX_BYTES } from "../experts/expertKnowledge.ts";
import { DEFAULT_INPUTS_MAX_BYTES } from "./seedInputs.ts";
import { DEFAULT_PROMPT_MAX_BYTES } from "./contextLedger.ts";
import { defaultMaxReads } from "./readCap.ts";

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
   * `knowledge_max_bytes:` — how much TRAINED KNOWLEDGE this stage inlines in
   * TOTAL, shared by every loaded expert (spec §2.3, §5). Per-stage and nowhere
   * else: a Watch card wants a page of gotchas and a Build story wants everything
   * the expert knows about the files it is editing, and a single workspace-wide
   * number could not be right for both.
   *
   * The retired `expert_knowledge_bytes:` is still read, as the same TOTAL. It
   * used to be a per-expert ceiling, which is how nine experts turned a 64 KB
   * number into 83,523 measured bytes; a fork that still sets it gets the number
   * it wrote, applied the way a ceiling has to be applied to be one.
   * Absent or unusable ⇒ `DEFAULT_KNOWLEDGE_MAX_BYTES` (48 KB).
   */
  readonly knowledgeMaxBytes: number;
  /**
   * `inputs_max_bytes:` — the shared ceiling on the CONTENT of every declared
   * input (§2.3). Filled before the experts get anything, because an input the
   * stage declared outranks reference material nobody asked for.
   * Absent or unusable ⇒ `DEFAULT_INPUTS_MAX_BYTES` (96 KB).
   */
  readonly inputsMaxBytes: number;
  /**
   * `prompt_max_bytes:` — the whole prompt's ceiling (§2.3, §5). Over it the stage
   * is REFUSED before a sub-agent is spawned, with the biggest sections named.
   * Absent or unusable ⇒ `DEFAULT_PROMPT_MAX_BYTES` (160 KB).
   */
  readonly promptMaxBytes: number;
  /**
   * `max_reads:` — how many `Read`/`Glob`/`Grep` calls the sub-agent may make
   * before it is stopped (§5). The real brake: `--max-budget-usd` only stops a
   * turn already in flight. Absent ⇒ the per-stage default (`readCap.ts`).
   */
  readonly maxReads: number;
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
  knowledgeMaxBytes: number;
  inputsMaxBytes: number;
  promptMaxBytes: number;
  maxReads: number;
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
    knowledgeMaxBytes: byteKey(stageDoc, "knowledge_max_bytes")
      ?? byteKey(stageDoc, "expert_knowledge_bytes")
      ?? DEFAULT_KNOWLEDGE_MAX_BYTES,
    inputsMaxBytes: byteKey(stageDoc, "inputs_max_bytes") ?? DEFAULT_INPUTS_MAX_BYTES,
    promptMaxBytes: byteKey(stageDoc, "prompt_max_bytes") ?? DEFAULT_PROMPT_MAX_BYTES,
    maxReads: byteKey(stageDoc, "max_reads") ?? defaultMaxReads(stageId),
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

/**
 * A non-negative integer key off `stage.yml`, or null when it is absent or is
 * anything a byte count cannot be. Null rather than the default, so a caller can
 * fall through to a second spelling before it gives up.
 */
function byteKey(doc: unknown, key: string): number | null {
  if (!isRecord(doc)) return null;
  const value = doc[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
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
