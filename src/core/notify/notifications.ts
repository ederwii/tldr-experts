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
import {
  answerCommand, approveCommand, continueCommand, rejectCommand,
} from "../run/decisionCards.ts";
import type { GatePolicy } from "../run/gatePolicy.ts";
import {
  continueNote, deliveredPhrase, gateStoriesPayload, type OutcomeLine, type StoriesView,
} from "../run/runOutcome.ts";
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
 * `question.auto_answered` — the loop took the asker's own recommendation (gh #251).
 *
 * It asks for nothing, so the summary is a REPORT: which question, which option, the
 * asker's reason, what was not taken, and the fact it became. The top-level `command`
 * is the one thing a person can do about it — reverse it, through the same door a
 * person's answer goes through — spelled with `--supersede` on the ONE
 * `answerCommand` every card and payload already uses, never a second spelling.
 */
export function questionAutoAnsweredNotification(ctx: NotifyContext, answered: AutoAnsweredView): NotifyPayload {
  const why = answered.pick.why === "" ? "" : ` — ${answered.pick.why}`;
  const alternatives = answered.pick.alternatives.length === 0
    ? "no other option was listed"
    : `not taken: ${answered.pick.alternatives.join("; ")}`;
  return {
    ...base(ctx, "question.auto_answered"),
    summary: `${ctx.runId} answered ${answered.q} · ${answered.title} itself at `
      + `${ctx.stage ?? "an unnamed stage"} (questions_policy: recommended): took `
      + `${answered.pick.letter}) ${answered.pick.text}${why}. Recorded as ${answered.fact}, `
      + `decided by agent-default, ${alternatives}. Nothing is waiting on you; `
      + "to reverse it, answer the question again with --supersede.",
    command: `${answerCommand(answered.q, ctx.runId)} --supersede`,
    detail: {
      question: { id: answered.q, title: answered.title, file: answered.file },
      pick: { letter: answered.pick.letter, text: answered.pick.text },
      alternatives: [...answered.pick.alternatives],
      why: answered.pick.why,
      fact: answered.fact,
      decided_by: "agent-default",
      supersede_command: `${answerCommand(answered.q, ctx.runId)} --supersede`,
    },
  };
}

/** What `questionAutoAnsweredNotification` needs — `autoAnswer.ts`'s `AutoAnswered`, as data. */
export interface AutoAnsweredView {
  readonly q: string;
  readonly title: string;
  readonly file: string;
  readonly pick: {
    readonly letter: string;
    readonly text: string;
    readonly alternatives: readonly string[];
    readonly why: string;
  };
  readonly fact: string;
}

/**
 * `a` or `an` for the phrase that follows. One helper rather than a literal at each
 * call site, because the article depends on the POLICY WORD and `auto` is the only
 * vowel among the four — which is how an owner's phone read "waiting at a auto gate"
 * for two releases (gh #203). It is a nit and it is also the first four words of the
 * only sentence the owner reads.
 */
function gateArticle(policy: GatePolicy | null): string {
  return policy === "auto" ? "an" : "a";
}

