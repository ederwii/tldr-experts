/**
 * The validator registry. One file kind -> one validate() that checks required
 * keys and enum membership only (concept §8, "Schema validation").
 */
import type { Validator } from "./validation.ts";
import { noteDeprecations } from "./deprecationNotice.ts";
import { validateWorkspace } from "./workspace.ts";
import { validateRun } from "./run.ts";
import { validateStage } from "./stage.ts";
import { validateWorkflow } from "./workflow.ts";
import { validateFacts } from "./facts.ts";
import { validateCompetencies } from "./competencies.ts";
import { validateEnv } from "./env.ts";
import { validateProcess } from "./process.ts";
import { validateBudget } from "./budget.ts";
import { validateStory } from "./story.ts";
import { validateEpic } from "./epic.ts";
import { validateWaves } from "./waves.ts";

export const FILE_KINDS = [
  "workspace", "run", "stage", "workflow", "facts", "competencies", "env", "process", "budget",
  "story", "epic", "waves",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const validators: Readonly<Record<FileKind, Validator>> = {
  workspace: validateWorkspace,
  run: validateRun,
  stage: validateStage,
  workflow: validateWorkflow,
  facts: validateFacts,
  competencies: validateCompetencies,
  env: validateEnv,
  process: validateProcess,
  budget: validateBudget,
  story: validateStory,
  epic: validateEpic,
  waves: validateWaves,
};

export function validate(kind: FileKind, input: unknown) {
  return validators[kind](input);
}

/**
 * Validate a document that came from a named file, and SAY on stderr whatever it
 * is still spelling the old way.
 *
 * The note carries the path because the validator cannot: `validate()` sees a
 * parsed object and has no idea which of a workspace's files it came from, and
 * "schema_version is deprecated" without a filename is a warning nobody can act
 * on. One line per deprecation, stderr so it never pollutes a `--json` stdout.
 */
export function validateFile(kind: FileKind, input: unknown, file: string) {
  const outcome = validate(kind, input);
  noteDeprecations(file, outcome);
  return outcome;
}

export type { ValidationIssue, ValidationResult, Validator } from "./validation.ts";
export {
  LEGACY_VERSION_KEY, LEGACY_VERSION_NOTE, SCHEMA_VERSION, VERSION_KEY, requireVersion,
} from "./validation.ts";
export { noteDeprecations, resetDeprecationNotices } from "./deprecationNotice.ts";
export type { Workspace, DetectedRepo, WorkspaceMode } from "./workspace.ts";
export type { Run, RunPhase, RunStatus } from "./run.ts";
export type { Stage, StageGate, GateType, EffortLevel } from "./stage.ts";
export { EFFORT_LEVELS, isEffortLevel } from "./stage.ts";
export type { Workflow, WorkflowDepth } from "./workflow.ts";
export type { FactsFile, Fact, FactSource } from "./facts.ts";
export type { CompetenciesFile, Competency } from "./competencies.ts";
export type { EnvManifest, EnvTool } from "./env.ts";
export type { ProcessModel, Methodology, TicketTool, StoryGranularity } from "./process.ts";
export type { BudgetFile } from "./budget.ts";
export {
  validateStory, validateStoryDod, validateStoryFile, parseDodBlock, asStory, STORY_KEYS,
} from "./story.ts";
export type { Story, DodBlock, StoryFile } from "./story.ts";
export { validateEpic, validateEpicFile, asEpic, EPIC_KEYS } from "./epic.ts";
export type { Epic, EpicFile } from "./epic.ts";
export { validateWaves, validateWaveOrder, asWavesFile, scheduleOf } from "./waves.ts";
export type { Wave, WavesFile } from "./waves.ts";
export {
  PLAN_STATUSES, STORY_ID_RE, EPIC_ID_RE, WAVE_ID_RE, EPIC_BRANCH_RE, REPO_NAME_RE,
  MAX_WAVES, MAX_PLAN_STORIES,
} from "./planCommon.ts";
export type { PlanStatus } from "./planCommon.ts";
export { splitFrontMatter, parseFrontMatter } from "./frontMatter.ts";
export type { FrontMatter, FrontMatterDoc } from "./frontMatter.ts";
