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
 *
 * ## Telling somebody (gh #180)
 *
 * Every stop above is announced on STDOUT, and stdout is in a terminal nobody is
 * watching — which is why 23 of 23 real runs in the week of 2026-09-07 were driven
 * in host mode instead, trading this loop's metered budget, enforced model and
 * parallel stories for a notification. So when `.tldrx/workspace.yml` declares a
 * `notify:` command (spec §2.18), this loop hands it one JSON payload on stdin at
 * each of those moments, with the exact command to type already in it.
 *
 * Three lines hold, and they are what every test in `test/notify-hook.test.ts`
 * asserts. **No behaviour moves**: a question or a gate still exits 4, with the same
 * lines, and an undeclared workspace is byte-identical to what it was. **A notifier
 * never changes an outcome**: every failure is a `notify.failed` event with a
 * reason. And **nothing here derives anything twice**: the questions come from the
 * same `questionsCard` `--gate-agent` prints, the status text from the same
 * `renderStatus` `tldrx run status` prints.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../events/EventLog.ts";
import { notRestoredSummary } from "../build/foreignWork.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { ambiguousRunLines } from "../run/openRuns.ts";
import { RunStore } from "../run/RunStore.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { AUTO_GATE_ACTOR, reevaluateAutoGate } from "../run/autoGate.ts";
import { flatten, isAttendedByHost, isFinished, type RunFile } from "../run/RunFile.ts";
import { BUILD_PHASE } from "../run/buildProgress.ts";
import { outcomeLine, storiesView } from "../run/runOutcome.ts";
import { runTally } from "../budget/budgetView.ts";
import { spentFigure, tallyOf, type SpentTally } from "../budget/spentFigure.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { cardForTriggers, questionsCard, type CardContext } from "../run/decisionCards.ts";
import { QUESTION_PHASES } from "../run/questionCards.ts";
import { decisionHeader, renderDecisionCard, type DecisionCard } from "../ui/decisionCard.ts";
import { blockingQuestionIds } from "./skipIf.ts";
import { buildStatus, renderStatus } from "../run/runStatus.ts";
import { waitingFor } from "../run/waiting.ts";
import { gatePolicyFor, type GatePolicy } from "../run/gatePolicy.ts";
import { readNotifyDeclaration } from "../notify/declaration.ts";
import { Notifier } from "../notify/Notifier.ts";
import {
  budgetNotification, gateNotification, gateTimeoutNotification, questionNotification,
  questionTimeoutNotification, runEndNotification, stageDoneNotification, statusNotification,
  type NotifyContext, type WaitingGate,
} from "../notify/notifications.ts";
import { GATE_SIGNER_ROLE } from "./gateSigner.ts";
import { approve } from "../run/gates.ts";
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
  /**
   * `--notify-every <duration>`, in ms: how often the declared notify hook (§2.18) gets a
   * `status` payload while this loop is running. Absent ⇒ never, which is the default and
   * what every existing invocation gets.
   *
   * It is a HEARTBEAT, not a progress bar: a stage can hold the loop for twenty minutes,
   * so the tick fires from a timer rather than between iterations — otherwise the one
   * period where a person wants to know the run is alive is the one period it says nothing.
   */
  readonly notifyEveryMs?: number;
  /**
   * `--wait-answers <duration>`, in ms: instead of exiting 4 the moment a stage parks on an
   * open question, poll the question files until they are answered or this lapses.
   *
   * The waiting is the ONLY thing it changes. A lapsed wait exits 4 with the same lines it
   * always did, nothing is spent while it polls, and the answer it is waiting for is an
   * ordinary `tldrx answer` run by a person (or by whatever the notify hook reached). A
   * loop that could ANSWER a question would be the framework answering its own questions.
   */
  readonly waitAnswersMs?: number;
  /**
   * `--wait-gates <duration>`, in ms: `--wait-answers`'s sibling for the OTHER half of
   * exit 4 (gh #197). Instead of exiting the moment a stage parks on a pending gate, poll
   * the run until somebody signs it or this lapses.
   *
   * A sibling rather than an overload, because the two parks are not the same thing: one
   * is closed by `tldrx answer` and the other by `tldrx approve` / `tldrx reject`, they
   * notify under different kinds, and calling a signature an "answer" would be the flag
   * name lying about what a person did.
   *
   * It WAITS FOR a signature; it never produces one — and that stayed true when the engine
   * gained a signer of its own (gh #198). The signing happens one level down, inside
   * `runNext`: a gate whose policy is `agent` gets one bounded `gate-signer` turn BEFORE
   * the loop ever sees an exit code, so a gate this flag is waiting on is by construction
   * one the signer already held (or one whose policy is `human`). Nothing here polls for a
   * signature it could have produced itself, and there is no second wait to reconcile:
   * what it is waiting for is `tldrx approve` (with or without `--as-agent`) run somewhere
   * else, by a person.
   */
  readonly waitGatesMs?: number;
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
  // The task tally as this loop STARTED, so every "spent by this loop" figure
  // below can name what its own delta cannot see (defect 3 of the 2026-09-07
  // audit: two runs reported `$0.00 spent` after 30 and 9 stories).
  const startedTally = runTally(resolution.store.run);
  /**
   * This loop's own spend as a tally — the dollars it metered, and the turns it
   * did not, both as DELTAS against the counts it inherited.
   *
   * Deltas rather than the run's totals, to match `spentByLoop`: a loop resuming
   * a run that already had 40 unmetered turns did not produce them, and saying it
   * did would make its own contribution unreadable. Clamped at zero because a
   * run.yml can be rewritten under a loop (`tldrx reject`, a hand edit) and a
   * negative count is not a thing to report.
   */
  const loopTally = (run: RunFile, spent: number): SpentTally => {
    const now = runTally(run);
    return {
      usd: spent,
      unmetered: Math.max(0, now.unmetered - startedTally.unmetered),
      metered: Math.max(0, now.metered - startedTally.metered),
    };
  };

  // The whole notify feature, from this loop's point of view: a declaration or nothing.
  // A workspace with no `notify:` block gets `null` here and every call below is a no-op,
  // which is why an undeclared run's lines and exit code are byte-identical to what they
  // were before this existed (`test/notify-hook.test.ts` asserts exactly that).
  const declaration = readNotifyDeclaration(options.root);
  const notifier = declaration === null
    ? null
    : new Notifier(declaration, log, runId, options.root, options.actor);

  const at = (): string => new Date().toISOString();
  const cursorOf = (): string | null => {
    const ctx = cursorContext(runDir, runId);
    return ctx === null ? null : `${ctx.phaseId}/${ctx.stageId}`;
  };
  const stageIdOf = (): string | null => cursorContext(runDir, runId)?.stageId ?? null;
  const notifyCtx = (): NotifyContext => ({ runId, root: options.root, at: at(), stage: cursorOf() });

  // `--notify-every`. The tick reads the run off disk and sends what `tldrx run status`
  // prints; a tick that cannot read the run says nothing rather than guessing at one.
  const heartbeat = notifier === null || options.notifyEveryMs === undefined
    ? null
    : setInterval(() => {
        void (async () => {
          let text: string;
          try {
              const store = RunStore.open(runDir);
              text = renderStatus(buildStatus(store.run, store.budget, store.runDir));
            } catch {
              return;
            }
            // `stillBlocking` is the SAME predicate `--wait-answers` polls and `runNext` parks
            // on. Without it the heartbeat told a person "Nothing is waiting on you" every
            // interval while the run sat on their answer — reproduced in review, and worse
            // than silence, because a heartbeat is believed.
            // The SAME two readers the loop itself parks on: `stillBlocking` for questions
            // and `waitingFor` for the gate. Without the second the heartbeat told a person
            // "Nothing is waiting on you" every interval while his signature was the only
            // thing the run was missing (gh #197) — the identical defect this comment's
            // first half already records, one park along.
            await notifier.send(
              statusNotification(notifyCtx(), text, stillBlocking(runDir), pendingGate(runDir)),
              stageIdOf(),
            );
          })();
        }, options.notifyEveryMs);

    /**
     * Every exit from the loop body below goes through here: the last notification, the
     * timer stopped, every queued send awaited. A `run.finished` that the process exited
     * before delivering would be the one notification that is worse than none.
     */
    const finish = async (code: number, spentUsd: number): Promise<NextOutcome> => {
      if (heartbeat !== null) clearInterval(heartbeat);
      if (notifier !== null) {
        const run = RunStore.open(runDir).run;
        await notifier.send(
          runEndNotification(
            notifyCtx(), code, spentUsd, lines[lines.length - 1] ?? "",
            loopTally(run, spentUsd),
            heldForeignWork(),
            // Only for a run that is actually OVER (#210). A loop that stopped
            // with the run still open has no outcome to report, and saying
            // `not recorded` there would be a claim about a run still running.
            isFinished(run.status) ? outcomeLine(run.outcome) : null,
          ),
          stageIdOf(),
        );
        await notifier.drain();
      }
      return { code, lines };
    };

    /**
     * Uncommitted work a Build stage set aside and could not give back (#164), read
     * off this run's own log — the same sentence the terminal's last line carries.
     *
     * No new notify kind: it rides in the `summary` of the kinds a run-level
     * notification already goes out under. The person reading "the stage finished"
     * on a phone is exactly the person whose files are in that stash. `null` on
     * every ordinary run, which leaves those summaries byte-identical.
     */
    const heldForeignWork = (): string | null => {
      try {
        return notRestoredSummary(readFileSync(join(runDir, "events.jsonl"), "utf8"));
      } catch {
        return null;
      }
    };

    /** The open questions where the run is parked, as the card `--gate-agent` would print. */
    const openQuestions = (): DecisionCard | null => {
      const ctx = cursorContext(runDir, runId);
      return ctx === null ? null : questionsCard(ctx);
    };

    /**
     * One iteration's events, translated into notifications.
     *
     * The branching mirrors `stageLines` below deliberately: a gate that was auto-approved
     * is not a gate anybody was asked to sign, so it is a `stage.done`, and a stage whose
     * gate fell to a person is `gate.requested` and NOT also a `stage.done`. Two payloads
     * for one stage would make an owner's script announce the same money twice.
     */
    const notifyFresh = async (fresh: readonly TldrxEvent[]): Promise<FreshNotified> => {
      if (notifier === null) return { costUsd: null, deferredGate: null };
      let requested: number | null = null;
      let requestedPhase = "";
      let autoApproved = false;
      for (const event of fresh) {
        if (event.type === "gate.requested") {
          requested = number(payload(event, "cost_usd"));
          requestedPhase = String(payload(event, "phase") ?? "");
        }
        if (event.type === "gate.approved" && String(payload(event, "by") ?? event.actor) === AUTO_GATE_ACTOR) {
          autoApproved = true;
        }
        if (event.type === "budget.warned") {
          await notifier.send(
            budgetNotification(
              notifyCtx(),
              number(payload(event, "spent_usd")),
              number(payload(event, "ceiling_usd")),
              // From the event, not re-derived: the warning is about the phase as
              // it was when it fired, and the run has moved since.
              {
                usd: number(payload(event, "spent_usd")),
                unmetered: number(payload(event, "unmetered_tasks")),
                metered: number(payload(event, "spent_usd")) > 0 ? 1 : 0,
              },
            ),
            event.stage,
          );
        }
      }
      if (requested !== null && !autoApproved) {
        const cost = requested;
        const policy = gatePolicyNow(runDir);
        // The story outcomes, for a BUILD gate only (#210). Re-read off disk
        // rather than lifted from the payload, exactly as `gatePolicyNow` on the
        // line above is: the loop is PARKED at this gate — nothing of this run
        // is running and nothing will write another byte until somebody signs —
        // so disk and the event that just fired describe the same instant. The
        // phase comes from the event, so a Plan gate (where every story is `todo`
        // by design) is never described as having delivered nothing.
        const stories = requestedPhase === BUILD_PHASE ? storiesView(runDir) : null;
        const send = async (): Promise<void> => {
          if (notifier === null) return;
          await notifier.send(gateNotification(notifyCtx(), cost, policy, gateHeld(fresh), stories), stageIdOf());
        };
        // The ONE case that waits: an auto gate whose only failing condition is
        // `questions` (gh #203). The questions ARE the gate — it is downstream of
        // them, not a parallel ask — so telling an owner to sign something before
        // telling him what to answer sends him to the wrong tap. The EVENT is on the
        // log either way: this defers a notification, never an audit record.
        if (onlyHeldByQuestions(fresh)) return { costUsd: cost, deferredGate: send };
        await send();
        return { costUsd: cost, deferredGate: null };
      }
      for (const event of fresh) {
        if (event.type === "stage.done") {
          // The stage's own unmetered turns, so "finished for $0.00" cannot be
          // sent about a stage every turn of which was billed to a host session.
          const stage = flatten(RunStore.open(runDir).run)
            .find((entry) => entry.stage.id === event.stage);
          const unmetered = stage === undefined
            ? 0
            : stage.stage.tasks.filter((task) => task.metered === false).length;
          await notifier.send(
            stageDoneNotification(notifyCtx(), number(payload(event, "cost_usd")), unmetered, heldForeignWork()),
            event.stage,
          );
        }
      }
      return { costUsd: null, deferredGate: null };
    };

    try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const store = RunStore.open(runDir);
      const spentByLoop = round2(store.run.budget.spent_usd - startedSpent);

      if (store.run.status === "done" || store.run.status === "cancelled") {
        say(`run ${runId} is ${store.run.status} — ${spentFigure(loopTally(store.run, spentByLoop))} `
          + "spent by this loop");
        return await finish(EXIT_OK, spentByLoop);
      }
      if (options.until !== undefined && store.run.cursor.stage === options.until) {
        say(`stopped before ${store.run.cursor.phase}/${options.until} (--until) — `
          + `${spentFigure(loopTally(store.run, spentByLoop))} spent by this loop`);
        return await finish(EXIT_OK, spentByLoop);
      }
      // Checked BETWEEN stages: a stage already in flight is never cut off mid-turn
      // — that is what the per-stage ceiling and `per_agent_max_usd` are for — so
      // the loop can overshoot by at most one stage's share, and says so.
      if (options.maxUsd !== undefined && spentByLoop >= options.maxUsd) {
        say(`stopped: this loop has spent $${spentByLoop.toFixed(2)} of its `
          + `$${options.maxUsd.toFixed(2)} --max-usd ceiling`);
        return await finish(EXIT_REFUSED, spentByLoop);
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
      // `notify.*` is filtered out before anything reads this. Those lines are appended by
      // the heartbeat timer, which can fire mid-stage, and a run that appended NOTHING but a
      // notification has still made no progress — the guard below would stop seeing that.
      const fresh = readEvents(log).slice(before).filter((event) => !event.type.startsWith("notify."));
      // Read once per iteration, off the file the loop just wrote — the same
      // source `notifyFresh` uses, so the line on stdout and the notification
      // about the same stage cannot disagree about what it cost.
      const stageTally = (stageId: string): { unmetered: number; metered: number } => {
        const found = flatten(RunStore.open(runDir).run).find((e) => e.stage.id === stageId);
        if (found === undefined) return { unmetered: 0, metered: 1 };
        const counted = tallyOf(found.stage.tasks);
        return { unmetered: counted.unmetered, metered: counted.metered };
      };
      for (const line of stageLines(fresh, cursorBefore, outcome, stageTally)) say(line);
      // What the gate that just fell to a person cost, when this iteration is the one that
      // raised it. Null on a loop that RESUMED a run already parked at a gate: no
      // `gate.requested` event was appended here, so no figure was measured, and
      // `gate.timeout` says nothing about cost rather than saying $0.00.
      const notified = await notifyFresh(fresh);
      const gateCostUsd = notified.costUsd;
      let deferredGate = notified.deferredGate;
      /**
       * Send the gate notification that was held back — once, at the first moment it
       * is still true. Idempotent: every call after the first is a no-op, so the
       * three places that must not miss it can each say so without coordinating.
       */
      const flushGate = async (): Promise<void> => {
        const send = deferredGate;
        deferredGate = null;
        if (send !== null) await send();
      };

      if (outcome.code !== EXIT_OK) {
        // `--wait-answers`: the ONE place the loop does something other than stop. The
        // question has already been notified; polling here rather than exiting is what turns
        // "answer it and start the loop again" into "answer it".
        let rejection: string | null = null;
        if (outcome.code === EXIT_AWAITING_HUMAN) {
          const card = openQuestions();
          if (card !== null && notifier !== null) {
            await notifier.send(questionNotification(notifyCtx(), card), stageIdOf());
          }
          if (card !== null && options.waitAnswersMs !== undefined) {
            const waited = await waitForAnswers(runDir, options.waitAnswersMs);
            if (waited.answered) {
              // The questions are settled. If the gate they were holding is STILL
              // pending — a second condition, or no `--wait-gates` to close it — the
              // notification that was deferred is now the actionable one (gh #203).
              if (pendingGate(runDir) !== null) await flushGate();
              say(`waited ${String(Math.round(waited.ms / 1000))}s at ${cursorBefore} — `
                + "every blocking question is answered, resuming");
              continue;
            }
            if (notifier !== null) {
              await notifier.send(questionTimeoutNotification(notifyCtx(), card, waited.ms), stageIdOf());
            }
            say(`waited ${String(Math.round(waited.ms / 1000))}s at ${cursorBefore} — `
              + "no answer arrived (--wait-answers)");
          } else if (options.waitGatesMs !== undefined) {
            // `--wait-gates`: the same wait for the other half of exit 4 (gh #197). The gate
            // has already been notified above, exactly as it was; this decides whether the
            // loop gives a signature a chance to land instead of stopping on the spot. The
            // park is read through `waitingFor` — the one derivation `tldrx run status` and
            // the dashboard share — so this cannot form a second opinion about whether a gate
            // is pending. The policy is REPORTED, and acted on in exactly one direction
            // (gh #203): an `auto` gate is re-measured on every poll and signed the moment
            // its seven conditions hold — the authority the run already granted, kept open
            // instead of expiring the instant `next` handed the gate over. A `human` or
            // `agent` gate stops this loop exactly as it always did; nothing here writes an
            // evidence note, and nothing here signs for a person.
            const gate = pendingGate(runDir);
            if (gate !== null) {
              const waited = await waitForGate(runDir, gate.stageId, options.waitGatesMs, {
                root: options.root,
                policy: gate.policy,
                at: options.at,
              });
              if (waited.resolution === "approved") {
                say(`waited ${String(Math.round(waited.ms / 1000))}s at ${cursorBefore} — `
                  + `the gate on ${gate.stage} is approved, resuming`);
                continue;
              }
              if (waited.resolution === "rejected") {
                // The rejection's own semantics, unchanged: `tldrx reject` has already put the
                // stage back to `ready` with the note fed into the next prompt, and the loop
                // stops on the exit `next` gave it. Resuming here would re-spend the stage on
                // a decision the person who rejected it has not been shown the result of.
                //
                // Said AFTER the stop block rather than before it, unlike every other `waited
                // …` line: the rejection is the stop REASON, and `run.finished`/`run.failed`
                // carries the last line — so a note written by the person who stopped the loop
                // reaches the phone of the person who has to act on it.
                rejection = `waited ${String(Math.round(waited.ms / 1000))}s at ${cursorBefore} — `
                  + `the gate on ${gate.stage} was REJECTED`
                  + (waited.note === null ? "" : `: ${waited.note}`);
              } else {
                // Lapsed: nothing closed it and nothing will. Whatever was deferred
                // above is now the whole story, and it goes out BEFORE the timeout so
                // the two read in the order they happened.
                await flushGate();
                if (notifier !== null) {
                  await notifier.send(
                    gateTimeoutNotification(notifyCtx(), gateCostUsd, waited.ms, gate.policy),
                    stageIdOf(),
                  );
                }
                say(`waited ${String(Math.round(waited.ms / 1000))}s at ${cursorBefore} — `
                  + "nobody signed the gate (--wait-gates)");
              }
            }
          }
        }
        for (const line of stopLines(options, runDir, runId, outcome)) say(line);
        if (rejection !== null) say(rejection);
        return await finish(outcome.code, spentByLoop);
      }
      // Exit 0 with nothing appended and the cursor unmoved would loop forever on a
      // run whose files disagree with themselves. Stop and say so instead.
      const after = RunStore.open(runDir);
      if (fresh.length === 0 && `${after.run.cursor.phase}/${after.run.cursor.stage}` === cursorBefore) {
        say(`stopped: ${cursorBefore} made no progress and appended no event`);
        for (const line of outcome.lines) say(`  ${line}`);
        return await finish(EXIT_USAGE, spentByLoop);
      }
    }
    say(`stopped after ${String(MAX_ITERATIONS)} iterations — run \`tldrx run status ${runId}\``);
    return await finish(EXIT_USAGE, round2(RunStore.open(runDir).run.budget.spent_usd - startedSpent));
  } finally {
    // Defense in depth. Every return above already goes through `finish`, which clears the
    // timer and drains the queue — but an unexpected throw would otherwise leave an interval
    // holding the event loop open and a notifier still able to fire for a loop that is gone.
    if (heartbeat !== null) clearInterval(heartbeat);
    if (notifier !== null) await notifier.drain();
  }
}

