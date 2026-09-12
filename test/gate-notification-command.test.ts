/**
 * The one command a parked run hands an owner must be the one that CLEARS it (gh #239).
 *
 * ## What was measured
 *
 * tldrx 0.16.0, an owner's phone, 2026-09-10: a gate held BY five unanswered
 * questions was announced with `Run: tldrx approve --run <id>` and the heartbeat
 * repeated that same line seven times in an hour. The sentence named the holding
 * condition correctly (#203) and the ACTION contradicted it — `approve` is the one
 * thing that must not happen while the questions the gate is downstream of are open.
 * Outcome: two Build gates approved by mistake in one evening, both over unbuilt
 * stories, both revoked with `reject --stage`.
 *
 * So `command` follows the holding condition, in ONE mapping shared by the gate
 * notification and the parked heartbeat (§7 — a second opinion about "what clears
 * this gate" is how the two surfaces would drift apart again):
 *
 *  - open blocking questions  -> `tldrx answer <first id> …`
 *  - unfinished stories       -> `tldrx run status <id>` (look before you sign)
 *  - nothing outstanding      -> `tldrx approve …`, as it always was
 *
 * `approve_command` and `reject_command` stay in the DETAIL on every one of them: a
 * script that renders buttons still has both, and nothing a consumer already reads
 * was taken away.
 *
 * These are unit tests over the wording layer on purpose — it takes DATA (§12), so
 * the whole mapping is reachable without spawning anything.
 */
import { describe, expect, test } from "bun:test";
import { gateNotification, statusNotification } from "../src/core/notify/notifications.ts";
import {
  answerCommand, approveCommand, continueCommand, rejectCommand,
} from "../src/core/run/decisionCards.ts";
import {
  continueNote, deliveredPhrase, REASON_NOT_RECORDED, type StoriesView,
} from "../src/core/run/runOutcome.ts";
import type { NotifyContext } from "../src/core/notify/notifications.ts";

const RUN = "260910-checkout";

const ctx: NotifyContext = {
  runId: RUN,
  root: "/w",
  at: "2026-09-10T17:18:00Z",
  stage: "01-what/what",
};

/** Five of six delivered, one blocked — the shape #210 put in the summary. */
function stories(done: number, total: number): StoriesView {
  const blocked = { id: "S6", status: "blocked", reason: "dotnet test exited 2" };
  const unfinished = done === total ? [] : [blocked];
  return {
    counts: { total, done, in_progress: 0, review: 0, blocked: unfinished.length, todo: 0 },
    unfinished,
    firstBlocked: unfinished.length === 0 ? null : blocked,
  };
}

describe("the gate notification's command follows what is holding the gate (#239)", () => {
  test("open questions hand over `answer`, never `approve`", () => {
    const payload = gateNotification(
      ctx, 1.78, "auto", ["questions=5 open (Q1, Q2, Q3, Q4, Q5)"], null, ["Q1", "Q2", "Q3", "Q4", "Q5"],
    );

    expect(payload.command).toBe(answerCommand("Q1", RUN));
    expect(payload.command).not.toBe(approveCommand(RUN));
    // Nothing a consumer already read was taken away.
    expect(payload.detail.approve_command).toBe(approveCommand(RUN));
    expect(payload.detail.reject_command).toBe(rejectCommand(RUN));
  });

  test("a Build gate over unfinished stories hands over `run status`, never `approve`", () => {
    const view = stories(5, 6);

    const payload = gateNotification(ctx, 1.78, "human", [], view);

    expect(payload.command).toBe(`tldrx run status ${RUN}`);
    expect(payload.command).not.toBe(approveCommand(RUN));
    expect(payload.detail.approve_command).toBe(approveCommand(RUN));
  });

  test("with nothing mechanical outstanding it is still `approve`", () => {
    const payload = gateNotification(ctx, 1.78, "human", [], stories(6, 6));

    expect(payload.command).toBe(approveCommand(RUN));
  });

  test("the summary has a verb: `It has 5 of 6 stories delivered`, not `It 5 of 6`", () => {
    const view = stories(5, 6);

    const summary = gateNotification(ctx, 1.78, "human", [], view).summary;

    // Asserted against the EXPORTED builder, not against English prose (§8).
    expect(summary).toContain(`It has ${deliveredPhrase(view)}.`);
    expect(summary).not.toContain(`It ${deliveredPhrase(view)}`);
  });
});

