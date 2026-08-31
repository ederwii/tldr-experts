/**
 * `tldrx run auto` — the headless loop (spec §3, §5).
 *
 * `tldrx next` runs exactly one stage and that is not going to change: one stage,
 * one lock, one decision. `run auto` is the thing that calls it repeatedly, and
 * its entire job is knowing when to STOP:
 *
 *   a human gate      exit 4   the policy says a person signs this one
 *   an open question  exit 4   the stage asked something facts.yml cannot answer
 *   a failure         exit 5   a stage failed; money is spent, nothing is retried
 *   a budget refusal  exit 2   a phase ceiling, or this loop's own `--max-usd`
 *   `--until <stage>` exit 0   stop BEFORE running that stage
 *   the run finished  exit 0
 *
 * It adds no capability `next` does not have, and it deliberately holds no state:
 * every iteration re-reads run.yml off disk, so killing the loop mid-way leaves a
 * run that `tldrx next` picks up exactly where it stopped.
 *
 * Headless only. There is no `--prepare`/`--commit` here: those two are a
 * handshake with a host session that dispatches the sub-agent itself, and a loop
 * that stopped after every `--prepare` would be `next` with extra words.
 */
import { EventLog } from "../events/EventLog.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { ambiguousRunLines } from "../run/openRuns.ts";
import { RunStore } from "../run/RunStore.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { AUTO_GATE_ACTOR } from "../run/autoGate.ts";
import { flatten, isAttendedByHost } from "../run/RunFile.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { cardForTriggers, questionsCard, type CardContext } from "../run/decisionCards.ts";
import { decisionHeader, renderDecisionCard } from "../ui/decisionCard.ts";
import { runNext, type NextOutcome } from "./runNext.ts";

export interface AutoOptions {
  readonly root: string;
  readonly runId?: string;
  /** Loop-level ceiling: total spend across the whole loop, on top of every stage's own. */
  readonly maxUsd?: number;
  /** Stop BEFORE running this stage. */
  readonly until?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly yolo: boolean;
  /** `--parallel N`, passed through to every `next` the loop makes. */
  readonly parallel?: number;
  readonly actor: string;
  readonly at: string;
  /**
   * `--gate-agent`: when this loop stops for a person, print a DECISION CARD
   * instead of the ordinary status block (design §F.3).
   *
   * It changes rendering and nothing else. In particular it does NOT upgrade any
   * stage to `gates_policy: agent` — a policy is what a run was opened with
   * (§A.7), and a flag that could raise one at stop time would make the frozen
   * policy decorative. What it says is "this loop is driving agent gates; when one
   * falls to me, show me the decision, not the dashboard."
   */
  readonly gateAgent?: boolean;
  /** Called with each line as it happens, so a long loop is not silent. */
  readonly onLine?: (line: string) => void;
}

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_AWAITING_HUMAN = 4;

/**
 * §2.2 caps a run at 40 stages, and a stage can legitimately be visited twice (a
 * retry after `reject`). 96 is well past anything a real run does and well short
 * of a loop that spends all night.
 */
const MAX_ITERATIONS = 96;

