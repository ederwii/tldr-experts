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
import { detectEpicChain, type EpicDependencyEdge } from "./branchModel.ts";

export const WAVES_FILE = "waves.yml";
export const STORIES_DIR = "stories";
export const EPICS_DIR = "epics";

export interface PlanIssue extends ValidationIssue {
  /** The Plan file the issue is in, relative to the phase dir. */
  readonly file: string;
  /**
   * This issue exists only because ANOTHER file did not validate (gh #37).
   *
   * `S8.md` held one 1,009-character acceptance item against the 512 cap, so it
   * never entered the parsed-story set, so the cross-file checks reported
   * `S8 has no file in stories/` twice — for a file that was 5,794 bytes on
   * disk. A reader then goes hunting for a missing file or rewrites waves.yml.
   * A cascade says which file to fix instead, and `describePlanIssues` shows the
   * root violation ahead of it.
   */
  readonly cascade?: boolean;
}

export interface PlanReport {
  readonly ok: boolean;
  readonly issues: readonly PlanIssue[];
  readonly storyCount: number;
  readonly epicCount: number;
  readonly waveCount: number;
  /**
   * Every cross-epic dependency the stories declare (issue #57), deduplicated per
   * epic pair. Non-empty means the epics form a CHAIN, and the run cuts one
   * integration branch instead of one branch per epic.
   *
   * Reported rather than refused: the Plan is legal either way, and which branch
   * model follows from it is what the `plan` gate check has to SAY. Computed from
   * the story front matter, so it is filled on every path out of this function —
   * including the ones that give up before `waves.yml`.
   */
  readonly epicChain: readonly EpicDependencyEdge[];
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
  const addCascade = (file: string, issue: ValidationIssue): void => {
    issues.push({ ...issue, file, cascade: true });
  };

  const storyFiles = markdownIn(join(planDir, STORIES_DIR));
  const epicFiles = markdownIn(join(planDir, EPICS_DIR));
  const dependsOn = new Map<string, readonly string[]>();
  // story id -> its `epic:`, for the cross-epic chain (issue #57).
  const epicOfStory = new Map<string, string>();
  const storyIds = new Set<string>();
  const epicIds = new Set<string>();
  // id-from-file-name -> why that file cannot answer to it. A reference to an id
  // in here resolves to a file that EXISTS, so it is never "has no file".
  const unusableStories = new Map<string, string>();
  const unusableEpics = new Map<string, string>();

  if (storyFiles.length === 0) {
    add(`${STORIES_DIR}/`, [{ path: "", message: "the Plan wrote no stories — there is nothing for Build to pick up" }]);
  }
  for (const name of storyFiles) {
    const rel = `${STORIES_DIR}/${name}`;
    const parsed = validateStoryFile(readFileSync(join(planDir, STORIES_DIR, name), "utf8"), allowed);
    add(rel, parsed.validation.issues);
    const story = parsed.story;
    if (story === null) {
      unusableStories.set(name.replace(/\.md$/, ""), "failed validation");
      continue;
    }
    if (`${story.id}.md` !== name) {
      add(rel, [{ path: "id", message: `\`${story.id}\` does not match the file name — a story is addressed by its id` }]);
      unusableStories.set(name.replace(/\.md$/, ""), `declares id \`${story.id}\``);
    }
    if (storyIds.has(story.id)) {
      add(rel, [{ path: "id", message: `\`${story.id}\` is used by more than one story file` }]);
      continue;
    }
    storyIds.add(story.id);
    dependsOn.set(story.id, story.depends_on);
    epicOfStory.set(story.id, story.epic);
  }
  // Read once, from the same story front matter the Build executor reads, so the
  // gate check and the branch it later cuts cannot disagree (issue #57).
  const epicChain = detectEpicChain(epicOfStory, dependsOn);

