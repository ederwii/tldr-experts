export { runDoctor, type DoctorOptions, type DoctorOutcome } from "./runDoctor.ts";
export { DoctorReport } from "./DoctorReport.ts";
export { ToolChecker, type ToolCheckResult, type ToolStatus } from "./ToolChecker.ts";
export { McpProbe, parseMcpList, type McpServer, type McpProbeResult } from "./McpProbe.ts";
export { loadEnvManifest } from "./loadEnvManifest.ts";
export { findLegacyVersionFiles } from "./legacyVersionKeys.ts";
export {
  describeRule,
  findGitignoreShadows,
  parseCheckIgnoreZ,
  probePaths,
  LOG_PROBE_NAME,
  type GitignoreShadowResult,
  type ShadowedPath,
} from "./gitignoreShadow.ts";
export { extractVersion, compareVersions, satisfiesMinimum } from "./version.ts";
