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

export interface RunStage {
  readonly id: string;
  readonly status: string;
  readonly expert: string | null;
  readonly budget_usd: number | null;
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
    cursor,
    phases,
  };
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
