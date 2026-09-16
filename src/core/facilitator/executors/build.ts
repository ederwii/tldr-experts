/**
 * The Build executor — `waves.yml` turned into branches, worktrees, sub-agents and
 * merges (concept §9, spec §5 "Build executor").
 *
 * One story is one unit of work, and the pipeline over it never varies:
 *
 *   branch → worktree → developer sub-agent → DoD → commit → merge → reviewer →
 *   `done` with evidence, or `blocked` with the reason
 *
 * Two rules shape everything below. **Done means proven**: a story reaches `done`
 * only when every command in its ```dod block exited 0 in its own worktree AND a
 * reviewer approved the diff, and the proof is written into the story's own
 * `evidence:`. **The phase does not ship**: nothing here pushes, and no epic is
 * ever merged into a default branch — the phase ends at a human gate that lists
 * the epic branches waiting.
 *
 * **Parallel within a wave (`--parallel N`; the shipped `stages/build/stage.yml`
 * declares 2, and `DEFAULT_PARALLEL` here stays 1 for a stage file that declares
 * none).** `waves.yml` guarantees a
 * dependency is in an EARLIER wave, so the stories of one wave are independent by
 * construction and may run at once. At `N = 1` the executor takes exactly the
 * path it always did, story by story — byte-identical, because "the default must
 * not change" is not a thing to be argued about after the fact. Above 1 the wave
 * splits in two halves:
 *
 *   A. concurrently, up to N at a time: worktree → developer → DoD → commit
 *   B. serially, in the wave's LISTED order: merge → reviewer → done/blocked
 *
 * Half B is serial on purpose, and not only for the merge. A reviewer reads
 * `git diff <epic>...<story>`, whose merge base MOVES every time another story
 * merges into that epic — two concurrent reviewers would be judging diffs that
 * changed under them. Serial B costs the reviewers' wall-clock and buys a review
 * that means something.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  describeBranchModel, epicBranchOf, storyBranchOf, type BranchModel,
} from "../../plan/branchModel.ts";
import {
  factsPath, loadWorkspace, type WorkspaceContext,
} from "../../../hooks/lib/workspace.ts";
import { FactsStore } from "../../facts/FactsStore.ts";
import { decidedTally, describeDecidedTally } from "../../facts/decidedTally.ts";
import { RunStore } from "../../run/RunStore.ts";
import { renderConventions, renderFacts, stackExpertNames } from "../prompt.ts";
import { loadExpertBundles } from "../../experts/expertBundle.ts";
import {
  readStackPacks, renderProjectSkills, skillsFor, untrackedSkillWarnings,
} from "../../experts/stackPacks.ts";
import { agentDir } from "../paths.ts";
import {
  describeDispatchNotes, loadDispatchNotes, type DispatchNotes,
} from "../dispatchNotes.ts";
import { preparedBundles, reviewBundles } from "../../run/prepared.ts";
import { spawnAgent, BASE_TOOLS, bashGrantsFor, type AgentRateLimit } from "../spawnAgent.ts";
import { rateLimitLine } from "../agentEvents.ts";
import { DEVELOPER_RESULT_SCHEMA, type AgentUsage } from "../envelope.ts";
import {
  PendingError, PENDING_FILE, RAW_FILE, RESULT_FILE, readResult, readResultObject, resultPath,
  writeBundle, writeRaw,
  dispatchNotesRecord, type PendingStage,
} from "../pending.ts";
import {
  abortOpenMerge, addWorktree, commitsBetween, ensureBranch, firstLine, fullShaOf, git, GitError, headSha, leftoverMerge,
  markerGuardVerdict, removeWorktree, repoDirOf, reviewDiffCommand, reviewDiffRange, shaReachability, uncountedCount,
} from "../../build/git.ts";
import { BaseGateFailure, baseRefusalLines, refusalFreshness } from "../../build/preflight.ts";
import {
  loadBuildPlan, PlanLoadError, BUILD_PHASE, LOG_DIR, PLAN_PHASE,
  type BuildPlan, type BuildWave, type PlannedEpic, type PlannedStory,
} from "../../build/plan.ts";
import {
  describeImplicitPlan, discardImplicitPlan, dodIsSatisfiedEmpty, implicitPlanContent, implicitPlanIsStale,
  implicitPlanPath, ImplicitPlanError, loadImplicitPlan, planIsSkipped, updateImplicitPlan,
  IMPLICIT_PLAN_REL, IMPLICIT_STORY_ID, IMPLICIT_STORY_NOTE,
} from "../../build/implicitPlan.ts";
import { evidenceFor, updateStoryFront } from "../../build/storyFile.ts";
import {
  buildDeveloperPrompt, REVIEW_SCHEMA, type ConflictTurnPrompt, type PreviousAttemptKind, type ReopenNote,
} from "../../build/prompts.ts";
import { ITERATION_ONLY_SLOT } from "../../schemas/commandAllowlist.ts";
import { boundBytes, DOD_DETAIL_MAX_BYTES } from "../../build/dodOutput.ts";

/**
 * The byte budget for ONE free-text `task.done` field that can carry
 * agent-authored text of unbounded length (gh #359) — `DOD_DETAIL_MAX_BYTES`
 * (dodOutput.ts), the SAME quarter-of-the-§2.9-cap the DoD excerpt already
 * uses, reused rather than re-derived (AGENTS.md §7).
 */
const TASK_DONE_FIELD_MAX_BYTES = DOD_DETAIL_MAX_BYTES;

/**
 * Clamp a `task.done` field that can carry agent-authored text of unbounded
 * length — `permission_refused` (the command a permission layer refused,
 * copied verbatim, gh #271) and `budget_death` (a developer's own kill
 * message) are the two measured so far.
 *
 * `capPayload` (Event.ts) is the REACTIVE valve at the emit seam — it drops a
 * still-oversized field as a last resort, for any event, but only for the
 * fields it is TAUGHT (`DROPPABLE_LISTS`/`DROPPABLE_PROSE`); `permission_refused`
 * was never on that list, a 5474-byte refused heredoc alone put a real
 * `task.done` over the §2.9 cap, `EventLog.append` threw, and the throw failed
 * the whole STAGE — not just the story — buying `run auto` a relaunch nobody
 * owed (measured on a field run, gh #359). This is the PROACTIVE half: bound
 * the field BEFORE it can ever make the payload oversized, so the reactive
 * valve never has to be taught this field at all.
 *
 * `boundBytes` is dodOutput.ts's ONE byte-safe truncation (§7) — reused here,
 * not re-derived. What THIS function adds is the marker: how big the original
 * was, and where the full text still lives. That pointer is true BY
 * CONSTRUCTION, never a promise about a file that may not exist — `settle`
 * always calls `writeLog` (which renders `permissionRefused`/`budgetDeath`
 * verbatim) before it builds `task.done`, so `logRel` already carries the text
 * this marker points at.
 */
function clampAgentText(text: string, logRel: string): string {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= TASK_DONE_FIELD_MAX_BYTES) return text;
  const marker = ` [clamped: ${String(originalBytes)} bytes exceeds the ${String(TASK_DONE_FIELD_MAX_BYTES)}` +
    `-byte field budget — full text: ${logRel}]`;
  // A floor, not the ordinary case: guards `boundBytes` against a budget below
  // its own ellipsis (3 bytes) — unreachable with `logRel`'s real, short shape,
  // but a marker is text too and this function does not get to assume its size.
  const headBudget = Math.max(64, TASK_DONE_FIELD_MAX_BYTES - Buffer.byteLength(marker, "utf8"));
  return `${boundBytes(text, headBudget)}${marker}`;
}

/** `testFast` as an optional prompt field: present only when the repo declares one. */
function testFastPart(
  found: { readonly fast: string; readonly full: string | null } | null,
): { readonly testFast?: { readonly fast: string; readonly full: string | null } } {
  return found === null ? {} : { testFast: found };
}
import {
  MAX_FORMAT_RETRIES, parseReview, renderPreviousAttempt, renderReviewLog, reviewerFailed,
  reviewerUnfunded, reviewerUnfundedReason, REVIEWER_UNFUNDED_MARK,
  type Review,
} from "../../build/review.ts";
import {
  AS_IS_MARK, AS_IS_REVIEW_ONLY_MARK, asIsNotAheadReason, DEVELOPER_FAILED, dodFailure, dodFailureReason, dodGreen, dodRefused,
  leftoverMergeReason, noDiffAfterReopenReason, reviewNeverCompleted, reviewStillOwed,
  type AsIsSettlement, type DodResult, type RescuedWork, type StoryOutcome,
} from "../../build/outcome.ts";
import {
  CLAIMED_UNVERIFIED, FIXLIST_SETTLED_MARK, canonicalizeResolutions, fixlistRel, fixlistRetroLines, latestFixlist, markUnverified,
  openFindings, openFixlist, readFixlistAt, renderFixlistSection, writeFixlist, AUTO_CLOSED_MARK, autoCloseShown,
  CLOSED_ON_EPIC,
  type FixFinding, type FixlistOnDisk,
} from "../../build/fixlist.ts";
import { sweepFixlistAgainstEpic, type SweepOutcome } from "../../build/fixlistSweep.ts";
import { renderBuildHandoff, type EpicSummaryRow, type NotStartedStory } from "../../build/handoff.ts";
import {
  asidePayload, FOREIGN_ASIDE_EVENT, FOREIGN_RESTORED_EVENT, namePaths, notRestoredLine, pendingAsides,
  restoreForeignWork, restoredLine, restoredPayload, setAsideForeignWork, unrestored,
  type AsideStash, type RestoreOutcome,
} from "../../build/foreignWork.ts";
import { measuredWidening, wideningRows, type WideningRow } from "../../build/measuredTouches.ts";
import { declaredTouchesFor } from "../../run/boundary.ts";

/** The log the widening citations point at, run-relative — one spelling. */
const EVENTS_FILE = "events.jsonl";

/** gh #286: the operator line for a story requeued with a merge to resolve — one spelling, two drivers. */
const CONFLICT_REQUEUED_LINE = "bringing it up to its epic conflicted — requeued once with the merge to resolve";
/**
 * gh #305: why a story was not started when a `run cancel` landed under this
 * stage — ONE spelling, now three readers (the serial loop, a wave's lanes, and
 * the handoff row that says why a scheduled story has no outcome). It was
 * written out twice and the handoff knew nothing about it, which is how the
 * live report and the audit record came to name different causes for the same
 * withheld story (gh #298's review).
 */
const CANCELLED_UNDER_STAGE = "the run was cancelled (tldrx run cancel) while this stage held it";
/**
 * gh #298: the operator line for a story the provider's quota warning parked —
 * one spelling, two doors (the serial loop and a wave's lanes).
 */
const RATE_LIMIT_PARK_LINE = "the provider warned its rate limit was close, so the run parked before it bit";
/** gh #327: the operator line for a story requeued for its fix round — one spelling, three doors. */
const FIX_ROUND_REQUEUED_LINE = "the reviewer signed with a fix list — requeued for its fix round, which spends no attempt";
import { carriedReportFor, type CarriedReport } from "../../build/carriedRows.ts";
import {
  PreflightCache, redBaseRefusal, runStoryDod, serveBaseResult, type BaseParts, type DodParts,
} from "../../build/dodRunner.ts";
import { scopedPathsFor } from "../../build/scopedPaths.ts";
import {
  commitIfDirty, EpicClaimError, epicClaimRefusal, EpicState, mergeIntoEpic, openConflictTurnMerge, openEpicWorktree,
  refreshStoryBase, rescueUncommitted, staleBaseConflict, storyWorktreePath, unreadableTouches, updateStoryBase,
  workSince, type EpicWorktreeParts,
} from "../../build/worktrees.ts";
import {
  INSTALL_SLOT, installCommandFor, installFailed, installFailureReason, runWorktreeInstall, type InstallCheck,
} from "../../build/worktreeDeps.ts";
import { entryProbeRefusal, type EntryProbeParts } from "../../build/entryProbe.ts";
import {
  dirtyRepoRefusal, epicRows, foreignEpicRefusal, relaunchCommand, resolveBranchModel, type ClaimParts,
} from "../../build/branchClaims.ts";
import {
  awaitingReview, bundleKeyOf, clearReviewBundle, resumableReview,
  reviewBundleKeyOf, reviewWorkFor, reviewWorkFromBundle, reviewWorkFromLedger,
  stashRefusedEnvelope, writeReviewBundle,
  type ResumableReview, type ReviewLookup, type ReviewWork,
} from "../../build/reviewBundle.ts";
import {
  blockedByFailedDeveloper, conflictTurnRefusal, dodRedRequeue, formatRetryDecision, narrowFixlist, pendingRefusal, reviewerPromptFor,
  unrecordedBaseLine,
  RecurringFocus, ReviewCounters, type RoundParts,
} from "../../build/reviewRound.ts";
import { readReviewLedger } from "../../build/reviewLedger.ts";
import {
  decidingHold, dependencyCommitRefusal, dependencyHoldOfLog, dependencyHoldReason, dependencyIsPending,
  dependencyNextLine, dependencyPrepareRefusal, dependencyWaitLine, dependencyWaitReason, type DependencyHold,
} from "../../build/dependencyHold.ts";
import { classifyRefusal, MAX_SEPARATOR_RETRIES, separatorCurePrefix, withCure } from "../../build/refusalKind.ts";
import { developerGitGrants } from "../../build/developerGrants.ts";
import type { ReviewerProvenance } from "../../build/reviewerProvenance.ts";
import {
  resolveReviewer, reviewerOverrideLine, type ReviewerResolution,
} from "../reviewerModel.ts";
import { phaseCostToDate, storySpendToDate } from "../../build/phaseCost.ts";
import { appendBuildRetro, buildRetroPath, gateRetroLines, storyRetroLines } from "../../build/retroLog.ts";
import {
  capDeathReason, clampParallel, developerAttemptDivisor, developerCap, planOverStageAdvisory, waveLaneFunding,
  reviewerCap, reviewerUnderfunded, round2, stageRemainderUsd, storyCeilingUsd,
  DEFAULT_PARALLEL, MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE,
  STORY_CAP_MULTIPLIER, STORY_CAP_FLOOR_USD,
  type CapLever, type CapParts,
} from "../../build/caps.ts";
import { shortBy, stageRaiseCommand } from "../../budget/budgetView.ts";
import type { PlanStatus } from "../../schemas/planCommon.ts";
import { withPartialTasks, type ExecutorContext, type ExecutorOutcome, type ExecutorTask } from "./index.ts";

export const HANDOFF_REL = `${BUILD_PHASE}/handoff.md`;
/** Run-relative, and the path `mineRuns` looks for — see `build/retroLog.ts`. */
export const RETRO_REL = "retro.md";

/**
 * One writer, in order, for everything that touches disk or `run.yml`.
 *
 * Concurrency here is between AWAITS, not between threads: two stories' pipelines
 * interleave only where one of them yields. That is enough to interleave a
 * sequence of writes — `git worktree add` in the shared repo, a story-file patch,
 * an `events.jsonl` append — into each other's middles. Every such sequence is
 * run through this chain, so the executor stays what it has always been: a single
 * writer holding the run lock.
 */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(work, work);
    // A rejection must not poison the queue: the next caller waits for this one
    // to SETTLE, and gets its own error rather than a stranger's.
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

/** What half A of a parallel wave produced for one story. */
interface StoryHalf {
  readonly story: StoryContext;
  readonly cost: number;
  readonly dod: readonly DodResult[];
  readonly commit: string | null;
  /** Non-null when the story is already lost: half B blocks it and stops. */
  readonly failure: string | null;
  /**
   * Non-null when the DEVELOPER sub-agent itself failed — spawn error, timeout,
   * exhausted budget — and delivered nothing. Half B parks the story instead of
   * blocking it: a turn that never ran is not an attempt.
   */
  readonly developerError: string | null;
  /**
   * The story's status BEFORE this attempt started, so a developer failure can
   * put it back. `todo` for a first attempt, `review` for one the reviewer
   * requeued, `blocked` for a story rescued from a previous run's spawn error.
   */
  readonly before: PlanStatus;
  /**
   * gh #295: the story's work is ALREADY on the epic from an earlier turn and
   * nothing judged it, so half B must merge nothing and run only the review —
   * over this commit and this base, the ones the story was merged as. Set by
   * `asIsHalf` alone, once it has measured the branch; absent on every other
   * half, where `commit` is what half B is about to merge.
   */
  readonly reviewOnly?: { readonly commit: string; readonly epicBase: string };
  /**
   * gh #313: `failure` is a red Definition of Done and nothing else — the
   * developer was neither refused nor killed on its cap. Half B requeues it
   * while attempts remain (`dodRedRequeue` decides). Absent on every other half.
   */
  readonly redDod?: { readonly refused: string | null; readonly budgetDeath: string | null };
  /**
   * gh #286: this half came from a headless developer attempt, the one path a
   * conflicting base update may requeue as a conflict turn. Absent on the host's
   * `--commit` half and on an as-is settlement, which block on a conflict as
   * they always did — the first has no dispatch of ours to hand the merge to,
   * and the second was signed as "no developer".
   */
  readonly mayConflictTurn?: true;
}

/**
 * `attended_by: host` and a headless invocation: refuse, spawn nothing.
 *
 * `refused: true` rather than a failure — the stage goes back to `ready` and the
 * operator fixes it by using the other half of the handshake (spec §3 exit 2).
 * `runNext` refuses this before an executor is reached, so reaching here means a
 * caller that is not `runNext`; the outcome is still the right one.
 */
function attendedRefusal(ctx: ExecutorContext): ExecutorOutcome {
  return {
    ok: false,
    awaiting: false,
    tasks: [],
    costUsd: 0,
    outputs: [],
    lines: [
      `${ctx.runId} is attended_by: host — ${ctx.phaseId}/${ctx.stageId} does not run headless.`,
      `  hand it a turn instead: tldrx next --prepare ${ctx.runId}`,
    ],
    error: null,
    refused: true,
  };
}

export async function buildExecutor(ctx: ExecutorContext): Promise<ExecutorOutcome> {
  // Before the workspace is even loaded: a host-driven run never runs the whole
  // remaining plan as paid spawns, which is exactly what one bare `tldrx next`
  // on a Build stage did (measured 2026-08-30).
  if (ctx.attendedByHost && ctx.mode === "headless") return attendedRefusal(ctx);
  const workspace = loadWorkspace(ctx.root);
  let plan: BuildPlan;
  const opening: string[] = [];
  // A skill git does not track is absent from every story worktree; say so once, at the
  // start, rather than letting the developer discover a file the prompt named is missing.
  opening.push(...untrackedSkillWarnings(skillsFor(readStackPacks(ctx.root), ctx.repos)));
  if (ctx.mode === "prepare" && ctx.discardPending) opening.push(...discardBundles(ctx));
  try {
    plan = await openPlan(ctx, workspace, opening);
  } catch (error) {
    if (error instanceof PlanLoadError || error instanceof ImplicitPlanError) {
      return failed(ctx, error.message, []);
    }
    throw error;
  }

  const session = new BuildSession(ctx, workspace, plan, opening);
  // Every exit carries the epic branches this run claimed — including the failure
  // paths. A run that cut `epic/x` and then fell over still cut it, and the next
  // invocation must not refuse its own branch.
  const withClaims = (outcome: ExecutorOutcome): ExecutorOutcome =>
    session.claimedEpics.size === 0
      ? outcome
      : {
          ...outcome,
          epicBranches: [...session.claimedEpics],
          // The model goes with the branches, in the same write (issue #57): a
          // run.yml that named a branch without saying which model chose it is
          // what the next invocation would have to guess at.
          branchModel: session.branchModel.kind,
        };
  /**
   * EVERY exit from this executor, including the successful ones (#164, review
   * round 1).
   *
   * A stage that refused at its third door, or died, still borrowed the
   * operator's uncommitted work — and the reviewer reproduced exactly that: a
   * refusal returned through a wrapper that only recorded claimed branches, so
   * the stash stayed, the tree stayed short a file, and the report said nothing.
   * There is now one wrapper, and it is this one: nothing returns from here
   * without the borrowed tree having been handed back and the handing-back said
   * out loud.
   *
   * `restoreForeignWorkAside` reads the LOG and is idempotent, so the ordinary
   * path — where `finish()` has already restored — adds no line and costs one
   * file read.
   */
  const withRestore = async (outcome: ExecutorOutcome): Promise<ExecutorOutcome> => {
    // gh #298: the provider's warning belongs on the ledger whether or not this
    // stage had a story left to withhold. Here, because this is the one wrapper
    // every exit — finished, refused, failed — returns through.
    session.flushRateLimited();
    const lines = await session.restoreForeignWorkAside();
    return withClaims(lines.length === 0 ? outcome : { ...outcome, lines: [...outcome.lines, ...lines] });
  };
  try {
    // `--review` names the second delegable role. It rides the SAME two doors —
    // there is one handshake, and a reviewer that needed its own would be a
    // second contract for the host to get wrong (design §B.3).
    if (ctx.mode === "prepare") {
      return await withRestore(ctx.review ? await session.prepareReviewOnly() : await session.prepare());
    }
    if (ctx.mode === "commit") {
      return await withRestore(ctx.review ? await session.commitReview() : await session.commit());
    }
    return await withRestore(await session.runAll());
  } catch (error) {
    // Issue #41: the DoD step found a red command that is red on the base tree
    // too. That is a workspace-configuration fault, so it REFUSES (stage back to
    // `ready`, story untouched, attempt unspent) rather than blocking a story for
    // something no story caused. Whatever the developer already cost is still in
    // `session.tasks` and is still recorded.
    if (error instanceof BaseGateFailure) return await withRestore(refusedOnBase(session, error));
    // #262: the branch was cut and the claim could not be written. A stage
    // failure carrying that sentence, rather than a `WorkspaceLockError` stack
    // that names a lock file and not the branch now sitting in the repo.
    if (error instanceof GitError || error instanceof PlanLoadError || error instanceof EpicClaimError) {
      const outcome = failed(ctx, error.message, session.tasks);
      return await withRestore({ ...outcome, lines: [...session.reportLines, ...outcome.lines] });
    }
    // An error nobody here understands still leaves with the tree it borrowed put
    // back: the throw is re-raised as it was, and a restore that itself throws
    // must not replace it. It leaves CARRYING the rows this session had already
    // earned (#249): the caller's catch records them, so a throw after a paid
    // turn no longer takes that turn's money out of the ledger.
    try {
      session.flushRateLimited();
      await session.restoreForeignWorkAside();
    } catch {
      // Nothing to add: the original error is the one that matters.
    }
    throw withPartialTasks(error, session.tasks);
  }
}

/** A story's DoD failure re-attributed to the base tree — see `BaseGateFailure`. */
function refusedOnBase(session: BuildSession, error: BaseGateFailure): ExecutorOutcome {
  const who = error.storyId === null ? "a story" : `\`${error.storyId}\``;
  const freshness = refusalFreshness([error.provenance]);
  return {
    ok: false,
    refused: true,
    awaiting: false,
    tasks: session.tasks,
    costUsd: session.tasks.reduce((sum, task) => sum + task.costUsd, 0),
    outputs: [],
    lines: [
      // The session's own lines first: this refusal can happen after the stash,
      // and a report that omits "N change(s) were set aside" is a report that
      // moved somebody's files in silence.
      ...session.reportLines,
      `[tldrx] build: ${who} was not blocked — its Definition of Done failed for a reason the base tree shares.`,
      ...baseRefusalLines([{ result: error.result, provenance: error.provenance }]),
    ],
    error: error.message,
    // #339: the same field `refuseOnRedBase` sets, from the same derivation. The two
    // refusal builders are structurally parallel and a supervisor cannot tell them
    // apart, so one of them being silent about freshness would be a hole that only
    // shows up on the day this path DOES serve a cached row.
    //
    // Reachability, stated rather than assumed: today this throw's reading is almost
    // always `measured`. The entry gate refuses over EVERY pending story's declared
    // commands, so a command that reaches here had no red row when the stage started —
    // it is a story that surfaced mid-attempt with a command the entry snapshot never
    // probed, and that command is measured now. `cached` is therefore unreached in the
    // shapes I could construct; it is set anyway because the derivation is shared and
    // a builder that hard-codes "measured" would be a claim, not a reading.
    ...(freshness === undefined ? {} : { signatureFreshness: freshness }),
  };
}

/**
 * `03-plan/`, or the plan a scope that skips Plan implies.
 *
 * The two are told apart from the WORKFLOW, not from the absence of a file: a
 * `03-plan/` that has not been written yet and a `03-plan/` that is never going
 * to be written are the same on disk and opposite in meaning, and only
 * `skips: [… plan …]` distinguishes them (spec §2.4). A scope that plans and has
 * not yet done so still gets the plain refusal it always got.
 *
 * A real plan always wins: if `03-plan/waves.yml` is there, it is executed, even
 * on a scope whose `skips:` names `plan`. Somebody wrote it on purpose.
 */
async function openPlan(
  ctx: ExecutorContext,
  workspace: WorkspaceContext,
  lines: string[],
): Promise<BuildPlan> {
  const wavesOnDisk = existsSync(join(ctx.runDir, PLAN_PHASE, "waves.yml"));
  if (!planIsSkipped(ctx.spec.skips) || wavesOnDisk) {
    return loadBuildPlan(join(ctx.runDir, PLAN_PHASE), workspace.commands, workspace.iterationCommands);
  }
  const parts = {
    runDir: ctx.runDir,
    runId: ctx.runId,
    runTitle: runTitleOf(ctx),
    scope: ctx.spec.scope,
    repos: ctx.repos,
    workspace,
    // The answers a human gave at this run's gates. They are what the one story
    // has to APPLY — without them the plan would only restate what What decided.
    facts: FactsStore.loadOrEmpty(factsPath(ctx.root)).facts,
    budgetUsd: ctx.budgetUsd,
  };
  if (ctx.discardPending) await rederiveImplicitPlan(ctx, workspace, parts, lines);
  const plan = loadImplicitPlan(parts);
  lines.push(describeImplicitPlan(plan, implicitPlanContent(parts)));
  return plan;
}

/**
 * `--discard-pending` on an implicit plan means "derive it again", not just
 * "rewrite the prompt".
 *
 * The bundle is a rendering of the plan, so throwing the bundle away and keeping
 * the plan re-hands the developer the same story — which is exactly what happened
 * on the aparece run of 2026-08-30: the operator fixed nothing by re-preparing,
 * because `loadImplicitPlan` writes the file once and reads it forever after.
 *
 * It is only safe while the story has produced NOTHING. Two conditions, both
 * checked, both named when they refuse: the file records no evidence and is not
 * settled (`implicitPlanIsStale`), and `git log <epic>..<story>` is empty. The
 * branches and the worktree are deliberately NOT re-cut — they are this run's
 * own, `run.yml` says so in `build.epic_branch`, and `openStory` adopts both.
 */
async function rederiveImplicitPlan(
  ctx: ExecutorContext,
  workspace: WorkspaceContext,
  parts: Parameters<typeof loadImplicitPlan>[0],
  lines: string[],
): Promise<void> {
  if (!existsSync(implicitPlanPath(ctx.runDir))) return;
  const kept = (why: string): void => {
    lines.push(`  · kept ${IMPLICIT_PLAN_REL} (--discard-pending re-derives only an unbuilt plan): ${why}`);
  };

  const blocker = implicitPlanIsStale(readFileSync(implicitPlanPath(ctx.runDir), "utf8"));
  if (blocker !== null) {
    kept(blocker);
    return;
  }
  const content = implicitPlanContent(parts);
  const storyBranch = storyBranchOf(ctx.runId, IMPLICIT_STORY_ID);
  const commits = await commitsBetween(repoDirOf(workspace, content.repo), content.branch, storyBranch);
  // A count git could not take is NOT "nothing was built" (gh #273). This guard
  // deletes the plan on a zero, so the failure used to land on the destructive
  // side: a branch carrying a developer's commits, counted against a base that
  // did not resolve, re-derived the plan out from under them. `null` keeps it,
  // the same direction #272 chose where the same zero would have deleted a
  // branch — the only safe reading of "I could not measure" is "leave it".
  if (commits === null) {
    kept(uncountedCount(content.branch, storyBranch));
    return;
  }
  if (commits > 0) {
    kept(`\`${storyBranch}\` carries ${String(commits)} commit(s) beyond \`${content.branch}\``);
    return;
  }
  discardImplicitPlan(ctx.runDir);
  lines.push(
    `  · re-derived ${IMPLICIT_PLAN_REL} (--discard-pending; no evidence, and no commit on ` +
    `\`${storyBranch}\` beyond \`${content.branch}\`)`,
  );
}

/**
 * Bin the prepared bundle(s) of this stage, the way `preparedRefusal` does for a
 * stage with no executor.
 *
 * `result.json` is the one that matters: `writeBundle` overwrites `prompt.md` and
 * `pending.json` on its own, but a stale result left by a killed session would be
 * read by the NEXT `--commit` as if it described the story just prepared.
 */
function discardBundles(ctx: ExecutorContext): readonly string[] {
  const lines: string[] = [];
  for (const dir of preparedBundles(ctx.runDir, ctx.stageId)) {
    // `dispatch-notes.md` is deliberately NOT in this list. It is an INPUT to the
    // rendering `--prepare` is about to redo, not an output of the one being
    // binned, and the operator who wrote it did not ask for it back.
    for (const file of [PENDING_FILE, RESULT_FILE, RAW_FILE]) rmSync(join(dir, file), { force: true });
    lines.push(`  · discarded the --prepare bundle in ${relative(ctx.root, dir)}/`);
  }
  // The reviewer half lives a level down (`<story>/review/`), so `preparedBundles`
  // does not see it — deliberately, so `preparedRefusal` cannot read one as a
  // developer bundle. It still has to be binnable: a stale review `result.json`
  // is read by the next `--commit --review` as a verdict on work it never saw.
  for (const dir of reviewBundles(ctx.runDir, ctx.stageId)) {
    for (const file of [PENDING_FILE, RESULT_FILE, RAW_FILE]) rmSync(join(dir, file), { force: true });
    lines.push(`  · discarded the reviewer bundle in ${relative(ctx.root, dir)}/`);
  }
  return lines;
}

/** `run.yml`'s `title:`, or the run id when the file will not open. */
function runTitleOf(ctx: ExecutorContext): string {
  try {
    const title = RunStore.open(ctx.runDir).run.title.trim();
    return title === "" ? ctx.runId : title;
  } catch {
    return ctx.runId;
  }
}

/**
 * What asking a fix list needs of a story — no worktree, no attempt (gh #329):
 * the settle pre-pass asks it of a `blocked` story before opening anything.
 */
type FixlistScope = Pick<StoryContext, "planned" | "repoDir" | "branch">;

/**
 * Which shape `closedFixlistCandidates` found a story in — the two doors a
 * fix list may leave nothing open behind: a `blocked` story whose last review
 * `approve`d (gh #329), or a `review` story a `fixlist` verdict parked (gh
 * #218). Both settle `done` with no spawn; only the wording differs.
 */
type ClosedFixlistKind = "blocked-approve" | "review-fixlist";

interface StoryContext {
  readonly planned: PlannedStory;
  readonly epic: PlannedEpic;
  readonly repoDir: string;
  readonly worktree: string;
  readonly branch: string;
  readonly epicBranch: string;
  readonly attempt: number;
  readonly previousAttempt: string;
  /** WHERE `previousAttempt` came from — the header depends on it (#211). */
  readonly previousAttemptKind: PreviousAttemptKind;
  /**
   * Touched paths the story's worktree has no copy of because they are not
   * committed at its branch — `01-what/` outputs and `run.yml` in a
   * `root_is_repo` workspace, which the run writes and nobody commits on Build's
   * cadence. The prompt says so; `existsSync` alone called them new files.
   */
  readonly notInWorktree: ReadonlySet<string>;
  /**
   * True when THIS call created the worktree, so it is a tree nothing has ever
   * installed into (gh #209). The install runs on a fresh tree only: a reopened
   * story's worktree already has whatever the first pass put there, and paying
   * for `npm ci` again on every review round is a cost nobody asked for.
   */
  readonly freshWorktree: boolean;
  /**
   * gh #286: the merge this attempt was handed, left in progress in the
   * worktree at dispatch. Absent on every attempt that is not a conflict turn.
   */
  readonly conflictTurn?: ConflictTurnPrompt;
}

