/**
 * `tldrx budget show` — the money, per phase, and whether `next` can afford to run.
 *
 * This exists because of a measured failure in the first pilot: a stage failed,
 * the operator retried it, and the retry was refused twice because the phase
 * ceiling had been sized for exactly one attempt. The information needed to see
 * that coming — remaining vs. the next stage's own estimate — was in two files and
 * in neither report. So this view puts them next to each other, and when the sum
 * does not work it prints the exact command that fixes it rather than three
 * things the operator could try.
 */
import { isTerminal, type RunFile, type RunStage, isAttendedByHost } from "../run/RunFile.ts";
import { economyFor, type RunBudget } from "./RunBudget.ts";
import { remainingWork, renderRemainingWork } from "./remainingWork.ts";
import { totalSpent, wouldExceed } from "./wouldExceed.ts";

export interface BudgetPhaseView {
  readonly id: string;
  readonly ceiling_usd: number;
  readonly spent_usd: number;
  readonly remaining_usd: number;
  /** The next stage this phase would run, or null when every stage is terminal. */
  readonly next_stage: string | null;
  /**
   * What `next` is about to try to spend.
   *
   * `static` — the stage's declared `budget_usd`, which is what this column has
   * always been. `plan` — a Build stage with a plan on disk, where the number is
   * the sum of the caps the executor would hand out for the stories that are
   * LEFT (design §E.2). The brake compares against the same figure, computed by
   * the same function, so the two can never disagree.
   */
  readonly next_estimate_usd: number;
  readonly next_estimate_basis: "plan" | "static";
  /** The declared `budget_usd`, kept alongside so the narrowing is visible. */
  readonly next_estimate_static_usd: number;
  /** `S4 dev $1.50 + reviewer $1.00 = $2.50`, or null on the static basis. */
  readonly next_estimate_detail: string | null;
  /** True when `next` would be refused here and `on_exceed: block`. */
  readonly blocked: boolean;
  /** What the ceiling is short by, rounded up to the cent. `0` when it is not. */
  readonly short_by_usd: number;
  readonly is_cursor: boolean;
}

export interface BudgetView {
  readonly run: string;
  readonly title: string;
  readonly ceiling_usd: number;
  readonly spent_usd: number;
  readonly remaining_usd: number;
  readonly per_agent_max_usd: number;
  readonly on_exceed: string;
  readonly phases: readonly BudgetPhaseView[];
  /** The cursor phase, when `next` would be blocked there. */
  readonly blocked: BudgetPhaseView | null;
  /** The exact command that unblocks it, or null when nothing is blocked. */
  readonly fix_command: string | null;
  /**
   * Turns whose cost nobody declared (`cost_usd: null`, in-session).
   *
   * `spent_usd` is a sum of what WAS measured, so with any of these it is a lower
   * bound and not a total. Reporting it as a total is how a ledger came to read
   * "$0.00 spent" after real money had gone (2026-08-29 audit, §A).
   */
  readonly unmetered_tasks: number;
}

/**
 * `runDir` is optional and its absence is not a degraded mode — it is the pre-4C
 * behaviour, exactly: with no run directory to read stories from, every estimate
 * is the stage's declared `budget_usd` and every field below is what it was.
 */
export function buildBudgetView(run: RunFile, budget: RunBudget, runDir?: string): BudgetView {
  const phases = budget.phases.map((phase) => {
    const runPhase = run.phases.find((p) => p.id === phase.id);
    const next = runPhase === undefined ? null : nextStageOf(runPhase.stages);
    const staticEstimate = next?.budget_usd ?? 0;
    const work = runDir === undefined || next === null
      ? null
      : remainingWork({
        runDir,
        phaseId: phase.id,
        stageBudgetUsd: staticEstimate,
        stageSpentUsd: next.cost_usd,
        perAgentMaxUsd: budget.per_agent_max_usd,
        maxUsd: null,
        economy: economyFor(budget, phase.id),
        attended: isAttendedByHost(run),
      });
    const estimate = work === null ? staticEstimate : work.usd;
    const decision = wouldExceed(budget, phase.id, estimate);
    return {
      id: phase.id,
      ceiling_usd: phase.ceiling_usd,
      spent_usd: phase.spent_usd,
      remaining_usd: round(phase.ceiling_usd - phase.spent_usd),
      next_stage: next?.id ?? null,
      next_estimate_usd: estimate,
      next_estimate_basis: work?.basis ?? "static",
      next_estimate_static_usd: staticEstimate,
      next_estimate_detail: work === null || work.basis === "static" ? null : renderRemainingWork(work),
      blocked: next !== null && decision.blocked,
      short_by_usd: next === null || !decision.exceeds ? 0 : shortBy(estimate, decision.remaining),
      is_cursor: phase.id === run.cursor.phase,
    } satisfies BudgetPhaseView;
  });

  const blocked = phases.find((p) => p.blocked && p.is_cursor) ?? phases.find((p) => p.blocked) ?? null;
  return {
    run: run.run,
    title: run.title,
    ceiling_usd: budget.ceiling_usd,
    spent_usd: totalSpent(budget),
    remaining_usd: round(budget.ceiling_usd - totalSpent(budget)),
    per_agent_max_usd: budget.per_agent_max_usd,
    on_exceed: budget.on_exceed,
    phases,
    blocked,
    fix_command: blocked === null ? null : raiseCommand(run.run, blocked.id, blocked.short_by_usd),
    unmetered_tasks: countUnmetered(run),
  };
}

