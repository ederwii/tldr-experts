/**
 * `tldrx-work/<run>/05-watch/watchers/<feature>.md` — one watcher card per
 * shipped feature (spec §2.16, concept §10).
 *
 * The card answers one question: how would anyone know this still works next
 * month? Its whole design is a refusal to answer it aspirationally. Every item in
 * the four checked sections ends with a `[src: …]` token, and that token points at
 * the code that was actually built — or, when the code emits nothing, at
 * `absent:<what was looked at>`. A card holding an `absent:` source under Signal
 * cannot be `verified`; it stays `draft` and names what to instrument.
 *
 * That single rule is why the file exists. A watcher listing the log line someone
 * MEANT to add is worse than no watcher: it reads as coverage, and the first
 * person to trust it is on-call.
 *
 * `[assumption]` — the spec had no §2.16 before this wave. The wave brief fixes
 * the six H2 sections and `version` / feature id / title / `stories` / `repos` /
 * `status`; `epic:` is added on top, because one feature per epic is the whole
 * grouping rule and a card with no way back to its epic cannot be re-derived. The
 * caps and the `id`-equals-file-name rule mirror §2.13, not a stated requirement.
 */
import {
  asDocument, requireEnum, requireKeys, result,
  type ValidationIssue, type ValidationResult,
} from "../schemas/validation.ts";
import {
  EPIC_ID_RE, REPO_NAME_RE, STORY_ID_RE,
  requirePattern, requireStringList, requireText, requireVersion1,
} from "../schemas/planCommon.ts";

/** Where the cards live inside the run, and the phase that owns them. */
export const WATCH_PHASE = "05-watch";
export const WATCHERS_DIR = "watchers";

export const WATCHER_STATUSES = ["draft", "verified"] as const;
export type WatcherStatus = (typeof WATCHER_STATUSES)[number];

/**
 * The H2 sections a card must carry, in this order.
 *
 * `Query` is fenced rather than listed (a copy-paste block is not a claim), and
 * `Sources` is prose. The other four hold list items, and every one of those items
 * is checked exactly like a handoff bullet.
 */
export const WATCHER_SECTIONS = [
  "Signal", "Where", "Healthy baseline", "Looks broken when", "Query", "Sources",
] as const;
export type WatcherSectionName = (typeof WATCHER_SECTIONS)[number];

/** The sections whose every list item must end with a resolvable `[src: …]`. */
export const WATCHER_CHECKED_SECTIONS = [
  "Signal", "Where", "Healthy baseline", "Looks broken when",
] as const;

/** The one section whose sources decide `draft` vs `verified`. */
export const WATCHER_SIGNAL_SECTION = "Signal";

/** `<feature>` — the file name stem, and the id in the front matter. */
export const FEATURE_ID_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

export interface Watcher {
  readonly version: number;
  readonly id: string;
  readonly epic: string;
  readonly title: string;
  readonly stories: readonly string[];
  readonly repos: readonly string[];
  readonly status: WatcherStatus;
}

export const WATCHER_KEYS = ["version", "id", "epic", "title", "stories", "repos", "status"] as const;

/** The front matter only — shape, ids and enums. The body is `watcherFile.ts`. */
export function validateWatcher(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = asDocument(input, issues);
  if (!doc) return result(issues);

  requireKeys(doc, WATCHER_KEYS, "", issues);
  requireVersion1(doc, issues);
  requirePattern(doc.id, FEATURE_ID_RE, "a feature id like `leaderboard`", "id", issues);
  requirePattern(doc.epic, EPIC_ID_RE, "an epic id like `E1`", "epic", issues);
  requireText(doc.title, "title", issues);
  requireStringList(doc.stories, "stories", issues, {
    nonEmpty: true, pattern: STORY_ID_RE, patternName: "a story id like `S3`", unique: true,
  });
  requireStringList(doc.repos, "repos", issues, {
    nonEmpty: true, pattern: REPO_NAME_RE, patternName: "a workspace.yml repo name", unique: true,
  });
  requireEnum(doc.status, WATCHER_STATUSES, "status", issues);
  return result(issues);
}

export function asWatcher(input: unknown): Watcher {
  const doc = input as Partial<Watcher>;
  return {
    version: doc.version ?? 1,
    id: doc.id ?? "",
    epic: doc.epic ?? "",
    title: doc.title ?? "",
    stories: doc.stories ?? [],
    repos: doc.repos ?? [],
    status: doc.status ?? "draft",
  };
}
