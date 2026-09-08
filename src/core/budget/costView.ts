/**
 * `tldrx cost` — what the work actually cost, per attempt, per stage, per run,
 * and — with `--stories` — per story against the ceiling its spawns were given.
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
 *    The measured dollars are the ones the CLI reported. The one figure here the
 *    CLI never reported is the `--stories` SPAWN CEILING — a cap `caps.ts`
 *    computed and `agent.spawned` recorded — and it keeps its own column, its own
 *    name and its own adjective so it can never be read as a charge.
 *    `run estimate` is the file that is allowed to guess, and it says so in words.
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
import { overShareSentence, ratioOf, round1, sumOrNull } from "../build/planVsMeasured.ts";

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

/** One turn's two facts, as much of an executor task as the story ledger reads. */
export interface StoryTurn {
  readonly key: string;
  readonly costUsd: number;
  /** False ⇒ this process never metered it. It contributes nothing, never `0`. */
  readonly metered?: boolean;
}

/** One story's two sides off the log, before anything divides them. */
export interface StoryLedgerRow {
  readonly story: string;
  readonly ceilingUsd: number | null;
  readonly measuredUsd: number | null;
  /** Turns for this story this process never metered — why a measurement is a floor. */
  readonly unmeteredTurns: number;
}

export interface StoryLedger {
  readonly rows: readonly StoryLedgerRow[];
  /**
   * Keyed `agent.result` rows no Build spawn accounts for.
   *
   * `ExecutorTask.key` is "the feature or story the task was for"
   * (`executors/index.ts:34-36`) and `watch.ts:157`/`:279` fill it with a FEATURE
   * id, while Watch emits no `agent.spawned` at all. Counting those as stories
   * printed features in a table headed "per story" AND — because `sumOrNull`
   * refuses the moment one side is null — deleted the headline sentence on every
   * run that reached 05-watch. They are dropped, counted, and the count is said.
   */
  readonly excluded: number;
  /** Events read. `0` with an unreadable `run.yml` is a run this cannot report on. */
  readonly events: number;
}

/**
 * One story's money, both sides of it, each `null` rather than `0` when absent.
 *
 * `ceilingUsd` is the sum of the `max_budget_usd` figures this run's
 * `agent.spawned` events carried for the story — the SPAWN ceiling the executor
 * computed and handed each spawn, never the phase budget the handoff header
 * quotes. It is not "the plan's share" either: `STORY_KEYS`
 * (`src/core/schemas/story.ts`) has no budget key, so no plan document holds a
 * per-story dollar figure at all, and naming one would be inventing it.
 */
export interface StoryCostRow {
  readonly story: string;
  readonly ceilingUsd: number | null;
  readonly measuredUsd: number | null;
  /** `ratioOf(ceilingUsd, measuredUsd)` to one decimal — the precision the text prints. */
  readonly ratio: number | null;
}

export interface StoryCost {
  readonly run: string;
  readonly title: string;
  readonly rows: readonly StoryCostRow[];
  /** The one over-ceiling sentence, or null — `overShareSentence`, not a second copy. */
  readonly note: string | null;
  /** Stories at least one of whose turns this process never metered. */
  readonly unmeteredStories: readonly string[];
  /** How many turns those were. A measurement with any of them is a FLOOR. */
  readonly unmeteredTurns: number;
  /** Keyed results dropped because no Build spawn accounts for them (Watch features). */
  readonly excludedKeyedResults: number;
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
 * The story ledger: per story, the spawn ceilings it was given and what it cost.
 *
 * ONE walk of the log, two feeders — `tldrx cost --stories` takes the whole run,
 * the Build handoff takes one phase/stage plus this invocation's turns (which are
 * not in the log yet: `recordExecutorTasks` runs after the executor returns).
 * Both sides are already in the stream (measured in the committed golden,
 * `test/fixtures/build/golden/rounds-events.txt`):
 *
 *   #03 agent.spawned … payload={"max_budget_usd":1.6,…,"role":"developer","story":"S1"}
 *   #19 agent.result  … cost_usd=0.1 keys=[effort,key,model,outputs,phase,session_id,task]
 *
 * Note WHERE the dollars are: `cost_usd` is the event ENVELOPE's field and
 * appears in no `agent.result` payload key list. Summing `payload.cost_usd`
 * would return `0` for exactly the metered rows this report exists for, so the
 * money is taken through `toAttempt` — the same reader `buildRunCost` uses, with
 * the same `metered !== false` gate.
 *
 * That gate is why an UNMETERED turn contributes NOTHING rather than `0`, and
 * why the count of them travels with the row: a story with one is a FLOOR, and
 * every sentence downstream has to say so.
 *
 * **A row is a BUILD STORY, not any keyed turn.** A key qualifies when an
 * `agent.spawned` named it as a `story`, or when such a spawn happened in the
 * same phase — so a Build story whose spawn event is missing still gets a named
 * absence, while a Watch feature (a `key`, a cost, no `agent.spawned` anywhere,
 * a different phase) is dropped and counted. Deriving the phase from the spawns
 * rather than hard-coding `04-build` keeps this true for a renamed workflow.
 */
