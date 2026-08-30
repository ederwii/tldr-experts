/** Schema for `tldrx-work/<run>/run.yml` — THE execution path and resume point. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  requireVersion, result, isRecord, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

export const RUN_STATUSES = [
  "pending", "running", "awaiting-answer", "awaiting-gate", "blocked", "done", "abandoned",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunPhase {
  readonly id: string;
  readonly stage: string;
  readonly status: RunStatus;
  readonly expert?: string | null;
  readonly model?: string | null;
  readonly cost_usd?: number;
  readonly started_at?: string | null;
  readonly ended_at?: string | null;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
}

export interface Run {
  /**
   * `version: 1`. A file still saying `schema_version` loads and is reported;
   * see `requireVersion` in `./validation.ts`.
   */
  readonly version: number;
  /** @deprecated the pre-spec spelling of `version`. Accepted for one release. */
  readonly schema_version?: number;
  readonly run_id: string;
  readonly scope: string;
  readonly workflow: string;
  readonly status: RunStatus;
  readonly budget_usd: number;
  readonly created_at?: string | null;
  readonly phases: readonly RunPhase[];
}

export function validateRun(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const deprecations: string[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireVersion(doc, issues, deprecations);
  requireKeys(doc, ["run_id", "scope", "workflow", "status", "budget_usd", "phases"], "", issues);
  requireString(doc.run_id, "run_id", issues);
  requireString(doc.scope, "scope", issues);
  requireString(doc.workflow, "workflow", issues);
  requireEnum(doc.status, RUN_STATUSES, "status", issues);
  requireNumber(doc.budget_usd, "budget_usd", issues);

  if (requireArray(doc.phases, "phases", issues)) {
    (doc.phases as unknown[]).forEach((phase, i) => {
      const path = `phases[${i}]`;
      if (!isRecord(phase)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(phase, ["id", "stage", "status"], path, issues);
      requireEnum(phase.status, RUN_STATUSES, `${path}.status`, issues);
    });
  }
  return result(issues, deprecations);
}
