/**
 * The slice of `run.yml` (spec §2.2) the hooks need: the cursor, the run status,
 * and the budget ceiling of the stage the cursor points at.
 *
 * Deliberately tolerant — a hook that cannot parse a run must fail open, not
 * argue about schema. `tldrx next` owns full validation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../../core/yaml.ts";
import { listRunDirs } from "./workspace.ts";

export const TERMINAL_STATUSES = ["done", "failed", "skipped", "cancelled"] as const;

export interface RunCursor {
  readonly phase: string;
  readonly stage: string;
  readonly task: string | null;
}

/**
 * One `tasks[]` row, in the only three fields a budget decision needs (issue #22).
 *
 * They are what `tldrx next --commit` writes for an IN-SESSION turn: `cost_usd:
 * null` + `metered: false` when nobody costed it, and `tokens:` when the host
 * declared a figure with `--tokens`. Skipping `tasks[]` entirely — which this
 * reader did — meant a run driven by a host session read as `$0.00` spent, which
 * is true of the dollars and says nothing about what actually happened.
 */
export interface RunTaskView {
  readonly cost_usd: number | null;
  /** False when this turn's cost is unmetered. Absent in run.yml means metered. */
  readonly metered: boolean;
  /** Host-session tokens the host declared, or null when it declared none. */
  readonly tokens: number | null;
}

export interface RunStage {
  readonly id: string;
  readonly status: string;
  readonly expert: string | null;
  readonly budget_usd: number | null;
  /** What the stage has metered so far — the reviewer floor's own clamp needs it. */
  readonly cost_usd: number | null;
  readonly tasks: readonly RunTaskView[];
}

export interface RunPhaseView {
  readonly id: string;
  readonly status: string;
  readonly stages: readonly RunStage[];
}

export interface RunView {
  readonly dir: string;
  readonly run: string;
  readonly title: string;
  readonly scope: string;
  readonly status: string;
  readonly updated_at: string;
  /**
   * `attended_by:` verbatim (spec §2.2), or null when the run carries none.
   *
   * Read rather than assumed since issue #22. Both consumers of this view make a
   * claim about spending — the `budget-gate` hook and the status line — and
   * "nobody is driving this run" and "I did not look" are not the same answer.
   */
  readonly attended_by: string | null;
  readonly cursor: RunCursor | null;
  readonly phases: readonly RunPhaseView[];
}

export function loadRunView(runDir: string): RunView | null {
  const path = join(runDir, "run.yml");
  if (!existsSync(path)) return null;
  let doc: Record<string, unknown>;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    doc = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawCursor = doc.cursor as Record<string, unknown> | undefined;
  const cursor: RunCursor | null =
    rawCursor === undefined || rawCursor === null
      ? null
      : {
          phase: str(rawCursor.phase),
          stage: str(rawCursor.stage),
          task: typeof rawCursor.task === "string" ? rawCursor.task : null,
        };
  const phases: RunPhaseView[] = [];
  if (Array.isArray(doc.phases)) {
    for (const entry of doc.phases as Record<string, unknown>[]) {
      const stages: RunStage[] = [];
      if (Array.isArray(entry?.stages)) {
        for (const s of entry.stages as Record<string, unknown>[]) {
          stages.push({
            id: str(s?.id),
            status: str(s?.status),
            expert: typeof s?.expert === "string" ? s.expert : null,
            budget_usd: typeof s?.budget_usd === "number" ? s.budget_usd : null,
            cost_usd: typeof s?.cost_usd === "number" ? s.cost_usd : null,
            tasks: tasksOf(s?.tasks),
          });
        }
      }
      phases.push({ id: str(entry?.id), status: str(entry?.status), stages });
    }
  }
  return {
    dir: runDir,
    run: str(doc.run) || str(doc.run_id),
    title: str(doc.title),
    scope: str(doc.scope),
    status: str(doc.status),
    updated_at: str(doc.updated_at),
    attended_by: typeof doc.attended_by === "string" && doc.attended_by !== "" ? doc.attended_by : null,
    cursor,
    phases,
  };
}

function tasksOf(value: unknown): readonly RunTaskView[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[]).map((task) => ({
    cost_usd: typeof task?.cost_usd === "number" ? task.cost_usd : null,
    // Absent means metered: every run.yml written before the flag existed, and
    // every headless spawn, whose cost is a reconciled `total_cost_usd`.
    metered: task?.metered !== false,
    tokens: typeof task?.tokens === "number" ? task.tokens : null,
  }));
}

