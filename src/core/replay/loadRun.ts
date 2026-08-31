/**
 * Load everything the read-only views read about one run: `run.yml`,
 * `budget.yml`, `events.jsonl` (with line numbers) and the phase artefacts.
 *
 * Events go through the existing `EventLog` reader — retro needs the 1-based
 * line of each event for its `[src: …events.jsonl:<line>]` tokens, so the raw
 * text is re-scanned only to number the lines the reader already returned. No
 * second JSON parser.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EventLog, type TldrxEvent } from "../events/index.ts";
import { parseYaml } from "../yaml.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { toBudgetDocument, toRunDocument, type BudgetDocument, type RunDocument } from "./RunDocument.ts";

export const RUN_FILE = "run.yml";
export const BUDGET_FILE = "budget.yml";
export const EVENTS_FILE = "events.jsonl";
export const QUESTIONS_FILE = "questions.md";
export const HANDOFF_FILE = "handoff.md";

export interface NumberedEvent {
  /** 1-based line number in events.jsonl. */
  readonly line: number;
  readonly event: TldrxEvent;
}

export interface PhaseArtefacts {
  readonly phase: string;
  readonly handoff: string | null;
  readonly questions: string | null;
}

export interface LoadedRun {
  readonly root: string;
  readonly dir: string;
  readonly id: string;
  readonly run: RunDocument;
  readonly budget: BudgetDocument | null;
  readonly events: readonly NumberedEvent[];
  /** Set when events.jsonl exists but could not be read. */
  readonly eventsError: string | null;
  /** Non-empty lines of `events.jsonl` that did not parse (a torn write). */
  readonly eventsSkipped: number;
}

export function workDir(root: string): string {
  return join(root, PROJECT_WORK_DIR);
}

export function runDir(root: string, run: string): string {
  return join(workDir(root), run);
}

/** Every run folder that has a run.yml, newest folder name first (ids are date-prefixed). */
export function listRuns(root: string): readonly string[] {
  const work = workDir(root);
  if (!existsSync(work)) return [];
  return readdirSync(work)
    .filter((entry) => {
      const dir = join(work, entry);
      return statSync(dir).isDirectory() && existsSync(join(dir, RUN_FILE));
    })
    .sort()
    .reverse();
}

/** null when the run folder or its run.yml does not exist — the caller exits 3. */
export function loadRun(root: string, id: string): LoadedRun | null {
  const dir = runDir(root, id);
  const runPath = join(dir, RUN_FILE);
  if (!existsSync(runPath)) return null;

  const run = toRunDocument(parseYaml(readFileSync(runPath, "utf8")), id);
  if (run === null) return null;

  const budgetPath = join(dir, BUDGET_FILE);
  const budget = existsSync(budgetPath)
    ? toBudgetDocument(parseYaml(readFileSync(budgetPath, "utf8")))
    : null;

  const { events, error, skipped } = readEvents(dir);
  return { root, dir, id, run, budget, events, eventsError: error, eventsSkipped: skipped };
}

/**
 * `EventLog.readAll` carries the line number of every event it could parse, so a
 * torn line no longer shifts every number after it — and the ones it had to skip
 * are counted rather than thrown, which is what `renderReplay` prints.
 */
function readEvents(dir: string): { events: readonly NumberedEvent[]; error: string | null; skipped: number } {
  const path = join(dir, EVENTS_FILE);
  if (!existsSync(path)) return { events: [], error: null, skipped: 0 };
  try {
    const parsed = new EventLog(path).readAll();
    return {
      events: parsed.events.map((event, index) => ({ line: parsed.lines[index] ?? index + 1, event })),
      error: null,
      skipped: parsed.skipped,
    };
  } catch (error) {
    return { events: [], error: error instanceof Error ? error.message : String(error), skipped: 0 };
  }
}

/** `<run>/<phase>/handoff.md` and `questions.md`, when they exist. */
export function loadPhaseArtefacts(loaded: LoadedRun, phase: string): PhaseArtefacts {
  const read = (name: string): string | null => {
    const path = join(loaded.dir, phase, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  return { phase, handoff: read(HANDOFF_FILE), questions: read(QUESTIONS_FILE) };
}

/**
 * The COMMITTED evidence note a gate points at, when it is there.
 *
 * `gate.evidence.path` is run-relative by construction, and a path that escapes
 * the run directory is refused rather than read: a viewer must never be steerable
 * into printing a file outside the run it was asked about.
 */
export function loadGateEvidence(loaded: LoadedRun, relPath: string): string | null {
  if (relPath === "" || relPath.includes("..") || relPath.startsWith("/")) return null;
  const path = join(loaded.dir, ...relPath.split("/"));
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Events belonging to one stage, in file order. */
export function stageEvents(loaded: LoadedRun, stage: string): readonly NumberedEvent[] {
  return loaded.events.filter((item) => item.event.stage === stage);
}

/** Run-level events (`stage: null`), in file order. */
export function runLevelEvents(loaded: LoadedRun): readonly NumberedEvent[] {
  return loaded.events.filter((item) => item.event.stage === null);
}
