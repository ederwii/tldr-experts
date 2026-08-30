export { findWorkspaceRoot, resolveWorkspaceRoot } from "./workspaceRoot.ts";
export { loadExperts, loadExpert, expertsDir, expertDir, COMPETENCIES_FILE, EXPERT_FILE, EXPERTS_DIRNAME } from "./loadExperts.ts";
export { starChart, starChartLine, stars, evidenceNote, MAX_LEVEL } from "./starChart.ts";
export { renderExpertList, expertListJson, driftWarnings, evidenceWarnings, evidenceCount, levelSummary } from "./renderExpertList.ts";
export { readEvidenceRows, ignoredRowWarnings } from "./readEvidenceRows.ts";
export type { EvidenceRows, IgnoredRow } from "./readEvidenceRows.ts";
export { checkEvidenceSrc, describeSrcProblem, EXPECTED_SRC } from "./evidenceSrc.ts";
export type { IgnoredReason, SrcProblem } from "./evidenceSrc.ts";
export { createExpert, planAreas, renderExpertMarkdown, EXPERT_NAME_RE } from "./createExpert.ts";
export {
  ROLE_EXPERTS, ROLE_AREA_TITLES, ROLE_TEMPLATES_DIR, isRoleExpert, hasRoleTemplate,
  roleTemplatePath, readRoleTemplate, renderRoleExpert,
} from "./roleExperts.ts";
export type { RoleRenderOptions } from "./roleExperts.ts";
export { readExpertDocument, splitFrontMatter, section } from "./expertDocument.ts";
export { renderTrainPrompt, isTrainMode, TRAIN_MODES } from "./trainPrompt.ts";
export { EXPERT_STATUSES } from "./ExpertRecord.ts";
export type { ExpertRecord, AreaRecord, ExpertStatus } from "./ExpertRecord.ts";
export type { CreateExpertOptions, CreatedExpert } from "./createExpert.ts";
export type { ExpertDocument } from "./expertDocument.ts";
export type { TrainMode, TrainPromptInput, TrainRepo } from "./trainPrompt.ts";

// --- the knowledge wave: selection, trained knowledge, and stage coverage ---
export { stackExpertNames } from "./stackExperts.ts";
export { readExpertDomain, domainPaths, normalisePath, pathsIntersect, parseList } from "./expertDomain.ts";
export type { ExpertDomain } from "./expertDomain.ts";
export {
  selectExperts, expertNames, matchedPath, MAX_DOMAIN_SELECTED, LEGACY_STAGE_EXPERTS,
} from "./selectExperts.ts";
export type { ExpertReason, ExpertSelection, SelectedExpert, SelectExpertsInput } from "./selectExperts.ts";
export {
  loadExpertKnowledge, readKnowledgeFiles, truncateAtHeading, countFindings, chartLines,
  byteLength, DEFAULT_KNOWLEDGE_MAX_BYTES, KNOWLEDGE_DIRNAME,
} from "./expertKnowledge.ts";
export type { ExpertKnowledge, KnowledgeFileView, KnowledgeOptions } from "./expertKnowledge.ts";
export { loadExpertBundles, describeBundles, untrainedNotes, LEGACY_NOTE } from "./expertBundle.ts";
export type { ExpertBundle, ExpertBundleSet, LoadBundlesInput } from "./expertBundle.ts";
export { stagesLoadingExperts, describeStageLoads, stageIds } from "./stageCoverage.ts";
export type { StageLoad } from "./stageCoverage.ts";
export type { StageLoads } from "./renderExpertList.ts";
export { nearbyPathsFor, graphPath, MAX_GRAPH_BYTES } from "./domainRank.ts";
export {
  sharedCitations, sharedCitationWarnings, type SharedCitation,
} from "./sharedCitations.ts";