class BuildSession {
  /** Every sub-agent this stage ran; `runNext` turns them into `run.yml` tasks. */
  readonly tasks: ExecutorTask[] = [];
  private readonly outcomes = new Map<string, StoryOutcome>();
  /**
   * Per story, the command the permission layer refused on an attempt that went
   * on anyway because its tree held committed work (gh #271). Set by `buildHalf`,
   * read by `settle` — the same shape as `reviewers`, so half B's five settle
   * paths need no sixth argument. Cleared at the top of every attempt.
   */
  private readonly refusals = new Map<string, string>();
  /**
   * Per story, the `Reached maximum budget (…)` a developer died on during an
   * attempt that went on anyway because its tree held work (gh #277). Same shape
   * and same lifetime as `refusals` above, for the same reason.
   */
  private readonly capDeaths = new Map<string, string>();
  /**
   * Stories whose LAST attempt settled on a red DoD and was requeued (gh #313).
   * Set by `settleHalf`, read by `driveStory` and `driveWaveHalves` to decide
   * whether another developer attempt follows — the red-DoD twin of `review` +
   * `changes`. Cleared at the top of every attempt, like the two maps above.
   */
  private readonly dodRequeued = new Set<string>();
  /** gh #286: stories `settleHalf` requeued as a conflict turn in THIS process — `dodRequeued`'s twin. */
  private readonly conflictRequeued = new Set<string>();
  /**
   * Per story, WHY no reviewer was spawned for it (gh #289) — the stage had less
   * left than a review costs. Same shape and same lifetime as the two maps above,
   * for the same reason: `settle` writes the record, the decision is taken one
   * step earlier, and no settle path grows an argument for it.
   */
  private readonly unfundedReviews = new Map<string, string>();
  /**
   * Stories this invocation settled from their BRANCH AS IT STANDS (#279), by
   * the person who signed the reopen.
   *
   * Held exactly the way `refusals` and `capDeaths` are, and for the same
   * reason: `settle` writes the record, and what it must say about WHO did the
   * work is decided one step earlier, in the half.
   */
  private readonly asIsSettlements = new Map<string, AsIsSettlement>();
  /**
   * The epic branches, worktrees and merges this invocation accumulated
   * (`build/worktrees.ts`). ONE instance, created here and passed by reference
   * everywhere the three private maps used to be read.
   */
  private readonly epics = new EpicState();
  private readonly lines: string[] = [];
  /**
   * The three bounds this invocation holds a review round to — the requeue
   * counter, the fix-list counter and the format-retry counter, three maps of
   * three different things (`build/reviewRound.ts`, where all three docstrings
   * went with their maps). ONE instance, created here and passed by reference.
   */
  private readonly counters = new ReviewCounters();
  /**
   * Which reviewer produced the verdict THIS invocation recorded, per story —
   * `null` for a host review nobody declared.
   *
   * Held here, and only for as long as the invocation, because it is not a bound:
   * the durable record is the log (`agent.spawned` for a spawn, the review check
   * event for a host declaration) and `build/reviewLedger.ts` reads it back from
   * there. This map exists so the story's own review log, written by `settle`
   * several calls later, does not have to re-read the file it is mid-way through
   * appending to.
   */
  private readonly reviewers = new Map<string, ReviewerProvenance | null>();
  /** The workspace prior every reviewer of THIS invocation is primed with (#74). */
  private readonly focus = new RecurringFocus();
  /** `buildExecutor`'s `withClaims` reads this on every exit path — including failures. */
  get claimedEpics(): ReadonlySet<string> {
    return this.epics.claimed;
  }
  /**
   * One branch per epic, or ONE branch for the run (issue #57).
   *
   * Resolved once, at construction, from three sources in this order:
   *
   *   1. `run.yml`'s `build.branch_model` — what this run already recorded.
   *      A run does not get to change its mind about branches it has cut.
   *   2. A non-empty `build.epic_branch` with NO model: a run that entered Build
   *      before the key existed. It stays `per-epic`, whatever its plan says, so
   *      the three closed runs and any in-flight one replay identically.
   *   3. The plan's own cross-epic dependencies.
   */
  readonly branchModel: BranchModel;
  /** The single writer every state-changing step goes through (see `SerialQueue`). */
  private readonly writes = new SerialQueue();
  /** stderr lines: advice for the operator, never a reason to stop. */
  private readonly advisories: string[] = [];
  /**
   * Every foreign-work stash this invocation tried to give back (#164).
   *
   * Held only to compose the report — the durable record is
   * `worktree.foreign_work_restored` on the log, and `pendingAsides` reads the
   * open ones back from there.
   */
  private readonly restores: RestoreOutcome[] = [];
  /** Stash hashes this INVOCATION has already tried to pop — see `restoreForeignWorkAside`. */
  private readonly restoreAttempted = new Set<string>();
  /**
   * What `refuseOnDirtyRepos` classified as foreign, held between the door that
   * DECIDES and the step that stashes — which are now two steps with two other
   * refusals between them (#164, review round 1).
   */
  private aside: readonly { readonly repo: string; readonly repoDir: string; readonly paths: readonly string[] }[] = [];
  /**
   * What this run measured on the untouched base tree (`build/preflight.ts`).
   *
   * Loaded lazily and once: a run resumed after a refusal must not re-pay for a
   * `dotnet test`, and a run that entered Build before this file existed must
   * not error on its absence.
   */
  private readonly preflight: PreflightCache;
  /** How many stories of one wave may be in flight at once. */
  private readonly lanes: number;
  /**
   * Stories this pass did NOT start because a dependency is mid-pipeline (#280)
   * — `review` or `in_progress`, re-offered by the next invocation. A wait
   * writes nothing to the story file and no outcome row; this is what lets
   * `## Unknowns` name the wait instead of "no attempt and no reason for it".
   */
  private readonly waits = new Map<string, DependencyHold>();
  /**
   * The developer cap a parallel wave's lane was FUNDED at (gh #325), keyed by
   * story, for exactly as long as that lane is in half A. Empty on the serial
   * path, which is what keeps `--parallel 1` byte-identical: every read below
   * falls through to `developerCap`.
   */
  private readonly laneCaps = new Map<string, number>();
  /**
   * gh #327: what a SPAWNED reviewer that returned `approve` was shown of its
   * story's open fix list — the file, the findings rendered into its prompt, and
   * the session that judged them. Written only by `spawnReviewer`, spent only by
   * `reviewAndSettle`; a host review never has an entry, so nothing a host signs
   * is auto-closed by a set this process did not render.
   */
  private readonly shownFixRounds = new Map<string, {
    readonly fixlist: FixlistOnDisk;
    readonly shown: readonly FixFinding[];
    readonly sessionId: string | null;
  }>();

  /**
   * The provider's quota WARNING, the first time one arrived on a turn's stream
   * (gh #298), or null while it never has.
   *
   * It is the park order, and it is one-way: a later `allowed` frame does not
   * clear it, because the window it warned about has not refilled — only the
   * reset it named does, and that is a `tldrx next` away.
   */
  private rateLimitPark: AgentRateLimit | null = null;
  /** The `agent.rate_limited` event is written once per stage, not once per story. */
  private rateLimitParked = false;

  constructor(
    private readonly ctx: ExecutorContext,
    private readonly workspace: WorkspaceContext,
    private readonly plan: BuildPlan,
    opening: readonly string[] = [],
  ) {
    this.lines.push(...opening);
    this.preflight = new PreflightCache(ctx.runDir);
    this.lanes = clampParallel(ctx.parallel);
    this.branchModel = resolveBranchModel(ctx.runDir, ctx.runId, plan.stories);
    if (this.branchModel.kind === "integration") {
      this.lines.push(`  · ${describeBranchModel(this.branchModel)}`);
    }
    // A `03-plan/budget.yml` that could not be used is stderr, not a refusal: the
    // caps fall back to the uniform share and the build carries on, but nobody
    // gets to think the Plan's prices were honoured when they were not.
    if (plan.priceIssue !== null) this.advisories.push(plan.priceIssue);
    // A plan priced past this stage is scaled, not refused — and said out loud
    // here, before a spawn, rather than learned from a dead developer (gh #281).
    const over = planOverStageAdvisory(this.capParts, this.capLever);
    if (over !== null) this.advisories.push(over);
  }

  // --- the three entry points ----------------------------------------------

  /** Headless: every wave, every story, in order, then the handoff. */
  async runAll(): Promise<ExecutorOutcome> {
    // ORDER IS LOAD-BEARING (#164, review round 1). Every refusal that can be
    // decided WITHOUT moving the operator's files is decided first; the stash is
    // the last step before anything is cut, and the one door that must come after
    // it — the base pre-flight, which needs the clean tree — restores on its way
    // out through `withRestore`.
    const refusal = await this.refuseOnDirtyRepos()
      ?? await this.refuseOnForeignEpic()
      ?? await this.setAsideForeign()
      ?? await this.refuseOnRedBase()
      ?? await this.refuseOnUnrunnableWorktree();
    if (refusal !== null) return refusal;
    this.recordGateFeedback();
    // gh #329: BEFORE the frontier walk, so a dependent of a story settled here
    // is asked against `done` rather than `blocked`.
    await this.settleClosedFixlists();

    for (const wave of this.plan.waves) {
      const pending: PlannedStory[] = [];
      for (const planned of wave.stories) {
        const status = this.statusOf(planned);
        const rescued = status === "blocked" ? this.blockedByFailedDeveloper(planned) : null;
        if (rescued !== null) {
          this.lines.push(
            `  · ${planned.story.id} was \`blocked\` by a developer that FAILED (${rescued}) — `
            + "that was never an attempt, so it is offered again",
          );
          pending.push(planned);
          continue;
        }
        // A row THIS loop blocked for a dependency that has since landed is not a
        // verdict on the story — nothing attempted it — so it is offered again
        // (#280). Every run before that fix left this shape on disk, and the one
        // it was measured on needed a person to `story reopen` both dependents.
        const released = status === "blocked" ? this.staleDependencyHold(planned) : null;
        if (released !== null) {
          this.lines.push(
            `  · ${planned.story.id} was \`blocked\` for dependency ${released}, which is now \`done\` — `
            + "that was never an attempt, so it is offered again",
          );
          // #361: written HERE, not left for `driveStory` to settle later. A
          // release only pushed onto `pending` was decided but not yet DONE —
          // and `driveStory`'s very first act is the gh #298 rate-limit park,
          // which returns before any write when the wall is already up from an
          // earlier story's turn. Measured live: a story released by this exact
          // branch, then parked before its own turn, stayed `blocked` on disk
          // across a whole further invocation — `gate.requested` kept reporting
          // it `blocked` with the generic `settled by an earlier \`tldrx next\``
          // reason `fromDisk` writes for a row this process never touched, and a
          // person had to `story reopen` it by hand. The release is a fact about
          // the DEPENDENCY the instant it is decided, not about whether THIS
          // pass also finds time to attempt the story — so it is persisted now,
          // and `driveStory` still owns whatever verdict the attempt itself earns.
          this.setStoryStatus(planned, "todo");
          pending.push(planned);
          continue;
        }
        if (status === "done" || status === "blocked") {
          this.lines.push(`  · ${planned.story.id} is already \`${status}\` — left alone`);
          continue;
        }
        // THE WAVE BOUNDARY ASKS PER STORY (#260). A dependency lives in an
        // EARLIER wave by construction (`plan/validatePlan.ts`, spec §5), so its
        // status is final and readable right here.
        //
        // BOTH PATHS, since #263. #260 built this frontier for the parallel path
        // alone, on the grounds that the sequential loop had no defect of its own
        // — it had one, and it was the one being measured: `lanes === 1` is the
        // default and it is what `run auto` runs, so a story parked `todo` by a
        // developer that died on its cap was followed one second later by the
        // dependent the next wave held, which then reached `done` over an epic
        // branch its dependency had put nothing on. That is an audit record
        // lying in the dangerous direction, and the frontier already answers
        // it exactly: ONE derivation (`blockingDependency`), asked per story, on
        // whatever number of lanes the operator chose. #260's own direction is
        // kept — a story that depends on NOTHING still runs after a parked one.
        //
        // TWO KINDS OF HOLD, since #280. A dependency that will not land in this
        // loop blocks the story with the reason; one at `review`/`in_progress`
        // is mid-pipeline and re-offered next invocation, so the dependent WAITS
        // — row untouched, asked again — because `blocked` is terminal here and
        // a terminal row over a story that is one re-review from `done` is what
        // left two dependents for a person to reopen (`build/dependencyHold.ts`).
        const held = this.blockingDependency(planned);
        if (held !== null) {
          if (dependencyIsPending(held.status)) this.waitOnDependency(planned, held);
          else this.blockOnDependency(planned, held);
          continue;
        }
        this.noteIfReopened(planned, status);
        pending.push(planned);
      }
      if (pending.length === 0) continue;

      if (this.lanes === 1) {
        // The v1 path, untouched. One story, start to finish, then the next.
        for (const planned of pending) await this.driveStory(planned);
        continue;
      }
      this.lines.push(
        `  · ${wave.id}: ${String(pending.length)} story(ies), ${String(Math.min(this.lanes, pending.length))} at a time`,
      );
      await this.driveWave(wave, pending);
      // Wave N+1 fanning out over code wave N failed to produce is how one red
      // story becomes N of them — and that rule is kept, per story, by the
      // `blockingDependency` frontier above. It used to be kept by BREAKING out
      // of the loop here, which also stopped every later story that never needed
      // the blocked one's code: a run told to build 8 built 5, left three stories
      // `todo` with their only dependency `done`, and reported the stage `done`
      // (#260). What is left here is the LINE, which names what happened; the
      // stories it holds back name themselves, with the dependency each waits on.
      if (this.waveFailed(wave)) {
        this.lines.push(
          `  · ${wave.id} ended \`failed\` — later stories that depend on its blocked work ` +
          "are recorded `blocked`; the rest carry on",
        );
      }
    }
    return await this.finish();
  }

  /**
   * In-session: prepare the bundle for the NEXT pending story and stop. One story
   * per prepare/commit cycle — the host session dispatches its own sub-agent, and
   * `--commit` picks the pipeline up at the DoD step.
   */
  async prepare(): Promise<ExecutorOutcome> {
    let planned = this.nextPending();
    // gh #329: a `blocked` story the pre-pass below may settle is not pending, so
    // "nothing pending" is not yet "nothing to do" while one exists.
    if (planned === null && this.closedFixlistCandidates().length === 0) return await this.finish();
    // ORDER IS LOAD-BEARING (#164, review round 1). Every refusal that can be
    // decided WITHOUT moving the operator's files is decided first; the stash is
    // the last step before anything is cut, and the one door that must come after
    // it — the base pre-flight, which needs the clean tree — restores on its way
    // out through `withRestore`.
    const refusal = await this.refuseOnDirtyRepos()
      ?? await this.refuseOnForeignEpic()
      ?? await this.setAsideForeign()
      ?? await this.refuseOnRedBase()
      ?? await this.refuseOnUnrunnableWorktree();
    if (refusal !== null) return refusal;
    // gh #329: the headless loop's pre-pass, at the same place relative to the
    // frontier — a story it settles is `done` before anything is offered.
    await this.settleClosedFixlists();

    // THE SAME FRONTIER THE HEADLESS LOOP ASKS (#300). Until this line the door
    // took `nextPending()` as offered, and `pendingStories` skips only `done`
    // and a terminal `blocked` — so a `todo` dependent of a story that had NOT
    // landed was handed out, and `--commit` merged it over an epic branch its
    // dependency put nothing on. Measured on the mixed shape #280 opened: a
    // headless pass leaves S2 waiting `todo` behind S1 at `review` (right), the
    // host's verdict blocks S1, and the next `--prepare` said `prepared S2`.
    const offered = this.offerAtFrontier();
    if (offered.kind === "wait") return refusedOnSequence(this.ctx, dependencyPrepareRefusal(offered.story, offered.held));
    if (offered.kind === "none") return await this.finish();
    planned = offered.planned;

    // A story waiting on nothing but a REVIEW gets its reviewer bundle written
    // here, and nothing is spawned — exactly like every other `--prepare`.
    //
    // Two histories reach this line. An errored review produced no `changes`
    // verdict, so no developer attempt is owed and none is offered: handing one
    // out is what this path did on 2026-08-30 (`task.started … attempt: 2,
    // mode: prepare`, for a diff nobody had read). And a review already handed to
    // the host is re-offered rather than re-decided.
    //
    // Until 2026-08-31 this path SPAWNED a metered reviewer under `--prepare`,
    // which is the one thing `--prepare` is supposed never to do: on the live
    // `260830-tenancy-identity-customers` a host timeout killed that spawn
    // mid-read and the story sat at `review` with the money gone. `--prepare`
    // writes a bundle; who dispatches it is the host's business.
    const review = this.reviewWorkFor(planned);
    if (review !== null) return await this.prepareReview(planned, review);

    // #279: the person signed "settle this branch, no developer", and
    // `--prepare` exists to hand a host a DEVELOPER bundle. Refused rather than
    // performed, because performing it is the exact thing that was signed
    // against — and refused rather than silently downgraded to a review bundle,
    // because the DoD and the merge have not run and a reviewer handed that
    // would be judging an unproven branch. The headless command is named.
    const asIs = this.asIsFor(planned);
    if (asIs !== null) {
      return refusedOnSequence(
        this.ctx,
        `${planned.story.id} was reopened \`--as-is\` by ${asIs.actor} (${asIs.note}) — the branch is to be `
        + "settled as it stands, and `--prepare` dispatches a developer. `tldrx next` (headless) runs the "
        + "dod, the review and the merge over it; to build it with a developer instead, "
        + `\`tldrx story reopen ${planned.story.id} --note "…"\` replaces the signature.`,
      );
    }

    // The fix-list ROUTER (design §B.4). `--fixlist <path>` names one explicitly;
    // absent, the latest round on disk is carried by itself — the same courtesy
    // `--prepare` already extends to a story waiting on a review, and for the
    // same reason: handing an author a bundle that omits the findings it is
    // being re-dispatched over is the mistake, not the convenience.
    // gh #218 (pre-merge review): every throw out of `fixlistFor` is a
    // PRECONDITION refusal decided before anything is opened, spent or
    // attempted — no worktree, no spawn, nothing this invocation did that the
    // next one needs undone. `failed()` was the wrong door: it reads as a
    // STAGE failure (`failStage`, exit 5), which stamps `run.yml` `status:
    // failed` and makes the next `tldrx next` print "retrying … (cost already
    // spent is not refunded)" — a lie, since nothing was ever spent here.
    // `refusedOnSequence` is the same shape `offerAtFrontier`'s "wait" case
    // and the as-is refusal a few lines below already use for exactly this —
    // exit 1 (usage / nothing-behind-it), `run.yml` untouched.
    let fixlist: FixlistOnDisk | null;
    try {
      fixlist = this.fixlistFor(planned.story.id, true);
    } catch (error) {
      return refusedOnSequence(this.ctx, error instanceof Error ? error.message : String(error));
    }

    this.noteIfReopened(planned, this.statusOf(planned));
    // `true`: a developer is about to be dispatched onto this branch, so it is
    // one of the two openings that may bring the base up to the epic tip (§F.2).
    const story = await this.openStory(planned, true);
    // gh #209, the in-session half: the host is about to run a developer in this
    // tree, so it gets the same install the headless path gets — and if the
    // install fails, the story blocks HERE rather than handing a human a bundle
    // pointing at a tree that cannot build.
    const install = await this.installDeps(story);
    if (install !== null && installFailed(install)) {
      await this.block(story, installFailureReason(install, planned.story.repo), 0);
      return await this.finish();
    }
    const cap = developerCap(this.capParts, planned.story.id, story.attempt);
    const key = this.bundleKey(planned.story.id);
    const notes = this.dispatchNotesFor(planned.story.id);
    this.lines.push(...describeDispatchNotes(notes));
    // Read BEFORE the bundle is rewritten: `writeBundle` leaves `result.json`
    // alone, so the id is still the PRIOR turn's, which is the one worth resuming.
    const resume = this.resumeSessionFor(planned.story.id);
    const pending: PendingStage = {
      version: 1,
      run: this.ctx.runId,
      phase: this.ctx.phaseId,
      stage: this.ctx.stageId,
      expert: "developer",
      model: this.model(),
      effort: this.ctx.effort,
      budget_usd: this.ctx.budgetUsd,
      max_budget_usd: cap,
      prompt: "prompt.md",
      outputs: [],
      sections: {},
      checks: this.ctx.spec.planned.checks,
      prepared_at: this.ctx.at,
      story: planned.story.id,
      // The developer's half of what the reviewer bundle has always carried. Its
      // absence was measured on a real workspace: `result_schema: false` on the
      // developer bundle, `true` on the reviewer's beside it, and a host guessing
      // the shape by copying a sibling story's `result.json`.
      result_schema: DEVELOPER_RESULT_SCHEMA,
      ...dispatchNotesRecord(notes),
      ...(fixlist === null ? {} : {
        fixlist: {
          path: fixlist.rel,
          round: fixlist.round,
          findings: fixlist.findings.length,
          open: openFindings(fixlist.findings).length,
        },
        resume_session: resume,
      }),
    };
    writeBundle(this.ctx.runDir, key, this.developerPrompt(story, fixlist), pending);
    if (fixlist !== null) {
      this.lines.push(
        `  · ${planned.story.id}: routing ${fixlist.rel} back to the author — `
        + `${String(openFindings(fixlist.findings).length)} of ${String(fixlist.findings.length)} `
        + "finding(s) still `fix-now`; this round spent no attempt",
        resume === null
          ? `  · ${planned.story.id}: no prior session_id on record — the bundle carries the fix list `
            + "and the merged commit instead"
          : `  · ${planned.story.id}: the prior author's session was \`${resume}\` — resume it if your `
            + "tooling can; the framework resumes nothing itself",
        `  · ${planned.story.id}: close each finding in ${fixlist.rel} as it lands `
          + "(`Resolved: yes <sha>`, naming the commit it landed as — a bare `yes` closes "
          + "nothing) or re-route its `Disposition:` — an open `fix-now` blocks `done`",
      );
    }
    // The story file is the state: `in_progress` is how `--commit` finds it again.
    this.setStoryStatus(planned, "in_progress");
    this.ctx.emit("task.started", {
      phase: this.ctx.phaseId,
      story: planned.story.id,
      wave: planned.wave,
      repo: planned.story.repo,
      branch: story.branch,
      attempt: story.attempt,
      mode: "prepare",
    });

    const dir = relative(this.ctx.root, agentDir(this.ctx.runDir, key));
    return {
      ok: true,
      awaiting: true,
      tasks: [],
      costUsd: 0,
      outputs: [],
      lines: [
        ...this.lines,
        `prepared ${planned.story.id} · ${planned.story.title} — ${dir}/prompt.md ` +
          `($${cap.toFixed(2)} ceiling, attempt ${String(story.attempt)} of ${String(this.attempts)})`,
        `dispatch ONE sub-agent with cwd ${relative(this.ctx.root, story.worktree)}`,
        `then write {outputs, questions_asked, notes} to ${dir}/result.json and run \`tldrx next --commit\``,
      ],
      stderr: [...this.advisories],
      error: null,
    };
  }

  /**
   * `tldrx next --prepare --review`: the reviewer bundle for the story at the
   * cursor, asked for by name.
   *
   * Bare `--prepare` already routes here on its own when a story is waiting on a
   * review (`reviewWorkFor`), so this is the explicit spelling rather than a
   * second behaviour — and the one that says something useful when the story is
   * NOT waiting on a review, instead of quietly preparing a developer.
   */
  async prepareReviewOnly(): Promise<ExecutorOutcome> {
    const planned = this.nextPending();
    if (planned === null) return await this.finish();
    const refusal = await this.refuseOnDirtyRepos()
      ?? await this.refuseOnForeignEpic()
      ?? await this.setAsideForeign();
    if (refusal !== null) return refusal;

    // The frontier, read and not recorded (#300): this spelling writes a review
    // bundle or nothing, and the cure below — "run `--prepare` for the developer
    // half" — would be false about a story the bare `--prepare` is going to
    // record `blocked`. The bare verb is the one that records; this one says why
    // there is nothing to review.
    const held = this.blockingDependency(planned);
    if (held !== null) return refusedOnSequence(this.ctx, dependencyPrepareRefusal(planned.story.id, held));

    const work = this.reviewWorkFor(planned) ?? this.reviewWorkFromLedger(planned);
    if (work === null) {
      // Order, not damage: the developer half has simply not run yet, and the
      // line already says which command runs it (gh #82).
      return refusedOnSequence(
        this.ctx,
        `${planned.story.id} has no merged commit to review — a story is reviewed after its developer turn, `
        + "not instead of one. Run `tldrx next --prepare` for the developer half first.",
      );
    }
    return await this.prepareReview(planned, work);
  }

  /**
   * Write the reviewer bundle for a story whose review is outstanding, and STOP.
   *
   * Nothing is spawned, nothing is settled and no money moves: this is the same
   * contract `--prepare` has for the developer, applied to the second role. The
   * bundle carries the prompt a spawned reviewer would have been given — the same
   * `buildReviewerPrompt`, byte for byte — plus the diff refs, the DoD recovered
   * from the ledger, and the envelope schema `--commit --review` will parse.
   */
  private async prepareReview(planned: PlannedStory, work: ReviewWork): Promise<ExecutorOutcome> {
    const story = await this.openStory(planned);
    // `null`, not `0`: this invocation did not watch the merge happen, so it
    // knows the story merged and does not know what the merge carried.
    this.noteMerged(story, null);
    this.lines.push(
      `  · ${planned.story.id}: ${work.why} — preparing the REVIEW only; `
      + `\`${work.commit}\` is already merged into \`${story.epicBranch}\``,
    );
    this.noteUnrecordedBase(planned.story.id, story.epicBranch, work.epicBase);
    // A `--prepare --review` over a story whose LAST envelope was refused must
    // not quietly drop the refusal: rewriting the prompt without it would hand
    // the host the same brief that produced the unreadable envelope (gh #78).
    const key = this.writeReviewBundle(story, work, this.pendingRefusal(planned.story.id));
    // The story file is the state: `review` is where a story waiting on a verdict
    // lives, and it is what `--commit --review` looks for. A story left
    // `in_progress` by a developer bundle that was never owed is moved back here.
    this.setStoryStatus(planned, "review");
    this.ctx.emit("task.started", {
      phase: this.ctx.phaseId,
      story: planned.story.id,
      wave: planned.wave,
      repo: planned.story.repo,
      branch: story.branch,
      attempt: story.attempt,
      role: "reviewer",
      mode: "prepare",
      resumed: "review",
    });

    const dir = relative(this.ctx.root, agentDir(this.ctx.runDir, key));
    return {
      ok: true,
      awaiting: true,
      tasks: this.tasks,
      costUsd: this.spent(),
      outputs: [...this.logPaths(), ...this.planOutputs(), ...this.retroOutputs()],
      lines: [
        ...this.lines,
        `prepared the REVIEW of ${planned.story.id} · ${planned.story.title} — ${dir}/prompt.md `
          + `(read-only, attempt ${String(story.attempt)} of ${String(this.attempts)})`,
        `dispatch ONE read-only sub-agent with cwd ${relative(this.ctx.root, story.worktree)}`,
        `then write {verdict, summary, findings} to ${dir}/result.json `
          + "— verdict is one of approve | fixlist | changes, NOT the `sign`/`refuse` gate "
          + "vocabulary — and run `tldrx next --commit --review`",
      ],
      stderr: [...this.advisories],
      error: null,
    };
  }

  /**
   * `tldrx next --commit --review`: the host's verdict, through the SAME seam a
   * spawned reviewer's goes through.
   *
   * `parseReview` narrows the envelope with its existing fail-closed rule — an
   * envelope this cannot read is `changes`, never `approve` — and `reviewAndSettle`
   * decides the story's fate exactly as it does after a spawn. One review, one
   * economy: no `agent.spawned` is emitted and no cent is metered.
   */
  async commitReview(): Promise<ExecutorOutcome> {
    this.recordGateFeedback();
    const planned = this.awaitingReview();
    if (planned === null) {
      // The refusal `260901-leaderboard-v2` earned on 2026-09-02, and the one
      // that used to fail the stage and the run with it. The message was always
      // right; what it did to the run was not (gh #82).
      return refusedOnSequence(
        this.ctx,
        "no reviewer bundle is out — run `tldrx next --prepare --review` first",
      );
    }
    const key = this.reviewBundleKey(planned.story.id);
    let envelope: Record<string, unknown>;
    try {
      envelope = readResultObject(this.ctx.runDir, key);
    } catch (error) {
      if (error instanceof PendingError) return this.refuseOnEnvelope(error, key, "reviewer", planned.story.id);
      throw error;
    }
    const work = this.reviewWorkFromBundle(planned.story.id) ?? this.reviewWorkFromLedger(planned);
    if (work === null) {
      return failed(
        this.ctx,
        `${planned.story.id} has no merged commit on the bundle or the ledger — `
        + "there is nothing this verdict is about",
        [],
      );
    }

    const story = await this.openStory(planned);
    this.noteMerged(story, null);
    const review = this.narrowFixlist(planned.story.id, parseReview(envelope, summaryOf(envelope)));
    // The reviewer half of #68: `--commit --review --cost-usd 1.10` is the same
    // declaration about the same kind of turn, so it takes the same precedence
    // over the envelope it did for the developer.
    const declaredReview = this.ctx.costUsd ?? numberOf(envelope.cost_usd);
    // The envelope was refused on its FORMAT and the round has a
    // correction left (gh #78). Nothing is recorded and nothing is settled: the
    // bundle stays out — its presence IS "a review is outstanding" — with the
    // refusal spliced into the prompt, and `--commit --review` picks the
    // corrected envelope up on the SAME attempt. Reached through the same
    // `isFormatRejection` the spawned door uses, so the two economies cannot
    // drift apart on what an attempt costs.
    const again = this.formatRetry(story, review, {
      costUsd: declaredReview ?? 0,
      sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
      metered: declaredReview !== undefined,
      tokens: this.ctx.tokens ?? numberOf(envelope.tokens),
    });
    if (again !== null) return this.reopenReviewBundle(story, work, again);
    this.recordReview(story, review, {
      costUsd: declaredReview ?? 0,
      sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
      // Billed to the HOST session, not metered here. `cost_usd: null` +
      // `metered: false` is the same spelling every other host turn gets.
      metered: declaredReview !== undefined,
      tokens: this.ctx.tokens ?? numberOf(envelope.tokens),
      source: "host",
      // The HOST's own declaration and nothing else. `--model`/`--effort` on
      // `tldrx next --commit --review` are what a host session says it judged
      // this diff with; with neither typed, this is null and every reader says
      // "not recorded" rather than repeating the bundle's suggestion back as a
      // measurement of somebody else's session.
      reviewer: this.hostDeclaredReviewer(),
    });
    await this.reviewAndSettle(story, work.dod, work.commit, 0, null, work.epicBase ?? null, review);
    // A settled handshake leaves the LOG, not the bundle: the bundle's presence
    // is what says "a review is outstanding", and one left behind would offer a
    // verdict that has already been counted.
    this.clearReviewBundle(key);

    if (this.nextPending() === null) return await this.finish();
    const outcome = this.outcomes.get(planned.story.id);
    return {
      ok: true,
      awaiting: true,
      tasks: this.tasks,
      costUsd: this.spent(),
      outputs: [...this.logPaths(), ...this.planOutputs(), ...this.retroOutputs()],
      lines: [
        ...this.lines,
        `${planned.story.id} → \`${outcome?.status ?? "?"}\` (host review, unmetered)`,
        this.nextAtFrontier(),
      ],
      stderr: [...this.advisories],
      error: null,
    };
  }

  /** In-session: continue the prepared story from the DoD step. */
  async commit(): Promise<ExecutorOutcome> {
    this.recordGateFeedback();
    const planned = this.inProgress();
    if (planned === null) {
      // The developer's half of the same mistake (gh #82).
      return refusedOnSequence(this.ctx, "no story is `in_progress` — run `tldrx next --prepare` first");
    }
    // The frontier on the settling door (#300). Asked BEFORE the envelope is
    // read, because the hold has nothing to do with what the host wrote: a
    // dependency that was `done` at `--prepare` and is not now — reopened,
    // blocked by a later verdict — is a story this one must not land over,
    // whatever `result.json` says. Refused, never `blocked`: there is a
    // developer's attempt on this branch, and the loop's row would say there
    // was none. The sentence names where the bundle and the work stay.
    const held = this.blockingDependency(planned);
    if (held !== null) {
      return refusedOnSequence(this.ctx, dependencyCommitRefusal(planned.story.id, held, {
        bundleDir: relative(this.ctx.root, agentDir(this.ctx.runDir, this.bundleKey(planned.story.id))),
        branch: storyBranchOf(this.ctx.runId, planned.story.id),
        worktree: relative(this.ctx.root, this.storyWorktree(planned)),
      }));
    }
    const key = this.bundleKey(planned.story.id);
    let result;
    try {
      result = readResult(this.ctx.runDir, key);
    } catch (error) {
      if (error instanceof PendingError) return this.refuseOnEnvelope(error, key, "developer", planned.story.id);
      throw error;
    }

    const story = await this.openStory(planned);
    // The cost of an in-session story turn is DECLARED, never measured: the
    // developer ran inside the host's session and was billed to it. Same
    // precedence, and the same three-value contract, `commitStage` uses for a
    // single-agent stage — `--cost-usd` first, then the envelope's own
    // `cost_usd`, and with NEITHER `null` + `metered: false` rather than `0`,
    // which is a measurement and a false one. Issue #68: this read the envelope
    // alone, so a host that declared $2.25 on the command line got a metered
    // $0.00 on the task row and `tldrx cost` reported 04-build at zero.
    const declared = this.ctx.costUsd ?? result.cost_usd;
    const cost = declared === null ? null : round2(declared);
    this.tasks.push({
      key: planned.story.id,
      model: this.model(),
      costUsd: cost ?? 0,
      sessionId: result.session_id,
      error: null,
      // The HOST ran this turn, but it ran it AS the developer — the role is
      // known here, so the row says it rather than inheriting the stage's (#234).
      role: "developer",
      outputs: result.outputs,
      ...(cost === null ? { metered: false } : {}),
      ...(this.ctx.tokens === null ? {} : { tokens: this.ctx.tokens }),
    });
    const route = await this.pipelineFromDod(story, cost ?? 0);
    // On an attended run the story is merged and its review is now the host's:
    // the bundle is out, nothing is settled, and the next command is the review
    // half — not `--prepare` for the story after this one.
    if (route === "handed-off") {
      return {
        ok: true,
        awaiting: true,
        tasks: this.tasks,
        costUsd: this.spent(),
        outputs: [...this.logPaths(), ...this.planOutputs(), ...this.retroOutputs()],
        lines: [...this.lines],
        stderr: [...this.advisories],
        error: null,
      };
    }

    if (this.nextPending() === null) return await this.finish();
    const outcome = this.outcomes.get(planned.story.id);
    return {
      ok: true,
      awaiting: true,
      tasks: this.tasks,
      costUsd: this.spent(),
      outputs: [...this.logPaths(), ...this.planOutputs(), ...this.retroOutputs()],
      lines: [
        ...this.lines,
        `${planned.story.id} → \`${outcome?.status ?? "?"}\``,
        this.nextAtFrontier(),
      ],
      error: null,
    };
  }