/**
 * Poll the run's question files until nothing blocking is open, or `limitMs` lapses.
 *
 * It reads and does nothing else — no lock, no mutation, not one byte written. The answer
 * it is waiting for is `tldrx answer` run by a person somewhere else, and the next
 * `runNext` is what notices and moves the stage back to `ready`; this only decides whether
 * to give it that chance.
 *
 * The poll interval is derived rather than configurable (`pollInterval`, shared with
 * `waitForGate`): a quarter of the wait, capped at two seconds. A knob here would be a
 * third duration for an owner to get wrong, and the thing being waited on is a human
 * typing.
 */
async function waitForAnswers(
  runDir: string,
  limitMs: number,
): Promise<{ readonly answered: boolean; readonly ms: number }> {
  const started = Date.now();
  const pollMs = pollInterval(limitMs);
  for (;;) {
    const elapsed = Date.now() - started;
    if (stillBlocking(runDir).length === 0) return { answered: true, ms: elapsed };
    if (elapsed >= limitMs) return { answered: false, ms: elapsed };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, limitMs - elapsed)));
  }
}

/**
 * How often either wait looks: a quarter of the wait, floored at 25 ms and capped at two
 * seconds. ONE derivation for both flags — two waits that polled at different rates would
 * be a knob nobody chose, and the thing being waited on is a person typing.
 */
