/** Schema for `.tldrx/workspace.yml` — what `tldrx init` detected. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireString,
  result, isRecord, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export const WORKSPACE_MODES = ["single", "multi"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface DetectedRepo {
  readonly name: string;
  readonly path: string;
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly commands?: Readonly<Record<string, string>>;
}

export interface Workspace {
  readonly schema_version: number;
  readonly mode: WorkspaceMode;
  readonly root: string;
  readonly repos: readonly DetectedRepo[];
  readonly detected_at?: string | null;
  readonly mcp_servers?: readonly string[];
}

export function validateWorkspace(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, ["schema_version", "mode", "root", "repos"], "", issues);
  requireEnum(doc.mode, WORKSPACE_MODES, "mode", issues);
  requireString(doc.root, "root", issues);

  if (requireArray(doc.repos, "repos", issues)) {
    (doc.repos as unknown[]).forEach((repo, i) => {
      const path = `repos[${i}]`;
      if (!isRecord(repo)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(repo, ["name", "path"], path, issues);
    });
  }
  return result(issues);
}
