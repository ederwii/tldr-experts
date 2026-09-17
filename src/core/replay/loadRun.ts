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
import { parseYamlRepairing } from "../yaml.ts";
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
  /**
   * When `events.jsonl` was last written, ISO-8601 to the second — null when
   * there is no file, and null when the stat itself failed.
   *
   * Carried HERE rather than stat-ed by a caller, because this module is the one
   * that owns the path. A viewer that wants to say how long a run has been
   * untouched needs a fallback for a ledger whose lines it could not parse, and
   * the alternative was every such viewer re-deriving `<dir>/events.jsonl` for
   * itself. It is a WEAKER fact than the last event's own `ts` — the file was
   * touched, which is not the same as the run moving — so a caller that uses it
   * is expected to say which of the two it is showing.
   */
  readonly eventsMtime: string | null;
}

export function workDir(root: string): string {
  return join(root, PROJECT_WORK_DIR);
}

export function runDir(root: string, run: string): string {
  return join(workDir(root), run);
}

/**
 * Every run folder that has a run.yml, newest folder name first (ids are
 * date-prefixed).
 *
 * Every filesystem call here is guarded, because a live reader asks this while
 * something else is writing (#108). Two shapes used to throw straight through
 * `buildModel` and take `tldrx dashboard` down with them: an entry removed
 * between the `readdir` and its `stat` (ENOENT — which is also what a dangling
 * symlink looks like), and a `tldrx-work` that is not a directory at all
 * (ENOTDIR). Neither is a run, and neither is a reason to stop listing the
 * others.
 */
export function listRuns(root: string): readonly string[] {
  const work = workDir(root);
  let entries: readonly string[];
  try {
    entries = readdirSync(work);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => {
      const dir = join(work, entry);
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, RUN_FILE));
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

/**
 * One run, or the honest reason there isn't one.
 *
 * `missing` and `unreadable` are different facts and the views act on them
 * differently: a run that is not there is a 3, a run whose `run.yml` does not
 * parse is a run the operator HAS and needs told about. Collapsing the two — or
 * throwing, which is what this did until 2026-08-31 — is how one corrupt file
 * took down `tldrx dashboard` for a whole workspace: the raw `YAMLParseError`
 * escaped `buildModel`, killed the server, and every other run went with it.
 */
export type RunLoad =
  | { readonly kind: "ok"; readonly run: LoadedRun }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly dir: string; readonly error: string };

