/**
 * Shared validation primitives.
 *
 * Deliberately tiny: these validators check *required keys and enum membership*
 * only. They are not a JSON-Schema engine, and they never coerce or mutate the
 * input. Budget: the whole registry must stay well under 50ms for the files a
 * single stage touches.
 */

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `repos[0].name`. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  /**
   * Things the file may keep saying for now, and should stop saying.
   *
   * Not issues: a deprecation never fails validation and never changes an exit
   * code. Optional so the handful of validators that build a result by hand stay
   * valid; read it as `result.deprecations ?? []`.
   */
  readonly deprecations?: readonly string[];
}

export type Validator = (input: unknown) => ValidationResult;

export function ok(): ValidationResult {
  return { ok: true, issues: [] };
}

export function result(
  issues: readonly ValidationIssue[],
  deprecations: readonly string[] = [],
): ValidationResult {
  return { ok: issues.length === 0, issues, deprecations };
}

/**
 * The version key, and the one it replaced.
 *
 * Spec §0 has always said "every schema's first key is `version: 1`; unknown
 * version ⇒ exit 1". Seven skeleton validators asked for `schema_version`
 * instead, and seven templates printed `schema_version: 0` — while `tldrx init`
 * had already been writing `version: 1` for real (measured 2026-08-29 against
 * `~/aparece-v2/.tldrx/`: `version: 1` in workspace.yml, process.yml, every
 * competencies.yml, and every run.yml/budget.yml under `tldrx-work/`). So the
 * validators were rejecting the tool's own output and accepting only a spelling
 * nothing wrote. The spec wins.
 *
 * `schema_version` is still ACCEPTED — a workspace on disk must keep loading —
 * but it is reported, never emitted, and goes after one release.
 */
export const VERSION_KEY = "version";
export const LEGACY_VERSION_KEY = "schema_version";
export const SCHEMA_VERSION = 1;
export const LEGACY_VERSION_NOTE = `${LEGACY_VERSION_KEY} is deprecated — say ${VERSION_KEY}: ${String(SCHEMA_VERSION)}`;

/**
 * Check the document's version key: `version: 1` preferred, `schema_version`
 * tolerated-and-reported, neither is an error.
 *
 * An unknown `version` IS an error (spec §0: "unknown version ⇒ exit 1"); an
 * unknown `schema_version` is not, because the legacy skeleton never numbered
 * itself meaningfully — `0` is the only value it ever wrote.
 */
export function requireVersion(
  doc: Record<string, unknown>,
  issues: ValidationIssue[],
  deprecations: string[],
): void {
  const declared = doc[VERSION_KEY];
  if (declared !== undefined) {
    if (declared !== SCHEMA_VERSION) {
      issues.push({
        path: VERSION_KEY,
        message: `unknown schema version ${describeValue(declared)} (expected ${String(SCHEMA_VERSION)})`,
      });
    }
    return;
  }
  if (!(LEGACY_VERSION_KEY in doc) || doc[LEGACY_VERSION_KEY] === undefined) {
    issues.push({ path: VERSION_KEY, message: `missing required key \`${VERSION_KEY}\`` });
    return;
  }
  requireNumber(doc[LEGACY_VERSION_KEY], LEGACY_VERSION_KEY, issues);
  deprecations.push(LEGACY_VERSION_NOTE);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

/** Push an issue for every key in `keys` that is absent or `undefined`. */
export function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  base: string,
  issues: ValidationIssue[],
): void {
  for (const key of keys) {
    if (!(key in value) || value[key] === undefined) {
      issues.push({ path: joinPath(base, key), message: `missing required key \`${key}\`` });
    }
  }
}

export function requireEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return; // absence is reported by requireKeys
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push({ path, message: `expected one of ${allowed.join(" | ")}, got ${describe(value)}` });
  }
}

export function requireArray(value: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value)) {
    issues.push({ path, message: `expected an array, got ${describe(value)}` });
    return false;
  }
  return true;
}

export function requireNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (typeof value !== "number" || Number.isNaN(value)) {
    issues.push({ path, message: `expected a number, got ${describe(value)}` });
  }
}

export function requireString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    issues.push({ path, message: `expected a string, got ${describe(value)}` });
  }
}

export function requireRecord(value: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) {
    issues.push({ path, message: `expected a mapping, got ${describe(value)}` });
    return false;
  }
  return true;
}

/** Guard used at the top of every validator: the document must be a mapping. */
export function asDocument(
  input: unknown,
  issues: ValidationIssue[],
): Record<string, unknown> | null {
  if (!isRecord(input)) {
    issues.push({ path: "", message: `expected a mapping at the document root, got ${describe(input)}` });
    return null;
  }
  return input;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** `describe`, but a scalar is quoted as itself — `2` reads better than `number`. */
function describeValue(value: unknown): string {
  return typeof value === "number" || typeof value === "boolean" ? String(value) : describe(value);
}
