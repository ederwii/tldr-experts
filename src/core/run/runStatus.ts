/**
 * `tldrx run status` — where the run is, in one screen (spec §3, §5).
 *
 * Reads run.yml and budget.yml and nothing else that can lie: the progress bars
 * count stage statuses, the money comes off the budget file, and the "what is
 * blocking" line is derived from the cursor stage plus the open blocks in that
 * phase's questions.md.
 */
import { dashDuration, dashDurationAbsence } from "./duration.ts";
import { remaining } from "../budget/wouldExceed.ts";
import { countUnmetered, unmeteredNote } from "../budget/budgetView.ts";
import type { RunBudget } from "../budget/RunBudget.ts";
import { renderAttempts, stageAttempts, type StageAttempts } from "./attempts.ts";
import { buildProgress, renderBuildProgress, renderStoryCosts, BUILD_PHASE, type BuildProgress } from "./buildProgress.ts";
import { gatePolicyFor, type GatePolicy, type GatesPolicy } from "./gatePolicy.ts";
import { describeGateSignature } from "./gateAuthority.ts";
import { failureReason, waitingFor, type Waiting, type WaitingKind } from "./waiting.ts";
import {
  flatten, isTerminal,
  type AttendedBy, type RunFile, type RunGateAuthority, type RunGateExecutor, type RunPhase,
} from "./RunFile.ts";
import { operatorNotes, type OperatorNote } from "./operatorNote.ts";

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
  /**
   * Which entity evaluated this gate, and under whose authority (#122).
   *
   * ADDITIVE and optional, both: a run.yml written before those keys existed
   * carries neither, and `describeGateSignature` falls back to `by` — the exact
   * string this row rendered before. Appended at the end so `--json` consumers
   * reading by key order are unaffected.
   */
  readonly executed_by?: RunGateExecutor;
  readonly authority?: RunGateAuthority;
  /**
   * The STAGE's own clock, unconverted (#120). Appended, never inserted: a
   * `--json` consumer reading `gates[i].by` is untouched, the same promise
   * `SINGLE_RUN_KEYS` makes for the top level.
   *
   * There is no `duration_seconds` beside them, on purpose and for #118's reason:
   * a duration is a subtraction, it exists only when both ends do, and every
   * number this layer could pick for the one-ended case is wrong — `0` is a
   * measurement of zero and `null` is what the two timestamps already say. The
   * subtraction happens where it is drawn.
   */
  readonly started_at: string | null;
  readonly ended_at: string | null;
  /**
   * What the person who signed this gate wrote, or null.
   *
   * Null covers all three absences without distinguishing them, because a reader
   * treats them the same: the gate is still open, or the note is the empty string
   * `run new` writes and `tldrx approve` never replaced. **`""` is not a
   * signature** and does not reach a reader as one — the same mapping `gateNote`
   * makes on the dashboard, so the two surfaces cannot disagree about whether a
   * gate was signed.
   */
  readonly note: string | null;
}

/**
 * Re-exported so every existing `from "./runStatus.ts"` import keeps working.
 * The derivation itself moved to `waiting.ts`, where the dashboard can reach it.
 */
export type { Waiting, WaitingKind };

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
  /**
   * Turns whose cost was never declared (in-session `--commit` with no
   * `--cost-usd`). With any of these, `spent_usd` is a LOWER BOUND. Reported
   * rather than folded in, because $0.00 and "nobody measured it" are different
   * facts and only one of them is a measurement.
   */
  readonly unmetered_tasks: number;
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
  /**
   * `run.yml`'s `attended_by` (§2.2), or null when the framework may spawn.
   *
   * On this screen because it changes what every OTHER line on it means: a run
   * that will not spawn is not a run that is stuck, and `waiting` reads the same
   * either way.
   */
  readonly attended_by: AttendedBy | null;
  /**
   * What a PERSON wrote on this run's log with `tldrx note` (issue #46), newest
   * last. Appended, never inserted: `--json` consumers read this object by key
   * order in at least one test.
   *
   * On this screen because the moment a note matters most is the one where
   * somebody else picks the run up: "the dod blocks were resynced by hand" is
   * exactly the sentence that stops the next reader re-deriving it. `tldrx
   * replay` shows every note in place; this shows the last few.
   */
  readonly operator_notes: readonly OperatorNote[];
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
    // Appended, never inserted: `--json` consumers read this object by key order
    // in at least one test, and every key above keeps its position.
    unmetered_tasks: countUnmetered(run),
    attended_by: run.attended_by ?? null,
    operator_notes: operatorNotes(runDir),
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
    ...(entry.stage.gate.executed_by === undefined ? {} : { executed_by: entry.stage.gate.executed_by }),
    ...(entry.stage.gate.authority === undefined ? {} : { authority: entry.stage.gate.authority }),
    started_at: entry.stage.started_at,
    ended_at: entry.stage.ended_at,
    note: entry.stage.gate.note === "" ? null : entry.stage.gate.note,
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
 * What this run is waiting on. A `RunFile`-typed door onto the shared
 * derivation — `waitingFor` in `waiting.ts` — which the dashboard model calls
 * with its own document so the two screens cannot disagree.
 */
