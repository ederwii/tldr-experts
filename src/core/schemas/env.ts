/**
 * Schema for `env.yml` — the local dev environment manifest that `tldrx doctor` runs.
 * The framework never installs anything: `install` holds a hint string per OS.
 */
import {
  asDocument, requireArray, requireKeys, requireNumber, requireString,
  result, isRecord, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export interface EnvTool {
  readonly id: string;
  readonly required: boolean;
  readonly check: string;
  readonly min_version?: string | null;
  readonly purpose?: string;
  readonly install: Readonly<Record<string, string>>;
}

export interface EnvManifest {
  readonly schema_version: number;
  readonly tools: readonly EnvTool[];
}

export function validateEnv(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, ["schema_version", "tools"], "", issues);
  requireNumber(doc.schema_version, "schema_version", issues);

  if (requireArray(doc.tools, "tools", issues)) {
    (doc.tools as unknown[]).forEach((tool, i) => {
      const path = `tools[${i}]`;
      if (!isRecord(tool)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(tool, ["id", "required", "check", "install"], path, issues);
      requireString(tool.id, `${path}.id`, issues);
      requireString(tool.check, `${path}.check`, issues);
      if (tool.required !== undefined && typeof tool.required !== "boolean") {
        issues.push({ path: `${path}.required`, message: "expected a boolean" });
      }
      if (tool.install !== undefined && !isRecord(tool.install)) {
        issues.push({ path: `${path}.install`, message: "expected a mapping of os -> hint" });
      }
    });
  }
  return result(issues);
}
