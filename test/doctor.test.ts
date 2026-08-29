import { describe, expect, test } from "bun:test";
import { runDoctor } from "../src/core/doctor/runDoctor.ts";
import { DoctorReport } from "../src/core/doctor/DoctorReport.ts";
import { loadEnvManifest } from "../src/core/doctor/loadEnvManifest.ts";
import { parseMcpList } from "../src/core/doctor/McpProbe.ts";
import { compareVersions, extractVersion, satisfiesMinimum } from "../src/core/doctor/version.ts";
import type { ToolCheckResult } from "../src/core/doctor/ToolChecker.ts";

describe("env manifest", () => {
  test("the framework's own env.yml loads and validates", async () => {
    const manifest = await loadEnvManifest();
    expect(manifest.tools.length).toBeGreaterThan(0);
    for (const tool of manifest.tools) {
      expect(typeof tool.id).toBe("string");
      expect(typeof tool.check).toBe("string");
      expect(Object.keys(tool.install).length).toBeGreaterThan(0);
    }
  });

  test("it declares claude, bun, node and git as required", async () => {
    const manifest = await loadEnvManifest();
    const required = manifest.tools.filter((t) => t.required).map((t) => t.id).sort();
    expect(required).toEqual(["bun", "claude", "git", "node"]);
  });
});

describe("runDoctor", () => {
  test("exits 0 or 1 and prints the table", async () => {
    const outcome = await runDoctor({ mcp: false });
    expect([0, 1]).toContain(outcome.exitCode);
    expect(outcome.output).toContain("TOOL");
    expect(outcome.output).toContain("REQUIRED");
    expect(outcome.output).toContain("FOUND");
    expect(outcome.output).toContain("MIN");
    expect(outcome.output).toContain("STATUS");
    expect(outcome.output).toContain("INSTALL HINT");
    expect(outcome.results.length).toBeGreaterThan(0);
  }, 30_000);

  test("does not probe MCP unless asked", async () => {
    const outcome = await runDoctor({ mcp: false });
    expect(outcome.output).toContain("MCP servers not probed");
  }, 30_000);

  test("the exit code agrees with the reported blockers", async () => {
    const outcome = await runDoctor({ mcp: false });
    const blocked = outcome.results.some(
      (r) => r.required && r.status !== "ok" && r.status !== "unparsed",
    );
    expect(outcome.exitCode).toBe(blocked ? 1 : 0);
  }, 30_000);
});

function result(over: Partial<ToolCheckResult>): ToolCheckResult {
  return {
    id: "tool", required: true, found: "1.0.0", minVersion: "1.0.0",
    status: "ok", installHint: "install me", purpose: "", ...over,
  };
}

describe("DoctorReport", () => {
  test("a missing required tool makes the report unhealthy", () => {
    const report = new DoctorReport([result({ id: "git", status: "missing", found: null })]);
    expect(report.healthy).toBe(false);
    expect(report.render()).toContain("MISSING");
    expect(report.render()).toContain("install me");
  });

  test("a missing OPTIONAL tool does not", () => {
    const report = new DoctorReport([result({ id: "gh", required: false, status: "missing", found: null })]);
    expect(report.healthy).toBe(true);
    expect(report.render()).toContain("All required tools present");
  });

  test("an outdated required tool is a blocker, not a warning", () => {
    const report = new DoctorReport([result({ found: "0.9.0", status: "outdated" })]);
    expect(report.healthy).toBe(false);
    expect(report.render()).toContain("OUTDATED");
  });
});

describe("version handling", () => {
  test("extracts a version from real --version output", () => {
    expect(extractVersion("1.3.14")).toBe("1.3.14");
    expect(extractVersion("v22.20.0")).toBe("22.20.0");
    expect(extractVersion("git version 2.50.1 (Apple Git-155)")).toBe("2.50.1");
    expect(extractVersion("Python 3.14.2")).toBe("3.14.2");
    expect(extractVersion("2.1.251 (Claude Code)")).toBe("2.1.251");
    expect(extractVersion("no numbers here")).toBeNull();
  });

  test("compares versions segment by segment", () => {
    expect(compareVersions("1.3.14", "1.3.0")).toBeGreaterThan(0);
    expect(compareVersions("1.3", "1.3.0")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.0")).toBeGreaterThan(0);
  });

  test("a null minimum always passes; a null found version never does", () => {
    expect(satisfiesMinimum(null, null)).toBe(true);
    expect(satisfiesMinimum("1.0.0", null)).toBe(true);
    expect(satisfiesMinimum(null, "1.0.0")).toBe(false);
  });
});

describe("parseMcpList", () => {
  test("parses `name: <transport> - <status>` lines", () => {
    const servers = parseMcpList(
      [
        "Checking MCP server health...",
        "",
        "context7: https://mcp.context7.com/mcp (HTTP) - ✓ Connected",
        "postgres-local: uvx postgres-mcp - ✗ Failed to connect",
      ].join("\n"),
    );
    expect(servers).toHaveLength(2);
    expect(servers[0]?.name).toBe("context7");
    expect(servers[0]?.status).toContain("Connected");
    expect(servers[1]?.name).toBe("postgres-local");
    expect(servers[1]?.status).toContain("Failed");
  });

  test("returns nothing for output with no server lines", () => {
    expect(parseMcpList("No MCP servers configured.")).toHaveLength(0);
  });
});