describe("the parked heartbeat repeats the same command (#239)", () => {
  test("a gate WITH open questions repeats `answer`", () => {
    const beat = statusNotification(
      ctx, "status text", ["Q1", "Q2", "Q3"], { stage: "01-what/what", policy: "auto" },
    );

    expect(beat.command).toBe(answerCommand("Q1", RUN));
    expect(beat.command).not.toBe(approveCommand(RUN));
    // The sentence #203 won is untouched.
    expect(beat.summary).toContain("It also has 3 open question(s): Q1, Q2, Q3.");
  });

  test("a Build gate over unfinished stories and NO open questions repeats `run status`", () => {
    // The case the issue was actually filed over, and the one a first fix missed: the
    // owner's two mistaken approvals were at a Build gate held by unbuilt stories with
    // no question open at all, while this heartbeat repeated `approve` every ten
    // minutes. A heartbeat that hands over a command the alert would not is the same
    // defect one surface along.
    const beat = statusNotification(
      ctx, "status text", [], { stage: "04-build/build", policy: "auto" }, null, stories(5, 6),
    );

    expect(beat.command).toBe(`tldrx run status ${RUN}`);
    expect(beat.command).not.toBe(approveCommand(RUN));
  });

  test("open questions still win over unfinished stories, on the heartbeat too", () => {
    const beat = statusNotification(
      ctx, "status text", ["Q7"], { stage: "04-build/build", policy: "auto" }, null, stories(5, 6),
    );

    expect(beat.command).toBe(answerCommand("Q7", RUN));
  });

  test("a gate with nothing open still repeats `approve` (guard, passed before the fix)", () => {
    const beat = statusNotification(ctx, "status text", [], { stage: "01-what/what", policy: "human" });

    expect(beat.command).toBe(approveCommand(RUN));
  });
});

/**
 * The holding condition travels as DATA, and a rejection that carries on is a command
 * the framework spells (gh #243).
 *
 * ## What was measured
 *
 * tldrx 0.16.1, the owner's Slack adapter, 2026-09-11: a `gate.requested` renders exactly
 * two buttons, Yes and No, and the No branch logs `gate stays open` and rejects nothing.
 * The adapter cannot do better with what it is handed: "there are unfinished stories"
 * travels structured (`detail.stories`), "there are open questions" does not travel at
 * all — the only thing that betrays it is the PREFIX of `payload.command` — and there is
 * no executable reject-and-continue line anywhere in the payload (`reject_command` spells
 * `--note "<why>"`, which is prose for a human, not the `…` the adapter substitutes).
 *
 * So the tri-state #239 already computes is NAMED in the detail instead of being sniffed
 * off a string, and the `--and-continue` rejection #242 added is spelled by the one file
 * that spells `approve` and `reject`.
 *
 * The second half is the half that makes this a proof and not a guard: the command and
 * its note are ABSENT whenever the gate has no reason of its own to put in `--note`
 * (§7). A `continue_command` on every gate would say "you may always carry on", and a
 * canned note would satisfy the flag `reject.ts:43` requires while emptying the rule it
 * exists for — the note is the next turn's prompt (`reject.ts:107`).
 */
