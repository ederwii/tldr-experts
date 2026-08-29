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
}

export type Validator = (input: unknown) => ValidationResult;

export function ok(): ValidationResult {
  return { ok: true, issues: [] };
}

export function result(issues: readonly ValidationIssue[]): ValidationResult {
  return { ok: issues.length === 0, issues };
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
