export { detectWorkspace } from "./detectWorkspace.ts";
export { findRepos, isGitRepo, type FoundRepos } from "./findRepos.ts";
export { detectStack, type StackDetection, type PackageJson } from "./stack.ts";
export { detectCommands, isSingleArgvCommand, type DetectedCommands } from "./commands.ts";
export { detectCi } from "./ci.ts";
export { detectDefaultBranch, FALLBACK_BRANCH, type DefaultBranch } from "./defaultBranch.ts";
export { scoreConfidence } from "./confidence.ts";
export { gapSrc } from "./gapSrc.ts";
export { CODE_EXTENSIONS, countCodeFiles, isCodeFile, extensionOf } from "./codeFiles.ts";
export { isGreenfield, workspaceMode } from "./greenfield.ts";
export { repoSlug, uniqueSlug } from "./repoSlug.ts";
export { walkFiles, readEntries, toPosix, SKIPPED_DIRS, type WalkedFile } from "./walk.ts";
export { lineOf, countLines } from "./lineOf.ts";
export { SpawnCommandRunner, type CommandRunner, type CommandResult } from "./CommandRunner.ts";
export {
  COMMAND_SLOTS, CONFIDENCE_LEVELS, WORKSPACE_MODES,
  type CommandSlot, type Confidence, type DetectedMode, type DetectedRepo,
  type DetectedWorkspace, type Evidence, type RepoCommands,
} from "./types.ts";
