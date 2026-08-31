/**
 * `tldrx cost` — what the work actually cost, per attempt, per stage, per run.
 *
 * The data was already there. Every `agent.result` line of `events.jsonl` carries
 * `cost_usd` (the CLI's own `total_cost_usd`, not an estimate of ours) and, since
 * wave N, the four token counters including both prompt-cache halves. What did
 * not exist was anything that ADDED THEM UP: `budget show` reports ceilings and
 * `run status` reports stages, and neither answers "where did the money go".
 *
 * Three rules the numbers obey:
 *
 *  - **Measured, never modelled.** Nothing here multiplies tokens by a price.
 *    The dollars are the ones the CLI reported. `run estimate` is the file that
 *    is allowed to guess, and it says so in words.
 *  - **Unmetered work is counted SEPARATELY, never as zero.** A stage that ran
 *    without a cost figure — the in-session `--commit` path, where the host
 *    session spent the money and `result.json` carried no `cost_usd` — is a
 *    stage whose cost is UNKNOWN. Adding 0 for it would report a total that is
 *    quietly wrong and looks precise. It gets its own count and its own line.
 *    The same rule applies one level down, to the TOKENS: an unmetered attempt
 *    has no `usage` block, and printing `0 in · 0 out · 0 cache write · 0 cache
 *    read` for it says "we measured nothing" in the notation of "nothing
 *    happened". When the host declared a figure with `--tokens` that number is
 *    real and is shown as what it is — declared, not measured, and never summed
 *    into the four measured counters.
 *  - **Attempts are not merged.** A stage that failed twice cost three times,
 *    and the retry is exactly the money an operator is trying to find.
 *  - **Two economies never add up.** Since 2026-08-30 a phase may be priced in
 *    `host-tokens` rather than `metered-usd` (spec §2.11), and the two have no
 *    exchange rate. So the economy is the ORGANISING AXIS here — a column on
 *    every row and a footer of its own — and there is NO GRAND TOTAL. A footer
 *    that printed `$1.70` under a run which also burned 1.5M host tokens is the
 *    exact sentence the label exists to stop.
 */
import { basename } from "node:path";
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { RunStore } from "../run/RunStore.ts";
import { economyFor, DEFAULT_ECONOMY, type Economy, type RunBudget } from "./RunBudget.ts";
import { loadRunBudget } from "./loadBudget.ts";

export interface CostTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
}

export interface CostAttempt {
  readonly phase: string;
  readonly stage: string;
  readonly task: string;
  readonly model: string | null;
  /** Null when this attempt reported no cost — see "unmetered" above. */
  readonly usd: number | null;
  readonly tokens: CostTokens;
  /**
   * Tokens the HOST declared with `tldrx next --commit --tokens <n>`, for a turn
   * this process never metered. One undifferentiated total, not four counters —
   * that is all the host knows — so it is kept apart from `tokens` rather than
   * folded into it.
   */
  readonly declaredTokens: number | null;
}

export interface CostStage {
  readonly phase: string;
  readonly stage: string;
  /** What this stage's phase is priced in — `budget.yml`, phase-then-run. */
  readonly economy: Economy;
  readonly attempts: readonly CostAttempt[];
  readonly usd: number;
  readonly tokens: CostTokens;
  /** Declared totals of this stage's unmetered attempts, added up. */
  readonly declaredTokens: number;
  /** True when at least one attempt of this stage reported no cost. */
  readonly unmetered: boolean;
}

export interface CostRun {
  readonly run: string;
  readonly title: string;
  /** Every distinct economy this run's stages were priced in, in table order. */
  readonly economies: readonly Economy[];
  readonly usd: number;
  readonly tokens: CostTokens;
  readonly declaredTokens: number;
  readonly stages: readonly CostStage[];
  /** Attempts with no cost figure. Counted, never summed into `usd`. */
  readonly unmeteredAttempts: number;
}

export interface CostProgram {
  readonly runs: readonly CostRun[];
  readonly economies: readonly Economy[];
  readonly usd: number;
  readonly tokens: CostTokens;
  readonly declaredTokens: number;
  readonly unmeteredAttempts: number;
}

