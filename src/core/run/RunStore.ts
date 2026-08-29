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

/**
 * What `RunStore.resolve()` found: one run, no run at all, or several open runs
 * and no way to tell which was meant.
 *
 * A discriminated union rather than a throw, because `ambiguous` is not an error
 * at this layer — the status screen renders all of them, the statusline picks the
 * newest, and only the mutating commands refuse.
 */
export type RunResolution =
  | { readonly kind: "one"; readonly store: RunStore }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly open: readonly RunStore[] };

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
   * Resolve a run BY ID. Returns null when no such run dir exists; throws when the
   * run exists but does not parse, because an explicitly named broken run is a
   * thing the operator has to be told about, not skipped.
   *
   * The id is required. There is no "and otherwise guess" branch here on purpose:
   * with two runs open, guessing silently retargeted every later command at
   * whichever run was touched last. `resolve()` is the no-id door, and it can say
   * "ambiguous" out loud.
   */
  static find(root: string, runId: string): RunStore | null {
    const dir = listRunDirs(root).find((d) => basename(d) === runId);
    if (dir === undefined) return null;
    return RunStore.open(dir);
  }

  /**
   * Every OPEN run under `root`, newest first.
   *
   * "Open" is "not `done` and not `cancelled`", not `isTerminal`: a run whose
   * stage failed is exactly the run the operator is about to retry or reject, so
   * skipping it would make `tldrx next` answer "no non-terminal run" to the one
   * person who needs it.
   *
   * Order is `updated_at` descending. `listRunDirs` already yields the newest
   * folder name first and `Array.prototype.sort` is stable, so runs that share a
   * timestamp (it is second-precision) settle by folder name, which is
   * date-prefixed by construction (spec §2.2). A run that does not parse is
   * skipped — it cannot be acted on, and it must not hide the ones that can.
   */
  static findOpen(root: string): readonly RunStore[] {
    const open: RunStore[] = [];
    for (const dir of listRunDirs(root)) {
      let store: RunStore;
      try {
        store = RunStore.open(dir);
      } catch {
        continue;
      }
      if (isFinished(store.run.status)) continue;
      open.push(store);
    }
    return open.sort((a, b) => compareDesc(a.run.updated_at, b.run.updated_at));
  }

  /**
   * The one resolution every command goes through (spec §3).
   *
   * With an id: that run, or `none`. Without one: the single open run when there
   * IS exactly one, `none` when there are zero, and `ambiguous` — carrying every
   * candidate — when there are several. The caller decides what ambiguity means
   * for it; what it may not do any more is pick.
   */
  static resolve(root: string, runId?: string): RunResolution {
    if (runId !== undefined && runId !== "") {
      const store = RunStore.find(root, runId);
      return store === null ? { kind: "none" } : { kind: "one", store };
    }
    const open = RunStore.findOpen(root);
    const only = open[0];
    if (only === undefined) return { kind: "none" };
    if (open.length === 1) return { kind: "one", store: only };
    return { kind: "ambiguous", open };
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

  /**
   * The same, for `budget.yml`. `save()` re-derives every `spent_usd` from the run,
   * so this is only ever a way to change *ceilings* — which is exactly what
   * `tldrx budget raise` does, and the only hand-driven edit the file allows.
   */
  mutateBudget(fn: (budget: RunBudget) => RunBudget): void {
    this.currentBudget = fn(structuredClone(this.currentBudget) as RunBudget);
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

/** Newest first, with ties left to the caller's (stable) input order. */
function compareDesc(a: string, b: string): number {
  if (a > b) return -1;
  return a < b ? 1 : 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
