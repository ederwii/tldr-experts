export {
  TRAINING_MODES, isTrainingMode, DEFAULT_TRAIN_USD, MIN_TRAIN_USD, DEFAULT_TRAIN_EFFORT,
  MAX_INLINE_FILES, MAX_INLINE_BYTES, MAX_FILE_BYTES,
  CODE_TASK, RUNS_TASK, KNOWLEDGE_DIRNAME, TRAINING_LOG_FILE,
  knowledgeRelPath, fromRunsRelPath,
} from "./Training.ts";
export type { TrainingMode, TrainingTask } from "./Training.ts";

export {
  KNOWLEDGE_SECTIONS, KNOWLEDGE_CHECKED_SECTIONS, FROM_RUNS_SECTIONS, FROM_RUNS_CHECKED_SECTIONS,
  LIGHT_SHAPE, RUNS_SHAPE, MAX_EVIDENCE_PER_AREA,
  parseKnowledgeFile, describeKnowledgeIssues, codeEvidence, runEvidence, mergeEvidence,
} from "./knowledgeFile.ts";
export type { KnowledgeFile, KnowledgeIssue, KnowledgeShape, MergedEvidence } from "./knowledgeFile.ts";

export { selectFiles, keywordsFor, readDomains, readCommunities, contentHits, MAX_KEYWORDS, MAX_SCANNED_FILES } from "./selectFiles.ts";
export type { FileSelection, Candidate, InlinedFile, SelectOptions } from "./selectFiles.ts";

export { mineRuns, relevantFacts, MAX_RUN_FILES, MAX_RUN_BYTES } from "./mineRuns.ts";
export type { RunMine, MinedFile, MineOptions } from "./mineRuns.ts";

export { codePrompt, runsPrompt, renderInlined, renderMined, renderFactRows, withGutter } from "./trainingPrompt.ts";
export type { TrainingPromptInput } from "./trainingPrompt.ts";

export { writeCompetencies, recomputeCompetencies, readEvidence, CompetenciesError } from "./competenciesWrite.ts";
export type {
  WriteCompetenciesOptions, CompetenciesWrite, RecomputeOptions, CompetenciesRecompute, RecomputedArea,
} from "./competenciesWrite.ts";

export { recomputeExperts, renderRecompute, recomputeJson, expertNames, ExpertNotFound } from "./recomputeExperts.ts";
export type { RecomputeExpertsOptions, RecomputedExpert } from "./recomputeExperts.ts";

export { TrainingLog, trainingLogPath, serializeTrainingEvent, validateTrainingEvent, TRAINING_EVENT_TYPES } from "./trainingLog.ts";
export type { TrainingEvent, TrainingEventType } from "./trainingLog.ts";

export { runTraining, expertRepos, trainingCacheDir, setExpertStatus, TRAIN_TIMEOUT_MS } from "./runTraining.ts";
export type { TrainOptions, TrainOutcome, TrainingRunMode } from "./runTraining.ts";