  // --- the pipeline ---------------------------------------------------------

  /** One story, with its at-most-one requeue after a `changes` verdict. */
  /**
   * Has a `run cancel --force` landed under this stage (gh #305)? Asked before
   * every spawn — here, in `fanOut`'s lanes and before the reviewer — because
   * this executor saves nothing until it returns, so the only way to see a
   * cancel that arrived mid-fan-out is to read the file. A `cancelled` run.yml
   * with a developer still spending is the record lying in the expensive
   * direction; the check costs one parse per spawn, against minutes of turn.
   */
  private cancelledUnder(): boolean {
    return RunStore.cancelledOnDisk(this.ctx.runDir);
  }

  private async driveStory(planned: PlannedStory): Promise<void> {
    // A story whose LAST review ERRORED is not owed a developer: its diff is
    // committed and merged, and its DoD went green. What is missing is the
    // review. Re-running the developer would throw away work nobody faulted and
    // charge for it twice.
    const resume = this.resumableReview(planned);
    let first = 0;
    if (resume !== null) {
      await this.rereview(planned, resume);
      // gh #327: the re-review's verdict is judged by the SAME rule as a fresh
      // one. A `changes` with attempts left (or a fix list with a fix-now open)
      // earned another developer attempt, and returning here left it unconsumed —
      // the story parked at `review` and every dependent waited on it. The loop
      // starts at the attempt the ledger now says is next (`attemptFor`, #313's
      // count), so the bound is the one every other requeue is held to.
      if (!this.owedAnotherPass(planned.story.id)) return;
      this.lines.push(`  · ${planned.story.id}: ${this.requeueLine(planned.story.id)}`);
      first = this.attemptFor(planned) - 1;
    }
    // `+ fixlistRounds`: a fix round spends no attempt, so it must not spend a
    // pass of this loop either — the per-story bounds (`attempt < attempts` at
    // every requeue, `narrowFixlist`'s round count) are what stop it.
    for (let i = first; i < this.attempts + this.fixlistRounds; i++) {
      // Per ATTEMPT, not per story: a requeue is a second developer spawn, and a
      // cancel that landed during the first attempt's review must stop it too.
      if (this.cancelledUnder()) {
        this.lines.push(
          `  · ${planned.story.id}: ${i === 0 ? "not started" : "not requeued"} — ${CANCELLED_UNDER_STAGE}`,
        );
        return;
      }
      // gh #298: the provider said the wall was close while an earlier turn was
      // still working. Stop HERE, at a story boundary with everything before it
      // settled, rather than spending this developer into the wall and recording
      // its death. Nothing waits and nothing retries — `tldrx next` picks the
      // run up, and the reset the provider stated is on the event.
      if (this.rateLimitPark !== null) {
        this.parkForRateLimit(planned.story.id, i === 0 ? "not started" : "not requeued");
        return;
      }
      await this.settleHalf(await this.buildHalf(planned));
      const outcome = this.outcomes.get(planned.story.id);
      // The developer never ran, so the story is back where it started and its
      // attempt is unspent. Spawning it again inside the same process, under the
      // same ceiling, would buy the same error twice — the operator raises a cap
      // (or the plan's price) between invocations, and that is the fix.
      if (outcome !== undefined && outcome.developerError !== null) return;
      // gh #313: a red DoD with attempts left is requeued like a `changes`
      // verdict — `settleRedDod` decided, and said why on the story's record.
      if (this.dodRequeued.has(planned.story.id)) {
        this.lines.push(`  · ${planned.story.id}: the DoD was red — requeued with its output`);
        continue;
      }
      // gh #286: a conflict an agent can own — requeued with the merge.
      if (this.conflictRequeued.has(planned.story.id)) {
        this.lines.push(`  · ${planned.story.id}: ${CONFLICT_REQUEUED_LINE}`);
        continue;
      }
      if (outcome?.status !== "review") return;
      // Only a real `changes` verdict buys another developer attempt. An errored
      // review leaves the story parked for the NEXT invocation's review-only
      // path — retrying the same reviewer under the same ceiling in the same
      // process would just buy the same error twice.
      // ... and a review that was never funded leaves it parked in exactly the
      // same place, for a stronger reason: the next spawn would be refused
      // before it happened (gh #289). `reviewStillOwed` is the one place the two
      // shapes are one question.
      if (reviewStillOwed(outcome)) return;
      // A fix list is a SIGNATURE with findings attached, not a fault: nothing
      // about the diff was rejected, so it spends no attempt. Until gh #327 it
      // also parked the story, on the grounds that its routing needed a host.
      // Owner decision (Slack q_mu23trkg8ae9c999, "A: ronda + auto-cierre"): the
      // headless run routes it itself — the developer is handed the list, the
      // next reviewer is shown its open findings, and that reviewer's approve
      // closes them. `settle` left the story at `review` only because a fix-now
      // is open, so the fix round is owed.
      if (!this.owedAnotherPass(planned.story.id)) return;
      this.lines.push(`  · ${planned.story.id}: ${this.requeueLine(planned.story.id)}`);
    }
  }

  /**
   * Did the story's LAST settle earn it another developer pass inside this
   * process (gh #327)? A `review` + `changes` (settled `review` only while an
   * attempt is left), or a `review` + `fixlist` (settled `review` only while a
   * `fix-now` is open — `open === 0` settles `done`). One predicate for the serial
   * loop, the wave's round filter and the re-review door, so the three cannot
   * disagree about which parked story is owed a turn.
   */
  private owedAnotherPass(storyId: string): boolean {
    const outcome = this.outcomes.get(storyId);
    if (outcome === undefined || outcome.status !== "review" || outcome.developerError !== null) return false;
    return outcome.verdict === "changes" || outcome.verdict === "fixlist";
  }

  /** The operator line for a `review`-settled requeue — which of the two verdicts bought it. */
  private requeueLine(storyId: string): string {
    return this.outcomes.get(storyId)?.verdict === "fixlist"
      ? FIX_ROUND_REQUEUED_LINE
      : "reviewer asked for changes — requeued once";
  }

  /**
   * One wave, N stories at a time (`--parallel N`, N > 1).
   *
   * Half A fans out; half B walks the wave's LISTED order, whatever order the
   * fan-out finished in. The requeue rule is unchanged and still at most one
   * extra attempt per story — it is applied to the whole wave rather than to one
   * story, so a second round is another fan-out.
   */
  private async driveWave(wave: BuildWave, pending: readonly PlannedStory[]): Promise<void> {
    // Stories waiting only on a REVIEW never enter the fan-out: half A is what
    // the lanes are for, and theirs is already done and merged. They are settled
    // first, serially, exactly as half B always runs.
    const queue: PlannedStory[] = [];
    for (const planned of pending) {
      const resume = this.resumableReview(planned);
      if (resume === null) {
        queue.push(planned);
        continue;
      }
      await this.rereview(planned, resume);
      // gh #327: a re-review that earned another pass joins the fan-out, exactly
      // as `driveStory` enters its attempt loop — same predicate, same bounds.
      if (this.owedAnotherPass(planned.story.id)) {
        this.lines.push(`  · ${planned.story.id}: ${this.requeueLine(planned.story.id)}`);
        queue.push(planned);
      }
    }
    await this.driveWaveHalves(wave, queue);
  }

  /** The fan-out proper: half A concurrently, half B in the wave's listed order. */
  private async driveWaveHalves(wave: BuildWave, pending: readonly PlannedStory[]): Promise<void> {
    let queue = [...pending];
    // `+ fixlistRounds` for `driveStory`'s reason: a fix round spends no attempt.
    for (let round = 0; round < this.attempts + this.fixlistRounds && queue.length > 0; round++) {
      const halves = await this.fanOut(queue);
      // The merge order is the file's, not the finish order. Two runs of the same
      // wave must produce the same epic branch, whatever the machine was doing.
      for (const planned of wave.stories) {
        const half = halves.get(planned.story.id);
        if (half === undefined) continue;
        await this.settleHalf(half);
      }
      // `review` + `changes` requeues, and since gh #327 so does `review` +
      // `fixlist` (its fix round). `review` + `error` means the reviewer never
      // judged the diff, and a second developer attempt is the one thing that
      // must NOT follow it — `owedAnotherPass` says no to it.
      const requeued = wave.stories.filter((p) =>
        halves.has(p.story.id) && (this.dodRequeued.has(p.story.id) || this.conflictRequeued.has(p.story.id)
          || this.owedAnotherPass(p.story.id)));
      for (const planned of requeued) {
        // gh #313: the red-DoD requeue rides the same round as `changes`.
        this.lines.push(this.dodRequeued.has(planned.story.id)
          ? `  · ${planned.story.id}: the DoD was red — requeued with its output`
          : this.conflictRequeued.has(planned.story.id)
            ? `  · ${planned.story.id}: ${CONFLICT_REQUEUED_LINE}`
            : `  · ${planned.story.id}: ${this.requeueLine(planned.story.id)}`);
      }
      queue = requeued;
    }
  }

