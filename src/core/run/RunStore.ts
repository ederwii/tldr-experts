/**
 * The one write path for a run.
 *
 * Every command that changes a run — `run new`, `answer`, `approve`, `reject`, and
 * `next` when it lands — goes through here, so derived state (stage costs, phase
 * status, run status, the budget mirror, `updated_at`) is recomputed in exactly one
 * place and both files are revalidated before either touches disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { asRunBudget, validateRunBudget, type RunBudget } from "../budget/RunBudget.ts";
import { noteDeprecations } from "../schemas/deprecationNotice.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { withWorkspaceLock, workspaceRootOfRunDir } from "../lock/workspaceLock.ts";
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
  /**
   * Did anyone call `mutateBudget`? Only then may this store's CEILINGS win over
   * whatever is on disk at save time — see `save()`.
   */
  private budgetMutated = false;

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
    noteDeprecations(runPath, validation);
    if (!validation.ok) {
      const first = validation.issues[0];
      throw new RunStoreError(`invalid run.yml (${runPath}): ${first?.path ?? ""} ${first?.message ?? "schema error"}`);
    }
    const budgetPath = join(runDir, "budget.yml");
    if (!existsSync(budgetPath)) throw new RunStoreError(`no budget.yml in ${runDir}`);
    const budgetDoc = parseYaml(readFileSync(budgetPath, "utf8"));
    const budgetValidation = validateRunBudget(budgetDoc);
    noteDeprecations(budgetPath, budgetValidation);
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
    this.budgetMutated = true;
  }

  append(event: TldrxEvent): void {
    this.events.append(event);
  }

  /**
   * Recompute everything derived, revalidate both files, then write. A validation
   * failure throws BEFORE the first byte lands, so a run is never left half-written.
   *
   * Three things this does that a plain `writeFileSync` pair did not, all from the
   * 2026-08-29 resumability audit:
   *
   * 1. **Under `.tldrx/.lock`.** `budget.yml` is read-modified-written here and by
   *    `budget raise`; without a lock those two interleave.
   * 2. **Ceilings are re-read from disk.** This store may have loaded `budget.yml`
   *    minutes ago. A `budget raise` that landed since is on disk and not in
   *    memory, and writing our stale copy back silently reverted it (measured).
   *    So unless THIS store deliberately changed the ceilings (`mutateBudget`,
   *    which is what `raise` uses), the ceilings on disk win and we contribute
   *    only the actuals we just rolled up.
   * 3. **Temp + rename per file.** `renameSync` is atomic within a filesystem, so
   *    a reader either sees the whole old file or the whole new one — never the
   *    truncated middle of a `writeFileSync` that was killed. Same move `run new`
   *    already made for the run directory (`newRun.ts`).
   */
  save(): void {
    const rolled = rollUp(this.current);

    const runValidation = validateRunFile(rolled);
    if (!runValidation.ok) {
      const first = runValidation.issues[0];
      throw new RunStoreError(`refusing to write an invalid run.yml: ${first?.path ?? ""} ${first?.message ?? ""}`);
    }

    withWorkspaceLock(workspaceRootOfRunDir(this.runDir), () => {
      const budget = rollUpBudget(this.ceilingsToWrite(), rolled);
      const budgetValidation = validateRunBudget(budget);
      if (!budgetValidation.ok) {
        const first = budgetValidation.issues[0];
        throw new RunStoreError(`refusing to write an invalid budget.yml: ${first?.path ?? ""} ${first?.message ?? ""}`);
      }
      writeAtomic(join(this.runDir, "budget.yml"), emitBudgetYaml(budget));
      writeAtomic(join(this.runDir, "run.yml"), emitRunYaml(rolled));
      this.current = rolled;
      this.currentBudget = budget;
      this.budgetMutated = false;
    });
  }

  /**
   * The ceilings this save should write: ours when we changed them on purpose,
   * otherwise whatever is on disk right now. Falls back to the in-memory copy
   * when the file is gone or does not parse — a save is not the place to fail
   * over someone else's damage.
   */
  private ceilingsToWrite(): RunBudget {
    if (this.budgetMutated) return this.currentBudget;
    const path = join(this.runDir, "budget.yml");
    if (!existsSync(path)) return this.currentBudget;
    try {
      const doc = parseYaml(readFileSync(path, "utf8"));
      const validation = validateRunBudget(doc);
      if (!validation.ok) return this.currentBudget;
      const onDisk = asRunBudget(doc);
      // Only CEILINGS come from disk. Actuals are ours: `rollUpBudget` overwrites
      // every `spent_usd` from the run we are about to write.
      return {
        ...onDisk,
        phases: this.currentBudget.phases.map((mine) => {
          const theirs = onDisk.phases.find((p) => p.id === mine.id);
          return theirs === undefined ? mine : { ...mine, ceiling_usd: theirs.ceiling_usd };
        }),
      };
    } catch {
      return this.currentBudget;
    }
  }
}

/**
 * Write via a sibling temp file and `renameSync`.
 *
 * The temp name carries the pid so two processes writing the same file cannot
 * collide on the temp itself, and it is removed on the failure path so a crashed
 * write leaves no litter next to the real file.
 */
function writeAtomic(path: string, content: string): void {
  const temp = `${path}.tmp-${String(process.pid)}`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) rmSync(temp, { force: true });
    } catch {
      // Nothing to clean up, or not ours to clean up.
    }
    throw error;
  }
}

/** Costs up from tasks, statuses up from stages, `updated_at` to now. */
export function rollUp(run: RunFile): RunFile {
  const phases = run.phases.map((phase) => {
    const stages = phase.stages.map((stage) => ({
      ...stage,
      // An unmetered task (`cost_usd: null`) contributes nothing. That makes the
      // stage total a LOWER BOUND rather than a measurement, which is exactly
      // what it is — `run status` and `budget show` say so rather than let the
      // number read as complete.
      cost_usd: round(stage.tasks.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0)),
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
