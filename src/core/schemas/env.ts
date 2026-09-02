/**
 * Schema for `env.yml` — the local dev environment manifest that `tldrx doctor` runs.
 * The framework never installs anything: `install` holds a hint string per OS.
 *
 * ## What is checked, and the one rule that was deleted rather than built (#126)
 *
 * Spec §2.10 designed four validation rules and this file enforced none of them.
 * Two are now here: **ids are unique** across `tools`, and there are **at most
 * `MAX_ENV_TOOLS`** of them. The duplicate rule pays for itself — `runDoctor`
 * iterates `tools` and probes each entry, so a repeated id spawned the same check
 * twice and printed two rows for one tool.
 *
 * The third — "`check` free of `; && | > \`" — is DELETED from the spec instead.
 * It was not a missing check but a disagreement about what `check` is:
 * `ToolChecker.check` runs `runtime.spawn("sh", ["-c", tool.check])`, so every
 * `check` in every manifest that ever shipped has been executed BY a shell, and
 * §2.10's own `[assumption]` depends on it (`check: "test -n \"$VAR\""` is
 * nothing without a shell to expand `$VAR`). Enforcing it would have been a
 * behaviour change that broke the file's own idiom in order to defend an owner
 * against a file they wrote, committed and reviewed like code, running on their
 * own machine as themselves. The honest fix was to say what `check` is.
 *
 * The fourth (`version_re`) went with the field in #125.
 */
import {
  asDocument, requireArray, requireKeys, requireString,
  requireVersion, result, isRecord, type ValidationIssue, type ValidationResult,
} from "./validation.ts";

/**
 * Spec §2.10, in the spirit of spec §0: a manifest is bounded or it is a document.
 * Interpolated into the message that refuses it (gh #38) rather than spelled there.
 */
export const MAX_ENV_TOOLS = 64;

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
    const tools = doc.tools as unknown[];
    if (tools.length > MAX_ENV_TOOLS) {
      issues.push({
        path: "tools",
        message: `${String(tools.length)} tools exceeds the ${String(MAX_ENV_TOOLS)} cap`,
      });
    }
    // Where each id was FIRST declared, so the second one can name it (#126).
    const declaredAt = new Map<string, number>();
    tools.forEach((tool, i) => {
      const path = `tools[${i}]`;
      if (!isRecord(tool)) {
        issues.push({ path, message: "expected a mapping" });
        return;
      }
      requireKeys(tool, ["id", "required", "check", "install"], path, issues);
      requireString(tool.id, `${path}.id`, issues);
      // `check` is a SHELL COMMAND LINE and is checked for nothing but its type:
      // `ToolChecker` runs `sh -c <check>` as the invoking user, and the manifest's
      // own idiom relies on it (`check: "test -n \"$CONTEXT7_API_KEY\""`). See the
      // header of this file for why refusing metacharacters was dropped (#126).
      requireString(tool.check, `${path}.check`, issues);
      if (tool.required !== undefined && typeof tool.required !== "boolean") {
        issues.push({ path: `${path}.required`, message: "expected a boolean" });
      }
      if (tool.install !== undefined && !isRecord(tool.install)) {
        issues.push({ path: `${path}.install`, message: "expected a mapping of os -> hint" });
      }
      // Only a well-typed id can duplicate one: a non-string id already has its
      // own message, and a second one about uniqueness would be noise about noise.
      if (typeof tool.id !== "string") return;
      const first = declaredAt.get(tool.id);
      if (first !== undefined) {
        issues.push({
          path: `${path}.id`,
          message: `\`${tool.id}\` is already declared by tools[${String(first)}] — `
            + "an id is the key `doctor` reports under, and a duplicate is probed twice and reported twice",
        });
        return;
      }
      declaredAt.set(tool.id, i);
    });
  }
  return result(issues, deprecations);
}