  /**
   * Half A over a queue of stories, at most `lanes` in flight.
   *
   * A story that fails does NOT cancel its siblings: the whole point of a wave is
   * that its stories are independent, and killing four running sub-agents because
   * a fifth went red would throw away turns that have already been paid for.
   */
  private async fanOut(queue: readonly PlannedStory[]): Promise<Map<string, StoryHalf>> {
    const halves = new Map<string, StoryHalf>();
    let cursor = 0;
    // gh #325: what the lanes already dispatched may still spend. A lane's
    // reservation is its developer cap until its half A returns; from then on
    // `spent()` carries what it metered instead, and — when a review is ahead of
    // it — `awaitingReview` keeps that review's floor held, because half B runs
    // only after this whole fan-out does.
    const inFlight = new Map<string, number>();
    let awaitingReview = 0;
    let wake: () => void = () => {};
    let freed = new Promise<void>((resolve) => { wake = resolve; });
    const release = (): void => {
      const woken = wake;
      freed = new Promise<void>((resolve) => { wake = resolve; });
      woken();
    };
    const lane = async (): Promise<void> => {
      for (;;) {
        const planned = queue[cursor++];
        if (planned === undefined) return;
        const id = planned.story.id;
        for (;;) {
          // gh #305: the same pre-spawn question `driveStory` asks, per lane —
          // asked again after a wait, which can be minutes of a sibling's turn.
          if (this.cancelledUnder()) {
            this.lines.push(`  · ${id}: not started — ${CANCELLED_UNDER_STAGE}`);
            return;
          }
          // gh #298, the same park per lane: a sibling lane's turn saw the
          // provider's warning, so this lane dispatches nothing more. The lanes
          // already in flight finish and are settled by half B.
          if (this.rateLimitPark !== null) {
            this.parkForRateLimit(id, "not started");
            return;
          }
          // A story a PERSON finished spawns no developer (#279): nothing to fund.
          if (this.asIsFor(planned) !== null) break;
          // Decided and reserved with no `await` between them, so two lanes can
          // never both be funded off the same unreserved dollar.
          const funding = waveLaneFunding(this.capParts, this.spent(), {
            storyId: id,
            attempt: this.attemptFor(planned),
            inFlight: [...inFlight].map(([storyId, capUsd]) => ({ storyId, capUsd })),
            awaitingReview,
          });
          if (funding.kind === "dispatch") {
            inFlight.set(id, funding.capUsd);
            this.laneCaps.set(id, funding.capUsd);
            break;
          }
          this.lines.push(`  · ${funding.reason}`);
          await freed;
        }
        try {
          const half = await this.buildHalf(planned);
          halves.set(id, half);
          if (half.failure === null && half.developerError === null && half.commit !== null) awaitingReview += 1;
        } finally {
          inFlight.delete(id);
          this.laneCaps.delete(id);
          release();
        }
      }
    };
    // `allSettled`, then rethrow: a lane that throws (a `GitError`, or the
    // base-gate halt of issue #41) must not leave its siblings running DETACHED
    // behind an executor that has already returned — they would write to
    // `run.yml` and the story files after the caller stopped holding the lock.
    // The first rejection is still what the caller sees.
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(this.lanes, queue.length) }, lane),
    );
    const rejected = settled.find((outcome) => outcome.status === "rejected");
    if (rejected !== undefined && rejected.status === "rejected") throw rejected.reason;
    return halves;
  }

  /**
   * Keep the provider's quota warning, once (gh #298).
   *
   * `status: "allowed"` is a healthy turn reporting a healthy window and buys
   * nothing; anything else is the provider itself saying the wall is close, and
   * that is what parks the run. The test is the provider's own WORD, never a
   * utilization threshold this repo picked: the CLI already decides when a
   * window has surpassed its threshold, and a second opinion here would be a
   * second implementation of a judgement we do not own.
   */
  private noteRateLimit(frame: AgentRateLimit | null): void {
    if (frame === null || frame.status === "allowed" || this.rateLimitPark !== null) return;
    this.rateLimitPark = frame;
    this.lines.push(`  · the provider's rate limit is close: ${rateLimitLine(frame)}`);
  }

  /**
   * The line a story that was NOT started gets, and the event that records it
   * (gh #298). Absent-with-reason for every figure the frame did not state
   * (AGENTS.md §7) — a missing utilization is not a zero and a missing reset is
   * not a time.
   */
  private parkForRateLimit(storyId: string, what: "not started" | "not requeued"): void {
    const frame = this.rateLimitPark;
    if (frame === null) return;
    this.lines.push(`  · ${storyId}: ${what} — ${this.rateLimitReason(frame)}`);
    this.recordRateLimited(storyId);
  }

  /**
   * The warning, on the ledger, ONCE per stage (gh #298).
   *
   * `parked` is the first story the warning cost, and it is ABSENT when the
   * warning arrived with nothing left to park — the stage's last story, which is
   * the shape a one-story wave has. That absence is the whole reason this is not
   * written from the park alone: the FRAME is the fact worth recording, and it is
   * a fact whether or not this stage still had work to withhold. Measured on the
   * review of the first cut: a one-story build warned, said so on stdout, and
   * wrote zero rows — a record that is silent about the one thing the operator
   * would act on.
   */
  private recordRateLimited(parked: string | null): void {
    const frame = this.rateLimitPark;
    if (frame === null || this.rateLimitParked) return;
    this.rateLimitParked = true;
    this.ctx.emit("agent.rate_limited", {
      phase: this.ctx.phaseId,
      status: frame.status,
      ...(frame.window === null
        ? { window_absent: "not recorded — the provider's frame named no window" }
        : { window: frame.window }),
      ...(frame.utilization === null
        ? { utilization_absent: "not recorded — the provider's frame stated no utilization" }
        : { utilization: frame.utilization }),
      ...(frame.resetsAt === null
        ? { resets_at_absent: "not recorded — the provider's frame stated no resetsAt" }
        : { resets_at: frame.resetsAt }),
      ...(parked === null
        ? { parked_absent: "nothing was left to park — the warning arrived on this stage's last story" }
        : { parked }),
    }, 0, "build");
  }

  /**
   * Every exit from this executor writes the warning if the park never did
   * (gh #298). Called from the ONE wrapper `buildExecutor` returns through, so
   * there is no path — refusal, throw, or a finished stage — that can drop it.
   */
  flushRateLimited(): void {
    this.recordRateLimited(null);
  }

  /**
   * The park, in one sentence, for the operator line AND for the handoff row —
   * one derivation, so the two can never describe the same frame differently.
   *
   * A reset the provider did not state is NAMED as missing rather than left out:
   * "when does this clear" is the question the sentence exists to answer, and
   * silence there reads as "soon".
   */
  private rateLimitReason(frame: AgentRateLimit): string {
    return `${RATE_LIMIT_PARK_LINE}: ${rateLimitLine(frame)}`
      + (frame.resetsAt === null ? " — and it stated no reset instant, so nothing here knows when it clears" : "");
  }

  /**
   * The person's signature on this story, when there is one (#279) — read from
   * `events.jsonl`, because the reopen that wrote it was a different process.
   */
  private asIsFor(planned: PlannedStory): AsIsSettlement | null {
    return readReviewLedger(this.ctx.runDir, planned.story.id).asIs;
  }

  /**
   * Half A for a story a PERSON finished, settled from its branch AS IT STANDS
   * (#279): worktree → DoD → the commits that are already there. No developer.
   *
   * It is half A's shape with the one spawn removed, and everything after it —
   * `settleHalf`'s base update, its merge, its reviewer — is byte-for-byte the
   * path every other story takes. That is the whole design: the operator asked
   * for a turn without a developer, not for a turn without gates.
   *
   * **Why it cannot spawn one.** `tldrx story reopen` hands the story back to a
   * developer, and a developer handed a finished branch has nothing to commit;
   * #271's rule — work is measured SINCE THE SPAWN — then blocks the story after
   * one attempt, and it is right to, because work older than the spawn cannot be
   * told apart from a developer that did nothing. This is the case that rule
   * could not see, added beside it rather than carved out of it.
   *
   * **Two refusals, and neither is skippable.** The branch must carry something
   * its epic has not already got, measured with `commitsBetween` — whose `null`
   * is "could not count", never "did not move" (#273) — and the DoD must go
   * green, judged by the same `dodProves` every other story is judged by. There
   * is no flag that passes either: a verb that merges a branch nobody's agent
   * wrote is exactly where a `--force` would be added at 3 a.m. to unstick a run.
   *
   * **The worktree may be gone, and usually is.** A blocked story's tree is
   * pruned as it settles, and the person who fixed the branch by hand did it in
   * a scratch worktree they then removed — measured on the field fix this came
   * from. So the branch is found BY NAME and `openStory` reopens a worktree on
   * it, with `refreshBase` false: nothing may move the branch the person signed.
   */
  private async asIsHalf(planned: PlannedStory, asIs: AsIsSettlement): Promise<StoryHalf> {
    const id = planned.story.id;
    const before = this.statusOf(planned);
    this.refusals.delete(id);
    this.capDeaths.delete(id);
    this.unfundedReviews.delete(id);
    // Recorded BEFORE anything can refuse, because every one of the exits below
    // goes through `settle`, and all of them have to say a developer did not do
    // this.
    this.asIsSettlements.set(id, asIs);
    // `false`: this is the one opening that must NOT move the branch. A
    // fast-forward onto the epic here would change the tree the person proved
    // by hand, under a verb whose entire promise is "as it stands".
    const story = await this.writes.run(() => this.openStory(planned));
    await this.writes.run(() => {
      this.ctx.emit("task.started", {
        phase: this.ctx.phaseId,
        story: id,
        wave: planned.wave,
        repo: planned.story.repo,
        branch: story.branch,
        attempt: story.attempt,
        // ADDITIVE: this attempt has no developer, and a reader of the log must
        // not have to infer that from an `agent.spawned` that never arrives.
        as_is: true,
      });
      this.setStoryStatus(planned, "in_progress");
    });
    this.lines.push(
      `  · ${id}: settling \`${story.branch}\` as it stands — signed by ${asIs.actor}: ${asIs.note}`,
    );

    // A worktree this invocation had to re-create is a tree with no
    // `node_modules` in it, and the DoD below would measure that rather than the
    // person's work. Same call, same block-on-failure, as half A.
    const install = await this.installDeps(story);
    if (install !== null && installFailed(install)) {
      return {
        story, cost: 0, dod: [], commit: null,
        failure: installFailureReason(install, planned.story.repo),
        developerError: null, before,
      };
    }

    // Refusal 1: there has to BE something to take.
    const ahead = await commitsBetween(story.repoDir, story.epicBranch, story.branch);
    if (ahead === 0) {
      // gh #295, the named case BESIDE the refusal: under merge-before-review a
      // story's whole diff can be on the epic while nothing has judged it — a
      // reviewer that died, a later attempt that died on a refusal with no
      // work. Then "ahead of base" measures the wrong thing: there is nothing
      // to MERGE and there is something to SETTLE. The ledger's `lastMerge`
      // survives the reopen boundary precisely so this question can be asked:
      // which commit, onto which base, and did anything judge it. `n-a` and
      // `error` mean nothing did. Every other verdict STANDS — a `changes` is a
      // fix owed, an `approve` is a story that is done or blocked on its fix
      // list — and the refusal below says so rather than buying a third
      // opinion on the same bytes.
      const merge = readReviewLedger(this.ctx.runDir, id).lastMerge;
      if (merge !== null && reviewNeverCompleted(merge.verdict)) {
        return await this.reviewOnlyHalf(planned, asIs, story, before, merge);
      }
      return {
        story, cost: 0, dod: [], commit: null,
        failure: asIsNotAheadReason(
          story.branch, story.epicBranch, ahead, merge === null ? undefined : merge,
        ),
        developerError: null, before,
      };
    }
    if (ahead === null) {
      return {
        story, cost: 0, dod: [], commit: null,
        failure: asIsNotAheadReason(story.branch, story.epicBranch, ahead),
        developerError: null, before,
      };
    }

    // Refusal 2: the DoD, over the tree that is about to merge — the same
    // `dodProves`, the same `dodFailureReason`, as every other story.
    const dod = await this.runDod(story);
    if (!this.dodProves(dod)) {
      const failing = dodFailure(dod);
      return {
        story, cost: 0, dod, commit: null,
        failure: failing === undefined
          ? "the story declares no dod commands, so nothing could prove it"
          : dodFailureReason(failing, planned.story.repo),
        developerError: null, before,
      };
    }

    // The tip, and deliberately not `commitIfDirty`: uncommitted bytes in this
    // tree are not what the person signed, and committing them here would put
    // work on the branch under nobody's name. What the DoD just proved is the
    // tree as HEAD leaves it; anything else the tree is carrying is rescued by
    // `settle` under its own record (#129) if the story does not reach `review`.
    const commit = await headSha(story.worktree);
    if (commit === "") {
      return {
        story, cost: 0, dod, commit: null,
        failure: `\`${story.branch}\` has no HEAD to take — git could not resolve it`,
        developerError: null, before,
      };
    }
    return { story, cost: 0, dod, commit, failure: null, developerError: null, before };
  }

  /**
   * The REVIEW-ONLY case of an as-is settlement (gh #295): the story's work is
   * already on its epic from an earlier turn and nothing judged it. Nothing is
   * merged and no commit is invented — the DoD runs on the EPIC HEAD, and half
   * B hands the reviewer the range the story was merged as, off the ledger.
   *
   * Why the branch is brought up to the epic first: the story tip carries
   * nothing of its own (that is the precondition), so `--ff-only` onto the epic
   * loses nothing and invents nothing, and the DoD then measures the tree the
   * epic actually holds rather than a tip a sibling's merge has left behind.
   * `refreshStoryBase` says so when it cannot move it, and the DoD then runs on
   * the tip it names.
   */
  private async reviewOnlyHalf(
    planned: PlannedStory,
    asIs: AsIsSettlement,
    story: StoryContext,
    before: PlanStatus,
    merge: { readonly commit: string; readonly epicBase: string },
  ): Promise<StoryHalf> {
    const id = planned.story.id;
    const reviewed = { commit: merge.commit, epicBase: merge.epicBase };
    // The record must name the case before anything below can settle it.
    this.asIsSettlements.set(id, { ...asIs, reason: "review-only", reviewed });
    this.lines.push(
      `  · ${id}: ${AS_IS_REVIEW_ONLY_MARK} — \`${merge.commit.slice(0, 7)}\` is already on `
      + `\`${story.epicBranch}\` and nothing judged it; running the dod on the epic head and the review `
      + `over \`${reviewDiffRange(merge.epicBase, story.epicBranch, story.branch)}\``,
    );
    await this.writes.run(() =>
      this.refreshStoryBase(planned, story.repoDir, story.worktree, story.branch, story.epicBranch));
    const dod = await this.runDod(story);
    if (!this.dodProves(dod)) {
      const failing = dodFailure(dod);
      return {
        story, cost: 0, dod, commit: null,
        failure: failing === undefined
          ? "the story declares no dod commands, so nothing could prove it"
          : dodFailureReason(failing, planned.story.repo),
        developerError: null, before,
      };
    }
    return { story, cost: 0, dod, commit: merge.commit, failure: null, developerError: null, before, reviewOnly: reviewed };
  }

  /** Half A for one story: worktree → developer → DoD → commit. */
  private async buildHalf(planned: PlannedStory): Promise<StoryHalf> {
    // A story a PERSON finished takes the half that spawns nothing (#279). Here
    // rather than in `driveStory`, because both entries into half A — the serial
    // loop and the wave's fan-out — come through this one method.
    const asIs = this.asIsFor(planned);
    if (asIs !== null) return await this.asIsHalf(planned, asIs);
    // Read BEFORE `setStoryStatus` below overwrites it. A developer that dies
    // without delivering must leave the story exactly where it found it, and
    // "where it found it" stops being readable one line from here.
    const before = this.statusOf(planned);
    // A fresh attempt carries no refusal from the last one (gh #271) — cleared
    // here, before any early return, so a developer that fails on attempt 2
    // cannot settle with attempt 1's command on its record.
    this.refusals.delete(planned.story.id);
    this.capDeaths.delete(planned.story.id);
    this.unfundedReviews.delete(planned.story.id);
    this.dodRequeued.delete(planned.story.id);
    this.conflictRequeued.delete(planned.story.id);
    // gh #286: a conflict turn granted and not yet taken — read off the ledger,
    // so a turn granted by an invocation that ended is still handed out. Read
    // BEFORE the opening: a story owed a turn is not fast-forwarded, because the
    // merge below is the move it is owed.
    const owed = readReviewLedger(this.ctx.runDir, planned.story.id).conflictTurnOwed;
    // And no as-is signature either (gh #279). A story whose reviewer asked for
    // changes over a hand-finished branch is requeued to a REAL developer, and
    // that attempt's record must not say the branch was taken as it stands —
    // the one direction in which this record must never be wrong.
    this.asIsSettlements.delete(planned.story.id);
    // (a)(b)(c) touch the SHARED repo — `git branch`, `git worktree add` — so they
    // go through the one writer even though the sub-agent below does not.
    // `true`: same reason as `prepare()` — the headless developer is dispatched
    // onto this branch a few lines below (§F.2).
    const opened = await this.writes.run(() => this.openStory(planned, owed === null));
    await this.writes.run(() => {
      this.ctx.emit("task.started", {
        phase: this.ctx.phaseId,
        story: planned.story.id,
        wave: planned.wave,
        repo: planned.story.repo,
        branch: opened.branch,
        attempt: opened.attempt,
      });
      this.setStoryStatus(planned, "in_progress");
    });
    let story = opened;

    // (c½) gh #209: the declared `install:`, in this fresh tree, before a dollar
    // is spent. A failed install BLOCKS — it is the story's environment, and a
    // developer dispatched into a tree whose dependencies did not install cannot
    // prove anything and would block on the DoD anyway, having been paid for.
    const install = await this.installDeps(story);
    if (install !== null && installFailed(install)) {
      return {
        story, cost: 0, dod: [], commit: null,
        failure: installFailureReason(install, planned.story.repo),
        developerError: null, before,
      };
    }

    // (c¾) gh #286: the conflict turn this attempt is owed. The CURRENT epic tip
    // is merged into the story's worktree and the merge is left open for the
    // developer — before `handed` is read, so "what the developer changed" is
    // measured from the tree the merge left, markers and all.
    if (owed !== null) {
      const merge = await this.writes.run(() => openConflictTurnMerge({
        storyId: planned.story.id,
        repoDir: story.repoDir,
        worktree: story.worktree,
        branch: story.branch,
        epicBranch: story.epicBranch,
      }));
      if (merge.kind === "failed") {
        return {
          story, cost: 0, dod: [], commit: null,
          failure: `the conflict turn could not merge \`${story.epicBranch}\` into \`${story.branch}\`: ${merge.detail}`,
          developerError: null, before,
        };
      }
      const files = merge.kind === "conflicted" ? merge.files : [];
      story = { ...story, conflictTurn: { files, epicSha: merge.epicSha, landed: merge.landed } };
      this.lines.push(
        `  · ${planned.story.id}: conflict turn — merged \`${story.epicBranch}\` (${merge.epicSha.slice(0, 7)}) `
        + (files.length === 0
          ? "into the story and it went in clean this time; nothing is left to resolve"
          : `into the story and left the merge open in ${files.join(", ")} for the developer`),
      );
    }

    // The tree the developer is handed, so that afterwards "did it commit work"
    // is a comparison against THIS and not against a proxy (gh #271).
    const handed = await headSha(story.worktree);
    // A developer that FAILED is a TRANSPORT outcome, not a story that could not
    // be built: the sub-agent never wrote a line, so nothing about the work has
    // been learned and nothing about it may be settled. `failure` stays null —
    // that field blocks the story — and `developerError` parks it instead.
    //
    // gh #277: unless it left WORK. A developer killed by its own
    // `--max-budget-usd` mid-sentence is not a turn that never ran — it is a
    // story with a diff and no verdict, and the facilitator's DoD one step below
    // is the authority on whether that diff is a delivered story. This is #271's
    // rule over a second cause, not a second rule: same `workSince` comparison,
    // same "the DoD decides", same "the cause is recorded either way". The
    // narrowing to a CAP death is deliberate — a spawn that never started, a
    // timeout or a transport fault says nothing about a tree, while `Reached
    // maximum budget` says precisely that the turn was doing work when it
    // stopped.
    let developer = await this.spawnDeveloper(story);
    let budgetDeath: string | null = null;
    // Every turn's money, whether one spawn or two (gh #278) — never hidden.
    let spent = 0;
    // gh #278: how many re-spawns this attempt has bought on a chained refusal.
    let separatorRetries = 0;
    for (;;) {
      spent = round2(spent + developer.cost);
      const capDeath = developer.error !== null && diedOnCap(developer.error);
      if (developer.error !== null) {
        const proven = capDeath && await workSince({
          workspaceRoot: this.workspace.root, repoDir: story.repoDir, worktree: story.worktree, since: handed,
        });
        if (!proven) {
          return {
            story, cost: spent, dod: [], commit: null,
            failure: null, developerError: developer.error, before,
          };
        }
        budgetDeath = developer.error;
        this.capDeaths.set(story.planned.story.id, developer.error);
      }

      // (d½) gh #261: the turn asked for something this run's permission layer
      // refused, and in headless mode there is nobody to approve it. With NO
      // committed work, BLOCK, with the command named — do not let the story walk
      // on to a DoD that is green on an untouched tree, an empty commit and a
      // reviewer who faults a diff that was never written. `blocked` is where the
      // attempt stops (`driveStory` returns on any status that is not `review`),
      // which is the point: the same allowance would refuse the same command on
      // attempt 2.
      //
      // gh #271: with WORK in the tree — committed or not — the refusal is
      // RECORDED and the Definition of Done decides. Measured on a field run, the
      // refused call was the developer's own DoD command wrapped in shell plumbing,
      // and the block landed on a story the DoD one step below would have
      // measured. Uncommitted work counts because the normal path already says so:
      // `runDod` runs before `commitIfDirty`, and a developer refused while
      // VERIFYING never reaches its commit. "Work" is `workSince` — the tree
      // against the one handed, state dirs excluded, untracked-but-ignored files
      // not counted — so an empty commit and an untouched tree still block.
      if (developer.refused === null) break;
      const proven = await workSince({
        workspaceRoot: this.workspace.root, repoDir: story.repoDir, worktree: story.worktree, since: handed,
      });
      if (proven) {
        this.refusals.set(story.planned.story.id, developer.refused);
        break;
      }
      // gh #278: no work, and the refused line CHAINS commands — measured six
      // times in one day with #271's rule already in `## Rules`, on sonnet and
      // opus alike. Once, within this attempt, the developer is spawned again
      // with the cure as the prompt's first lines; the tree it is handed is the
      // same one (nothing was written), so `handed` still holds. ONLY a positive
      // `separator` classification: an ungranted verb will be ungranted again,
      // and a cause the line does not show cannot be cured by restating it —
      // both block as before, the verb with its cure named.
      if (classifyRefusal(developer.refused).kind === "separator" && separatorRetries < MAX_SEPARATOR_RETRIES) {
        separatorRetries += 1;
        developer = await this.spawnDeveloper(story, { after: developer.refused });
        continue;
      }
      return {
        story, cost: spent, dod: [], commit: null,
        failure: permissionBlockReason(developer.refused, {
          retried: separatorRetries > 0,
          declared: this.repoCommands(story.planned.story.repo),
        }),
        developerError: null, before,
      };
    }

    // (d⅞) gh #286: the MARKER GUARD, before the DoD and before any commit the
    // framework makes. A conflict turn that left a marker anywhere — committed
    // or not — or never closed the merge BLOCKS: a requeue would hand the same
    // tree to the same bound, and a DoD over markers proves nothing.
    //
    // gh #324: a path the guard could not READ is no longer counted clean. The
    // guard names it with its reason and the POLICY lives here, at the one call
    // site, in `UNCHECKED_PATH_POLICY` (`src/core/build/git.ts`) — `"refuse"`
    // blocks the attempt with the paths named, `"warn"` walks on with them named
    // on the Build lines. Either way they are named; only this line decides
    // whether the story survives them.
    if (story.conflictTurn !== undefined) {
      const left = await leftoverMerge(story.worktree, story.conflictTurn.files, handed);
      const verdict = markerGuardVerdict(left);
      const held = left.markers.length > 0 || left.inProgress;
      if (verdict.blocks) {
        return {
          story, cost: spent, dod: [], commit: null,
          failure: [
            ...(held ? [leftoverMergeReason(left.markers, left.inProgress)] : []),
            ...(verdict.unchecked === null ? [] : [verdict.unchecked]),
          ].join(" "),
          developerError: null, before,
        };
      }
      if (verdict.unchecked !== null) {
        this.lines.push(`  · ${story.planned.story.id}: warning — ${verdict.unchecked}`);
      }
    }

    // (d¾) gh #308: a story a PERSON put back with a note — a fix round or a
    // plain reopen — whose developer changed nothing since the tree it was
    // handed. Measured live: a `--for-fix` developer read the file, said it
    // "already satisfies every acceptance criterion", spent $1.69 and changed
    // nothing; the DoD below was green on the tree that was already accepted
    // once, `commitIfDirty` handed back the OLD head (a clean tree has one), the
    // merge was a no-op and the ledger closed the fix round on `done` alone. The
    // note names a concrete gap, and a tree that did not move cannot have closed
    // it — so BEFORE the DoD (its own build step must not count as work, and
    // there is nothing to pay it for), the same `workSince` the two refusal
    // branches above use decides: no work, and the attempt is refused with the
    // note's first line in the sentence. Only a reopened story: a first attempt
    // that lands nothing is rendered honestly as "added nothing" and reviewed
    // (build-executor: "honest merge rendering"), which is a pinned decision,
    // not this defect.
    const reopen = this.reopenFor(planned);
    if (reopen !== null) {
      const proven = await workSince({
        workspaceRoot: this.workspace.root, repoDir: story.repoDir, worktree: story.worktree, since: handed,
      });
      if (!proven) {
        return {
          story, cost: spent, dod: [], commit: null,
          failure: noDiffAfterReopenReason({ handed, ...reopen }),
          developerError: null, before,
        };
      }
    }

    // (e) the Definition of Done, re-run in the story's own worktree.
    //
    // An EMPTY dod is the one case the two kinds of plan answer differently: a
    // planned story that declares no command is a Plan bug and blocks, and an
    // implicit one is the framework saying this scope has nothing to run
    // (`dodIsSatisfiedEmpty`). Everything else — one red command — blocks either way.
    const dod = await this.runDod(story);
    if (!this.dodProves(dod)) {
      const failing = dodFailure(dod);
      const why = failing === undefined
        ? "the story declares no dod commands, so nothing could prove it"
        : dodFailureReason(failing, story.planned.story.repo);
      return {
        story,
        cost: spent,
        dod,
        commit: null,
        // A red DoD on a tree whose developer was also refused — or was killed by
        // its own cap (#277) — names BOTH: the DoD is the verdict, the other is
        // the cause a person triages first.
        failure: [
          why,
          ...(developer.refused === null
          ? []
          : [permissionBlockReason(developer.refused, { declared: this.repoCommands(story.planned.story.repo) })]),
          ...(budgetDeath === null
            ? []
            : [capDeathReason(budgetDeath, this.capParts, story.planned.story.id, story.attempt, this.capLever)
              + this.laneCapNote(story)]),
        ].join("; and "),
        developerError: null,
        before,
        // Only a red DoD with commands behind it can be requeued (gh #313); an
        // empty list is a plan that proves nothing, and stays a block.
        ...(failing === undefined ? {} : { redDod: { refused: developer.refused, budgetDeath } }),
      };
    }

    // (e) commit whatever the agent left behind, if it did not commit itself.
    const commit = await this.writes.run(() => this.commitIfDirty(story));
    if (commit === null) {
      return {
        story, cost: spent, dod, commit: null,
        failure: "the working tree could not be committed", developerError: null, before,
      };
    }
    return { story, cost: spent, dod, commit, failure: null, developerError: null, before, mayConflictTurn: true };
  }

  /**
   * Half B for one story: merge → review → done/blocked. Always serial.
   *
   * Returns `handed-off` when the review was written into a bundle for the host
   * instead of spawned — the story is merged and parked at `review`, and the
   * caller must say so rather than reporting a settled outcome it does not have.
   */
  private async settleHalf(half: StoryHalf): Promise<ReviewRoute> {
    const { story, dod, commit } = half;
    // gh #286: a conflict turn that ends anywhere but a clean commit leaves no
    // merge open behind it — a rescue's `git add -A` must never commit markers.
    if (story.conflictTurn !== undefined && (half.failure !== null || half.developerError !== null)) {
      await abortOpenMerge(story.worktree);
    }
    // A developer that FAILED comes first, because it is the one case where half
    // A produced no information at all. The story goes back to where it was, its
    // attempt unspent — see `parkDeveloperFailure`.
    if (half.developerError !== null) {
      await this.parkDeveloperFailure(story, half.developerError, half.cost, half.before);
      return "settled";
    }
    if (half.failure !== null && half.redDod !== undefined) {
      await this.settleRedDod(story, half.failure, half.cost, dod, half.redDod, half.before);
      return "settled";
    }
    if (half.failure !== null) {
      await this.block(story, half.failure, half.cost, dod);
      return "settled";
    }
    // `buildHalf` sets `failure` whenever it has no commit, so this is
    // unreachable — but the reviewer path needs a sha it can hand forward, and a
    // narrowing the compiler can see beats one it has to be told about.
    if (commit === null) {
      await this.block(story, "the story produced no commit to review", half.cost, dod);
      return "settled";
    }
    // gh #295: the work is already on the epic and only the review is owed.
    // Nothing below this line — base update, merge — may run: there is nothing
    // to merge, and a merge that moves nothing would still write a record
    // saying it did. `null` for `carried`, as `rereview` passes it: this
    // invocation did not watch the merge happen.
    if (half.reviewOnly !== undefined) {
      this.noteMerged(story, null);
      return await this.reviewAndSettle(story, dod, half.reviewOnly.commit, half.cost, null, half.reviewOnly.epicBase);
    }

    // (f0) the epic may have MOVED since this story's branch was cut (#268), and
    // the DoD above proved a tree that does not include what moved it. A wave
    // runs its stories at `--parallel N` from one tip and merges them one after
    // another, so every story but the first is in exactly this position. The
    // story branch is brought up to the epic in its OWN worktree and its DoD is
    // re-run on the result; the cost is one extra DoD per story, and only when
    // the epic actually moved.
    const update = await updateStoryBase({
      storyId: story.planned.story.id,
      repoDir: story.repoDir,
      worktree: story.worktree,
      branch: story.branch,
      epicBranch: story.epicBranch,
    });
    if (update.kind === "blocked") {
      // Nothing was merged and `mergeNoFf` has already aborted, so the story is
      // exactly where its developer left it — which is what makes naming the
      // files useful rather than cruel.
      const blocked = staleBaseConflict(
        story.branch, story.epicBranch, update.conflicts, update.detail,
        relative(this.ctx.root, story.worktree) || story.worktree,
      );
      // gh #286: ONE conflict turn, when an agent can own the conflict.
      const refused = half.mayConflictTurn === true
        ? conflictTurnRefusal({
          conflicts: update.conflicts,
          touches: story.planned.story.touches,
          turnsSpent: this.counters.conflictTurnsSpent(this.ctx.runDir, story.planned.story.id),
          attempt: story.attempt,
          attempts: this.attempts,
        })
        : null;
      if (half.mayConflictTurn === true && refused === null) {
        await this.requeueConflictTurn(story, update.conflicts, half.cost, dod, half.before);
        return "settled";
      }
      await this.block(
        story,
        refused === null ? blocked : `${blocked}. ${refused}`,
        half.cost,
        dod,
        { commit, conflicts: update.conflicts },
      );
      return "settled";
    }
    // The DoD that speaks for this story is the one that ran on the tree that is
    // about to merge. On the `current` path that is the one half A already ran,
    // and this story pays nothing at all.
    let proven = dod;
    if (update.kind === "updated") {
      this.lines.push(
        `  · ${story.planned.story.id}: \`${story.branch}\` was ${String(update.behind)} commit(s) behind `
        + `\`${story.epicBranch}\`${update.uncounted === null ? "" : ` (${update.uncounted})`} — merged the epic `
        + `into it (${update.from.slice(0, 7)} → ${update.to.slice(0, 7)}) and re-ran the DoD on the result`,
      );
      this.ctx.emit("story.base_updated", {
        phase: this.ctx.phaseId,
        story: story.planned.story.id,
        repo: story.planned.story.repo,
        branch: story.branch,
        base: story.epicBranch,
        from: update.from,
        to: update.to,
        commits: update.behind,
      });
      proven = await this.runDod(story);
      if (!this.dodProves(proven)) {
        const failing = dodFailure(proven);
        await this.block(
          story,
          `${failing === undefined
            ? "the story declares no dod commands, so nothing could prove it"
            : dodFailureReason(failing, story.planned.story.repo)}`
          + ` — re-run after \`${story.epicBranch}\` moved under \`${story.branch}\` `
          + `(${update.from.slice(0, 7)} → ${update.to.slice(0, 7)}); nothing was merged`,
          half.cost,
          proven,
          { commit },
        );
        return "settled";
      }
    }

    // (f) merge into the epic. A conflict blocks the story; the wave carries on.
    //
    // How much the merge is about to MOVE is measured first, because afterwards
    // it cannot be: once the story branch is an ancestor of the epic, `git diff
    // <epic>...<story>` is empty whether it carried thirty commits or none.
    // `null` when git could not count, and it travels as `null` all the way to
    // the epic row: an uncounted merge is `mergedEarlier` ("what it carried is
    // not recoverable"), never `emptyMerges` (gh #273). Before, a failed
    // `rev-list` read as 0 and printed a merge that moved real commits as one
    // that moved nothing — the 2026-08-30 empty-merge trap, in reverse.
    const carried = await commitsBetween(story.repoDir, story.epicBranch, story.branch);
    // The epic AS IT WAS. Captured here and nowhere else: after the merge the
    // story branch is an ancestor, and `git diff <epic>...<story>` — the command
    // the reviewer's prompt hands it — is empty whether the story carried thirty
    // commits or none (#166). `""` when git had no answer, which renders the
    // branch name exactly as it did before this existed.
    //
    // FULL sha, not `shaOf`'s abbreviation: this value is written into records
    // that outlive the process and are read back by a reviewer as a ref, and an
    // abbreviation is a prefix that can go ambiguous as the repo grows.
    const epicShaBefore = await fullShaOf(story.repoDir, story.epicBranch);
    const merge = await this.mergeIntoEpic(story);
    if (!merge.ok) {
      await this.block(story, `merge into \`${story.epicBranch}\` failed: ${merge.detail}`, half.cost, proven, {
        commit,
        conflicts: merge.conflicts,
      });
      return "settled";
    }
    this.noteMerged(story, carried);

    // (g)(h) the reviewer, and whatever it decides.
    return await this.reviewAndSettle(story, proven, commit, half.cost, carried, epicShaBefore);
  }

  /**
   * gh #286: a conflict an agent can own, settled as a requeue — #313's shape
   * exactly: back to the status the attempt started from, worktree KEPT, one
   * attempt spent — plus ONE `story.conflict_turn`, emitted after the settle so
   * the ledger reads the grant as owed to the NEXT attempt, not taken by this
   * one. `conflictTurnRefusal` has already said yes.
   */
  private async requeueConflictTurn(
    story: StoryContext,
    files: readonly string[],
    cost: number,
    dod: readonly DodResult[],
    before: PlanStatus,
  ): Promise<void> {
    const id = story.planned.story.id;
    const spent = this.counters.conflictTurnsSpent(this.ctx.runDir, id);
    const storySha = await fullShaOf(story.worktree, "HEAD");
    const epicSha = await fullShaOf(story.repoDir, story.epicBranch);
    this.counters.countConflictTurn(id, spent);
    this.conflictRequeued.add(id);
    await this.settle(story, before, {
      dod, commit: null, merged: false, carried: null, conflicts: files, verdict: "n-a",
      review: {
        verdict: "n-a", summary: "", findings: [], fixlist: [], fixlistProblems: [],
        formatProblems: [], verdictProblem: null,
      },
      keepWorktree: true,
      cost,
      reason: `bringing \`${story.branch}\` up to \`${story.epicBranch}\` conflicted in ${files.join(", ")} on attempt `
        + `${String(story.attempt)} of ${String(this.attempts)}, so the next attempt is handed the merge to resolve`,
    });
    this.ctx.emit("story.conflict_turn", {
      phase: this.ctx.phaseId,
      story: id,
      repo: story.planned.story.repo,
      branch: story.branch,
      base: story.epicBranch,
      attempt: story.attempt,
      files: [...files],
      epic_sha: epicSha,
      story_sha: storySha,
    });
  }

  /**
   * gh #313: a red Definition of Done, settled — requeued while attempts remain,
   * blocked on the last one.
   *
   * The red-DoD twin of the `changes` branch in `reviewAndSettle`, and the same
   * bound: `story.attempt < attempts`, with the attempts a red DoD spent read
   * back off the ledger. A requeued attempt settles back at the status it
   * started from — not `review`, because nothing merged and nothing judged it,
   * and not `blocked`, because it is about to be dispatched again — with its
   * worktree KEPT, so the next attempt continues in the tree whose output it is
   * handed (`previousAttemptFor` cites the kept DoD output from the log this
   * settle writes).
   *
   * Every failure that is not a plain red — a refused developer, a cap death, a
   * refused or absent DoD command — never reaches here with `requeue` true, and
   * blocks with today's sentence (`dodRedRequeue`).
   */
  private async settleRedDod(
    story: StoryContext,
    failure: string,
    cost: number,
    dod: readonly DodResult[],
    cause: NonNullable<StoryHalf["redDod"]>,
    before: PlanStatus,
  ): Promise<void> {
    const id = story.planned.story.id;
    const spent = this.counters.dodRequeuesSpent(this.ctx.runDir, id);
    const requeue = dodRedRequeue({
      dod, ...cause, attempt: story.attempt, attempts: this.attempts,
      // gh #360: the `undeclared` refusal kind is only decidable with the
      // workspace's own declared commands beside it — see `classifyRefusal`.
      declared: this.repoCommands(story.planned.story.repo),
    });
    if (requeue) {
      this.counters.countDodRequeue(id, spent);
      this.dodRequeued.add(id);
      // Back to where the attempt found it — `parkDeveloperFailure`'s shape for
      // the other transient settle — not `blocked`: a `tldrx status`, a dashboard
      // or a `story reopen` reading the file between the two attempts must not see
      // a terminal state for a story about to be dispatched again. A process that
      // dies here leaves the story offerable, and the ledger's `redDodAttempts`
      // (not this process's memory) is what holds its next attempt to the bound.
      await this.settle(story, before, {
        dod, commit: null, merged: false, carried: null, conflicts: [], verdict: "n-a",
        review: {
          verdict: "n-a", summary: "", findings: [], fixlist: [], fixlistProblems: [],
          formatProblems: [], verdictProblem: null,
        },
        keepWorktree: true,
        cost,
        reason: `the DoD was red on attempt ${String(story.attempt)} of ${String(this.attempts)}, `
          + `so the next attempt is handed its output: ${failure}`,
      });
      return;
    }
    // Attempts that went red in a row in THIS process, this one included. One is
    // today's block, sentence unchanged; more than one says so, because "blocked
    // on its DoD" over two paid attempts reads like one.
    const red = spent + 1;
    await this.block(
      story,
      red > 1 ? `the DoD stayed red on ${String(red)} of ${String(this.attempts)} attempts: ${failure}` : failure,
      cost,
      dod,
    );
  }

  /**
   * (g)(h): the reviewer over an already-merged diff, and the story's fate.
   *
   * Split out of `settleHalf` because it is reachable two ways — after a fresh
   * developer attempt, and on its own for a story whose previous review ERRORED.
   * The second entry is the whole point: everything before this line (worktree,
   * developer, DoD, commit, merge) already happened and is not repeatable
   * cheaply, and a review that never returned a verdict is not a reason to redo
   * any of it.
   */
  private async reviewAndSettle(
    story: StoryContext,
    dod: readonly DodResult[],
    commit: string,
    priorCost: number,
    carried: number | null,
    /**
     * The epic's sha immediately before this story merged (#166) — the base the
     * reviewer's `git diff` starts from. `null` (and `""`) mean it could not be
     * named, which renders the epic BRANCH: the bytes every review had before
     * this existed, and what a run resumed off a pre-#166 ledger still gets.
     */
    epicBase: string | null,
    supplied?: Review,
  ): Promise<ReviewRoute> {
    // The HOST's review, already parsed and already recorded by `commitReview`.
    // It reaches the same three branches below by the same rules — that is the
    // whole point of injecting it here rather than settling it somewhere else.
    if (supplied === undefined && this.ctx.attendedByHost) {
      await this.handOffReview(story, dod, commit, priorCost, carried, epicBase);
      return "handed-off";
    }
    // gh #289, and it happens BEFORE the spawn because that is the whole fix: a
    // reviewer capped under `REVIEWER_FLOOR_USD` is a turn that provably cannot
    // read the diff, and paying for it spends the money AND loses the story.
    // `supplied` is the HOST's review — it costs this stage nothing, so the
    // stage's remainder has no say over it.
    if (supplied === undefined && reviewerUnderfunded(this.capParts, this.spent())) {
      const review = this.refuseUnfundedReview(story);
      await this.settle(story, "review", {
        dod, commit, merged: true, carried, epicBase, verdict: "n-a", review,
        cost: round2(priorCost),
        reason: review.summary,
      });
      return "settled";
    }
    // gh #305: a `run cancel --force` that landed during the developer's turn (or
    // its DoD) stops HERE — the reviewer is a spawn, and a cancelled run buys no
    // more of them. The diff is merged on the epic branch and nobody has judged
    // it, so the story parks at `review` with an `n-a` verdict that says why,
    // exactly the shape an unfunded review parks it in: no reviewer ran, and
    // nothing here claims one did.
    if (supplied === undefined && this.cancelledUnder()) {
      const review = reviewerUnfunded(
        "the run was cancelled (tldrx run cancel) before the review — the diff is merged on the epic "
          + "branch and nobody has judged it",
      );
      this.ctx.emit("check.failed", {
        phase: this.ctx.phaseId,
        check: "review",
        story: story.planned.story.id,
        verdict: review.verdict,
        attempt: story.attempt,
        detail: review.summary,
      });
      await this.settle(story, "review", {
        dod, commit, merged: true, carried, epicBase, verdict: "n-a", review,
        cost: round2(priorCost),
        reason: review.summary,
      });
      return "settled";
    }
    const outcome = supplied === undefined
      ? await this.spawnReviewer(story, dod, epicBase)
      : { review: supplied, cost: 0 };
    const review = outcome.review;
    const cost = round2(priorCost + outcome.cost);

    // A reviewer that FAILED said nothing about the diff. The story parks at
    // `review` — pending, worktree kept, requeue counter untouched — and the next
    // `tldrx next` re-runs the REVIEW, not the developer.
    if (review.verdict === "error") {
      await this.settle(story, "review", {
        dod, commit, merged: true, carried, epicBase, verdict: "error", review, cost,
        reason: `the reviewer FAILED and returned no verdict — ${review.summary}`,
      });
      return "settled";
    }

    // The THIRD verdict: signed, and with findings the acceptance criteria never
    // covered (design §B.4). The story parks at `review` with a fix list beside
    // it, exactly where an errored review parks it — and for the same reason:
    // nothing about the diff was faulted, so nothing is owed a second developer
    // attempt. `recordReview` has already declined to count it against the
    // requeue counter; here it is declined against the story's fate too.
    if (review.verdict === "fixlist") {
      const rel = this.writeFixlistFor(story, review, commit, epicBase);
      const open = openFindings(review.fixlist).length;
      // gh #295: a fix list with NOTHING to fix now is a signature and nothing
      // else — every finding was routed to the owner (`defer-with-log`), refuted
      // or put out of scope, so no developer is owed a round. Measured on a live
      // run: a two-finding list, both `docs`/`defer-with-log`, parked the story
      // at `review` and bought a fix round that died four times with nothing to
      // fix (#294). Decided off the PARSED list — the dispositions the file
      // carries, #255's routing included — not off the reviewer's words, and by
      // exactly the count the line above prints. The artifact is still written
      // and the deferred findings still reach `retro.md`: settling the story
      // does not settle what it deferred.
      if (open === 0) {
        this.lines.push(`  · ${story.planned.story.id}: ${FIXLIST_SETTLED_MARK} (${rel})`);
        await this.settle(story, "done", {
          dod, commit, merged: true, carried, epicBase, verdict: "fixlist", review, cost, reason: null,
        });
        return "settled";
      }
      await this.settle(story, "review", {
        dod, commit, merged: true, carried, epicBase, verdict: "fixlist", review, cost,
        reason: `the reviewer SIGNED with a fix list — ${String(review.fixlist.length)} finding(s), `
          + `${String(open)} to fix now (${rel})`,
      });
      return "settled";
    }

    const requeue = review.verdict === "changes" && story.attempt < this.attempts;
    if (review.verdict === "changes") {
      await this.settle(story, requeue ? "review" : "blocked", {
        dod, commit, merged: true, carried, epicBase, verdict: "changes", review, cost,
        reason: requeue
          ? `the reviewer asked for changes: ${review.summary}`
          : `the reviewer asked for changes twice: ${review.summary}`,
      });
      return "settled";
    }

    // A story may not reach `done` over a finding somebody wrote down and nobody
    // dispositioned. The check is against the FILE, not against the envelope that
    // produced it, because the file is the state: a host closes a finding by
    // writing one word in it, and the whole point of the artifact is that the
    // decision outlives the turn that raised it.
    // gh #327 (owner decision "A: ronda + auto-cierre"): a SPAWNED fix-round
    // reviewer that was shown the open findings and approved has closed them —
    // written into the file before the file is asked, so the one gate below
    // (`openFixNow`, with its git verification) judges the closure like any other
    // claim. A host review has no shown set and closes nothing here.
    if (supplied === undefined) this.closeShownFixRound(story, commit);
    const open = await this.openFixNow(story);
    if (open !== null) {
      // Not `block()`: that one is for a story nothing judged, and it would
      // record `verdict: n-a` and `not merged` over a diff a reviewer APPROVED
      // and a merge that happened. The story is blocked on the fix list and on
      // nothing else, and the log has to say exactly that.
      await this.settle(story, "blocked", {
        dod, commit, merged: true, carried, epicBase, verdict: "approve", review, cost, reason: open,
      });
      return "settled";
    }

    // (h) done — DoD green AND the reviewer approved. Write the evidence.
    await this.settle(story, "done", {
      dod, commit, merged: true, carried, epicBase, verdict: "approve", review, cost, reason: null,
    });
    return "settled";
  }

  /**
   * Stories that MAY settle `done` on their fix list alone, off files only:
   * either a `blocked` story whose last settlement was a `blocked` over an
   * `approve` naming the merged commit (gh #329), or a `review` story parked
   * there by a `fixlist` verdict (gh #218) — and in both cases the latest fix
   * list no longer SAYS anything is open. `settleClosedFixlists` asks git the
   * rest.
   *
   * The `review`/`fixlist` shape is #218's own measurement: a reviewer signs
   * `fixlist` with an open `fix-now` finding, the story parks `review` owing a
   * developer round, and the finding is later re-routed away from `fix-now` by
   * hand — not through the audited auto-close (`closeShownFixRound`), which
   * only ever closes what a SPAWNED reviewer that approved was shown. Nothing
   * else re-reads the file, so without this the next `--prepare` or headless
   * pass reads `fixlistFor`'s unnamed door returning `null` (0 open — correct,
   * it is not to be re-rendered) as "no fix list ever happened" and hands out
   * a fresh plain developer bundle for a story nothing faults, which then buys
   * a whole DoD re-run over an unchanged tree.
   */
  private closedFixlistCandidates(): readonly { readonly planned: PlannedStory; readonly kind: ClosedFixlistKind }[] {
    const rows: { planned: PlannedStory; kind: ClosedFixlistKind }[] = [];
    for (const wave of this.plan.waves) {
      for (const planned of wave.stories) {
        const status = this.statusOf(planned);
        const kind: ClosedFixlistKind | null = status === "blocked"
          ? "blocked-approve"
          : status === "review" ? "review-fixlist" : null;
        if (kind === null) continue;
        const ledger = readReviewLedger(this.ctx.runDir, planned.story.id);
        const settled = ledger.lastSettled;
        const merge = ledger.lastMerge;
        if (settled === null || merge === null) continue;
        const matches = kind === "blocked-approve"
          ? settled.status === "blocked" && settled.verdict === "approve" && merge.verdict === "approve"
          : settled.status === "review" && settled.verdict === "fixlist" && merge.verdict === "fixlist";
        if (!matches) continue;
        if (settled.commit !== merge.commit) continue;
        const fixlist = latestFixlist(this.ctx.runDir, BUILD_PHASE, planned.story.id);
        // gh #218 (correctness half): `unreadable` must be empty too. A parse
        // that dropped a heading (a typo'd `Disposition:`) or read no heading
        // at all (a truncated file) reads back as `findings: []` /
        // `openFindings === 0` exactly like a genuinely closed round — this is
        // the one check `openFixNow` (below) and this cheap off-files check
        // must BOTH make, since this candidate list decides who is even ASKED.
        // Kept PURE (no `this.lines` here): this method is also called from
        // `prepare()`'s early-exit `.length` probe, before `settleClosedFixlists`
        // runs, and a side effect here would print the same line twice.
        if (fixlist === null || fixlist.unreadable.length > 0 || openFindings(fixlist.findings).length > 0) continue;
        rows.push({ planned, kind });
      }
    }
    return rows;
  }

  /**
   * Settle `done`, with NO spawn, every candidate `closedFixlistCandidates`
   * names: a `blocked` story whose last review approved (gh #329), or a
   * `review` story parked on a spent `fixlist` round (gh #218) — in both
   * cases the fix list now has nothing open.
   *
   * Measured live (gh #329): a fix landed, the reviewer approved it, the story
   * blocked on a `Resolved: no` nobody had rewritten — and once a person
   * rewrote it, no verb re-read the file: `story reopen` handed a developer
   * nothing to do (#308 refused it) and `--as-is` refused a branch already on
   * its epic. The review that decides this already happened; what was missing
   * was asking `openFixNow` again. It is asked exactly as `reviewAndSettle`
   * asks it — `verifyResolutions` holds each `Resolved: yes` to git first, and
   * a claim that does not check out is rewritten `claimed-unverified` and the
   * story stays put.
   */
  private async settleClosedFixlists(): Promise<void> {
    for (const { planned, kind } of this.closedFixlistCandidates()) {
      const id = planned.story.id;
      const scope: FixlistScope = {
        planned,
        repoDir: repoDirOf(this.workspace, planned.story.repo),
        branch: storyBranchOf(this.ctx.runId, id),
      };
      if (await this.openFixNow(scope) !== null) continue;
      const ledger = readReviewLedger(this.ctx.runDir, id);
      const merge = ledger.lastMerge;
      if (merge === null) continue;
      const rel = latestFixlist(this.ctx.runDir, BUILD_PHASE, id)?.rel ?? "its fix list";
      const verdict = kind === "blocked-approve" ? "approve" : "fixlist";
      const summary = kind === "blocked-approve"
        ? `no reviewer ran for this settlement: the approve recorded over \`${merge.commit}\` stands, `
          + `and every \`fix-now\` finding in ${rel} is now closed or routed away`
        : `no developer round ran for this settlement: the reviewer's fix-list signature over `
          + `\`${merge.commit}\` stands, and every \`fix-now\` finding in ${rel} is now closed or routed away`;
      this.lines.push(
        kind === "blocked-approve"
          ? `  · ${id} was \`blocked\` on its fix list only — its last review approved \`${merge.commit}\` and `
            + `${rel} has nothing open now, so it settles \`done\` with no agent spawned`
          : `  · ${id} was parked \`review\` on its fix list only — its last review signed \`${merge.commit}\` `
            + `with a fix list, and ${rel} has nothing open now, so it settles \`done\` with no agent spawned`,
      );
      const story = await this.writes.run(() => this.openStory(planned));
      await this.settle(story, "done", {
        dod: ledger.dod, commit: merge.commit, merged: true, carried: null, epicBase: merge.epicBase,
        verdict,
        review: {
          verdict, summary, findings: [], fixlist: [], fixlistProblems: [],
          formatProblems: [], verdictProblem: null,
        },
        cost: 0, reason: null,
      });
    }
  }

  /**
   * Auto-close what an approving fix-round reviewer was shown (gh #327).
   *
   * Only the file that reviewer was shown, and only while it is still the
   * story's latest round: a newer round is a newer review's business. The
   * provenance names the turn — its session, the attempt, the run — so the record
   * says who closed each line and on what evidence, never just that it closed.
   */
  private closeShownFixRound(story: StoryContext, commit: string): void {
    const id = story.planned.story.id;
    const round = this.shownFixRounds.get(id);
    this.shownFixRounds.delete(id);
    if (round === undefined) return;
    const latest = latestFixlist(this.ctx.runDir, BUILD_PHASE, id);
    if (latest === null || latest.path !== round.fixlist.path) return;
    const provenance = `reviewer session ${round.sessionId ?? "not recorded"}, attempt ${String(story.attempt)}, `
      + `run ${this.ctx.runId}`;
    const { text, closed } = autoCloseShown(readFileSync(latest.path, "utf8"), round.shown, commit, provenance);
    if (closed.length === 0) return;
    writeFileSync(latest.path, text, "utf8");
    this.lines.push(
      `  · ${id}: fix-list finding(s) ${closed.map((n) => `#${String(n)}`).join(", ")} in ${latest.rel} `
      + `${AUTO_CLOSED_MARK} — \`Resolved: yes ${commit}\``,
    );
  }

  /**
   * Write `04-build/fixlist/<story>-<n>.md`, and route what it says.
   *
   * The executor writes it, never the reviewer — the same rule `renderReviewLog`
   * follows, and for the same reason: `REVIEWER_TOOLS` is `Read`, `Grep`, `Glob`
   * and `Bash(git diff *)`, so the role that found the defects holds no pen.
   *
   * `defer-with-log` findings go on to `retro.md`'s `## Build feedback` — the
   * existing second writer with the existing verbatim dedup — because a defect
   * the team decided not to fix yet is exactly the push-back that section carries
   * to a role expert, and it should reach the owner through a channel that
   * already exists rather than a new one.
   *
   * `epicBase` is the review's OWN base and travels in as data, because the fix
   * list is the second artifact of one review and has to name the range the
   * reviewer was actually handed (#166). It rendered `epicBranch...branch` until
   * this fix — the post-merge range, which resolves to nothing for a story that
   * has already merged — so the record said one thing and the prompt another,
   * and the developer sent to fix the findings got an empty diff. One
   * derivation of the base, `reviewDiffCommand`, for both (AGENTS.md §7).
   */
  private writeFixlistFor(
    story: StoryContext, review: Review, commit: string, epicBase: string | null,
  ): string {
    const id = story.planned.story.id;
    // Allocated by `narrowFixlist`, which is the only thing that may grant one.
    const round = this.counters.fixlistRoundGranted(id) ?? this.fixlistRounds;
    const rel = writeFixlist(this.ctx.runDir, BUILD_PHASE, {
      storyId: id,
      title: story.planned.story.title,
      round,
      attempt: story.attempt,
      maxAttempts: this.attempts,
      diff: reviewDiffCommand(epicBase, story.epicBranch, story.branch),
      commit,
      summary: review.summary,
      findings: review.fixlist,
    });
    appendBuildRetro(
      this.ctx.runDir,
      fixlistRetroLines(id, this.ctx.runId, rel, review.fixlist),
    );
    this.lines.push(
      `  · ${id}: fix list written — ${rel} `
      + `(${String(openFindings(review.fixlist).length)} to fix now; this round spent no attempt)`,
    );
    return rel;
  }

  /**
   * The reason a story may not settle `done`, or null when nothing is open.
   *
   * Names the file, the finding's number and its heading — the three things the
   * person who has to close it needs — and then the two ways to close it, because
   * a refusal that does not say what to do next is a trap rather than a gate.
   *
   * Asked of the FILE, and — since #130 — of GIT. `Resolved: yes` is a claim
   * somebody typed; `verifyResolutions` is what turns it into a fact or refuses
   * it. Measured 2026-09-02 on `260830-money-and-payments`: `S4-1.md` said
   * `Resolved: yes` with a result.json describing the fix, and the branch did not
   * contain it, because the worktree holding it had been pruned (#129). The story
   * would have settled `done` over a live defect, silently, in the one direction
   * a mistake is not recoverable in.
   */
  private async openFixNow(story: FixlistScope): Promise<string | null> {
    const storyId = story.planned.story.id;
    const fixlist = latestFixlist(this.ctx.runDir, BUILD_PHASE, storyId);
    if (fixlist === null) return null;
    // gh #218 (correctness half): a heading the parse could not read back as a
    // finding is not evidence of zero — it is evidence the count is not to be
    // trusted. Measured reproduction: `**fix-now**` typo'd to `**fix-noww**`
    // silently dropped a live correctness finding from `findings`, and a plain
    // `--prepare` read the resulting `openFindings(...).length === 0` as
    // "nothing left to fix" and settled the story `done` with no re-review.
    // Asked BEFORE `verifyResolutions`: a claim git cannot verify is still a
    // claim about a finding the parse COULD read; a finding the parse could
    // not read at all is a different failure and gets its own name.
    const first = fixlist.unreadable[0];
    if (first !== undefined) {
      return `${String(fixlist.unreadable.length)} heading(s) in ${fixlist.rel} could not be read as a `
        + `finding — #${String(first.n)} · ${first.finding} (${first.reason}). A story may not settle `
        + "`done` on a fix list this could not fully parse: fix the file's `Disposition:` line (or its "
        + "heading, if the file was truncated) so it reads as one of `fix-now`, `defer-with-log`, "
        + "`refuted` or `out-of-scope`, then run the Build stage again";
    }
    const { findings, refused } = await this.verifyResolutions(story, fixlist);
    const open = openFindings(findings);
    const firstOpen = open[0];
    if (firstOpen === undefined) return null;
    return `${String(open.length)} fix-list finding(s) are still \`fix-now\` in ${fixlist.rel} — `
      + `#${String(firstOpen.n)} · ${firstOpen.finding}. `
      + (refused.length === 0
        ? ""
        : `${String(refused.length)} \`Resolved: yes\` claim(s) did not check out and were `
          + `recorded as \`${CLAIMED_UNVERIFIED}\`: ${refused.join("; ")}. `)
      + "Close each one there with `Resolved: yes <sha>` — the commit the fix landed as on "
      + `\`${story.branch}\` — or re-route its \`Disposition:\`, `
      // gh #329: NOT `tldrx story reopen`. A reopen hands the story to a developer
      // with nothing left to change (#308 refuses it), and `--as-is` refuses a
      // branch already on its epic. What re-reads this file is the stage itself.
      + "then run the Build stage again (`tldrx reject --note \"…\"`, then `tldrx next`): a `blocked` story "
      + "whose last review approved and whose fix list has nothing open settles `done` with no agent spawned";
  }

  /**
   * Hold every `Resolved: yes` in a fix list to the framework's own evidence rule.
   *
   * A claim closes a finding when it names a commit that (a) exists in the story's
   * repo and (b) is reachable from the story branch. Anything else is a claim
   * nobody can check, and the file is REWRITTEN to say so — `claimed-unverified`,
   * with the reason — rather than left saying `yes`. That rewrite is the point:
   * the incident was not a story that settled wrong once, it was an audit record
   * that went on asserting a closed defect afterwards.
   *
   * Deliberately one-directional. This can only ever move a finding from closed to
   * open; nothing here closes one, and a `no` is never touched.
   */
  private async verifyResolutions(
    story: FixlistScope,
    fixlist: FixlistOnDisk,
  ): Promise<{ findings: readonly FixFinding[]; refused: readonly string[] }> {
    const id = story.planned.story.id;
    const findings: FixFinding[] = [];
    const refused: string[] = [];
    let text: string | null = null;
    for (const finding of fixlist.findings) {
      // EVERY claim, not only the ones that gate `done`. A `defer-with-log`
      // finding marked resolved over a fix that does not exist is a smaller
      // problem and the same lie, and the record is what is being fixed here.
      // A claim whose sha was refused on SHAPE (#163) is downgraded here like any
      // other, and with the sentence `readResolvedSha` already wrote — not a
      // second phrasing of it (§7). It is asked FIRST because `unverifiedBecause`
      // cannot tell this case from a bare `Resolved: yes`: both arrive with
      // `resolvedSha: null`, and answering "named no commit to point at" over a
      // line that named 41 characters put the file and this report — the one a
      // human reads first — at odds about the same event.
      const why = finding.resolved
        ? finding.resolvedShaRefusal ?? await this.unverifiedBecause(story, finding.resolvedSha)
        : null;
      if (why === null) {
        findings.push(finding);
        continue;
      }
      findings.push({ ...finding, resolved: false, resolvedSha: null, resolvedShaRefusal: null });
      refused.push(`#${String(finding.n)} — ${why}`);
      text = markUnverified(text ?? readFileSync(fixlist.path, "utf8"), finding.n, why);
      this.lines.push(
        `  · ${id}: fix-list finding #${String(finding.n)} claimed \`Resolved: yes\` and `
        + `${why} — recorded as \`${CLAIMED_UNVERIFIED}\`, and it still blocks \`done\``,
      );
    }
    // Records never lie (#130 follow-up): a claim that DID check out may still
    // name a truncated sha — git resolves 39 hex characters exactly as happily as
    // 7, and a later reader cannot tell that apart from a deliberate abbreviation
    // of a DIFFERENT commit. `canonicalizeResolutions` owns both the git
    // resolution and the text edit; this call site only routes its answer into
    // the same single write below.
    const canonicalized = await canonicalizeResolutions(
      story.repoDir,
      findings,
      text ?? readFileSync(fixlist.path, "utf8"),
    );
    if (canonicalized.lines.length > 0) {
      text = canonicalized.text;
      for (const line of canonicalized.lines) this.lines.push(`  · ${id}: ${line}`);
    }
    if (text !== null) writeFileSync(fixlist.path, text, "utf8");
    return { findings: canonicalized.findings, refused };
  }

  /** Why a `Resolved: yes` does not check out, or null when it does. */
  private async unverifiedBecause(story: FixlistScope, sha: string | null): Promise<string | null> {
    if (sha === null) return "named no commit to point at";
    switch (await shaReachability(story.repoDir, sha, story.branch)) {
      case "reachable":
        return null;
      case "absent":
        return `named \`${sha}\`, which is not a commit in repo ${story.planned.story.repo}`;
      default:
        return `named \`${sha}\`, which is not reachable from \`${story.branch}\``;
    }
  }

  private narrowFixlist(storyId: string, review: Review): Review {
    return narrowFixlist(this.counters, this.roundParts, storyId, review);
  }

  /**
   * `attended_by: host` and the pipeline has reached the reviewer: write the
   * reviewer bundle and stop, instead of spawning one.
   *
   * This is the "one review, one economy" half of design §B.3. On an attended run
   * the host is already reading this diff; the framework spawning its own $0.26
   * reader beside it buys a second opinion nobody asked for and a bill nobody
   * budgeted. The story parks at `review` with its worktree kept, exactly where
   * an errored review parks it, and `--commit --review` picks it up.
   */
  private async handOffReview(
    story: StoryContext,
    dod: readonly DodResult[],
    commit: string,
    priorCost: number,
    carried: number | null,
    epicBase: string | null,
  ): Promise<void> {
    const key = this.writeReviewBundle(story, {
      commit, dod, why: "the run is `attended_by: host`, so the framework does not spawn a reviewer",
      // Recorded on the bundle so `--commit --review` reviews the range this
      // merge actually moved, not an empty one (#166).
      ...(epicBase === null || epicBase === "" ? {} : { epicBase }),
    });
    this.setStoryStatus(story.planned, "review");
    this.ctx.emit("task.started", {
      phase: this.ctx.phaseId,
      story: story.planned.story.id,
      wave: story.planned.wave,
      repo: story.planned.story.repo,
      branch: story.branch,
      attempt: story.attempt,
      role: "reviewer",
      mode: "prepare",
    });
    const dir = relative(this.ctx.root, agentDir(this.ctx.runDir, key));
    this.lines.push(
      `  · ${story.planned.story.id} merged into \`${story.epicBranch}\` `
      + `($${priorCost.toFixed(2)} so far${carried === null ? "" : `, ${String(carried)} commit(s) carried`}) — `
      + "its review is the host's",
      `prepared the REVIEW of ${story.planned.story.id} — ${dir}/prompt.md (read-only, nothing spawned)`,
      `dispatch ONE read-only sub-agent with cwd ${relative(this.ctx.root, story.worktree)}`,
      `then write {verdict, summary, findings} to ${dir}/result.json `
      + "— verdict is one of approve | fixlist | changes, NOT the `sign`/`refuse` gate "
      + "vocabulary — and run `tldrx next --commit --review`",
    );
  }

  /**
   * The developer FAILED, so the story goes back exactly where it was.
   *
   * This is the developer-side sibling of the reviewer's `verdict: "error"`, and
   * it exists for the same reason. Measured on `260830-tenancy-identity-customers`
   * (2026-08-30): five developer spawns died with `Reached maximum budget (…)`
   * having written nothing — zero commits on any of the five story branches — and
   * every one of them was recorded as a story `blocked` at attempt N. `blocked`
   * is terminal in-run, so one errored spawn ended the story, and the epic
   * shipped one story's work with six stories reported as tried and failed.
   *
   * What a failed spawn is allowed to change: the money it spent (recorded), the
   * ledger line saying it died (recorded), and the log and retro saying so in
   * those words. What it is NOT allowed to change: the story's status, its
   * attempt number, its worktree, or the reader's impression that the work was
   * judged. A developer that RAN and produced work the DoD faulted is a different
   * thing entirely and still blocks, unchanged.
   */
  private async parkDeveloperFailure(
    story: StoryContext,
    error: string,
    cost: number,
    before: PlanStatus,
  ): Promise<void> {
    await this.settle(story, before, {
      dod: [], commit: null, merged: false, carried: null,
      verdict: "n-a",
      review: {
        verdict: "n-a", summary: "", findings: [], fixlist: [], fixlistProblems: [],
        formatProblems: [], verdictProblem: null,
      },
      developerError: error,
      keepWorktree: true,
      cost,
      reason: `the developer FAILED and produced no work — ${error}`,
    });
  }

  /**
   * Re-run ONLY the review of a story whose last reviewer errored.
   *
   * The commit and the DoD results come from the run's own ledger, not from a
   * second developer turn: `events.jsonl` recorded which commit was merged and
   * which `dod` commands exited what, and those facts have not changed. Nothing
   * is re-merged either — `task.done` said `merged`, and merging a branch that is
   * already an ancestor is at best a no-op.
   */
  private async rereview(planned: PlannedStory, resume: ResumableReview): Promise<void> {
    const story = await this.writes.run(() => this.openStory(planned));
    await this.writes.run(() => {
      this.ctx.emit("task.started", {
        phase: this.ctx.phaseId,
        story: planned.story.id,
        wave: planned.wave,
        repo: planned.story.repo,
        branch: story.branch,
        attempt: story.attempt,
        resumed: "review",
      });
    });
    // `null`, not `0`: this invocation did not watch the merge happen, so it
    // knows the story merged and does not know what the merge carried.
    this.noteMerged(story, null);
    // WHICH of the two ways the last review left no verdict — a reviewer that
    // died, or one that was never funded (gh #289). Saying "FAILED" over a turn
    // that was deliberately not spawned is the same mislabel this pair of issues
    // is about, one layer up.
    const failed = resume.error.includes(REVIEWER_UNFUNDED_MARK)
      ? `the previous review was refused for want of money (${resume.error})`
      : `the previous reviewer FAILED (${resume.error})`;
    this.lines.push(
      `  · ${planned.story.id}: ${failed} — `
      + `re-running the REVIEW only; \`${resume.commit}\` is already merged into \`${story.epicBranch}\``,
    );
    this.noteUnrecordedBase(planned.story.id, story.epicBranch, resume.epicBase);
    // Off the LEDGER: this process did not watch the merge, so the base it hands
    // the second reviewer is the one the first was handed (#166). Null on a run
    // built before `epic_base` existed, which renders the epic branch.
    await this.reviewAndSettle(story, resume.dod, resume.commit, 0, null, resume.epicBase ?? null);
  }

  /**
   * One line when a story is pending because a PERSON put it back there.
   *
   * A reopened story is indistinguishable from a never-started one on disk —
   * both are `status: todo` — and that is by design: the reset is REAL, and the
   * pipeline that runs it must not special-case it. What would be wrong is the
   * operator reading `S3 · attempt 1 of 2` over a story two reviewers already
   * refused and thinking the framework had forgotten. The event remembers; this
   * says so out loud, with the note the person signed it with.
   */
  private noteIfReopened(planned: PlannedStory, status: PlanStatus): void {
    if (status !== "todo") return;
    const ledger = readReviewLedger(this.ctx.runDir, planned.story.id);
    if (ledger.reopened === null) return;
    this.lines.push(
      `  · ${planned.story.id} was reopened by ${ledger.reopened.actor} (${ledger.reopened.note}) — `
      + `the verdicts before that do not count against it, so it runs as attempt 1 of ${String(this.attempts)}`,
    );
  }

  /**
   * The note a PERSON put this story back with, or null when nobody did (#308).
   *
   * Off the ledger, like `noteIfReopened`: a reopen is an event, and a second
   * `tldrx` invocation remembers nothing else. An OPEN fix round wins over the
   * last plain reopen — it is the named defect still owed, and a plain reopen
   * granting more attempts does not close it (`reviewLedger.ts`, `fixRound`).
   */
  private reopenFor(planned: PlannedStory): ReopenNote | null {
    const ledger = readReviewLedger(this.ctx.runDir, planned.story.id);
    if (ledger.fixRound !== null) return { note: ledger.fixRound.note, actor: ledger.fixRound.actor, fix: true };
    if (ledger.reopened !== null) return { note: ledger.reopened.note, actor: ledger.reopened.actor, fix: false };
    return null;
  }

  /**
   * True when any story of this wave settled at `blocked`.
   *
   * It decides ONE line of the report now, and nothing about what runs next: a
   * wave-wide answer to a per-story question is exactly the defect #260 was filed
   * for. `blockingDependency` is what the frontier asks.
   */
  private waveFailed(wave: BuildWave): boolean {
    return wave.stories.some((planned) => this.statusOf(planned) === "blocked");
  }

  /**
   * The dependency that holds this story back, or null when every one of them is
   * `done` (#260).
   *
   * `waves.yml` guarantees a dependency lands in an EARLIER wave
   * (`plan/validatePlan.ts`), so at the moment this is asked every dependency has
   * already had its turn. Anything but `done` holds the story: `blocked` is the
   * case #260 is about, and a dependency left at `todo`, `in_progress` or
   * `review` is work that did not land either — a story fanning out over it is
   * the same false start, and a frontier that let it through because the status
   * was not the one word it checked for would be reading a label rather than
   * the fact. WHAT the hold does — block, or wait (#280) — is the caller's
   * question, and `decidingHold` answers which of several holds it is asked of.
   *
   * A `depends_on` id no story answers to is NOT treated as a hold: `validatePlan`
   * already refuses a plan with a dangling dependency, so inventing a reason here
   * would be this file's second opinion about that (§7).
   */
  private blockingDependency(planned: PlannedStory): DependencyHold | null {
    const holds: DependencyHold[] = [];
    for (const id of planned.story.depends_on) {
      const dependency = this.plan.stories.get(id);
      if (dependency === undefined) continue;
      const status = this.statusOf(dependency);
      if (status !== "done") holds.push({ id, status });
    }
    return decidingHold(holds);
  }

  /**
   * The story `--prepare` may hand out, decided by the SAME frontier `runAll`
   * asks at every wave boundary (#300) — one derivation, two doors.
   *
   * Walks `pendingStories` in wave order and does per story exactly what the
   * loop does: a terminal hold records the dependent `blocked` with the reason
   * (`blockOnDependency`) and moves on; a pending hold is a wait — row untouched,
   * remembered for the report — and moves on; the first story with no hold is
   * the offer. `none` when the walk recorded something or nothing was pending:
   * the caller finishes, and the rows just written reach the gate. `wait` only
   * when NOTHING was recorded and at least one story waits — a refusal that
   * changes no state, which is the only kind a sequencing refusal may be.
   *
   * The `wait` branch is unreachable at `--prepare` for ANY valid plan, not
   * just at the head of the queue: `validateWaveOrder` (`schemas/waves.ts`, run
   * by `plan/validatePlan.ts`)
   * puts every dependency in an EARLIER wave, `pendingStories` walks waves in
   * order and skips only `done` and a terminal `blocked`, so a dependency at
   * `review`/`in_progress` is itself pending and is reached — and offered —
   * before anything that waits on it. The branch exists because the walk is the
   * loop's rule and not a guess about reachability, and the same hold IS
   * reachable on the settling door, where `commit()` refuses over it.
   */
  private offerAtFrontier():
    | { kind: "offer"; planned: PlannedStory }
    | { kind: "wait"; story: string; held: DependencyHold }
    | { kind: "none" } {
    const walked = this.walkFrontier(true);
    if (walked.kind === "held" && !walked.recorded) return { kind: "wait", story: walked.story, held: walked.held };
    if (walked.kind === "held") return { kind: "none" };
    return walked;
  }

  /**
   * What the next `--prepare` would offer, asked of the same frontier and
   * RECORDING NOTHING — the closing hint of a `--commit` that has more to do
   * (#300). Reading raw `nextPending()` there named the held dependent the
   * instant its dependency was blocked, which is the one bundle `--prepare`
   * then refuses to write.
   */
  private nextAtFrontier(): string {
    const walked = this.walkFrontier(false);
    if (walked.kind === "offer") return `${walked.planned.story.id} is next — run \`tldrx next --prepare\``;
    if (walked.kind === "held") return dependencyNextLine(walked.story, walked.held);
    return "nothing is next — run `tldrx next --prepare` to close the stage at its gate";
  }

  /**
   * The one walk both readers share: `pendingStories` in wave order, the
   * frontier asked per story. `record` is the whole difference between the
   * door that hands out (`blocked` rows and waits are written) and the hint
   * that only says what it would do. `held` names the FIRST hold met, with
   * whether anything was recorded on the way.
   */
  private walkFrontier(record: boolean):
    | { kind: "offer"; planned: PlannedStory }
    | { kind: "held"; story: string; held: DependencyHold; recorded: boolean }
    | { kind: "none" } {
    let recorded = false;
    let first: { story: string; held: DependencyHold } | null = null;
    for (const planned of this.pendingStories()) {
      const held = this.blockingDependency(planned);
      if (held === null) return { kind: "offer", planned };
      first ??= { story: planned.story.id, held };
      if (dependencyIsPending(held.status)) {
        if (record) this.waitOnDependency(planned, held);
        continue;
      }
      if (record) this.blockOnDependency(planned, held);
      recorded = true;
    }
    return first === null ? { kind: "none" } : { kind: "held", ...first, recorded };
  }

  /**
   * A story whose dependency is mid-pipeline waits (#280): nothing is written —
   * not the story file, not an outcome row — and the next invocation asks the
   * frontier again, by which time the dependency has had its re-review or its
   * fix round. The wait is remembered for this pass only, so the report and
   * `## Unknowns` name it instead of calling it a story with no reason.
   */
  private waitOnDependency(planned: PlannedStory, held: DependencyHold): void {
    this.waits.set(planned.story.id, held);
    this.lines.push(dependencyWaitLine(planned.story.id, held));
  }

  /**
   * The dependency a `blocked` story's own log says blocked it, when that
   * dependency — and every other one — is now `done`; null otherwise (#280).
   *
   * Read off the log because that is the only record `blockOnDependency` leaves
   * that outlives the process (it emits no event: there was no attempt to
   * close). A row a reviewer blocked, or one the loop blocked for a dependency
   * that is STILL not `done`, returns null and stays exactly where it is.
   */
  private staleDependencyHold(planned: PlannedStory): string | null {
    const path = join(this.ctx.runDir, BUILD_PHASE, LOG_DIR, `${planned.story.id}.md`);
    let named: string | null;
    try {
      named = dependencyHoldOfLog(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    if (named === null) return null;
    return this.blockingDependency(planned) === null ? named : null;
  }

  /**
   * A story whose dependency did not land: `blocked` WITH the reason, never a
   * silent `todo` (#260).
   *
   * It does not go through `settle`. Every field `settle` writes describes an
   * attempt — a worktree to prune, a rescue to attempt, an `epic_base` to measure,
   * a `task.done` to close a `task.started` that was never emitted — and this
   * story had no attempt: `attempts: 0` is the truth about it, and so is a review
   * log that says no reviewer judged anything. What it DOES share with `settle` is
   * everything a reader downstream depends on: the status on the story file, the
   * epic's rolled-up status, an outcome row (so `## Findings` and `## Unknowns`
   * name it), and the review log those bullets cite. That row is what
   * `blockedReasons` parses back out of the handoff, which is how the reason
   * reaches `blocked_reason` on `gate.requested` and `continueNote`
   * (`run/runOutcome.ts`) — the whole point of recording a reason instead of
   * leaving the gate held by a `todo` nobody can act on (#239).
   */
  private blockOnDependency(planned: PlannedStory, held: DependencyHold): void {
    const id = planned.story.id;
    // ONE sentence, written and read back by `build/dependencyHold.ts` (#280):
    // the next invocation recognises this row by it.
    const reason = dependencyHoldReason(held);
    const epic = this.plan.epics.get(planned.story.epic);
    const outcome: StoryOutcome = {
      id,
      title: planned.story.title,
      wave: planned.wave,
      repo: planned.story.repo,
      epic: planned.story.epic,
      epicBranch: epic === undefined ? "" : epicBranchOf(this.branchModel, epic.epic.branch),
      // The name the cut WOULD have used, derived the one way (#134). Nothing has
      // created it — the row says `attempts: 0`, which is what says so.
      branch: storyBranchOf(this.ctx.runId, id),
      status: "blocked",
      attempts: 0,
      dod: [],
      // Its declared commands exist and NONE of them ran. Empty beside an empty
      // list would read as "this story declares no Definition of Done", which is
      // a different fact (#137).
      dodUnrecovered: planned.dod.commands,
      commit: null,
      merged: false,
      carried: null,
      conflicts: [],
      verdict: "n-a",
      reviewer: null,
      developerError: null,
      reviewSummary: "not attempted — a dependency did not land",
      reviewFindings: [],
      reviewRel: `${BUILD_PHASE}/${LOG_DIR}/${id}.md`,
      reason,
      rescued: null,
      cost_usd: 0,
    };
    this.outcomes.set(id, outcome);
    this.writeLog(outcome);
    this.setStoryStatus(planned, "blocked");
    if (!this.plan.implicit && epic !== undefined) this.updateEpicStatus(epic);
    this.lines.push(
      `  · ${id} was not started — ${reason}; recorded \`blocked\` so the reason reaches the gate`,
    );
  }

  /** DoD → commit → merge → review → done/blocked, for the `--commit` cycle. */
  private async pipelineFromDod(story: StoryContext, developerCost: number): Promise<ReviewRoute> {
    const dod = await this.runDod(story);
    if (!this.dodProves(dod)) {
      const failing = dodFailure(dod);
      await this.block(
        story,
        failing === undefined
          ? "the story declares no dod commands, so nothing could prove it"
          : dodFailureReason(failing, story.planned.story.repo),
        developerCost,
        dod,
      );
      return "settled";
    }
    const commit = await this.commitIfDirty(story);
    if (commit === null) {
      await this.block(story, "the working tree could not be committed", developerCost, dod);
      return "settled";
    }
    // `developerError` is null on this path by construction: the developer was
    // the HOST's sub-agent, not ours, and `--commit` only runs once it has left a
    // `result.json` behind. A host whose agent died writes no result and this
    // method is never reached. `before` is `in_progress` — what `--prepare` set —
    // and is unused, since nothing here can park.
    return await this.settleHalf({
      story, cost: developerCost, dod, commit,
      failure: null, developerError: null, before: "in_progress",
    });
  }

  // --- steps ----------------------------------------------------------------

  /**
   * (a)(b)(c): repo, epic branch, story worktree.
   *
   * `refreshBase` is true on the two paths that are about to put a DEVELOPER on
   * this branch — `prepare()` and `buildHalf()` — and false everywhere else.
   * Design §F.2 says the staleness check belongs "inside `openStory`, which is
   * the one place a worktree is opened", and it does; the flag is about which
   * openings may MOVE the branch. The review paths (`prepareReview`,
   * `commitReview`, `rereview`) open a story whose work is already merged into
   * the epic, so a fast-forward there would drag other stories' commits onto a
   * branch whose whole meaning is "what this story built", to no end: nobody is
   * about to compile against that base. `commit()` opens a worktree a developer
   * has just written into, which the dirty guard would refuse anyway — the flag
   * saves the warning as well as the move.
   */
  private async openStory(planned: PlannedStory, refreshBase = false): Promise<StoryContext> {
    const epic = this.plan.epics.get(planned.story.epic);
    if (epic === undefined) {
      throw new PlanLoadError(`${planned.story.id} names epic ${planned.story.epic}, which did not load`);
    }
    const repoDir = repoDirOf(this.workspace, planned.story.repo);
    const base = this.workspace.defaultBranches.get(planned.story.repo) ?? "main";
    // The epic's own `branch:` under `per-epic`; the run's ONE integration branch
    // when the epics form a dependency chain (issue #57). Every other line of
    // this method — the cut, the claim, the worktree, the merge — is unchanged:
    // only WHICH branch it names moves.
    const epicBranch = epicBranchOf(this.branchModel, epic.epic.branch);
    if (await ensureBranch(repoDir, epicBranch, base)) {
      this.lines.push(`  · cut \`${epicBranch}\` from \`${base}\` in ${planned.story.repo}`);
    }
    // Whatever happened above, this run is now working on that branch: say so in
    // run.yml (`build.epic_branch`) so its NEXT invocation, and any other run,
    // can tell "I cut this" from "this was already here".
    //
    // ON DISK, here, before the developer turn that follows (#262) — not only in
    // the outcome this executor carries out at the end. A Build stage takes
    // minutes to return, and a SIGKILL in that window (a cancelled session, an
    // OOM kill, a power cut; SIGINT and SIGTERM are hooked, SIGKILL cannot be)
    // used to leave the branch in the repo with nothing claiming it, and the
    // relaunch was then refused its OWN epic.
    //
    // It does NOT ride the write serializer, and must not be described as doing
    // so: `openStory` has EIGHT call sites (measured) and only four wrap it in
    // `this.writes.run` — `asIsHalf`, `buildHalf`, `settleClosedFixlists` and
    // `rereview` do; `prepare`, `prepareReview`, `commitReview` and `commit`
    // call it bare. What makes this safe is the statement below, not a queue:
    // there is NO `await` between `ensureBranch` resolving above and the claim,
    // and `ctx.claimEpicBranch` is synchronous, so the cut and its record are
    // one uninterrupted step of this task — nothing else in the process can run
    // between them, on any of the eight paths.
    this.epics.claimAtTheCut(epicBranch, (branch) => {
      try {
        this.ctx.claimEpicBranch(branch, this.branchModel.kind);
      } catch (error) {
        // Named, never swallowed: see `epicClaimRefusal`.
        throw epicClaimRefusal(branch, planned.story.repo, this.ctx.runId, error);
      }
    });
    // The run id is IN the branch name — see `storyBranchOf`, which is the ONE
    // place that name is derived. Without the run id, four runs of the same plan
    // all cut `story/S1`: the second found it already there, `addWorktree`
    // checked it out as it stood, and one run's commits landed on another's
    // branch (2026-08-29 audit, §B). `story/<run>/<story>` cannot collide.
    const branch = storyBranchOf(this.ctx.runId, planned.story.id);
    const worktree = this.storyWorktree(planned);
    const freshWorktree = !existsSync(worktree);
    if (freshWorktree) {
      mkdirSync(join(worktree, ".."), { recursive: true });
      await addWorktree(repoDir, worktree, branch, epicBranch);
    }
    // The worktree has to exist first: a fast-forward is a checkout, and this is
    // the one place a story's worktree is opened.
    if (refreshBase) await this.refreshStoryBase(planned, repoDir, worktree, branch, epicBranch);
    return {
      planned,
      epic,
      repoDir,
      worktree,
      branch,
      epicBranch,
      attempt: this.attemptFor(planned),
      ...(() => {
        const previous = this.previousAttemptFor(planned.story.id);
        return { previousAttempt: previous.text, previousAttemptKind: previous.kind };
      })(),
      notInWorktree: await this.unreadableTouches(planned, repoDir, branch),
      freshWorktree,
    };
  }

  /**
   * The attempt a story opened now would be on — `openStory`'s, and the one a
   * wave lane is funded for before it opens (gh #325).
   */
  private attemptFor(planned: PlannedStory): number {
    return Math.min(
      // Verdicts that cost an attempt, plus attempts this process requeued on a red
      // DoD (gh #313) — both spend one, and only the first is a review.
      this.reviewAttempts(planned.story.id) + this.counters.dodRequeuesSpent(this.ctx.runDir, planned.story.id)
        // gh #286: and a conflict turn spends one too.
        + this.counters.conflictTurnsSpent(this.ctx.runDir, planned.story.id) + 1,
      this.attempts,
    );
  }

  /**
   * (c½) the declared `install:`, in the story's fresh worktree, BEFORE the
   * developer (gh #209).
   *
   * Deliberately OUTSIDE the single writer: this is the one step of story setup
   * that can take minutes (`npm ci`, `dotnet restore`), it touches only the
   * story's own tree, and holding the executor's serial lock across it would
   * stall every other lane's git for the duration.
   *
   * Returns null when there is nothing to do — no `install:` declared, or a
   * worktree this invocation did not create. Null is not a green: the DoD's own
   * 127 reading is what speaks for the undeclared case, and it says so.
   */
  private async installDeps(story: StoryContext): Promise<InstallCheck | null> {
    if (!story.freshWorktree) return null;
    const repo = story.planned.story.repo;
    const command = installCommandFor(this.workspace, repo);
    if (command === null) return null;
    const check = await runWorktreeInstall({
      storyId: story.planned.story.id,
      repo,
      worktree: story.worktree,
      command,
      workspaceCommands: this.workspace.commands,
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      phaseId: this.ctx.phaseId,
      emit: (type, payload) => { this.ctx.emit(type, payload); },
    });
    this.lines.push(
      `  · ${story.planned.story.id}: \`${command}\` in the story worktree — `
      + `${check.refusedBecause === undefined ? `exit ${String(check.exitCode ?? "?")}` : "REFUSED"}, `
      + `${String(check.durationMs)} ms`,
    );
    return check;
  }

  private async refreshStoryBase(
    planned: PlannedStory,
    repoDir: string,
    worktree: string,
    branch: string,
    epicBranch: string,
  ): Promise<void> {
    await refreshStoryBase({
      storyId: planned.story.id,
      root: this.ctx.root,
      workspaceRoot: this.workspace.root,
      repoDir,
      worktree,
      branch,
      epicBranch,
      repo: planned.story.repo,
      phaseId: this.ctx.phaseId,
      lines: this.lines,
      emit: (type, payload) => { this.ctx.emit(type, payload); },
    });
  }

  private async unreadableTouches(
    planned: PlannedStory,
    repoDir: string,
    branch: string,
  ): Promise<ReadonlySet<string>> {
    return await unreadableTouches({
      repoDir,
      branch,
      touches: planned.story.touches,
      advisories: this.advisories,
    });
  }

  /**
   * (d) one developer sub-agent, cwd = the worktree.
   *
   * Returns what it spent and — when it FAILED — what it died with, verbatim.
   * The two are separate on purpose: an errored spawn still costs money, and the
   * money is the operator's clue about why it errored.
   */
  /**
   * `capDeathReason` derives the cap from the plan; a wave lane funded BELOW that
   * was spawned under less, and the sentence must not name a cap the turn never
   * had (gh #325). Empty on the serial path and whenever the lane got its own cap.
   */
  private laneCapNote(story: StoryContext): string {
    const lane = this.laneCaps.get(story.planned.story.id);
    const own = developerCap(this.capParts, story.planned.story.id, story.attempt);
    return lane === undefined || lane === own
      ? ""
      : `; this parallel lane was dispatched under $${lane.toFixed(2)}, not $${own.toFixed(2)} — the rest was `
        + "held for the wave's other lanes and their reviews (gh #325)";
  }

  /** The cap this story's developer is spawned under: its lane's, in a wave (gh #325). */
  private developerCapFor(story: StoryContext): number {
    return this.laneCaps.get(story.planned.story.id)
      ?? developerCap(this.capParts, story.planned.story.id, story.attempt);
  }

  private async spawnDeveloper(
    story: StoryContext,
    // gh #278: the one re-spawn after a CHAINED refusal with no work — the cure
    // goes in front of the same prompt, and the spawn event says which refused
    // line it is the retry for. Additive on `agent.spawned`; absent otherwise.
    retry: { readonly after: string } | null = null,
  ): Promise<{ cost: number; error: string | null; refused: string | null }> {
    const cap = this.developerCapFor(story);
    const commands = this.repoCommands(story.planned.story.repo);
    this.ctx.emit("agent.spawned", {
      phase: this.ctx.phaseId,
      story: story.planned.story.id,
      role: "developer",
      model: this.model(),
      effort: this.ctx.effort,
      max_budget_usd: cap,
      ...(retry === null ? {} : { retry: "separator-cure", retry_after: retry.after }),
    }, 0, "developer");

    const agent = await spawnAgent({
      // gh #327: the headless developer is handed the open fix list exactly as a
      // `--prepare` bundle is — the one derivation `fixlistFor` already owns.
      prompt: (retry === null ? "" : separatorCurePrefix(retry.after))
        + this.developerPrompt(story, this.fixlistFor(story.planned.story.id)),
      model: this.model(),
      effort: this.ctx.effort,
      maxBudgetUsd: cap,
      workspaceCommands: commands,
      // `Skill` only when there is one to invoke: an allowance for a tool nothing needs
      // is a wider surface for no reason.
      tools: developerTools(commands, {
        skills: skillsFor(readStackPacks(this.ctx.root), [story.planned.story.repo]).length > 0,
      }),
      yolo: this.ctx.yolo,
      cwd: story.worktree,
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      lane: this.lane(story),
      role: "developer",
    });
    // gh #298: whatever the turn ITSELF did, its stream may have carried the
    // provider's warning that the window is nearly gone. Read before the outcome
    // is judged, because a turn that succeeded is exactly the one that can warn.
    this.noteRateLimit(agent.rateLimit);
    if (agent.raw !== "") writeRaw(this.ctx.runDir, this.bundleKey(story.planned.story.id), agent.raw);

    this.tasks.push({
      key: story.planned.story.id,
      model: this.model(),
      costUsd: round2(agent.costUsd),
      sessionId: agent.sessionId,
      error: agent.error,
      // The same role this spawn was made under, three lines up (#234).
      role: "developer",
      outputs: agent.envelope?.outputs ?? [],
      metered: agent.metered,
      usage: agent.usage,
      // The developer sub-agent's own span, measured around its process (#184).
      // Every task row of a parallel build otherwise shares one `started_at`.
      durationMs: agent.durationMs,
    });
    // A turn refused at the permission layer is OK by every transport measure —
    // it exited 0, returned an envelope and was charged for — and it did none of
    // the work it was asked for (#261). Reported beside the cost so the caller
    // that owns attempts can stop, rather than reading an empty diff as a
    // developer that simply chose to change nothing.
    if (agent.ok) {
      return { cost: round2(agent.costUsd), error: null, refused: agent.permissionRefusal };
    }

    // The developer IS a check, and this is the one outcome it can have that
    // nothing downstream may read as work. `status: "error"` and the error as
    // `detail` are the developer-side spelling of the reviewer's
    // `verdict: "error"` — a ledger must be able to tell "the turn never ran"
    // from "the turn ran and the story failed", and until 2026-08-30 the only
    // record of the difference was a `run.yml` task nobody joined back.
    const error = (agent.error ?? "").trim() === "" ? DEVELOPER_FAILED : (agent.error ?? "").trim();
    this.ctx.emit("check.failed", {
      phase: this.ctx.phaseId,
      check: "developer",
      story: story.planned.story.id,
      status: "error",
      attempt: story.attempt,
      detail: error,
    });
    return { cost: round2(agent.costUsd), error, refused: null };
  }

  /** (e) the story's ```dod block, in the worktree, via the gate's own runner. */
  /**
   * Does this DoD PROVE the story? One derivation, three callers (§7).
   *
   * The empty list is the interesting half: a planned story that declares no
   * command is a Plan bug and blocks, and an implicit one is the framework
   * saying this scope has nothing to run — which is `dodIsSatisfiedEmpty`'s
   * question, not `dodGreen`'s.
   */
  private dodProves(dod: readonly DodResult[]): boolean {
    return dod.length === 0 ? dodIsSatisfiedEmpty(this.plan) : dodGreen({ dod });
  }

  private async runDod(story: StoryContext): Promise<readonly DodResult[]> {
    const scoped = await this.scopedParts(story);
    const results = await runStoryDod({
      storyId: story.planned.story.id,
      repo: story.planned.story.repo,
      worktree: story.worktree,
      repoDir: story.repoDir,
      installDeclared: installCommandFor(this.workspace, story.planned.story.repo) !== null,
      commands: story.planned.dod.commands,
      workspaceCommands: this.workspace.commands,
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      phaseId: this.ctx.phaseId,
      runDir: this.ctx.runDir,
      emit: (type, payload) => { this.ctx.emit(type, payload); },
      baseResult: (repo, command) => serveBaseResult(this.baseParts, repo, command),
      ...(scoped === null ? {} : { scoped }),
    });
    // A story proven over its paths alone leaves the epic head owing a full run
    // (#257) — remembered on the epic, where `settle` asks.
    if (results.some((r) => r.scope === "paths")) this.epics.noteScopedRun(story.epicBranch);
    return results;
  }

  /**
   * The repo's `<slot>_scoped` templates and THIS story's paths (#257), or null
   * when the repo declares no template — in which case the runner is handed
   * nothing and is byte-for-byte what it was.
   */
  private async scopedParts(story: StoryContext): Promise<NonNullable<DodParts["scoped"]> | null> {
    const templates = this.workspace.scopedCommands.get(story.planned.story.repo);
    if (templates === undefined || templates.size === 0) return null;
    const paths = await scopedPathsFor({
      declared: this.declaredTouches(story),
      repoDir: story.repoDir,
      worktree: story.worktree,
      // Before the merge, so the epic tip IS the base: the same range the
      // reviewer's diff and the surface measurement read (§7, one derivation).
      range: reviewDiffRange(null, story.epicBranch, story.branch),
    });
    return { templates, paths };
  }

  /**
   * (h) the FULL Definition of Done, once, on the epic head (#257).
   *
   * Only for an epic on which a story was proven over its paths alone — a
   * scoped green says the story's files pass; it says nothing about the suite
   * against the tree every story of this epic now shares. So the moment the
   * epic flips to `done`, the deduped full commands of its stories run in the
   * epic worktree, whose HEAD is the epic head that ships. Once per epic per
   * invocation (`claimHeadCheck`); an epic whose every story ran the full list
   * already proved the tree the old way and owes nothing.
   *
   * A red is attributed to the LAST story merged, not to every story — the
   * base pre-flight is the precedent for "the change that landed last owns the
   * red" — and the caller blocks that story, so the epic is no longer `done`
   * and the `stories` gate condition refuses. The base tree is NOT consulted
   * for this red: Build entry already refused a red base, and the epic head is
   * exactly the tree the base is not.
   *
   * Returns the one sentence to block with, or null when green or not owed.
   */
  private async checkEpicHead(story: StoryContext): Promise<string | null> {
    const epicBranch = story.epicBranch;
    if (!this.epics.hadScopedRun(epicBranch) || !this.epics.claimHeadCheck(epicBranch)) return null;
    const id = story.planned.story.id;
    const repo = story.planned.story.repo;
    const commands: string[] = [];
    for (const storyId of story.epic.epic.stories) {
      for (const command of this.plan.stories.get(storyId)?.dod.commands ?? []) {
        if (!commands.includes(command)) commands.push(command);
      }
    }
    if (commands.length === 0) return null;
    const worktree = await openEpicWorktree(this.epics, this.epicParts(story));
    const timeoutMs = this.ctx.spec.planned.timeout_s * 1000;
    // The epic worktree is a `git worktree add` nothing ever installed into —
    // without this, the declared suite exits 127 here the way a story's did
    // before gh #209.
    const install = installCommandFor(this.workspace, repo);
    if (install !== null) {
      const check = await runWorktreeInstall({
        storyId: id, repo, worktree, command: install,
        workspaceCommands: this.workspace.commands, timeoutMs, phaseId: this.ctx.phaseId,
        lane: epicBranch,
        emit: (type, payload) => { this.ctx.emit(type, payload); },
      });
      if (installFailed(check)) {
        return `the epic head (${epicBranch}) could not be checked: \`${install}\` `
          + `(the \`${INSTALL_SLOT}:\` command for repo ${repo}) `
          + `${check.refusedBecause === undefined
            ? `exited ${String(check.exitCode ?? "?")}${check.timedOut ? " (timed out)" : ""}`
            : "was REFUSED and never ran"} in the epic worktree — ${check.refusedBecause ?? check.tail}`;
      }
    }
    const results = await runStoryDod({
      storyId: id, repo, worktree, repoDir: story.repoDir, installDeclared: install !== null,
      commands, workspaceCommands: this.workspace.commands, timeoutMs,
      phaseId: this.ctx.phaseId, runDir: this.ctx.runDir,
      // Every row says which tree and which proof: the epic's lane, the full command.
      emit: (type, payload) => { this.ctx.emit(type, { ...payload, scope: "full", lane: epicBranch }); },
      baseResult: async () => null,
    });
    const failing = results.find((r) => dodRefused(r) || r.exitCode !== 0 || r.timedOut);
    this.lines.push(
      `  · ${epicBranch}: full Definition of Done on the epic head (${String(commands.length)} command(s)) — `
      + (failing === undefined ? "green" : `RED, ${id} blocked`),
    );
    if (failing === undefined) return null;
    return `the epic head (${epicBranch}) failed the full Definition of Done once ${id} was merged — `
      + dodFailureReason(failing, repo);
  }

  private async commitIfDirty(story: StoryContext): Promise<string | null> {
    return await commitIfDirty({
      storyId: story.planned.story.id,
      title: story.planned.story.title,
      workspaceRoot: this.workspace.root,
      repoDir: story.repoDir,
      worktree: story.worktree,
      lines: this.lines,
    });
  }

  /** (f) `git merge --no-ff story/<id>` inside the epic's own worktree. */
  private async mergeIntoEpic(
    story: StoryContext,
  ): Promise<{ ok: boolean; conflicts: readonly string[]; detail: string }> {
    return await mergeIntoEpic(this.epics, {
      ...this.epicParts(story),
      storyBranch: story.branch,
      storyId: story.planned.story.id,
      storyTitle: story.planned.story.title,
    });
  }

  /**
   * The review this stage cannot afford to spawn (gh #289) — recorded, not paid
   * for.
   *
   * It writes NO task row: a `$0.00` row is a claim that a turn happened, and
   * none did. What it writes is the same `check.failed` every review writes, so
   * one reader answers "what became of this story's review" — with
   * `verdict: "n-a"`, because nothing judged anything, and `unfunded_usd` so a
   * ledger can tell this refusal from the four verdicts without parsing English.
   */
  private refuseUnfundedReview(story: StoryContext): Review {
    const id = story.planned.story.id;
    const left = stageRemainderUsd(this.capParts, this.spent()) ?? 0;
    const review = reviewerUnfunded(reviewerUnfundedReason({
      remainingUsd: left,
      floorUsd: REVIEWER_FLOOR_USD,
      fix: `\`${stageRaiseCommand(
        this.ctx.runId, this.ctx.phaseId, this.ctx.stageId, shortBy(REVIEWER_FLOOR_USD, left),
      )}\``,
    }));
    this.unfundedReviews.set(id, review.summary);
    this.ctx.emit("check.failed", {
      phase: this.ctx.phaseId,
      check: "review",
      story: id,
      verdict: review.verdict,
      attempt: story.attempt,
      unfunded_usd: left,
      floor_usd: REVIEWER_FLOOR_USD,
      detail: review.summary,
    });
    // No reviewer ran, so nothing may claim one did — `settle` renders a null
    // provenance as `not recorded`, which is the truth about this story.
    this.reviewers.set(id, null);
    return review;
  }

  /** (g) the reviewer, read-only, judging the story diff. */
  private async spawnReviewer(
    story: StoryContext,
    dod: readonly DodResult[],
    epicBase: string | null,
  ): Promise<{ review: Review; cost: number }> {
    const id = story.planned.story.id;
    let refusal: string | null = null;
    let spent = 0;
    // gh #327: the open fix-list findings this reviewer is SHOWN, read once, before
    // the first envelope — the set an `approve` from this turn may auto-close, and
    // nothing wider. A stale set from an earlier review of the story never survives
    // into this one.
    this.shownFixRounds.delete(id);
    const fixRound = openFixlist(this.ctx.runDir, BUILD_PHASE, id);
    // Bounded by `MAX_FORMAT_RETRIES` and by nothing else — the loop can only
    // go round again on the one outcome `formatRetry` grants, and that grant is
    // counted on disk before this line is reached a second time (gh #78).
    for (;;) {
      const cap = reviewerCap(this.capParts, this.spent(), id);
      // Resolved ONCE per envelope round, before the event that records it — the
      // `agent.spawned` payload is the audit trail for which model judged this
      // diff, and it must name the argv this loop is about to pass, not the
      // stage's pin.
      const reviewer = this.reviewerModel(story.planned);
      if (refusal === null) this.noteReviewerOverride(story.planned, reviewer);
      this.ctx.emit("agent.spawned", {
        phase: this.ctx.phaseId,
        story: id,
        role: "reviewer",
        model: reviewer.model,
        effort: reviewer.effort,
        max_budget_usd: cap,
      }, 0, "reviewer");

      const agent = await spawnAgent({
        prompt: this.reviewerPrompt(story, dod, refusal, epicBase, fixRound),
        model: reviewer.model,
        effort: reviewer.effort,
        maxBudgetUsd: cap,
        workspaceCommands: [],
        tools: REVIEWER_TOOLS,
        schema: REVIEW_SCHEMA,
        // NOT `this.ctx.yolo`. `--yolo` is `--dangerously-skip-permissions`
        // (spawnAgent.ts:89), and handing it to the read-only reviewer took away the
        // one thing making it read-only — an agent asked to judge a diff was given a
        // permission-free shell to do it with (2026-08-29 audit, §C). The developer
        // still gets it: that one is meant to write.
        yolo: false,
        cwd: story.worktree,
        timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
        lane: this.lane(story),
        role: "reviewer",
      });
      // gh #298: a reviewer's stream warns exactly like a developer's.
      this.noteRateLimit(agent.rateLimit);

      // A reviewer that did not finish has not approved anything — and has not
      // asked for changes either. `agent.ok === false` is a TRANSPORT outcome (the
      // spawn failed, the process timed out, `--max-budget-usd` bit), and the one
      // thing it is not is a judgement of the diff. Fabricating `changes` here is
      // what spent story S1's single requeue on a reviewer that died mid-read
      // (2026-08-30); `reviewerFailed` records the corpse as a corpse.
      const parsed = agent.ok ? parseReview(agent.structured, agent.result) : reviewerFailed(agent.error);
      // The bound is applied between the parse and the record, so a refused second
      // fix-list round reaches the requeue counter, the ledger line and the story's
      // fate as the ONE verdict it was downgraded to — not as a fix list here and a
      // `changes` three lines later.
      const review = this.narrowFixlist(id, parsed);
      const turn = round2(agent.costUsd);

      // The envelope was refused on its FORMAT and the story still has
      // a correction in hand: ask again. The turn's money is real and is recorded
      // as its own task row; the verdict is not, because there was none to record
      // (gh #78). Every other outcome — including the third refusal — falls
      // through to `recordReview` exactly as it always did.
      const again = this.formatRetry(story, review, {
        costUsd: turn, sessionId: agent.sessionId, metered: agent.metered,
        usage: agent.usage,
        durationMs: agent.durationMs,
      });
      if (again !== null) {
        refusal = again;
        spent = round2(spent + turn);
        continue;
      }

      this.recordReview(story, review, {
        costUsd: turn,
        sessionId: agent.sessionId,
        error: agent.error,
        metered: agent.metered,
        usage: agent.usage,
        durationMs: agent.durationMs,
        source: "agent",
        // MEASURED: these are the arguments this loop handed the provider CLI a
        // few lines up, not a re-derivation of them.
        reviewer: { model: reviewer.model, effort: reviewer.effort, basis: "spawned" },
      });
      if (fixRound !== null && review.verdict === "approve") {
        this.shownFixRounds.set(id, {
          fixlist: fixRound, shown: openFindings(fixRound.findings), sessionId: agent.sessionId,
        });
      }
      // The story's recorded cost is every turn this review took, not just the
      // last one: a free retry costs the story no ATTEMPT, never no money.
      return { review, cost: round2(spent + turn) };
    }
  }

  /**
   * The MONEY and the EVENT of a format retry — the decision is
   * `formatRetryDecision` (`build/reviewRound.ts`), which reads the bound and
   * records the grant. What stays here is what only the executor can do: the
   * turn's own task row, and the `story.review_retried` that makes an attempt
   * deliberately not spent auditable by every process after this one.
   */
  private formatRetry(
    story: StoryContext,
    review: Review,
    task: {
      costUsd: number;
      sessionId: string | null;
      /** False ⇒ the turn was billed to the host session, as in `recordReview`. */
      metered: boolean;
      tokens?: number;
      /** The provider's own accounting for this turn, when it reported any. */
      usage?: AgentUsage;
      /** The spawn's own wall clock, when this turn was spawned rather than hosted. */
      durationMs?: number;
    },
  ): string | null {
    const id = story.planned.story.id;
    const again = formatRetryDecision(this.counters, { ...this.roundParts, storyId: id, review });
    if (again === null) return null;
    this.tasks.push({
      key: id,
      model: task.metered ? this.model() : null,
      costUsd: task.costUsd,
      sessionId: task.sessionId,
      error: null,
      // A review turn whose verdict would not parse is still a REVIEW turn (#234).
      role: "reviewer",
      outputs: [],
      ...(task.metered ? {} : { metered: false }),
      ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
      usage: task.usage,
      // Absent for a HOST review turn, which is the point: absence is "not
      // recorded", and only a span this process timed is written down.
      ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
    });
    this.ctx.emit("story.review_retried", {
      phase: this.ctx.phaseId,
      story: id,
      // The attempt this did NOT spend. That is the whole point of the event.
      attempt: story.attempt,
      retry: again.retry,
      max_retries: MAX_FORMAT_RETRIES,
      detail: again.detail,
    }, task.costUsd, "reviewer");
    this.lines.push(...again.lines);
    return again.refusal;
  }

  private pendingRefusal(storyId: string): string | null {
    return pendingRefusal(this.ctx.runDir, storyId);
  }

  /**
   * The HOST's envelope was refused on its FORMAT: hand the same review
   * back, with the refusal in its prompt, and settle nothing (gh #78).
   *
   * The refused `result.json` is MOVED ASIDE rather than left or deleted, and
   * both halves of that matter. Left, the next `--commit --review` would settle
   * the very envelope this just declined to count. Deleted, a host would lose a
   * judgement it paid for over one mis-placed bracket — so it is renamed to
   * `result.refused-<n>.json`, which the host can copy back with the envelope
   * fixed. This is the one place `--prepare`'s "an answer already here is not
   * binned" rule is bent, and nothing is actually binned.
   */
  private reopenReviewBundle(story: StoryContext, work: ReviewWork, refusal: string): ExecutorOutcome {
    const id = story.planned.story.id;
    const key = this.reviewBundleKey(id);
    const dir = agentDir(this.ctx.runDir, key);
    const kept = stashRefusedEnvelope(this.ctx.runDir, key, this.formatRetriesSpent(id));
    this.writeReviewBundle(story, work, refusal);
    const rel = relative(this.ctx.root, dir);
    this.lines.push(
      `  · ${id}: the refused envelope was kept as ${rel}/${kept} — `
      + "copy it back with the envelope fixed rather than writing it again",
    );
    return {
      ok: true,
      awaiting: true,
      tasks: this.tasks,
      costUsd: this.spent(),
      outputs: [...this.logPaths(), ...this.planOutputs(), ...this.retroOutputs()],
      lines: [
        ...this.lines,
        `re-prepared the REVIEW of ${story.planned.story.id} — ${rel}/prompt.md carries what was refused`,
        `write the CORRECTED envelope to ${rel}/${RESULT_FILE} and run \`tldrx next --commit --review\``,
      ],
      stderr: [...this.advisories],
      error: null,
    };
  }

  private formatRetriesSpent(storyId: string): number {
    return this.counters.formatRetriesSpent(this.ctx.runDir, storyId);
  }

  private reviewerPrompt(
    story: StoryContext,
    dod: readonly DodResult[],
    refusal: string | null,
    /**
     * REQUIRED, with no default, on purpose: the bug #166 fixed is "somebody
     * forgot the base", and an optional parameter would let the next call site
     * forget it and silently render the epic branch again. A forgotten argument
     * is a typecheck failure instead.
     */
    diffBase: string | null,
    /**
     * gh #327: the open fix list this review is shown — REQUIRED for the reason
     * `diffBase` is: the spawn records exactly what it rendered, and a call site
     * that forgot the argument would render one set and close another.
     */
    fixRound: FixlistOnDisk | null,
  ): string {
    return reviewerPromptFor({
      diffBase,
      fixRound: fixRound === null ? null : { rel: fixRound.rel, findings: openFindings(fixRound.findings) },
      // gh #322: the note the person signed — the same value #308's check reads.
      reopenNote: this.reopenFor(story.planned),
      runDir: this.ctx.runDir,
      root: this.ctx.root,
      runId: this.ctx.runId,
      story: story.planned,
      branch: story.branch,
      epicBranch: story.epicBranch,
      worktree: story.worktree,
      dod,
      refusal,
      stackExperts: this.ctx.spec.stackExperts,
      fixlistRounds: this.fixlistRounds,
      counters: this.counters,
      focus: this.focus,
      lines: this.lines,
    });
  }

  /**
   * One verdict, recorded — the ledger line, the requeue counter and the task
   * row — whether a spawn produced it or a host did.
   *
   * Extracted from `spawnReviewer` when the reviewer became delegable, and the
   * extraction is the point: attempt accounting must not depend on which door a
   * verdict came through. `if (verdict !== "error")` moved WITH the parse, so a
   * host review counts a verdict exactly as a spawned one does, and a host that
   * never writes `result.json` has produced no verdict and spends no attempt.
   */
  private recordReview(
    story: StoryContext,
    review: Review,
    task: {
      costUsd: number;
      sessionId: string | null;
      error?: string | null;
      /** False ⇒ the turn was billed to the host session; `run.yml` records no dollars. */
      metered: boolean;
      tokens?: number;
      /** The provider's own accounting for this turn, when it reported any. */
      usage?: AgentUsage;
      /** The spawn's own wall clock, when this turn was spawned rather than hosted. */
      durationMs?: number;
      source: "agent" | "host";
      /**
       * WHO judged this diff, or null when nothing can say (`build/reviewerProvenance.ts`).
       *
       * Null is a real answer and the honest one for a host review whose session
       * declared no `--model`: the bundle's recorded model is a SUGGESTION, and
       * quoting it back as the model that produced the verdict would be a record
       * lying in the dangerous direction.
       */
      reviewer: ReviewerProvenance | null;
    },
  ): void {
    this.tasks.push({
      key: story.planned.story.id,
      model: task.metered ? this.model() : null,
      costUsd: task.costUsd,
      sessionId: task.sessionId,
      error: task.error ?? null,
      // Spawned or hosted, this row is the reviewer's turn (#234).
      role: "reviewer",
      outputs: [],
      ...(task.metered ? {} : { metered: false }),
      ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
      usage: task.usage,
      ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
    });
    const id = story.planned.story.id;
    // The requeue counter counts VERDICTS THAT COST AN ATTEMPT — two of the five
    // do not. An errored review consumed a turn's money but produced no
    // judgement. A `fixlist` produced a judgement and it was a SIGNATURE: the
    // diff was not faulted, so no second developer attempt is owed for it, and
    // the round it does buy is bounded by `narrowFixlist` instead.
    if (review.verdict !== "error" && review.verdict !== "fixlist") {
      this.counters.countVerdict(id);
    }
    // A verdict — any verdict — closes this envelope round, and the next one
    // starts with its corrections again (gh #78). Set to `0` rather than deleted
    // so this process's own answer keeps winning over a ledger it has not
    // finished writing; `readReviewLedger` resets on exactly the same events.
    this.counters.closeEnvelopeRound(id);
    // The reviewer IS a check: `approve` is the pass, `changes` and `error` the
    // two failures. `verdict` is what tells a ledger which one it is reading, and
    // `detail` on an errored review is the ERROR, verbatim.
    //
    // `source: "host"` is written ONLY for a host review — a reader can tell one
    // from a spawn's without joining it back to an `agent.spawned` that, for a
    // host, is deliberately absent. The spawned payload keeps its exact shape:
    // absence of the key means what it has always meant, and the ordinary path's
    // event sequence is unchanged byte for byte.
    //
    // The reviewer's own model rides on the event for the HOST door only, and
    // that asymmetry is deliberate. A spawned reviewer already records its exact
    // argv on the `agent.spawned` immediately above this line — adding the same
    // two values here would duplicate a derivation and change the payload of the
    // path that has always been byte-stable. A host review emits no
    // `agent.spawned` at all, so the declaration has nowhere else to live.
    // Absent means "not recorded", which is what every record written before
    // this shipped means too.
    const declared = task.source === "host" ? task.reviewer : null;
    this.ctx.emit(review.verdict === "approve" ? "check.passed" : "check.failed", {
      phase: this.ctx.phaseId,
      check: "review",
      story: id,
      verdict: review.verdict,
      attempt: story.attempt,
      ...(task.source === "host" ? { source: "host" } : {}),
      ...(declared === null
        ? {}
        : {
          ...(declared.model === null ? {} : { model: declared.model }),
          ...(declared.effort === null ? {} : { effort: declared.effort }),
          basis: declared.basis,
        }),
      detail: review.summary,
    });
    // What this invocation knows about the reviewer, for the story's own review
    // log — which is written later, by `settle`, out of a `StoryOutcome`.
    this.reviewers.set(id, task.reviewer);
  }

  // --- settling a story -----------------------------------------------------

  private async block(
    story: StoryContext,
    reason: string,
    cost: number,
    dod: readonly DodResult[] = [],
    extra: { commit?: string | null; conflicts?: readonly string[] } = {},
  ): Promise<void> {
    await this.settle(story, "blocked", {
      dod,
      commit: extra.commit ?? null,
      merged: false,
      carried: null,
      conflicts: extra.conflicts ?? [],
      verdict: "n-a",
      review: {
        verdict: "n-a", summary: "", findings: [], fixlist: [], fixlistProblems: [],
        formatProblems: [], verdictProblem: null,
      },
      cost,
      reason,
    });
  }

  private async settle(
    story: StoryContext,
    status: PlanStatus,
    parts: {
      dod: readonly DodResult[];
      commit: string | null;
      merged: boolean;
      /** Commits the merge moved: `0` for a no-op, `null` when not measured. */
      carried: number | null;
      /**
       * The epic's sha immediately before the merge — the base the reviewer's
       * diff was computed from (#166). `null` on every settle that did not watch
       * a merge happen, and OMITTED from `task.done` when it is: absent means
       * "not recorded", which readers turn back into the epic branch.
       */
      epicBase?: string | null;
      conflicts?: readonly string[];
      verdict: StoryOutcome["verdict"];
      review: Review;
      /** Non-null only when the developer sub-agent never delivered. */
      developerError?: string | null;
      /**
       * Keep the story's worktree even though it did not settle at `review`.
       * True for a developer failure: the story is going to be attempted again
       * from exactly here, and re-cutting the tree buys nothing.
       */
      keepWorktree?: boolean;
      cost: number;
      reason: string | null;
    },
  ): Promise<void> {
    const id = story.planned.story.id;
    const reviewRel = `${BUILD_PHASE}/${LOG_DIR}/${id}.md`;
    // #129, and it happens FIRST because the sha has to be in the outcome the
    // review log renders from. Worktrees survive a `review` and a parked
    // developer failure on purpose, and `--keep-worktrees` keeps every one of
    // them: those three are the cases where nothing is about to be deleted, so
    // there is nothing to rescue from.
    const pruning = status !== "review" && parts.keepWorktree !== true && !this.ctx.keepWorktrees;
    const rescued = pruning ? await this.rescueUncommitted(story, status, parts.reason) : null;
    let outcome: StoryOutcome = {
      id,
      title: story.planned.story.title,
      wave: story.planned.wave,
      repo: story.planned.story.repo,
      epic: story.planned.story.epic,
      epicBranch: story.epicBranch,
      branch: story.branch,
      status,
      attempts: story.attempt,
      dod: parts.dod,
      commit: parts.commit,
      merged: parts.merged,
      carried: parts.carried,
      conflicts: parts.conflicts ?? [],
      verdict: parts.verdict,
      // What THIS invocation recorded about the reviewer, or null. `recordReview`
      // is the only writer, so a story that settled without one — blocked before
      // any reviewer ran — carries null and its log says `not recorded`, which is
      // the truth about it.
      reviewer: this.reviewers.get(id) ?? null,
      developerError: parts.developerError ?? null,
      reviewSummary: parts.review.summary,
      reviewFindings: parts.review.findings,
      reviewRel,
      reason: parts.reason,
      permissionRefused: this.refusals.get(id) ?? null,
      // gh #285: what the workspace granted this developer, beside what it
      // refused — the pair is what names the operator's cure.
      declaredCommands: this.repoCommands(story.planned.story.repo),
      budgetDeath: this.capDeaths.get(id) ?? null,
      // gh #289: no reviewer was spawned for this story, and why. `verdict` is
      // `n-a` beside it — the record must not say something judged this diff.
      reviewerUnfunded: this.unfundedReviews.get(id) ?? null,
      // #279: with no developer spawned, the record must not read as though one
      // delivered this. Absent on every ordinary settle, where one did.
      asIs: this.asIsSettlements.get(id) ?? null,
      rescued,
      cost_usd: parts.cost,
    };
    this.outcomes.set(id, outcome);
    this.writeLog(outcome);
    this.recordStoryFeedback(outcome);

    // Evidence is REQUIRED of a done story (spec §2.13) and useful on a blocked
    // one: the conflicting paths are exactly what the human who unblocks it needs,
    // and they are gone from the tree by then — the merge is aborted so the epic
    // branch stays usable.
    const evidence = status === "done" && parts.commit !== null
      ? evidenceFor(parts.dod.map((r) => r.command), parts.commit, reviewRel)
      : outcome.conflicts.length > 0
        ? [...outcome.conflicts.map((path) => `merge conflict: ${path}`), reviewRel]
        : undefined;
    this.setStoryStatus(story.planned, status, evidence);
    // An implicit epic IS the implicit story — one file, one `status:` — so
    // writing the epic's status would immediately overwrite the story's.
    const epicStatus = this.plan.implicit ? null : this.updateEpicStatus(story.epic);

    // The story's work is final for the framework: the DoD has run, the merge into
    // the epic has happened or been refused, and the diff is on disk. This is the
    // last moment `epic_base` still names the epic tip the story was reviewed
    // against, which is why the measurement is taken HERE and not at the gate.
    if (status === "done") await this.measureSurface(story, parts.epicBase ?? null);

    // (h) #257: the epic just flipped to `done` — if any of its stories was
    // proven over its paths alone, the full list now runs on the epic head, and
    // a red there is THIS story's (it merged last). Before `task.done`, so the
    // ledger's final word on the story is the one the files carry.
    const headRed = epicStatus === "done" ? await this.checkEpicHead(story) : null;
    if (headRed !== null) {
      status = "blocked";
      outcome = { ...outcome, status, reason: headRed };
      this.outcomes.set(id, outcome);
      this.writeLog(outcome);
      this.setStoryStatus(story.planned, status, evidence);
      this.updateEpicStatus(story.epic);
    }

    this.ctx.emit("task.done", {
      phase: this.ctx.phaseId,
      story: id,
      wave: story.planned.wave,
      status,
      verdict: parts.verdict,
      commit: parts.commit,
      attempt: story.attempt,
      // ADDITIVE and omitted when unknown — never an empty string in the ledger,
      // because absent is what a reader falls back from (#166).
      ...(parts.epicBase === null || parts.epicBase === undefined || parts.epicBase === ""
        ? {}
        : { epic_base: parts.epicBase }),
      // ADDITIVE (gh #271): the command the permission layer refused on an
      // attempt the DoD went on to decide. Omitted when there was none.
      // Clamped (gh #359): the command is copied verbatim from the agent and
      // can be arbitrarily long (a multi-line heredoc, measured); the FULL
      // text is unaffected — it is in `reviewRel`, written above by `writeLog`.
      ...(outcome.permissionRefused == null
        ? {}
        : { permission_refused: clampAgentText(outcome.permissionRefused, reviewRel) }),
      // ADDITIVE (gh #277): the cap the developer died on during an attempt the
      // DoD went on to decide. Omitted when there was none. Clamped (gh #359):
      // same reasoning — a developer's own kill message is not bounded either.
      ...(outcome.budgetDeath == null ? {} : { budget_death: clampAgentText(outcome.budgetDeath, reviewRel) }),
      // ADDITIVE (gh #289): no reviewer was spawned because the stage could not
      // fund one. Omitted on every turn where one was.
      ...(outcome.reviewerUnfunded == null ? {} : { reviewer_unfunded: outcome.reviewerUnfunded }),
      // ADDITIVE (gh #279): the branch was taken AS IT STANDS and no developer
      // was spawned for it — with the person who signed that, and their note.
      // Omitted on every ordinary turn, where absent means what it always meant.
      ...(outcome.asIs == null
        ? {}
        : { as_is: true, as_is_by: outcome.asIs.actor, as_is_note: outcome.asIs.note }),
      // ADDITIVE (gh #295): WHICH as-is case this was. Omitted on the case #279
      // shipped, so a record written before this key reads as it always did.
      ...(outcome.asIs?.reason === undefined ? {} : { as_is_reason: outcome.asIs.reason }),
    });
    // Worktrees survive a `review` on purpose: the second attempt continues in
    // the same tree rather than re-cutting the branch it just wrote. A parked
    // developer failure keeps its tree for the same reason — and, since #129, so
    // does a tree whose changes could not be made to reach a ref.
    // `worktree` is non-null on exactly one shape: the rescue could not commit,
    // so the tree is the ONLY copy and it stays.
    if (pruning && (rescued === null || rescued.worktree === null)) {
      await removeWorktree(story.repoDir, story.worktree);
    }
    this.lines.push(
      `  ${status === "done" ? "✓" : "·"} ${id} → \`${status}\`` +
        (outcome.reason === null ? "" : ` (${outcome.reason})`) +
        (outcome.asIs == null
          ? ""
          : ` — ${outcome.asIs.reason === "review-only" ? AS_IS_REVIEW_ONLY_MARK : AS_IS_MARK}; `
            + `${outcome.asIs.actor} signed it`) +
        (outcome.permissionRefused == null
          ? ""
          : ` — ${withCure(
            `\`${outcome.permissionRefused}\` was refused for approval; the tree held committed work, so the DoD decided`,
            outcome.permissionRefused,
            outcome.declaredCommands,
          )}`),
    );
  }

  private writeLog(outcome: StoryOutcome): void {
    const dir = join(this.ctx.runDir, BUILD_PHASE, LOG_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${outcome.id}.md`), renderReviewLog(outcome), "utf8");
  }

  /**
   * The story's own push-back, appended to `retro.md` as it settles.
   *
   * This is the only place a reviewer's `changes` verdict and a first-attempt DoD
   * failure become something a ROLE expert can ever read: `mineRuns` reads
   * `handoff.md` and `retro.md`, and until now `retro.md` existed only when a
   * human typed `tldrx retro`. Measured 2026-08-29: all five role experts sat at
   * level 0 with nothing to mine.
   */
  private recordStoryFeedback(outcome: StoryOutcome): void {
    appendBuildRetro(this.ctx.runDir, storyRetroLines(outcome, this.ctx.runId));
  }

  /**
   * Gate rejections and revocations, recovered from `events.jsonl`.
   *
   * They happen BETWEEN invocations — `tldrx reject` is a separate command — so
   * they are read at the top of the next Build run rather than emitted where they
   * occur. Appending is deduped verbatim, so re-running over the same log adds
   * nothing.
   */
  private recordGateFeedback(): void {
    appendBuildRetro(this.ctx.runDir, gateRetroLines(this.ctx.runDir, this.ctx.runId));
  }

  /** The synthesised plan is an output of the phase that synthesised it. */
  private planOutputs(): readonly string[] {
    return this.plan.implicit ? [IMPLICIT_PLAN_REL] : [];
  }

  /** `retro.md` is an output only when something was actually appended to it. */
  private retroOutputs(): readonly string[] {
    return existsSync(buildRetroPath(this.ctx.runDir)) ? [RETRO_REL] : [];
  }

  // --- the end of the phase -------------------------------------------------

  private async finish(): Promise<ExecutorOutcome> {
    // The operator's tree comes back FIRST, before the handoff is written: a
    // restore that fails has to be nameable in `## Unknowns`, and a document that
    // said "nothing needs a human" over a stash the framework could not give back
    // would be the record lying in the dangerous direction (§7).
    const restored = await this.restoreForeignWorkAside();
    // The epic worktrees are deliberately NOT removed here (issue #16, owner
    // decision 2026-09-01). They belong to the RUN, not to this stage: a later
    // Watch stage cites code that is committed on the epic branch and merged
    // nowhere, and `resolveSrc` can only resolve that against a checkout that is
    // still on disk. `cleanUpRunEpicWorktrees` takes them at run close instead.
    const outcomes = this.orderedOutcomes();
    const done = outcomes.filter((o) => o.status === "done").length;
    const notStarted = this.scheduledWithoutOutcome(outcomes);
    // BEFORE the handoff, because the handoff is the gate document and this is the
    // question a human was answering by hand at it (#163, sub-fix 2). It is also
    // the earliest moment the question CAN be answered: a defect closed by a later
    // story is only closed once that story has merged.
    const sweep = await this.sweepFixlists(outcomes);
    this.writeHandoff(outcomes, notStarted, sweep);
    return {
      ok: true,
      awaiting: false,
      tasks: this.tasks,
      costUsd: this.spent(),
      outputs: [...this.logPaths(), HANDOFF_REL, ...this.planOutputs(), ...this.retroOutputs()],
      // Build always stops at a human: nothing here merges an epic to a default
      // branch, so somebody has to.
      gate: "approve",
      lines: [
        // Over every SCHEDULED story, which is what `waves.yml` says — not over
        // the rows this process happens to hold. `orderedOutcomes` drops a `todo`
        // story, so the old denominator shrank to hide exactly the stories that
        // were never started: `5 of 8` was reported as `5 of 5` on the run #260
        // came from (#260).
        `${this.ctx.phaseId}/${this.ctx.stageId}: ${String(done)} of ` +
          `${String(outcomes.length + notStarted.length)} story(ies) done ` +
          `across ${String(this.plan.waves.length)} wave(s)`,
        ...this.lines,
        `wrote ${HANDOFF_REL}`,
        // A failed restore is moved to the very END of the report by `out()` in
        // `runNext.ts` — after `gate pending`, which this stage always writes.
        ...restored,
      ],
      stderr: [...this.advisories],
      error: null,
    };
  }

  /**
   * Every story `waves.yml` scheduled that has NO outcome row — named with why,
   * so the handoff's `none — every scheduled story reached done` sentence is
   * decided against the plan rather than against this process's memory (#260).
   *
   * With the dependency frontier in place this is normally empty: a story held
   * back by a dependency settles `blocked` and HAS a row. It is the residue — a
   * story the phase never reached for any other reason — and the point is that
   * the residue is nameable at all. Silence about it is what let a stage report
   * `done` over three stories it never started.
   */
  private scheduledWithoutOutcome(outcomes: readonly StoryOutcome[]): readonly NotStartedStory[] {
    const named = new Set(outcomes.map((o) => o.id));
    // Read ONCE, not per story: it is one fact about the run, and it is a file
    // parse. Read here rather than remembered from the loop, because the cancel
    // can land after the last story was decided.
    const cancelled = this.cancelledUnder();
    const rows: NotStartedStory[] = [];
    for (const wave of this.plan.waves) {
      for (const planned of wave.stories) {
        if (named.has(planned.story.id)) continue;
        const wait = this.waits.get(planned.story.id);
        rows.push({
          id: planned.story.id,
          rel: this.plan.implicit ? IMPLICIT_PLAN_REL : planned.rel,
          status: this.statusOf(planned),
          // A wait IS a reason (#280); a quota park is one too (gh #298), and it
          // covers EVERY story left unstarted after the warning — including the
          // ones a wave's lanes never pulled, which get no operator line of their
          // own. Without it the handoff said "no reason for it" over a reason
          // this stage had printed, recorded and acted on: the audit record
          // lying in the dangerous direction (AGENTS.md §7). The dependency wait
          // wins where there is one — it is the more specific fact about THAT
          // story. The residue below is the one there really is no reason for.
          // The order is the order the loop itself takes its doors, so the
          // audit record and the live report can never name different causes
          // for the same withheld story (gh #298's review): a dependency wait is
          // the most specific fact about THIS story; a cancel stops everything
          // and is checked before the park at both spawn doors, so it wins over
          // the park here too — a quota warning that was true is not why the run
          // stopped once a person cancelled it. The residue is the one there
          // really is no reason for.
          reason: wait !== undefined
            ? dependencyWaitReason(wait)
            : cancelled
              ? CANCELLED_UNDER_STAGE
              : this.rateLimitPark !== null
                ? this.rateLimitReason(this.rateLimitPark)
                : "this stage recorded no attempt and no reason for it — "
                  + "nothing here says the work was done, and nothing says why it was not",
        });
      }
    }
    return rows;
  }

  /**
   * Re-check every still-open fix-list finding of this run against its epic tip,
   * and write down what came back (#163, sub-fix 2).
   *
   * The orchestrator's whole share of it: which stories have a fix list, where
   * their repos are, and the single write per file. The judgement — what counts as
   * a candidate, what evidences a close, how the two kinds of close are spelled
   * apart, what a sweep that could not be taken says — lives in
   * `build/fixlistSweep.ts` and takes DATA (§12).
   *
   * Nothing here decides anything. `yes-on-epic` is not `yes`, so every finding
   * this touches is exactly as open afterwards as it was before, and no story's
   * status is recomputed: `finish` runs after the last settlement. A file that
   * cannot be read or a repo that cannot be located is reported as an absence with
   * its reason, never as a story with nothing to sweep (§7).
   */
  private async sweepFixlists(outcomes: readonly StoryOutcome[]): Promise<readonly SweepOutcome[]> {
    const rows: SweepOutcome[] = [];
    for (const outcome of outcomes) {
      const fixlist = latestFixlist(this.ctx.runDir, BUILD_PHASE, outcome.id);
      if (fixlist === null) continue;
      let repoDir: string;
      let text: string;
      try {
        repoDir = repoDirOf(this.workspace, outcome.repo);
        text = readFileSync(fixlist.path, "utf8");
      } catch (error) {
        const why = firstLine(error instanceof Error ? error.message : String(error));
        rows.push({
          storyId: outcome.id, rel: fixlist.rel, epicTip: null, closed: [], touched: [], unmeasured: [],
          examined: 0,
          absence: `its fix list could not be re-read for the sweep — ${why}`,
        });
        this.lines.push(
          `  · ${outcome.id}: the run-level fix-list sweep could not be taken — ${why}`,
        );
        continue;
      }
      const swept = await sweepFixlistAgainstEpic(
        {
          storyId: outcome.id,
          repo: outcome.repo,
          repoDir,
          branch: outcome.branch,
          epicBranch: outcome.epicBranch,
        },
        fixlist,
        text,
        this.ctx.at,
      );
      if (swept.text !== null) writeFileSync(fixlist.path, swept.text, "utf8");
      rows.push(swept.outcome);
      if (swept.outcome.examined === 0) continue;
      if (swept.outcome.absence !== null) {
        this.lines.push(
          `  · ${outcome.id}: the run-level fix-list sweep could not be taken — ${swept.outcome.absence}`,
        );
        continue;
      }
      this.lines.push(
        `  · ${outcome.id}: ${String(swept.outcome.examined)} still-open fix-list finding(s) re-checked `
        + `against \`${outcome.epicBranch}\` @ ${swept.outcome.epicTip ?? "(no tip)"} — `
        + (swept.outcome.closed.length === 0
          ? "none is evidenced closed by a later story, so each stays open and the file says the sweep ran"
          : `${swept.outcome.closed.map((c) => `#${String(c.n)}`).join(", ")} `
            + `closed on the EPIC by a later story, not by ${outcome.id} — recorded `
            + `\`Resolved: ${CLOSED_ON_EPIC} ${swept.outcome.closed[0]?.sha ?? ""}\``)
        + (swept.outcome.touched.length === 0
          ? ""
          : `; ${swept.outcome.touched.map((t) => `#${String(t.n)}`).join(", ")} still open with the `
            + "cited file changed by a later story — named, not resolved"),
      );
    }
    return rows;
  }

  private writeHandoff(
    outcomes: readonly StoryOutcome[],
    notStarted: readonly NotStartedStory[],
    sweep: readonly SweepOutcome[],
  ): void {
    const path = join(this.ctx.runDir, HANDOFF_REL);
    mkdirSync(join(path, ".."), { recursive: true });
    // The PHASE's spend, not this process's — the header sits on a document whose
    // own docstring says it describes the phase (#138). `ExecutorOutcome.costUsd`
    // below stays `this.spent()` on purpose: that one is ADDED to the run budget,
    // and a phase-to-date number there would double-count on every re-entry.
    const cost = phaseCostToDate(
      this.ctx.runDir, this.ctx.phaseId, this.ctx.stageId, this.spent(), this.tasks,
      // PHASE-to-date, the same scope as the `$X of $Y` it qualifies (#170): the
      // ceilings come off `agent.spawned`, which recorded each one at the spawn,
      // plus this invocation's turns, which are not in the log yet.
      storySpendToDate(this.ctx.runDir, this.ctx.phaseId, this.ctx.stageId, this.tasks),
    );
    // ONE walk for both fields, and the leaf derives its own phase list from the
    // run dir — the executor's `ctx` carries none, and passing one from here is
    // how the handoff and the PR body became able to see different stories.
    const carried = this.carriedRows();
    writeFileSync(path, renderBuildHandoff({
      runId: this.ctx.runId,
      stageId: this.ctx.stageId,
      model: this.model(),
      costUsd: cost.usd,
      costNote: cost.note,
      unmeteredTasks: cost.unmetered,
      meteredTasks: cost.metered,
      decidedNote: describeDecidedTally(
        decidedTally(FactsStore.loadOrEmpty(factsPath(this.ctx.root)).facts, this.ctx.runId),
      ),
      budgetUsd: this.ctx.budgetUsd,
      at: this.ctx.at,
      outcomes,
      epics: this.epicRows(outcomes),
      storiesRel: this.plan.implicit ? IMPLICIT_PLAN_REL : null,
      carried: carried.rows,
      notStarted,
      unreadableStories: carried.unreadable,
      widenings: this.wideningRows(),
      epicReleases: this.epics.released,
      // The failed restores only. A stash that came back is not an unknown.
      sweep,
      foreignWork: unrestored(this.restores).map((outcome) => ({
        repo: outcome.stash.repo,
        paths: outcome.conflicts.length > 0 ? outcome.conflicts : outcome.stash.paths,
        stashRef: outcome.stash.hash,
        command: outcome.command,
        detail: outcome.detail,
      })),
    }), "utf8");
  }

  /**
   * Carried findings this phase leaves owed that no story's surface covers (#171).
   *
   * Computed nowhere here: `carriedReportFor` walks the fix lists and the declared
   * surfaces, and the two predicates behind it live in `build/fixlist.ts` and
   * `build/unownedFindings.ts`. The executor stays an orchestrator — it hands
   * over the run directory and the workspace's repo names, which is the same set
   * `toSrcContext` gives the `[src:]` grammar, and renders whatever comes back.
   */
  private carriedRows(): CarriedReport {
    return carriedReportFor(this.ctx.runDir, new Set(this.workspace.repos.keys()));
  }

  /**
   * Every widening this run recorded, operator-declared and framework-measured
   * alike (#171, #185), read back off `events.jsonl` rather than remembered.
   *
   * Read rather than remembered for two reasons. A `tldrx story widen` happens
   * BETWEEN invocations — it is a separate command, exactly like the gate
   * rejections `recordGateFeedback` recovers the same way — so this process never
   * saw it. And a measured widening from an earlier `tldrx next` belongs in a
   * handoff that describes the PHASE, not the invocation. `wideningRows` is total
   * and labels each row's basis; the log never throws here (`read()` is tolerant).
   */
  private wideningRows(): readonly WideningRow[] {
    try {
      return wideningRows(readFileSync(join(this.ctx.runDir, EVENTS_FILE), "utf8"));
    } catch {
      return [];
    }
  }

  /**
   * The reading `touches` never had: what the story ACTUALLY changed, measured off
   * its own diff at the moment its work is final (#185).
   *
   * Advisory by construction — it appends one event and returns. It cannot refuse,
   * it does not touch the story file, and every failure below is an absence rather
   * than a throw: a story whose diff cannot be read is a story with no measurement,
   * never a story that fails to settle. `touches` stays the operator's forecast and
   * `story widen` stays the operator's verb; this only says what was measured.
   *
   * The range is `reviewDiffRange` and nothing else — the same string the
   * reviewer's `diff:` command names — so "the story's diff" has one definition
   * (AGENTS.md §7).
   */
  /**
   * The story's `touches:` OFF DISK, through the same reader `deriveSurface`
   * walks — not the plan snapshot this invocation parsed at its start. `tldrx
   * story widen` is allowed on an `in_progress` story, so a long headless run
   * can have its surface declared out from under the snapshot; the snapshot is
   * the fallback only when this run has no story file at all. One reading,
   * shared by the surface measurement and the scoped DoD (#257).
   */
  private declaredTouches(story: StoryContext): readonly string[] {
    return declaredTouchesFor(this.ctx.runDir, story.planned.story.id) ?? story.planned.story.touches;
  }

  private async measureSurface(story: StoryContext, epicBase: string | null): Promise<void> {
    // Off DISK, through the same reader `deriveSurface` walks — not the plan
    // snapshot this invocation parsed at its start. `tldrx story widen` is
    // allowed on an `in_progress` story, so a long headless run can have its
    // surface declared out from under the snapshot; falling back to the snapshot
    // only when this run has no story file at all keeps the measurement possible
    // for a scope that has neither.
    const declared = this.declaredTouches(story);
    const range = reviewDiffRange(epicBase, story.epicBranch, story.branch);
    const diff = await git(["diff", "--name-only", range], story.repoDir);
    if (!diff.ok) return;
    const changed = diff.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const measured = measuredWidening(changed, declared);
    if (measured === null) return;
    const id = story.planned.story.id;
    // Not the operator and not a sub-agent: the framework read this off a diff.
    const actor = "framework";
    try {
      this.ctx.emit(
        "story.touches_widened",
        {
          story: id,
          paths: [...measured.paths],
          note: measured.note,
          before: [...measured.before],
          after: [...measured.after],
          // ADDITIVE, and the whole of what separates this row from an operator's:
          // absent means `declared`, which is what every row written before this
          // field existed is (`build/measuredTouches.ts`).
          basis: "measured",
        },
        0,
        actor,
      );
      return;
    } catch (error) {
      // #249: the emit is the one line above that could throw, and it did — on a
      // live run, for a payload the cap could not carry — and the throw went out
      // through `settle`, between the story's `done` on disk and its `task.done`
      // in the ledger, taking two paid turns' rows with it. "Advisory" has to
      // cover the emit as much as the git read: what gets recorded instead is a
      // BOUNDED absence on the same event — the counts, and a note naming why
      // the lists are not here — so a reader still sees the widening happened
      // and by how much (§7: absent with a reason, never silent).
      const why = firstLine(error instanceof Error ? error.message : String(error));
      try {
        this.ctx.emit(
          "story.touches_widened",
          {
            story: id,
            paths_omitted: measured.paths.length,
            before_omitted: measured.before.length,
            after_omitted: measured.after.length,
            note: `${measured.note} — the lists could not be recorded on this event: ${why}`,
            basis: "measured",
          },
          0,
          actor,
        );
      } catch (again) {
        // The log itself is refusing. The story still settles — this measurement
        // is advisory — and the loss is said where the operator reads it.
        this.advisories.push(
          `${id}: the measured widening of its surface (${String(measured.paths.length)} path(s) outside `
          + `\`touches:\`) could not be recorded in events.jsonl — `
          + firstLine(again instanceof Error ? again.message : String(again)),
        );
      }
    }
  }

  /**
   * Outcomes from this process, plus a row read off disk for any story a previous
   * `next` already settled — the handoff describes the phase, not the invocation.
   */
  private orderedOutcomes(): readonly StoryOutcome[] {
    const rows: StoryOutcome[] = [];
    for (const wave of this.plan.waves) {
      for (const planned of wave.stories) {
        const fresh = this.outcomes.get(planned.story.id);
        if (fresh !== undefined) {
          rows.push(fresh);
          continue;
        }
        const status = this.statusOf(planned);
        if (status === "todo") continue;
        rows.push(this.fromDisk(planned, status));
      }
    }
    return rows;
  }

  /**
   * A story settled by an earlier `next`; its log is already on disk.
   *
   * Every field here is READ, not defaulted, wherever the run recorded it (#137).
   * The row used to be a thin sketch — `dod: []`, `commit: null` — and the
   * handoff renders from it, so a re-entered stage overwrote its own Evidence
   * ledger with `- no Definition of Done ran` over two green DoD runs and its
   * Findings with `at (no commit)` over a merged sha. Both facts are in
   * `events.jsonl`: `readReviewLedger` is the same reader `rereview` trusts when
   * it declines to re-run a DoD, so trusting it here asserts nothing new.
   *
   * What is NOT reconstructed is `carried`. It is measured before the merge and
   * stored nowhere, and afterwards it cannot be measured at all. It stays `null`
   * and the Gate section says so in words — see `mergeSummary`.
   */
  private fromDisk(planned: PlannedStory, status: PlanStatus): StoryOutcome {
    const epic = this.plan.epics.get(planned.story.epic);
    const ledger = readReviewLedger(this.ctx.runDir, planned.story.id);
    const outcome: StoryOutcome = {
      id: planned.story.id,
      title: planned.story.title,
      wave: planned.wave,
      repo: planned.story.repo,
      epic: planned.story.epic,
      epicBranch: epic === undefined ? "" : epicBranchOf(this.branchModel, epic.epic.branch),
      // The SAME derivation the cut used. This row is read by a human who may
      // `git show` the branch it names, and a name assembled a second way here
      // named a ref no repo had (#134).
      branch: storyBranchOf(this.ctx.runId, planned.story.id),
      status,
      attempts: Math.max(this.reviewAttempts(planned.story.id), 1),
      dod: ledger.dod,
      // The commands the plan declares and the ledger could NOT account for. An
      // empty `dod` beside an empty list is a story with no dod block; beside a
      // populated one it is a gap, and the two must not render alike.
      dodUnrecovered: ledger.dod.length === 0 ? planned.dod.commands : [],
      commit: ledger.commit,
      merged: status === "done",
      carried: null,
      conflicts: [],
      verdict: status === "done" ? "approve" : "n-a",
      // Reconstructed from the LEDGER, never from the stage's current pin: this
      // row describes a review an earlier process ran, possibly on a stage file
      // that has since been edited.
      reviewer: ledger.reviewer,
      developerError: null,
      reviewSummary: "settled by an earlier `tldrx next`",
      reviewFindings: [],
      reviewRel: `${BUILD_PHASE}/${LOG_DIR}/${planned.story.id}.md`,
      reason: status === "done" ? null : "settled by an earlier `tldrx next`",
      // This invocation rescued nothing: the story settled in a process that has
      // already gone. Whatever it rescued is in ITS log, not reconstructed here.
      rescued: null,
      cost_usd: 0,
    };
    if (!existsSync(join(this.ctx.runDir, outcome.reviewRel))) this.writeLog(outcome);
    return outcome;
  }

  private epicRows(outcomes: readonly StoryOutcome[]): readonly EpicSummaryRow[] {
    return epicRows(this.epics, {
      workspace: this.workspace,
      epics: this.plan.epics,
      branchModel: this.branchModel,
      stories: this.plan.stories,
    }, outcomes);
  }

  // --- helpers --------------------------------------------------------------

  private async refuseOnForeignEpic(): Promise<ExecutorOutcome | null> {
    const refusal = await foreignEpicRefusal(this.epics, this.claimParts, this.pendingStories());
    return refusal === null ? null : {
      ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
      lines: refusal.lines, error: refusal.error,
    };
  }

  /** What `build/branchClaims.ts` needs to claim, refuse or report an epic branch. */
  private get claimParts(): ClaimParts {
    return {
      runId: this.ctx.runId,
      runDir: this.ctx.runDir,
      root: this.ctx.root,
      workspace: this.workspace,
      epics: this.plan.epics,
      branchModel: this.branchModel,
      reuseEpic: this.ctx.reuseEpic,
      lines: this.lines,
      at: this.ctx.at,
      emit: (type, payload) => { this.ctx.emit(type, payload); },
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
    };
  }

  /** What `build/worktrees.ts` needs to open — or merge into — an epic worktree. */
  private epicParts(story: StoryContext): EpicWorktreeParts {
    return {
      root: this.ctx.root,
      runId: this.ctx.runId,
      repo: story.planned.story.repo,
      repoDir: story.repoDir,
      epicId: story.planned.story.epic,
      epicBranch: story.epicBranch,
      branchModel: this.branchModel,
      defaultBranch: this.workspace.defaultBranches.get(story.planned.story.repo) ?? "main",
    };
  }

  /** What `build/dodRunner.ts` needs to measure or recall the base tree. */
  private get baseParts(): BaseParts {
    return {
      workspace: this.workspace,
      cache: this.preflight,
      at: this.ctx.at,
      preparing: this.ctx.mode === "prepare",
      relaunching: this.ctx.relaunching,
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      runDir: this.ctx.runDir,
      write: (work) => this.writes.run(work),
      advisories: this.advisories,
    };
  }

  /**
   * The one refusal that happens AFTER the stash — so it is the one that has to
   * carry this session's own lines, including the sentence saying work was set
   * aside. `withRestore` appends the sentence saying it came back.
   */
  private async refuseOnRedBase(): Promise<ExecutorOutcome | null> {
    const refusal = await redBaseRefusal(this.baseParts, this.pendingStories());
    return refusal === null ? null : {
      ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
      lines: [...this.lines, ...refusal.lines], error: refusal.error,
      // #339: the supervisor's repeat guard needs to know whether the sentence it is
      // about to compare was MEASURED by this attempt. Passed through, never re-derived.
      ...(refusal.freshness === undefined ? {} : { signatureFreshness: refusal.freshness }),
    };
  }

  /** What `build/entryProbe.ts` needs to ask a FRESH worktree the same question (#254). */
  private get entryProbeParts(): EntryProbeParts {
    return {
      workspace: this.workspace,
      cache: this.preflight,
      root: this.ctx.root,
      runId: this.ctx.runId,
      at: this.ctx.at,
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      write: (work) => this.writes.run(work),
      advisories: this.advisories,
      lines: this.lines,
    };
  }

  /**
   * The LAST door (#254), after the base pre-flight and for the same reason it is
   * after the stash: it needs the clean tree the stash produced, and it opens a
   * worktree of the base sha, which a dirty repo would have made a measurement of
   * somebody's uncommitted work. `withRestore` carries its lines out.
   *
   * Its order relative to `refuseOnRedBase` is deliberate and cheap: a command
   * that is red in the OWNER'S OWN checkout is the simpler fault and the better
   * sentence, and saying it first means the expensive probe is never paid for a
   * workspace that was going to refuse anyway.
   */
  private async refuseOnUnrunnableWorktree(): Promise<ExecutorOutcome | null> {
    const refusal = await entryProbeRefusal(this.entryProbeParts, this.pendingStories());
    return refusal === null ? null : {
      ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
      lines: [...this.lines, ...refusal.lines], error: refusal.error,
    };
  }

  /** The session's own report lines, for the exit paths that compose their own. */
  get reportLines(): readonly string[] {
    return this.lines;
  }

  /**
   * The dirty-tree door (#164): refuse what a story is about to write, set the
   * rest aside, and cut the epic branch from a clean tree either way.
   *
   * The stash happens HERE — before `refuseOnForeignEpic` and before the base
   * pre-flight — because a clean tree is precisely what the pre-flight's
   * measurement is worth anything over. It is recorded before anything else can
   * fail: `worktree.foreign_work_aside` is appended in the same step, so a crash
   * one line later still leaves the operator a log entry naming their stash.
   */
  private async refuseOnDirtyRepos(): Promise<ExecutorOutcome | null> {
    const plan = await dirtyRepoRefusal(
      { ...this.claimParts, mode: this.ctx.mode }, this.pendingStories(),
    );
    this.aside = plan.aside;
    if (plan.refusal !== null) {
      return {
        ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
        lines: plan.refusal.lines, error: plan.refusal.error,
      };
    }
    if (plan.ignored > 0) {
      this.lines.push(`  · ignoring ${String(plan.ignored)} tldrx state file(s) in the dirty-tree check`);
    }
    return null;
  }

  /**
   * Take the stash — and take it LAST, after every other door has passed.
   *
   * The order is the fix for the reviewer's Critical (2026-09-09). The stash used
   * to be the FIRST thing Build did, so the foreign-epic refusal and the base
   * pre-flight could both refuse with the operator's files already moved, through
   * a return path that neither restored them nor even printed the line saying they
   * had gone. Reproduced: exit 2, a stash on the list, the file missing from the
   * tree, nothing said, and a re-run that refused forever.
   *
   * `refuseOnRedBase` is the one door that stays AFTER this, and it has to: a
   * pre-flight measured over a dirty tree is the measurement this entire guard
   * exists to protect. That path restores on its way out (`withRestore` in
   * `buildExecutor` wraps every return) and carries both sentences.
   */
  private async setAsideForeign(): Promise<ExecutorOutcome | null> {
    for (const row of this.aside) {
      const reason = "uncommitted work no pending story declares in its `touches:` — set aside so the "
        + "base pre-flight measures the tree the stories are cut from";
      const outcome = await setAsideForeignWork(row.repo, row.repoDir, this.ctx.runId, row.paths);
      if (outcome.stash === null) {
        return {
          ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
          lines: [
            `[tldrx] build: repo \`${row.repo}\` has ${String(row.paths.length)} uncommitted change(s) that `
              + `are nobody's story, and they could not be set aside: ${outcome.reason ?? "no reason given"}.`,
            `  ${namePaths(row.paths)}`,
            "  Commit them, or set them aside by hand, then run "
              + `\`${relaunchCommand(this.ctx.mode, this.ctx.runId)}\`.`,
          ],
          // WHY it could not be set aside, which the line above already says and the
          // comparand did not (gh #297): a run comes back to the same repo, so a
          // sentence that names only the repo makes two different stash failures the
          // same refusal.
          error: `repo \`${row.repo}\` has uncommitted changes that could not be set aside: `
            + `${outcome.reason ?? "no reason given"}`,
        };
      }
      this.ctx.emit(FOREIGN_ASIDE_EVENT, asidePayload(outcome.stash, reason));
      this.lines.push(
        `  · ${row.repo}: ${String(row.paths.length)} uncommitted change(s) nobody's story declares — `
        + `set aside in stash ${outcome.stash.hash.slice(0, 12)} (${namePaths(row.paths)}) and `
        + "given back when this stage ends",
      );
    }
    return null;
  }

  /**
   * Give every stash this run opened back — the one place, on every exit path.
   *
   * Read off `events.jsonl` rather than off a field, because the two moments are
   * not always in one process: a cursor-driven Build sets the work aside on the
   * invocation that cuts the branch and finishes the stage several `tldrx next`
   * calls later. Idempotent by construction — a stash with a `restored: true`
   * event is not pending — so calling it twice, or on a path that set nothing
   * aside, does nothing at all.
   *
   * Never forces, never drops. A pop git refuses is recorded `restored: false`
   * with the literal command, and the run's own outcome is unchanged: the exit
   * code answers for the run's work, not for the operator's tree.
   */
  async restoreForeignWorkAside(): Promise<readonly string[]> {
    let open: readonly AsideStash[];
    try {
      open = pendingAsides(
        readFileSync(join(this.ctx.runDir, EVENTS_FILE), "utf8"),
        (repo) => {
          try {
            return repoDirOf(this.workspace, repo);
          } catch {
            return null;
          }
        },
      );
    } catch {
      return [];
    }
    const lines: string[] = [];
    for (const stash of open) {
      // ONCE PER PROCESS. A refused pop leaves the stash pending on the log —
      // deliberately, so a later invocation may try again when the path is free —
      // but trying it twice inside one invocation would pop nothing and write a
      // second identical `restored: false` event, which is a record of an attempt
      // nobody made a decision about.
      if (this.restoreAttempted.has(stash.hash)) continue;
      this.restoreAttempted.add(stash.hash);
      const outcome = await restoreForeignWork(stash);
      this.restores.push(outcome);
      this.ctx.emit(FOREIGN_RESTORED_EVENT, restoredPayload(outcome));
      lines.push(outcome.restored
        ? `  · ${restoredLine(outcome)}`
        : `[tldrx] build: ${notRestoredLine(outcome)}`);
    }
    return lines;
  }

  private pendingStories(): readonly PlannedStory[] {
    const rows: PlannedStory[] = [];
    for (const wave of this.plan.waves) {
      for (const planned of wave.stories) {
        const status = this.statusOf(planned);
        if (status === "done") continue;
        // `blocked` is terminal in-run — unless what blocked it was a developer
        // that never ran, or a dependency that has since landed (#280): in both
        // the story was never really attempted and is owed the turn it did not get.
        if (status === "blocked" && this.blockedByFailedDeveloper(planned) === null
          && this.staleDependencyHold(planned) === null) continue;
        rows.push(planned);
      }
    }
    return rows;
  }

  private nextPending(): PlannedStory | null {
    return this.pendingStories()[0] ?? null;
  }

  /** The story a `--prepare` cycle handed out; the file says so. */
  private inProgress(): PlannedStory | null {
    return this.pendingStories().find((p) => this.statusOf(p) === "in_progress") ?? null;
  }

  /** The story's status as it is ON DISK — the file is the state (spec §1). */
  private statusOf(planned: PlannedStory): PlanStatus {
    const fresh = this.outcomes.get(planned.story.id);
    if (fresh !== undefined) return fresh.status;
    try {
      const value = /^status\s*:\s*(\w+)\s*$/m.exec(readFileSync(planned.path, "utf8"))?.[1];
      return isPlanStatus(value) ? value : planned.story.status;
    } catch {
      return planned.story.status;
    }
  }

  private setStoryStatus(planned: PlannedStory, status: PlanStatus, evidence?: readonly string[]): void {
    const text = readFileSync(planned.path, "utf8");
    // An implicit plan has no `---` front matter: the whole file is the story's
    // YAML, and `status:`/`evidence:` sit at its top level.
    const patched = this.plan.implicit
      ? updateImplicitPlan(text, { status, evidence })
      : updateStoryFront(text, { status, evidence });
    writeFileSync(planned.path, patched, "utf8");
  }

  /**
   * `[assumption]` — spec §2.14 gives an epic the story states and says nothing
   * about who moves them, so the executor keeps it honest: `done` when every story
   * is, `blocked` when any is, `in_progress` otherwise.
   */
  private updateEpicStatus(epic: PlannedEpic): PlanStatus {
    const statuses = epic.epic.stories.map((id) => {
      const planned = this.plan.stories.get(id);
      return planned === undefined ? "todo" : this.statusOf(planned);
    });
    const status: PlanStatus = statuses.every((s) => s === "done")
      ? "done"
      : statuses.some((s) => s === "blocked")
        ? "blocked"
        : "in_progress";
    writeFileSync(epic.path, updateStoryFront(readFileSync(epic.path, "utf8"), { status }), "utf8");
    return status;
  }

  private noteMerged(story: StoryContext, carried: number | null): void {
    this.epics.noteMerged(story.epicBranch, story.planned.story.id, carried);
  }

  private developerPrompt(story: StoryContext, fixlist: FixlistOnDisk | null = null): string {
    const repo = story.planned.story.repo;
    const facts = FactsStore.loadOrEmpty(factsPath(this.ctx.root));
    // The story's `touches:` is exactly the list of paths this sub-agent will
    // edit, so a domain expert that has read one of them is the one to load.
    const bundles = loadExpertBundles({
      root: this.ctx.root,
      staged: this.ctx.spec.planned.experts.length === 0 ? ["developer"] : this.ctx.spec.planned.experts,
      repos: [repo],
      stackExperts: this.ctx.spec.stackExperts,
      stackNames: stackExpertNames(this.ctx.root, [repo]),
      citedPaths: story.planned.story.touches,
      knowledgeBytes: this.ctx.spec.knowledgeMaxBytes,
    });
    return buildDeveloperPrompt({
      runId: this.ctx.runId,
      story: story.planned,
      epic: story.epic,
      repoName: repo,
      branch: story.branch,
      epicBranch: story.epicBranch,
      worktree: story.worktree,
      commands: this.repoCommands(repo),
      ...testFastPart(this.testFastFor(repo)),
      conventions: renderConventions(this.ctx.root, [repo]),
      facts: renderFacts(facts.facts, [repo]),
      experts: bundles.experts,
      budgetUsd: this.developerCapFor(story),
      // The implicit plan writes its own note, naming the facts this story is
      // for; the constant is the fallback for a plan built before it did.
      planNote: this.plan.implicit ? (story.planned.note ?? IMPLICIT_STORY_NOTE) : undefined,
      previousAttempt: story.previousAttempt,
      previousAttemptKind: story.previousAttemptKind,
      // gh #322: why a person put this story back. It used to reach only a report
      // line and #308's no-diff check, never the turn that had to act on it.
      reopenNote: this.reopenFor(story.planned),
      notInWorktree: story.notInWorktree,
      ...(story.conflictTurn === undefined ? {} : { conflictTurn: story.conflictTurn }),
      dispatchNotes: this.dispatchNotesFor(story.planned.story.id).body,
      // This repo's skills only: the worktree carries one repo's `.claude/skills`.
      projectSkills: renderProjectSkills(skillsFor(readStackPacks(this.ctx.root), [repo])),
      ...(fixlist === null
        ? {}
        : { fixlist: renderFixlistSection(fixlist.rel, fixlist.findings) }),
    });
  }

  /**
   * The fix list this `--prepare` is a round of, or null.
   *
   * Two doors, one answer. `--fixlist <path>` names a file and is REFUSED loudly
   * when it is not one, is not this story's, or is not there — a flag that
   * silently prepared an ordinary bundle would be worse than no flag, because the
   * operator would believe the findings had been carried. With no flag, the
   * latest round on disk is carried by itself, and only while something in it is
   * still open: a fix list every finding of which has been dispositioned away
   * from `fix-now` is finished, and re-rendering it into the next attempt would
   * be asking for work somebody already decided not to do.
   */
  /**
   * `refuseCorrupted` (gh #218, correctness half) is true only from `prepare()`
   * — the one caller with a `try`/`catch` (routed to `refusedOnSequence`, exit
   * 1: no worktree, no spawn, nothing to undo) around this call. The OTHER
   * caller, `spawnDeveloper`'s headless auto fix-round, builds this string
   * mid-prompt with `agent.spawned` already emitted and no such catch — a throw
   * there would crash the invocation past every other story in the wave for a
   * file a human could have corrupted between runs. It keeps the pre-#218
   * reading (a corrupted round falls through to a plain bundle: wasteful, not
   * unsafe) rather than trade a wasted turn for a run-ending crash; the
   * DANGEROUS half — never settling `done` on an unreadable round — is closed
   * independently in `openFixNow`/`closedFixlistCandidates`, which both callers
   * of a fix list already go through before anything is proposed.
   */
  private fixlistFor(storyId: string, refuseCorrupted = false): FixlistOnDisk | null {
    const named = this.ctx.fixlist;
    if (named === undefined) {
      const latest = latestFixlist(this.ctx.runDir, BUILD_PHASE, storyId);
      const problem = latest === null ? null : this.describeUnreadableFixlist(latest);
      if (problem !== null && refuseCorrupted) throw new Error(problem);
      return openFixlist(this.ctx.runDir, BUILD_PHASE, storyId);
    }
    for (const base of [this.ctx.root, this.ctx.runDir, process.cwd()]) {
      const path = isAbsolute(named) ? named : join(base, named);
      const read = readFixlistAt(path, relative(this.ctx.runDir, path));
      if (read !== null) return this.checkFixlistStory(read, storyId, named);
      if (isAbsolute(named)) break;
    }
    throw new Error(
      `--fixlist ${named}: no readable fix list there. A fix list is `
      + `${fixlistRel(BUILD_PHASE, storyId, 1)} in the run tree, with numbered `
      + "`## N · <finding>` headings and a `Disposition:` line each",
    );
  }

  /** A fix list is one STORY's. Routing another's into this bundle is not a typo worth honouring. */
  private checkFixlistStory(read: FixlistOnDisk, storyId: string, named: string): FixlistOnDisk {
    const path = read.rel;
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base !== "" && !base.startsWith(`${storyId}-`)) {
      throw new Error(
        `--fixlist ${named} is not ${storyId}'s fix list (it is \`${base}\`) — `
        + `the story at the cursor is ${storyId}`,
      );
    }
    // gh #218 (correctness half): a corrupted file's `openFindings` is 0
    // whether or not it really has nothing open — asked BEFORE the 0-open
    // refusal below, so a truncated/malformed file is never misread as "this
    // has genuinely nothing to fix".
    const problem = this.describeUnreadableFixlist(read);
    if (problem !== null) throw new Error(`--fixlist ${named}: ${problem}`);
    // gh #218: naming a file explicitly is a stronger claim than the unnamed
    // door's courtesy carry-forward, so it gets a REFUSAL, not a silent
    // downgrade to a plain bundle — a fixlist with nothing open dispatched a
    // developer for a story nothing faults, and the flag would make an
    // operator believe findings were being carried when none were.
    const open = openFindings(read.findings).length;
    if (open === 0) {
      throw new Error(
        `--fixlist ${named} names ${read.rel}, which has 0 \`fix-now\` finding(s) — there is nothing here `
        + "to dispatch a developer over. `tldrx next` (headless) settles the story once its last review "
        + "and the fix list agree nothing is open; run it without `--fixlist` to let that happen",
      );
    }
    return read;
  }

  /**
   * A sentence naming what `fixlist`'s parse could not read, or `null` when it
   * parsed cleanly (gh #218, correctness half). Shared by both fixlist doors
   * — the unnamed carry-forward and `--fixlist <path>` — so a corrupted round
   * is refused the same way, and named, wherever it is found.
   */
  private describeUnreadableFixlist(fixlist: FixlistOnDisk): string | null {
    const first = fixlist.unreadable[0];
    if (first === undefined) return null;
    return `${fixlist.rel} has ${String(fixlist.unreadable.length)} heading(s) that could not be read as a `
      + `finding — #${String(first.n)} · ${first.finding} (${first.reason}). Its open count cannot be `
      + "trusted until every heading parses: fix the file's `Disposition:` line (or its heading, if the "
      + "file was truncated or overwritten), then try again";
  }

  /**
   * The `session_id` the PRIOR turn on this story reported, or null.
   *
   * Read off the developer bundle's own `result.json`, which `--commit` leaves
   * exactly where it found it. The framework resumes nothing itself — `spawnAgent`
   * has no `--resume` — so this is a fact handed BACK to the host, which is the
   * only party here that can act on it. Null is an honest answer and says so in
   * the prepared lines.
   */
  private resumeSessionFor(storyId: string): string | null {
    const path = join(agentDir(this.ctx.runDir, this.bundleKey(storyId)), RESULT_FILE);
    if (!existsSync(path)) return null;
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as { session_id?: unknown };
      return typeof doc.session_id === "string" && doc.session_id !== "" ? doc.session_id : null;
    } catch {
      return null;
    }
  }

  /**
   * The host's own context for this cycle, stage-level file first (spec §5).
   *
   * Both files feed ONE 8 KB slot, spent in that order: a note the operator left
   * for the whole Build stage ("Docker is up") is read before the one they left
   * for this story, and neither can quietly double the budget.
   */
  private dispatchNotesFor(storyId: string): DispatchNotes {
    return loadDispatchNotes(this.ctx.runDir, [this.ctx.stageId, this.bundleKey(storyId)]);
  }

  /**
   * Which activity line this sub-agent's events belong on.
   *
   * Only when several are actually in flight. With one lane there is nothing to
   * disambiguate, and prefixing every summary with `S1 ` would be noise plus a
   * changed screen for every run that never asked for parallelism.
   */
  private lane(story: StoryContext): string | undefined {
    return this.lanes > 1 ? story.planned.story.id : undefined;
  }

  private model(): string | null {
    return this.ctx.model ?? this.ctx.spec.planned.model;
  }

  /**
   * The model and effort the REVIEWER of this story runs on.
   *
   * `this.model()` above is the DEVELOPER's and the stage's, and it stays the
   * bottom layer here — so a stage file that declares neither `reviewer:` nor
   * `reviewer_by_stakes:` resolves to exactly what this accessor returned before
   * either key existed, which is what keeps the golden bytes still.
   *
   * The arithmetic is `facilitator/reviewerModel.ts` and is not repeated here:
   * the spawned door and the `--prepare --review` bundle both call this, and a
   * bundle whose recorded `model` disagreed with what a spawn would have used
   * would make the handshake's whole claim false.
   */
  private reviewerModel(planned: PlannedStory): ReviewerResolution {
    return resolveReviewer({
      cliModel: this.ctx.modelFlag,
      cliEffort: this.ctx.effortFlag,
      stakes: planned.story.stakes ?? null,
      byStakes: this.ctx.spec.reviewerByStakes,
      reviewer: this.ctx.spec.reviewer,
      stageModel: this.model(),
      stageEffort: this.ctx.effort,
    });
  }

  /**
   * What a HOST session declared about the reviewer it ran, or null.
   *
   * `--model`/`--effort` on `tldrx next` already existed and already mean "for
   * this invocation's sub-agent"; on `--commit --review` the turn has already
   * happened in the host's own session, so the same two flags are read as the
   * DECLARATION of what took it — the same reading `--cost-usd` and `--tokens`
   * already get on that command (#68).
   */
  private hostDeclaredReviewer(): ReviewerProvenance | null {
    const model = this.ctx.modelFlag;
    const effort = this.ctx.effortFlag;
    if (model === null && effort === null) return null;
    return { model, effort, basis: "host-declared" };
  }

  /**
   * Say it out loud, once, when a FILE moved the reviewer off the developer's
   * model — and only then.
   *
   * A calibration that spends more money without a line in the operator's output
   * is a bill nobody was shown. A `--model` flag raises no line: the operator
   * typed it and both roles got it.
   */
  private noteReviewerOverride(planned: PlannedStory, resolution: ReviewerResolution): void {
    const line = reviewerOverrideLine(planned.story.id, resolution, planned.story.stakes ?? null);
    if (line !== null) this.lines.push(line);
  }

  private repoCommands(repo: string): readonly string[] {
    return this.workspace.repoCommands.get(repo) ?? [];
  }

  /**
   * This repo's two test speeds, or null when it declares only one.
   *
   * Read off `commandRoles`, which keeps the SLOT keys: which of a repo's commands is
   * the fast one is the key the operator wrote in `workspace.yml`, never something to
   * read out of the command text (`hooks/lib/workspace.ts` records what that guess cost
   * on a real .NET workspace). `full` may be null — a repo may declare a fast test and
   * no suite — and the prompt says so rather than pointing at a command that is not there.
   */
  private testFastFor(repo: string): { readonly fast: string; readonly full: string | null } | null {
    const roles = this.workspace.commandRoles.get(repo);
    const fast = roles?.get(ITERATION_ONLY_SLOT);
    if (fast === undefined) return null;
    return { fast, full: roles?.get("test") ?? null };
  }

  /** The ledger's runDir and the operator-line sink, for `build/reviewRound.ts`. */
  private get roundParts(): RoundParts {
    return { runDir: this.ctx.runDir, lines: this.lines, fixlistRounds: this.fixlistRounds };
  }

  /** The plan's prices and this stage's money, for `build/caps.ts`. */
  private get capParts(): CapParts {
    return {
      prices: this.plan.prices,
      storyCount: this.plan.storyCount,
      budgetUsd: this.ctx.budgetUsd,
      maxBudgetUsd: this.ctx.maxBudgetUsd,
      agentCap: this.ctx.agentCap,
      attempts: this.attempts,
      reviewerShare: this.ctx.spec.tuning.reviewerShare,
      // gh #277 — read at DISPATCH off the stage as it sits on disk, so a run
      // already in flight under an older plan's prices is covered the moment
      // this is installed.
      storyCapMultiplier: this.ctx.spec.tuning.storyCapMultiplier,
      storyCapFloorUsd: this.ctx.spec.tuning.storyCapFloorUsd,
    };
  }

  /** The one command that moves a spawn ceiling (gh #244), for `build/caps.ts`'s sentences. */
  private get capLever(): CapLever {
    return {
      raiseCommand: (usd) => stageRaiseCommand(this.ctx.runId, this.ctx.phaseId, this.ctx.stageId, usd),
    };
  }

  /**
   * Developer attempts one story of THIS stage gets — `attempts:` in its
   * `stage.yml`, default 2 (`schemas/stageTuning.ts`). Read once, off the spec
   * the executor was handed, so every "attempt N of M" line, every requeue and
   * every ceiling in this file answers for the same number.
   */
  private get attempts(): number {
    return this.ctx.spec.tuning.attempts;
  }

  /** `fixlist_rounds:` for this stage — a `fixlist` verdict spends no attempt. */
  private get fixlistRounds(): number {
    return this.ctx.spec.tuning.fixlistRounds;
  }

  private spent(): number {
    return round2(this.tasks.reduce((sum, task) => sum + task.costUsd, 0));
  }

  private logPaths(): readonly string[] {
    return [...this.outcomes.values()].map((outcome) => outcome.reviewRel);
  }

  /**
   * The handshake's own `result.json` could not be read — one door for both ways
   * that happens (gh #82, gh #88).
   *
   * `absent` was already a sequencing refusal: the host has not written the file
   * yet, the fix is to write it and run the SAME command again, and nothing was
   * attempted (#82).
   *
   * `unreadable` — the file is there and does not parse — now takes the same
   * door, by owner decision on gh #88 (2026-09-02). The argument is that nothing
   * was attempted here either: no sub-agent ran, no cent moved, no branch
   * changed, and the fix is the same one command. Failing the stage actively
   * OBSTRUCTED that fix, because it demoted the stage out of `running` and the
   * phase-budget gate is skipped exactly when a stage is `running` — which is how
   * #82's live run took a `budget.blocked` it had not earned. A host that
   * fat-fingers its JSON must not pay that tax. It is #79's model — FORM never
   * costs an attempt, CONTENT/WORK always does — applied to run state, and
   * malformed JSON is as pure a FORM fault as exists.
   *
   * What stops that being a framework that shrugs at broken artefacts is the
   * other half of the decision: corruption never passes SILENTLY. An `unreadable`
   * envelope writes one `result.unreadable` event naming the file, the parse
   * error, the role and the story — the only thing a sequencing refusal writes,
   * and it goes in `events.jsonl`, never in `run.yml`, which still comes back
   * byte for byte.
   *
   * `parseReview`'s own fail-closed rule is untouched and is a different
   * contract: it governs an envelope that PARSES and is not a valid verdict
   * (unreadable ⇒ `changes`, never `approve`). A file that does not parse at all
   * never reaches it.
   */
  private refuseOnEnvelope(
    error: PendingError,
    key: string,
    role: "developer" | "reviewer",
    storyId: string,
  ): ExecutorOutcome {
    if (error.kind !== "unreadable") return refusedOnSequence(this.ctx, error.message);
    const path = relative(this.ctx.runDir, resultPath(this.ctx.runDir, key));
    this.ctx.emit("result.unreadable", {
      phase: this.ctx.phaseId,
      story: storyId,
      role,
      path,
      error: error.message,
    });
    return refusedOnSequence(
      this.ctx,
      `${error.message} — nothing was attempted and nothing moved: rewrite ${path} and run `
      + `\`tldrx next --commit${role === "reviewer" ? " --review" : ""}\` again`,
    );
  }

  /**
   * Say out loud that this review's diff base could not be recovered (#166).
   *
   * Both resume doors call it and neither owns the sentence: `unrecordedBaseLine`
   * is one implementation in `build/reviewRound.ts`, and a review whose base is
   * known adds no line at all — so nothing is said on the path where there is
   * nothing to warn about.
   */
  private noteUnrecordedBase(storyId: string, epicBranch: string, epicBase: string | undefined): void {
    const line = unrecordedBaseLine(storyId, epicBranch, epicBase);
    if (line !== null) this.lines.push(line);
  }

  private bundleKey(storyId: string): string {
    return bundleKeyOf(this.ctx.stageId, storyId);
  }

  private reviewBundleKey(storyId: string): string {
    return reviewBundleKeyOf(this.ctx.stageId, storyId);
  }

  private writeReviewBundle(story: StoryContext, work: ReviewWork, refusal: string | null = null): string {
    const reviewer = this.reviewerModel(story.planned);
    this.noteReviewerOverride(story.planned, reviewer);
    return writeReviewBundle({
      runDir: this.ctx.runDir,
      root: this.ctx.root,
      runId: this.ctx.runId,
      phaseId: this.ctx.phaseId,
      stageId: this.ctx.stageId,
      storyId: story.planned.story.id,
      repo: story.planned.story.repo,
      branch: story.branch,
      epicBranch: story.epicBranch,
      worktree: story.worktree,
      attempt: story.attempt,
      maxAttempts: this.attempts,
      // The REVIEWER's, not the stage's: this bundle is the brief a host session
      // works from, so `pending.json` has to carry the model the framework would
      // have judged this diff with — a host reading the stage's pin here would be
      // handed a suggestion the framework itself had already overridden.
      model: reviewer.model,
      effort: reviewer.effort,
      budgetUsd: this.ctx.budgetUsd,
      reviewerCapUsd: reviewerCap(this.capParts, this.spent(), story.planned.story.id),
      preparedAt: this.ctx.at,
      work,
      // The bundle's prompt and the bundle's recorded `diff` are derived from the
      // SAME base, which is what makes "byte-identical to what a spawn would have
      // sent" still true after #166.
      prompt: this.reviewerPrompt(
        story, work.dod, refusal, work.epicBase ?? null, openFixlist(this.ctx.runDir, BUILD_PHASE, story.planned.story.id),
      ),
      lines: this.lines,
    });
  }

  private clearReviewBundle(key: string): void {
    clearReviewBundle(this.ctx.runDir, key);
  }

  private reviewWorkFor(planned: PlannedStory): ReviewWork | null {
    return reviewWorkFor(this.lookupFor(planned));
  }

  private reviewWorkFromBundle(storyId: string): ReviewWork | null {
    return reviewWorkFromBundle(this.ctx.runDir, this.reviewBundleKey(storyId));
  }

  private reviewWorkFromLedger(planned: PlannedStory): ReviewWork | null {
    return reviewWorkFromLedger(this.ctx.runDir, planned.story.id, this.statusOf(planned));
  }

  private awaitingReview(): PlannedStory | null {
    return awaitingReview(this.ctx.runDir, this.ctx.stageId, this.pendingStories());
  }

  private reviewAttempts(storyId: string): number {
    return this.counters.verdicts(this.ctx.runDir, storyId);
  }

  private blockedByFailedDeveloper(planned: PlannedStory): string | null {
    return blockedByFailedDeveloper(this.ctx.runDir, planned, this.outcomes.get(planned.story.id));
  }

  private resumableReview(planned: PlannedStory): ResumableReview | null {
    return resumableReview(
      this.ctx.runDir, planned.story.id, this.statusOf(planned), this.outcomes.get(planned.story.id),
    );
  }

  /**
   * Everything `build/reviewBundle.ts` needs to say whether a review is
   * outstanding and what it is OF — the story's status on disk and this
   * process's own outcome for it, which the executor alone can answer.
   */
  private lookupFor(planned: PlannedStory): ReviewLookup {
    return {
      runDir: this.ctx.runDir,
      stageId: this.ctx.stageId,
      storyId: planned.story.id,
      status: this.statusOf(planned),
      fresh: this.outcomes.get(planned.story.id),
    };
  }

  /**
   * The last attempt, rendered for the next prompt's `## Previous attempt` — and
   * WHICH KIND of attempt it was, so the section's header is true (#211).
   *
   * `kind` is data, not a guess: a counted verdict makes it `review`, and a story
   * that never reached a reviewer and blocked on its DoD makes it `dod`. The
   * header the prompt prints is chosen from it in ONE renderer
   * (`previousAttemptHeader`).
   */
  private previousAttemptFor(storyId: string): { text: string; kind: PreviousAttemptKind } {
    return { text: this.previousAttemptText(storyId), kind: this.previousAttemptKind(storyId) };
  }

  /** `review` unless the last attempt blocked on its DoD with nothing judged. */
  private previousAttemptKind(storyId: string): PreviousAttemptKind {
    const outcome = this.outcomes.get(storyId);
    if (outcome !== undefined && outcome.verdict === "changes") return "review";
    // gh #313: an attempt THIS process requeued on a red DoD is a DoD attempt even
    // when an earlier one was reviewed — the log the text quotes is the DoD's.
    if (this.counters.dodRequeuesSpent(this.ctx.runDir, storyId) > 0 && outcome?.verdict === "n-a") return "dod";
    return this.reviewAttempts(storyId) === 0 ? "dod" : "review";
  }

  /** The last `changes` verdict, rendered for the next prompt's Previous attempt. */
  private previousAttemptText(storyId: string): string {
    const outcome = this.outcomes.get(storyId);
    if (outcome !== undefined && outcome.verdict === "changes") {
      return renderPreviousAttempt({
        verdict: "changes",
        summary: outcome.reviewSummary,
        findings: outcome.reviewFindings,
        fixlist: [],
        fixlistProblems: [],
        formatProblems: [],
        verdictProblem: null,
      });
    }
    const path = join(this.ctx.runDir, BUILD_PHASE, LOG_DIR, `${storyId}.md`);
    if (!this.hasPriorAttempt(storyId) || !existsSync(path)) return "";
    return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => `> ${line}`).join("\n");
  }

  /**
   * Is there an EARLIER attempt whose log this story's next developer should read?
   *
   * A counted verdict was the only answer until #211 — and a story that blocked on
   * its DoD never reaches a reviewer, so the one attempt whose failure is fully
   * recorded was the one attempt the next prompt said nothing about. The log now
   * cites the kept output of the red command (`04-build/log/dod-output/…`), which
   * is precisely what the next developer needs and cannot re-derive: the worktree
   * is gone.
   *
   * A GREEN dod row is not a prior attempt — the story would not be dispatched
   * again for it.
   */
  private hasPriorAttempt(storyId: string): boolean {
    if (this.reviewAttempts(storyId) > 0) return true;
    const ledger = readReviewLedger(this.ctx.runDir, storyId);
    // `lastDodOutputPath` outlives a reopen where `dod` does not, so a story a
    // person reopened still hands its next developer the failure that blocked it.
    if (ledger.lastDodOutputPath !== null) return true;
    return ledger.dod.some((row) => dodRefused(row) || row.exitCode !== 0 || row.timedOut);
  }

  private storyWorktree(planned: PlannedStory): string {
    return storyWorktreePath(this.ctx.root, planned.story.repo, this.ctx.runId, planned.story.id);
  }

  private async rescueUncommitted(
    story: StoryContext,
    status: PlanStatus,
    reason: string | null,
  ): Promise<RescuedWork | null> {
    return await rescueUncommitted({
      storyId: story.planned.story.id,
      repo: story.planned.story.repo,
      workspaceRoot: this.workspace.root,
      repoDir: story.repoDir,
      worktree: story.worktree,
      branch: story.branch,
      phaseId: this.ctx.phaseId,
      status,
      reason,
      lines: this.lines,
      emit: (type, payload) => { this.ctx.emit(type, payload); },
      write: (work) => this.writes.run(work),
    });
  }

}

