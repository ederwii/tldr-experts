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
import { NOTIFY_PAYLOAD_VERSION, exitFamily, type NotifyKind, type NotifyPayload } from "./payload.ts";

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

/** `gate.requested` — a stage finished and a person has to sign it. */
export function gateNotification(ctx: NotifyContext, costUsd: number): NotifyPayload {
  const approve = `tldrx approve --run ${ctx.runId}`;
  return {
    ...base(ctx, "gate.requested"),
    summary: `${ctx.runId} finished ${ctx.stage ?? "a stage"} for $${costUsd.toFixed(2)} and is waiting `
      + "for a person to sign its gate. Nothing runs after it until the gate is approved or rejected.",
    command: approve,
    detail: {
      cost_usd: costUsd,
      approve_command: approve,
      reject_command: `tldrx reject --run ${ctx.runId} --note "<why>"`,
    },
  };
}

/**
 * `stage.done` — a report, and the one kind whose `command` is honestly null.
 *
 * There is nothing for a person to type: the loop is already running the next stage.
 */
export function stageDoneNotification(ctx: NotifyContext, costUsd: number): NotifyPayload {
  return {
    ...base(ctx, "stage.done"),
    summary: `${ctx.runId} finished ${ctx.stage ?? "a stage"} for $${costUsd.toFixed(2)} and moved on. `
      + "No decision is waiting on you.",
    command: null,
    detail: { cost_usd: costUsd },
  };
}

/** `budget.warned` — a ceiling is close, said with both numbers. */
export function budgetNotification(
  ctx: NotifyContext,
  spentUsd: number,
  ceilingUsd: number,
): NotifyPayload {
  return {
    ...base(ctx, "budget.warned"),
    summary: `${ctx.runId} has spent $${spentUsd.toFixed(2)} of its $${ceilingUsd.toFixed(2)} ceiling. `
      + "It has not been refused anything yet; the next stage that would cross the ceiling is.",
    command: `tldrx budget show --run ${ctx.runId}`,
    detail: { spent_usd: spentUsd, ceiling_usd: ceilingUsd },
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
): NotifyPayload {
  const kind: NotifyKind = exitCode === 0 ? "run.finished" : "run.failed";
  const verb = exitCode === 0 ? "finished" : "stopped";
  return {
    ...base(ctx, kind),
    summary: `${ctx.runId}: the loop ${verb} with exit ${String(exitCode)} `
      + `(${exitFamily(exitCode)}), $${spentUsd.toFixed(2)} spent by this loop. ${lastLine}`,
    command: exitCode === 0 ? null : `tldrx run status ${ctx.runId}`,
    detail: { exit_code: exitCode, exit_family: exitFamily(exitCode), spent_usd: spentUsd },
  };
}

/**
 * `status` — the periodic heartbeat `--notify-every` asks for.
 *
 * `statusText` is what `tldrx run status` prints, verbatim and unabridged. A summary of a
 * summary would be this file inventing a view of the run that no command can reproduce.
 */
export function statusNotification(ctx: NotifyContext, statusText: string): NotifyPayload {
  return {
    ...base(ctx, "status"),
    summary: `${ctx.runId} is still running at ${ctx.stage ?? "an unnamed stage"}. `
      + "Nothing is waiting on you — this is the periodic heartbeat `--notify-every` asked for.",
    command: `tldrx run status ${ctx.runId}`,
    detail: { status_text: statusText },
  };
}
