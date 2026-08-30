/** Renders the `tldrx doctor` table. Pure string building — no I/O, no exits. */
import type { ToolCheckResult } from "./ToolChecker.ts";
import type { McpProbeResult } from "./McpProbe.ts";

const HEADERS = ["TOOL", "REQUIRED", "FOUND", "MIN", "STATUS", "INSTALL HINT"] as const;

const STATUS_LABEL: Readonly<Record<ToolCheckResult["status"], string>> = {
  ok: "ok",
  outdated: "OUTDATED",
  missing: "MISSING",
  unparsed: "present?",
};

export class DoctorReport {
  constructor(
    private readonly results: readonly ToolCheckResult[],
    private readonly mcp: McpProbeResult | null = null,
    private readonly legacyVersionFiles: readonly string[] | null = null,
  ) {}

  /** True when every REQUIRED tool is present and at or above its min_version. */
  get healthy(): boolean {
    return this.blockers.length === 0;
  }

  get blockers(): readonly ToolCheckResult[] {
    return this.results.filter((r) => r.required && r.status !== "ok" && r.status !== "unparsed");
  }

  render(): string {
    const rows = this.results.map((r) => [
      r.id,
      r.required ? "yes" : "no",
      r.found ?? "-",
      r.minVersion ?? "-",
      STATUS_LABEL[r.status],
      r.status === "ok" ? "" : r.installHint,
    ]);

    const lines: string[] = ["tldrx doctor — local environment", "", this.table(rows), ""];

    if (this.blockers.length === 0) {
      lines.push("All required tools present. ✓");
    } else {
      lines.push(`Missing or outdated REQUIRED tools: ${this.blockers.map((b) => b.id).join(", ")}`);
      lines.push("The framework never installs anything — run the install hints above yourself.");
    }

    if (this.mcp) lines.push("", ...this.renderMcp(this.mcp));
    else lines.push("", "MCP servers not probed. Re-run with --mcp (may take 30s+; runs live health checks).");

    lines.push("", ...this.renderLegacyVersions());

    return lines.join("\n");
  }

  /**
   * `schema_version:` still loads, and stops loading after the next release.
   * A file on the old key is a warning, never a blocker: `healthy` is about the
   * TOOLS this machine has, and renaming a key is not one of them.
   */
  private renderLegacyVersions(): string[] {
    if (this.legacyVersionFiles === null) return ["Schema keys: no workspace here — nothing scanned."];
    if (this.legacyVersionFiles.length === 0) return ["Schema keys: every file says `version: 1`. \u2713"];
    return [
      `Deprecated \`schema_version:\` in ${String(this.legacyVersionFiles.length)} file(s) — say \`version: 1\` instead:`,
      ...this.legacyVersionFiles.map((path) => `  ${path}`),
      "They still load today. Support goes after the next release.",
    ];
  }

  private renderMcp(mcp: McpProbeResult): string[] {
    if (!mcp.ran) return [`MCP servers: could not run \`claude mcp list\` (${mcp.error ?? "unknown error"})`];
    if (mcp.servers.length === 0) return [`MCP servers: none listed (${mcp.error ?? "no output"})`];
    const width = Math.max(...mcp.servers.map((s) => s.name.length));
    return [
      "MCP servers (from `claude mcp list`):",
      ...mcp.servers.map((s) => `  ${s.name.padEnd(width)}  ${s.transport}  ${s.status}`),
    ];
  }

  private table(rows: readonly (readonly string[])[]): string {
    const all = [HEADERS as readonly string[], ...rows];
    const widths = HEADERS.map((_, col) => Math.max(...all.map((row) => (row[col] ?? "").length)));
    const line = (row: readonly string[]): string =>
      row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd();
    const divider = widths.map((w) => "-".repeat(w)).join("  ");
    return [line(HEADERS), divider, ...rows.map(line)].join("\n");
  }
}
