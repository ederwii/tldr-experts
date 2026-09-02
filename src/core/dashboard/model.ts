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
 * `run.yml` is the run data source, with the phase artefacts (`handoff.md`,
 * `questions.md`) and the Plan artefacts (`stories/`, `epics/`, `waves.yml`)
 * read through the existing parsers. Nothing here talks to a network or a model.
 *
 * **`events.jsonl` is NOT read**, and the page must not say it is (measured
 * 2026-09-01: nothing in this file or in `loadPhaseArtefacts` opens the ledger).
 * That is why every events-only fact is absent — operator notes (`tldrx note`),
 * per-attempt costs, story reopens and review retries all live in the ledger and
 * in no other file. Reading it is a real change with a panel behind it, not a
 * line in a doc comment; until somebody makes it, the honest thing is to name
 * the files that ARE read.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { MAX_LEVEL, loadExperts, driftWarnings, evidenceWarnings, type ExpertRecord } from "../experts/index.ts";
import { listRuns, loadPhaseArtefacts, loadRunResult, type LoadedRun } from "../replay/index.ts";
import { hasStarted, resolveDependencies, type DependencyInput, type ResolvedRun } from "../run/dependencies.ts";
import { isMovable, waitingFor, type Waiting } from "../run/waiting.ts";
import { openBlocks, parseQuestions } from "../text/index.ts";
import { renderMarkdown } from "../markdown/index.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { asWavesFile, validateWaves } from "../schemas/waves.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { validateEpicFile } from "../schemas/epic.ts";
import { parseYaml } from "../yaml.ts";
import { offlineHtml } from "./offlineHtml.ts";

/**
 * Bumped when a field is removed or changes meaning, never for an addition.
 *
 * 1 → 2: `pendingQuestion` used to be "the first open question anywhere in the
 * run" and is now "the question the run STOPPED for" — null while the run is at
 * a gate, however many blocks are open in an already-approved phase.
 * `pendingGate` kept its documented meaning but not its behaviour: it used to
 * be the first stage whose gate object read `pending`, which on an untouched
 * run is every stage. Both are aliases of `waiting` now. A consumer reading
 * either gets different data than it did at v1, which is exactly what this
 * number is for.
 *
 * **v3 (#60).** `runnable` changed for one shape: a run that has STARTED and was
 * proposed to follow a sibling that has not finished. It read `false`, because
 * `blockedBy` alone decided; it now reads `true`, because a proposal recorded
 * before either run existed cannot un-start a run that is running. `blockedBy`
 * itself is unchanged and still lists those siblings — the new `started` field is
 * what says whether they still hold anything back.
 */
export const DASHBOARD_MODEL_VERSION = 3;

/**
 * What an `agent` gate was signed over (`run.yml` `gate.evidence`, design §A.5).
 *
 * Carried because the page already prints WHO closed a gate, and for an agent
 * that is a name with nothing behind it. `run.yml` records the counts and the
 * path of the COMMITTED note, so a reader can audit the signature from a clone
 * instead of taking it. Null on every gate a person or the facilitator closed,
 * which is most gates ever written.
 */
export interface GateEvidenceModel {
  /** Run-relative path of the committed note. Text — the page fetches nothing. */
  readonly path: string;
  readonly role: string;
  readonly verdict: string;
  readonly sampled: number | null;
  readonly of: number | null;
  readonly resolved: number | null;
  readonly refuted: number | null;
  readonly outsideSurface: number | null;
}

/** What the Build claimed on disk (`run.yml` `build`). */
export interface BuildModel {
  /**
   * `per-epic` | `integration`, or null on a run.yml written before the key
   * existed (issue #57). Null is not `per-epic`: nobody recorded a choice.
   */
  readonly branchModel: string | null;
  /** Epic branches this run cut or adopted. A list even under `integration`. */
  readonly epicBranches: readonly string[];
}

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
  /**
   * Who is MEANT to sign it: `human` waits for `tldrx approve`, `auto` lets the
   * facilitator close it when the §5 conditions hold, `agent` lets a sub-agent
   * close it over a validated evidence note (spec §2.2 `gates_policy`). Absence
   * reads as `human` everywhere, including on a run.yml written before the key
   * existed — the safe default is the one that stops, and `gatePolicyFor` applies
   * exactly the same rule.
   */
  readonly gatePolicy: string;
  /** What an `agent` policy signed this gate over, or null. */
  readonly gateEvidence: GateEvidenceModel | null;
  /**
   * True when an earlier stage's gate was revoked after this one ran (`run.yml`
   * `stage.stale`). The outputs are still on disk and still read as current.
   */
  readonly stale: boolean;
}