/**
 * What a story's developer may do: the file tools, exactly the commands its OWN
 * repo declares in `workspace.yml`, and the git verbs that make a commit and
 * move a path around. Not `git push`, not `git merge`, not another repo's
 * commands, and never a bare `rm`.
 *
 * ## Why the file-lifecycle verbs are here (gh #261)
 *
 * A story that said "delete an unused file" could not be done AT ALL: nothing on
 * this list removes or renames a path — `Write`/`Edit` can empty a file, nothing
 * could unlink it or take it out of the index — and every `git rm`/`git mv` the
 * developer tried came back "This command requires approval", which in a
 * headless `-p` run is a prompt nobody will ever answer.
 *
 * The 2026-08-29 audit's line is UNCHANGED by this and is the reason the three
 * verbs are git verbs: no permission-free shell, only operations on the story's
 * own index. `git rm`, `git mv` and `git restore` act on the story's own
 * worktree, they are undone by exactly the `git checkout` that undoes an `Edit`,
 * and the branch never leaves the machine — `Bash(git push …)` is asserted
 * absent (`test/build-executor.test.ts`). `Bash(rm *)` would be none of those
 * things, and is refused by that same test.
 *
 * **gh #215, and the nuance is the whole of it.** Does an `allow` rule of the
 * `Bash(<cmd> *)` form reach a COMMAND SUBSTITUTION in its arguments? MEASURED
 * against `claude` **2.1.270**, with `git rm -n` as the instrument (see #215's
 * comment): under `Bash(git rm *)`, `git rm -n -- "$(echo MARKER.txt)"`,
 * `git rm -n "$(echo MARKER.txt)"` and `git rm -n -r "$(echo .)"` were ALL
 * denied — "Contains shell syntax that cannot be statically analyzed" — while a
 * bare `git rm MARKER.txt` ran.
 *
 * What that does and does not mean: the layer refuses the SYNTAX of a
 * substitution, **not the action**. In the same measurement the agent simply
 * rewrote the command with the value already expanded, and then it ran. For
 * `git rm <path>` that expanded form is exactly the scope this grant hands out,
 * so the direction is the safe one — but nobody may build a guarantee on top of
 * "substitutions are blocked", because what is blocked is a spelling.
 *
 * And it is HOST behaviour, not this repo's: it lives in the agent CLI's
 * permission layer and can change under us without a line of tldrx moving. The
 * argument that actually holds this grant up is the one above and is unchanged —
 * `git rm`/`git mv` are index operations on the story's own tree, undone by the
 * same `git checkout` that undoes an `Edit`, on a branch that never leaves the
 * machine.
 *
 * `Skill` joins the list only when `options.skills` says this repo HAS one — the caller
 * asks `skillsFor(...)` rather than this function guessing. `[unverified]` whether the
 * agent CLI's print mode denies an unlisted `Skill` call; listing it is what this
 * framework controls, and an allowance for a tool nothing needs is surface for nothing.
 */
