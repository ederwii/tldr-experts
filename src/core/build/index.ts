/** The Build phase's machinery. The pipeline that drives it is `facilitator/executors/build.ts`. */
export {
  git, repoDirOf, dirtyPaths, isDirty, branchExists, currentBranch, headSha, ensureBranch,
  addWorktree, removeWorktree, cleanUpRunEpicWorktrees, commitAll, commitPathsOnly, mergeNoFf, diffCommand,
  firstLine, GitError, GIT_TIMEOUT_MS,
  stateDirPrefixes, partitionDirty, porcelainPath, shaOf, baseStateOf, fastForward, commitsBetween,
  assertWorktreeOn, WorktreeBranchMismatchError, shaReachability,
} from "./git.ts";
export type {
  GitResult, MergeOutcome, PathCommit, DirtySplit, BaseState, BaseStaleness, ShaReachability,
} from "./git.ts";
export { loadBuildPlan, inOrder, PlanLoadError } from "./plan.ts";
export type { BuildPlan, BuildWave, PlannedStory, PlannedEpic } from "./plan.ts";
export { updateStoryFront, applyPlanPatch, evidenceFor, quote, StoryWriteError } from "./storyFile.ts";
export {
  loadImplicitPlan, implicitPlanContent, renderImplicitPlan, describeImplicitPlan, updateImplicitPlan,
  planIsSkipped, satisfiedByImplicitPlan, dodCommandsFor, dodRolesFor, dodIsSatisfiedEmpty, citedRepoPaths,
  decisionBullets, chooseRepo, epicBranchFor, implicitPlanPath, isImplicitPlanOnDisk, ImplicitPlanError,
  IMPLICIT_PLAN_REL, IMPLICIT_PLAN_FILE, IMPLICIT_STORY_ID, IMPLICIT_EPIC_ID, IMPLICIT_WAVE_ID,
  MAX_IMPLICIT_TOUCHES, PLAN_STAGE, WHAT_HANDOFF_REL, SUCCESS_METRICS_REL, IMPLICIT_STORY_NOTE,
  runFacts, planFacts, applyGoals, applyAcceptance, factNotes, decisionKeysOf, isWhatDeliverable,
  whatSignal, droppedNotes, answersByQuestion, matchTextOf, wasTruncated, WHAT_SIGNALS, QUESTIONS_REL,
} from "./implicitPlan.ts";
export type {
  ImplicitPlanParts, ImplicitPlanContent, CitedPath, FactMapping, FactPlan,
} from "./implicitPlan.ts";
export type { StoryPatch } from "./storyFile.ts";
export {
  buildDeveloperPrompt, buildReviewerPrompt, epicSummary, touchedInputs, REVIEW_SCHEMA,
  MAX_TOUCHED_BYTES, MAX_TOUCHED_FILES,
} from "./prompts.ts";
export type { DeveloperPromptParts, ReviewerPromptParts } from "./prompts.ts";
export { parseReview, renderReviewLog, renderPreviousAttempt } from "./review.ts";
export type { Review } from "./review.ts";
export { dodGreen, describeOutcome } from "./outcome.ts";
export type { StoryOutcome, DodResult, Verdict, RescuedWork } from "./outcome.ts";
export {
  parseFixFindings, parseFixlistFile, renderFixlist, renderFixlistSection, writeFixlist,
  fixlistRounds, fixlistRel, fixlistStory, latestFixlist, readFixlistAt, openFindings, isOpen,
  fixlistRetroLines, unevidencedClaims, markUnverified,
  CLAIMED_UNVERIFIED, DISPOSITIONS, FIXLIST_DIR, MAX_FIXLIST_ROUNDS,
} from "./fixlist.ts";
export type { FixFinding, Disposition, FixlistParts, FixlistOnDisk, ParsedFixlist } from "./fixlist.ts";
export { renderBuildHandoff } from "./handoff.ts";
export type { BuildHandoffParts, EpicSummaryRow } from "./handoff.ts";
