/**
 * One REVIEW ROUND: the reviewer's prompt, the workspace prior it is primed with,
 * the bound on a fix-list verdict, the bound on a malformed envelope — and the
 * three counters those bounds are kept in.
 *
 * `ReviewCounters` is three separate maps ON PURPOSE. A requeue bound, a fix-list
 * bound and a format-retry bound count three different things and are reset on
 * three different events; the class docstring says it again where the maps are,
 * because merging any two is the defect this module is most able to introduce.
 *
 * Everything here takes DATA, never a session: `runDir` for the ledger side of a
 * bound, an operator-line array to append to, and one `ReviewCounters` the
 * executor owns and passes by reference (spec §2 decision 3). The halves that
 * spend money or write events — `spawnReviewer`, `recordReview`, and
 * `formatRetry`'s task row and `story.review_retried` — stay in `build.ts`,
 * because no module under `src/core/build/` may name an `ExecutorTask`.
 */
import { renderConventions } from "../facilitator/prompt.ts";
import { stackChecks } from "../experts/packSections.ts";
import { workspaceRecurring } from "../retro/reviewerFocus.ts";
import { latestFixlist, MAX_FIXLIST_ROUNDS } from "./fixlist.ts";
import { BUILD_PHASE, type PlannedStory } from "./plan.ts";
import { buildReviewerPrompt, type RecurringClass } from "./prompts.ts";
import {
  isFormatRejection, MAX_FORMAT_RETRIES, renderFormatRefusal, type Review,
} from "./review.ts";
import { readReviewLedger } from "./reviewLedger.ts";
import { DEVELOPER_FAILED, type DodResult, type StoryOutcome } from "./outcome.ts";

/**
 * The three bounds a review round is held to, each counting a DIFFERENT thing,
 * each falling back to the ledger for a fresh process — and each with its own
 * map, deliberately. `verdicts` counts judgements that cost an attempt;
 * `fixlistRounds` counts free rounds granted to the AUTHOR; `formatRetriesSpent`
 * counts envelopes the format check sent back to the REVIEWER. Merging any two
 * spends a requeue the framework did not owe, or forgets a bound a restart must
 * remember. The three field docstrings below are the executor's own, moved with
 * their maps.
 *
 * ONE instance per invocation, constructed by the executor and passed by reference.
 */
export class ReviewCounters {
  /** Per-story reviewer verdicts seen in THIS process, for the requeue counter. */
  private readonly reviews = new Map<string, number>();

  /**
   * Fix-list rounds this process has granted, per story — the bound's own
   * counter, deliberately NOT the requeue one.
   *
   * A `fixlist` verdict spends no attempt, so it must not touch `reviews`; and it
   * is bounded at `MAX_FIXLIST_ROUNDS`, so it must be counted somewhere. Read
   * through `fixlistRounds`, which falls back to the ledger for a fresh
   * process — a bound a restart forgets is not a bound.
   */
  private readonly fixlists = new Map<string, number>();
  /**
   * Free re-prompts this process has granted THIS review round, per story (#78).
   *
   * A third counter rather than a flag on one of the other two, because it counts
   * a third thing: `reviews` counts verdicts that cost an attempt, `fixlists`
   * counts free rounds granted to the AUTHOR, and this counts envelopes the
   * format check sent back to the REVIEWER. It is reset — not incremented
   * — the moment a verdict is finally counted, because the bound is per envelope
   * round (see `MAX_FORMAT_RETRIES`). Read through `formatRetriesSpent`, which
   * falls back to the ledger: the host door settles one envelope per process, so
   * a bound this process alone remembered would be no bound at all.
   */
  private readonly formatRetries = new Map<string, number>();

  /** How many reviewers have already JUDGED this story, from the ledger. */
  verdicts(runDir: string, storyId: string): number {
    return this.reviews.get(storyId) ?? readReviewLedger(runDir, storyId).verdicts;
  }

  /** One more verdict that COST AN ATTEMPT — `recordReview` decides which do. */
  countVerdict(storyId: string): void {
    this.reviews.set(storyId, (this.reviews.get(storyId) ?? 0) + 1);
  }

  /**
   * How many fix-list rounds this story has already been granted.
   *
   * This process first, then the ledger — the same two-source shape
   * `verdicts` uses, and for the same reason: a bound that a fresh `tldrx
   * next` forgets is not a bound, and a story settled inside THIS invocation has
   * not written its event to a file this can re-read yet.
   */
  fixlistRounds(runDir: string, storyId: string): number {
    return this.fixlists.get(storyId) ?? readReviewLedger(runDir, storyId).fixlistRounds;
  }

  /** Allocate the round `narrowFixlist` just granted, where it is granted. */
  grantFixlistRound(storyId: string, spent: number): void {
    this.fixlists.set(storyId, spent + 1);
  }