function pollInterval(limitMs: number): number {
  return Math.max(25, Math.min(2000, Math.floor(limitMs / 4)));
}

/**
 * The gate this run is PARKED on, or null — and who its frozen policy says may sign it.
 *
 * Built on `waitingFor`, which is the ONE answer to "what is this run waiting on"
 * (`run/waiting.ts`): it reads the STATUS of the stage the cursor sits on, never the gate
 * objects, so a brand-new run whose every `gate.status` is still `pending` is not called
 * "waiting at a gate". A second predicate here is exactly the drift that put the heartbeat
 * out of step with the interrupt once already.
 *
 * The policy is read separately, through `gatePolicyFor` — the run's own frozen map. It is
 * what `waitForGate` hands to `selfCloseAutoGate`, which acts on `auto` and on nothing else;
 * for `human` and `agent` this loop waits the same way it always did.
 */
function pendingGate(runDir: string): (WaitingGate & { readonly stageId: string }) | null {
  try {
    const store = RunStore.open(runDir);
    if (waitingFor(store.run, store.runDir).kind !== "gate") return null;
    const cursor = store.run.cursor;
    return {
      stage: `${cursor.phase}/${cursor.stage}`,
      stageId: cursor.stage,
      policy: gatePolicyFor(store.run.gates_policy, cursor.stage),
    };
  } catch {
    return null;
  }
}

