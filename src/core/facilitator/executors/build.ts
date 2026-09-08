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
import { spawnAgent, BASE_TOOLS } from "../spawnAgent.ts";
import { DEVELOPER_RESULT_SCHEMA } from "../envelope.ts";
import {
  PendingError, PENDING_FILE, RAW_FILE, RESULT_FILE, readResult, readResultObject, resultPath,
  writeBundle, writeRaw,
  dispatchNotesRecord, type PendingStage,
} from "../pending.ts";
import {
  addWorktree, commitsBetween, ensureBranch, fullShaOf, GitError, removeWorktree, repoDirOf,
  reviewDiffCommand, shaReachability,
} from "../../build/git.ts";
import { BaseGateFailure, baseRefusalLines } from "../../build/preflight.ts";
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
import { buildDeveloperPrompt, REVIEW_SCHEMA } from "../../build/prompts.ts";
import { ITERATION_ONLY_SLOT } from "../../schemas/commandAllowlist.ts";

/** `testFast` as an optional prompt field: present only when the repo declares one. */
function testFastPart(
  found: { readonly fast: string; readonly full: string | null } | null,
): { readonly testFast?: { readonly fast: string; readonly full: string | null } } {
  return found === null ? {} : { testFast: found };
}
import {
  MAX_FORMAT_RETRIES, parseReview, renderPreviousAttempt, renderReviewLog, reviewerFailed,
  type Review,
} from "../../build/review.ts";
import {
  DEVELOPER_FAILED, dodFailureReason, dodGreen, dodRefused,
  type DodResult, type RescuedWork, type StoryOutcome,
} from "../../build/outcome.ts";
import {
  CLAIMED_UNVERIFIED, canonicalizeResolutions, fixlistRel, fixlistRetroLines, latestFixlist, markUnverified,
  MAX_FIXLIST_ROUNDS, openFindings, readFixlistAt, renderFixlistSection, writeFixlist,
  type FixFinding, type FixlistOnDisk,
} from "../../build/fixlist.ts";
import { renderBuildHandoff, type EpicSummaryRow } from "../../build/handoff.ts";
import { carriedReportFor, type CarriedReport } from "../../build/carriedRows.ts";
import {
  baseResultOf, PreflightCache, redBaseRefusal, runStoryDod, type BaseParts,
} from "../../build/dodRunner.ts";
import {
  commitIfDirty, EpicState, mergeIntoEpic, refreshStoryBase, rescueUncommitted, storyWorktreePath,
  unreadableTouches, type EpicWorktreeParts,
} from "../../build/worktrees.ts";
import {
  dirtyRepoRefusal, epicRows, foreignEpicRefusal, resolveBranchModel, type ClaimParts,
} from "../../build/branchClaims.ts";
import {
  awaitingReview, bundleKeyOf, clearReviewBundle, resumableReview,
  reviewBundleKeyOf, reviewWorkFor, reviewWorkFromBundle, reviewWorkFromLedger,
  stashRefusedEnvelope, writeReviewBundle,
  type ResumableReview, type ReviewLookup, type ReviewWork,
} from "../../build/reviewBundle.ts";
import {
  blockedByFailedDeveloper, formatRetryDecision, narrowFixlist, pendingRefusal, reviewerPromptFor,
  unrecordedBaseLine,
  RecurringFocus, ReviewCounters, type RoundParts,
} from "../../build/reviewRound.ts";
import { readReviewLedger } from "../../build/reviewLedger.ts";
import type { ReviewerProvenance } from "../../build/reviewerProvenance.ts";
import {
  resolveReviewer, reviewerOverrideLine, type ReviewerResolution,
} from "../reviewerModel.ts";
import { phaseCostToDate, storySpendToDate } from "../../build/phaseCost.ts";
import { appendBuildRetro, buildRetroPath, gateRetroLines, storyRetroLines } from "../../build/retroLog.ts";
import {
  clampParallel, developerCap, developerPriceDivisor, reviewerCap, round2,
  DEFAULT_PARALLEL, MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE,
  type CapParts,
} from "../../build/caps.ts";
import type { PlanStatus } from "../../schemas/planCommon.ts";
import type { ExecutorContext, ExecutorOutcome, ExecutorTask } from "./index.ts";

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
  try {
    // `--review` names the second delegable role. It rides the SAME two doors —
    // there is one handshake, and a reviewer that needed its own would be a
    // second contract for the host to get wrong (design §B.3).
    if (ctx.mode === "prepare") {
      return withClaims(ctx.review ? await session.prepareReviewOnly() : await session.prepare());
    }
    if (ctx.mode === "commit") {
      return withClaims(ctx.review ? await session.commitReview() : await session.commit());
    }
    return withClaims(await session.runAll());
  } catch (error) {
    // Issue #41: the DoD step found a red command that is red on the base tree
    // too. That is a workspace-configuration fault, so it REFUSES (stage back to
    // `ready`, story untouched, attempt unspent) rather than blocking a story for
    // something no story caused. Whatever the developer already cost is still in
    // `session.tasks` and is still recorded.
    if (error instanceof BaseGateFailure) return withClaims(refusedOnBase(session, error));
    if (error instanceof GitError || error instanceof PlanLoadError) {
      return withClaims(failed(ctx, error.message, session.tasks));
    }
    throw error;
  }
}