  /**
   * The round THIS process allocated, or undefined — deliberately WITHOUT the
   * ledger fallback `fixlistRounds` has. `writeFixlistFor` numbers its artefact
   * from the grant `narrowFixlist` just made, and a ledger re-count would read
   * that very round as one already spent and number the file `-2`.
   */
  fixlistRoundGranted(storyId: string): number | undefined {
    return this.fixlists.get(storyId);
  }

  /**
   * Free re-prompts already granted for this story's CURRENT envelope round.
   *
   * The same two-source shape `verdicts` and `fixlistRounds` use, and
   * for the same reason — except that here the ledger side is load-bearing rather
   * than a fallback: `--commit --review` settles one envelope per process, so
   * every host correction is read back off the log.
   */
  formatRetriesSpent(runDir: string, storyId: string): number {
    return this.formatRetries.get(storyId) ?? readReviewLedger(runDir, storyId).formatRetries;
  }

  /** Allocate the free correction `formatRetryDecision` just granted. */
  grantFormatRetry(storyId: string, spent: number): void {
    this.formatRetries.set(storyId, spent + 1);
  }

  /** A verdict — any verdict — closes the envelope round (#78). */
  closeEnvelopeRound(storyId: string): void {
    this.formatRetries.set(storyId, 0);
  }
}

/**
 * The workspace's recurring finding classes, mined ONCE per invocation (#74).
 *
 * Once, not per story, for two reasons. It reads every artefact of every run in
 * the workspace, and a wave of six stories would pay that six times. And every
 * reviewer in one invocation should be primed with the SAME prior — an
 * aggregate that shifted between story three and story four would make two
 * reviews incomparable for a reason neither log records.
 *
 * `workspaceRecurring` never throws: the worst case is no prior. A refused
 * `finding-classes.yml` is said out loud here rather than swallowed, because a
 * team editing a file that has silently stopped being read is the failure this
 * whole feature exists to end.
 */
export class RecurringFocus {
  private recurring: readonly RecurringClass[] | null = null;

  classes(root: string, lines: string[]): readonly RecurringClass[] {
    if (this.recurring !== null) return this.recurring;
    const focus = workspaceRecurring(root);
    if (focus.error !== null) {
      lines.push(`  \u00b7 reviewer focus skipped \u2014 ${focus.error}`);
    }
    this.recurring = focus.classes;
    return this.recurring;
  }
}

/** The runDir a bound falls back to, and the operator-line sink it speaks through. */
export interface RoundParts {
  readonly runDir: string;
  /** Appended to, never replaced — the executor owns the array. */
  readonly lines: string[];
}

/** `formatRetryDecision`'s input: `RoundParts` plus the envelope being judged. */
export interface FormatRetryParts extends RoundParts {
  readonly storyId: string;
  readonly review: Review;
}

/** Everything `reviewerPromptFor` renders from, as values rather than as a session. */
export interface ReviewerPromptParts {
  readonly runDir: string;
  readonly root: string;
  readonly runId: string;
  readonly story: PlannedStory;
  readonly branch: string;
  readonly epicBranch: string;
  readonly worktree: string;
  readonly dod: readonly DodResult[];
  /** The refusal a previous envelope of this round earned, or null (#78). */
  readonly refusal: string | null;
  /** `spec.stackExperts` — the second of the two switches `## Stack checks` needs. */
  readonly stackExperts: boolean;
  readonly counters: ReviewCounters;
  readonly focus: RecurringFocus;
  /** Appended to, never replaced. */
  readonly lines: string[];
  /**
   * What the reviewer's `git diff` starts FROM — the epic's sha immediately
   * before this story was merged into it (#166).
   *
   * ADDITIVE and optional. Absent, null or empty ⇒ `epicBranch`, which is
   * byte-for-byte the prompt this rendered before the field existed: a story
   * reviewed out of a bundle written by an older binary reads exactly as it did.
   */
  readonly diffBase?: string | null;
}

/**
 * The reviewer's prompt — ONE renderer, whichever door the review comes
 * through.
 *
 * A host review that judged a different brief from the one a spawn would have
 * been given is not the same review, and the bundle's whole claim is that it
 * is. Sharing the call is how that stays true without a test having to keep
 * two copies in step.
 */
