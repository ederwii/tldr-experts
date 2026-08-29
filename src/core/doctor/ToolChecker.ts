/**
 * Runs one tool's `check` command and reports what was actually found.
 *
 * Evidence discipline: the reported version is whatever the tool PRINTED. We
 * never infer presence from a path lookup, and we never report "ok" for a
 * command that exited non-zero.
 */
import type { EnvTool } from "../schemas/env.ts";
import { extractVersion, satisfiesMinimum } from "./version.ts";

export type ToolStatus = "ok" | "outdated" | "missing" | "unparsed";

export interface ToolCheckResult {
  readonly id: string;
  readonly required: boolean;
  readonly found: string | null;
  readonly minVersion: string | null;
  readonly status: ToolStatus;
  readonly installHint: string;
  readonly purpose: string;
}

export class ToolChecker {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async check(tool: EnvTool): Promise<ToolCheckResult> {
    const minVersion = tool.min_version ?? null;
    const installHint = this.installHint(tool);
    const purpose = tool.purpose ?? "";

    let stdout = "";
    let stderr = "";
    let exitCode = 127;

    try {
      const proc = Bun.spawn(["sh", "-c", tool.check], { stdout: "pipe", stderr: "pipe" });
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      exitCode = await proc.exited;
    } catch {
      exitCode = 127;
    }

    if (exitCode !== 0) {
      return { id: tool.id, required: tool.required, found: null, minVersion, status: "missing", installHint, purpose };
    }

    const found = extractVersion(stdout + "\n" + stderr);
    if (found === null) {
      // The command succeeded but printed nothing version-shaped. The tool is
      // present; we simply cannot assert which version. That is not "ok".
      return { id: tool.id, required: tool.required, found: null, minVersion, status: "unparsed", installHint, purpose };
    }

    const status: ToolStatus = satisfiesMinimum(found, minVersion) ? "ok" : "outdated";
    return { id: tool.id, required: tool.required, found, minVersion, status, installHint, purpose };
  }

  private installHint(tool: EnvTool): string {
    const key = this.osKey();
    return tool.install[key] ?? tool.install.all ?? "";
  }

  private osKey(): string {
    if (this.platform === "darwin") return "macos";
    if (this.platform === "win32") return "windows";
    return "linux";
  }
}