export function developerTools(
  repoCommands: readonly string[],
  options: { readonly skills?: boolean } = {},
): readonly string[] {
  return [
    ...BASE_TOOLS,
    ...(options.skills === true ? ["Skill"] : []),
    // Both the exact form and the trailing-wildcard form, from the ONE place
    // that derives a Bash grant (`spawnAgent.bashGrantsFor`) — gh #209: a
    // developer granted only `Bash(npm run test)` had `npm run test -- <file>`
    // denied and never ran its own Definition of Done.
    ...repoCommands.flatMap((command) => bashGrantsFor(command)),
    // `add`, `commit`, and the file-lifecycle verbs (#261) — from the ONE
    // constant the developer prompt lists and the refusal classifier reads
    // (gh #278, `build/developerGrants.ts`), so the grant, the sentence that
    // tells the agent what it holds, and the cure a refusal names cannot drift.
    ...developerGitGrants(),
  ];
}

/**
 * Why a story stopped when the environment, not the work, decided it (#261).
 *
 * `permission — <command>` reads as a CAUSE and not as a verdict on the diff,
 * which is the distinction a person triaging a parked run needs first. The tail
 * is the absent-with-reason half (§7): it says what is missing (an approver),
 * why re-running cannot supply it, and therefore why no second attempt was
 * bought. One implementation, so the block reason, the story file, the handoff's
 * `## Unknowns` and `gate.requested`'s `blocked_reason` cannot drift.
 *
 * gh #278: the CURE follows, when the line shows one — `withCure` appends
 * "run each command alone …" for a chained line and "`git <verb>` is not
 * granted; use `git <equivalent>`" for an ungranted verb, and nothing at all
 * for a refusal the line does not explain, which keeps #261's sentence
 * byte-identical there. `retried` is the block AFTER the one re-spawn with the
 * cure in front of the prompt: "not repeated" would be false of it, so it says
 * what was done instead.
 */