export function loadRunResult(root: string, id: string): RunLoad {
  const dir = runDir(root, id);
  const runPath = join(dir, RUN_FILE);
  if (!existsSync(runPath)) return { kind: "missing" };

  let doc: unknown;
  try {
    doc = parseYamlRepairing(readFileSync(runPath, "utf8")).doc;
  } catch (error) {
    return { kind: "unreadable", dir, error: error instanceof Error ? error.message : String(error) };
  }
  const run = toRunDocument(doc, id);
  if (run === null) return { kind: "missing" };

  // A broken budget.yml must not cost the run either: the views treat a missing
  // budget as `null` already, so an unreadable one becomes the same null rather
  // than an exception thrown through a page that was rendering fine.
  //
  // `budgetDamagedReason` is set ONLY when the file EXISTS and its parse threw —
  // a run with no `budget.yml` at all is not damaged, it simply never had one
  // (every run written before #85, and any economy that skips the file), and
  // §245 leaves that case alone. The reason is named here, at the one place that
  // both checks existence and attempts the parse, because a null `budget` alone
  // loses the WHY (§7) — and the ceiling resolution below needs it to say which.
  const budgetPath = join(dir, BUDGET_FILE);
  const budgetExists = existsSync(budgetPath);
  let budget: BudgetDocument | null = null;
  let budgetDamagedReason: string | null = null;
  if (budgetExists) {
    try {
      budget = toBudgetDocument(parseYamlRepairing(readFileSync(budgetPath, "utf8")).doc);
    } catch (error) {
      budgetDamagedReason =
        `${BUDGET_FILE} could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // The run ceiling comes from budget.yml, never from run.yml's mirror (#236).
  //
  // Resolved HERE because this is the one place both files are in hand, so every
  // consumer of a `LoadedRun` — `tldrx replay` and the dashboard — gets the same
  // figure from one derivation (§7). It is not an optional freshening: run.yml's
  // budget block is HALF LIVE. `RunStore.rollUp` re-derives `spent_usd` on every
  // save while carrying `ceiling_usd` through untouched, so the two keys sitting
  // beside each other in one mapping describe two different moments, and a view
  // that prints them as one sentence says things like `$12.00 spent of $10.00
  // ceiling` — measured through the CLI on a run raised $10 → $30. "A replay
  // narrates the document" does not rescue it: the document itself is mixed.
  //
  // Owner decision on #245 (2026-09-17): "Null con razón" — a DAMAGED budget.yml
  // no longer falls back to the frozen creation mirror. That fallback used to
  // pair a live `spent_usd` with a ceiling that stopped moving at `run new`,
  // printing the same impossible `$X spent of $Y ceiling` (Y < X) that #236
  // fixed for the ordinary case — narrower (it also needs a raise) but the same
  // lie. A budget.yml that EXISTS but will not parse gives a null ceiling with
  // `ceiling_basis: "absent"` and a reason naming the file and why, so every
  // renderer falls back to the `$?` it already prints for a spend it cannot
  // read. A budget.yml that is simply MISSING is not "damaged" — the mirror is
  // the only figure that was ever going to exist for that run, so it is kept
  // (`ceiling_basis: "mirror"`), exactly as before #245.
  //
  // Deviation, measured: the issue's own "What" section says "missing or does
  // not parse"; narrowed here to "exists but does not parse" because (a) the
  // owner's decision names a DAMAGED file, (b) the issue's own reproduction
  // damages an existing budget.yml rather than deleting it, and (c)
  // `test/dashboard-hero.test.ts` and `test/dashboard-sources.test.ts` already
  // pin the mirror fallback for a run with no budget.yml at all — nulling that
  // case reddened both on the full suite (measured, `bun test`, 2026-09-17).
  const withLiveCeiling = budgetExists
    ? (budget?.ceiling_usd === null || budget?.ceiling_usd === undefined
      ? { ...run, ceiling_usd: null, ceiling_basis: "absent" as const,
          ceiling_reason: budgetDamagedReason ?? `${BUDGET_FILE} does not record a ceiling` }
      : { ...run, ceiling_usd: budget.ceiling_usd, ceiling_basis: "recorded" as const, ceiling_reason: null })
    : { ...run, ceiling_basis: "mirror" as const, ceiling_reason: null };

  const { events, error, skipped, mtime } = readEvents(dir);
  return {
    kind: "ok",
    run: {
      root, dir, id, run: withLiveCeiling, budget, events,
      eventsError: error, eventsSkipped: skipped, eventsMtime: mtime,
    },
  };
}

/**
 * null when the run folder, its run.yml, or a readable run.yml does not exist —
 * the caller exits 3. Callers that must TELL the operator which of those it was
 * use `loadRunResult`.
 */
export function loadRun(root: string, id: string): LoadedRun | null {
  const result = loadRunResult(root, id);
  return result.kind === "ok" ? result.run : null;
}

/**
 * `EventLog.readAll` carries the line number of every event it could parse, so a
 * torn line no longer shifts every number after it — and the ones it had to skip
 * are counted rather than thrown, which is what `renderReplay` prints.
 */
function readEvents(dir: string): {
  events: readonly NumberedEvent[];
  error: string | null;
  skipped: number;
  mtime: string | null;
} {
  const path = join(dir, EVENTS_FILE);
  if (!existsSync(path)) return { events: [], error: null, skipped: 0, mtime: null };
  // One stat, on the file this function is already opening. To the second, like
  // every other timestamp a viewer prints.
  let mtime: string | null = null;
  try {
    mtime = `${new Date(statSync(path).mtimeMs).toISOString().slice(0, 19)}Z`;
  } catch {
    mtime = null;
  }
  try {
    const parsed = new EventLog(path).readAll();
    return {
      events: parsed.events.map((event, index) => ({ line: parsed.lines[index] ?? index + 1, event })),
      error: null,
      skipped: parsed.skipped,
      mtime,
    };
  } catch (error) {
    return { events: [], error: error instanceof Error ? error.message : String(error), skipped: 0, mtime };
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
