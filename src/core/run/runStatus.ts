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
import { renderAttempts, stageAttempts, type StageAttempts } from "./attempts.ts";
import { buildProgress, renderBuildProgress, renderStoryCosts, BUILD_PHASE, type BuildProgress } from "./buildProgress.ts";
import { gatePolicyFor, type GatePolicy, type GatesPolicy } from "./gatePolicy.ts";
import { flatten, isTerminal, stageAt, type RunFile, type RunPhase, type RunStage } from "./RunFile.ts";

export const BAR_CELLS = 5;

export interface PhaseProgress {
  readonly id: string;
  readonly status: string;
  /** Stages that finished and did NOT fail. A failure is not progress. */
  readonly done: number;
  readonly failed: number;
  readonly total: number;
  readonly bar: string;
  /** The reason the first failed stage in this phase gave, or null. */
  readonly failure: string | null;
  readonly spent_usd: number;
  readonly ceiling_usd: number;
}

/** One stage's gate: who is meant to sign it, and who did (spec §2.2). */
export interface GateRow {
  readonly phase: string;
  readonly stage: string;
  /** `human` waits for `tldrx approve`; `auto` lets the facilitator close it. */
  readonly policy: GatePolicy;
  readonly type: string;
  readonly status: string;
  /** `auto` on a gate the facilitator closed, the operator's name on a human one. */
  readonly by: string | null;
  readonly at: string | null;
}

export type WaitingKind = "gate" | "answer" | "ready" | "done" | "blocked" | "failed";

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
  /** Per-attempt cost for the cursor stage, from `agent.result` events. */
  readonly attempts: StageAttempts;
  /**
   * The Build phase story by story — null for a run with no `03-plan/waves.yml`.
   * A one-stage phase holding a dozen sub-agents needs its own view; the phase bar
   * cannot move until every story is finished.
   */
  readonly build: BuildProgress | null;
  readonly waiting: Waiting;
  /**
   * The run's frozen gate policy (spec §2.2 `gates_policy`). ADDITIVE: a run.yml
   * written before the key existed reports every stage as `human`, which is what
   * it behaves as.
   */
  readonly gates_policy: GatesPolicy;
  /** One row per stage, in execution order, carrying `by` on a closed gate. */
  readonly gates: readonly GateRow[];
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
    attempts: stageAttempts(runDir, run.cursor.phase, run.cursor.stage),
    build: buildProgress(runDir),
    waiting: whatIsWaiting(run, runDir),
    gates_policy: resolvedPolicy(run),
    gates: gateRows(run),
  };
}

/** Every stage, never a gap: an absent `gates_policy` reads as `human` throughout. */
function resolvedPolicy(run: RunFile): GatesPolicy {
  const out: Record<string, GatePolicy> = {};
  for (const entry of flatten(run)) {
    out[entry.stage.id] = gatePolicyFor(run.gates_policy, entry.stage.id);
  }
  return out;
}

function gateRows(run: RunFile): readonly GateRow[] {
  return flatten(run).map((entry) => ({
    phase: entry.phase.id,
    stage: entry.stage.id,
    policy: gatePolicyFor(run.gates_policy, entry.stage.id),
    type: entry.stage.gate.type,
    status: entry.stage.gate.status,
    by: entry.stage.gate.by,
    at: entry.stage.gate.at,
  }));
}

function progressOf(phase: RunPhase, budget: RunBudget): PhaseProgress {
  const total = phase.stages.length;
  const failedStages = phase.stages.filter((s) => s.status === "failed");
  const done = phase.stages.filter((s) => isTerminal(s.status) && s.status !== "failed").length;
  const money = budget.phases.find((p) => p.id === phase.id);
  return {
    id: phase.id,
    status: phase.status,
    done,
    failed: failedStages.length,
    total,
    bar: bar(done, total, failedStages.length),
    failure: failedStages[0] === undefined ? null : failureReason(failedStages[0]),
    spent_usd: money?.spent_usd ?? 0,
    ceiling_usd: money?.ceiling_usd ?? 0,
  };
}

/**
 * The bar counts finished-and-not-failed stages. A failure takes the first cell
 * as `✗` and keeps it: a phase that shows a full bar after a stage failed is the
 * exact lie this replaced.
 */
