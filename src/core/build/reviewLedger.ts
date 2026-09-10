/**
 * `events.jsonl`, read once, into the answers a fresh process cannot hold in
 * memory: how many times a story was really REVIEWED, whether it is waiting on a
 * review that FAILED, what its last developer died with, and where the reset
 * boundaries are.
 *
 * A pure reader — it opens one file and returns a record. It lives here rather
 * than in the executor because every bound in the Build phase is enforced across
 * PROCESSES: `tldrx next --commit --review` settles one envelope and exits, so a
 * counter this process alone remembered would be no bound at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVELOPER_FAILED, type DodResult } from "./outcome.ts";
import { looksLikeReviewerError } from "./review.ts";
import { provenanceFromPayload, verdictReviewer, type ReviewerProvenance } from "./reviewerProvenance.ts";

/**
 * What `events.jsonl` already says about one story, for the questions a fresh
 * process cannot answer from memory: how many times has it really been REVIEWED,
 * is it waiting on a review that FAILED, and did its last DEVELOPER ever run?
 */
export interface ReviewLedger {
  /**
   * Real verdicts — `approve` or `changes`. This is the requeue counter, and an
   * errored review is deliberately not one of them.
   */
  readonly verdicts: number;
  /**
   * Fix-list rounds this story has been GRANTED (design §B.4) — the bound's
   * counter.
   *
   * Deliberately separate from `verdicts`: a `fixlist` is a real verdict that
   * costs no attempt, so counting it there would spend the requeue it exists not
   * to spend, and not counting it anywhere would make the one-round bound
   * unenforceable across processes. Reset by `story.reopened` like every other
   * count here — a person who reopens a story hands it a fresh run of attempts,
   * and a fresh fix-list round with them.
   */
  readonly fixlistRounds: number;
  /** The error of the LAST review, when it errored and nothing judged it since. */
  readonly erroredWith: string | null;
  /** The story commit the last `task.done` recorded — the diff already merged. */
  readonly commit: string | null;
  /**
   * The epic sha the last `task.done` recorded (`epic_base`) — where the
   * reviewer's diff STARTS — or null on a run whose Build predates #166.
   *
   * Null is the honest answer and it has a reader: every consumer falls back to
   * the epic BRANCH, which is the range those runs were actually reviewed
   * against. It is never guessed from the branch's sha TODAY — that is the epic
   * after the merge, and diffing from it is the bug this field exists to fix.
   */
  readonly epicBase: string | null;
  /** The DoD results of the last developer attempt that actually ran one. */
  readonly dod: readonly DodResult[];
  /**
   * Where the last RED DoD command's kept output went (#211) — relative to the
   * run dir — and nothing else about it.
   *
   * The one field here a `story.reopened` does NOT clear, deliberately. Every
   * other value in this ledger is a COUNT or a VERDICT: things that count
   * against the story, which is exactly what a person reopening it is saying
   * should not. This is EVIDENCE — the last measured failure of the tree — and a
   * reopen does not make the suite pass. The next developer's prompt cites it so
   * the agent reads the real failure instead of re-running to rediscover it in a
   * worktree that no longer exists.
   */
  readonly lastDodOutputPath: string | null;
  /**
   * The error the LAST developer died with, when it died and nothing has run
   * since — read off the `check: "developer"` event this executor writes.
   */
  readonly developerErroredWith: string | null;
  /**
   * COMPAT: the story's last attempt was blocked having produced nothing the
   * PIPELINE recorded — no commit at `task.done`, no check of any kind, no
   * reviewer spawned.
   *
   * A run recorded before `check: "developer"` existed wrote an errored
   * developer spawn exactly like this and left no other trace in
   * `events.jsonl`; the error itself went only to `run.yml`'s task row.
   * Measured 2026-08-30 in `260830-tenancy-identity-customers`, five times:
   *
   *   {"type":"task.started","payload":{"story":"S2","attempt":1}}
   *   {"type":"agent.spawned","payload":{"story":"S2","role":"developer"}}
   *   {"type":"task.done","payload":{"story":"S2","status":"blocked",
   *                                  "verdict":"n-a","commit":null}}
   *
   * "Nothing the pipeline recorded" is the careful phrasing, and the same run is
   * why: two of those five story branches (S4, S5) DO carry a commit the dying
   * developer made with its own `git commit` before the budget bit. Nothing ran
   * a DoD over it, nothing merged it and nothing read it — which is exactly why
   * the story is owed the attempt again rather than blocked on it.
   *
   * It is NOT on its own proof of a failed spawn — a story with an empty dod
   * block blocks identically — so the caller pairs it with the story's own plan.
   */
  readonly blockedWithNothingRun: boolean;
  /**
   * The last `story.reopened` — a person giving this story another run of
   * attempts (`tldrx story reopen`, `run/reopenStory.ts`) — or null.
   *
   * It is a RESET BOUNDARY, not a field with a reader: every count above starts
   * again at it, so a verdict recorded before a reopen does not spend an attempt
   * of the reopened story. Nothing is erased to achieve that. The events are all
   * still in the log; this reads the last boundary in it.
   */
  readonly reopened: { readonly at: string; readonly actor: string; readonly note: string } | null;
  /**
   * The OPEN fix round on this story (issue #58), or null when there is none.
   *
   * A fix round is `tldrx story reopen <id> --for-fix --note "<defect>"`: a DONE
   * story reopened to land one named defect, consuming no attempt. It OPENS on
   * that event and CLOSES when the story is `done` again — nothing else closes
   * it, and a plain reopen deliberately does not: a fix round that blocked and
   * was granted more attempts is still the same unfixed defect.
   *
   * One story may have exactly one open at a time (owner constraint,
   * 2026-09-01), and this is the field that enforces it across processes. It is
   * the bound's counter in the same way `fixlistRounds` is — read from the log,
   * because a second `tldrx` invocation remembers nothing.
   */
  readonly fixRound: { readonly at: string; readonly actor: string; readonly note: string } | null;
  /**
   * Free re-prompts already granted for the story's OPEN envelope round (#78).
   *
   * The bound's counter, and the reason it is read from the log: `--commit
   * --review` settles one envelope per process, so a limit this process alone
   * remembered would reset on every host correction. It restarts at zero the
   * moment any review verdict is recorded — including an errored one — because
   * the bound is per envelope round, not per story.
   */
  readonly formatRetries: number;
  /**
   * What the format check said about the last refused envelope, or null.
   *
   * Cleared by the same events that reset `formatRetries`, so it is never advice
   * about a round that has already closed. `--prepare --review` splices it back
   * into a rewritten prompt: a host asked for a corrected envelope must not be
   * handed the brief that produced the broken one.
   */
  readonly formatRefusal: string | null;
  /**
   * WHICH REVIEWER produced the story's last recorded verdict, or null when the
   * log cannot say (`build/reviewerProvenance.ts`).
   *
   * Two sources, because there are two doors and they record it in two places. A
   * SPAWNED reviewer's exact arguments are on its own `agent.spawned` — they
   * always were, which is why nothing in this file needed a migration. A HOST
   * review emits no spawn at all, so its declaration rides on the review check
   * event itself.
   *
   * Null on every run recorded before `reviewer_by_stakes:` existed and on every
   * host review whose session declared nothing — and null is the answer those
   * runs deserve. It is never filled from the reviewer BUNDLE's `model:`, which
   * is a suggestion the framework made, not a measurement of what judged the diff.
   *
   * Cleared by `story.reopened` with every other count here: a verdict from
   * before a reopen does not describe the run of attempts starting at it.
   */
  readonly reviewer: ReviewerProvenance | null;
}