/**
 * What ONE run is waiting on — the same record `tldrx run status --json` prints.
 *
 * Not derived here. `waitingFor` (`src/core/run/waiting.ts`) is the single
 * derivation both screens call, so the page and the CLI cannot disagree about
 * whether a run is at a gate, holding a question, failed, or simply ready.
 */
export interface WaitingModel {
  /** `gate` | `answer` | `ready` | `done` | `blocked` | `failed`. */
  readonly kind: string;
  readonly message: string;
  /** Open question ids in the cursor phase, when it is waiting on answers. */
  readonly questions: readonly string[];
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
  /**
   * METERED dollars only, and a LOWER BOUND whenever `unmeteredTasks > 0`.
   *
   * Read it with the two fields below or not at all: a host-attended run whose
   * every turn was billed to somebody's session sums to `0` here, and that is a
   * true statement about what this process measured and a false one about what
   * the run cost.
   */
  readonly spentUsd: number | null;
  readonly ceilingUsd: number | null;
  /**
   * `host` when a host session drives the turns (`run.yml` `attended_by`), null
   * when the framework may spawn. Same wording `tldrx run status` prints.
   */
  readonly attendedBy: string | null;
  /** Turns whose cost nobody declared. `spentUsd` is a lower bound when > 0. */
  readonly unmeteredTasks: number;
  /** Host-session tokens declared with `--tokens`. A DIFFERENT currency: never added to dollars. */
  readonly hostTokens: number;
  readonly stagesTotal: number;
  readonly stagesDone: number;
  /** 0–100, rounded. */
  readonly percent: number;
  /** What this run is waiting on. The one field to read; the two below alias it. */
  readonly waiting: WaitingModel;
  /**
   * The stage held at a gate, or null. DERIVED from `waiting`: non-null only
   * when `waiting.kind === "gate"`. Kept for one release for templates that
   * already read it — new code should read `waiting`.
   */
  readonly pendingGate: string | null;
  /**
   * The question the run stopped for, `"<id> · <title>"`, or null. DERIVED from
   * `waiting`: non-null only when `waiting.kind === "answer"`. Open questions in
   * an already-approved phase still appear under `phases[].questions`; they are
   * not what the run is waiting on.
   */
  readonly pendingQuestion: string | null;
  /**
   * Runs this one was proposed to follow (`run.yml` `triage.depends_on`),
   * resolved from slugs to run ids. A slug with no run in this workspace keeps
   * its raw slug — it was proposed to come first and it does not exist.
   */
  readonly dependsOn: readonly string[];
  /**
   * The subset of `dependsOn` that is not `done`.
   *
   * A fact about the PROPOSAL, not a verdict on this run: read it with `started`
   * (#60). A run that has begun is not held back by an order proposed before it
   * existed, and a cell that renders this as "blocked by" without checking is
   * making the claim the issue was filed about.
   */
  readonly blockedBy: readonly string[];
  /** This run has left `pending` — work has observably begun (#60). */
  readonly started: boolean;
  /** A human could move it right now, and nothing that still applies blocks it. */
  readonly runnable: boolean;
  /** The execution path, one row per stage, in run.yml order. */
  readonly path: readonly StageRowModel[];
  readonly phases: readonly PhaseModel[];
  /** The Plan phase's stories/epics/waves, when the run has written them. */
  readonly plan: PlanModel | null;
  /** What the Build cut on disk, when it has cut anything. */
  readonly build: BuildModel | null;
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

/** A run folder that exists but whose `run.yml` could not be parsed. */
export interface UnreadableRun {
  readonly id: string;
  /** The parser's own words, verbatim. */
  readonly error: string;
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
  /**
   * Run folders whose `run.yml` is on disk but does not parse. Named rather than
   * skipped: a run the operator can see in `tldrx-work/` and cannot see here is
   * a page telling a lie by omission.
   */
  readonly unreadable: readonly UnreadableRun[];
  /**
   * Every run id in the order a human should work through them: topological on
   * `dependsOn`, runnable first, then newest-updated. The head is the run to do
   * next. `runs` stays newest-first, so a renderer can offer either.
   */
  readonly order: readonly string[];
  /**
   * Root-to-leaf dependency paths, for an `A → B → C` rendering. Every arrow is
   * a real `depends_on` edge, so a fork yields one chain per branch rather than
   * one flattened list claiming an order nobody asked for. Chains of one are
   * omitted and the list is capped (`MAX_CHAINS`).
   */
  readonly chains: readonly (readonly string[])[];
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

