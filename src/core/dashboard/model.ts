/**
 * ONE plain-JSON model of everything the dashboard shows, read from the files.
 *
 * Wave 6 constraint (Alan, 2026-08-29): "one JSON model from the files, thin
 * templating, no framework — a UI/UX redesign will replace the rendering layer
 * later, so keep data model and renderer separate." So this file reads, and
 * `render.ts` draws. Nothing here emits markup except `handoffHtml`, which is
 * the Markdown converter's output and is documented as such
 * (`docs/dashboard-model.md`).
 *
 * The model is JSON by construction: strings, numbers, booleans, nulls, arrays
 * and plain objects only. It is what `GET /model.json` serves verbatim, what the
 * static export renders from, and what a future designer targets.
 *
 * `run.yml` + `events.jsonl` remain the only run data source (spec §2.9), with
 * the phase artefacts (`handoff.md`, `questions.md`) and the Plan artefacts
 * (`stories/`, `epics/`, `waves.yml`) read through the existing parsers. Nothing
 * here talks to a network or a model.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { MAX_LEVEL, loadExperts, driftWarnings, evidenceWarnings, type ExpertRecord } from "../experts/index.ts";
import { listRuns, loadPhaseArtefacts, loadRun, type LoadedRun } from "../replay/index.ts";
import { openBlocks, parseQuestions } from "../text/index.ts";
import { renderMarkdown } from "../markdown/index.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { asWavesFile, validateWaves } from "../schemas/waves.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { validateEpicFile } from "../schemas/epic.ts";
import { parseYaml } from "../yaml.ts";
import { offlineHtml } from "./offlineHtml.ts";

/** Bumped when a field is removed or changes meaning, never for an addition. */
export const DASHBOARD_MODEL_VERSION = 1;

export interface StageRowModel {
  readonly phase: string;
  readonly id: string;
  readonly status: string;
  readonly expert: string | null;
  readonly model: string | null;
  readonly costUsd: number;
  readonly budgetUsd: number | null;
  /** `"approve: pending"`, or null when the stage has no gate. */
  readonly gate: string | null;
  /**
   * Who closed the gate: `auto` when the facilitator did (spec §5), the
   * operator's name when a person did, null while it is still open. ADDITIVE —
   * `gate` keeps its exact old spelling, so nothing reading it has to change.
   */
  readonly gateBy: string | null;
}

export interface QuestionOptionModel {
  readonly letter: string;
  readonly text: string;
}

export interface QuestionModel {
  readonly id: string;
  readonly title: string;
  readonly whyAsked: string | null;
  readonly options: readonly QuestionOptionModel[];
  /** The exact terminal command that answers it. */
  readonly answerCommand: string;
}

export interface PhaseModel {
  readonly id: string;
  readonly status: string;
  /**
   * `<run>/<phase>/handoff.md` converted to HTML, with external anchors demoted
   * to visible text. Null when the phase has no handoff yet.
   *
   * `[assumption]` The handoff is one file per phase folder on disk (spec §1)
   * even though §2.8 speaks of one handoff per stage, so it is carried once per
   * phase and labelled with the phase.
   */
  readonly handoffHtml: string | null;
  readonly questions: readonly QuestionModel[];
}

export interface StoryModel {
  readonly id: string;
  readonly epic: string;
  readonly title: string;
  readonly repo: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  /** The wave id this story runs in, or null when `waves.yml` does not schedule it. */
  readonly wave: string | null;
}

export interface EpicModel {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
  readonly status: string;
  readonly stories: readonly string[];
}

export interface WaveModel {
  readonly id: string;
  readonly stories: readonly string[];
}

export interface PlanModel {
  /** The phase folder the Plan artefacts were found in, e.g. `03-plan`. */
  readonly phase: string;
  readonly stories: readonly StoryModel[];
  readonly epics: readonly EpicModel[];
  readonly waves: readonly WaveModel[];
  /** Files that are there but unreadable — shown, never swallowed. */
  readonly unreadable: readonly string[];
}

export interface RunModel {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly workflow: string;
  readonly repos: readonly string[];
  readonly status: string;
  readonly updatedAt: string | null;
  /** `"<phase> / <stage>"`, or null when run.yml records no cursor. */
  readonly cursor: string | null;
  readonly spentUsd: number | null;
  readonly ceilingUsd: number | null;
  readonly stagesTotal: number;
  readonly stagesDone: number;
  /** 0–100, rounded. */
  readonly percent: number;
  /** The gate the run is waiting on, if any. */
  readonly pendingGate: string | null;
  /** The first open question, `"<id> · <title>"`, if any. */
  readonly pendingQuestion: string | null;
  /** The execution path, one row per stage, in run.yml order. */
  readonly path: readonly StageRowModel[];
  readonly phases: readonly PhaseModel[];
  /** The Plan phase's stories/epics/waves, when the run has written them. */
  readonly plan: PlanModel | null;
  /** Lowercased haystack the client-side run filter matches against. */
  readonly filter: string;
}