export async function runAuto(options: AutoOptions): Promise<NextOutcome> {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    options.onLine?.(line);
  };

  // Resolve ONCE and then always pass the concrete id: a loop that re-resolved
  // every iteration could silently change which run it was driving the moment a
  // second one was opened in another terminal.
  const resolution = RunStore.resolve(options.root, options.runId);
  if (resolution.kind === "ambiguous") {
    for (const line of ambiguousRunLines(resolution.open)) say(line);
    return { code: EXIT_REFUSED, lines };
  }
  if (resolution.kind === "none") {
    say(options.runId === undefined
      ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
      : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`);
    return { code: EXIT_NOT_FOUND, lines };
  }
  const runDir = resolution.store.runDir;
  const runId = resolution.store.runId;

  // `attended_by: host` (spec §2.2). Exit 1, a USAGE error, and before the event
  // log is even opened so nothing is written: this loop's whole job is calling
  // `next` headless over and over, and on this run `next` headless is a refusal.
  // Not exit 4 — a run waiting on a host turn is `next`'s answer to give, and a
  // loop that reported "awaiting human" would invite a retry that can never
  // succeed. The command is wrong for this run, which is what 1 means.
  if (isAttendedByHost(resolution.store.run)) {
    say(`${runId} is attended_by: host — \`run auto\` is a loop over spawns and this run does not spawn.`);
    say(`  drive it a turn at a time: tldrx next --prepare ${runId}`);
    say(`  or hand the run back to the framework: tldrx run attend --none ${runId}`);
    return { code: EXIT_USAGE, lines };
  }

  if (options.until !== undefined) {
    const known = flatten(resolution.store.run).map((entry) => entry.stage.id);
    if (!known.includes(options.until)) {
      say(`--until: '${options.until}' is not a stage of run ${runId} (${known.join(", ")})`);
      return { code: EXIT_USAGE, lines };
    }
  }

  const log = EventLog.forRun(runDir);
  const startedSpent = resolution.store.run.budget.spent_usd;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const store = RunStore.open(runDir);
    const spentByLoop = round2(store.run.budget.spent_usd - startedSpent);

    if (store.run.status === "done" || store.run.status === "cancelled") {
      say(`run ${runId} is ${store.run.status} — $${spentByLoop.toFixed(2)} spent by this loop`);
      return { code: EXIT_OK, lines };
    }
    if (options.until !== undefined && store.run.cursor.stage === options.until) {
      say(`stopped before ${store.run.cursor.phase}/${options.until} (--until) — `
        + `$${spentByLoop.toFixed(2)} spent by this loop`);
      return { code: EXIT_OK, lines };
    }
    // Checked BETWEEN stages: a stage already in flight is never cut off mid-turn
    // — that is what the per-stage ceiling and `per_agent_max_usd` are for — so
    // the loop can overshoot by at most one stage's share, and says so.
    if (options.maxUsd !== undefined && spentByLoop >= options.maxUsd) {
      say(`stopped: this loop has spent $${spentByLoop.toFixed(2)} of its `
        + `$${options.maxUsd.toFixed(2)} --max-usd ceiling`);
      return { code: EXIT_REFUSED, lines };
    }

    const before = countEvents(log);
    const cursorBefore = `${store.run.cursor.phase}/${store.run.cursor.stage}`;
    const outcome = await runNext({
      root: options.root,
      runId,
      dryRun: false,
      mode: "headless",
      model: options.model,
      effort: options.effort,
      yolo: options.yolo,
      parallel: options.parallel,
      actor: options.actor,
      at: options.at,
    });
    const fresh = readEvents(log).slice(before);
    for (const line of stageLines(fresh, cursorBefore, outcome)) say(line);

    if (outcome.code !== EXIT_OK) {
      for (const line of stopLines(options, runDir, runId, outcome)) say(line);
      return { code: outcome.code, lines };
    }
    // Exit 0 with nothing appended and the cursor unmoved would loop forever on a
    // run whose files disagree with themselves. Stop and say so instead.
    const after = RunStore.open(runDir);
    if (fresh.length === 0 && `${after.run.cursor.phase}/${after.run.cursor.stage}` === cursorBefore) {
      say(`stopped: ${cursorBefore} made no progress and appended no event`);
      for (const line of outcome.lines) say(`  ${line}`);
      return { code: EXIT_USAGE, lines };
    }
  }
  say(`stopped after ${String(MAX_ITERATIONS)} iterations — run \`tldrx run status ${runId}\``);
  return { code: EXIT_USAGE, lines };
}

/**
 * What the loop prints where it STOPPED.
 *
 * Without `--gate-agent` this is exactly what it always was: `next`'s own lines,
 * indented by two. With it, and only on exit `4` — *awaiting human* — the block is
 * replaced by a decision card (design §F.3): the question, its options, the
 * agent's recommendation if a note carried one, and the one command to type.
 *
 * `next` cards its OWN agent-gate fallthrough, so a card already in the outcome is
 * relayed rather than drawn twice. Two frames around one decision is worse than
 * none: a reader has to work out whether they are the same decision.
 */