export function permissionBlockReason(
  command: string,
  // `declared` (gh #285): the repo's `commands:`. Omitted, the sentence is
  // byte-identical to #278's — which is what every caller outside Build gets.
  options: { readonly retried?: boolean; readonly declared?: readonly string[] } = {},
): string {
  const base = `permission — \`${command}\` was refused for approval by the agent's own permission layer, `
    + "and a headless turn has nobody to approve it: the same allowance would refuse it again, "
    + "so this attempt was not repeated"
    + (options.retried === true ? " beyond the one re-spawn with the cure stated, which was refused too" : "");
  return withCure(base, command, options.declared);
}

/**
 * Did this spawn die on the ceiling the executor handed it? (gh #277)
 *
 * The sentence is the provider's own — `Reached maximum budget ($1.28)` — and it
 * reaches here through `describe()` in `spawnAgent.ts`, so the match is on the
 * framework's own transport of a provider string and never on a model's prose:
 * a model's words go through the envelope, not through `AgentOutcome.error`.
 * ONE implementation, because three surfaces now read it — the branch that lets
 * the DoD decide, the reason a person triages, and the ledger row.
 */
export function diedOnCap(error: string): boolean {
  return error.includes("Reached maximum budget");
}

/** The reviewer reads and nothing else. */
export const REVIEWER_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "Bash(git diff *)"];