/**
 * WHICH gate is waiting, in the frozen policy's own words (gh #197, scope note).
 *
 * An owner who has just switched a stage to `gates_policy: agent` expecting the loop to
 * carry on needs to be told that it did not: `run auto` writes no evidence note, so an
 * `agent` gate stops it exactly as a `human` one does and waits for whoever signs.
 * Saying only "its gate" left him to infer which tap he was doing. (An `auto` gate is
 * the one the loop does close by itself, and by the time this phrase is sent it has
 * already failed to — see `selfCloseAutoGate` in `runAuto.ts`, gh #203.)
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
 * THE one mapping from "what is holding this run" to "the one command that clears it"
 * (gh #239), shared by `gate.requested` and the parked heartbeat.
 *
 * ## Why it is not `approve`
 *
 * Measured, an owner's phone, 2026-09-10: a gate held BY five unanswered questions went
 * out as `Run: tldrx approve --run <id>`, and the heartbeat repeated that line seven
 * times in an hour. The summary named the holding condition correctly (#203) and the
 * ACTION contradicted it. Two Build gates were approved by mistake that evening, both
 * over unbuilt stories, both revoked with `reject --stage` — *"creo que le di por
 * error"*. A notification exists to be obeyed off a lock screen, so the tap it offers
 * has to be the tap that helps.
 *
 * The order is the order in which a thing becomes answerable:
 *
 *  - **open blocking questions -> `answer`.** The gate is DOWNSTREAM of them; approving
 *    is the one thing that must not happen yet. The first id, for the reason
 *    `questionNotification` already gives: questions are answered one at a time and a
 *    payload has one `command` slot, and every id is in the detail.
 *  - **unfinished stories -> `run status`.** Not `reject`: nobody has decided to abandon
 *    that work, and a one-tap refusal is the mirror of the mistake being fixed. Not
 *    `null` either — a person whose run is parked needs somewhere to go, and what is
 *    missing here is knowledge, not a signature. `run status` is the screen that says
 *    which story stopped and why.
 *  - **nothing mechanical outstanding -> `approve`.** The gate really is waiting on a
 *    judgement, which is what this field always meant.
 *
 * `approve_command` and `reject_command` stay in the DETAIL of every payload either
 * way: a script that renders buttons keeps both, and nothing a consumer already reads
 * was taken away.
 */
function clearingCommand(
  runId: string,
  openQuestions: readonly string[],
  unfinishedStories: number,
): string {
  switch (gateHolding(openQuestions, unfinishedStories)) {
    case "questions":
      // Non-null by construction: `gateHolding` returns `questions` only when there is
      // a first id. The fallback exists so the narrowing is the compiler's, not a
      // comment's — and it can never be the string a reader sees.
      return answerCommand(openQuestions[0] ?? "", runId);
    case "stories":
      return `tldrx run status ${runId}`;
    default:
      return approveCommand(runId);
  }
}

/**
 * The NAME of the branch `clearingCommand` just took (gh #243).
 *
 * ## Why the tri-state has to travel as a field
 *
 * Measured, the owner's Slack adapter, 2026-09-11: a `gate.requested` renders two
 * buttons, Yes and No, and No rejects nothing — it logs "gate stays open". To do
 * better the adapter has to know WHICH gate this is, and today only one third of that
 * travels structured: `detail.stories` says there is unbuilt work, but "there are open
 * questions" is carried by nothing except the PREFIX of `command` (`tldrx answer …`).
 * So a consumer that wants a third button has to sniff a CLI string for a substring —
 * a second, untested, out-of-repo copy of the mapping right below, and one that goes
 * quietly wrong the day a command is reworded.
 *
 * This is that same mapping, named. It is not a second measurement and it must never
 * become one: `clearingCommand` switches on it, so `holding` and `command` are two
 * renderings of one branch and cannot disagree (§7). It makes exactly the claim
 * `command` already made and no stronger one — `none` means "the inputs this payload
 * was built from name nothing mechanical outstanding", which is why a caller that read
 * no questions gets the same answer it always got.
 */
export type GateHolding = "questions" | "stories" | "none";

