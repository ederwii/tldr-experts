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

export interface DoctorOptions {
  /** Run `claude mcp list` and list servers. Off by default: it is slow. */
  readonly mcp: boolean;
  readonly manifestPath?: string;
}

export interface DoctorOutcome {
  readonly exitCode: 0 | 1;
  readonly output: string;
  readonly results: readonly ToolCheckResult[];
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorOutcome> {
  const manifest = await loadEnvManifest(options.manifestPath);
  const checker = new ToolChecker();
  const results = await Promise.all(manifest.tools.map((tool) => checker.check(tool)));

  let mcp: McpProbeResult | null = null;
  if (options.mcp) mcp = await new McpProbe().probe();

  const report = new DoctorReport(results, mcp);
  return { exitCode: report.healthy ? 0 : 1, output: report.render(), results };
}
