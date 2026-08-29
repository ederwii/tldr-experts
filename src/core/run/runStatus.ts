/**
 * `tldrx run status` — where the run is, in one screen (spec §3, §5).
 *
 * Reads run.yml and budget.yml and nothing else that can lie: the progress bars
 * count stage statuses, the money comes off the budget file, and the "what is
 * blocking" line is derived from the cursor stage plus the open blocks in that
 * phase's questions.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBlocks, parseQuestions } from "../text/questions.ts";
import { remaining } from "../budget/wouldExceed.ts";
import type { RunBudget } from "../budget/RunBudget.ts";
import { isTerminal, stageAt, type RunFile, type RunPhase } from "./RunFile.ts";

export const BAR_CELLS = 5;

export interface PhaseProgress {
  readonly id: string;
  readonly status: string;
  readonly done: number;
  readonly total: number;
  readonly bar: string;
  readonly spent_usd: number;
  readonly ceiling_usd: number;
}

export type WaitingKind = "gate" | "answer" | "ready" | "done" | "blocked";

export interface Waiting {
  readonly kind: WaitingKind;
  readonly message: string;
  /** Open question ids in the cursor phase, when the run is waiting on answers. */
  readonly questions: readonly string[];
}

export interface RunStatusView {
  readonly run: string;
  readonly title: string;
  readonly scope: string;
  readonly workflow: string;
  readonly repos: readonly string[];
  readonly status: string;
  readonly cursor: { readonly phase: string; readonly stage: string; readonly task: string | null };
  readonly phases: readonly PhaseProgress[];
  readonly budget: { readonly spent_usd: number; readonly ceiling_usd: number; readonly remaining_usd: number };
  readonly waiting: Waiting;
}

export function buildStatus(run: RunFile, budget: RunBudget, runDir: string): RunStatusView {
  const phases = run.phases.map((phase) => progressOf(phase, budget));
  return {
    run: run.run,
    title: run.title,
    scope: run.scope,
    workflow: run.workflow,
    repos: run.repos,
    status: run.status,
    cursor: run.cursor,
    phases,
    budget: {
      spent_usd: run.budget.spent_usd,
      ceiling_usd: run.budget.ceiling_usd,
      remaining_usd: remaining(budget),
    },
    waiting: whatIsWaiting(run, runDir),
  };
}

function progressOf(phase: RunPhase, budget: RunBudget): PhaseProgress {
  const total = phase.stages.length;
  const done = phase.stages.filter((s) => isTerminal(s.status)).length;
  const money = budget.phases.find((p) => p.id === phase.id);
  return {
    id: phase.id,
    status: phase.status,
    done,
    total,
    bar: bar(done, total),
    spent_usd: money?.spent_usd ?? 0,
    ceiling_usd: money?.ceiling_usd ?? 0,
  };
}

export function bar(done: number, total: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_CELLS);
  return "▓".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

export function whatIsWaiting(run: RunFile, runDir: string): Waiting {
  const entry = stageAt(run, run.cursor);
  if (entry === null) {
    return { kind: "blocked", message: `cursor ${run.cursor.phase}/${run.cursor.stage} does not resolve to a stage`, questions: [] };
  }
  const open = openQuestionIds(join(runDir, run.cursor.phase, "questions.md"));

  switch (entry.stage.status) {
    case "awaiting_gate":
      return {
        kind: "gate",
        message: `gate on ${entry.phase.id}/${entry.stage.id} — \`tldrx approve\` or \`tldrx reject --note "…"\``,
        questions: open,
      };
    case "awaiting_answer":
      return {
        kind: "answer",
        message: open.length === 0
          ? `stage ${entry.stage.id} is waiting on an answer, but ${run.cursor.phase}/questions.md has no open block`
          : `${open.length} open question(s) in ${run.cursor.phase}/questions.md — \`tldrx answer ${open[0] ?? "Q1"} "…"\``,
        questions: open,
      };
    case "done":
    case "failed":
    case "skipped":
    case "cancelled":
      return { kind: "done", message: "every stage is terminal — nothing is waiting", questions: open };
    case "blocked":
      return { kind: "blocked", message: `stage ${entry.stage.id} is blocked`, questions: open };
    default:
      return {
        kind: "ready",
        message: `next up: ${entry.phase.id}/${entry.stage.id} (${entry.stage.status}) — \`tldrx next\``,
        questions: open,
      };
  }
}

function openQuestionIds(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    return openBlocks(parseQuestions(readFileSync(path, "utf8")).blocks).map((b) => b.id);
  } catch {
    return [];
  }
}

/** The human rendering. `--json` prints `RunStatusView` instead. */
export function renderStatus(view: RunStatusView): string {
  const width = Math.max(...view.phases.map((p) => p.id.length), 7);
  const lines = [
    `${view.run} · ${view.title}`,
    `scope ${view.scope} · workflow ${view.workflow} · repos ${view.repos.length === 0 ? "(none)" : view.repos.join(", ")} · status ${view.status}`,
    `cursor ${view.cursor.phase} / ${view.cursor.stage}`,
    "",
  ];
  for (const phase of view.phases) {
    const marker = phase.id === view.cursor.phase ? ">" : " ";
    lines.push(
      `${marker} ${phase.id.padEnd(width)}  [${phase.bar}] ${String(phase.done)}/${String(phase.total)} stages` +
        `   $${phase.spent_usd.toFixed(2)} / $${phase.ceiling_usd.toFixed(2)}`,
    );
  }
  lines.push(
    "",
    `budget  $${view.budget.spent_usd.toFixed(2)} spent of $${view.budget.ceiling_usd.toFixed(2)} ceiling ` +
      `($${view.budget.remaining_usd.toFixed(2)} left)`,
    `waiting ${view.waiting.message}`,
  );
  return lines.join("\n");
}
