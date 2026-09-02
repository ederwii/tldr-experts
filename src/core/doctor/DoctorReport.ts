/** Renders the `tldrx doctor` table. Pure string building — no I/O, no exits. */
import { FRAMEWORK_ROOT } from "../paths.ts";
import type { ToolCheckResult } from "./ToolChecker.ts";
import type { McpProbeResult } from "./McpProbe.ts";
import { describeRule, type GitignoreShadowResult } from "./gitignoreShadow.ts";
import { WORKSPACE_YML_REL, type DefaultBranchAudit } from "./recordedDefaultBranch.ts";

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
    private readonly gitignoreShadow: GitignoreShadowResult | null = null,
    private readonly defaultBranches: DefaultBranchAudit | null = null,
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

    // Where the framework's OWN files are, said once, in the one command whose
    // job is "what does this machine actually have". Measured 2026-08-30: a real
    // session spent 1m22s on `find / -name build -type d -path "*stages*"`
    // looking for `stages/build/`, because nothing printed the answer.
    const lines: string[] = [
      "tldrx doctor — local environment",
      "",
      `framework  ${FRAMEWORK_ROOT}  (stages/, workflows/, templates/ ship here; `
        + "a project's overrides live in .tldrx/stages/ and .tldrx/workflows/)",
      "",
      this.table(rows),
      "",
    ];

    if (this.blockers.length === 0) {
      lines.push("All required tools present. ✓");
    } else {
      lines.push(`Missing or outdated REQUIRED tools: ${this.blockers.map((b) => b.id).join(", ")}`);
      lines.push("The framework never installs anything — run the install hints above yourself.");
    }

    if (this.mcp) lines.push("", ...this.renderMcp(this.mcp));
    else lines.push("", "MCP servers not probed. Re-run with --mcp (may take 30s+; runs live health checks).");

    lines.push("", ...this.renderLegacyVersions());
    lines.push("", ...this.renderGitignoreShadow());
    lines.push("", ...this.renderDefaultBranches());

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

  /**
   * Committed state a `.gitignore` rule is swallowing.
   *
   * A warning, never a blocker: `healthy` is about the TOOLS this machine has.
   * But it is loud, because the failure it reports is silent — the file gets
   * written, `git status` says nothing, and the teammate who clones never sees it.
   */
  private renderGitignoreShadow(): string[] {
    const shadow = this.gitignoreShadow;
    if (shadow === null) return ["State files vs .gitignore: no workspace here — nothing probed."];
    if (!shadow.ran) {
      return [`State files vs .gitignore: could not run \`git check-ignore\` (${shadow.error ?? "unknown error"})`];
    }
    if (shadow.shadowed.length === 0) {
      return [`State files vs .gitignore: ${String(shadow.probed.length)} probed, none ignored. \u2713`];
    }
    const width = Math.max(...shadow.shadowed.map((s) => s.path.length));
    const n = shadow.shadowed.length;
    return [
      `Gitignore shadow: ${String(n)} of ${String(shadow.probed.length)} probed state `
        + `${n === 1 ? "paths is" : "paths are"} IGNORED. tldrx state is committed state (spec §1):`,
      ...shadow.shadowed.map((s) => `  ${s.path.padEnd(width)}  ignored by  ${describeRule(s)}`),
      "Re-run `tldrx init` to refresh the `# >>> tldrx >>>` block, whose negations re-include them,",
      "or delete the rule. This does not change the exit code.",
    ];
  }

  /**
   * A `default_branch` the workspace RECORDS and the repo cannot find (gh #92).
   *
   * A warning, never a blocker, for the same reason as the two above: `healthy`
   * is about the TOOLS this machine has. It is loud anyway, because the failure
   * it reports is silent everywhere else — Watch refuses with one line about one
   * repo, and `boundary` just says `n/a` at every Build gate for as long as the
   * record stays wrong.
   */
  private renderDefaultBranches(): string[] {
    const audit = this.defaultBranches;
    if (audit === null) return ["Recorded default branches: no workspace here — nothing probed."];
    if (!audit.ran) {
      return [`Recorded default branches: not probed (${audit.error ?? "unknown error"})`];
    }
    const skippedPart = audit.skipped.map((row) => `  skipped ${row.repo}: ${row.reason}`);
    if (audit.unresolved.length === 0) {
      return [
        `Recorded default branches: ${String(audit.probed.length)} probed, all resolve. \u2713`,
        ...skippedPart,
      ];
    }
    const width = Math.max(...audit.unresolved.map((row) => row.repo.length));
    const n = audit.unresolved.length;
    return [
      `Recorded default branch: ${String(n)} of ${String(audit.probed.length)} probed repos `
        + `${n === 1 ? "records" : "record"} a \`default_branch\` its checkout cannot find:`,
      ...audit.unresolved.map((row) =>
        `  ${row.repo.padEnd(width)}  ${WORKSPACE_YML_REL} records \`${row.branch}\`  —  ${row.detail}`),
      ...skippedPart,
      "Watch REFUSES to diff a feature against a base that is not there, and `boundary` reports n/a",
      `at every Build gate while this is wrong. Fix \`default_branch:\` in ${WORKSPACE_YML_REL}, or`,
      "fetch the branch into the repo. This does not change the exit code.",
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
