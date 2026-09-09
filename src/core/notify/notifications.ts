/**
 * Turning what a run just did into the payload a person reads on a phone.
 *
 * Every function here takes DATA and returns a payload — no `RunStore`, no session, no
 * `ctx` (the rule that came out of the wave-2 decomposition, AGENTS.md §12). The loop owns
 * the reading; this file owns the wording.
 *
 * Nothing here DERIVES anything twice. The questions, their options and their
 * recommendation come from `decisionCards.ts` — the same card `--gate-agent` prints, so a
 * notification and a terminal can never disagree about what was asked. The status text is
 * `renderStatus` — the same string `tldrx run status` prints. The exit families are
 * `exitFamily` in `payload.ts`. If a sentence here had to invent a fact about the run, it
 * would be the wrong place to put it.
 */
import type { DecisionCard } from "../ui/decisionCard.ts";
// The one spelling of `tldrx answer <Qid> "…" --run <id>`, shared with every decision card.
import { answerCommand, approveCommand, rejectCommand } from "../run/decisionCards.ts";
import type { GatePolicy } from "../run/gatePolicy.ts";
import { NOTIFY_PAYLOAD_VERSION, exitFamily, type NotifyKind, type NotifyPayload } from "./payload.ts";
import { spentBasis, spentFigure, type SpentTally } from "../budget/spentFigure.ts";

/** What every payload shares, gathered once by the caller. */
export interface NotifyContext {
  readonly runId: string;
  readonly root: string;
  /** RFC3339 for the payload's `at`. */
  readonly at: string;
  /** `<phase>/<stage>`, or null. */
  readonly stage: string | null;
}

function base(ctx: NotifyContext, kind: NotifyKind): Omit<NotifyPayload, "summary" | "command" | "detail"> {
  return {
    version: NOTIFY_PAYLOAD_VERSION,
    kind,
    at: ctx.at,
    run: ctx.runId,
    root: ctx.root,
    stage: ctx.stage,
  };
}

/**
 * `question.raised` — the one notification the whole feature was measured for.
 *
 * The summary names the run, where it stopped and every open question by id and title,
 * because that is what has to survive being read on a lock screen. The top-level
 * `command` is the FIRST question's answer command; the per-question commands are all
 * there in `detail.questions`. Picking the first is not a judgement about importance —
 * questions are answered one at a time and a payload has one `command` slot; the detail
 * is where a script that wants to render buttons for all of them looks.
 */
export function questionNotification(ctx: NotifyContext, card: DecisionCard): NotifyPayload {
  const questions = card.questions.map((question) => ({
    id: question.id,
    title: question.title,
    why_asked: question.whyAsked,
    // `{letter, text}`, not the rendered `A) …` line: an owner's script builds buttons out
    // of the letters, and re-parsing a string the framework had already parsed would be a
    // second implementation of the §2.7 option grammar living in somebody's shell script.
    options: question.options.map((option) => ({ letter: option.letter, text: option.text })),
    recommendation: question.recommendation === null ? null : {
      option: question.recommendation.option,
      why: question.recommendation.why,
      src: question.recommendation.src,
    },
    answer_command: question.answerCommand,
  }));
  const titles = questions.map((q) => `${q.id} · ${q.title}`).join("; ");
  return {
    ...base(ctx, "question.raised"),
    summary: `${ctx.runId} stopped at ${ctx.stage ?? "an unnamed stage"} on `
      + `${String(questions.length)} open question(s): ${titles}. `
      + "The run is parked until one is answered; nothing is being spent while it waits.",
    command: questions[0]?.answer_command ?? null,
    detail: { questions },
  };
}

/**
 * `question.timeout` — `--wait-answers` lapsed and the loop is about to exit 4.
 *
 * A separate kind rather than a second `question.raised`, because the two say different
 * things to a person: one is "you are needed", the other is "you were needed and the loop
 * has stopped waiting". A script that only wants to escalate the second can.
 */
