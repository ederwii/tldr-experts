/**
 * The run facts the statusline and the SessionStart hook both need, read once.
 *
 * `RunStore` is the authority — it is the same validated view `next`, `approve`
 * and `run status` work from, so the status line can never disagree with the
 * command that wrote it. But a hook must fail OPEN (spec §4): a run.yml that
 * does not satisfy every §2.2 invariant is still a run a human wants to see on
 * their status line, so a validation failure degrades to the tolerant reader the
 * hooks already use rather than blanking the display.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "../run/RunStore.ts";
import { isTerminal } from "../run/RunFile.ts";
import { openRunViews, cursorStage } from "../../hooks/lib/runFile.ts";
import { openQuestionIds, phaseDirs } from "../facilitator/skipIf.ts";

export type SnapshotSource = "run-store" | "tolerant";

export interface RunSnapshot {
  readonly runDir: string;
  readonly run: string;
  readonly title: string;
  readonly scope: string;
  readonly status: string;
  readonly phase: string;
  readonly stage: string;
  readonly stageStatus: string;
  readonly expert: string | null;
  /** Terminal stages / all stages, across the whole run. */
  readonly done: number;
  readonly total: number;
  readonly ceilingUsd: number;
  readonly spentUsd: number;
  /** How many runs are open right now, this one included. Never 0. */
  readonly openCount: number;
  readonly source: SnapshotSource;
}

/** The newest OPEN run under `root`, or null when there is none. */
export function runSnapshot(root: string): RunSnapshot | null {
  return fromStore(root) ?? fromTolerantRead(root);
}

/** Open question ids across every phase folder of the run. */
export function openQuestions(snapshot: RunSnapshot): readonly string[] {
  const ids: string[] = [];
  for (const phase of phaseDirs(snapshot.runDir)) {
    ids.push(...openQuestionIds(join(snapshot.runDir, phase, "questions.md")));
  }
  return ids;
}

function fromStore(root: string): RunSnapshot | null {
  let open: readonly RunStore[];
  try {
    open = RunStore.findOpen(root);
  } catch {
    return null;
  }
  // The NEWEST open run, plus how many there are. A status line must show one
  // run — it is one line — but it must not pretend the other two do not exist.
  const store = open[0];
  if (store === undefined) return null;
  const run = store.run;
  const entry = store.cursorEntry();
  const stages = run.phases.flatMap((phase) => phase.stages);
  return {
    runDir: store.runDir,
    run: run.run,
    title: run.title,
    scope: run.scope,
    status: run.status,
    phase: run.cursor.phase,
    stage: run.cursor.stage,
    stageStatus: entry?.stage.status ?? run.status,
    expert: entry?.stage.expert ?? null,
    done: stages.filter((stage) => isTerminal(stage.status)).length,
    total: stages.length,
    ceilingUsd: run.budget.ceiling_usd,
    spentUsd: run.budget.spent_usd,
    openCount: open.length,
    source: "run-store",
  };
}

function fromTolerantRead(root: string): RunSnapshot | null {
  const open = openRunViews(root);
  const view = open[0];
  if (view === undefined) return null;
  const stage = cursorStage(view);
  const stages = view.phases.flatMap((phase) => phase.stages);
  const budget = readBudgetMirror(view.dir);
  return {
    runDir: view.dir,
    run: view.run,
    title: view.title,
    scope: view.scope,
    status: view.status,
    phase: view.cursor?.phase ?? "",
    stage: view.cursor?.stage ?? "",
    stageStatus: stage?.status === undefined || stage.status === "" ? view.status : stage.status,
    expert: stage?.expert ?? null,
    done: stages.filter((s) => isTerminal(s.status)).length,
    total: stages.length,
    ceilingUsd: budget.ceiling_usd,
    spentUsd: budget.spent_usd,
    openCount: open.length,
    source: "tolerant",
  };
}

/** `run.yml`'s budget mirror, scraped without schema validation. */
function readBudgetMirror(runDir: string): { ceiling_usd: number; spent_usd: number } {
  const path = join(runDir, "run.yml");
  if (!existsSync(path)) return { ceiling_usd: 0, spent_usd: 0 };
  try {
    const text = readFileSync(path, "utf8");
    return {
      ceiling_usd: numberAfter(text, "ceiling_usd"),
      spent_usd: numberAfter(text, "spent_usd"),
    };
  } catch {
    return { ceiling_usd: 0, spent_usd: 0 };
  }
}

function numberAfter(text: string, key: string): number {
  const match = new RegExp(`${key}:\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(text);
  return match === null ? 0 : Number(match[1]);
}