/** The cursor stage's gate policy, or null when the run cannot be read. */
function gatePolicyNow(runDir: string): GatePolicy | null {
  try {
    const store = RunStore.open(runDir);
    return gatePolicyFor(store.run.gates_policy, store.run.cursor.stage);
  } catch {
    return null;
  }
}

/**
 * Poll one stage's gate until it is signed, either way, or `limitMs` lapses.
 *
 * Reads and does nothing else, like `waitForAnswers` — no lock, no mutation, not one byte
 * written and not one cent spent. The signature it is waiting for is `tldrx approve` or
 * `tldrx reject` run by somebody else; this only decides whether the loop gives it a
 * chance to arrive.
 *
 * The status is read off the STAGE'S OWN GATE rather than through `waitingFor`, because
 * the question here is a different one: `waitingFor` answers "is a gate holding this run",
 * which stops being true the moment either verb lands, and approve and reject then need
 * telling apart. `gate.status` is the field both verbs write, read once, not re-derived.
 */
async function waitForGate(
  runDir: string,
  stageId: string,
  limitMs: number,
  gate: GateWait,
): Promise<{
  readonly resolution: "approved" | "rejected" | "lapsed";
  readonly ms: number;
  readonly note: string | null;
}> {
  const started = Date.now();
  for (;;) {
    const elapsed = Date.now() - started;
    const found = gateOf(runDir, stageId);
    if (found !== null && found.status === "approved") return { resolution: "approved", ms: elapsed, note: null };
    if (found !== null && found.status === "rejected") {
      return { resolution: "rejected", ms: elapsed, note: found.note.trim() === "" ? null : found.note.trim() };
    }
    // The one thing this loop DOES rather than watches (gh #203). An `auto` policy has
    // already said the machine may close this gate; before #203 the offer expired the
    // moment `next` handed the gate over, so an auto gate held by four open questions
    // stayed a human gate forever once the answers landed.
    if (found !== null && await selfCloseAutoGate(runDir, stageId, gate)) {
      return { resolution: "approved", ms: Date.now() - started, note: null };
    }
    if (elapsed >= limitMs) return { resolution: "lapsed", ms: elapsed, note: null };
    const pollMs = pollInterval(limitMs);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, limitMs - elapsed)));
  }
}