function stopLines(
  options: AutoOptions,
  runDir: string,
  runId: string,
  outcome: NextOutcome,
): readonly string[] {
  const indented = outcome.lines.map((line) => `  ${line}`);
  if (options.gateAgent !== true || outcome.code !== EXIT_AWAITING_HUMAN) return indented;
  if (outcome.lines.some((line) => line.startsWith("DECISION — "))) return indented;

  const ctx = cursorContext(runDir, runId);
  if (ctx === null) return indented;
  const questions = questionsCard(ctx);
  if (questions !== null) return renderDecisionCard(questions);
  // No open question: frame what `next` actually said, so `--gate-agent` always
  // hands over a card and never silently degrades to the block it replaced.
  const card = cardForTriggers(ctx, [{ trigger: "gate", detail: "" }]);
  if (card === null) return indented;
  return [
    decisionHeader(card),
    "Gate — this run stopped for a person",
    ...outcome.lines.map((line) => `  ${line}`),
    ...card.commands.map((command) => `  ${command}`),
  ];
}

/** Where the run is now, re-read off disk. Null when run.yml stopped parsing. */
function cursorContext(runDir: string, runId: string): CardContext | null {
  try {
    const store = RunStore.open(runDir);
    return {
      runDir: store.runDir,
      runId,
      phaseId: store.run.cursor.phase,
      stageId: store.run.cursor.stage,
    };
  } catch {
    return null;
  }
}

/**
 * One line per stage the invocation touched, read off the events it appended.
 *
 * The events are used rather than the cursor because ONE `next` can walk past
 * several stages: a `skip_if` that holds skips a stage and keeps going, and a line
 * naming only the cursor it started on would silently under-report the run.
 */
function stageLines(
  fresh: readonly TldrxEvent[],
  cursorBefore: string,
  outcome: NextOutcome,
): readonly string[] {
  const lines: string[] = [];
  let requested: { at: string; cost: number } | null = null;
  let done: { at: string; cost: number } | null = null;
  let approvedBy: string | null = null;

  for (const event of fresh) {
    const at = `${String(payload(event, "phase") ?? "")}/${event.stage ?? ""}`;
    switch (event.type) {
      case "stage.skipped":
        lines.push(`${at} … skipped (${String(payload(event, "reason") ?? "skip_if")})`);
        break;
      case "stage.failed":
        lines.push(`${at} … failed: ${String(payload(event, "reason") ?? "")}`);
        break;
      case "gate.requested":
        requested = { at, cost: number(payload(event, "cost_usd")) };
        break;
      case "gate.approved":
        approvedBy = String(payload(event, "by") ?? event.actor);
        break;
      case "stage.done":
        done = { at, cost: number(payload(event, "cost_usd")) };
        break;
      default:
        break;
    }
  }

  if (requested !== null) {
    lines.push(approvedBy === AUTO_GATE_ACTOR
      ? `${requested.at} … done $${requested.cost.toFixed(2)} · auto-approved`
      : `${requested.at} … done $${requested.cost.toFixed(2)} · awaiting human gate`);
    return lines;
  }
  if (done !== null) {
    lines.push(`${done.at} … done $${done.cost.toFixed(2)}`);
    return lines;
  }
  if (lines.length === 0) {
    // No stage event at all: awaiting an answer, a budget refusal, a stage already
    // parked at a gate before the loop started. `next`'s own first line says which.
    lines.push(`${cursorBefore} … ${outcome.lines[0] ?? "no progress"}`);
  }
  return lines;
}

function payload(event: TldrxEvent, key: string): unknown {
  return (event.payload as Record<string, unknown>)[key];
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function countEvents(log: EventLog): number {
  return readEvents(log).length;
}

function readEvents(log: EventLog): readonly TldrxEvent[] {
  try {
    return log.read();
  } catch {
    return [];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
