/**
 * The validator registry. One file kind -> one validate() that checks required
 * keys and enum membership only (concept §8, "Schema validation").
 */
import type { Validator } from "./validation.ts";
import { validateWorkspace } from "./workspace.ts";
import { validateRun } from "./run.ts";
import { validateStage } from "./stage.ts";
import { validateWorkflow } from "./workflow.ts";
import { validateFacts } from "./facts.ts";
import { validateCompetencies } from "./competencies.ts";
import { validateEnv } from "./env.ts";
import { validateProcess } from "./process.ts";
import { validateBudget } from "./budget.ts";

export const FILE_KINDS = [
  "workspace", "run", "stage", "workflow", "facts", "competencies", "env", "process", "budget",
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
};

export function validate(kind: FileKind, input: unknown) {
  return validators[kind](input);
}

export type { ValidationIssue, ValidationResult, Validator } from "./validation.ts";
export type { Workspace, DetectedRepo, WorkspaceMode } from "./workspace.ts";
export type { Run, RunPhase, RunStatus } from "./run.ts";
export type { Stage, StageGate, GateType } from "./stage.ts";
export type { Workflow, WorkflowDepth } from "./workflow.ts";
export type { FactsFile, Fact, FactSource } from "./facts.ts";
export type { CompetenciesFile, Competency } from "./competencies.ts";
export type { EnvManifest, EnvTool } from "./env.ts";
export type { ProcessModel, Methodology, TicketTool, StoryGranularity } from "./process.ts";
export type { BudgetFile } from "./budget.ts";