export function whatIsWaiting(run: RunFile, runDir: string): Waiting {
  return waitingFor(run, runDir);
}

/**
 * The human rendering. `--json` prints `RunStatusView` instead.
 *
 * `verbose` (`run status --verbose`) only ever ADDS lines under the gate rows —
 * the timestamps behind a duration, the sentence behind an absent one, and the
 * words on a signed gate. The default screen stays a screen (#120).
 */
export function renderStatus(view: RunStatusView, verbose = false): string {
  const width = Math.max(...view.phases.map((p) => p.id.length), 7);
  const lines = [
    `${view.run} · ${view.title}`,
    `scope ${view.scope} · workflow ${view.workflow} · repos ${view.repos.length === 0 ? "(none)" : view.repos.join(", ")} · status ${view.status}` +
      // Only when set, so an ordinary run's screen is byte-identical to before.
      (view.attended_by === null ? "" : ` · attended: ${view.attended_by}`),
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
      `($${view.budget.remaining_usd.toFixed(2)} left)` +
      (view.unmetered_tasks === 0 ? "" : ` · ${String(view.unmetered_tasks)} unmetered (in-session)`),
  );
  if (view.unmetered_tasks > 0) lines.push(`        ${unmeteredNote(view.unmetered_tasks)}`);
  // The Build phase, story by story. Only when there is one: on a run parked in
  // What, a "W1 [S1 todo]" line would be describing a plan nobody has written.
  if (view.build !== null && view.build.total > 0) {
    lines.push("");
    // Say where the plan came from when nobody wrote it. A synthesised plan reads
    // exactly like an approved one on this screen otherwise, and only one of the
    // two passed a human gate.
    if (view.build.implicit) lines.push(`${"plan".padEnd(width)}  implicit (scope skips Plan)`);
    lines.push(
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
  lines.push("", ...renderGates(view.gates, verbose));
  lines.push(...renderOperatorNotes(view.operator_notes));
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
export function renderGates(rows: readonly GateRow[], verbose = false): readonly string[] {
  if (rows.length === 0) return [];
  const where = rows.map((row) => `${row.phase}/${row.stage}`);
  const width = Math.max(...where.map((w) => w.length));
  // Counted per policy rather than as "human and the rest": a third value read as
  // a human gate would over-report the number of stages that actually stop.
  const auto = rows.filter((row) => row.policy === "auto").length;
  const agent = rows.filter((row) => row.policy === "agent").length;
  const human = rows.length - auto - agent;
  const noted = rows.filter((row) => row.note !== null).length;
  const lines = [
    `gates   ${String(human)} human, ${String(auto)} auto`
      + (agent === 0 ? "" : `, ${String(agent)} agent`),
  ];
  // The marker's legend, under the header and only when a marker is drawn — the
  // same shape `unmeteredNote` has under `budget`. A bare glyph nobody explained
  // is a worse answer than no glyph at all.
  if (noted > 0) {
    lines.push(`        ${String(noted)} signed gate${noted === 1 ? " carries" : "s carry"} a note`
      + ` (${NOTE_MARK})`
      + (verbose ? "" : ` \u2014 \`run status --verbose\` quotes ${noted === 1 ? "it" : "them"}`));
  }
  const described = rows.map(describeGate);
  const tails = rows.map(gateTail);
  const tailWidth = Math.max(...described.map((text) => text.length));
  rows.forEach((row, i) => {
    const head = `  ${(where[i] ?? "").padEnd(width)}  ${row.policy.padEnd(5)}  `;
    const tail = tails[i] ?? "";
    const describe = described[i] ?? "";
    // Padded only when something follows it, so a run with nothing to add is
    // byte-identical to the screen before #120 — trailing spaces included.
    lines.push(tail === "" ? head + describe : `${head}${describe.padEnd(tailWidth)}  ${tail}`);
    if (verbose) lines.push(...gateDetail(row));
  });
  return lines;
}

/** Marks a gate somebody signed with words. Explained in the header, never alone. */
const NOTE_MARK = "\u270e";

/**
 * The compact right-hand end of a stage line: how long it took, and whether its
 * gate was signed with words.
 *
 * The duration is a subtraction done HERE, off `run.yml`'s two timestamps, by the
 * same `dashDuration` the dashboard draws with (`core/run/duration.ts`) — one
 * implementation, so the page and the terminal cannot disagree about one file.
 */
function gateTail(row: GateRow): string {
  const parts = [briefDuration(row.started_at, row.ended_at)];
  if (row.note !== null) parts.push(NOTE_MARK);
  return parts.filter((part) => part !== "").join("  ");
}

/**
 * A duration, or a few words saying which end is missing — never a blank that
 * reads as "it took no time", and never a synthesised `0m`.
 *
 * A stage with NEITHER end gets nothing rather than a phrase. That is not the
 * blank #118 refused: on the page the duration has a CELL, and an empty cell is a
 * claim; here it is a suffix on a line, and a stage nobody has started has no
 * clock to account for — its status column already says `todo`. Printing "not
 * timed" on all eight rows of a fresh run is noise, not honesty. `--verbose`
 * spells out all four cases, including this one, with `dashDurationAbsence`.
 */
function briefDuration(startedAt: string | null, endedAt: string | null): string {
  const measured = dashDuration(startedAt, endedAt);
  if (measured !== "") return measured;
  const noStart = startedAt === null || startedAt === "";
  const noEnd = endedAt === null || endedAt === "";
  if (noStart && noEnd) return "";
  if (noEnd) return "not ended";
  if (noStart) return "no start";
  return "bad timestamps";
}

/**
 * What `--verbose` adds under one stage line: the two instants behind a duration
 * or the sentence behind an absent one, and the words on a signed gate.
 *
 * Timestamps are printed as `run.yml` holds them. This screen prints an operator
 * note's `ts` raw for the same reason — a run is read across machines, and a
 * localised instant is a different fact on each of them.
 */
function gateDetail(row: GateRow): readonly string[] {
  const lines: string[] = [];
  const measured = dashDuration(row.started_at, row.ended_at);
  lines.push(measured === ""
    ? `      ${dashDurationAbsence(row.started_at, row.ended_at)}`
    : `      ${String(row.started_at)} \u2192 ${String(row.ended_at)}`);
  if (row.note !== null) lines.push(`      note: ${row.note}`);
  return lines;
}

function describeGate(row: GateRow): string {
  // `describeGateSignature` is the ONE renderer (#122): a bare name for a person
  // signing as themselves and for every record written before the fields existed,
  // and `agent alan (delegated by alan, policy: agent)` when the name in `by`
  // belongs to somebody who was not the one checking.
  if (row.status === "approved") return `approved by ${describeGateSignature(row)}`;
  if (row.status === "rejected") return `rejected by ${describeGateSignature(row)}`;
  if (row.status === "n-a") return `${row.type}: n-a`;
  return `${row.type}: ${row.status}`;
}

/**
 * The last few operator notes, or nothing at all.
 *
 * Capped rather than complete: this screen is read to answer "where is the run",
 * and a run somebody has annotated forty times must not push the `waiting` line
 * off the terminal. `tldrx replay <run>` is the complete record and is named here
 * when there are more, so the cap can never read as "that is all of them".
 */
export const NOTES_SHOWN = 3;

export function renderOperatorNotes(notes: readonly OperatorNote[]): readonly string[] {
  if (notes.length === 0) return [];
  const shown = notes.slice(-NOTES_SHOWN);
  const hidden = notes.length - shown.length;
  const lines = [
    "",
    `notes   ${String(notes.length)} operator note(s)`
      + (hidden === 0 ? "" : `, last ${String(shown.length)} shown \u2014 \`tldrx replay\` has them all`),
  ];
  for (const note of shown) {
    lines.push(`  ${note.ts} ${note.actor}${note.stage === null ? "" : ` \u00b7 ${note.stage}`}: ${note.note}`);
  }
  return lines;
}