/** What a self-close needs that is not on disk. DATA, never the loop's options object. */
interface GateWait {
  readonly root: string;
  /** The run's own FROZEN policy for this stage. Only `auto` is ever self-closed. */
  readonly policy: GatePolicy | null;
  /** The loop's pinned clock, or undefined to take the wall clock, as `next` does. */
  readonly at: string | undefined;
}

/**
 * Re-run the seven conditions and, when every one holds, sign the gate.
 *
 * `human` and `agent` return false without measuring anything — a policy is a
 * statement about WHO may close a gate, and this loop is not a person and is not the
 * engine's evidence-writing signer (#198). A person's `approve` or `reject` still
 * lands first: this only runs while the gate is provably still `pending`, and it goes
 * through the SAME `approve` door `runNext` uses when an auto gate closes at the end
 * of a stage — the checks are re-run off disk there, the actor is `AUTO_GATE_ACTOR`,
 * and the note is the verdict's own seven-condition line. One implementation of
 * "an auto gate closes", called from two places.
 *
 * False on any refusal, including `approve`'s own: a gate this could not close is a
 * gate that keeps waiting for a person, never one reported as closed.
 *
 * It runs at the POLL cadence — `pollInterval`, a quarter of the wait capped at two
 * seconds — and that is a decision, not an oversight. Re-measuring costs file reads
 * and, at a Build gate only, one `git diff --name-only` per repo for condition 7: a
 * four-hour `--wait-gates` over a Build stage is a few thousand `git diff` spawns and
 * no money, no agent turn and nothing written. A second, slower cadence would be a
 * duration nobody chose (the same reason `pollInterval` is derived rather than a
 * flag), and a gate that re-measured lazily would leave an owner's answered question
 * sitting behind a closed condition for however long that knob happened to be.
 */