/** A story's DoD failure re-attributed to the base tree — see `BaseGateFailure`. */
function refusedOnBase(session: BuildSession, error: BaseGateFailure): ExecutorOutcome {
  const who = error.storyId === null ? "a story" : `\`${error.storyId}\``;
  return {
    ok: false,
    refused: true,
    awaiting: false,
    tasks: session.tasks,
    costUsd: session.tasks.reduce((sum, task) => sum + task.costUsd, 0),
    outputs: [],
    lines: [
      `[tldrx] build: ${who} was not blocked — its Definition of Done failed for a reason the base tree shares.`,
      ...baseRefusalLines([error.result]),
    ],
    error: error.message,
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

interface StoryContext {
  readonly planned: PlannedStory;
  readonly epic: PlannedEpic;
  readonly repoDir: string;
  readonly worktree: string;
  readonly branch: string;
  readonly epicBranch: string;
  readonly attempt: number;
  readonly previousAttempt: string;
  /**
   * Touched paths the story's worktree has no copy of because they are not
   * committed at its branch — `01-what/` outputs and `run.yml` in a
   * `root_is_repo` workspace, which the run writes and nobody commits on Build's
   * cadence. The prompt says so; `existsSync` alone called them new files.
   */
  readonly notInWorktree: ReadonlySet<string>;
}

class BuildSession {
  /** Every sub-agent this stage ran; `runNext` turns them into `run.yml` tasks. */
  readonly tasks: ExecutorTask[] = [];
  private readonly outcomes = new Map<string, StoryOutcome>();
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
   * What this run measured on the untouched base tree (`build/preflight.ts`).
   *
   * Loaded lazily and once: a run resumed after a refusal must not re-pay for a
   * `dotnet test`, and a run that entered Build before this file existed must
   * not error on its absence.
   */
  private readonly preflight: PreflightCache;
  /** How many stories of one wave may be in flight at once. */
  private readonly lanes: number;

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
  }

  // --- the three entry points ----------------------------------------------

  /** Headless: every wave, every story, in order, then the handoff. */
  async runAll(): Promise<ExecutorOutcome> {
    const refusal = await this.refuseOnDirtyRepos()
      ?? await this.refuseOnForeignEpic()
      ?? await this.refuseOnRedBase();
    if (refusal !== null) return refusal;
    this.recordGateFeedback();

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
        if (status === "done" || status === "blocked") {
          this.lines.push(`  · ${planned.story.id} is already \`${status}\` — left alone`);
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
      // Only the parallel path stops here. Wave N+1 fanning out over code wave N
      // failed to produce is how one red story becomes N of them; the sequential
      // path has always carried on and is left exactly as it was.
      if (this.waveFailed(wave)) {
        this.lines.push(
          `  · ${wave.id} ended \`failed\` — the next wave was not started ` +
          "(its stories may depend on what this one did not land)",
        );
        break;
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
    const planned = this.nextPending();
    if (planned === null) return await this.finish();
    const refusal = await this.refuseOnDirtyRepos()
      ?? await this.refuseOnForeignEpic()
      ?? await this.refuseOnRedBase();
    if (refusal !== null) return refusal;

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

    // The fix-list ROUTER (design §B.4). `--fixlist <path>` names one explicitly;
    // absent, the latest round on disk is carried by itself — the same courtesy
    // `--prepare` already extends to a story waiting on a review, and for the
    // same reason: handing an author a bundle that omits the findings it is
    // being re-dispatched over is the mistake, not the convenience.
    let fixlist: FixlistOnDisk | null;
    try {
      fixlist = this.fixlistFor(planned.story.id);
    } catch (error) {
      return failed(this.ctx, error instanceof Error ? error.message : String(error), []);
    }

    this.noteIfReopened(planned, this.statusOf(planned));
    // `true`: a developer is about to be dispatched onto this branch, so it is
    // one of the two openings that may bring the base up to the epic tip (§F.2).
    const story = await this.openStory(planned, true);
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
          `($${cap.toFixed(2)} ceiling, attempt ${String(story.attempt)} of ${String(MAX_ATTEMPTS)})`,
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
    const refusal = await this.refuseOnDirtyRepos() ?? await this.refuseOnForeignEpic();
    if (refusal !== null) return refusal;

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
          + `(read-only, attempt ${String(story.attempt)} of ${String(MAX_ATTEMPTS)})`,
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
        `${this.nextPending()?.story.id ?? "?"} is next — run \`tldrx next --prepare\``,
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
        `${this.nextPending()?.story.id ?? "?"} is next — run \`tldrx next --prepare\``,
      ],
      error: null,
    };
  }

  // --- the pipeline ---------------------------------------------------------

  /** One story, with its at-most-one requeue after a `changes` verdict. */
  private async driveStory(planned: PlannedStory): Promise<void> {
    // A story whose LAST review ERRORED is not owed a developer: its diff is
    // committed and merged, and its DoD went green. What is missing is the
    // review. Re-running the developer would throw away work nobody faulted and
    // charge for it twice.
    const resume = this.resumableReview(planned);
    if (resume !== null) {
      await this.rereview(planned, resume);
      return;
    }
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await this.settleHalf(await this.buildHalf(planned));
      const outcome = this.outcomes.get(planned.story.id);
      // The developer never ran, so the story is back where it started and its
      // attempt is unspent. Spawning it again inside the same process, under the
      // same ceiling, would buy the same error twice — the operator raises a cap
      // (or the plan's price) between invocations, and that is the fix.
      if (outcome !== undefined && outcome.developerError !== null) return;
      if (outcome?.status !== "review") return;
      // Only a real `changes` verdict buys another developer attempt. An errored
      // review leaves the story parked for the NEXT invocation's review-only
      // path — retrying the same reviewer under the same ceiling in the same
      // process would just buy the same error twice.
      if (outcome.verdict === "error") return;
      // A fix list is a SIGNATURE with findings attached, not a fault: nothing
      // about the diff was rejected, so a second developer attempt is not owed —
      // and the routing it IS owed needs a host (`--prepare --fixlist`), which a
      // headless invocation does not have. The story parks with its artifact.
      if (outcome.verdict === "fixlist") return;
      this.lines.push(`  · ${planned.story.id}: reviewer asked for changes — requeued once`);
    }
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
      if (resume === null) queue.push(planned);
      else await this.rereview(planned, resume);
    }
    await this.driveWaveHalves(wave, queue);
  }

  /** The fan-out proper: half A concurrently, half B in the wave's listed order. */
  private async driveWaveHalves(wave: BuildWave, pending: readonly PlannedStory[]): Promise<void> {
    let queue = [...pending];
    for (let round = 0; round < MAX_ATTEMPTS && queue.length > 0; round++) {
      const halves = await this.fanOut(queue);
      // The merge order is the file's, not the finish order. Two runs of the same
      // wave must produce the same epic branch, whatever the machine was doing.
      for (const planned of wave.stories) {
        const half = halves.get(planned.story.id);
        if (half === undefined) continue;
        await this.settleHalf(half);
      }
      // `review` + `changes` is the only requeue. `review` + `error` means the
      // reviewer never judged the diff, and a second developer attempt is the one
      // thing that must NOT follow it.
      const requeued = wave.stories.filter((p) =>
        halves.has(p.story.id) && this.outcomes.get(p.story.id)?.status === "review"
        && this.outcomes.get(p.story.id)?.verdict === "changes");
      for (const planned of requeued) {
        this.lines.push(`  · ${planned.story.id}: reviewer asked for changes — requeued once`);
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
    const lane = async (): Promise<void> => {
      for (;;) {
        const planned = queue[cursor++];
        if (planned === undefined) return;
        halves.set(planned.story.id, await this.buildHalf(planned));
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

  /** Half A for one story: worktree → developer → DoD → commit. */
  private async buildHalf(planned: PlannedStory): Promise<StoryHalf> {
    // Read BEFORE `setStoryStatus` below overwrites it. A developer that dies
    // without delivering must leave the story exactly where it found it, and
    // "where it found it" stops being readable one line from here.
    const before = this.statusOf(planned);
    // (a)(b)(c) touch the SHARED repo — `git branch`, `git worktree add` — so they
    // go through the one writer even though the sub-agent below does not.
    // `true`: same reason as `prepare()` — the headless developer is dispatched
    // onto this branch a few lines below (§F.2).
    const story = await this.writes.run(() => this.openStory(planned, true));
    await this.writes.run(() => {
      this.ctx.emit("task.started", {
        phase: this.ctx.phaseId,
        story: planned.story.id,
        wave: planned.wave,
        repo: planned.story.repo,
        branch: story.branch,
        attempt: story.attempt,
      });
      this.setStoryStatus(planned, "in_progress");
    });

    // A developer that FAILED is a TRANSPORT outcome, not a story that could not
    // be built: the sub-agent never wrote a line, so nothing about the work has
    // been learned and nothing about it may be settled. `failure` stays null —
    // that field blocks the story — and `developerError` parks it instead.
    const developer = await this.spawnDeveloper(story);
    if (developer.error !== null) {
      return {
        story, cost: developer.cost, dod: [], commit: null,
        failure: null, developerError: developer.error, before,
      };
    }
    const spent = developer.cost;

    // (e) the Definition of Done, re-run in the story's own worktree.
    //
    // An EMPTY dod is the one case the two kinds of plan answer differently: a
    // planned story that declares no command is a Plan bug and blocks, and an
    // implicit one is the framework saying this scope has nothing to run
    // (`dodIsSatisfiedEmpty`). Everything else — one red command — blocks either way.
    const dod = await this.runDod(story);
    const green = dod.length === 0 ? dodIsSatisfiedEmpty(this.plan) : dodGreen({ dod });
    if (!green) {
      const failing = dod.find((r) => dodRefused(r) || r.exitCode !== 0 || r.timedOut);
      return {
        story,
        cost: spent,
        dod,
        commit: null,
        failure: failing === undefined
          ? "the story declares no dod commands, so nothing could prove it"
          : dodFailureReason(failing, story.planned.story.repo),
        developerError: null,
        before,
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
    return { story, cost: spent, dod, commit, failure: null, developerError: null, before };
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
    // A developer that FAILED comes first, because it is the one case where half
    // A produced no information at all. The story goes back to where it was, its
    // attempt unspent — see `parkDeveloperFailure`.
    if (half.developerError !== null) {
      await this.parkDeveloperFailure(story, half.developerError, half.cost, half.before);
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

    // (f) merge into the epic. A conflict blocks the story; the wave carries on.
    //
    // How much the merge is about to MOVE is measured first, because afterwards
    // it cannot be: once the story branch is an ancestor of the epic, `git diff
    // <epic>...<story>` is empty whether it carried thirty commits or none.
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
      await this.block(story, `merge into \`${story.epicBranch}\` failed: ${merge.detail}`, half.cost, dod, {
        commit,
        conflicts: merge.conflicts,
      });
      return "settled";
    }
    this.noteMerged(story, carried);

    // (g)(h) the reviewer, and whatever it decides.
    return await this.reviewAndSettle(story, dod, commit, half.cost, carried, epicShaBefore);
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
      await this.settle(story, "review", {
        dod, commit, merged: true, carried, epicBase, verdict: "fixlist", review, cost,
        reason: `the reviewer SIGNED with a fix list — ${String(review.fixlist.length)} finding(s), `
          + `${String(open)} to fix now (${rel})`,
      });
      return "settled";
    }

    const requeue = review.verdict === "changes" && story.attempt < MAX_ATTEMPTS;
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
    const round = this.counters.fixlistRoundGranted(id) ?? MAX_FIXLIST_ROUNDS;
    const rel = writeFixlist(this.ctx.runDir, BUILD_PHASE, {
      storyId: id,
      title: story.planned.story.title,
      round,
      attempt: story.attempt,
      maxAttempts: MAX_ATTEMPTS,
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
  private async openFixNow(story: StoryContext): Promise<string | null> {
    const storyId = story.planned.story.id;
    const fixlist = latestFixlist(this.ctx.runDir, BUILD_PHASE, storyId);
    if (fixlist === null) return null;
    const { findings, refused } = await this.verifyResolutions(story, fixlist);
    const open = openFindings(findings);
    const first = open[0];
    if (first === undefined) return null;
    return `${String(open.length)} fix-list finding(s) are still \`fix-now\` in ${fixlist.rel} — `
      + `#${String(first.n)} · ${first.finding}. `
      + (refused.length === 0
        ? ""
        : `${String(refused.length)} \`Resolved: yes\` claim(s) did not check out and were `
          + `recorded as \`${CLAIMED_UNVERIFIED}\`: ${refused.join("; ")}. `)
      + "Close each one there with `Resolved: yes <sha>` — the commit the fix landed as on "
      + `\`${story.branch}\` — or re-route its \`Disposition:\`, `
      + `then \`tldrx story reopen ${storyId}\``;
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
    story: StoryContext,
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
      const why = finding.resolved ? await this.unverifiedBecause(story, finding.resolvedSha) : null;
      if (why === null) {
        findings.push(finding);
        continue;
      }
      findings.push({ ...finding, resolved: false, resolvedSha: null });
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
  private async unverifiedBecause(story: StoryContext, sha: string | null): Promise<string | null> {
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
    this.lines.push(
      `  · ${planned.story.id}: the previous reviewer FAILED (${resume.error}) — `
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
      + `the verdicts before that do not count against it, so it runs as attempt 1 of ${String(MAX_ATTEMPTS)}`,
    );
  }

  /** True when any story of this wave settled at `blocked`. */
  private waveFailed(wave: BuildWave): boolean {
    return wave.stories.some((planned) => this.statusOf(planned) === "blocked");
  }

  /** DoD → commit → merge → review → done/blocked, for the `--commit` cycle. */
  private async pipelineFromDod(story: StoryContext, developerCost: number): Promise<ReviewRoute> {
    const dod = await this.runDod(story);
    const green = dod.length === 0 ? dodIsSatisfiedEmpty(this.plan) : dodGreen({ dod });
    if (!green) {
      const failing = dod.find((r) => dodRefused(r) || r.exitCode !== 0 || r.timedOut);
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
    this.epics.claimed.add(epicBranch);
    // The run id is IN the branch name — see `storyBranchOf`, which is the ONE
    // place that name is derived. Without the run id, four runs of the same plan
    // all cut `story/S1`: the second found it already there, `addWorktree`
    // checked it out as it stood, and one run's commits landed on another's
    // branch (2026-08-29 audit, §B). `story/<run>/<story>` cannot collide.
    const branch = storyBranchOf(this.ctx.runId, planned.story.id);
    const worktree = this.storyWorktree(planned);
    if (!existsSync(worktree)) {
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
      attempt: Math.min(this.reviewAttempts(planned.story.id) + 1, MAX_ATTEMPTS),
      previousAttempt: this.previousAttemptText(planned.story.id),
      notInWorktree: await this.unreadableTouches(planned, repoDir, branch),
    };
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
  private async spawnDeveloper(story: StoryContext): Promise<{ cost: number; error: string | null }> {
    const cap = developerCap(this.capParts, story.planned.story.id, story.attempt);
    const commands = this.repoCommands(story.planned.story.repo);
    this.ctx.emit("agent.spawned", {
      phase: this.ctx.phaseId,
      story: story.planned.story.id,
      role: "developer",
      model: this.model(),
      effort: this.ctx.effort,
      max_budget_usd: cap,
    }, 0, "developer");

    const agent = await spawnAgent({
      prompt: this.developerPrompt(story),
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
    if (agent.raw !== "") writeRaw(this.ctx.runDir, this.bundleKey(story.planned.story.id), agent.raw);

    this.tasks.push({
      key: story.planned.story.id,
      model: this.model(),
      costUsd: round2(agent.costUsd),
      sessionId: agent.sessionId,
      error: agent.error,
      outputs: agent.envelope?.outputs ?? [],
      metered: agent.metered,
      inputTokens: agent.usage.input_tokens,
      outputTokens: agent.usage.output_tokens,
    });
    if (agent.ok) return { cost: round2(agent.costUsd), error: null };

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
    return { cost: round2(agent.costUsd), error };
  }

  /** (e) the story's ```dod block, in the worktree, via the gate's own runner. */
  private async runDod(story: StoryContext): Promise<readonly DodResult[]> {
    return await runStoryDod({
      storyId: story.planned.story.id,
      repo: story.planned.story.repo,
      worktree: story.worktree,
      commands: story.planned.dod.commands,
      workspaceCommands: this.workspace.commands,
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      phaseId: this.ctx.phaseId,
      emit: (type, payload) => { this.ctx.emit(type, payload); },
      baseResult: (repo, command) => baseResultOf(this.baseParts, repo, command),
    });
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

  /** (g) the reviewer, read-only, judging the story diff. */
  private async spawnReviewer(
    story: StoryContext,
    dod: readonly DodResult[],
    epicBase: string | null,
  ): Promise<{ review: Review; cost: number }> {
    const id = story.planned.story.id;
    let refusal: string | null = null;
    let spent = 0;
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
        prompt: this.reviewerPrompt(story, dod, refusal, epicBase),
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
        inputTokens: agent.usage.input_tokens, outputTokens: agent.usage.output_tokens,
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
        inputTokens: agent.usage.input_tokens,
        outputTokens: agent.usage.output_tokens,
        source: "agent",
        // MEASURED: these are the arguments this loop handed the provider CLI a
        // few lines up, not a re-derivation of them.
        reviewer: { model: reviewer.model, effort: reviewer.effort, basis: "spawned" },
      });
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
      /** The provider's own split for this turn, when it reported one. */
      inputTokens?: number;
      outputTokens?: number;
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
      outputs: [],
      ...(task.metered ? {} : { metered: false }),
      ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
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
  ): string {
    return reviewerPromptFor({
      diffBase,
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
      /** The provider's own split for this turn, when it reported one. */
      inputTokens?: number;
      outputTokens?: number;
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
      outputs: [],
      ...(task.metered ? {} : { metered: false }),
      ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
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
    const outcome: StoryOutcome = {
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
    if (!this.plan.implicit) this.updateEpicStatus(story.epic);

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
        (parts.reason === null ? "" : ` (${parts.reason})`),
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
    // The epic worktrees are deliberately NOT removed here (issue #16, owner
    // decision 2026-09-01). They belong to the RUN, not to this stage: a later
    // Watch stage cites code that is committed on the epic branch and merged
    // nowhere, and `resolveSrc` can only resolve that against a checkout that is
    // still on disk. `cleanUpRunEpicWorktrees` takes them at run close instead.
    const outcomes = this.orderedOutcomes();
    const done = outcomes.filter((o) => o.status === "done").length;
    this.writeHandoff(outcomes);
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
        `${this.ctx.phaseId}/${this.ctx.stageId}: ${String(done)} of ${String(outcomes.length)} story(ies) done ` +
          `across ${String(this.plan.waves.length)} wave(s)`,
        ...this.lines,
        `wrote ${HANDOFF_REL}`,
      ],
      stderr: [...this.advisories],
      error: null,
    };
  }

  private writeHandoff(outcomes: readonly StoryOutcome[]): void {
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
      decidedNote: describeDecidedTally(
        decidedTally(FactsStore.loadOrEmpty(factsPath(this.ctx.root)).facts, this.ctx.runId),
      ),
      budgetUsd: this.ctx.budgetUsd,
      at: this.ctx.at,
      outcomes,
      epics: this.epicRows(outcomes),
      storiesRel: this.plan.implicit ? IMPLICIT_PLAN_REL : null,
      carried: carried.rows,
      unreadableStories: carried.unreadable,
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
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      write: (work) => this.writes.run(work),
      advisories: this.advisories,
    };
  }

  private async refuseOnRedBase(): Promise<ExecutorOutcome | null> {
    const refusal = await redBaseRefusal(this.baseParts, this.pendingStories());
    return refusal === null ? null : {
      ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
      lines: refusal.lines, error: refusal.error,
    };
  }

  private async refuseOnDirtyRepos(): Promise<ExecutorOutcome | null> {
    const { refusal, ignored } = await dirtyRepoRefusal(this.claimParts, this.pendingStories());
    if (refusal !== null) {
      return {
        ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
        lines: refusal.lines, error: refusal.error,
      };
    }
    if (ignored > 0) {
      this.lines.push(`  · ignoring ${String(ignored)} tldrx state file(s) in the dirty-tree check`);
    }
    return null;
  }

  private pendingStories(): readonly PlannedStory[] {
    const rows: PlannedStory[] = [];
    for (const wave of this.plan.waves) {
      for (const planned of wave.stories) {
        const status = this.statusOf(planned);
        if (status === "done") continue;
        // `blocked` is terminal in-run — unless what blocked it was a developer
        // that never ran, in which case the story was never really attempted and
        // is owed the turn it did not get.
        if (status === "blocked" && this.blockedByFailedDeveloper(planned) === null) continue;
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
  private updateEpicStatus(epic: PlannedEpic): void {
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
      budgetUsd: developerCap(this.capParts, story.planned.story.id, story.attempt),
      // The implicit plan writes its own note, naming the facts this story is
      // for; the constant is the fallback for a plan built before it did.
      planNote: this.plan.implicit ? (story.planned.note ?? IMPLICIT_STORY_NOTE) : undefined,
      previousAttempt: story.previousAttempt,
      notInWorktree: story.notInWorktree,
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
  private fixlistFor(storyId: string): FixlistOnDisk | null {
    const named = this.ctx.fixlist;
    if (named === undefined) {
      const latest = latestFixlist(this.ctx.runDir, BUILD_PHASE, storyId);
      return latest !== null && openFindings(latest.findings).length > 0 ? latest : null;
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
    return read;
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
    return { runDir: this.ctx.runDir, lines: this.lines };
  }

  /** The plan's prices and this stage's money, for `build/caps.ts`. */
  private get capParts(): CapParts {
    return {
      prices: this.plan.prices,
      storyCount: this.plan.storyCount,
      budgetUsd: this.ctx.budgetUsd,
      maxBudgetUsd: this.ctx.maxBudgetUsd,
      agentCap: this.ctx.agentCap,
    };
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
      prompt: this.reviewerPrompt(story, work.dod, refusal, work.epicBase ?? null),
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
    if (this.reviewAttempts(storyId) === 0 || !existsSync(path)) return "";
    return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => `> ${line}`).join("\n");
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
 * repo declares in `workspace.yml`, and the two git verbs that make a commit.
 * Not `git push`, not `git merge`, not another repo's commands.
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
    ...repoCommands.map((command) => `Bash(${command})`),
    "Bash(git add *)",
    "Bash(git commit *)",
  ];
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
  clampParallel, developerPriceDivisor,
  DEFAULT_PARALLEL, MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE,
};
