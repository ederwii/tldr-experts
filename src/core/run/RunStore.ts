/**
 * The one write path for a run.
 *
 * Every command that changes a run — `run new`, `answer`, `approve`, `reject`, and
 * `next` when it lands — goes through here, so derived state (stage costs, phase
 * status, run status, the budget mirror, `updated_at`) is recomputed in exactly one
 * place and both files are revalidated before either touches disk.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { asRunBudget, validateRunBudget, type RunBudget } from "../budget/RunBudget.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { nowRfc3339 } from "../../hooks/lib/actor.ts";
import { emitBudgetYaml, emitRunYaml } from "./emitRunYaml.ts";
import {
  asRunFile, derivePhaseStatus, deriveRunStatus, flatten, isFinished, stageAt, validateRunFile,
  type RunFile, type RunPhase, type RunStage,
} from "./RunFile.ts";

export class RunStoreError extends Error {}

export interface CursorEntry {
  readonly phase: RunPhase;
  readonly stage: RunStage;
}

export class RunStore {
  private current: RunFile;
  private currentBudget: RunBudget;

  private constructor(
    readonly runDir: string,
    run: RunFile,
    budget: RunBudget,
    readonly events: EventLog,
  ) {
    this.current = run;
    this.currentBudget = budget;
  }

  static open(runDir: string): RunStore {
    const runPath = join(runDir, "run.yml");
    if (!existsSync(runPath)) throw new RunStoreError(`no run.yml in ${runDir}`);
    const doc = parseYaml(readFileSync(runPath, "utf8"));
    const validation = validateRunFile(doc);
    if (!validation.ok) {
      const first = validation.issues[0];
      throw new RunStoreError(`invalid run.yml (${runPath}): ${first?.path ?? ""} ${first?.message ?? "schema error"}`);
    }
    const budgetPath = join(runDir, "budget.yml");
    if (!existsSync(budgetPath)) throw new RunStoreError(`no budget.yml in ${runDir}`);
    const budgetDoc = parseYaml(readFileSync(budgetPath, "utf8"));
    const budgetValidation = validateRunBudget(budgetDoc);
    if (!budgetValidation.ok) {
      const first = budgetValidation.issues[0];
      throw new RunStoreError(`invalid budget.yml (${budgetPath}): ${first?.path ?? ""} ${first?.message ?? "schema error"}`);
    }
    return new RunStore(runDir, asRunFile(doc), asRunBudget(budgetDoc), EventLog.forRun(runDir));
  }

  /**
   * Resolve a run by id, or the newest unfinished one when no id is given
   * (spec §3: `run status [<run>]`). Returns null when nothing matches.
   *
   * "Unfinished" is `done`/`cancelled`, not `isTerminal`: a run whose stage failed
   * is exactly the run the operator is about to retry or reject, so skipping it
   * would make `tldrx next` answer "no non-terminal run" to the one person who
   * needs it.
   */
  static find(root: string, runId?: string): RunStore | null {
    const dirs = listRunDirs(root);
    if (runId !== undefined && runId !== "") {
      const dir = dirs.find((d) => basename(d) === runId);
      if (dir === undefined) return null;
      return RunStore.open(dir);
    }
    let newest: RunStore | null = null;
    for (const dir of dirs) {
      let store: RunStore;
      try {
        store = RunStore.open(dir);
      } catch {
        continue; // a run we cannot parse is not the newest live run
      }
      if (isFinished(store.run.status)) continue;
      if (newest === null || store.run.updated_at > newest.run.updated_at) newest = store;
    }
    return newest;
  }

  get run(): RunFile {
    return this.current;
  }

  get budget(): RunBudget {
    return this.currentBudget;
  }

  get runId(): string {
    return this.current.run;
  }

  /** The stage the cursor points at, or null when the file is inconsistent. */
  cursorEntry(): CursorEntry | null {
    return stageAt(this.current, this.current.cursor);
  }

  /** The stage after the cursor in execution order, or null at the end of the run. */
  nextEntry(): CursorEntry | null {
    const all = flatten(this.current);
    const at = all.findIndex(
      (e) => e.phase.id === this.current.cursor.phase && e.stage.id === this.current.cursor.stage,
    );
    if (at === -1) return null;
    return all[at + 1] ?? null;
  }

  /** Apply a mutation to a deep copy. Nothing is written until `save()`. */
  mutate(fn: (run: RunFile) => RunFile): void {
    this.current = fn(structuredClone(this.current) as RunFile);
  }

  append(event: TldrxEvent): void {
    this.events.append(event);
  }

  /**
   * Recompute everything derived, revalidate both files, then write. A validation
   * failure throws BEFORE the first byte lands, so a run is never left half-written.
   */
  save(): void {
    const rolled = rollUp(this.current);
    const budget = rollUpBudget(this.currentBudget, rolled);

    const runValidation = validateRunFile(rolled);
    if (!runValidation.ok) {
      const first = runValidation.issues[0];
      throw new RunStoreError(`refusing to write an invalid run.yml: ${first?.path ?? ""} ${first?.message ?? ""}`);
    }
    const budgetValidation = validateRunBudget(budget);
    if (!budgetValidation.ok) {
      const first = budgetValidation.issues[0];
      throw new RunStoreError(`refusing to write an invalid budget.yml: ${first?.path ?? ""} ${first?.message ?? ""}`);
    }

    writeFileSync(join(this.runDir, "budget.yml"), emitBudgetYaml(budget), "utf8");
    writeFileSync(join(this.runDir, "run.yml"), emitRunYaml(rolled), "utf8");
    this.current = rolled;
    this.currentBudget = budget;
  }
}

/** Costs up from tasks, statuses up from stages, `updated_at` to now. */
export function rollUp(run: RunFile): RunFile {
  const phases = run.phases.map((phase) => {
    const stages = phase.stages.map((stage) => ({
      ...stage,
      cost_usd: round(stage.tasks.reduce((sum, t) => sum + t.cost_usd, 0)),
    }));
    const withStages: RunPhase = { ...phase, stages, status: "pending" };
    return { ...withStages, status: derivePhaseStatus(withStages) };
  });
  const spent = round(
    phases.reduce((sum, p) => sum + p.stages.reduce((s, st) => s + st.cost_usd, 0), 0),
  );
  const next: RunFile = {
    ...run,
    phases,
    budget: { ...run.budget, spent_usd: spent },
    updated_at: nowRfc3339(),
  };
  return { ...next, status: deriveRunStatus(next) };
}

/** Mirror the run's per-phase actuals into budget.yml, keeping every ceiling. */
export function rollUpBudget(budget: RunBudget, run: RunFile): RunBudget {
  const spentByPhase = new Map<string, number>();
  for (const phase of run.phases) {
    spentByPhase.set(phase.id, round(phase.stages.reduce((sum, s) => sum + s.cost_usd, 0)));
  }
  return {
    ...budget,
    phases: budget.phases.map((p) => ({ ...p, spent_usd: spentByPhase.get(p.id) ?? p.spent_usd })),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
