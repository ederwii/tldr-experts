/** Schema for `.tldrx/workspace.yml` — what `tldrx init` detected. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  requireVersion, result, isRecord, type ValidationIssue, type ValidationResult,
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

/**
 * `seed_triage:` — optional tuning for `tldrx seed triage` (spec §6.2).
 *
 * Additive and absent from everything `tldrx init` writes: a workspace that never
 * sets it gets the built-in 20,000-token threshold, and every reader that never
 * heard of the key is unaffected.
 */
export interface SeedTriageSettings {
  readonly threshold_tokens?: number;
}

export interface Workspace {
  /**
   * `version: 1`. A file still saying `schema_version` loads and is reported;
   * see `requireVersion` in `./validation.ts`.
   */
  readonly version: number;
  /** @deprecated the pre-spec spelling of `version`. Accepted for one release. */
  readonly schema_version?: number;
  readonly mode: WorkspaceMode;
  readonly root: string;
  readonly repos: readonly DetectedRepo[];
  readonly detected_at?: string | null;
  readonly mcp_servers?: readonly string[];
  readonly seed_triage?: SeedTriageSettings;
}

export function validateWorkspace(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["mode", "root", "repos"], "", issues);
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

  if (doc.seed_triage !== undefined) {
    if (isRecord(doc.seed_triage)) {
      const tokens = doc.seed_triage.threshold_tokens;
      requireNumber(tokens, "seed_triage.threshold_tokens", issues);
      if (typeof tokens === "number" && (!Number.isFinite(tokens) || tokens <= 0)) {
        issues.push({ path: "seed_triage.threshold_tokens", message: "must be a positive number of tokens" });
      }
    } else {
      issues.push({ path: "seed_triage", message: "expected a mapping" });
    }
  }
  return result(issues, deprecations);
}