export function storyLedger(
  runDir: string,
  scope: { readonly phaseId: string; readonly stageId: string } | null = null,
  extraTurns: readonly StoryTurn[] = [],
): StoryLedger {
  const events = EventLog.forRun(runDir).read();
  const inScope = (event: TldrxEvent): boolean =>
    scope === null || (event.stage === scope.stageId && str(event.payload.phase) === scope.phaseId);

  const order: string[] = [];
  const first = (story: string): void => { if (!order.includes(story)) order.push(story); };
  const ceilings = new Map<string, number>();
  const measured = new Map<string, number>();
  const unmetered = new Map<string, number>();
  const storyKeys = new Set<string>();
  const storyPhases = new Set<string>();
  let excluded = 0;

  for (const event of events) {
    if (event.type !== "agent.spawned" || !inScope(event)) continue;
    const story = str(event.payload.story);
    if (story === null) continue;
    storyKeys.add(story);
    const phase = str(event.payload.phase);
    if (phase !== null) storyPhases.add(phase);
    first(story);
    const cap = event.payload.max_budget_usd;
    if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
    ceilings.set(story, round((ceilings.get(story) ?? 0) + cap));
  }

  /** Is this key one of THIS phase's stories, or a feature wearing the same field? */
  const isStory = (key: string, phase: string | null): boolean =>
    storyKeys.has(key) || (phase !== null && storyPhases.has(phase));

  for (const event of events) {
    const attempt = toAttempt(event);
    if (attempt === null || !inScope(event)) continue;
    // The story key an `agent.result` carries is `key` (`runNext.ts`'s
    // `recordExecutorTasks`); `task` is the run.yml row id and joins nothing.
    const key = str(event.payload.key);
    if (key === null) continue;
    if (!isStory(key, str(event.payload.phase))) { excluded += 1; continue; }
    first(key);
    if (attempt.usd === null) unmetered.set(key, (unmetered.get(key) ?? 0) + 1);
    else measured.set(key, round((measured.get(key) ?? 0) + attempt.usd));
  }

  // This invocation's turns, which `recordExecutorTasks` has not written yet.
  for (const turn of extraTurns) {
    if (!isStory(turn.key, scope === null ? null : scope.phaseId)) { excluded += 1; continue; }
    first(turn.key);
    if (turn.metered === false) unmetered.set(turn.key, (unmetered.get(turn.key) ?? 0) + 1);
    else measured.set(turn.key, round((measured.get(turn.key) ?? 0) + turn.costUsd));
  }

  return {
    rows: order.map((story) => ({
      story,
      ceilingUsd: ceilings.has(story) ? round(ceilings.get(story) ?? 0) : null,
      measuredUsd: measured.has(story) ? round(measured.get(story) ?? 0) : null,
      unmeteredTurns: unmetered.get(story) ?? 0,
    })),
    excluded,
    events: events.length,
  };
}

/**
 * `tldrx cost --stories`: the whole run's story ledger, with the ratios and the
 * one over-ceiling sentence attached.
 */
