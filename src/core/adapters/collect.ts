/**
 * Reading `03-plan/` as a list of things to mirror.
 *
 * Deliberately NOT `loadBuildPlan`: that refuses a plan whose `waves.yml` is
 * wrong, because handing two parallel agents the same file is a real hazard.
 * Mirroring has no such hazard — a story with a bad dependency order is still a
 * story somebody wants a ticket for — so this reads the two folders directly and
 * skips only files that do not parse, naming each one it skipped.
 *
 * Epics come first and each list is sorted by id, so a sync is deterministic and
 * a `--dry-run` plan is diffable against the run that follows it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStoryFile } from "../schemas/story.ts";
import { validateEpicFile } from "../schemas/epic.ts";
import type { PlanStatus } from "../schemas/planCommon.ts";
import { EPICS_DIR, STORIES_DIR } from "../plan/validatePlan.ts";
import { issueTitle, renderIssueBody } from "./body.ts";
import { readExternal } from "./external.ts";
import type { ExternalRef, MirrorKind } from "./types.ts";

/** The phase folder the Plan artefacts live in (spec §1). */
export const PLAN_PHASE = "03-plan";

export interface MirrorItem {
  readonly kind: MirrorKind;
  readonly id: string;
  readonly title: string;
  /** Absolute path of the file this mirrors. */
  readonly path: string;
  /** Run-relative path, as it appears in the issue body. */
  readonly rel: string;
  /** The LOCAL status. Read, printed, compared — never written by this module. */
  readonly localStatus: PlanStatus;
  readonly external: ExternalRef | null;
  readonly externalStatus: string | null;
  /** The rendered issue title and body, footer included. */
  readonly issueTitle: string;
  readonly issueBody: string;
}

export interface CollectResult {
  readonly items: readonly MirrorItem[];
  /** Files that did not parse, by run-relative path, with the reason. */
  readonly skipped: readonly string[];
}

/** `planDir` is the run's `03-plan/`; `runId` only decorates the body's source line. */
export function collectMirrorItems(planDir: string, runId: string): CollectResult {
  const items: MirrorItem[] = [];
  const skipped: string[] = [];

  for (const name of markdownIn(join(planDir, EPICS_DIR))) {
    const path = join(planDir, EPICS_DIR, name);
    const text = readFileSync(path, "utf8");
    const parsed = validateEpicFile(text);
    const epic = parsed.epic;
    if (epic === null) {
      skipped.push(`${EPICS_DIR}/${name} — ${reason(parsed.validation.issues)}`);
      continue;
    }
    const rel = `${EPICS_DIR}/${name}`;
    const external = readExternal(text);
    items.push({
      kind: "epic",
      id: epic.id,
      title: epic.title,
      path,
      rel,
      localStatus: epic.status,
      external: external.external,
      externalStatus: external.externalStatus,
      issueTitle: issueTitle(epic.id, epic.title),
      issueBody: renderIssueBody({
        kind: "epic", id: epic.id, title: epic.title,
        acceptance: [], testPlan: [], stories: epic.stories, rel, runId,
      }),
    });
  }

  for (const name of markdownIn(join(planDir, STORIES_DIR))) {
    const path = join(planDir, STORIES_DIR, name);
    const text = readFileSync(path, "utf8");
    // No workspace commands passed: the dod-membership rule is about executing a
    // story, not about mirroring one, and a story with an undeclared dod command
    // is still a ticket somebody wants.
    const parsed = validateStoryFile(text);
    const story = parsed.story;
    if (story === null) {
      skipped.push(`${STORIES_DIR}/${name} — ${reason(parsed.validation.issues)}`);
      continue;
    }
    const rel = `${STORIES_DIR}/${name}`;
    const external = readExternal(text);
    items.push({
      kind: "story",
      id: story.id,
      title: story.title,
      path,
      rel,
      localStatus: story.status,
      external: external.external,
      externalStatus: external.externalStatus,
      issueTitle: issueTitle(story.id, story.title),
      issueBody: renderIssueBody({
        kind: "story", id: story.id, title: story.title,
        acceptance: story.acceptance, testPlan: story.test_plan, stories: [], rel, runId,
      }),
    });
  }

  return { items, skipped };
}

function markdownIn(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
}

function reason(issues: readonly { readonly path: string; readonly message: string }[]): string {
  const first = issues[0];
  if (first === undefined) return "does not validate";
  return first.path === "" ? first.message : `${first.path}: ${first.message}`;
}