export function bar(done: number, total: number, failed = 0): string {
  if (failed > 0) {
    const cells = BAR_CELLS - 1;
    const filled = total === 0 ? 0 : Math.min(cells, Math.round((done / total) * cells));
    return `✗${"▓".repeat(filled)}${"░".repeat(cells - filled)}`;
  }
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_CELLS);
  return "▓".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

/**
 * Why a stage failed. `RunStage` has no `error` field (spec §2.2) — the reason is
 * recorded on the task that failed, so that is where this reads it from.
 */
function failureReason(stage: RunStage): string | null {
  const error = [...stage.tasks].reverse().find((task) => task.error !== null)?.error ?? null;
  return error === null || error.trim() === "" ? null : oneLine(error);
}

function oneLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
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
    case "failed": {
      const reason = failureReason(entry.stage);
      return {
        kind: "failed",
        message: `${entry.phase.id}/${entry.stage.id} FAILED${reason === null ? "" : `: ${reason}`} — ` +
          "retry: `tldrx next` · or: `tldrx reject --note \"…\"`",
        questions: open,
      };
    }
    case "done":
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
    const failure = phase.failed === 0
      ? ""
      : ` · failed: ${phase.failure ?? `${String(phase.failed)} stage(s)`}`;
    lines.push(
      `${marker} ${phase.id.padEnd(width)}  [${phase.bar}] ${String(phase.done)}/${String(phase.total)} stages` +
        `   $${phase.spent_usd.toFixed(2)} / $${phase.ceiling_usd.toFixed(2)}${failure}`,
    );
  }
  lines.push(
    "",
    `budget  $${view.budget.spent_usd.toFixed(2)} spent of $${view.budget.ceiling_usd.toFixed(2)} ceiling ` +
      `($${view.budget.remaining_usd.toFixed(2)} left)`,
  );
  // The Build phase, story by story. Only when there is one: on a run parked in
  // What, a "W1 [S1 todo]" line would be describing a plan nobody has written.
  if (view.build !== null && view.build.total > 0) {
    lines.push(
      "",
      `${BUILD_PHASE.padEnd(width)}  ${renderBuildProgress(view.build)}` +
        `   ${String(view.build.done)}/${String(view.build.total)} stories done`,
    );
    const costs = renderStoryCosts(view.build);
    if (costs !== null) lines.push(`${"".padEnd(width)}  ${costs}`);
    lines.push("");
  }
  // What the CURSOR stage cost, attempt by attempt. A retry is the moment this
  // matters, and `cost_usd` alone cannot tell one $2.60 try from two $1.30 ones.
  const attempts = renderAttempts(view.attempts);
  if (attempts !== null) lines.push(`${view.cursor.stage.padEnd(7)} ${attempts}`);
  lines.push("", ...renderGates(view.gates));
  lines.push(`waiting ${view.waiting.message}`);
  return lines.join("\n");
}

/**
 * Who signs each gate, and who signed the ones already closed.
 *
 * Printed for every run, including an all-`human` one: "which of these will stop
 * for me" is the question `run auto` makes people ask, and an answer that only
 * appears once you have opted in is an answer nobody finds.
 */
export function renderGates(rows: readonly GateRow[]): readonly string[] {
  if (rows.length === 0) return [];
  const where = rows.map((row) => `${row.phase}/${row.stage}`);
  const width = Math.max(...where.map((w) => w.length));
  const auto = rows.filter((row) => row.policy === "auto").length;
  const lines = [
    `gates   ${String(rows.length - auto)} human, ${String(auto)} auto`,
  ];
  rows.forEach((row, i) => {
    lines.push(`  ${(where[i] ?? "").padEnd(width)}  ${row.policy.padEnd(5)}  ${describeGate(row)}`);
  });
  return lines;
}

function describeGate(row: GateRow): string {
  if (row.status === "approved") return `approved by ${row.by ?? "?"}`;
  if (row.status === "rejected") return `rejected by ${row.by ?? "?"}`;
  if (row.status === "n-a") return `${row.type}: n-a`;
  return `${row.type}: ${row.status}`;
}
