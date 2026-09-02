/**
 * `tldrx doctor` — the one command in v0 that does real work.
 *
 * Reads the env.yml manifest, runs each tool's declared `check` command, and
 * prints a table. Exit code 0 when every REQUIRED tool is present and meets its
 * min_version; 1 otherwise.
 *
 * Three warnings ride along and NONE moves the exit code, because the exit code
 * is about the tools this machine has: files still on the deprecated
 * `schema_version:` key, committed state a `.gitignore` rule is swallowing, and
 * a repo whose RECORDED `default_branch` its own checkout cannot find (gh #92).
 */
import { loadEnvManifest } from "./loadEnvManifest.ts";
import { ToolChecker, type ToolCheckResult } from "./ToolChecker.ts";
import { McpProbe, type McpProbeResult } from "./McpProbe.ts";
import { DoctorReport } from "./DoctorReport.ts";
import { findLegacyVersionFiles } from "./legacyVersionKeys.ts";
import { findGitignoreShadows, type GitignoreShadowResult } from "./gitignoreShadow.ts";
import { findUnresolvedDefaultBranches, type DefaultBranchAudit } from "./recordedDefaultBranch.ts";
import { agentProvider, type AgentProvider } from "../facilitator/spawnAgent.ts";
import type { EnvTool } from "../schemas/env.ts";

export interface DoctorOptions {
  /** Run `claude mcp list` and list servers. Off by default: it is slow. */
  readonly mcp: boolean;
  readonly manifestPath?: string;
  /**
   * Workspace root to scan for deprecated `schema_version:` keys. `null`/absent
   * means "no workspace here", which is not the same claim as "nothing to fix" —
   * the report says which one it is.
   */
  readonly root?: string | null;
}

export interface DoctorOutcome {
  readonly exitCode: 0 | 1;
  readonly output: string;
  readonly results: readonly ToolCheckResult[];
  /** Null when `--mcp` was not passed: "not probed" is not "none found". */
  readonly mcp: McpProbeResult | null;
  /** Workspace-relative paths still on `schema_version:`. Null when not scanned. */
  readonly legacyVersionFiles: readonly string[] | null;
  /**
   * Committed state files a `.gitignore` rule is swallowing. Null when there is
   * no workspace to ask about — again not the same claim as "nothing is wrong".
   */
  readonly gitignoreShadow: GitignoreShadowResult | null;
  /**
   * Repos whose `default_branch` in `.tldrx/workspace.yml` does not resolve in
   * the repo (gh #92). Null when there is no workspace to ask about — once more
   * not the same claim as "every record is true".
   */
  readonly defaultBranches: DefaultBranchAudit | null;
  readonly healthy: boolean;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorOutcome> {
  const manifest = await loadEnvManifest(options.manifestPath);
  const checker = new ToolChecker();
  const results = await Promise.all(providerTools(manifest.tools, agentProvider()).map((tool) => checker.check(tool)));

  let mcp: McpProbeResult | null = null;
  if (options.mcp) mcp = await new McpProbe().probe();

  const root = options.root ?? null;
  const legacyVersionFiles = root === null ? null : findLegacyVersionFiles(root);
  const gitignoreShadow = root === null ? null : await findGitignoreShadows(root);
  const defaultBranches = root === null ? null : await findUnresolvedDefaultBranches(root);

  const report = new DoctorReport(results, mcp, legacyVersionFiles, gitignoreShadow, defaultBranches);
  return {
    exitCode: report.healthy ? 0 : 1,
    output: report.render(),
    results,
    mcp,
    legacyVersionFiles,
    gitignoreShadow,
    defaultBranches,
    healthy: report.healthy,
  };
}

/** Only the selected automated runner is required; both remain visible in the report. */
export function providerTools(tools: readonly EnvTool[], provider: AgentProvider): readonly EnvTool[] {
  return tools.map((tool) => {
    if (tool.id === "claude") return { ...tool, required: provider === "claude" };
    if (tool.id === "codex") return { ...tool, required: provider === "codex" };
    return tool;
  });
}