export function reviewerPromptFor(parts: ReviewerPromptParts): string {
  return buildReviewerPrompt({
    // What this workspace's own reviews keep finding (#74). Empty on a workspace
    // with no history, which renders no section at all.
    recurring: parts.focus.classes(parts.root, parts.lines),
    refusal: parts.refusal,
    runId: parts.runId,
    story: parts.story,
    repoName: parts.story.story.repo,
    branch: parts.branch,
    epicBranch: parts.epicBranch,
    // Straight through: `buildReviewerPrompt` owns the fallback, so the spawned
    // door and the bundle door cannot disagree about what a missing base means.
    diffBase: parts.diffBase,
    worktree: parts.worktree,
    conventions: renderConventions(parts.root, [parts.story.story.repo]),
    // Every field, including the ABSENCE of an exit code on a refused row —
    // reconstructing one here is the bug #165 fixed one layer down.
    dodResults: parts.dod.map((r) => ({
      command: r.command,
      ...(r.status === undefined ? {} : { status: r.status }),
      ...(r.refusedBecause === undefined ? {} : { refusedBecause: r.refusedBecause }),
      ...(r.exitCode === undefined ? {} : { exitCode: r.exitCode }),
    })),
    // Withdrawn once the story's one round is spent, so the prompt never offers
    // a verdict `narrowFixlist` is about to refuse. Computed the same way on
    // both doors, which is what keeps the bundle's prompt byte-identical to the
    // one a spawn would have sent.
    fixlistAvailable:
      parts.counters.fixlistRounds(parts.runDir, parts.story.story.id) < MAX_FIXLIST_ROUNDS,
    // The active packs' checks for this story's repo (stack packs design §4.5), fed
    // straight into the reviewer's prompt. Null when the packs switch is off, which
    // renders nothing.
    //
    // Gated on `spec.stackExperts` too (issue review, fix round 1): the developer's
    // OWN pack content is gated on that same stage-yaml switch two calls down, via
    // `loadExpertBundles({ stackExperts: this.ctx.spec.stackExperts, ... })` ->
    // `selectExperts` (`selectExperts.ts:140` — a `kind: stack` expert is never even
    // SELECTED without it). With `stack_packs.enabled: true` and `stack_experts: false`
    // in one story, the developer would get no pack content at all while the reviewer
    // graded against `## Stack checks` text it was never shown. Checking both switches
    // here is what keeps the two turns agreeing on whether packs are in play at all.
    stackChecks: parts.stackExperts
      ? stackChecks(parts.root, [parts.story.story.repo])
      : null,
  });
}

/**
 * The bound, applied to a verdict before anything records it (design §B.4).
 *
 * One fix-list round per story. A second `fixlist` is refused and read as
 * `changes` — the fail-closed direction, and the honest one: the reviewer asked
 * for a free round it does not have, and what it actually said was "this diff
 * is not finished". Refused HERE, between the parse and `recordReview`, so the
 * downgraded verdict is the one that lands on the requeue counter, the ledger
 * line and the story's fate alike.
 *
 * A declared fix list `parseReview` could not read has already fallen to
 * `changes` by the time this runs; its reasons come through on
 * `fixlistProblems` and are said out loud rather than swallowed.
 */
export function narrowFixlist(
  counters: ReviewCounters, parts: RoundParts, storyId: string, review: Review,
): Review {
  // Printed HERE because both doors — a spawned reviewer and a host's
  // `--commit --review` — reach the record through this one call (gh #36).
  if (review.verdictProblem !== null) {
    parts.lines.push(`  · ${storyId}: ${review.verdictProblem}`);
  }
  for (const problem of review.fixlistProblems) {
    parts.lines.push(`  · ${storyId}: the reviewer's fix list was REFUSED — ${problem}`);
  }
  if (review.fixlistProblems.length > 0) {
    parts.lines.push(
      // Not "does not buy a free round", which is what this said before #78:
      // an unreadable envelope DOES buy a bounded free CORRECTION now. What it
      // still cannot buy is the third VERDICT — a fix-list round is granted on
      // a fix list somebody can read, and on nothing else.
      `  · ${storyId}: an unreadable fix list does not grant a fix-list round — read as \`changes\``,
    );
  }
  if (review.verdict !== "fixlist") return review;
  const spent = counters.fixlistRounds(parts.runDir, storyId);
  if (spent < MAX_FIXLIST_ROUNDS) {
    // The round is ALLOCATED here, where it is granted — not counted off the
    // ledger later. `recordReview` writes the `verdict: fixlist` event between
    // this and the artifact, so a later re-count would read this very round as
    // one already spent and number the file `-2`.
    counters.grantFixlistRound(storyId, spent);
    return review;
  }
  const previous = latestFixlist(parts.runDir, BUILD_PHASE, storyId);
  parts.lines.push(
    `  · ${storyId}: a SECOND fix-list round was refused — the bound is `
    + `${String(MAX_FIXLIST_ROUNDS)} per story`
    + (previous === null ? "" : ` (round ${String(previous.round)} is ${previous.rel})`)
    + ", so this review is a full one and its verdict is read as `changes`",
  );
  return {
    ...review,
    verdict: "changes",
    summary: `a second fix-list round was refused (the bound is ${String(MAX_FIXLIST_ROUNDS)} `
      + `per story): ${review.summary}`,
    findings: [
      ...review.findings,
      ...review.fixlist.map((f) => `${String(f.n)}. ${f.finding} [${f.severity}]`),
    ],
    fixlist: [],
  };
}

