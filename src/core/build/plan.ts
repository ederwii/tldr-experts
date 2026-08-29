/**
 * Loading `03-plan/` as something the Build phase can execute.
 *
 * `validatePlan` (wave 4A) answers "can this be executed at all?" by reading the
 * three artefacts together. This module answers the next question — "in what
 * order, and with what?" — by turning them into wave-ordered story objects with
 * their file text, their dod block and their epic already resolved.
 *
 * It runs the validator first and refuses to load anything it rejected. A Build
 * phase that started on a plan whose `depends_on` pointed at the same wave would
 * hand two agents the same file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { asWavesFile, validateWaves } from "../schemas/waves.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { validateEpicFile } from "../schemas/epic.ts";
import type { Story, DodBlock } from "../schemas/story.ts";
import type { Epic } from "../schemas/epic.ts";
import { describePlanIssues, validatePlan, EPICS_DIR, STORIES_DIR, WAVES_FILE } from "../plan/validatePlan.ts";

/** The phase folder this executor owns (spec §1). The registry keys on it. */
export const BUILD_PHASE = "04-build";
/** Where the Plan phase left the three artefacts it reads. */
export const PLAN_PHASE = "03-plan";
/** One review log per story, cited by every Finding in the handoff. */
export const LOG_DIR = "log";
/** Story worktrees live under the framework dir, which `init` gitignores. */
export const WORKTREES = "worktrees";

export interface PlannedStory {
  readonly story: Story;
  readonly dod: DodBlock;
  /** The file, verbatim — inlined into the sub-agent prompt. */
  readonly text: string;
  /** Absolute path of `03-plan/stories/<id>.md`. */
  readonly path: string;
  /** Run-relative path, for citations. */
  readonly rel: string;
  readonly wave: string;
}

export interface PlannedEpic {
  readonly epic: Epic;
  readonly text: string;
  readonly path: string;
  readonly rel: string;
}

export interface BuildWave {
  readonly id: string;
  readonly stories: readonly PlannedStory[];
}

export interface BuildPlan {
  readonly waves: readonly BuildWave[];
  readonly epics: ReadonlyMap<string, PlannedEpic>;
  readonly stories: ReadonlyMap<string, PlannedStory>;
  readonly storyCount: number;
}

export class PlanLoadError extends Error {}

/**
 * `planDir` is the run's `03-plan/`; `allowed` is `workspace.yml`'s command set,
 * which the story validator checks every dod line against.
 */
export function loadBuildPlan(planDir: string, allowed: ReadonlySet<string>): BuildPlan {
  const report = validatePlan(planDir, allowed);
  if (!report.ok) {
    throw new PlanLoadError(`03-plan/ does not validate — ${describePlanIssues(report.issues)}`);
  }

  const wavesPath = join(planDir, WAVES_FILE);
  if (!existsSync(wavesPath)) throw new PlanLoadError(`no ${WAVES_FILE} in 03-plan/`);
  const doc = parseYaml(readFileSync(wavesPath, "utf8"));
  if (!validateWaves(doc).ok) throw new PlanLoadError(`${WAVES_FILE} does not validate`);
  const wavesFile = asWavesFile(doc);

  const epics = new Map<string, PlannedEpic>();
  const stories = new Map<string, PlannedStory>();
  const waves: BuildWave[] = [];

  for (const wave of wavesFile.waves) {
    const loaded: PlannedStory[] = [];
    for (const id of wave.stories) {
      const path = join(planDir, STORIES_DIR, `${id}.md`);
      if (!existsSync(path)) throw new PlanLoadError(`${STORIES_DIR}/${id}.md is scheduled in ${wave.id} but missing`);
      const text = readFileSync(path, "utf8");
      const parsed = validateStoryFile(text, allowed);
      if (parsed.story === null) throw new PlanLoadError(`${STORIES_DIR}/${id}.md does not validate`);
      const planned: PlannedStory = {
        story: parsed.story,
        dod: parsed.dod,
        text,
        path,
        rel: `03-plan/${STORIES_DIR}/${id}.md`,
        wave: wave.id,
      };
      loaded.push(planned);
      stories.set(id, planned);
      if (!epics.has(parsed.story.epic)) {
        epics.set(parsed.story.epic, loadEpic(planDir, parsed.story.epic));
      }
    }
    waves.push({ id: wave.id, stories: loaded });
  }

  return { waves, epics, stories, storyCount: stories.size };
}

function loadEpic(planDir: string, id: string): PlannedEpic {
  const path = join(planDir, EPICS_DIR, `${id}.md`);
  if (!existsSync(path)) throw new PlanLoadError(`${EPICS_DIR}/${id}.md is named by a story but missing`);
  const text = readFileSync(path, "utf8");
  const parsed = validateEpicFile(text);
  if (parsed.epic === null) throw new PlanLoadError(`${EPICS_DIR}/${id}.md does not validate`);
  return { epic: parsed.epic, text, path, rel: `03-plan/${EPICS_DIR}/${id}.md` };
}

/**
 * Stories in execution order: wave by wave, and within a wave in the order
 * `waves.yml` lists them.
 *
 * `[assumption]` — spec §5 decision (c) says v0 runs tasks sequentially and v1
 * runs independent stories of one wave in parallel. This wave executor is the
 * sequential half: the ORDER is already the parallel-safe one (a dependency is
 * always in an earlier wave), so turning the inner loop into a fan-out later
 * changes no other line of the pipeline.
 */
export function inOrder(plan: BuildPlan): readonly PlannedStory[] {
  return plan.waves.flatMap((wave) => wave.stories);
}
