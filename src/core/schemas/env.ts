/**
 * Schema for `env.yml` — the local dev environment manifest that `tldrx doctor` runs.
 * The framework never installs anything: `install` holds a hint string per OS.
 */
import {
  asDocument, requireArray, requireKeys, requireString,
  requireVersion, result, isRecord, type ValidationIssue, type ValidationResult,
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
  /**
   * `version: 1`. A file still saying `schema_version` loads and is reported;
   * see `requireVersion` in `./validation.ts`.
   */
  readonly version: number;
  /** @deprecated the pre-spec spelling of `version`. Accepted for one release. */
  readonly schema_version?: number;
  readonly tools: readonly EnvTool[];
}

export function validateEnv(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["tools"], "", issues);

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
  return result(issues, deprecations);
}