async function selfCloseAutoGate(runDir: string, stageId: string, gate: GateWait): Promise<boolean> {
  if (gate.policy !== "auto") return false;
  try {
    const store = RunStore.open(runDir);
    const verdict = await reevaluateAutoGate({
      root: gate.root,
      runDir: store.runDir,
      run: store.run,
      budget: store.budget,
      stageId,
    });
    if (verdict === null || !verdict.ok) return false;
    const approved = await approve(store, {
      root: gate.root,
      actor: AUTO_GATE_ACTOR,
      at: gate.at ?? new Date().toISOString(),
      note: verdict.note,
    });
    return approved.ok;
  } catch {
    return false;
  }
}

/** One stage's gate object, off disk. Null when the run or the stage cannot be read. */
function gateOf(runDir: string, stageId: string): { readonly status: string; readonly note: string } | null {
  try {
    const found = flatten(RunStore.open(runDir).run).find((entry) => entry.stage.id === stageId);
    return found === undefined ? null : { status: found.stage.gate.status, note: found.stage.gate.note };
  } catch {
    return null;
  }
}

/**
 * Blocking open question ids across every phase of the run.
 *
 * `blockingQuestionIds` is the ONE predicate for "does this question park a run" — the same
 * one `runNext` and `skip_if` take, imported rather than re-decided, so an `advisory: true`
 * block cannot make this loop wait for an answer `runNext` was never going to require.
 */
