/**
 * The ids, enums and list rules the three Plan schemas share (spec §2.13–§2.15).
 *
 * Kept in one file so a story, its epic and the wave that runs it cannot drift
 * apart on what an id looks like — the whole point of `waves.yml` is that `S3`
 * means the same thing in all three.
 */
import { isRecord, joinPath, type ValidationIssue } from "./validation.ts";

/** `S<n>` — a story. */
export const STORY_ID_RE = /^S\d{1,4}$/;
/** `E<n>` — an epic. */
export const EPIC_ID_RE = /^E\d{1,4}$/;
/** `W<n>` — a wave. */
export const WAVE_ID_RE = /^W\d{1,3}$/;
/** `epic/<slug>` — the branch an epic's story branches are cut from (concept §9). */
export const EPIC_BRANCH_RE = /^epic\/[a-z0-9][a-z0-9-]{0,48}$/;
/** A `workspace.yml` repo name (spec §2.1). */
export const REPO_NAME_RE = /^[a-z0-9-]{1,32}$/;

/**
 * One status enum for stories and epics.
 *
 * `[assumption]` — the wave brief names the five story states and is silent on an
 * epic's, so an epic reuses them rather than inventing a second vocabulary.
 */
export const PLAN_STATUSES = ["todo", "in_progress", "review", "done", "blocked"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Caps, in the spirit of spec §0: a Plan artefact is bounded or it is a document.
 *
 * Every message that refuses a value interpolates the constant rather than
 * spelling the number (gh #38): the agent that trips one is told what the cap is
 * and what to do about it, and `plan/schemaContract.ts` renders the same
 * constants into the Plan prompt so the contract is stated before it is enforced.
 */
export const MAX_LIST_ITEMS = 64;
export const MAX_TOUCHES = 128;
export const MAX_ITEM_CHARS = 512;
export const MAX_WAVES = 32;
export const MAX_STORIES_PER_WAVE = 32;
export const MAX_PLAN_STORIES = 200;

export interface ListRules {
  /** Reject an empty list. */
  readonly nonEmpty?: boolean;
  readonly max?: number;
  /** Every item must match this. */
  readonly pattern?: RegExp;
  /** Human-readable name of `pattern`, for the message. */
  readonly patternName?: string;
  /** Reject a repeated item. */
  readonly unique?: boolean;
}

/**
 * Validate a list of strings. Absence is reported by `requireKeys`, so an
 * `undefined` value is silently skipped here — one missing key, one message.
 */
export function requireStringList(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  rules: ListRules = {},
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path, message: `expected a list, got ${describe(value)}` });
    return [];
  }
  const max = rules.max ?? MAX_LIST_ITEMS;
  if (value.length > max) {
    issues.push({ path, message: `${value.length} items exceeds the ${max}-item cap` });
  }
  if (rules.nonEmpty === true && value.length === 0) {
    issues.push({ path, message: "must not be empty" });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  value.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (typeof item !== "string") {
      issues.push({ path: at, message: `expected a string, got ${describe(item)}` });
      return;
    }
    if (item.trim() === "") {
      issues.push({ path: at, message: "must not be blank" });
      return;
    }
    if (item.length > MAX_ITEM_CHARS) {
      issues.push({
        path: at,
        message: `${item.length} characters exceeds the ${MAX_ITEM_CHARS}-character cap on one list item `
          + "— split it into several items",
      });
    }
    if (rules.pattern !== undefined && !rules.pattern.test(item)) {
      issues.push({ path: at, message: `expected ${rules.patternName ?? String(rules.pattern)}, got \`${item}\`` });
      return;
    }
    if (rules.unique === true && seen.has(item)) {
      issues.push({ path: at, message: `\`${item}\` is listed twice` });
      return;
    }
    seen.add(item);
    out.push(item);
  });
  return out;
}

/** A required, non-blank string that must match `pattern`. */
export function requirePattern(
  value: unknown,
  pattern: RegExp,
  patternName: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    issues.push({ path, message: `expected a string, got ${describe(value)}` });
    return;
  }
  if (!pattern.test(value)) {
    issues.push({ path, message: `expected ${patternName}, got \`${value}\`` });
  }
}

/** A required, non-blank string of bounded length. */
export function requireText(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    issues.push({ path, message: `expected a string, got ${describe(value)}` });
    return;
  }
  if (value.trim() === "") issues.push({ path, message: "must not be blank" });
  if (value.length > MAX_ITEM_CHARS) {
    issues.push({ path, message: `${value.length} characters exceeds the ${MAX_ITEM_CHARS}-character cap` });
  }
}

/** Spec §0: every schema's first key is `version: 1`; an unknown version is an error. */
export function requireVersion1(doc: Record<string, unknown>, issues: ValidationIssue[]): void {
  if (doc.version !== undefined && doc.version !== 1) {
    issues.push({ path: "version", message: `unknown schema version ${String(doc.version)} (expected 1)` });
  }
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isRecord(value)) return "a mapping";
  return typeof value;
}

export { joinPath };
