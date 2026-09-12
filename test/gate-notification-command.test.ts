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
import { answerCommand, approveCommand, rejectCommand } from "../src/core/run/decisionCards.ts";
import { deliveredPhrase, type StoriesView } from "../src/core/run/runOutcome.ts";
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