function stillBlocking(runDir: string): readonly string[] {
  const ids: string[] = [];
  for (const phase of QUESTION_PHASES) {
    ids.push(...blockingQuestionIds(join(runDir, phase, "questions.md")));
  }
  return ids;
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
 *
 * `tallyForStage` is how the `done $…` figure stops being a bare number. The
 * event carries `cost_usd` and nothing else, so this function had no way to know
 * that a stage's every turn was billed to a host session — and printed
 * `04-build/build … done $0.00` over nine stories, on the loop's own stdout,
 * which is the surface an operator watches. `notifyFresh` above already routes
 * the same event through `tallyOf`/`spentFigure`; this is the other half of that
 * fix, and it reads the same run.yml. Exported for the test that pins the two
 * shapes without a loop around it.
 */
export function stageLines(
  fresh: readonly TldrxEvent[],
  cursorBefore: string,
  outcome: NextOutcome,
  tallyForStage: (stageId: string) => { unmetered: number; metered: number },
): readonly string[] {
  const lines: string[] = [];
  let requested: { at: string; stage: string; cost: number } | null = null;
  let done: { at: string; stage: string; cost: number } | null = null;
  let approvedBy: string | null = null;
  /**
   * The event's own `cost_usd` for the dollars — it is the number this line has
   * always printed — with the COUNTS from the run file beside it. When nothing on
   * the stage was unmetered the two counts make `spentFigure` return exactly the
   * `$X.XX` it returned before, so a fully metered stage's line is unchanged.
   */
  const figure = (row: { stage: string; cost: number }): string => {
    const counts = tallyForStage(row.stage);
    return spentFigure({ usd: row.cost, unmetered: counts.unmetered, metered: counts.metered });
  };

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
        requested = { at, stage: event.stage ?? "", cost: number(payload(event, "cost_usd")) };
        break;
      case "gate.approved":
        approvedBy = String(payload(event, "by") ?? event.actor);
        break;
      case "stage.done":
        done = { at, stage: event.stage ?? "", cost: number(payload(event, "cost_usd")) };
        break;
      default:
        break;
    }
  }

  if (requested !== null) {
    lines.push(`${requested.at} … done ${figure(requested)}`
      + (approvedBy === AUTO_GATE_ACTOR ? " · auto-approved" : " · awaiting human gate"));
    return lines;
  }
  if (done !== null) {
    lines.push(`${done.at} … done ${figure(done)}`);
    return lines;
  }
  if (lines.length === 0) {
    // No stage event at all: awaiting an answer, a budget refusal, a stage already
    // parked at a gate before the loop started. `next`'s own first line says which.
    lines.push(`${cursorBefore} … ${outcome.lines[0] ?? "no progress"}`);
  }
  return lines;
}