/** The grant `formatRetryDecision` made, and everything its caller has to say. */
export interface FormatRetry {
  /** What to splice into the corrected envelope's prompt. */
  readonly refusal: string;
  /** `story.review_retried`'s payload detail, already clipped to 4 KB (§2.9). */
  readonly detail: string;
  /** 1-based: which correction this is. */
  readonly retry: number;
  /** The two operator lines, pushed by the caller AFTER its event, as they were. */
  readonly lines: readonly string[];
}

/**
 * Grant one free re-prompt for a FORMAT-refused envelope, or refuse to (#78, #79).
 *
 * Returns the refusal to carry into the corrected envelope's prompt, or null —
 * and null is the answer for every case except the narrow one this exists for,
 * which is why the caller can treat it as "carry on exactly as before".
 *
 * The grant is RECORDED before it is used, in both places a bound has to live:
 * `this.formatRetries` for this process, and a `story.review_retried` event for
 * every process after it. Attempt bookkeeping that moved with nothing in the log
 * would be unauditable, and this is the one path where an attempt is deliberately
 * not spent.
 *
 * The turn's money is pushed as its own task row here rather than at
 * `recordReview`, because that turn happened and was billed: what it did not
 * produce is a VERDICT.
 */
export function formatRetryDecision(
  counters: ReviewCounters, parts: FormatRetryParts,
): FormatRetry | null {
  const id = parts.storyId;
  const review = parts.review;
  if (!isFormatRejection(review)) return null;
  const spent = counters.formatRetriesSpent(parts.runDir, id);
  if (spent >= MAX_FORMAT_RETRIES) {
    parts.lines.push(
      `  · ${id}: a ${String(MAX_FORMAT_RETRIES + 1)}th envelope was refused on its FORMAT — the `
      + `bound is ${String(MAX_FORMAT_RETRIES)} free correction(s), so this one is `
      + "recorded as `changes` and costs the attempt",
    );
    return null;
  }
  counters.grantFormatRetry(id, spent);
  // `formatProblems`, not `fixlistProblems`: a verdict WORD outside the enum
  // (gh #36) is a format refusal that raises no fix-list problem at all, and
  // reading the narrower list would record — and re-prompt with — nothing.
  const detail = review.formatProblems.join(" · ");
  return {
    refusal: renderFormatRefusal(review.formatProblems),
    detail: clipDetail(detail),
    retry: spent + 1,
    lines: [
      `  · ${id}: the review envelope was REFUSED as malformed — ${detail}`,
      `  · ${id}: asking for a corrected envelope; this cost the story NO attempt `
      + `(correction ${String(spent + 1)} of ${String(MAX_FORMAT_RETRIES)})`,
    ],
  };
}

/**
 * Was this story's `blocked` caused by a developer that never RAN?
 *
 * Returns the error it died with, or null when the block was earned. This is
 * the migration for Fix 1, and it exists because `blocked` is terminal in-run:
 * a run recorded by the old code has stories parked there that were never
 * really attempted, and nothing would ever offer them again.
 *
 * Two recorded shapes, because two eras — see `readReviewLedger`. The old one
 * is only trusted when the story DECLARES dod commands and none ran: a story
 * with an empty dod block blocks with exactly the same event shape (no commit,
 * no check, no reviewer), and that block is a plan bug the developer had
 * nothing to do with.
 *
 * `this.outcomes` is consulted first so a story THIS process just settled is
 * read from its own outcome rather than from a log line it has not written yet.
 */
export function blockedByFailedDeveloper(
  runDir: string, planned: PlannedStory, fresh: StoryOutcome | undefined,
): string | null {
  if (fresh !== undefined) return fresh.developerError;
  const ledger = readReviewLedger(runDir, planned.story.id);
  if (ledger.developerErroredWith !== null) return ledger.developerErroredWith;
  if (ledger.blockedWithNothingRun && planned.dod.commands.length > 0) return DEVELOPER_FAILED;
  return null;
}

/**
 * The refusal a previous envelope of this story's open round earned, rendered
 * for a prompt — or null when the last envelope was not refused that way (#78).
 *
 * Read off the ledger rather than off this process, because the only caller is
 * `--prepare --review`, which by definition runs after the invocation that
 * recorded the refusal has exited.
 */
export function pendingRefusal(runDir: string, storyId: string): string | null {
  const said = readReviewLedger(runDir, storyId).formatRefusal;
  return said === null ? null : renderFormatRefusal([said]);
}

/** One event payload's `detail`, bounded — spec §2.9 caps a payload at 4 KB. */
function clipDetail(detail: string): string {
  const text = detail.replace(/\s+/g, " ").trim();
  return text.length <= 1200 ? text : `${text.slice(0, 1197)}…`;
}
