/**
 * The one write path for a run.
 *
 * Every command that changes a run — `run new`, `answer`, `approve`, `reject`, and
 * `next` when it lands — goes through here, so derived state (stage costs, phase
 * status, run status, the budget mirror, `updated_at`) is recomputed in exactly one
 * place and both files are revalidated before either touches disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, join } from "node:path";
import { parseYaml, parseYamlRepairing, type RepairedYaml } from "../yaml.ts";
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { asRunBudget, validateRunBudget, type RunBudget } from "../budget/RunBudget.ts";
import { noteDeprecations } from "../schemas/deprecationNotice.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { withWorkspaceLock, workspaceRootOfRunDir } from "../lock/workspaceLock.ts";
import { nowRfc3339 } from "../../hooks/lib/actor.ts";
import { frameworkVersionSync } from "../frameworkVersion.ts";
import { spentBasis, tallyOf } from "../budget/spentFigure.ts";
import { backupPathFor, writeAtomic } from "../fs/writeAtomic.ts";
import { emitBudgetYaml, emitRunYaml } from "./emitRunYaml.ts";
import {
  asRunFile, derivePhaseStatus, deriveRunStatus, flatten, isFinished, stageAt, validateRunFile,
  type RunFile, type RunPhase, type RunStage,
} from "./RunFile.ts";

export class RunStoreError extends Error {}

/** What `RunStore.save()` answers — see `cancelledUnder`. */
export interface SaveOutcome {
  /**
   * True when THIS save found a `cancelled:` on disk that this store did not
   * write — a `run cancel --force` landed while the store was held. The file has
   * already resolved in the cancel's favour; this is the process being told.
   */
  readonly cancelledUnder: boolean;
}

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
   * `run.yml` as THIS store last read it from disk or wrote it there. `save()`
   * writes back only what differs between `current` and this — see `runToWrite`.
   */
  private loaded: RunFile;
  /**
   * Sticky: once a save has seen a cancel land under this store, every later
   * save keeps the cancel's statuses too — see `carryChanges`.
   */
  private cancelledUnderFlag = false;
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
    this.loaded = run;
    this.currentBudget = budget;
  }

  static open(runDir: string): RunStore {
    const runPath = join(runDir, "run.yml");
    if (!existsSync(runPath)) throw new RunStoreError(`no run.yml in ${runDir}`);
    const run = parseStateFile(runPath);
    const validation = validateRunFile(run.doc);
    noteDeprecations(runPath, validation);
    if (!validation.ok) {
      const first = validation.issues[0];
      throw new RunStoreError(`invalid run.yml (${runPath}): ${first?.path ?? ""} ${first?.message ?? "schema error"}`);
    }
    const budgetPath = join(runDir, "budget.yml");
    if (!existsSync(budgetPath)) throw new RunStoreError(`no budget.yml in ${runDir}`);
    const budget = parseStateFile(budgetPath);
    const budgetValidation = validateRunBudget(budget.doc);
    noteDeprecations(budgetPath, budgetValidation);
    if (!budgetValidation.ok) {
      const first = budgetValidation.issues[0];
      throw new RunStoreError(`invalid budget.yml (${budgetPath}): ${first?.path ?? ""} ${first?.message ?? "schema error"}`);
    }
    const store = new RunStore(
      runDir, asRunFile(run.doc), asRunBudget(budget.doc), EventLog.forRun(runDir),
    );
    if (run.repaired || budget.repaired) store.healOnDisk(run.repaired, budget.repaired);
    return store;
  }

  /**
   * Write back a file that only parsed because `parseYamlRepairing` mended it.
   *
   * The repair happens in memory on every load, so the run is USABLE either way —
   * but leaving the broken bytes on disk means every reader keeps paying for the
   * repair, and any reader that does not know about it (an editor, `git diff`, a
   * person) still sees a broken file. One save fixes it for good, because the
   * emitter that writes it now escapes.
   *
   * Deliberately not `save()`: this must not touch `updated_at`, roll costs up,
   * or re-derive a single status. It re-emits exactly what was loaded, and it is
   * silent about everything except the fact that it happened. Failures are
   * swallowed — a read-only checkout or a workspace someone else has locked must
   * not turn a recovered read into a crash, and the in-memory repair still stands.
   */
  private healOnDisk(runRepaired: boolean, budgetRepaired: boolean): void {
    try {
      withWorkspaceLock(workspaceRootOfRunDir(this.runDir), () => {
        if (runRepaired) writeAtomic(join(this.runDir, "run.yml"), emitRunYaml(this.current));
        if (budgetRepaired) writeAtomic(join(this.runDir, "budget.yml"), emitBudgetYaml(this.currentBudget));
      });
      const which = [runRepaired ? "run.yml" : "", budgetRepaired ? "budget.yml" : ""]
        .filter((name) => name !== "").join(" and ");
      process.stderr.write(
        `tldrx: ${this.runDir}: ${which} held text broken across lines by an emitter bug ` +
          "since fixed. It was repaired in memory and rewritten correctly; the version that was " +
          "on disk is beside it as .bak. Nothing else about the run was changed.\n",
      );
    } catch {
      // Could not write — read-only, or someone else holds the lock. The
      // in-memory repair still stands, so every command works; the file on disk
      // is simply mended again on the next load.
    }
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

  /**
   * Has a `run cancel` landed under this store (gh #305)? True from the first
   * `save()` that merged one in, for the life of the store. A process holding
   * the run reads this after every save and spawns nothing more — `run.yml`
   * saying `cancelled` while a developer keeps spending is the record lying in
   * the expensive direction.
   */
  get cancelledUnder(): boolean {
    return this.cancelledUnderFlag;
  }

  /**
   * Is `<runDir>/run.yml` cancelled RIGHT NOW, on disk? The pre-spawn question
   * for a process that holds a store it has not saved for a while (the Build
   * fan-out saves only when it returns). Tolerant: a file that is gone or does
   * not parse answers `false` — "cannot tell" is not "cancelled", and the next
   * save says what it could not read.
   */
  static cancelledOnDisk(runDir: string): boolean {
    const path = join(runDir, "run.yml");
    if (!existsSync(path)) return false;
    try {
      const doc = parseYaml(readFileSync(path, "utf8"));
      return validateRunFile(doc).ok && asRunFile(doc).cancelled !== undefined;
    } catch {
      return false;
    }
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
   * Four things this does that a plain `writeFileSync` pair did not — three from
   * the 2026-08-29 resumability audit, the fourth from gh #305:
   *
   * 1. **Under `.tldrx/.lock`.** Both files are read-modified-written here and by
   *    `budget raise`; without a lock those two interleave.
   * 2. **Ceilings are re-read from disk.** This store may have loaded `budget.yml`
   *    minutes ago. A `budget raise` that landed since is on disk and not in
   *    memory, and writing our stale copy back silently reverted it (measured).
   *    So unless THIS store deliberately changed the ceilings (`mutateBudget`,
   *    which is what `raise` uses), the ceilings on disk win and we contribute
   *    only the actuals we just rolled up.
   * 3. **Temp + rename per file, and the replaced version kept as `<file>.bak`.**
   *    `renameSync` is atomic within a filesystem, so a reader either sees the
   *    whole old file or the whole new one — never the truncated middle of a
   *    `writeFileSync` that was killed. Same move `run new` already made for the
   *    run directory (`newRun.ts`). Atomic is not the same as GOOD, though, so
   *    `writeAtomic` also leaves one step back — see `core/fs/writeAtomic.ts`.
   * 4. **`run.yml` is re-read from disk too, and only what this store CHANGED is
   *    written over it** (gh #305). Point 2 fixed the lost update for one file
   *    and left the other: `tldrx run auto` holds one store for the whole of a
   *    stage — the Build fan-out included — and every save on it wrote `run.yml`
   *    whole from the copy loaded when the stage began. A `budget raise --stage`
   *    typed during that stage printed `12.60 → 62.60`, exited 0, and was back at
   *    12.60 after the loop's next save; the developers were capped on it
   *    (measured, installed 0.21.0). See `runToWrite` for the rule and what it is
   *    deliberately not.
   */
  save(): SaveOutcome {
    return withWorkspaceLock(workspaceRootOfRunDir(this.runDir), () => {
      const base = this.runToWrite();
      const rolled = rollUp(base.run);

      const runValidation = validateRunFile(rolled);
      if (!runValidation.ok) {
        const first = runValidation.issues[0];
        throw new RunStoreError(`refusing to write an invalid run.yml: ${first?.path ?? ""} ${first?.message ?? ""}`);
      }

      const budget = rollUpBudget(this.ceilingsToWrite(), rolled);
      const budgetValidation = validateRunBudget(budget);
      if (!budgetValidation.ok) {
        const first = budgetValidation.issues[0];
        throw new RunStoreError(`refusing to write an invalid budget.yml: ${first?.path ?? ""} ${first?.message ?? ""}`);
      }
      writeAtomic(join(this.runDir, "budget.yml"), emitBudgetYaml(budget));
      const runPath = join(this.runDir, "run.yml");
      writeAtomic(runPath, emitRunYaml(rolled));
      this.current = rolled;
      this.loaded = rolled;
      this.currentBudget = budget;
      this.budgetMutated = false;
      // Said AFTER the write, once it is true — and never silently (peer review
      // of #305, §7): the one case a merge cannot happen is exactly the case
      // where an external write may just have been overwritten, and the
      // operator who typed it would otherwise be the last to know.
      if (base.fallback !== null) {
        process.stderr.write(
          `tldrx: ${runPath} ${base.fallback}, so it could not be merged with: this process's copy of ` +
            `the run was written whole, and the version that was on disk is beside it as ${backupPathFor(runPath)}. ` +
            "A change another command wrote there since this process read the run (a budget raise, a " +
            "cancel, a rejection) may be in that backup and not in run.yml.\n",
        );
      }
      if (base.cancelledUnder) {
        this.cancelledUnderFlag = true;
        const who = rolled.cancelled;
        process.stderr.write(
          `tldrx: run ${rolled.run} was cancelled` +
            (who === undefined ? "" : ` by ${who.by} at ${who.at} (${who.note})`) +
            " while this process held it: the cancel's statuses were kept, this process's task rows were " +
            "recorded beside them, and nothing more may be spawned for it.\n",
        );
      }
      return { cancelledUnder: base.cancelledUnder };
    });
  }

  /**
   * The run this save should write: `run.yml` as it is on disk RIGHT NOW, with
   * only the fields this store changed since it last read or wrote the file
   * carried over it (`carryChanges`).
   *
   * Three outcomes, and they are deliberately not one. A file that is GONE is
   * merged with nothing and nothing is said — there was no external write to
   * lose. A file that exists but does not parse or does not validate cannot be
   * merged with, so the in-memory copy is written whole (`ceilingsToWrite`'s
   * fallback, and a save is not the place to fail over someone else's damage) —
   * but that is the one case an external write may be silently destroyed, so
   * `fallback` carries the reason and `save()` says so on stderr, beside the
   * `.bak` `writeAtomic` keeps of what was there. A file that records ANOTHER
   * run is not damage, it is a violated premise: the save REFUSES, naming both
   * ids and the path, and writes nothing — unreachable by path construction
   * today, and exactly the kind of overwrite that must not be reachable by
   * accident tomorrow.
   *
   * This is ownership by CHANGE, not a blind reload-and-merge, and the
   * distinction is the whole design (gh #305). A blind merge combines two
   * writers' copies into a state neither asked for. Here every value that lands
   * on disk was written by the store that changed it, and a store never carries
   * back a value it only ever loaded — so who owns a field is decided by who
   * writes it, which spec §2.2 lists: the loop owns the execution record
   * (statuses, cursor, task rows, costs, the gate it parks on, `build`,
   * `outcome`, `ship`), external commands own the decisions a person makes
   * (`stages[].budget_usd`, `cancelled`, gate signatures and rejections,
   * `gates_policy`, `questions_policy`, `attended_by`). The two sets never
   * change the same field, so neither can revert the other. Two writers that DO
   * change one field — a `run cancel --force` marking a stage `cancelled` that a
   * live loop is still marking `running` — are the case ownership cannot
   * settle, and that is why `cancelRun` refuses under a live `.lock` unless
   * forced, rather than this method guessing.
   *
   * Every derived field (`status` at all three levels, `cost_usd`, `spent_usd`,
   * `updated_at`, `last_written_by`) is recomputed by `rollUp` from the MERGED
   * document, so a roll-up never describes a mix of two moments. A decision
   * derived from fields with two owners — the economy refusal reads the loop's
   * spend against an operator's ceiling — records the figures it read beside
   * the verdict (`budget.blocked` carries `remaining_usd` and `ceiling_usd`; the
   * auto-gate note carries `budget=$x of $y`), because after this change the
   * file can legitimately hold a pair no single writer saw side by side.
   */
  private runToWrite(): { readonly run: RunFile; readonly fallback: string | null; readonly cancelledUnder: boolean } {
    const path = join(this.runDir, "run.yml");
    if (!existsSync(path)) return { run: this.current, fallback: null, cancelledUnder: false };
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(path, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { run: this.current, fallback: `could not be read or parsed (${detail})`, cancelledUnder: false };
    }
    const validation = validateRunFile(doc);
    if (!validation.ok) {
      const first = validation.issues[0];
      return {
        run: this.current,
        fallback: `does not validate (${first?.path ?? ""} ${first?.message ?? "schema error"})`,
        cancelledUnder: false,
      };
    }
    const onDisk = asRunFile(doc);
    if (onDisk.run !== this.current.run) {
      throw new RunStoreError(
        `refusing to write ${path}: it records run ${onDisk.run}, and this store holds run ` +
          `${this.current.run} — a save never overwrites another run's record`,
      );
    }
    // The one field two writers CAN both change, decided (gh #305, peer review):
    // a `cancelled:` on disk this store neither loaded nor wrote is a cancel
    // that landed under it, and cancelled is terminal and wins — see
    // `carryChanges` for exactly what is then not carried.
    const cancelledUnder = onDisk.cancelled !== undefined
      && this.loaded.cancelled === undefined
      && this.current.cancelled === undefined;
    return {
      run: carryChanges(onDisk, this.current, this.loaded, { cancelledWins: this.cancelledUnderFlag || cancelledUnder }),
      fallback: null,
      cancelledUnder,
    };
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
      //
      // A phase's ceiling is FOUR fields, not one. Three of them (#61): the
      // dollar figure, the host-token allowance, and the `economy:` that says
      // which of them governs — taking the number without the label would be the
      // worse half of both, a token allowance preserved into a phase this reader
      // has been told is priced in dollars, where `hostTokenCeiling` can no
      // longer see it.
      //
      // The fourth is `authorized_usd` (#170), and it is here for the same
      // reason with a sharper failure. The run-level grant keys ride in on
      // `{...onDisk}`, so a phase amount left off THIS list is erased by any
      // ordinary save — `tldrx next`, the Build executor, `approve`, `close` —
      // while `authorized_by` and `authorized_at` survive. That is worse than a
      // clean loss: budget.yml is left naming a fact as the authorizer of an
      // amount that is nowhere, `grantFor` returns null, and the phase silently
      // stops being governed. It is exactly the "recorded number that silently
      // governs nothing" state `grantFor`'s own docstring exists to prevent.
      //
      // For a file with no labels, no token ceilings and no grant, every one of
      // the four is identical on both sides and this is the same object it
      // always was.
      return {
        ...onDisk,
        phases: this.currentBudget.phases.map((mine) => {
          const theirs = onDisk.phases.find((p) => p.id === mine.id);
          return theirs === undefined ? mine : {
            ...mine,
            ceiling_usd: theirs.ceiling_usd,
            ceiling_host_tokens: theirs.ceiling_host_tokens,
            economy: theirs.economy,
            authorized_usd: theirs.authorized_usd,
          };
        }),
      };
    } catch {
      return this.currentBudget;
    }
  }
}

/**
 * Read and parse one of a run's two state files, or say something USEFUL about
 * why not.
 *
 * A raw parse throw from the YAML seam says `Unexpected character` and stops —
 * it names no file, and it does not say that this one file is what every other
 * command reads first. Measured 2026-08-31: an unescapable note corrupted a live
 * `run.yml`, and from then on every `tldrx` verb failed with that bare sentence,
 * with nothing to say where to look or what to do.
 *
 * `parseYamlRepairing` first tries to mend the one corruption we know how to
 * mend — a scalar broken across lines by the old emitter — so most files of that
 * shape never reach the error path at all. What is left here is a file nothing
 * mechanical can vouch for.
 *
 * So: name the file, quote the parser verbatim, say why everything is failing,
 * and point at the backup — while being straight that using it is a MANUAL
 * decision. `writeAtomic` keeps `<file>.bak`, but tldrx will not roll a file back
 * on its own: the backup is one save old, that save may be the work you want, and
 * silently reinstating an older state is exactly the kind of write nobody asked
 * for that this framework refuses everywhere else.
 */
function parseStateFile(path: string): RepairedYaml {
  const text = readFileSync(path, "utf8");
  try {
    return parseYamlRepairing(text);
  } catch (error) {
    const backup = backupPathFor(path);
    const detail = error instanceof Error ? error.message : String(error);
    throw new RunStoreError([
      `${path} does not parse: ${detail}`,
      "  every tldrx command on this run reads that file first, so all of them fail until it does",
      existsSync(backup)
        ? `  the version the last save replaced is at ${backup} — recovery is MANUAL and tldrx `
          + "will not do it for you:"
          + `\n    diff it, and if that version is the one you want, copy it back over ${basename(path)}`
        : `  there is no ${basename(backup)} beside it — this file has not been written since `
          + "backups arrived, so there is no previous version to go back to",
      "  a hand-edit is the other way out, and it is the only one that keeps work the backup predates",
    ].join("\n"));
  }
}

/**
 * `onDisk` with every field that differs between `mine` and `loaded` taken from
 * `mine` — top-level keys, then per phase, then per stage, matched by id; a
 * stage's `tasks` list is one field. A key `mine` dropped is dropped. A phase or
 * stage `onDisk` does not have is written as `mine` has it (the structure is
 * fixed at `run new`; this only says what happens if it is not).
 *
 * `cancelledWins` (gh #305, peer review): `cancelled` is terminal and wins the
 * one field two writers can both change. When the on-disk run was cancelled
 * under this store, its `cursor` change is not carried, and on every stage the
 * cancel marked `cancelled` its `status`/`started_at`/`ended_at` changes are not
 * carried — the stage stays cancelled. Its `tasks` ARE carried: those turns
 * happened and cost money, and a ledger that forgot them would be the other
 * lie. Every other field follows the ordinary rule.
 *
 * Exported so a test can pin it directly; `RunStore.save()` is its one caller.
 */
export function carryChanges(
  onDisk: RunFile,
  mine: RunFile,
  loaded: RunFile,
  rules: { readonly cancelledWins: boolean } = { cancelledWins: false },
): RunFile {
  const top = carryLevel(onDisk, mine, loaded, rules.cancelledWins ? ["phases", "cursor"] : ["phases"]);
  const phases = mine.phases.map((phase) => {
    const theirs = onDisk.phases.find((p) => p.id === phase.id);
    const was = loaded.phases.find((p) => p.id === phase.id);
    if (theirs === undefined || was === undefined) return phase;
    const stages = phase.stages.map((stage) => {
      const theirStage = theirs.stages.find((s) => s.id === stage.id);
      const wasStage = was.stages.find((s) => s.id === stage.id);
      if (theirStage === undefined || wasStage === undefined) return stage;
      const kept = rules.cancelledWins && theirStage.status === "cancelled"
        ? ["status", "started_at", "ended_at"]
        : [];
      return carryLevel(theirStage, stage, wasStage, kept);
    });
    return { ...carryLevel(theirs, phase, was, ["stages"]), stages };
  });
  return { ...top, phases };
}

/** One mapping level of `carryChanges`; `skip` names the keys the caller merges itself. */
function carryLevel<T extends object>(onDisk: T, mine: T, loaded: T, skip: readonly string[]): T {
  const out = { ...onDisk } as unknown as Record<string, unknown>;
  const theirs = mine as unknown as Record<string, unknown>;
  const was = loaded as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(was)])) {
    if (skip.includes(key)) continue;
    if (isDeepStrictEqual(theirs[key], was[key])) continue;
    if (theirs[key] === undefined) delete out[key];
    else out[key] = theirs[key];
  }
  return out as unknown as T;
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
    // Every write, not just the first (#183). `updated_at` says WHEN the run was
    // last touched and this says by WHICH tldrx — the pair is what makes a
    // behaviour change attributable to a release, and this repo shipped ten of
    // them in the week the 23 audited runs were recorded. It rides here, in the
    // one derivation `save()` runs before validating, so no command can write a
    // run.yml without it and none of them had to learn about it.
    last_written_by: frameworkVersionSync(),
  };
  return { ...next, status: deriveRunStatus(next) };
}

/** Mirror the run's per-phase actuals into budget.yml, keeping every ceiling. */
export function rollUpBudget(budget: RunBudget, run: RunFile): RunBudget {
  const spentByPhase = new Map<string, number>();
  for (const phase of run.phases) {
    spentByPhase.set(phase.id, round(phase.stages.reduce((sum, s) => sum + s.cost_usd, 0)));
  }
  // Counted from the SAME rows the dollars were summed from, in the same pass
  // over the same file, so `spent_usd` and its basis can never describe two
  // different sets of turns. `tallyOf` is the one implementation; this is only
  // the mirror into `budget.yml`.
  const tally = tallyOf(run.phases.flatMap((p) => p.stages.flatMap((s) => s.tasks)));
  return {
    ...budget,
    unmetered_tasks: tally.unmetered,
    spent_basis: spentBasis(tally.unmetered),
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