export function questionTimeoutNotification(
  ctx: NotifyContext,
  card: DecisionCard,
  waitedMs: number,
): NotifyPayload {
  const raised = questionNotification(ctx, card);
  const ids = card.questions.map((q) => q.id).join(", ");
  return {
    ...raised,
    kind: "question.timeout",
    summary: `${ctx.runId} waited ${String(Math.round(waitedMs / 1000))}s for an answer to ${ids} and `
      + "none arrived, so the loop stopped with exit 4. Answer it and start the loop again — "
      + "nothing was lost and nothing was spent while it waited.",
    detail: { ...raised.detail, waited_ms: waitedMs },
  };
}

/**
 * WHICH gate is waiting, in the frozen policy's own words (gh #197, scope note).
 *
 * An owner who has just switched a stage to `gates_policy: agent` expecting the loop to
 * carry on needs to be told that it did not: there is no engine-side signing in
 * `run auto`, so an `agent` gate stops it exactly as a `human` one does and waits for
 * whoever signs. Saying only "its gate" left him to infer which tap he was doing.
 *
 * The policy comes from `gatePolicyFor` — the run's own frozen map, read by the caller —
 * never from a guess about what the workflow says today.
 */
function gatePhrase(policy: GatePolicy | null): string {
  switch (policy) {
    case "human":
      return "human gate — a person signs it";
    case "agent":
      return "agent gate — an agent may sign it over an evidence note, or a person may approve it "
        + "(that is a recorded override, not a workaround)";
    case "auto":
      return "auto gate that did not close by itself — a person signs it";
    default:
      return "gate";
  }
}

/**
 * `gate.requested` — a stage finished and a person has to sign it.
 *
 * `policy` is nullable rather than defaulted: a loop that could not read the run's
 * `gates_policy` says "gate" instead of naming a policy it did not measure.
 */
export function gateNotification(
  ctx: NotifyContext,
  costUsd: number,
  policy: GatePolicy | null = null,
  held: readonly string[] = [],
): NotifyPayload {
  const approve = approveCommand(ctx.runId);
  // `held` is what the engine's gate signer could not sign over (gh #198), in the
  // same words `tldrx next` prints. It goes in the SUMMARY and not only the detail
  // because the summary is the half that reaches a lock screen, and "an agent
  // looked at this and here is what stopped it" is the difference between a person
  // opening the run and a person opening the run to find out why.
  const why = held.length === 0 ? "" : ` The engine's signer held it: ${held.join("; ")}.`;
  return {
    ...base(ctx, "gate.requested"),
    summary: `${ctx.runId} finished ${ctx.stage ?? "a stage"} for $${costUsd.toFixed(2)} and is waiting `
      + `at a ${gatePhrase(policy)}.${why} Nothing runs after it until the gate is approved or rejected.`,
    command: approve,
    detail: {
      cost_usd: costUsd,
      approve_command: approve,
      reject_command: rejectCommand(ctx.runId),
      ...(policy === null ? {} : { gate_policy: policy }),
      // Absent, never `[]`, when no signer ran: an empty list would read as "the
      // signer found nothing wrong", which is the opposite of "no signer looked".
      ...(held.length === 0 ? {} : { signer_held: held }),
    },
  };
}

/**
 * `gate.timeout` — `--wait-gates` lapsed and the loop is about to exit 4.
 *
 * `question.timeout`'s twin, and a separate kind for the same reason: "you are needed"
 * and "you were needed and the loop has stopped waiting" are two different things to
 * read on a phone, and a script that only escalates the second can.
 *
 * `costUsd` is nullable and ABSENT from the detail when it is null, rather than `0`: a
 * loop that resumed a run already parked at a gate never saw the `gate.requested` event
 * that carries the figure, and a confident zero there would report a stage that cost
 * money as free (AGENTS.md §7, absent-with-reason).
 */
export function gateTimeoutNotification(
  ctx: NotifyContext,
  costUsd: number | null,
  waitedMs: number,
  policy: GatePolicy | null = null,
): NotifyPayload {
  const approve = approveCommand(ctx.runId);
  return {
    ...base(ctx, "gate.timeout"),
    summary: `${ctx.runId} waited ${String(Math.round(waitedMs / 1000))}s for a signature on the `
      + `${gatePhrase(policy)} at ${ctx.stage ?? "an unnamed stage"} and none arrived, so the loop `
      + "stopped with exit 4. Approve or reject it and start the loop again — nothing was lost and "
      + "nothing was spent while it waited.",
    command: approve,
    detail: {
      ...(costUsd === null ? {} : { cost_usd: costUsd }),
      approve_command: approve,
      reject_command: rejectCommand(ctx.runId),
      ...(policy === null ? {} : { gate_policy: policy }),
      waited_ms: waitedMs,
    },
  };
}

