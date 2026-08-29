/**
 * The Plan phase's three artefacts, checked together (spec §2.13–§2.15).
 *
 * Each schema on its own answers "is this file well formed?". Only reading all
 * three answers the question the Plan gate actually asks: **can the Build phase
 * execute this?** That needs the cross-file half —
 *
 *   - every story names an epic that exists, and every epic names stories that do;
 *   - `waves.yml` schedules every story, exactly once;
 *   - every `depends_on` lands in an earlier wave than the story that needs it;
 *   - every `dod` command is one `workspace.yml` declares, verbatim.
 *
 * Read-only and deterministic: it opens files, it runs nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import type { ValidationIssue } from "../schemas/validation.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { validateEpicFile } from "../schemas/epic.ts";
import { asWavesFile, validateWaveOrder, validateWaves } from "../schemas/waves.ts";

export const WAVES_FILE = "waves.yml";
export const STORIES_DIR = "stories";
export const EPICS_DIR = "epics";

export interface PlanIssue extends ValidationIssue {
  /** The Plan file the issue is in, relative to the phase dir. */
  readonly file: string;
}

export interface PlanReport {
  readonly ok: boolean;
  readonly issues: readonly PlanIssue[];
  readonly storyCount: number;
  readonly epicCount: number;
  readonly waveCount: number;
}

/**
 * `planDir` is the run's `03-plan/` folder. `allowed` is the set of commands
 * `.tldrx/workspace.yml` declares; an empty set skips the membership rule (same
 * `[assumption]` as `validateStoryDod`).
 */
export function validatePlan(planDir: string, allowed: ReadonlySet<string> = new Set()): PlanReport {
  const issues: PlanIssue[] = [];
  const add = (file: string, list: readonly ValidationIssue[]): void => {
    for (const issue of list) issues.push({ ...issue, file });
  };

  const storyFiles = markdownIn(join(planDir, STORIES_DIR));
  const epicFiles = markdownIn(join(planDir, EPICS_DIR));
  const dependsOn = new Map<string, readonly string[]>();
  const storyIds = new Set<string>();
  const epicIds = new Set<string>();

  if (storyFiles.length === 0) {
    add(`${STORIES_DIR}/`, [{ path: "", message: "the Plan wrote no stories — there is nothing for Build to pick up" }]);
  }
  for (const name of storyFiles) {
    const rel = `${STORIES_DIR}/${name}`;
    const parsed = validateStoryFile(readFileSync(join(planDir, STORIES_DIR, name), "utf8"), allowed);
    add(rel, parsed.validation.issues);
    const story = parsed.story;
    if (story === null) continue;
    if (`${story.id}.md` !== name) {
      add(rel, [{ path: "id", message: `\`${story.id}\` does not match the file name — a story is addressed by its id` }]);
    }
    if (storyIds.has(story.id)) {
      add(rel, [{ path: "id", message: `\`${story.id}\` is used by more than one story file` }]);
      continue;
    }
    storyIds.add(story.id);
    dependsOn.set(story.id, story.depends_on);
  }

  if (epicFiles.length === 0) {
    add(`${EPICS_DIR}/`, [{ path: "", message: "the Plan wrote no epics — a story with no epic has no branch to merge into" }]);
  }
  const claimedByEpic = new Map<string, string>();
  for (const name of epicFiles) {
    const rel = `${EPICS_DIR}/${name}`;
    const parsed = validateEpicFile(readFileSync(join(planDir, EPICS_DIR, name), "utf8"));
    add(rel, parsed.validation.issues);
    const epic = parsed.epic;
    if (epic === null) continue;
    if (`${epic.id}.md` !== name) {
      add(rel, [{ path: "id", message: `\`${epic.id}\` does not match the file name` }]);
    }
    epicIds.add(epic.id);
    epic.stories.forEach((story, i) => {
      if (!storyIds.has(story)) {
        add(rel, [{ path: `stories[${i}]`, message: `${story} has no file in ${STORIES_DIR}/` }]);
        return;
      }
      const already = claimedByEpic.get(story);
      if (already !== undefined && already !== epic.id) {
        add(rel, [{ path: `stories[${i}]`, message: `${story} is already listed by ${already} — a story belongs to one epic` }]);
        return;
      }
      claimedByEpic.set(story, epic.id);
    });
  }

  // A story's `epic:` and its epic's `stories:` must agree in both directions.
  for (const name of storyFiles) {
    const rel = `${STORIES_DIR}/${name}`;
    const id = name.replace(/\.md$/, "");
    if (!storyIds.has(id)) continue;
    const epic = epicOf(planDir, name);
    if (epic === null) continue;
    if (!epicIds.has(epic)) {
      add(rel, [{ path: "epic", message: `${epic} has no file in ${EPICS_DIR}/` }]);
      continue;
    }
    if (claimedByEpic.get(id) !== epic) {
      add(rel, [{ path: "epic", message: `${id} names ${epic}, but ${epic}.md does not list ${id}` }]);
    }
  }

  const wavesPath = join(planDir, WAVES_FILE);
  if (!existsSync(wavesPath)) {
    add(WAVES_FILE, [{ path: "", message: "missing — without it nothing knows what may run in parallel" }]);
    return report(issues, storyIds.size, epicIds.size, 0);
  }

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(wavesPath, "utf8"));
  } catch (error) {
    add(WAVES_FILE, [{ path: "", message: `is not valid YAML: ${first(error)}` }]);
    return report(issues, storyIds.size, epicIds.size, 0);
  }
  const shape = validateWaves(doc);
  add(WAVES_FILE, shape.issues);
  if (!shape.ok) return report(issues, storyIds.size, epicIds.size, 0);

  const waves = asWavesFile(doc);
  const scheduled = new Set<string>();
  waves.waves.forEach((wave, index) => {
    wave.stories.forEach((story, i) => {
      scheduled.add(story);
      if (!storyIds.has(story)) {
        add(WAVES_FILE, [{ path: `waves[${index}].stories[${i}]`, message: `${story} has no file in ${STORIES_DIR}/` }]);
      }
    });
  });
  for (const id of [...storyIds].sort()) {
    if (!scheduled.has(id)) {
      add(WAVES_FILE, [{ path: "waves", message: `${id} is in no wave — every story runs in exactly one` }]);
    }
  }
  add(WAVES_FILE, validateWaveOrder(waves, dependsOn));

  return report(issues, storyIds.size, epicIds.size, waves.waves.length);
}

/** One line, ready for a check `detail` or a deny message. */
export function describePlanIssues(issues: readonly PlanIssue[], max = 3): string {
  const shown = issues.slice(0, max).map((i) => `${i.file}${i.path === "" ? "" : ` ${i.path}`}: ${i.message}`);
  const rest = issues.length - shown.length;
  return rest > 0 ? `${shown.join("; ")} (+${String(rest)} more)` : shown.join("; ");
}

function report(issues: readonly PlanIssue[], storyCount: number, epicCount: number, waveCount: number): PlanReport {
  return { ok: issues.length === 0, issues, storyCount, epicCount, waveCount };
}

function markdownIn(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
}

/** Re-read one story's `epic:` without re-validating it. */
function epicOf(planDir: string, name: string): string | null {
  const parsed = validateStoryFile(readFileSync(join(planDir, STORIES_DIR, name), "utf8"));
  return parsed.story?.epic ?? null;
}

function first(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "parse error" : String(error);
}
