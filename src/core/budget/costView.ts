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
 *  - **Attempts are not merged.** A stage that failed twice cost three times,
 *    and the retry is exactly the money an operator is trying to find.
 */
import { basename } from "node:path";
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { listRunDirs } from "../../hooks/lib/workspace.ts";
import { RunStore } from "../run/RunStore.ts";

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
}

export interface CostStage {
  readonly phase: string;
  readonly stage: string;
  readonly attempts: readonly CostAttempt[];
  readonly usd: number;
  readonly tokens: CostTokens;
  /** True when at least one attempt of this stage reported no cost. */
  readonly unmetered: boolean;
}

export interface CostRun {
  readonly run: string;
  readonly title: string;
  readonly usd: number;
  readonly tokens: CostTokens;
  readonly stages: readonly CostStage[];
  /** Attempts with no cost figure. Counted, never summed into `usd`. */
  readonly unmeteredAttempts: number;
}

export interface CostProgram {
  readonly runs: readonly CostRun[];
  readonly usd: number;
  readonly tokens: CostTokens;
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
    usd: round(runs.reduce((sum, run) => sum + run.usd, 0)),
    tokens: sumTokens(runs.map((run) => run.tokens)),
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

  const stages: CostStage[] = [];
  for (const [, list] of byStage) {
    const first = list[0];
    if (first === undefined) continue;
    stages.push({
      phase: first.phase,
      stage: first.stage,
      attempts: list,
      usd: round(list.reduce((sum, a) => sum + (a.usd ?? 0), 0)),
      tokens: sumTokens(list.map((a) => a.tokens)),
      unmetered: list.some((a) => a.usd === null),
    });
  }

  return {
    run: runId,
    title,
    usd: round(stages.reduce((sum, s) => sum + s.usd, 0)),
    tokens: sumTokens(stages.map((s) => s.tokens)),
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
    tokens: {
      input: num(usage?.input_tokens),
      output: num(usage?.output_tokens),
      cacheCreation: num(usage?.cache_creation_input_tokens),
      cacheRead: num(usage?.cache_read_input_tokens),
    },
  };
}

/** Output tokens of every past attempt at a stage with this id, across the workspace. */
export function outputTokensForStage(root: string, stageId: string): readonly number[] {
  const out: number[] = [];
  for (const dir of listRunDirs(root)) {
    for (const event of EventLog.forRun(dir).read()) {
      const attempt = toAttempt(event);
      if (attempt === null || attempt.stage !== stageId) continue;
      if (attempt.tokens.output > 0) out.push(attempt.tokens.output);
    }
  }
  return out.sort((a, b) => a - b);
}

/** The middle value, or the mean of the middle two. Null for an empty sample. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function renderRunCost(cost: CostRun): string {
  const lines = [
    `${cost.run}${cost.title === "" ? "" : ` · ${cost.title}`}`,
    `$${cost.usd.toFixed(2)} over ${plural(cost.stages.length, "stage")}, `
      + `${plural(cost.stages.reduce((n, s) => n + s.attempts.length, 0), "attempt")}`
      + unmeteredSuffix(cost.unmeteredAttempts),
    tokenLine(cost.tokens),
    "",
  ];
  const width = Math.max(...cost.stages.map((s) => `${s.phase}/${s.stage}`.length), 5);
  for (const stage of cost.stages) {
    lines.push(
      `  ${`${stage.phase}/${stage.stage}`.padEnd(width)}  ${pad(`$${stage.usd.toFixed(2)}`)}  `
      + `${plural(stage.attempts.length, "attempt")}${stage.unmetered ? " (some unmetered)" : ""}`,
    );
    if (stage.attempts.length > 1) {
      for (const attempt of stage.attempts) {
        lines.push(
          `  ${" ".repeat(width)}  ${pad(attempt.usd === null ? "—" : `$${attempt.usd.toFixed(2)}`)}  `
          + `${attempt.task}${attempt.model === null ? "" : ` · ${attempt.model}`}`,
        );
      }
    }
  }
  if (cost.stages.length === 0) lines.push("  no agent.result events — nothing has been spent on this run.");
  return lines.join("\n");
}

export function renderProgramCost(program: CostProgram): string {
  const lines = [
    `${plural(program.runs.length, "run")} in this workspace · $${program.usd.toFixed(2)}`
      + unmeteredSuffix(program.unmeteredAttempts),
    tokenLine(program.tokens),
    "",
  ];
  const width = Math.max(...program.runs.map((r) => r.run.length), 3);
  for (const run of program.runs) {
    lines.push(
      `  ${run.run.padEnd(width)}  ${pad(`$${run.usd.toFixed(2)}`)}  `
      + `${plural(run.stages.length, "stage")}${run.unmeteredAttempts > 0 ? " (some unmetered)" : ""}`,
    );
  }
  if (program.runs.length === 0) lines.push("  no runs under tldrx-work/.");
  return lines.join("\n");
}

function unmeteredSuffix(count: number): string {
  return count === 0
    ? ""
    : ` · ${plural(count, "attempt")} UNMETERED (cost unknown, not counted above)`;
}

function tokenLine(t: CostTokens): string {
  return `tokens: ${tokens(t.input)} in · ${tokens(t.output)} out · `
    + `${tokens(t.cacheCreation)} cache write · ${tokens(t.cacheRead)} cache read`;
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

function pad(text: string): string {
  return text.padStart(9);
}

function tokens(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}