/**
 * Why the engine's gate signer did NOT close this gate, straight off the
 * `agent.result` it recorded (gh #198).
 *
 * Read from the event rather than re-derived: the signer's turn already ran the
 * evaluator and wrote down what it concluded, and a loop that formed its own
 * second opinion here could tell an owner something the run's own log denies.
 * Empty when no signer ran this iteration — a `human` gate, or a resumed run whose
 * gate was already pending — and `gateNotification` says nothing rather than
 * claiming a signer looked.
 */
/** What one iteration's notifications produced: the gate figure, and any deferral. */
interface FreshNotified {
  /**
   * What the gate that just fell to a person cost, or null when this iteration raised
   * none — a loop that RESUMED a run already parked at a gate measured no figure, and
   * `gate.timeout` then says nothing about cost rather than saying $0.00.
   */
  readonly costUsd: number | null;
  /** The gate notification held back because the questions come first (gh #203). */
  readonly deferredGate: (() => Promise<void>) | null;
}

/**
 * The auto verdict `runNext` recorded on `gate.requested`, off the event itself.
 *
 * Read, never re-derived: `next` measured the seven conditions at the moment it handed
 * the gate over, and a loop that formed its own second opinion here could tell an
 * owner something the run's own log denies — which is the defect this pair of readers
 * exists to end. Absent keys mean the gate had no auto verdict behind it at all (a
 * `human` or `agent` policy), which is not the same as one that found nothing.
 */
function autoGateWhy(fresh: readonly TldrxEvent[]): { readonly why: string; readonly heldBy: readonly string[] } | null {
  for (let i = fresh.length - 1; i >= 0; i--) {
    const event = fresh[i];
    if (event === undefined || event.type !== "gate.requested") continue;
    const held = payload(event, "held_by");
    if (!Array.isArray(held)) return null;
    return {
      why: typeof payload(event, "why") === "string" ? String(payload(event, "why")) : "",
      heldBy: held.filter((id): id is string => typeof id === "string"),
    };
  }
  return null;
}

/** True when `questions` is the ONE condition holding an auto gate (gh #203). */
function onlyHeldByQuestions(fresh: readonly TldrxEvent[]): boolean {
  const verdict = autoGateWhy(fresh);
  return verdict !== null && verdict.heldBy.length === 1 && verdict.heldBy[0] === "questions";
}

/**
 * What held THIS gate, in one list, whichever mechanism measured it.
 *
 * An `agent` gate's reason comes from the engine signer's own `agent.result` (#198);
 * an `auto` gate's comes from the verdict `runNext` put on `gate.requested` (#203).
 * They never both exist — the signer only runs under the `agent` policy — so one
 * field carries both and `gateNotification` renders whichever arrived.
 */
function gateHeld(fresh: readonly TldrxEvent[]): readonly string[] {
  const auto = autoGateWhy(fresh);
  if (auto !== null && auto.why.trim() !== "") return [auto.why];
  return signerHeld(fresh);
}

function signerHeld(fresh: readonly TldrxEvent[]): readonly string[] {
  for (let i = fresh.length - 1; i >= 0; i--) {
    const event = fresh[i];
    if (event === undefined || event.type !== "agent.result") continue;
    if (payload(event, "role") !== GATE_SIGNER_ROLE) continue;
    const held = payload(event, "held");
    return Array.isArray(held) ? held.filter((line): line is string => typeof line === "string") : [];
  }
  return [];
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
