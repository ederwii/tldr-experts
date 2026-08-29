/**
 * Everything the static dashboard shows, gathered from files.
 *
 * `run.yml` + `events.jsonl` are the dashboard's only run data source (spec §2.9),
 * with the phase artefacts (`handoff.md`, `questions.md`) read through the
 * existing text parsers. Nothing here talks to a network or a model.
 */
import { loadExperts, type ExpertRecord } from "../experts/index.ts";
import { listRuns, loadPhaseArtefacts, loadRun, type LoadedRun } from "../replay/index.ts";
import { openBlocks, parseQuestions, type QuestionBlock } from "../text/index.ts";

export interface PhaseView {
  readonly id: string;
  readonly status: string;
  /**
   * `[assumption]` The handoff is one file per phase folder on disk
   * (`<run>/<phase>/handoff.md`, spec §1) even though §2.8 speaks of one handoff
   * per stage, so it is rendered once per phase and labelled with the phase.
   */
  readonly handoff: string | null;
  readonly questions: readonly QuestionBlock[];
}

export interface RunView {
  readonly loaded: LoadedRun;
  readonly phases: readonly PhaseView[];
  readonly stagesTotal: number;
  readonly stagesDone: number;
  /** The gate the run is waiting on, if any. */
  readonly pendingGate: string | null;
  /** The first open question, if any. */
  readonly pendingQuestion: string | null;
}

export interface DashboardData {
  readonly root: string;
  readonly generatedAt: string;
  readonly runs: readonly RunView[];
  readonly experts: readonly ExpertRecord[];
}

const TERMINAL = new Set(["done", "failed", "skipped", "cancelled"]);

export function collect(root: string, generatedAt: string, now: Date = new Date()): DashboardData {
  const runs: RunView[] = [];
  for (const id of listRuns(root)) {
    const loaded = loadRun(root, id);
    if (loaded !== null) runs.push(toRunView(loaded));
  }
  return { root, generatedAt, runs, experts: loadExperts(root, now) };
}

export function toRunView(loaded: LoadedRun): RunView {
  const phases: PhaseView[] = loaded.run.phases.map((phase) => {
    const artefacts = loadPhaseArtefacts(loaded, phase.id);
    return {
      id: phase.id,
      status: phase.status,
      handoff: artefacts.handoff,
      questions: artefacts.questions === null ? [] : openBlocks(parseQuestions(artefacts.questions).blocks),
    };
  });

  const stages = loaded.run.phases.flatMap((phase) => phase.stages);
  const gate = stages.find((stage) => stage.gate !== null && stage.gate.status === "pending");
  const question = phases.flatMap((phase) => phase.questions)[0];

  return {
    loaded,
    phases,
    stagesTotal: stages.length,
    stagesDone: stages.filter((stage) => TERMINAL.has(stage.status)).length,
    pendingGate: gate === undefined ? null : gate.id,
    pendingQuestion: question === undefined ? null : `${question.id} · ${question.title}`,
  };
}