/**
 * What half B did with the review: judged it, or handed it to the host.
 *
 * `handed-off` is not a failure and not an outcome — the story is merged and
 * parked at `review` with a bundle out, and the caller has to say that rather
 * than report a settled status it does not have.
 */
type ReviewRoute = "settled" | "handed-off";

/** A host envelope's own `summary`, as `parseReview`'s fallback text. */
function summaryOf(envelope: Record<string, unknown>): string {
  return typeof envelope.summary === "string" ? envelope.summary : "";
}

/** A finite number from an envelope field, or null. Never a coerced `0`. */
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlanStatus(value: string | undefined): value is PlanStatus {
  return value !== undefined && ["todo", "in_progress", "review", "done", "blocked"].includes(value);
}

/**
 * The handshake was called by the wrong end — and that is ALL that is wrong (gh #82).
 *
 * Nothing was attempted, nothing was spent, nothing is out that was not out
 * before, and the fix is the other half of the same handshake, named on the line
 * this returns. So the run must come out of the invocation exactly as it went in:
 * see `ExecutorOutcome.sequencing` for what `runNext` does with it, and why that
 * is not the same as the `refused` a dirty repo earns.
 *
 * `error: null` because there is no failure to report. `refused: true` beside it
 * so a caller that has not learned about `sequencing` still lands on the
 * not-a-failure path rather than on `failStage` — the fail-safe reading of a flag
 * it does not know is the conservative one, not the destructive one.
 *
 * No `tasks` parameter, deliberately. A refusal that has a task to record is one
 * that spent money, which is not this: giving the helper somewhere to put tasks
 * would make it possible to write a sequencing refusal that quietly drops them.
 */
function refusedOnSequence(ctx: ExecutorContext, why: string): ExecutorOutcome {
  return {
    ok: false,
    refused: true,
    sequencing: true,
    awaiting: false,
    tasks: [],
    costUsd: 0,
    outputs: [],
    lines: [`${ctx.phaseId}/${ctx.stageId}: ${why}`],
    error: null,
  };
}

function failed(ctx: ExecutorContext, error: string, tasks: readonly ExecutorTask[]): ExecutorOutcome {
  return {
    ok: false,
    awaiting: false,
    tasks,
    costUsd: round2(tasks.reduce((sum, task) => sum + task.costUsd, 0)),
    outputs: [],
    lines: [`${ctx.phaseId}/${ctx.stageId} failed: ${error}`],
    error,
  };
}

// --- re-exports: the public surface does not move -------------------------
//
// `src/core/run/reopenStory.ts:54` and nine test files import these FROM HERE.
// Wave 2 moves where they are defined and nothing else; a re-export is how
// "the same symbol, a different file" stays true for every caller.
export { readReviewLedger, phaseCostToDate };
export {
  capDeathReason, clampParallel, developerAttemptDivisor, storyCeilingUsd,
  DEFAULT_PARALLEL, MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE,
  STORY_CAP_MULTIPLIER, STORY_CAP_FLOOR_USD,
};