/**
 * `stage.done` — a report, and the one kind whose `command` is honestly null.
 *
 * There is nothing for a person to type: the loop is already running the next stage.
 */
export function stageDoneNotification(
  ctx: NotifyContext,
  costUsd: number,
  unmetered = 0,
): NotifyPayload {
  // A stage every one of whose turns was in-session cost this loop nothing it
  // could see, and "finished for $0.00" is the sentence that reads as thrift.
  // `spentFigure` is the same rule every other surface uses; `unmetered` is 0 on
  // an ordinary spawned stage, which keeps that sentence exactly as it was.
  const figure = spentFigure({ usd: costUsd, unmetered, metered: unmetered > 0 && costUsd === 0 ? 0 : 1 });
  return {
    ...base(ctx, "stage.done"),
    summary: `${ctx.runId} finished ${ctx.stage ?? "a stage"} for ${figure} and moved on. `
      + "No decision is waiting on you.",
    command: null,
    detail: { cost_usd: costUsd, ...(unmetered === 0 ? {} : { unmetered_tasks: unmetered }) },
  };
}

/** `budget.warned` — a ceiling is close, said with both numbers. */
export function budgetNotification(
  ctx: NotifyContext,
  spentUsd: number,
  ceilingUsd: number,
  tally: SpentTally = { usd: spentUsd, unmetered: 0, metered: 1 },
): NotifyPayload {
  return {
    ...base(ctx, "budget.warned"),
    // The figure carries its basis (`budget/spentFigure.ts`). A notification is
    // read once, on a phone, by somebody who is not going to open `budget show`
    // — it is the LAST surface that can afford a bare `$0.00`.
    summary: `${ctx.runId} has spent ${spentFigure(tally)} of its $${ceilingUsd.toFixed(2)} ceiling. `
      + "It has not been refused anything yet; the next stage that would cross the ceiling is.",
    command: `tldrx budget show --run ${ctx.runId}`,
    // `spent_usd` keeps its meaning and its type — a consumer parsing this
    // number must not have to parse a sentence. The two counts beside it are
    // additive and say what the number cannot see.
    detail: {
      spent_usd: spentUsd,
      ceiling_usd: ceilingUsd,
      unmetered_tasks: tally.unmetered,
      spent_basis: spentBasis(tally.unmetered),
    },
  };
}

/**
 * `run.finished` / `run.failed` — where the loop stopped, in the exit code's own family.
 *
 * `run.failed` is every non-zero exit, including the refusals: from the far end of a
 * notification, "the loop is no longer running and did not finish the run" is one fact,
 * and `detail.exit_code` with its family is what separates a money refusal from a crash.
 */
export function runEndNotification(
  ctx: NotifyContext,
  exitCode: number,
  spentUsd: number,
  lastLine: string,
  tally: SpentTally = { usd: spentUsd, unmetered: 0, metered: 1 },
): NotifyPayload {
  const kind: NotifyKind = exitCode === 0 ? "run.finished" : "run.failed";
  const verb = exitCode === 0 ? "finished" : "stopped";
  return {
    ...base(ctx, kind),
    summary: `${ctx.runId}: the loop ${verb} with exit ${String(exitCode)} `
      + `(${exitFamily(exitCode)}), ${spentFigure(tally)} spent by this loop. ${lastLine}`,
    command: exitCode === 0 ? null : `tldrx run status ${ctx.runId}`,
    detail: {
      exit_code: exitCode,
      exit_family: exitFamily(exitCode),
      spent_usd: spentUsd,
      unmetered_tasks: tally.unmetered,
      spent_basis: spentBasis(tally.unmetered),
    },
  };
}

/**
 * The gate a heartbeat has to name: where it is, and who the run's frozen policy says
 * may sign it. Both are read by the caller off `run.yml` — this file words, it never
 * derives (gh #197).
 */