/** `attended_by: host` — a host session drives this run and nothing here spawns. */
export function isAttendedByHostView(view: RunView): boolean {
  return view.attended_by === "host";
}

/** What a run has spent, in BOTH currencies, plus what nobody costed (issue #22). */
export interface RunSpend {
  /** Dollars this process metered. A LOWER BOUND whenever `unmeteredTasks > 0`. */
  readonly meteredUsd: number;
  /** Host-session tokens declared with `--tokens`. Never converted to dollars. */
  readonly hostTokens: number;
  /** In-session turns whose cost nobody declared at all. */
  readonly unmeteredTasks: number;
}

/**
 * The two economies, side by side and never added together.
 *
 * There is no exchange rate between a metered dollar and a host token, and
 * inventing one would be a guess about a price — which is the whole reason the
 * `economy:` label exists (design §E.2, `budget/RunBudget.ts`). So this returns
 * both numbers and lets the reader hold them apart.
 */
export function runSpend(view: RunView): RunSpend {
  let meteredUsd = 0;
  let hostTokens = 0;
  let unmeteredTasks = 0;
  for (const phase of view.phases) {
    for (const stage of phase.stages) {
      for (const task of stage.tasks) {
        if (task.cost_usd !== null) meteredUsd += task.cost_usd;
        if (!task.metered || task.cost_usd === null) unmeteredTasks += 1;
        if (task.tokens !== null) hostTokens += task.tokens;
      }
    }
  }
  return { meteredUsd: Math.round(meteredUsd * 100) / 100, hostTokens, unmeteredTasks };
}

/**
 * One line saying that the dollar figure is not the whole spend — or null when it
 * is, in which case nothing is printed and every existing message is unchanged.
 *
 * This is the whole of issue #22's user-visible half: a budget decision may still
 * only enforce dollars, but the operator reading it is entitled to know that
 * `$0.00` was measured on a run whose turns a host session paid for.
 */
export function renderRunEconomies(view: RunView): string | null {
  const spend = runSpend(view);
  const attended = isAttendedByHostView(view);
  if (spend.hostTokens === 0 && spend.unmeteredTasks === 0 && !attended) return null;
  const parts = [`$${spend.meteredUsd.toFixed(2)} metered`];
  if (spend.hostTokens > 0) parts.push(`${String(spend.hostTokens)} host tokens`);
  if (spend.unmeteredTasks > 0) {
    parts.push(`${String(spend.unmeteredTasks)} unmetered turn${spend.unmeteredTasks === 1 ? "" : "s"}`);
  }
  const who = attended ? " (attended_by: host — the framework does not spawn on this run)" : "";
  return `spend so far: ${parts.join(" + ")}${who}. `
    + "The dollar figure is METERED spend only; host tokens are a different currency and are never converted.";
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The stage the cursor points at. */
export function cursorStage(view: RunView): RunStage | null {
  if (view.cursor === null) return null;
  for (const phase of view.phases) {
    if (phase.id !== view.cursor.phase) continue;
    return phase.stages.find((s) => s.id === view.cursor?.stage) ?? null;
  }
  return null;
}

/**
 * Every run that is not finished, newest first. "Newest" = latest `updated_at`,
 * falling back to the folder name, which is date-prefixed by construction
 * (spec §2.2) — `listRunDirs` yields those in reverse order and `sort` is stable,
 * so a shared second-precision timestamp still orders deterministically.
 *
 * The tolerant twin of `RunStore.findOpen`: same set, no schema validation, used
 * where a hook must render something rather than argue about a schema.
 */
export function openRunViews(root: string): readonly RunView[] {
  const open: RunView[] = [];
  for (const dir of listRunDirs(root)) {
    const view = loadRunView(dir);
    if (view === null || isTerminal(view.status)) continue;
    open.push(view);
  }
  return open.sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0));
}

/**
 * The newest run that is not finished, or null.
 *
 * Still a deliberate single pick: `budget-gate` has one Bash command to judge and
 * no way to ask which run it belongs to, so after `--run` and the cwd it falls
 * back to the newest rather than failing open on ambiguity (a gate that stops
 * gating when a second run exists is worse than one that guesses).
 */
export function newestActiveRun(root: string): RunView | null {
  return openRunViews(root)[0] ?? null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
