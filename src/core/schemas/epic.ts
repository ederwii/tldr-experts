/**
 * Schema for `tldrx-work/<run>/03-plan/epics/<id>.md` (spec §2.14).
 *
 * An epic is a branch and a list of stories, not a container of prose. Concept §9:
 * "`epic/<epic>` ← `story/<id>` worktrees. Story merges to epic on green; epic
 * merges to main after integration tests + human gate." Everything the Build phase
 * needs to cut those branches is in the front matter.
 */
import {
  asDocument, requireEnum, requireKeys, result,
  type ValidationIssue, type ValidationResult,
} from "./validation.ts";
import {
  EPIC_BRANCH_RE, EPIC_ID_RE, PLAN_STATUSES, REPO_NAME_RE, STORY_ID_RE,
  requirePattern, requireStringList, requireText, requireVersion1, type PlanStatus,
} from "./planCommon.ts";
import { parseFrontMatter } from "./frontMatter.ts";

export interface Epic {
  readonly version: number;
  readonly id: string;
  readonly title: string;
  readonly repos: readonly string[];
  readonly stories: readonly string[];
  readonly branch: string;
  readonly status: PlanStatus;
}

export const EPIC_KEYS = ["version", "id", "title", "repos", "stories", "branch", "status"] as const;

export function validateEpic(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, EPIC_KEYS, "", issues);
  requireVersion1(doc, issues);
  requirePattern(doc.id, EPIC_ID_RE, "an epic id like `E1`", "id", issues);
  requireText(doc.title, "title", issues);
  requireStringList(doc.repos, "repos", issues, {
    nonEmpty: true, pattern: REPO_NAME_RE, patternName: "a workspace.yml repo name", unique: true,
  });
  requireStringList(doc.stories, "stories", issues, {
    nonEmpty: true, pattern: STORY_ID_RE, patternName: "a story id like `S3`", unique: true,
  });
  requirePattern(doc.branch, EPIC_BRANCH_RE, "a branch named `epic/<slug>`", "branch", issues);
  requireEnum(doc.status, PLAN_STATUSES, "status", issues);
  return result(issues);
}

export function asEpic(input: unknown): Epic {
  const doc = input as Partial<Epic>;
  return {
    version: doc.version ?? 1,
    id: doc.id ?? "",
    title: doc.title ?? "",
    repos: doc.repos ?? [],
    stories: doc.stories ?? [],
    branch: doc.branch ?? "",
    status: doc.status ?? "todo",
  };
}

export interface EpicFile {
  readonly epic: Epic | null;
  readonly validation: ValidationResult;
}

/** Read one `epics/<id>.md`: the front matter is the whole schema. */
export function validateEpicFile(text: string): EpicFile {
  const parsed = parseFrontMatter(text);
  if (parsed.issue !== null) return { epic: null, validation: result([parsed.issue]) };
  const front = validateEpic(parsed.doc);
  return { epic: front.ok ? asEpic(parsed.doc) : null, validation: front };
}