  if (epicFiles.length === 0) {
    add(`${EPICS_DIR}/`, [{ path: "", message: "the Plan wrote no epics — a story with no epic has no branch to merge into" }]);
  }
  const claimedByEpic = new Map<string, string>();
  for (const name of epicFiles) {
    const rel = `${EPICS_DIR}/${name}`;
    const parsed = validateEpicFile(readFileSync(join(planDir, EPICS_DIR, name), "utf8"));
    add(rel, parsed.validation.issues);
    const epic = parsed.epic;
    if (epic === null) {
      unusableEpics.set(name.replace(/\.md$/, ""), "failed validation");
      continue;
    }
    if (`${epic.id}.md` !== name) {
      add(rel, [{ path: "id", message: `\`${epic.id}\` does not match the file name` }]);
      unusableEpics.set(name.replace(/\.md$/, ""), `declares id \`${epic.id}\``);
    }
    epicIds.add(epic.id);
    epic.stories.forEach((story, i) => {
      if (!storyIds.has(story)) {
        const why = unusableStories.get(story);
        const at = `stories[${i}]`;
        if (why === undefined) add(rel, [{ path: at, message: `${story} has no file in ${STORIES_DIR}/` }]);
        else addCascade(rel, { path: at, message: cascadeMessage(story, STORIES_DIR, why) });
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
      const why = unusableEpics.get(epic);
      if (why === undefined) add(rel, [{ path: "epic", message: `${epic} has no file in ${EPICS_DIR}/` }]);
      else addCascade(rel, { path: "epic", message: cascadeMessage(epic, EPICS_DIR, why) });
      continue;
    }
    if (claimedByEpic.get(id) !== epic) {
      add(rel, [{ path: "epic", message: `${id} names ${epic}, but ${epic}.md does not list ${id}` }]);
    }
  }

  const wavesPath = join(planDir, WAVES_FILE);
  if (!existsSync(wavesPath)) {
    add(WAVES_FILE, [{ path: "", message: "missing — without it nothing knows what may run in parallel" }]);
    return report(issues, storyIds.size, epicIds.size, 0, epicChain);
  }

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(wavesPath, "utf8"));
  } catch (error) {
    add(WAVES_FILE, [{ path: "", message: `is not valid YAML: ${first(error)}` }]);
    return report(issues, storyIds.size, epicIds.size, 0, epicChain);
  }
  const shape = validateWaves(doc);
  add(WAVES_FILE, shape.issues);
  if (!shape.ok) return report(issues, storyIds.size, epicIds.size, 0, epicChain);

  const waves = asWavesFile(doc);
  const scheduled = new Set<string>();
  waves.waves.forEach((wave, index) => {
    wave.stories.forEach((story, i) => {
      scheduled.add(story);
      if (storyIds.has(story)) return;
      const why = unusableStories.get(story);
      const at = `waves[${index}].stories[${i}]`;
      if (why === undefined) add(WAVES_FILE, [{ path: at, message: `${story} has no file in ${STORIES_DIR}/` }]);
      else addCascade(WAVES_FILE, { path: at, message: cascadeMessage(story, STORIES_DIR, why) });
    });
  });
  for (const id of [...storyIds].sort()) {
    if (!scheduled.has(id)) {
      add(WAVES_FILE, [{ path: "waves", message: `${id} is in no wave — every story runs in exactly one` }]);
    }
  }
  add(WAVES_FILE, validateWaveOrder(waves, dependsOn));

  return report(issues, storyIds.size, epicIds.size, waves.waves.length, epicChain);
}

/** One line, ready for a check `detail` or a deny message. */
export function describePlanIssues(issues: readonly PlanIssue[], max = 3): string {
  // Root violations first (gh #37). The window is three issues wide, so a plan
  // whose one real defect cascades into four references would otherwise spend
  // the whole window on the consequences and never name the cause.
  const ordered = [...issues.filter((i) => i.cascade !== true), ...issues.filter((i) => i.cascade === true)];
  const shown = ordered.slice(0, max).map((i) => `${i.file}${i.path === "" ? "" : ` ${i.path}`}: ${i.message}`);
  const rest = ordered.length - shown.length;
  return rest > 0 ? `${shown.join("; ")} (+${String(rest)} more)` : shown.join("; ");
}

/**
 * A reference to a file that EXISTS but cannot answer to the id it was asked
 * for. Never "has no file": that sentence sent a real session hunting for a
 * 5,794-byte file it already had (gh #37).
 */
function cascadeMessage(id: string, dir: string, why: string): string {
  return `${id} is unresolved because ${dir}/${id}.md ${why} — that file exists; `
    + "fix the errors reported against it and this one goes with them";
}

/**
 * True when a stage writes the Plan artefacts. The predicate `checkPlan` skips
 * on, and the one that decides whether the schema contract is worth its bytes in
 * that stage's prompt — one source so the two cannot disagree.
 */
export function writesPlanArtefacts(outputs: readonly string[]): boolean {
  return outputs.some((path) => path.endsWith(WAVES_FILE));
}

function report(
  issues: readonly PlanIssue[],
  storyCount: number,
  epicCount: number,
  waveCount: number,
  epicChain: readonly EpicDependencyEdge[],
): PlanReport {
  return { ok: issues.length === 0, issues, storyCount, epicCount, waveCount, epicChain };
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
