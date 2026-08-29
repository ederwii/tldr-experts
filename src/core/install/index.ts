export {
  applyInstall, chainStatusLineHint, claudeDirFor, findGitRoot, InstallError, planInstall,
  renderInstallSummary,
} from "./installClaude.ts";
export type {
  ChangeAction, FileChange, InstallOptions, InstallPlan, InstallScope,
} from "./installClaude.ts";
export { mergeSettings, unmergeSettings } from "./mergeSettings.ts";
export type { MergeOptions, MergeResult, StatusLineOutcome, UnmergeResult } from "./mergeSettings.ts";
export {
  HOOK_COMMAND_PREFIX, HOOK_SCRIPTS, MANAGED_HOOKS, RUNNABLE_SCRIPTS, STATUSLINE_COMMAND,
  STATUSLINE_SCRIPT, entryFor, hookCommand, isManagedCommand, statusLineValue,
} from "./managedEntries.ts";
export type { HookScript, ManagedHook } from "./managedEntries.ts";
export { isManagedSkill, managedSkill, SKILL_MARKER, SKILL_RELATIVE } from "./skillFile.ts";
export {
  DEFAULT_FORMAT, detectFormat, handlersOf, parseSettings, serializeSettings, SettingsError,
} from "./ClaudeSettings.ts";
export type {
  ClaudeSettings, HookEntry, HookHandler, LoadedSettings, SettingsFormat, StatusLine,
} from "./ClaudeSettings.ts";
