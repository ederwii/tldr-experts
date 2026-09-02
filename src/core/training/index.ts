export {
  TRAINING_MODES, isTrainingMode, DEFAULT_TRAIN_USD, DEFAULT_FULL_TRAIN_USD, defaultTrainUsd,
  MEASURED_FULL_TRAIN_USD, MIN_TRAIN_USD, DEFAULT_TRAIN_EFFORT,
  MAX_INLINE_FILES, MAX_INLINE_BYTES, MAX_FILE_BYTES,
  CODE_TASK, RUNS_TASK, KNOWLEDGE_DIRNAME, TRAINING_LOG_FILE,
  knowledgeRelPath, fromRunsRelPath,
} from "./Training.ts";
export type { TrainingMode, TrainingTask } from "./Training.ts";

export {
  trainPreflight, modelTier, measuredBand, perAgentExpectedUsd, TIER_MULTIPLIER,
} from "./trainPreflight.ts";
export type { AmbientModel, ModelTier, PreflightInput, TrainPreflight } from "./trainPreflight.ts";
export { resolveAmbientModel, ambientModelFiles } from "./ambientModel.ts";
export type { AmbientModelInput } from "./ambientModel.ts";

export {
  KNOWLEDGE_SECTIONS, KNOWLEDGE_CHECKED_SECTIONS, FROM_RUNS_SECTIONS, FROM_RUNS_CHECKED_SECTIONS,
  LIGHT_SHAPE, RUNS_SHAPE, MAX_EVIDENCE_PER_AREA, RECAP_SECTION, EXECUTION_CLAIM_REFUSAL,
  parseKnowledgeFile, proseExecutionIssues, describeKnowledgeIssues, describeKnowledgeIssue,
  knowledgeErrors, knowledgeWarnings,
  codeEvidence, runEvidence, mergeEvidence, emptyKnowledgeScope,
} from "./knowledgeFile.ts";
export type {
  KnowledgeFile, KnowledgeIssue, KnowledgeShape, KnowledgeBullet, KnowledgeScope, KnowledgeSeverity,
  MergedEvidence,
} from "./knowledgeFile.ts";
export {
  claimText, confidenceOf, executionClaim, isParaphrase, neighbourhood, normaliseClaim,
  EXECUTION_CLAIM_PATTERNS, MIN_PARAPHRASE_CHARS, NEIGHBOURHOOD_RADIUS, PARAPHRASE_RATIO,
} from "./claimCheck.ts";
export type { Confidence } from "./claimCheck.ts";
export { knowledgeScopeFor, allExpertDomains } from "./knowledgeScope.ts";

export { selectFiles, keywordsFor, readDomains, readCommunities, contentHits, MAX_KEYWORDS, MAX_SCANNED_FILES } from "./selectFiles.ts";
export type { FileSelection, Candidate, InlinedFile, SelectOptions } from "./selectFiles.ts";

export { mineRuns, relevantFacts, hasMinableFiles, MAX_RUN_FILES, MAX_RUN_BYTES } from "./mineRuns.ts";
export type { RunMine, MinedFile, MineOptions } from "./mineRuns.ts";

export {
  codePrompt, runsPrompt, repairPrompt, executionClaimRule, recapSectionRule,
  outputPath, writeTargetRule,
  renderInlined, renderMined, renderFactRows, withGutter,
} from "./trainingPrompt.ts";
export type { TrainingPromptInput, RepairPromptParts } from "./trainingPrompt.ts";

export { writeCompetencies, recomputeCompetencies, readEvidence, CompetenciesError } from "./competenciesWrite.ts";
export type {
  WriteCompetenciesOptions, CompetenciesWrite, RecomputeOptions, CompetenciesRecompute, RecomputedArea,
} from "./competenciesWrite.ts";

export { recomputeExperts, renderRecompute, recomputeJson, expertNames, ExpertNotFound } from "./recomputeExperts.ts";
export type { RecomputeExpertsOptions, RecomputedExpert } from "./recomputeExperts.ts";

export {
  TrainingLog, trainingLogPath, serializeTrainingEvent, validateTrainingEvent, TRAINING_EVENT_TYPES,
  MAX_PAYLOAD_BYTES, MAX_LINE_BYTES,
} from "./trainingLog.ts";
export type { TrainingEvent, TrainingEventType } from "./trainingLog.ts";

export { isRoleExpertOnDisk, lightModeRefusal, nothingToMineRefusal } from "./roleTraining.ts";
export { emptyCodeSweepNote, emptyRunsNote, nothingToTrainRefusal, skipNoteLines } from "./emptyPass.ts";

export { findStrayWrite, recoverStrayWrite, describeStrayRecovery } from "./strayWrite.ts";
export type { StrayProbe, StrayWrite, StrayRecovery } from "./strayWrite.ts";

export { runTraining, expertRepos, trainingCacheDir, setExpertStatus, TRAIN_TIMEOUT_MS } from "./runTraining.ts";
export type { TrainOptions, TrainOutcome, TrainingRunMode } from "./runTraining.ts";