export function buildStoryCost(runDir: string): StoryCost | null {
  let title = "";
  let runId = basename(runDir);
  let readable = false;
  try {
    const store = RunStore.open(runDir);
    title = store.run.title;
    runId = store.run.run;
    readable = true;
  } catch {
    // A run.yml that will not parse still has an events log worth adding up.
  }

  const ledger = storyLedger(runDir);
  if (!readable && ledger.events === 0) return null;

  const rows: StoryCostRow[] = ledger.rows.map((row) => {
    const ratio = ratioOf(row.ceilingUsd, row.measuredUsd);
    return {
      story: row.story,
      ceilingUsd: row.ceilingUsd,
      measuredUsd: row.measuredUsd,
      // ONE division, in the leaf, rounded to the precision the text prints — a
      // `--json` reader used to get 5.820512820512821 beside a table saying 5.8.
      ratio: ratio === null ? null : round1(ratio),
    };
  });
  return {
    run: runId,
    title,
    rows,
    // ONE arithmetic — the same leaf the Build handoff's cost line goes through.
    note: overShareSentence(
      sumOrNull(rows.map((row) => row.ceilingUsd)),
      sumOrNull(rows.map((row) => row.measuredUsd)),
      rows.length,
    ),
    unmeteredStories: ledger.rows.filter((row) => row.unmeteredTurns > 0).map((row) => row.story),
    unmeteredTurns: ledger.rows.reduce((sum, row) => sum + row.unmeteredTurns, 0),
    excludedKeyedResults: ledger.excluded,
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

/**
 * The one line an operator keeps — so it may never overclaim.
 *
 * FOUR sentences, not one with a fallback. A total that came out under the
 * ceilings, a total that could not be FORMED, and a total taken over a
 * measurement with an unmetered turn in it are three different facts, and the
 * reassuring one is only true in the first case. An unmetered turn's dollars
 * could put a story well over a ceiling nothing here can see, so a measurement
 * with one is a FLOOR and both the figure and the ratio are said to be floors.
 * This is the same rule the file's own docstring opens with: the footer that
 * printed `$1.70` under a run which also burned 1.5M host tokens is the exact
 * sentence the label exists to stop.
 */
function storyVerdict(cost: StoryCost): string {
  const floor = cost.unmeteredTurns > 0;
  const turns = plural(cost.unmeteredTurns, "turn");
  if (cost.note !== null) {
    return floor
      ? `at least: ${cost.note}; ${turns} unmetered, so the measurement and the ratio are both floors.`
      : `${cost.note}.`;
  }
  const ceilings = sumOrNull(cost.rows.map((row) => row.ceilingUsd));
  const measured = sumOrNull(cost.rows.map((row) => row.measuredUsd));
  if (ceilings === null || measured === null) {
    return "no total: a story above is missing one side, and an absent figure is not summed as zero.";
  }
  if (floor) {
    return `no verdict: ${turns} unmetered, so at least one story's measurement is a LOWER BOUND `
      + "— an unmetered turn could put it over a spawn ceiling this cannot see.";
  }
  return "every story measured inside the spawn ceilings it was given.";
}

/**
 * The per-story ledger: what it cost, the spawn ceilings it was given, the ratio.
 *
 * The header names the figure for what it IS. A spawn ceiling is what the
 * executor computed and handed each spawn (`caps.ts`, surfaced as
 * `agent.spawned.max_budget_usd`); it is NOT the phase budget, and it is NOT a
 * share of a plan, because no plan document carries a per-story dollar figure to
 * take a share of. Getting that name wrong is the failure #170 is about, so it
 * is in the header rather than in a footnote.
 *
 * Absences are named with their reason and never printed as `$0.00` — the same
 * rule the run ledger above follows for an unmetered attempt, one level down.
 */
export function renderStoryCost(cost: StoryCost): string {
  const lines = [
    `${cost.run}${cost.title === "" ? "" : ` · ${cost.title}`} — per story, against the `
    + "spawn ceilings it was given",
    "",
  ];
  if (cost.rows.length === 0) {
    lines.push(
      "  no story spawns and no story-keyed `agent.result` in this run's events.jsonl — "
      + "nothing to measure against a spawn ceiling.",
    );
    if (cost.excludedKeyedResults > 0) lines.push("", `  ${excludedLine(cost)}`);
    return lines.join("\n");
  }
  const width = Math.max(...cost.rows.map((row) => row.story.length), "STORY".length);
  lines.push(`  ${"STORY".padEnd(width)}  ${storyCell("MEASURED")}  ${storyCell("SPAWN CEILING")}  RATIO`);
  for (const row of cost.rows) {
    lines.push(
      `  ${row.story.padEnd(width)}  `
      + `${storyCell(row.measuredUsd === null ? NOT_RECORDED : `$${row.measuredUsd.toFixed(2)}`)}  `
      + `${storyCell(row.ceilingUsd === null ? NOT_RECORDED : `$${row.ceilingUsd.toFixed(2)}`)}  `
      + `${row.ratio === null ? DASH : `${row.ratio.toFixed(1)}x`}`,
    );
  }
  lines.push("");
  if (cost.rows.some((row) => row.ceilingUsd === null)) {
    lines.push(
      "  spawn ceiling not recorded — no `agent.spawned` for that story carried `max_budget_usd`. "
      + "The ceiling is the figure the executor handed the spawn; nothing here invents one.",
    );
  }
  if (cost.rows.some((row) => row.measuredUsd === null)) {
    lines.push(
      "  measured not recorded — no metered `agent.result` carried a cost for that story. "
      + "A turn this process never metered is a cost it did not see, never a free one.",
    );
  }
  if (cost.unmeteredStories.length > 0) {
    lines.push(
      `  ${cost.unmeteredStories.join(", ")}: ${plural(cost.unmeteredTurns, "turn")} UNMETERED, so `
      + "that measurement is a LOWER BOUND, not a total.",
    );
  }
  if (cost.excludedKeyedResults > 0) lines.push(`  ${excludedLine(cost)}`);
  lines.push(`  ${storyVerdict(cost)}`);
  return lines.join("\n");
}

/** What was dropped from the table, and why — a silent drop is its own dishonesty. */
function excludedLine(cost: StoryCost): string {
  return `${plural(cost.excludedKeyedResults, "keyed result")} excluded: no Build spawn named `
    + "them. `ExecutorTask.key` is \"the feature or story the task was for\" and 05-watch fills "
    + "it with a FEATURE id, which is not a story and has no spawn ceiling to be measured against.";
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
  // #56, found by the `tldrx learn` cold-player QA: this was unconditional, so a
  // run whose every attempt was metered in dollars was told there were "two
  // economies" and that no total could be printed. There is one, and the `metered`
  // footer above IS it. The sentence is only true when both economies are present.
  if (metered.length > 0 && declared.length > 0) {
    lines.push("  (no total: two economies, no exchange rate — see spec §2.11)");
  }
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
const NOT_RECORDED = "not recorded";

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

/** Wider than `padCell`: `not recorded` is twelve characters and must not push a column. */
function storyCell(text: string): string {
  return text.padEnd(13);
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
