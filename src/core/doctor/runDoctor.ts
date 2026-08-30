/**
 * `tldrx doctor` — the one command in v0 that does real work.
 *
 * Reads the env.yml manifest, runs each tool's declared `check` command, and
 * prints a table. Exit code 0 when every REQUIRED tool is present and meets its
 * min_version; 1 otherwise.
 */
import { loadEnvManifest } from "./loadEnvManifest.ts";
import { ToolChecker, type ToolCheckResult } from "./ToolChecker.ts";
import { McpProbe, type McpProbeResult } from "./McpProbe.ts";
import { DoctorReport } from "./DoctorReport.ts";
import { findLegacyVersionFiles } from "./legacyVersionKeys.ts";

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
  readonly healthy: boolean;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorOutcome> {
  const manifest = await loadEnvManifest(options.manifestPath);
  const checker = new ToolChecker();
  const results = await Promise.all(manifest.tools.map((tool) => checker.check(tool)));

  let mcp: McpProbeResult | null = null;
  if (options.mcp) mcp = await new McpProbe().probe();

  const root = options.root ?? null;
  const legacyVersionFiles = root === null ? null : findLegacyVersionFiles(root);

  const report = new DoctorReport(results, mcp, legacyVersionFiles);
  return {
    exitCode: report.healthy ? 0 : 1,
    output: report.render(),
    results,
    mcp,
    legacyVersionFiles,
    healthy: report.healthy,
  };
}
