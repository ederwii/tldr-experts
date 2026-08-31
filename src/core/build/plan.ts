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
import { validateBudget } from "../schemas/budget.ts";
import { STORY_ID_RE } from "../schemas/planCommon.ts";
import { describePlanIssues, validatePlan, EPICS_DIR, STORIES_DIR, WAVES_FILE } from "../plan/validatePlan.ts";

/** The phase folder this executor owns (spec §1). The registry keys on it. */
export const BUILD_PHASE = "04-build";
/** Where the Plan phase left the three artefacts it reads. */
export const PLAN_PHASE = "03-plan";
/** One review log per story, cited by every Finding in the handoff. */
export const LOG_DIR = "log";
/** Story worktrees live under the framework dir, which `init` gitignores. */
export const WORKTREES = "worktrees";
/** What the Plan phase priced each story at — `03-plan/budget.yml` (spec §2.11). */
export const PLAN_BUDGET_FILE = "budget.yml";

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
  /**
   * Background the developer is given AFTER the objective and clearly labelled
   * as background — never as instructions. Only an implicit story has any: it is
   * what the What stage decided, which is context for the work and not the work
   * (`build/implicitPlan.ts`). A planned story's brief is the story.
   */
  readonly context?: readonly string[];
  /**
   * Files to inline in the developer prompt that are NOT in the story's repo —
   * run artefacts such as `01-what/questions.md`, which holds the whole of every
   * answer this story applies. `touches` cannot carry them: it is resolved
   * inside the story's worktree.
   */
  readonly extraInputs?: readonly { readonly path: string; readonly content: string }[];
  /** One line under Objective saying where this story came from. */
  readonly note?: string;
  /**
   * The story's statement of the WORK, when it has one distinct from its
   * acceptance criteria. Only an implicit story does: `goal:` is what the run's
   * answers settle (`build/implicitPlan.ts`). It is not rendered as a section —
   * the whole file is inlined as the story — but it decides which touched paths
   * win the developer prompt's inline budget (`build/prompts.ts` `orderTouches`).
   */
  readonly goal?: readonly string[];
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
  /**
   * True when nobody planned this: the scope SKIPS the Plan phase and the plan
   * was synthesised from the What handoff (`build/implicitPlan.ts`). It changes
   * exactly two things downstream — an empty Definition of Done is green rather
   * than vacuously red, and the story's state is written back into the one
   * `04-build/implicit-plan.yml` instead of a `stories/<id>.md`.
   */
  readonly implicit: boolean;
  /** Run-relative path of the file this plan was read from — cited in messages. */
  readonly source: string;
  /**
   * What the Plan priced each story at, story id -> USD, from
   * `03-plan/budget.yml`'s `per_phase_usd`. Empty when the Plan wrote no budget,
   * when the file does not validate, or for an implicit plan (nobody priced it).
   *
   * This is the whole point of the Plan writing a budget: until 2026-08-30 the
   * file was authored, validated and read by NOTHING, so the Build executor split
   * its stage ceiling into equal shares regardless — and on
   * `260830-tenancy-identity-customers` handed the story Delivery had priced at
   * $4.75 exactly the same $1.03 as the one priced at $0.75.
   */
  readonly prices: ReadonlyMap<string, number>;
  /** One line for the operator when a `budget.yml` was there but unusable. */
  readonly priceIssue: string | null;
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

  const priced = loadPlanPrices(planDir, stories);
  return {
    waves, epics, stories, storyCount: stories.size,
    implicit: false,
    source: `${PLAN_PHASE}/${WAVES_FILE}`,
    prices: priced.prices,
    priceIssue: priced.issue,
  };
}

/**
 * `03-plan/budget.yml`'s `per_phase_usd`, narrowed to entries that name a story
 * this plan actually schedules and carry a positive amount.
 *
 * Never throws and never refuses the plan. A price is an OPTIMISATION — it makes
 * the executor's caps match what Delivery decided each story is worth — and a
 * plan whose budget file is missing or malformed must still build, on the uniform
 * shares it has always used. What it must not do is stay silent about it, so the
 * reason comes back as a line for the operator.
 */
export function loadPlanPrices(
  planDir: string,
  stories: ReadonlyMap<string, PlannedStory>,
): { prices: ReadonlyMap<string, number>; issue: string | null } {
  const empty = new Map<string, number>();
  const path = join(planDir, PLAN_BUDGET_FILE);
  if (!existsSync(path)) return { prices: empty, issue: null };

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    return { prices: empty, issue: budgetIgnored(`it does not parse (${String(error)})`) };
  }
  const validation = validateBudget(doc);
  if (!validation.ok) {
    const first = validation.issues[0];
    return {
      prices: empty,
      issue: budgetIgnored(`it does not validate (${first?.path ?? ""} ${first?.message ?? "schema error"})`),
    };
  }

  const perPhase = (doc as { per_phase_usd?: Record<string, unknown> }).per_phase_usd ?? {};
  const prices = new Map<string, number>();
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(perPhase)) {
    // A `per_phase_usd` keyed by PHASE rather than story is the run-root
    // budget.yml's shape and perfectly legal; it just prices nothing here.
    if (!STORY_ID_RE.test(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      skipped.push(`${key} (${String(value)})`);
      continue;
    }
    if (!stories.has(key)) {
      skipped.push(`${key} (not scheduled)`);
      continue;
    }
    prices.set(key, value);
  }
  if (prices.size === 0) {
    return {
      prices: empty,
      issue: skipped.length === 0
        ? null
        : budgetIgnored(`no usable story price in it — skipped ${skipped.join(", ")}`),
    };
  }
  return {
    prices,
    issue: skipped.length === 0
      ? null
      : `note: ${PLAN_PHASE}/${PLAN_BUDGET_FILE} priced ${String(prices.size)} story(ies); `
        + `skipped ${skipped.join(", ")}`,
  };
}

function budgetIgnored(why: string): string {
  return `warning: ${PLAN_PHASE}/${PLAN_BUDGET_FILE} was ignored because ${why} — `
    + "story caps fall back to an equal share of the stage ceiling";
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