export interface AreaModel {
  readonly id: string;
  readonly title: string;
  /** Recomputed from evidence at read time (spec §2.6) — this is what is shown. */
  readonly level: number;
  /** The number that was on disk. Never shown as the level. */
  readonly storedLevel: number | null;
  readonly evidenceCount: number;
  readonly newestEvidence: string | null;
  readonly trainPrompt: string;
}

export interface ExpertModel {
  readonly name: string;
  readonly status: string;
  readonly lastTrained: string | null;
  readonly areas: readonly AreaModel[];
  /**
   * Stored-vs-computed level disagreements and evidence rows no reader could
   * count, already worded for a reader. The page has no other channel — a
   * dashboard that drops a row without a line is as silent as the reader was.
   */
  readonly warnings: readonly string[];
  readonly error: string | null;
}

export interface FaqEntryModel {
  readonly heading: string;
  readonly commands: readonly string[];
}

export interface DashboardModel {
  readonly modelVersion: number;
  readonly generatedAt: string;
  readonly root: string;
  readonly workspace: string;
  /** False when there is no `.tldrx/` at `root` — the page says so instead of looking empty. */
  readonly workspaceFound: boolean;
  /** True when this model is being served by the watching server rather than exported. */
  readonly live: boolean;
  /** Highest competency level, so the renderer never has to know the constant. */
  readonly maxLevel: number;
  readonly runs: readonly RunModel[];
  readonly experts: readonly ExpertModel[];
  readonly faq: readonly FaqEntryModel[];
}

const TERMINAL = new Set(["done", "failed", "skipped", "cancelled"]);
const WAVES_FILE = "waves.yml";
const STORIES_DIR = "stories";
const EPICS_DIR = "epics";

export interface ModelOptions {
  readonly live?: boolean;
  /** `now` for the competency staleness window. */
  readonly now?: Date;
}

/** Read the whole workspace into one JSON-serialisable model. */
export function buildModel(root: string, generatedAt: string, options: ModelOptions = {}): DashboardModel {
  const now = options.now ?? new Date();
  const runs: RunModel[] = [];
  for (const id of listRuns(root)) {
    const loaded = loadRun(root, id);
    if (loaded !== null) runs.push(toRunModel(loaded));
  }
  return {
    modelVersion: DASHBOARD_MODEL_VERSION,
    generatedAt,
    root,
    workspace: basename(root),
    workspaceFound: existsSync(join(root, PROJECT_FRAMEWORK_DIR)),
    live: options.live === true,
    maxLevel: MAX_LEVEL,
    runs,
    experts: loadExperts(root, now).map(toExpertModel),
    faq: FAQ,
  };
}

export function toRunModel(loaded: LoadedRun): RunModel {
  const doc = loaded.run;

  const phases: PhaseModel[] = doc.phases.map((phase) => {
    const artefacts = loadPhaseArtefacts(loaded, phase.id);
    return {
      id: phase.id,
      status: phase.status,
      handoffHtml: artefacts.handoff === null ? null : offlineHtml(renderMarkdown(artefacts.handoff)),
      questions: artefacts.questions === null
        ? []
        : openBlocks(parseQuestions(artefacts.questions).blocks).map((block) => ({
            id: block.id,
            title: block.title,
            whyAsked: block.whyAsked,
            options: block.options.map((option) => ({ letter: option.letter, text: option.text })),
            answerCommand: `tldrx answer ${block.id} "your answer"`,
          })),
    };
  });

  const path: StageRowModel[] = doc.phases.flatMap((phase) =>
    phase.stages.map((stage) => ({
      phase: phase.id,
      id: stage.id,
      status: stage.status,
      expert: stage.expert,
      model: stage.model,
      costUsd: stage.cost_usd,
      budgetUsd: stage.budget_usd,
      gate: stage.gate === null ? null : `${stage.gate.type}: ${stage.gate.status}`,
      gateBy: stage.gate === null ? null : stage.gate.by,
    })),
  );

  const stages = doc.phases.flatMap((phase) => phase.stages);
  const gate = stages.find((stage) => stage.gate !== null && stage.gate.status === "pending");
  const question = phases.flatMap((phase) => phase.questions)[0];
  const stagesTotal = stages.length;
  const stagesDone = stages.filter((stage) => TERMINAL.has(stage.status)).length;

  return {
    id: loaded.id,
    title: doc.title,
    scope: doc.scope,
    workflow: doc.workflow,
    repos: doc.repos,
    status: doc.status,
    updatedAt: doc.updated_at,
    cursor: doc.cursor === null ? null : `${doc.cursor.phase} / ${doc.cursor.stage}`,
    spentUsd: doc.spent_usd,
    ceilingUsd: doc.ceiling_usd,
    stagesTotal,
    stagesDone,
    percent: stagesTotal === 0 ? 0 : Math.round((stagesDone / stagesTotal) * 100),
    pendingGate: gate === undefined ? null : gate.id,
    pendingQuestion: question === undefined ? null : `${question.id} · ${question.title}`,
    path,
    phases,
    plan: loadPlan(loaded),
    filter: [doc.run, doc.title, doc.scope, doc.status].join(" ").toLowerCase(),
  };
}