function gateHolding(openQuestions: readonly string[], unfinishedStories: number): GateHolding {
  if (openQuestions[0] !== undefined) return "questions";
  if (unfinishedStories > 0) return "stories";
  return "none";
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
  /**
   * What the stage DELIVERED, for a Build gate (gh #210). Null for every other
   * stage and for a run with no plan, which leaves those notifications
   * byte-identical.
   *
   * It is the first clause of the summary — before the money — because the money
   * is what the two runs in #210 already said and the delivery is what they did
   * not. Measured: a `human` Build gate's whole payload was
   * `cost_usd: 1.78, outputs: [handoff], checks: [claim-sources:passed]` while
   * every story was blocked or todo, and it was approved from a phone.
   *
   * Passed IN, never derived here: this file words, it never measures (gh #197).
   */
  stories: StoriesView | null = null,
  /**
   * The run's OPEN blocking question ids (gh #239), read off disk by the caller
   * through `blockingQuestionIds` — the one predicate for "does this question park
   * a run". They pick the `command` (see `clearingCommand`); they are not worded
   * into the summary, which already carries `held`.
   *
   * SIXTH and last for the reason `stories` is fifth: every caller passes these
   * positionally. Empty is the honest default — a caller that did not read the
   * questions is not claiming there are none, it is claiming nothing, and the
   * mapping falls through to what it did before.
   */
  openQuestions: readonly string[] = [],
): NotifyPayload {
  const approve = approveCommand(ctx.runId);
  // `held` is what the engine's gate signer could not sign over (gh #198), in the
  // same words `tldrx next` prints. It goes in the SUMMARY and not only the detail
  // because the summary is the half that reaches a lock screen, and "an agent
  // looked at this and here is what stopped it" is the difference between a person
  // opening the run and a person opening the run to find out why.
  //
  // TWO provenances, one field. For an `agent` gate `held` is what the engine's own
  // signer wrote down (#198); for an `auto` gate it is the auto verdict's `why`,
  // carried on `gate.requested` since #203 — the run's own words, handed through, not
  // re-rendered here. A second spelling of "what held this gate" is exactly the drift
  // that left `verdict.why` on stdout and nothing on the phone.
  const why = held.length === 0
    ? ""
    : policy === "auto"
      ? ` It is held by: ${held.join("; ")}.`
      : ` The engine's signer held it: ${held.join("; ")}.`;
  // `It has 5 of 6 stories delivered` — the verb #239 found missing. `deliveredPhrase`
  // is a NOUN phrase and stays one: `runNext`, `ship` and the decision card all embed
  // it after a label (`stories: …`), and giving it a verb for this one caller's sake
  // would break the three that read best without it. So the article is fixed here, at
  // the only call site that needed a sentence.
  const delivered = stories === null ? "" : ` It has ${deliveredPhrase(stories)}.`;
  const holding = gateHolding(openQuestions, stories?.unfinished.length ?? 0);
  // The one-tap "send it back and carry on" (#243), offered ONLY where the gate can
  // say what has to change in its own words.
  //
  // Not on a gate held by open QUESTIONS: it is downstream of them, and a one-tap
  // refusal there is the mirror of the mistake #239 was filed over. Not on a gate
  // held by nothing mechanical either: that gate is waiting on a judgement, and the
  // reason to refuse a judgement is in a person's head, not on disk. And not even on
  // every gate held by stories — `continueNote` returns null when no story is blocked,
  // or when the blocked one's reason was never recorded, because `--note` is the next
  // turn's prompt (`reject.ts:107`) and a canned note would satisfy the flag while
  // emptying the rule it exists for (§7, absent-with-reason).
  //
  // Both keys travel together or neither does: a command whose hole nothing can fill
  // is a button that cannot be pressed.
  const note = holding === "stories" && stories !== null ? continueNote(stories) : null;
  return {
    ...base(ctx, "gate.requested"),
    summary: `${ctx.runId} finished ${ctx.stage ?? "a stage"} for $${costUsd.toFixed(2)} and is waiting `
      + `at ${gateArticle(policy)} ${gatePhrase(policy)}.${delivered}${why} Nothing runs after it until the gate is `
      + "approved or rejected.",
    command: clearingCommand(ctx.runId, openQuestions, stories?.unfinished.length ?? 0),
    detail: {
      cost_usd: costUsd,
      approve_command: approve,
      reject_command: rejectCommand(ctx.runId),
      ...(policy === null ? {} : { gate_policy: policy }),
      // The same numbers the event carries, so a `notify:` consumer never has to
      // read events.jsonl to learn what a gate is over. Absent for a non-Build
      // stage — a zeroed count would say a plan was read and found empty (§7).
      ...(stories === null ? {} : gateStoriesPayload(stories)),
      // What is holding this gate, as DATA. Always present on `gate.requested`: it is
      // the name of the branch `command` above was chosen by, so a payload carrying a
      // command but no holding would be hiding half of one fact.
      holding,
      // `…` is the placeholder the framework has always used for "the consumer fills
      // this in" (`answerCommand`); `continue_note` is what a one-tap button puts in
      // it, derived from the gate. A consumer that wants the owner to type instead
      // substitutes their text and ignores the note.
      ...(note === null ? {} : { continue_command: continueCommand(ctx.runId), continue_note: note }),
      // Absent, never `[]`, when no signer ran: an empty list would read as "the
      // signer found nothing wrong", which is the opposite of "no signer looked".
      ...(held.length === 0 ? {} : policy === "auto" ? { held_by: held } : { signer_held: held }),
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
  /**
   * A sentence the run owes the reader whatever else happened — today, exactly
   * one: uncommitted work this stage set aside and could not give back (#164).
   * `null` leaves the summary byte-identical to what it has always been.
   */
  note: string | null = null,
  /**
   * What the inputs budget cut for this stage (#207), already worded by
   * `run/truncations.ts`. A caveat on a moment already being announced rather
   * than a tenth `NotifyKind`: every adapter anyone has written already handles
   * `stage.done`, and none of them handle a kind invented today. `null` leaves
   * the summary byte-identical to what it has always been.
   */
  truncation: string | null = null,
): NotifyPayload {
  // A stage every one of whose turns was in-session cost this loop nothing it
  // could see, and "finished for $0.00" is the sentence that reads as thrift.
  // `spentFigure` is the same rule every other surface uses; `unmetered` is 0 on
  // an ordinary spawned stage, which keeps that sentence exactly as it was.
  const figure = spentFigure({ usd: costUsd, unmetered, metered: unmetered > 0 && costUsd === 0 ? 0 : 1 });
  return {
    ...base(ctx, "stage.done"),
    summary: `${ctx.runId} finished ${ctx.stage ?? "a stage"} for ${figure} and moved on. `
      + (note === null ? "No decision is waiting on you." : note)
      + (truncation === null ? "" : ` ${truncation}`),
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
  /** Same contract as `stageDoneNotification`'s: today only a failed restore. */
  note: string | null = null,
  /**
   * What the run DELIVERED, from `run.yml`'s `outcome:` (gh #210) — passed in by
   * the caller, which is the only thing that knows whether the run is actually
   * over. Null for a loop that stopped with the run still open, so a
   * `run.failed` mid-run is byte-identical to what it was.
   *
   * A run that delivered nothing must not reach a phone as `finished with exit 0`
   * and a dollar figure: that is exactly the sentence two real runs sent while
   * every story was blocked (#210).
   *
   * SEVENTH and not sixth: `note` (#164) landed first and its caller passes it
   * positionally, so a new parameter goes after it.
   */
  outcome: OutcomeLine | null = null,
  /**
   * Same contract as `stageDoneNotification`'s `truncation` (#207). EIGHTH, for
   * the reason `outcome` above is seventh: every parameter already here is passed
   * positionally by its caller, so a new one goes at the end.
   */
  truncation: string | null = null,
  /**
   * What `tldrx ship` did when the run closed under this loop (gh #253) — the
   * run.yml `ship:` record. NINTH, for the reason the two before it give. Null on
   * every run without a `ship:` block, which leaves the payload byte-identical.
   */
  ship: ShipRecordLine | null = null,
): NotifyPayload {
  const kind: NotifyKind = exitCode === 0 ? "run.finished" : "run.failed";
  const verb = exitCode === 0 ? "finished" : "stopped";
  const delivered = outcome === null ? "" : ` The run: ${outcome.text}.`;
  const shipped = ship === null ? "" : ` ${shipSentence(ship)}`;
  return {
    ...base(ctx, kind),
    summary: `${ctx.runId}: the loop ${verb} with exit ${String(exitCode)} `
      + `(${exitFamily(exitCode)}), ${spentFigure(tally)} spent by this loop.${delivered} ${lastLine}`
      + `${note === null ? "" : ` ${note}`}`
      + `${truncation === null ? "" : ` ${truncation}`}`
      + shipped,
    command: exitCode === 0 ? null : `tldrx run status ${ctx.runId}`,
    detail: {
      exit_code: exitCode,
      exit_family: exitFamily(exitCode),
      spent_usd: spentUsd,
      unmetered_tasks: tally.unmetered,
      spent_basis: spentBasis(tally.unmetered),
      // Absent while the run is still open: `outcome: "not-recorded"` on a loop
      // that merely stopped would claim the run had ended without one (§7).
      ...(outcome === null ? {} : { outcome: outcome.kind, outcome_detail: outcome.text }),
      // Only on a run that carried a `ship:` block. `pr_url` is the ONE url when
      // there is exactly one — the common case, and the field the issue asks for;
      // `pr_urls` is always the list, so a multi-repo run is not reduced to a guess.
      ...(ship === null ? {} : {
        ...(ship.pr_urls.length === 1 ? { pr_url: ship.pr_urls[0] } : {}),
        pr_urls: ship.pr_urls,
        merge: ship.merge,
      }),
    },
  };
}

/** The `ship:` record as the payload reads it — `run.yml`'s `RunShip`, with the optional halves resolved. */
export interface ShipRecordLine {
  readonly pr_urls: readonly string[];
  readonly merge: string;
}

function shipSentence(ship: ShipRecordLine): string {
  const urls = ship.pr_urls.length === 0 ? "no PR was opened" : `PR: ${ship.pr_urls.join(", ")}`;
  return `Shipped — ${urls}; merge: ${ship.merge}.`;
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
  /** Same contract as `stageDoneNotification`'s `truncation` (#207). */
  truncation: string | null = null,
  /**
   * What the PENDING gate is over, for a Build gate (gh #239) — the same
   * `gateStories` view `gate.requested` is built from, passed in by the caller,
   * never re-derived here. It picks the `command` and nothing else: the heartbeat's
   * summary is `run status`'s own text and does not grow a sentence.
   *
   * Null, not an empty view, when no gate is pending or the gate is not a Build one
   * — "no stories were looked at" is not "no story is unfinished", and it was the
   * hard-wired zero here that kept offering `approve` at a gate held by unbuilt
   * work.
   */
  stories: StoriesView | null = null,
): NotifyPayload {
  const ids = [...waitingOn];
  const parked = ids.length > 0;
  const gateSummary = waitingOnGate === null
    ? ""
    : `${ctx.runId} is parked at ${waitingOnGate.stage} waiting for a person to SIGN it: `
      + `${gatePhrase(waitingOnGate.policy)}. Nothing runs after it and nothing is being spent `
      + "while it waits."
      + (parked ? ` It also has ${String(ids.length)} open question(s): ${ids.join(", ")}.` : "");
  const tail = truncation === null ? "" : ` ${truncation}`;
  return {
    ...base(ctx, "status"),
    summary: (waitingOnGate !== null
      ? gateSummary
      : parked
        ? `${ctx.runId} is parked at ${ctx.stage ?? "an unnamed stage"} waiting on YOU: `
          + `${String(ids.length)} open question(s), ${ids.join(", ")}. Nothing is being spent `
          + "while it waits, and it resumes the moment one is answered."
        : `${ctx.runId} is still running at ${ctx.stage ?? "an unnamed stage"}. `
          + "Nothing is waiting on you — this is the periodic heartbeat `--notify-every` asked for.") + tail,
    // The literal line to type, exactly as `question.raised` and `gate.requested` spelled it
    // — a reminder that made the reader go and find the command would be a reminder to go and
    // look at a screen. A pending gate wins the one slot over a run that is merely running:
    // it is the thing that has stopped the loop.
    //
    // But a gate held over OPEN QUESTIONS does not win it against those questions (gh #239):
    // this heartbeat is the surface that repeated `tldrx approve` seven times in an hour at a
    // gate whose five questions nobody had answered. `clearingCommand` is the same mapping
    // `gate.requested` uses — one implementation, so the alert and its reminder can never
    // offer two different taps for the same parked run (§7).
    command: waitingOnGate !== null || parked
      ? clearingCommand(ctx.runId, ids, stories?.unfinished.length ?? 0)
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