/** Everything the two resume paths and the requeue counter need, in one pass. */
export function readReviewLedger(runDir: string, storyId: string): ReviewLedger {
  const path = join(runDir, "events.jsonl");
  const empty: ReviewLedger = {
    verdicts: 0, fixlistRounds: 0, erroredWith: null, commit: null, epicBase: null, dod: [],
    lastDodOutputPath: null,
    developerErroredWith: null, blockedWithNothingRun: false, reopened: null, fixRound: null,
    formatRetries: 0, formatRefusal: null, reviewer: null,
  };
  if (!existsSync(path)) return empty;

  let verdicts = 0;
  let fixlistRounds = 0;
  let erroredWith: string | null = null;
  let commit: string | null = null;
  // The epic AS IT WAS before the merge (#166). A reset boundary clears it with
  // `commit`, because the two describe the same merge and half of one is worse
  // than neither: a base without its commit would name a range for a diff that
  // no longer belongs to this run of attempts.
  let epicBase: string | null = null;
  // The three the DEVELOPER side needs, all scoped to the story's LAST attempt:
  // what its developer died with, whether ANY check ran under it, and whether a
  // reviewer was ever spawned. Together they separate "the turn never happened"
  // from every other way a story blocks.
  let developerErroredWith: string | null = null;
  let ranACheck = false;
  let sawReviewer = false;
  let blockedWithNothingRun = false;
  // `dod` is the last attempt that got as far as running its DoD; `current` is
  // what THIS attempt has run so far. An attempt that was started and produced
  // nothing must not erase the proof of the one before it — measured on the live
  // run, where the wrongly-prepared "attempt 2" left S1 with no DoD at all.
  let dod: DodResult[] = [];
  let current: DodResult[] = [];
  // Survives `story.reopened` — see the field's docstring: it is evidence, not a
  // count, and a reopen resets what counts against the story, not what the tree
  // last measured.
  let lastDodOutputPath: string | null = null;
  let reopened: ReviewLedger["reopened"] = null;
  let fixRound: ReviewLedger["fixRound"] = null;
  let formatRetries = 0;
  let formatRefusal: string | null = null;
  // The LAST reviewer spawn seen for this story, held until the verdict that
  // spawn produced arrives — a spawn on its own is not a review record, and a
  // round that ended in a format refusal is followed by another spawn that
  // replaces this.
  let spawned: ReviewerProvenance | null = null;
  let reviewer: ReviewerProvenance | null = null;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event: { ts?: string; actor?: string; type?: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      // A half-written last line is not a reason to lose the count.
      continue;
    }
    const payload = event.payload ?? {};
    if (payload.story !== storyId) continue;

    // A person reopened the story: everything before this line belongs to a run
    // of attempts an owner has closed by hand, and none of it counts against the
    // one starting here. This is the only branch that resets `verdicts` — the
    // requeue counter — and it is deliberately the only one that can, because it
    // is the only one a human signs (`run/reopenStory.ts`). Nothing is erased:
    // the events it steps over are still in this file and still read by `replay`,
    // `cost` and `retro`, and the reopen event itself records the count it reset.
    if (event.type === "story.reopened") {
      verdicts = 0;
      fixlistRounds = 0;
      erroredWith = null;
      commit = null;
      epicBase = null;
      dod = [];
      current = [];
      developerErroredWith = null;
      ranACheck = false;
      sawReviewer = false;
      blockedWithNothingRun = false;
      reopened = {
        at: typeof event.ts === "string" ? event.ts : "",
        actor: typeof event.actor === "string" ? event.actor : "",
        note: typeof payload.note === "string" ? payload.note : "",
      };
      // A FIX round opens here and is not closed by the reset above (#58): the
      // counters restart, the defect does not stop existing. Deliberately NOT
      // cleared by a plain reopen either — a fix that blocked and was granted
      // more attempts is the same fix round, still owed.
      if (payload.reason === "fix") fixRound = reopened;
      formatRetries = 0;
      formatRefusal = null;
      spawned = null;
      reviewer = null;
      continue;
    }

    // One envelope refused on its FORMAT and sent back, costing no attempt (#78).
    // Counted here and nowhere else: the grant is what this event records, and a
    // grant that a fresh `tldrx next` could not see would not be a bound.
    if (event.type === "story.review_retried") {
      formatRetries++;
      formatRefusal = typeof payload.detail === "string" && payload.detail.trim() !== ""
        ? payload.detail.trim()
        : null;
      continue;
    }

    // A new attempt starts a new DoD run; only the latest one that RAN describes
    // the diff on the branch now.
    if (event.type === "task.started") {
      if (current.length > 0) dod = current;
      current = [];
      // Everything the developer side asks is about the LAST attempt, so every
      // attempt starts the question again. An attempt that RUNS clears the
      // failure the one before it recorded.
      developerErroredWith = null;
      ranACheck = false;
      sawReviewer = false;
      blockedWithNothingRun = false;
    }
    if (event.type === "agent.spawned" && payload.role === "reviewer") {
      sawReviewer = true;
      // MEASURED, and already in every log this framework has ever written: the
      // spawn's own `model`/`effort`. A pre-#178 run recorded them too, which is
      // why a story reviewed by an old binary reads back with its model named
      // rather than as "not recorded".
      spawned = provenanceFromPayload(payload, "spawned");
    }
    if (event.type === "task.done") {
      if (typeof payload.commit === "string" && payload.commit !== "") commit = payload.commit;
      // ADDITIVE: absent on every `task.done` written before #166, and absent
      // leaves this null rather than defaulting to anything.
      if (typeof payload.epic_base === "string" && payload.epic_base !== "") epicBase = payload.epic_base;
      // The story finished again: whatever fix round was open has landed, and the
      // next named defect may open one of its own (#58). This is the ONLY thing
      // that closes one — the same handshake that closed the story the first time.
      if (payload.status === "done") fixRound = null;
      // The COMPAT shape, decided at the moment the attempt ended: blocked with
      // nothing to show for itself and nothing that could have judged it.
      blockedWithNothingRun = payload.status === "blocked"
        && payload.verdict === "n-a"
        && (payload.commit === null || payload.commit === undefined || payload.commit === "")
        && !ranACheck
        && !sawReviewer;
    }
    if (event.type !== "check.passed" && event.type !== "check.failed") continue;

    // The developer's own check, and the only outcome it has is `error` — a
    // developer that RAN is judged by its DoD and its reviewer, never by this.
    // It is deliberately not counted as a check that RAN: the record of a spawn
    // that never happened is not evidence that something happened.
    if (payload.check === "developer") {
      developerErroredWith = typeof payload.detail === "string" && payload.detail.trim() !== ""
        ? payload.detail.trim()
        : DEVELOPER_FAILED;
      continue;
    }
    ranACheck = true;

    if (payload.check === "dod" && typeof payload.command === "string") {
      const refused = typeof payload.refused === "string" && payload.refused !== "";
      const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : null;
      current.push({
        command: payload.command,
        // A refused check has no exit code, and defaulting one to 0 would
        // recover a command that never ran as a GREEN one (#165). Measured
        // before the fix: a `check.failed` carrying only `refused` came back
        // `{exitCode: 0}` and `dodGreen` said true.
        //
        // A pre-#165 event (`exit_code: 126`, no `refused`) still loads as a
        // `ran` row with exit 126 — the file said that, and the reader reports
        // what the file says.
        ...(refused
          ? { status: "refused" as const, refusedBecause: payload.refused as string }
          : { status: "ran" as const, ...(exitCode === null ? {} : { exitCode }) }),
        // Explicit, matching `reviewWorkFromBundle`: `null === 124` is already
        // false, but a future `refused` payload that also carried an exit code
        // must not be able to flip it.
        timedOut: !refused && exitCode === 124,
        // #211: `detail` is now the failure EXCERPT (possibly several lines), so
        // both fields are recovered from it — `tail` is its first line, exactly
        // as `failureSummaryLine` derives it, and a pre-#211 single-line detail
        // round-trips unchanged.
        tail: typeof payload.detail === "string" ? (payload.detail.split("\n")[0] ?? "") : "",
        ...(typeof payload.detail === "string" && payload.detail.includes("\n")
          ? { excerpt: payload.detail }
          : {}),
        ...(typeof payload.output_path === "string" && payload.output_path !== ""
          ? {
            outputPath: payload.output_path,
            ...(typeof payload.output_bytes === "number" ? { outputBytes: payload.output_bytes } : {}),
            ...(typeof payload.output_line === "number" ? { outputLine: payload.output_line } : {}),
          }
          : {}),
      });
      if (typeof payload.output_path === "string" && payload.output_path !== "") {
        lastDodOutputPath = payload.output_path;
      }
      continue;
    }
    if (payload.check !== "review") continue;

    // Any recorded review CLOSES the envelope round — an error and a fix list as
    // much as a counted verdict — so the next one starts with its corrections
    // again. Mirrors `recordReview`, which resets the in-process counter for
    // exactly the same set of outcomes (#78).
    formatRetries = 0;
    formatRefusal = null;
    // One rule, shared with `renderReplay` — see `verdictReviewer`.
    reviewer = verdictReviewer(payload, spawned);

    if (reviewEventErrored(payload)) {
      erroredWith = typeof payload.detail === "string" && payload.detail.trim() !== ""
        ? payload.detail.trim()
        : "the reviewer sub-agent failed";
      continue;
    }
    // A fix list is a verdict that spent no attempt. It clears the errored-review
    // flag like any other judgement — something DID read the diff — and it is
    // counted only against its own bound.
    if (payload.verdict === "fixlist") {
      fixlistRounds++;
      erroredWith = null;
      continue;
    }
    verdicts++;
    erroredWith = null;
  }
  return {
    verdicts,
    fixlistRounds,
    erroredWith,
    commit,
    epicBase,
    dod: current.length > 0 ? current : dod,
    lastDodOutputPath,
    developerErroredWith,
    blockedWithNothingRun,
    reopened,
    fixRound,
    formatRetries,
    formatRefusal,
    reviewer,
  };
}

/**
 * Did this recorded review event describe a reviewer that FAILED?
 *
 * Two shapes, because two eras. A run written by this code says so:
 * `verdict: "error"`. A run written before it existed said `verdict: "changes"`
 * and put the spawn layer's error in `detail` — see `looksLikeReviewerError`.
 */
function reviewEventErrored(payload: Record<string, unknown>): boolean {
  if (payload.verdict === "error") return true;
  if (payload.verdict !== "changes") return false;
  return typeof payload.detail === "string" && looksLikeReviewerError(payload.detail);
}
