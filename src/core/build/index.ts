/** The Build phase's machinery. The pipeline that drives it is `facilitator/executors/build.ts`. */
export {
  git, repoDirOf, dirtyPaths, isDirty, branchExists, currentBranch, headSha, ensureBranch,
  addWorktree, removeWorktree, commitAll, mergeNoFf, diffCommand, firstLine, GitError, GIT_TIMEOUT_MS,
} from "./git.ts";
export type { GitResult, MergeOutcome } from "./git.ts";
export { loadBuildPlan, inOrder, PlanLoadError } from "./plan.ts";
export type { BuildPlan, BuildWave, PlannedStory, PlannedEpic } from "./plan.ts";
export { updateStoryFront, evidenceFor, quote, StoryWriteError } from "./storyFile.ts";
export type { StoryPatch } from "./storyFile.ts";
export {
  buildDeveloperPrompt, buildReviewerPrompt, epicSummary, touchedInputs, REVIEW_SCHEMA,
  MAX_TOUCHED_BYTES, MAX_TOUCHED_FILES,
} from "./prompts.ts";
export type { DeveloperPromptParts, ReviewerPromptParts } from "./prompts.ts";
export { parseReview, renderReviewLog, renderPreviousAttempt } from "./review.ts";
export type { Review } from "./review.ts";
export { dodGreen, describeOutcome } from "./outcome.ts";
export type { StoryOutcome, DodResult, Verdict } from "./outcome.ts";
export { renderBuildHandoff } from "./handoff.ts";
export type { BuildHandoffParts, EpicSummaryRow } from "./handoff.ts";