  // Two passes, because "what blocks this run" is a fact about its SIBLINGS.
  // Read every run first, resolve the whole graph once, then build each model
  // knowing its place in it. `listRuns` is newest-first, which is the order
  // `resolveDependencies` uses to settle a slug carried by two runs.
  const loaded: LoadedRun[] = [];
  const unreadable: UnreadableRun[] = [];
  for (const id of listRuns(root)) {
    // One corrupt run.yml used to throw straight through here and kill the
    // server (measured 2026-08-31). A run that cannot be read is now a row on
    // the page, not the end of the page.
    const result = loadRunResult(root, id);
    if (result.kind === "ok") loaded.push(result.run);
    else if (result.kind === "unreadable") unreadable.push({ id, error: result.error });
  }
  const waiting = new Map(loaded.map((run) => [run.id, waitingFor(run.run, run.dir)]));
  const graph = resolveDependencies(loaded.map((run): DependencyInput => ({
    id: run.id,
    status: run.run.status,
    dependsOn: run.run.triage?.depends_on ?? [],
    movable: isMovable(waiting.get(run.id)?.kind ?? "blocked"),
    updatedAt: run.run.updated_at,
  })));
  const resolved = new Map(graph.runs.map((run) => [run.id, run]));

  return {
    modelVersion: DASHBOARD_MODEL_VERSION,
    generatedAt,
    root,
    workspace: basename(root),
    workspaceFound: existsSync(join(root, PROJECT_FRAMEWORK_DIR)),
    live: options.live === true,
    maxLevel: MAX_LEVEL,
    runs: loaded.map((run) => toRunModel(run, waiting.get(run.id), resolved.get(run.id))),
    unreadable,
    order: graph.order,
    chains: graph.chains,
    experts: loadExperts(root, now).map(toExpertModel),
    faq: FAQ,
  };
}

/**
 * One run, as the page needs it.
 *
 * `waiting` and `resolution` are arguments rather than second derivations so a
 * caller that already computed them for the whole workspace does not pay twice.
 * Both fall back to the honest answer for a run with no siblings: its own
 * waiting derivation, and "nothing blocks it".
 */
export function toRunModel(
  loaded: LoadedRun,
  waiting?: Waiting,
  resolution?: ResolvedRun,
): RunModel {
  const doc = loaded.run;
  const waits = waiting ?? waitingFor(doc, loaded.dir);
  const depends: ResolvedRun = resolution ?? {
    id: loaded.id,
    dependsOn: [],
    blockedBy: [],
    started: hasStarted(doc.status),
    runnable: isMovable(waits.kind),
  };

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
      gatePolicy: doc.gates_policy[stage.id] ?? "human",
      gateEvidence: stage.gate?.evidence == null
        ? null
        : {
            path: stage.gate.evidence.path,
            role: stage.gate.evidence.role,
            verdict: stage.gate.evidence.verdict,
            sampled: stage.gate.evidence.sampled,
            of: stage.gate.evidence.of,
            resolved: stage.gate.evidence.resolved,
            refuted: stage.gate.evidence.refuted,
            outsideSurface: stage.gate.evidence.outside_surface,
          },
      stale: stage.stale,
    })),
  );

  // The two economies, counted once and never added together (issue #22). A
  // dollar and a host token have no exchange rate, so this carries both numbers
  // and the count of turns that produced neither.
  const tasks = doc.phases.flatMap((phase) => phase.stages).flatMap((stage) => stage.tasks);
  const unmeteredTasks = tasks.filter((task) => !task.metered).length;
  const hostTokens = tasks.reduce((sum, task) => sum + (task.tokens ?? 0), 0);

  const stages = doc.phases.flatMap((phase) => phase.stages);
  const open = phases.flatMap((phase) => phase.questions);
  // Both aliases are now DERIVED from `waiting`, never from the gate objects.
  // The old `pendingGate` was "the first stage whose gate.status is pending" —
  // which on a run nobody has started is EVERY stage, so a fresh run drew a red
  // "waiting at a gate" card while `tldrx run status` called it `ready`.
  const held = doc.cursor === null || waits.kind !== "gate" ? null : doc.cursor.stage;
  const asked = waits.kind !== "answer"
    ? undefined
    : open.find((item) => item.id === waits.questions[0]) ?? open[0];
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
    attendedBy: doc.attended_by,
    unmeteredTasks,
    hostTokens,
    stagesTotal,
    stagesDone,
    percent: stagesTotal === 0 ? 0 : Math.round((stagesDone / stagesTotal) * 100),
    waiting: { kind: waits.kind, message: waits.message, questions: waits.questions },
    pendingGate: held,
    pendingQuestion: asked === undefined ? null : `${asked.id} · ${asked.title}`,
    dependsOn: depends.dependsOn,
    blockedBy: depends.blockedBy,
    started: depends.started,
    runnable: depends.runnable,
    path,
    phases,
    plan: loadPlan(loaded),
    build: doc.build === null
      ? null
      : { branchModel: doc.build.branch_model, epicBranches: doc.build.epic_branch },
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
