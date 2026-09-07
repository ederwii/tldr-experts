/** Schema for `.tldrx/workspace.yml` — what `tldrx init` detected. */
import {
  asDocument, requireArray, requireEnum, requireKeys, requireNumber, requireString,
  requireVersion, result, isRecord, type ValidationIssue, type ValidationResult,
} from "./validation.ts";
// Imported from where it is ENFORCED, never retyped: `probeCommands.ts` is what writes
// these rows, and a schema listing a status the producer cannot emit (or missing one it
// can) is worse than no schema.
import { PROBE_STATUSES, type ProbeStatus } from "../detect/probeCommands.ts";

export const WORKSPACE_MODES = ["single", "multi"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/**
 * `command_probes.<slot>` — what `tldrx init` MEASURED about a declared command (#168).
 *
 * Additive and optional. It permits nothing: `commands` above is still the allowlist,
 * and no gate reads this. `exit_code` is null exactly when nothing exited — a timeout,
 * a command that could not be started, or a slot that was never probed — and `reason`
 * is required in every case, because a `verified: false` with no sentence behind it is
 * the confident-nothing this key exists to replace.
 */
export interface CommandProbeRecord {
  readonly status: ProbeStatus;
  readonly verified: boolean;
  readonly exit_code: number | null;
  readonly at: string;
  readonly reason: string;
}

/**
 * The ONE shape check for a `command_probes` row, as a list of issues.
 *
 * Two readers need it and they must not disagree: `validateWorkspace` below, which
 * REFUSES a malformed file, and `commandProbesOf` (`src/hooks/lib/workspace.ts`), which
 * SKIPS a malformed row so a hand edit can never make a hook invent a verdict. Before
 * this was shared they already disagreed — the loader accepted `at: ""` and the
 * validator did not.
 *
 * Returns `[]` for a good row, so a caller wanting a boolean asks for `.length === 0`.
 */
export function commandProbeIssues(probe: unknown, path: string): readonly ValidationIssue[] {
  if (!isRecord(probe)) return [{ path, message: "expected a mapping" }];
  const issues: ValidationIssue[] = [];
  if (!(PROBE_STATUSES as readonly string[]).includes(probe.status as string)) {
    issues.push({ path: `${path}.status`, message: `expected one of ${PROBE_STATUSES.join(" | ")}` });
  }
  if (typeof probe.verified !== "boolean") {
    issues.push({ path: `${path}.verified`, message: "expected a boolean" });
  }
  if (probe.exit_code !== null && typeof probe.exit_code !== "number") {
    issues.push({ path: `${path}.exit_code`, message: "expected a number or null" });
  }
  // Both REQUIRED and both non-empty. `reason` is the "absent with a reason" half of the
  // record: a row without it says something happened without saying what, which is the
  // confident-nothing this key exists to replace.
  if (typeof probe.at !== "string" || probe.at === "") {
    issues.push({ path: `${path}.at`, message: "expected a non-empty RFC3339 string" });
  }
  if (typeof probe.reason !== "string" || probe.reason === "") {
    issues.push({ path: `${path}.reason`, message: "expected a non-empty sentence saying why" });
  }
  return issues;
}

export interface DetectedRepo {
  readonly name: string;
  readonly path: string;
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly commands?: Readonly<Record<string, string>>;
  readonly command_probes?: Readonly<Record<string, CommandProbeRecord>>;
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

/** `stack_packs:` — the one opt-in switch for stack expert packs. Additive; absent means off. */
export interface StackPacksSettings {
  readonly enabled: boolean;
  readonly enabled_at?: string | null;
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
  readonly stack_packs?: StackPacksSettings;
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
      requireCommandProbes(repo.command_probes, `${path}.command_probes`, issues);
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

  if (doc.stack_packs !== undefined) {
    if (isRecord(doc.stack_packs)) {
      if (typeof doc.stack_packs.enabled !== "boolean") {
        issues.push({ path: "stack_packs.enabled", message: "expected a boolean" });
      }
      const at = doc.stack_packs.enabled_at;
      if (at !== undefined && at !== null && typeof at !== "string") {
        issues.push({ path: "stack_packs.enabled_at", message: "expected an RFC3339 string or null" });
      }
    } else {
      issues.push({ path: "stack_packs", message: "expected a mapping" });
    }
  }
  return result(issues, deprecations);
}

/**
 * A mapping of slot -> probe, or nothing at all.
 *
 * Held to the same strictness `stack_packs` is above, and for the same reason: a key
 * this file will not check is a key a hand edit can turn into a lie. Absent is fine —
 * every `workspace.yml` written before #168 has no such key and must load unchanged.
 */
function requireCommandProbes(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "expected a mapping of command slot to probe" });
    return;
  }
  for (const [slot, probe] of Object.entries(value)) {
    issues.push(...commandProbeIssues(probe, `${path}.${slot}`));
  }
}
