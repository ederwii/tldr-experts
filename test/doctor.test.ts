import { describe, expect, test } from "bun:test";
import { runDoctor } from "../src/core/doctor/runDoctor.ts";
import { doctorJson } from "../src/cli/commands/doctor.ts";
import { DoctorReport } from "../src/core/doctor/DoctorReport.ts";
import { loadEnvManifest } from "../src/core/doctor/loadEnvManifest.ts";
import { parseMcpList } from "../src/core/doctor/McpProbe.ts";
import { compareVersions, extractVersion, satisfiesMinimum } from "../src/core/doctor/version.ts";
import type { ToolCheckResult } from "../src/core/doctor/ToolChecker.ts";
import { findLegacyVersionFiles } from "../src/core/doctor/legacyVersionKeys.ts";
import { noteDeprecations, resetDeprecationNotices, validate } from "../src/core/schemas/index.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("tldrx doctor --json", () => {
  test("the same findings as the table, as data a script can read", async () => {
    const outcome = await runDoctor({ mcp: false });
    const parsed = JSON.parse(doctorJson(outcome)) as {
      healthy: boolean;
      tools: { id: string; required: boolean; status: string; installHint: string | null }[];
      mcp: unknown;
    };
    expect(parsed.healthy).toBe(outcome.exitCode === 0);
    expect(parsed.tools.map((tool) => tool.id).sort()).toEqual(outcome.results.map((r) => r.id).sort());
    for (const tool of parsed.tools) {
      // Every id and status in the JSON is one the table printed too.
      expect(outcome.output).toContain(tool.id);
      // A hint is only carried when there is something to fix.
      if (tool.status === "ok") expect(tool.installHint).toBeNull();
    }
  });

  // "not probed" and "no servers" are different claims and must not share a shape.
  test("mcp is null when --mcp was not passed, not an empty list", async () => {
    const outcome = await runDoctor({ mcp: false });
    expect(outcome.mcp).toBeNull();
    expect((JSON.parse(doctorJson(outcome)) as { mcp: unknown }).mcp).toBeNull();
  });
});

/**
 * The deprecated version key, and how a workspace finds out (2026-08-29).
 *
 * `schema_version:` still loads for one release; this is the report that tells a
 * team what to rename before it stops. Warning only — `healthy` is about the
 * TOOLS this machine has, and a key spelling is not one of them.
 */
describe("doctor reports files still on `schema_version:`", () => {
  function workspace(files: Readonly<Record<string, string>>): { root: string; dispose(): void } {
    const root = mkdtempSync(join(tmpdir(), "tldrx-legacy-key-"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), body, "utf8");
    }
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
  }

  const MODERN = "version: 1\nmode: single\nroot: .\nrepos: []\n";
  const LEGACY = "schema_version: 0\nmode: single\nroot: .\nrepos: []\n";

  test("it names each one, workspace-relative and sorted", () => {
    const ws = workspace({
      ".tldrx/workspace.yml": LEGACY,
      ".tldrx/process.yml": "schema_version: 0\nmethodology: none\n",
      ".tldrx/experts/api/competencies.yml": "schema_version: 0\nexpert: api\nareas: []\n",
      "tldrx-work/260830-x/run.yml": "schema_version: 0\nrun: 260830-x\n",
      "tldrx-work/260830-x/budget.yml": "version: 1\nrun: 260830-x\n",
    });
    try {
      expect(findLegacyVersionFiles(ws.root)).toEqual([
        ".tldrx/experts/api/competencies.yml",
        ".tldrx/process.yml",
        ".tldrx/workspace.yml",
        "tldrx-work/260830-x/run.yml",
      ]);
    } finally {
      ws.dispose();
    }
  });

  test("a file carrying BOTH keys is already correct — `version` is what is read", () => {
    const ws = workspace({ ".tldrx/workspace.yml": `version: 1\nschema_${"version"}: 0\nmode: single\n` });
    try {
      expect(findLegacyVersionFiles(ws.root)).toEqual([]);
    } finally {
      ws.dispose();
    }
  });

  test("a modern workspace reports clean, and the finding never changes the exit code", async () => {
    const ws = workspace({ ".tldrx/workspace.yml": MODERN });
    try {
      expect(findLegacyVersionFiles(ws.root)).toEqual([]);
      const clean = await runDoctor({ mcp: false, root: ws.root });
      expect(clean.output).toContain("every file says `version: 1`");

      writeFileSync(join(ws.root, ".tldrx", "workspace.yml"), LEGACY, "utf8");
      const dirty = await runDoctor({ mcp: false, root: ws.root });
      expect(dirty.output).toContain("Deprecated `schema_version:` in 1 file(s)");
      expect(dirty.output).toContain(".tldrx/workspace.yml");
      expect(dirty.exitCode).toBe(clean.exitCode);
      expect(dirty.healthy).toBe(clean.healthy);
      expect(JSON.parse(doctorJson(dirty)).legacyVersionFiles).toEqual([".tldrx/workspace.yml"]);
    } finally {
      ws.dispose();
    }
  }, 60_000);

  test("outside a workspace the report says NOT SCANNED, not `nothing found`", async () => {
    const outcome = await runDoctor({ mcp: false });
    expect(outcome.legacyVersionFiles).toBeNull();
    expect(outcome.output).toContain("no workspace here");
  }, 30_000);
});

/** The stderr line a loader prints, once per file per process. */
describe("the schema_version stderr notice", () => {
  test("`<file>: schema_version is deprecated — say version: 1`, and not twice", () => {
    resetDeprecationNotices();
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      const legacy = validate("workspace", { schema_version: 0, mode: "single", root: ".", repos: [] });
      noteDeprecations("/w/.tldrx/workspace.yml", legacy);
      noteDeprecations("/w/.tldrx/workspace.yml", legacy);
      noteDeprecations("/w/.tldrx/process.yml", legacy);
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    expect(written).toEqual([
      "/w/.tldrx/workspace.yml: schema_version is deprecated — say version: 1\n",
      "/w/.tldrx/process.yml: schema_version is deprecated — say version: 1\n",
    ]);
  });

  test("a `version: 1` file says nothing", () => {
    resetDeprecationNotices();
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      noteDeprecations("/w/.tldrx/workspace.yml", validate("workspace", {
        version: 1, mode: "single", root: ".", repos: [],
      }));
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    expect(written).toEqual([]);
  });
});