describe("the gate payload names what holds it and how to send it back (#243)", () => {
  test("a Build gate over a blocked story names `stories` and spells reject --and-continue", () => {
    const view = stories(5, 6);

    const payload = gateNotification(ctx, 1.78, "human", [], view);

    expect(payload.detail.holding).toBe("stories");
    expect(payload.detail.continue_command).toBe(continueCommand(RUN));
    // The note is DERIVED from the gate — the blocked story and the handoff's own
    // reason, the same two keys `blocked_story`/`blocked_reason` already carry.
    expect(payload.detail.continue_note).toBe(continueNote(view));
    expect(payload.detail.continue_note).toContain("S6");
    expect(payload.detail.continue_note).toContain("dotnet test exited 2");
  });

  test("open questions name `questions`, and offer no way to carry on", () => {
    const payload = gateNotification(ctx, 1.78, "auto", [], stories(5, 6), ["Q1", "Q2"]);

    expect(payload.detail.holding).toBe("questions");
    // Downstream of the questions: the tap is `answer`, and a rejection here would be
    // the one-tap refusal #239 was filed over.
    expect(payload.detail).not.toHaveProperty("continue_command");
    expect(payload.detail).not.toHaveProperty("continue_note");
  });

  test("with nothing outstanding it names `none` and the keys are ABSENT, not empty", () => {
    const payload = gateNotification(ctx, 1.78, "human", [], stories(6, 6));

    expect(payload.detail.holding).toBe("none");
    expect(payload.detail).not.toHaveProperty("continue_command");
    expect(payload.detail).not.toHaveProperty("continue_note");
    expect(Object.keys(payload.detail)).not.toContain("continue_command");
  });

  test("a non-Build gate names `none` — no plan was read, so no story is unfinished", () => {
    const payload = gateNotification(ctx, 1.78, "human", [], null);

    expect(payload.detail.holding).toBe("none");
    expect(payload.detail).not.toHaveProperty("continue_command");
  });

  test("unfinished but nothing BLOCKED: `stories`, and still no continue — the gate has no reason to send", () => {
    // Every story merely `todo`. The gate is held, and the framework knows WHY it is
    // held no better than "not started" — which is not an instruction for the next
    // turn. Absent-with-reason beats a note that says nothing (§7).
    const todoOnly: StoriesView = {
      counts: { total: 3, done: 1, in_progress: 0, review: 0, blocked: 0, todo: 2 },
      unfinished: [
        { id: "S2", status: "todo", reason: REASON_NOT_RECORDED },
        { id: "S3", status: "todo", reason: REASON_NOT_RECORDED },
      ],
      firstBlocked: null,
    };

    const payload = gateNotification(ctx, 1.78, "human", [], todoOnly);

    expect(payload.detail.holding).toBe("stories");
    expect(payload.detail).not.toHaveProperty("continue_command");
    expect(continueNote(todoOnly)).toBeNull();
  });

  test("a blocked story whose handoff recorded NO reason is not given an invented one", () => {
    const noReason: StoriesView = {
      counts: { total: 2, done: 1, in_progress: 0, review: 0, blocked: 1, todo: 0 },
      unfinished: [{ id: "S2", status: "blocked", reason: REASON_NOT_RECORDED }],
      firstBlocked: { id: "S2", status: "blocked", reason: REASON_NOT_RECORDED },
    };

    const payload = gateNotification(ctx, 1.78, "human", [], noReason);

    expect(payload.detail.holding).toBe("stories");
    expect(payload.detail).not.toHaveProperty("continue_command");
  });

  test("the continue command carries the substitutable placeholder, not prose", () => {
    // The adapter fills the `…` (the convention `answerCommand` established); it must
    // never have to notice that `<why>` is a hole.
    expect(continueCommand(RUN)).toContain('--note "…"');
    expect(continueCommand(RUN)).toContain("--and-continue");
    // `--stage` beside `--and-continue` is a usage refusal (`reject.ts:51-57`), so the
    // line the framework hands a button must never carry one.
    expect(continueCommand(RUN)).not.toContain("--stage");
    expect(rejectCommand(RUN)).not.toContain("--and-continue");
  });

  test("`holding` names the branch `command` was chosen by — one derivation, never two", () => {
    const cases: readonly [StoriesView | null, readonly string[], string][] = [
      [stories(5, 6), ["Q1"], "questions"],
      [stories(5, 6), [], "stories"],
      [stories(6, 6), [], "none"],
      [null, [], "none"],
    ];
    for (const [view, open, holding] of cases) {
      const payload = gateNotification(ctx, 1.0, "human", [], view, open);
      const expected = holding === "questions"
        ? answerCommand(open[0] ?? "", RUN)
        : holding === "stories" ? `tldrx run status ${RUN}` : approveCommand(RUN);
      expect(payload.detail.holding).toBe(holding);
      expect(payload.command).toBe(expected);
    }
  });
});