/** In-session turns nobody costed. See `BudgetView.unmetered_tasks`. */
export function countUnmetered(run: RunFile): number {
  return run.phases
    .flatMap((phase) => phase.stages)
    .flatMap((stage) => stage.tasks)
    .filter((task) => task.cost_usd === null).length;
}

/** The one sentence every report uses for an unmetered total. */
export function unmeteredNote(count: number): string {
  return `${count} turn(s) are unmetered (in-session): their cost was never declared, so `
    + "`spent` is a LOWER BOUND, not a total. `tldrx next --commit --cost-usd <n>` records one.";
}

/** The command that makes the refused stage affordable. Printed, never run. */
export function raiseCommand(runId: string, phaseId: string, amountUsd: number): string {
  return `tldrx budget raise ${phaseId} ${amountUsd.toFixed(2)} --run ${runId}`;
}

/**
 * What the ceiling is short by, rounded UP to the cent.
 *
 * Rounding up matters: `remaining` is a float difference, and a raise that lands
 * a hundredth of a cent under the estimate refuses the stage a second time — the
 * exact shape of the pilot failure this command exists to end.
 */
export function shortBy(estimate: number, remaining: number): number {
  return Math.max(0.01, Math.ceil((estimate - remaining) * 100) / 100);
}

/** The first stage in the phase that has not finished — what `next` would run. */
function nextStageOf(stages: readonly RunStage[]): RunStage | null {
  return stages.find((stage) => !isTerminal(stage.status)) ?? null;
}

export function renderBudget(view: BudgetView): string {
  const width = Math.max(...view.phases.map((p) => p.id.length), 7);
  const stageWidth = Math.max(...view.phases.map((p) => (p.next_stage ?? "—").length), 10);
  const lines = [
    `${view.run} · ${view.title}`,
    `ceiling ${usd(view.ceiling_usd)} · spent ${usd(view.spent_usd)}` +
      (view.unmetered_tasks === 0 ? "" : ` (+${String(view.unmetered_tasks)} unmetered)`) +
      ` · left ${usd(view.remaining_usd)} · ` +
      `per-agent max ${usd(view.per_agent_max_usd)} · on_exceed ${view.on_exceed}`,
    ...(view.unmetered_tasks === 0 ? [] : [unmeteredNote(view.unmetered_tasks)]),
    "",
    `  ${"phase".padEnd(width)}  ${pad("ceiling")}  ${pad("spent")}  ${pad("left")}  ` +
      `${"next stage".padEnd(stageWidth)}  ${pad("est.")}  next`,
  ];
  for (const phase of view.phases) {
    lines.push(
      `${phase.is_cursor ? ">" : " "} ${phase.id.padEnd(width)}  ${pad(usd(phase.ceiling_usd))}  ` +
        `${pad(usd(phase.spent_usd))}  ${pad(usd(phase.remaining_usd))}  ` +
        `${(phase.next_stage ?? "—").padEnd(stageWidth)}  ` +
        `${pad(phase.next_stage === null ? "—" : usd(phase.next_estimate_usd))}  ` +
        `${phase.next_stage === null ? "—" : phase.blocked ? "BLOCKED" : "ok"}`,
    );
  }
  // Where the est. column is no longer the stage's own price, show the sum: a
  // number an operator cannot take apart is a number they cannot argue with, and
  // the $18-that-was-really-$2.50 refusal is exactly that failure.
  for (const phase of view.phases) {
    if (phase.next_estimate_detail !== null) {
      lines.push(`  ${phase.id}: ${phase.next_estimate_detail} `
        + `(stage estimate ${usd(phase.next_estimate_static_usd)})`);
    }
  }
  const blocked = view.blocked;
  if (blocked === null) {
    lines.push("", "`tldrx next` is affordable in every phase that still has a stage to run.");
  } else {
    lines.push(
      "",
      `\`tldrx next\` is BLOCKED: phase ${blocked.id} has ${usd(blocked.remaining_usd)} left and stage ` +
        `\`${blocked.next_stage ?? "?"}\` estimates ${usd(blocked.next_estimate_usd)} ` +
        `(short by ${usd(blocked.short_by_usd)}).`,
      `Fix it with:  ${view.fix_command ?? ""}`,
      `Or move the money instead of adding it:  ${view.fix_command ?? ""} --take-from <phase>`,
    );
  }
  return lines.join("\n");
}

function pad(text: string): string {
  return text.padStart(9);
}

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