export interface WaitingGate {
  /** `<phase>/<stage>`, the same spelling the payload's own `stage` field uses. */
  readonly stage: string;
  readonly policy: GatePolicy | null;
}

/**
 * `status` — the periodic heartbeat `--notify-every` asks for.
 *
 * `statusText` is what `tldrx run status` prints, verbatim and unabridged. A summary of a
 * summary would be this file inventing a view of the run that no command can reproduce.
 *
 * ## Why it has to know whether the run is parked
 *
 * Reproduced in review, 2026-09-07: with `--notify-every` and `--wait-answers` both on, a
 * `question.raised` went out and then the heartbeat kept telling the same person "Nothing is
 * waiting on you" every interval, while the run sat parked on their answer. That is false
 * reassurance aimed at exactly the person this whole feature exists to reach — worse than
 * silence, because a heartbeat is believed.
 *
 * So a heartbeat over a parked run REMINDS instead: it names the open questions, repeats the
 * literal answer command, and lists the ids in `detail.waiting_on`. Silence was the other
 * option and it is the weaker one — the reminder is the notification a waiting owner wants.
 *
 * The same hole existed at a GATE and cost the same person the same evening (gh #197): a
 * run parked on a signature got `waiting_on: []` and the identical "Nothing is waiting on
 * you". `waitingOnGate` closes it, and it too is passed IN — from `waitingFor`, the one
 * derivation `tldrx run status` and the dashboard already share.
 *
 * `waitingOn` is passed IN, from the caller's `blockingQuestionIds` — the one predicate for
 * "does this question park a run", shared with `runNext`, `skip_if` and `--wait-answers`.
 * A second opinion about parked-ness here is exactly the drift that would put the heartbeat
 * back out of step with the interrupt.
 */
export function statusNotification(
  ctx: NotifyContext,
  statusText: string,
  waitingOn: readonly string[] = [],
  waitingOnGate: WaitingGate | null = null,
): NotifyPayload {
  const ids = [...waitingOn];
  const parked = ids.length > 0;
  const gateSummary = waitingOnGate === null
    ? ""
    : `${ctx.runId} is parked at ${waitingOnGate.stage} waiting for a person to SIGN it: `
      + `${gatePhrase(waitingOnGate.policy)}. Nothing runs after it and nothing is being spent `
      + "while it waits."
      + (parked ? ` It also has ${String(ids.length)} open question(s): ${ids.join(", ")}.` : "");
  return {
    ...base(ctx, "status"),
    summary: waitingOnGate !== null
      ? gateSummary
      : parked
        ? `${ctx.runId} is parked at ${ctx.stage ?? "an unnamed stage"} waiting on YOU: `
          + `${String(ids.length)} open question(s), ${ids.join(", ")}. Nothing is being spent `
          + "while it waits, and it resumes the moment one is answered."
        : `${ctx.runId} is still running at ${ctx.stage ?? "an unnamed stage"}. `
          + "Nothing is waiting on you — this is the periodic heartbeat `--notify-every` asked for.",
    // The literal line to type, exactly as `question.raised` and `gate.requested` spelled it
    // — a reminder that made the reader go and find the command would be a reminder to go and
    // look at a screen. A pending gate wins the one slot: it is the thing that has stopped
    // the loop, and its verb is not `answer`.
    command: waitingOnGate !== null
      ? approveCommand(ctx.runId)
      : parked
        ? answerCommand(ids[0] ?? "Q1", ctx.runId)
        : `tldrx run status ${ctx.runId}`,
    detail: {
      status_text: statusText,
      waiting_on: ids,
      // A SIBLING key, not a member of `waiting_on` (gh #197). `waiting_on` is a list of
      // question ids and an owner's adapter maps each one to `tldrx answer <id>`; folding
      // `01-what/alpha` into it would make that adapter build a command nobody can type.
      // Absent — not `null` — when no gate is pending, so a heartbeat over an unparked run
      // is byte-identical to the one it sent before this existed.
      ...(waitingOnGate === null ? {} : { waiting_on_gate: waitingOnGate.stage, gate_policy: waitingOnGate.policy }),
    },
  };
}
