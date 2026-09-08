/**
 * What the PHASE has spent so far, for `04-build/handoff.md`'s header — never
 * what THIS process spent (#138), and never a confident total when the ledger
 * cannot be read (#139).
 */
import { RunStore } from "../run/RunStore.ts";
import { stageAt } from "../run/RunFile.ts";
import { spendBasisOf, type SpendTurn } from "../budget/spendBasis.ts";
import { turnTokens } from "../budget/turnTokens.ts";
import { round2 } from "./caps.ts";
import { overShareSentence, sumOrNull } from "./planVsMeasured.ts";
import { storyLedger, type StoryTurn } from "../budget/costView.ts";

/** One turn's accounting — as much of an executor task as the cost line reads. */
export interface PhaseCostTurn {
  readonly costUsd: number;
  /** False ⇒ billed to a host session; `run.yml` records no dollars for it. */
  readonly metered?: boolean;
  readonly tokens?: number;
  /**
   * The provider's measured split for this turn (#159), when the executor
   * spawned one and read its `AgentOutcome.usage`. Absent for a HOST turn —
   * nothing here watched it.
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * One story's ceiling-vs-measured, as much of it as the cost line reads.
 *
 * Two nullable numbers and nothing else: the orchestrator owns the join (which
 * caps it applied to which story, which turns it ran for them) and hands DATA
 * down, exactly as `PreflightCache` and `ReviewCounters` do.
 */
export interface StorySpend {
  /** What the executor handed this story's spawns as `--max-budget-usd`. */
  readonly ceilingUsd: number | null;
  /** What this process actually metered for it. Null is "never metered", not zero. */
  readonly measuredUsd: number | null;
}

export interface PhaseCost {
  readonly usd: number;
  readonly note: string | null;
  /**
   * Turns this phase recorded as `metered: false`, and turns that put a real
   * figure in `usd`. ADDITIVE (defect 3, 2026-09-07 audit): the `note` above
   * already explained WHY the total is short, and the header still printed
   * `Cost: $0.11 of $200.00 ceiling` as the number a reader takes away.
   * `budget/spentFigure.ts` turns these two into the figure itself.
   */
  readonly unmetered: number;
  readonly metered: number;
}

/**
 * The PHASE's story ledger, in the shape the cost line reads — ONE SCOPE.
 *
 * `Cost: $X of $Y ceiling` is deliberately the phase to date, not this process's
 * spend (#138), so the clause that qualifies it has to be phase-to-date too. It
 * was not: built from a per-`BuildSession` map of caps and the session's own
 * tasks, it covered only the stories THIS invocation re-ran. On a re-entered
 * Build — the fix-round case, which is exactly when somebody reads this line — a
 * story that overran 5x in invocation 1 vanished from the clause while its
 * dollars stayed in the figure in front of it. Two scopes on one line, neither
 * named.
 *
 * The ceilings come back out of `events.jsonl` instead, where `agent.spawned`
 * recorded each one AT the spawn (`ctx.emit` appends synchronously, so this
 * invocation's are already on disk when the handoff is written). That is reading
 * the record, not re-deriving it — `developerCap` reads the attempt and
 * `reviewerCap` reads what had been spent by then, so a recomputation would be a
 * different number wearing the same name. `invocationTurns` supplies the money
 * side for THIS invocation, whose `agent.result` rows `recordExecutorTasks` has
 * not written yet — the same reason `invocationUsd` is added to the sum below.
 *
 * Both feeders now walk one ledger (`budget/costView.ts`'s `storyLedger`), so
 * `tldrx cost --stories` and this header cannot disagree about what a story is.
 */
export function storySpendToDate<T extends StoryTurn>(
  runDir: string,
  phaseId: string,
  stageId: string,
  invocationTurns: readonly T[] = [],
): readonly StorySpend[] {
  return storyLedger(
    runDir,
    { phaseId, stageId },
    invocationTurns.map((turn) => ({
      key: turn.key, costUsd: turn.costUsd, metered: turn.metered,
    })),
  ).rows.map((row) => ({ ceilingUsd: row.ceilingUsd, measuredUsd: row.measuredUsd }));
}

/**
 * What the PHASE has spent so far, for the handoff header — never what THIS
 * process spent (#138).
 *
 * `04-build/handoff.md` is rewritten by every invocation that reaches `finish()`,
 * over a document whose own docstring says it "describes the phase, not the
 * invocation". The header was fed `this.spent()`, the sum of the tasks this
 * process spawned, so a `tldrx next` → `tldrx reject` → `tldrx next` rewrote a
 * phase that had spent $0.44 as one that had spent `$0.00`: the second invocation
 * settled nothing, spent nothing, and said so about the whole phase.
 *
 * **The durable source is `run.yml`'s `stage.cost_usd`**, and it is chosen over
 * the `agent.result` events for one reason: it is the ledger the BUDGET is
 * derived from, and it validates its own arithmetic. `rollUp` recomputes it from
 * `stage.tasks` on every save (`RunStore.ts:378`), `rollUpBudget` mirrors it into
 * `budget.yml`, `run status` and the dashboard both read it (`dashboard/model.ts`,
 * `stage.cost_usd`), and `validateRunFile` REFUSES a `run.yml` whose
 * `budget.spent_usd` drifts from the sum of its task rows by more than a cent
 * (`RunFile.ts:647`). The events ledger carries the same numbers — every
 * `recordTask` is paired with an `agent.result` written from the same task in the
 * same loop — but nothing checks that it still does, so reading it here would put
 * a second, unpoliced derivation of the budget on the page beside the first.
 *
 * Three properties this relies on, each verified rather than assumed:
 *
 *  - **`tldrx reject` does not touch it.** It rewrites `status`, `ended_at` and
 *    `gate` and nothing else (`run/gates.ts`), so a rejected stage keeps every
 *    dollar it spent. That is the right answer to "what should a reject do to the
 *    number a re-run reports": nothing. The money was spent.
 *  - **This invocation is not in it yet.** `recordExecutorTasks` runs in
 *    `runNext` AFTER the executor returns, so at `writeHandoff` time `run.yml`
 *    holds the earlier invocations and `invocationUsd` holds this one. Adding
 *    them cannot double-count.
 *  - **Opening the store mid-stage is the established shape here**, not a new
 *    coupling: the executor already does exactly `RunStore.open(runDir).run` for
 *    the run title and for the epic-branch state.
 *
 * When the ledger cannot be read at all — no `run.yml`, one that fails schema
 * validation, or a stage id that does not resolve — the answer is NOT a confident
 * total. It falls back to this invocation's own spend and says which of the two
 * numbers the reader is looking at.
 *
 * **And the total it CAN read is a lower bound whenever a turn ran in-session**
 * (#139). A host session driving `--prepare`/`--commit` without `--cost-usd` is
 * recorded as `cost_usd: null` + `metered: false`, and `rollUp` sums that as
 * nothing — so `stage.cost_usd` is what the METERED turns cost, not what the
 * stage cost. Measured, not inferred: a run whose developer was the host's and
 * whose reviewer was a $0.11 spawn wrote `Cost: $0.11 of $200.00 ceiling`, a bare
 * figure indistinguishable from a stage where every turn was billed here.
 *
 * The counting and the sentence come from `budget/spendBasis.ts`, which is also
 * where the dashboard's `spend.reason` comes from (#103) and where `budget show`'s
 * "LOWER BOUND, not a total" is spelled — the caveat is one derivation on three
 * surfaces rather than three wordings of one fact. The turns are the same rows
 * the sum above is made of, plus this invocation's, for the same reason
 * `invocationUsd` is added to it: the first write of a handoff happens before
 * `recordExecutorTasks` puts them in the file.
 *
 * A stage whose every turn WAS metered gets no note at all. `measured` is the one
 * basis with nothing to say, and a caveat on every header is a caveat nobody reads.
 */
// `<T extends PhaseCostTurn>` rather than a bare `readonly PhaseCostTurn[]`
// parameter: `build.ts`'s own call site passes `this.tasks: ExecutorTask[]` (a
// typed variable, structurally a `PhaseCostTurn[]` already), but
// `test/build-executor.test.ts` passes several FRESH `ExecutorTask`-shaped
// object literals inline, and TS's excess-property check rejects a fresh
// literal's extra fields against a plain object type even when the same value
// held in a variable would pass. Inferring `T` from the literal itself sidesteps
// that check while still enforcing the constraint — the body reads only
// `costUsd`, `metered` and `tokens`, exactly as it did before this file moved.
export function phaseCostToDate<T extends PhaseCostTurn>(
  runDir: string,
  phaseId: string,
  stageId: string,
  invocationUsd: number,
  invocationTurns: readonly T[] = [],
  stories: readonly StorySpend[] = [],
): PhaseCost {
  let recorded: number | null = null;
  let turns: SpendTurn[] = [];
  // The HOST-declared side only (#159) — a SEPARATE sum from `turns[].tokens`
  // above, because that field is now `turnTokens(task)` and can be filled from
  // a provider's split. Folding the split into this figure would let a
  // measurement stand in for something the host never declared; see the
  // `absent` sentence's dash-clause in `spendBasis.ts`, which is the only place
  // this number is read.
  let hostTokens = 0;
  try {
    const found = stageAt(RunStore.open(runDir).run, { phase: phaseId, stage: stageId, task: null });
    if (found !== null) {
      recorded = found.stage.cost_usd;
      // The rows the sum above is made of. `metered` is written only when it is
      // `false`, so an absent one means metered — every row from before the field
      // existed, and every headless spawn.
      turns = found.stage.tasks.map((task) => ({
        costUsd: task.cost_usd,
        metered: task.metered !== false,
        tokens: turnTokens(task),
      }));
      hostTokens += found.stage.tasks.reduce((sum, task) => sum + (task.tokens ?? 0), 0);
    }
  } catch {
    // A run.yml that is missing, torn, or invalid. The handoff is still worth
    // writing; the header just has to stop pretending it knows the phase total.
    recorded = null;
  }
  // This invocation's turns are not in `run.yml` yet — `recordExecutorTasks` runs
  // after the executor returns — so they are counted from the executor's own list,
  // exactly as `invocationUsd` is added to the sum. Without them the FIRST write
  // of a handoff would count nothing at all and report a host-driven stage as
  // fully metered (#139).
  turns = [
    ...turns,
    ...invocationTurns.map((task) => ({
      costUsd: task.metered === false ? null : round2(task.costUsd),
      metered: task.metered !== false,
      tokens: turnTokens({ tokens: task.tokens, input_tokens: task.inputTokens, output_tokens: task.outputTokens }),
    })),
  ];
  hostTokens += invocationTurns.reduce((sum, task) => sum + (task.tokens ?? 0), 0);
  const counted = spendBasisOf(turns, hostTokens, "stage");
  // A fully metered stage keeps its clean line: `measured` is the one basis with
  // nothing to caveat, and a caveat on every header is a caveat nobody reads.
  const bound = counted.basis === "measured" ? null : counted.reason;
  // One clause, from the ONE arithmetic (`build/planVsMeasured.ts`) — the same
  // sentence `tldrx cost --stories` prints, so the header and the report cannot
  // word one fact two ways. Absent when either side is missing or the stories
  // fit, the same discipline `bound` follows above: `sumOrNull` refuses to add a
  // `null` as a zero, so a story whose ceiling was never recorded takes the
  // whole clause with it rather than shrinking the denominator.
  const over = overShareSentence(
    sumOrNull(stories.map((story) => story.ceilingUsd)),
    sumOrNull(stories.map((story) => story.measuredUsd)),
    stories.length,
  );
  const note = [bound, over].filter((part) => part !== null).join("; ") || null;
  // Counted from the SAME `turns` array the basis sentence is built from, so the
  // figure and the caveat can never describe two different sets of turns. Not
  // `counted.costlessTasks`: that is the deliberately WIDER reading (it also
  // counts a metered `$0.00`), and the figure's `≥` is a claim about turns that
  // recorded no dollars AT ALL. The two live side by side on purpose.
  const unmetered = turns.filter((turn) => !turn.metered).length;
  const tally = { unmetered, metered: turns.length - unmetered };
  if (recorded === null) {
    return {
      usd: round2(invocationUsd),
      note: "this invocation only — `run.yml` could not be read for what the stage spent before it"
        + (note === null ? "" : `; ${note}`),
      ...tally,
    };
  }
  return { usd: round2(recorded + invocationUsd), note, ...tally };
}