/**
 * The Plan artefacts, when the run has any.
 *
 * `[assumption]` The Plan phase is found by looking for the folder that holds
 * `waves.yml` or `stories/`, rather than by hard-coding `03-plan`: the phase id
 * comes from the workflow preset, and a custom workflow may name it differently.
 * Read tolerantly — a half-written story is listed as unreadable, never dropped
 * silently and never a reason to refuse to draw the page.
 */
function loadPlan(loaded: LoadedRun): PlanModel | null {
  for (const phase of loaded.run.phases) {
    const dir = join(loaded.dir, phase.id);
    const hasWaves = existsSync(join(dir, WAVES_FILE));
    const hasStories = existsSync(join(dir, STORIES_DIR));
    if (!hasWaves && !hasStories) continue;

    const unreadable: string[] = [];
    const waves = hasWaves ? readWaves(join(dir, WAVES_FILE), unreadable) : [];
    const scheduled = new Map<string, string>();
    for (const wave of waves) for (const story of wave.stories) if (!scheduled.has(story)) scheduled.set(story, wave.id);

    const stories: StoryModel[] = [];
    for (const name of markdownIn(join(dir, STORIES_DIR))) {
      const parsed = read(join(dir, STORIES_DIR, name), unreadable, `${STORIES_DIR}/${name}`);
      if (parsed === null) continue;
      const story = validateStoryFile(parsed).story;
      if (story === null) {
        unreadable.push(`${STORIES_DIR}/${name}`);
        continue;
      }
      stories.push({
        id: story.id,
        epic: story.epic,
        title: story.title,
        repo: story.repo,
        status: story.status,
        dependsOn: story.depends_on,
        wave: scheduled.get(story.id) ?? null,
      });
    }

    const epics: EpicModel[] = [];
    for (const name of markdownIn(join(dir, EPICS_DIR))) {
      const parsed = read(join(dir, EPICS_DIR, name), unreadable, `${EPICS_DIR}/${name}`);
      if (parsed === null) continue;
      const epic = validateEpicFile(parsed).epic;
      if (epic === null) {
        unreadable.push(`${EPICS_DIR}/${name}`);
        continue;
      }
      epics.push({
        id: epic.id,
        title: epic.title,
        branch: epic.branch,
        status: epic.status,
        stories: epic.stories,
      });
    }

    if (stories.length === 0 && epics.length === 0 && waves.length === 0 && unreadable.length === 0) return null;
    return { phase: phase.id, stories, epics, waves, unreadable };
  }
  return null;
}

function readWaves(path: string, unreadable: string[]): readonly WaveModel[] {
  const text = read(path, unreadable, WAVES_FILE);
  if (text === null) return [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    unreadable.push(WAVES_FILE);
    return [];
  }
  if (!validateWaves(doc).ok) {
    unreadable.push(WAVES_FILE);
    return [];
  }
  return asWavesFile(doc).waves.map((wave) => ({ id: wave.id, stories: wave.stories }));
}

function read(path: string, unreadable: string[], label: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    unreadable.push(label);
    return null;
  }
}

function markdownIn(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function toExpertModel(expert: ExpertRecord): ExpertModel {
  return {
    name: expert.name,
    status: expert.status,
    lastTrained: expert.lastTrained,
    areas: expert.areas.map((area) => ({
      id: area.id,
      title: area.title,
      level: area.level,
      storedLevel: area.storedLevel,
      evidenceCount: area.evidence.length,
      newestEvidence: area.newestEvidence,
      trainPrompt: area.trainPrompt,
    })),
    warnings: [...driftWarnings(expert), ...evidenceWarnings(expert)],
    error: expert.error,
  };
}

/**
 * The how-to, as data rather than markup — a designer re-laying the page out
 * should not have to dig commands out of a template.
 */
const FAQ: readonly FaqEntryModel[] = [
  { heading: "Open a piece of work", commands: ["tldrx run new --scope feature --budget 25"] },
  { heading: "Run the next stage — it stops at gates and questions", commands: ["tldrx next"] },
  { heading: "Answer an open question", commands: ['tldrx answer Q4 "rankings are global, same as Places"'] },
  {
    heading: "Approve or reject the stage waiting at a gate",
    commands: ['tldrx approve --note "contracts look right"', 'tldrx reject --note "split the migration out"'],
  },
  { heading: "Read the story of a run", commands: ["tldrx replay 260828-leaderboard"] },
  { heading: "Watch it live, or export a snapshot", commands: ["tldrx dashboard", "tldrx dashboard --static"] },
];