const ZERO: CostTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/** Every run under `root`, whether open or finished — a program is all of it. */
export function buildProgramCost(root: string): CostProgram {
  const runs: CostRun[] = [];
  for (const dir of listRunDirs(root)) {
    const cost = buildRunCost(dir);
    if (cost !== null) runs.push(cost);
  }
  return {
    runs,
    economies: distinctEconomies(runs.flatMap((run) => run.economies)),
    usd: round(runs.reduce((sum, run) => sum + run.usd, 0)),
    tokens: sumTokens(runs.map((run) => run.tokens)),
    declaredTokens: runs.reduce((sum, run) => sum + run.declaredTokens, 0),
    unmeteredAttempts: runs.reduce((sum, run) => sum + run.unmeteredAttempts, 0),
  };
}

export function buildRunCost(runDir: string): CostRun | null {
  let title = "";
  let runId = basename(runDir);
  try {
    const store = RunStore.open(runDir);
    title = store.run.title;
    runId = store.run.run;
  } catch {
    // A run.yml that will not parse still has an events log worth adding up.
  }

  const attempts: CostAttempt[] = [];
  for (const event of EventLog.forRun(runDir).read()) {
    const attempt = toAttempt(event);
    if (attempt !== null) attempts.push(attempt);
  }
  if (attempts.length === 0 && title === "") return null;

  const byStage = new Map<string, CostAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.phase}/${attempt.stage}`;
    const list = byStage.get(key);
    if (list === undefined) byStage.set(key, [attempt]);
    else list.push(attempt);
  }

  // Fail-soft on purpose: `cost` reports what was spent and must not become the
  // command that refuses to print a ledger because a ceiling file has a typo in
  // it. An unreadable budget.yml means every row falls back to the default.
  const budget = readBudget(runDir);

  const stages: CostStage[] = [];
  for (const [, list] of byStage) {
    const first = list[0];
    if (first === undefined) continue;
    stages.push({
      phase: first.phase,
      stage: first.stage,
      economy: economyFor(budget, first.phase),
      attempts: list,
      usd: round(list.reduce((sum, a) => sum + (a.usd ?? 0), 0)),
      tokens: sumTokens(list.map((a) => a.tokens)),
      declaredTokens: list.reduce((sum, a) => sum + (a.declaredTokens ?? 0), 0),
      unmetered: list.some((a) => a.usd === null),
    });
  }

  return {
    run: runId,
    title,
    economies: distinctEconomies(stages.map((stage) => stage.economy)),
    usd: round(stages.reduce((sum, s) => sum + s.usd, 0)),
    tokens: sumTokens(stages.map((s) => s.tokens)),
    declaredTokens: stages.reduce((sum, s) => sum + s.declaredTokens, 0),
    stages,
    unmeteredAttempts: attempts.filter((a) => a.usd === null).length,
  };
}

/**
 * One `agent.result` line as an attempt, or null for any other event.
 *
 * `metered: false` is wave M's marker for work whose cost this process did not
 * see; a `cost_usd: null` in the payload means the same thing from the in-session
 * path. Either one makes the attempt UNMETERED — a null, never a zero.
 */
export function toAttempt(event: TldrxEvent): CostAttempt | null {
  if (event.type !== "agent.result") return null;
  const payload = event.payload;
  const metered = payload.metered !== false && payload.cost_usd !== null;
  const usage = asRecord(payload.usage);
  return {
    phase: str(payload.phase) ?? "",
    stage: event.stage ?? "",
    task: str(payload.task) ?? "",
    model: str(payload.model),
    usd: metered ? event.cost_usd : null,
    // `--commit --tokens <n>` writes this onto both the task row and the
    // `agent.result` payload; it is the only token figure an unmetered turn has.
    declaredTokens: num(payload.tokens) > 0 ? num(payload.tokens) : null,
    tokens: {
      input: num(usage?.input_tokens),
      output: num(usage?.output_tokens),
      cacheCreation: num(usage?.cache_creation_input_tokens),
      cacheRead: num(usage?.cache_read_input_tokens),
    },
  };
}

/**
 * The token counters of every past attempt at a stage with this id, across the
 * workspace — or, with `stageId` null, of every past attempt at ANY stage.
 *
 * All FOUR counters, not just output. `run estimate` needs the two cache halves
 * as badly as it needs output: on a real What stage the ledger read 56 input,
 * 29.0k output, 166.3k cache write and 3,747.1k cache read, so an estimate built
 * on output alone was pricing a rounding error and calling it the bill.
 *
 * An attempt that reported no output tokens carries no usage worth a median —
 * that is the in-session/unmetered path, where the host session held the meter —
 * so it is left out of the sample rather than counted as a row of zeroes.
 */
export function attemptTokensForStage(
  root: string, stageId: string | null,
): readonly CostTokens[] {
  const out: CostTokens[] = [];
  for (const dir of listRunDirs(root)) {
    for (const event of EventLog.forRun(dir).read()) {
      const attempt = toAttempt(event);
      if (attempt === null) continue;
      if (stageId !== null && attempt.stage !== stageId) continue;
      if (attempt.tokens.output > 0) out.push(attempt.tokens);
    }
  }
  return out;
}

/** Output tokens of every past attempt at a stage with this id, across the workspace. */
export function outputTokensForStage(root: string, stageId: string): readonly number[] {
  return attemptTokensForStage(root, stageId)
    .map((t) => t.output)
    .sort((a, b) => a - b);
}

/** The middle value, or the mean of the middle two. Null for an empty sample. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * The run ledger, with the ECONOMY as its axis.
 *
 * Two columns that never mix — MEASURED is dollars this process saw the CLI
 * report, DECLARED is host-session tokens somebody typed with `--tokens` — and
 * two footers, one per economy. There is deliberately no grand total: adding a
 * dollar to a token needs an exchange rate nobody here has, and the last time
 * this file implied one it read `$1.70` over a run that had spent 1.5M host
 * tokens.
 */
export function renderRunCost(cost: CostRun): string {
  const lines = [
    `${cost.run}${cost.title === "" ? "" : ` · ${cost.title}`}`,
    "",
  ];
  const width = Math.max(...cost.stages.map((s) => `${s.phase}/${s.stage}`.length), "STAGE".length);
  lines.push(
    `  ${"STAGE".padEnd(width)}  ${"ECONOMY".padEnd(ECONOMY_WIDTH)}  `
    + `${padCell("MEASURED")}  DECLARED`,
  );
  for (const stage of cost.stages) {
    lines.push(
      `  ${`${stage.phase}/${stage.stage}`.padEnd(width)}  ${stage.economy.padEnd(ECONOMY_WIDTH)}  `
      + `${padCell(stage.usd === 0 && stage.unmetered ? DASH : `$${stage.usd.toFixed(2)}`)}  `
      + `${stage.declaredTokens > 0 ? `~${bigTokens(stage.declaredTokens)} tokens (host session)` : DASH}`,
    );
    // Every attempt is expanded, not only the retried ones. Before this, a stage
    // that ran once printed a dollar figure and nothing about where it went — and
    // cache read is where it goes, so hiding the columns hid the answer.
    for (const attempt of stage.attempts) {
      lines.push(
        `  ${" ".repeat(width)}  ${" ".repeat(ECONOMY_WIDTH)}  `
        + `${padCell(attempt.usd === null ? DASH : `$${attempt.usd.toFixed(2)}`)}  `
        + `${attempt.task}${attempt.model === null ? "" : ` · ${attempt.model}`}`
        + `  ${tokenColumns(attempt.tokens, attempt.declaredTokens ?? 0)}`,
      );
    }
  }
  if (cost.stages.length === 0) {
    lines.push("  no agent.result events — nothing has been spent on this run.");
    return lines.join("\n");
  }
  lines.push("", ...footers(cost.stages.flatMap((stage) => stage.attempts)));
  return lines.join("\n");
}

export function renderProgramCost(program: CostProgram): string {
  const lines = [
    `${plural(program.runs.length, "run")} in this workspace`,
    "",
  ];
  const width = Math.max(...program.runs.map((r) => r.run.length), "RUN".length);
  lines.push(
    `  ${"RUN".padEnd(width)}  ${"ECONOMY".padEnd(ECONOMY_WIDTH)}  ${padCell("MEASURED")}  DECLARED`,
  );
  for (const run of program.runs) {
    lines.push(
      `  ${run.run.padEnd(width)}  ${economyCell(run.economies).padEnd(ECONOMY_WIDTH)}  `
      + `${padCell(run.usd === 0 && run.unmeteredAttempts > 0 ? DASH : `$${run.usd.toFixed(2)}`)}  `
      + `${run.declaredTokens > 0 ? `~${bigTokens(run.declaredTokens)} tokens (host session)` : DASH}`,
    );
  }
  if (program.runs.length === 0) {
    lines.push("  no runs under tldrx-work/.");
    return lines.join("\n");
  }
  lines.push("", ...footers(program.runs.flatMap((run) => run.stages).flatMap((stage) => stage.attempts)));
  return lines.join("\n");
}

/**
 * One footer per economy, and a third line for work that reported NEITHER.
 *
 * The three are computed off the attempts, not off the labels: a label says what
 * a ceiling was denominated in, and these say what actually happened. A run
 * labelled `host-tokens` whose stages somehow reported dollars still shows those
 * dollars, on the metered line, where they can be argued with.
 */
function footers(attempts: readonly CostAttempt[]): readonly string[] {
  const metered = attempts.filter((a) => a.usd !== null);
  const declared = attempts.filter((a) => (a.declaredTokens ?? 0) > 0);
  const silent = attempts.filter((a) => a.usd === null && (a.declaredTokens ?? 0) <= 0);
  const lines: string[] = [];
  lines.push(
    `  metered      ${metered.length === 0
      ? "nothing this process metered"
      : `$${round(metered.reduce((sum, a) => sum + (a.usd ?? 0), 0)).toFixed(2)} over ${plural(metered.length, "attempt")}`}`,
  );
  // The four counters the dollars were charged against, rolled up. Cache read is
  // where the money actually goes — an estimate blind to it priced a real What
  // stage at $0.33 against a $1.70 bill — so the total keeps its columns.
  const measured = sumTokens(metered.map((a) => a.tokens));
  if (!isZero(measured)) lines.push(`               ${tokenColumns(measured)}`);
  if (declared.length > 0) {
    lines.push(
      `  host-billed  ~${bigTokens(declared.reduce((sum, a) => sum + (a.declaredTokens ?? 0), 0))} tokens `
      + `declared over ${plural(declared.length, "attempt")} — no dollar figure; this process metered none of it`,
    );
  }
  if (silent.length > 0) {
    lines.push(
      `  unmetered    ${plural(silent.length, "attempt")} UNMETERED — no cost figure and no declared tokens; `
      + "cost unknown, and never counted as zero",
    );
  }
  lines.push("  (no total: two economies, no exchange rate — see spec §2.11)");
  return lines;
}

/** The economy cell for a row that summarises several stages. */
function economyCell(economies: readonly Economy[]): string {
  if (economies.length === 0) return DEFAULT_ECONOMY;
  return economies.length === 1 ? (economies[0] ?? DEFAULT_ECONOMY) : "mixed";
}

/** Distinct, in the fixed order the label enum declares — never sample order. */
function distinctEconomies(all: readonly Economy[]): readonly Economy[] {
  const seen = new Set(all);
  return (["metered-usd", "host-tokens"] as const).filter((economy) => seen.has(economy));
}

/** budget.yml, or null when there is none or it will not load. Never throws. */
function readBudget(runDir: string): RunBudget | null {
  try {
    return loadRunBudget(runDir);
  } catch {
    return null;
  }
}

const ECONOMY_WIDTH = 12;
const DASH = "—";

/**
 * The four counters in one column group — the same order at every level — plus
 * whatever the host DECLARED for turns this process could not meter.
 *
 * An attempt with nothing but a declared figure prints the declared figure
 * alone. Printing `0 in · 0 out · 0 cache write · 0 cache read` beside a run.yml
 * that says `tokens: 342527` is not a rounding error, it is the wrong claim:
 * four zeroes read as "this turn used no tokens" when what happened is that the
 * host session used 342.5k of them and this process never saw the meter.
 */
function tokenColumns(t: CostTokens, declared = 0): string {
  const measured = `${bigTokens(t.input)} in · ${bigTokens(t.output)} out · `
    + `${bigTokens(t.cacheCreation)} cache write · ${bigTokens(t.cacheRead)} cache read`;
  if (declared <= 0) return measured;
  const label = `~${bigTokens(declared)} declared (host session)`;
  return isZero(t) ? label : `${measured} · ${label}`;
}

function isZero(t: CostTokens): boolean {
  return t.input === 0 && t.output === 0 && t.cacheCreation === 0 && t.cacheRead === 0;
}

function sumTokens(all: readonly CostTokens[]): CostTokens {
  return all.reduce((sum, t) => ({
    input: sum.input + t.input,
    output: sum.output + t.output,
    cacheCreation: sum.cacheCreation + t.cacheCreation,
    cacheRead: sum.cacheRead + t.cacheRead,
  }), ZERO);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function padCell(text: string): string {
  return text.padEnd(11);
}

/**
 * `~342.5k`, `~1.5M`. Thousands stop being readable somewhere around a million,
 * and a host session's declared total is routinely past it.
 */
function bigTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}
