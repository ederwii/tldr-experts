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
 * **Parallel within a wave (`--parallel N`, default 1).** `waves.yml` guarantees a
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
import { PROJECT_FRAMEWORK_DIR, epicWorktreeName } from "../../paths.ts";
import {
  FALLBACK_DEFAULT_BRANCH, factsPath, loadWorkspace, type WorkspaceContext,
} from "../../../hooks/lib/workspace.ts";
import { DodCommandRefused, runDodCommand } from "../../../hooks/lib/story.ts";
import { FactsStore } from "../../facts/FactsStore.ts";
import { RunStore } from "../../run/RunStore.ts";
import { renderConventions, renderFacts, stackExpertNames } from "../prompt.ts";
import { loadExpertBundles } from "../../experts/expertBundle.ts";
import { agentDir } from "../paths.ts";
import {
  describeDispatchNotes, loadDispatchNotes, type DispatchNotes,
} from "../dispatchNotes.ts";
import { preparedBundles, reviewBundles, REVIEW_DIR } from "../../run/prepared.ts";
import { spawnAgent, BASE_TOOLS } from "../spawnAgent.ts";
import {
  PendingError, PENDING_FILE, RAW_FILE, RESULT_FILE, readResult, readResultObject, writeBundle, writeRaw,
  dispatchNotesRecord, type PendingReview, type PendingStage,
} from "../pending.ts";
import {
  addWorktree, assertWorktreeOn, baseStateOf, branchExists, commitAll, commitsBetween, currentBranch, diffCommand,
  dirtyPaths, ensureBranch, fastForward, firstLine, GitError, headSha, isDirty, mergeNoFf, partitionDirty, pathAtRef,
  removeWorktree, repoDirOf, shaOf, stateDirPrefixes,
} from "../../build/git.ts";
import {
  BaseGateFailure, baseRefusalLines, baseResultFor, EMPTY_PREFLIGHT, loadPreflight, PREFLIGHT_REL,
  savePreflight, withResult, type BaseCommandResult, type BasePreflight,
} from "../../build/preflight.ts";
import {
  loadBuildPlan, PlanLoadError, BUILD_PHASE, LOG_DIR, PLAN_PHASE, WORKTREES,
  type BuildPlan, type BuildWave, type PlannedEpic, type PlannedStory,
} from "../../build/plan.ts";
import {
  describeImplicitPlan, discardImplicitPlan, dodIsSatisfiedEmpty, implicitPlanContent, implicitPlanIsStale,
  implicitPlanPath, ImplicitPlanError, loadImplicitPlan, planIsSkipped, updateImplicitPlan,
  IMPLICIT_PLAN_REL, IMPLICIT_STORY_ID, IMPLICIT_STORY_NOTE,
} from "../../build/implicitPlan.ts";
import { evidenceFor, updateStoryFront } from "../../build/storyFile.ts";
import { buildDeveloperPrompt, buildReviewerPrompt, REVIEW_SCHEMA } from "../../build/prompts.ts";
import {
  looksLikeReviewerError, parseReview, renderPreviousAttempt, renderReviewLog, reviewerFailed, type Review,
} from "../../build/review.ts";
import { DEVELOPER_FAILED, dodGreen, type DodResult, type StoryOutcome } from "../../build/outcome.ts";
import {
  fixlistRel, fixlistRetroLines, latestFixlist, MAX_FIXLIST_ROUNDS, openFindings, readFixlistAt,
  renderFixlistSection, writeFixlist, type FixlistOnDisk,
} from "../../build/fixlist.ts";
import { renderBuildHandoff, type EpicSummaryRow } from "../../build/handoff.ts";
import { appendBuildRetro, buildRetroPath, gateRetroLines, storyRetroLines } from "../../build/retroLog.ts";
import { MAX_STORIES_PER_WAVE, type PlanStatus } from "../../schemas/planCommon.ts";
import type { ExecutorContext, ExecutorOutcome, ExecutorTask } from "./index.ts";

export const HANDOFF_REL = `${BUILD_PHASE}/handoff.md`;
/** Run-relative, and the path `mineRuns` looks for — see `build/retroLog.ts`. */
export const RETRO_REL = "retro.md";

/**
 * A story gets one developer attempt, plus one more if the reviewer asks for
 * changes. A second `changes` blocks it — a third try is an operator's decision,
 * not the framework's.
 */
export const MAX_ATTEMPTS = 2;

/**
 * `[assumption]` — the brief splits the stage budget "by story count", which is the
 * DEVELOPER's share; the reviewer needs its own and the spec never sizes one. A
 * quarter of a story's share reads a diff comfortably and cannot quietly double
 * the phase's cost.
 */
export const REVIEWER_SHARE = 0.25;

/**
 * The least a reviewer may be given, whatever the arithmetic says.
 *
 * Measured 2026-08-30, run `260830-tenancy-identity-customers`: the uniform split
 * handed the reviewer of a 39-file, +1879-line story $0.26, and it died mid-read
 * with `Reached maximum budget ($0.26)`. A reviewer that cannot finish reading
 * the diff approves nothing, blocks nothing and judges nothing — it converts the
 * developer's spend into a story stuck at `review`. A floor is the cheapest thing
 * that makes a review mean something, and it is deliberately traded against the
 * strict "every worst-case cap sums inside the stage ceiling" arithmetic below:
 * the worst case only materialises when reviewers keep asking for changes, and
 * `budget.yml`'s own gate is what actually stops a stage that runs out.
 */
export const REVIEWER_FLOOR_USD = 1.00;

/**
 * The default degree of parallelism inside a wave: one story at a time.
 *
 * Spec §5 decision (c) shipped v1 sequential, and this stays the default so a
 * workspace that says nothing keeps the behaviour it has been running.
 */
export const DEFAULT_PARALLEL = 1;

/**
 * Whatever this run may do at once inside a wave, clamped to something sane.
 *
 * The ceiling is `MAX_STORIES_PER_WAVE`, since a number above it can never be
 * reached; the floor is 1, because "0 lanes" is not a slower build, it is a
 * build that never starts.
 */
export function clampParallel(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PARALLEL;
  return Math.max(1, Math.min(MAX_STORIES_PER_WAVE, Math.trunc(requested)));
}

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

/**
 * A story that needs its REVIEW re-run and nothing else: the developer half is
 * done, its DoD was green, and the commit is already merged into the epic.
 */
interface ResumableReview {
  /** The merged story commit, from the ledger's `task.done`. */
  readonly commit: string;
  /** The DoD results of the attempt that produced it, from the ledger. */
  readonly dod: readonly DodResult[];
  /** What the reviewer died with — quoted to the operator, never as a verdict. */
  readonly error: string;
}

/**
 * A story whose REVIEW is the only thing outstanding, and everything a reviewer
 * needs to do it — recovered from the run's own ledger, never re-measured.
 *
 * The superset of `ResumableReview`: that one is the narrow "the last reviewer
 * died" case, this one also covers "the review was handed to the host and has
 * not come back", which is what a reviewer bundle on disk means.
 */
interface ReviewWork {
  /** The merged story commit the verdict is about. */
  readonly commit: string;
  /** The DoD results of the attempt that produced it. */
  readonly dod: readonly DodResult[];
  /** Why the review is outstanding, in the words the operator reads. */
  readonly why: string;
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
    session.claimedEpics.size === 0 ? outcome : { ...outcome, epicBranches: [...session.claimedEpics] };
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
    return loadBuildPlan(join(ctx.runDir, PLAN_PHASE), workspace.commands);
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
  const storyBranch = `story/${ctx.runId}/${IMPLICIT_STORY_ID}`;
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
  private readonly epicWorktrees = new Map<string, string>();
  /**
   * Per epic branch, the stories merged into it and what each merge CARRIED —
   * `0` for a branch that was already identical to the epic, `null` when an
   * earlier invocation did the merging.
   */
  private readonly merged = new Map<string, { id: string; carried: number | null }[]>();
  private readonly lines: string[] = [];
  /** Per-story reviewer verdicts seen in THIS process, for the requeue counter. */
  private readonly reviews = new Map<string, number>();

  /**
   * Fix-list rounds this process has granted, per story — the bound's own
   * counter, deliberately NOT the requeue one.
   *
   * A `fixlist` verdict spends no attempt, so it must not touch `reviews`; and it
   * is bounded at `MAX_FIXLIST_ROUNDS`, so it must be counted somewhere. Read
   * through `fixlistRoundsSpent`, which falls back to the ledger for a fresh
   * process — a bound a restart forgets is not a bound.
   */
  private readonly fixlists = new Map<string, number>();
  /** Epic branches this run cut or adopted; `runNext` writes them to run.yml. */
  readonly claimedEpics = new Set<string>();
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
  private preflight: BasePreflight | null = null;
  private preflightLoaded = false;
  /** How many stories of one wave may be in flight at once. */
  private readonly lanes: number;

  constructor(
    private readonly ctx: ExecutorContext,
    private readonly workspace: WorkspaceContext,
    private readonly plan: BuildPlan,
    opening: readonly string[] = [],
  ) {
    this.lines.push(...opening);
    this.lanes = clampParallel(ctx.parallel);
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
    const cap = this.developerCap(planned.story.id);
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
          + "(`Resolved: yes`) or re-route its `Disposition:` — an open `fix-now` blocks `done`",
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
      return failed(
        this.ctx,
        `${planned.story.id} has no merged commit to review — a story is reviewed after its developer turn, `
        + "not instead of one. Run `tldrx next --prepare` for the developer half first.",
        [],
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
    const key = this.writeReviewBundle(story, work);
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
      return failed(
        this.ctx,
        "no reviewer bundle is out — run `tldrx next --prepare --review` first",
        [],
      );
    }
    const key = this.reviewBundleKey(planned.story.id);
    let envelope: Record<string, unknown>;
    try {
      envelope = readResultObject(this.ctx.runDir, key);
    } catch (error) {
      if (error instanceof PendingError) return failed(this.ctx, error.message, []);
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
    this.recordReview(story, review, {
      costUsd: numberOf(envelope.cost_usd) ?? 0,
      sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
      // Billed to the HOST session, not metered here. `cost_usd: null` +
      // `metered: false` is the same spelling every other host turn gets.
      metered: numberOf(envelope.cost_usd) !== undefined,
      tokens: numberOf(envelope.tokens),
      source: "host",
    });
    await this.reviewAndSettle(story, work.dod, work.commit, 0, null, review);
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
      return failed(this.ctx, "no story is `in_progress` — run `tldrx next --prepare` first", []);
    }
    const key = this.bundleKey(planned.story.id);
    let result;
    try {
      result = readResult(this.ctx.runDir, key);
    } catch (error) {
      if (error instanceof PendingError) return failed(this.ctx, error.message, []);
      throw error;
    }

    const story = await this.openStory(planned);
    this.tasks.push({
      key: planned.story.id,
      model: this.model(),
      costUsd: round2(result.cost_usd ?? 0),
      sessionId: result.session_id,
      error: null,
      outputs: result.outputs,
    });
    const route = await this.pipelineFromDod(story, round2(result.cost_usd ?? 0));
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
      const failing = dod.find((r) => r.exitCode !== 0 || r.timedOut);
      return {
        story,
        cost: spent,
        dod,
        commit: null,
        failure: failing === undefined
          ? "the story declares no dod commands, so nothing could prove it"
          : `\`${failing.command}\` exited ${String(failing.exitCode)} in repo ${story.planned.story.repo}` +
            `${failing.timedOut ? " (timed out)" : ""} — ${failing.tail}`,
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
    return await this.reviewAndSettle(story, dod, commit, half.cost, carried);
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
    supplied?: Review,
  ): Promise<ReviewRoute> {
    // The HOST's review, already parsed and already recorded by `commitReview`.
    // It reaches the same three branches below by the same rules — that is the
    // whole point of injecting it here rather than settling it somewhere else.
    if (supplied === undefined && this.ctx.attendedByHost) {
      await this.handOffReview(story, dod, commit, priorCost, carried);
      return "handed-off";
    }
    const outcome = supplied === undefined
      ? await this.spawnReviewer(story, dod)
      : { review: supplied, cost: 0 };
    const review = outcome.review;
    const cost = round2(priorCost + outcome.cost);

    // A reviewer that FAILED said nothing about the diff. The story parks at
    // `review` — pending, worktree kept, requeue counter untouched — and the next
    // `tldrx next` re-runs the REVIEW, not the developer.
    if (review.verdict === "error") {
      await this.settle(story, "review", {
        dod, commit, merged: true, carried, verdict: "error", review, cost,
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
      const rel = this.writeFixlistFor(story, review, commit);
      const open = openFindings(review.fixlist).length;
      await this.settle(story, "review", {
        dod, commit, merged: true, carried, verdict: "fixlist", review, cost,
        reason: `the reviewer SIGNED with a fix list — ${String(review.fixlist.length)} finding(s), `
          + `${String(open)} to fix now (${rel})`,
      });
      return "settled";
    }

    const requeue = review.verdict === "changes" && story.attempt < MAX_ATTEMPTS;
    if (review.verdict === "changes") {
      await this.settle(story, requeue ? "review" : "blocked", {
        dod, commit, merged: true, carried, verdict: "changes", review, cost,
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
    const open = this.openFixNow(story.planned.story.id);
    if (open !== null) {
      // Not `block()`: that one is for a story nothing judged, and it would
      // record `verdict: n-a` and `not merged` over a diff a reviewer APPROVED
      // and a merge that happened. The story is blocked on the fix list and on
      // nothing else, and the log has to say exactly that.
      await this.settle(story, "blocked", {
        dod, commit, merged: true, carried, verdict: "approve", review, cost, reason: open,
      });
      return "settled";
    }

    // (h) done — DoD green AND the reviewer approved. Write the evidence.
    await this.settle(story, "done", {
      dod, commit, merged: true, carried, verdict: "approve", review, cost, reason: null,
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
   */
  private writeFixlistFor(story: StoryContext, review: Review, commit: string): string {
    const id = story.planned.story.id;
    // Allocated by `narrowFixlist`, which is the only thing that may grant one.
    const round = this.fixlists.get(id) ?? MAX_FIXLIST_ROUNDS;
    const rel = writeFixlist(this.ctx.runDir, BUILD_PHASE, {
      storyId: id,
      title: story.planned.story.title,
      round,
      attempt: story.attempt,
      maxAttempts: MAX_ATTEMPTS,
      diff: diffCommand(story.epicBranch, story.branch),
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
   */
  private openFixNow(storyId: string): string | null {
    const fixlist = latestFixlist(this.ctx.runDir, BUILD_PHASE, storyId);
    if (fixlist === null) return null;
    const open = openFindings(fixlist.findings);
    const first = open[0];
    if (first === undefined) return null;
    return `${String(open.length)} fix-list finding(s) are still \`fix-now\` in ${fixlist.rel} — `
      + `#${String(first.n)} · ${first.finding}. `
      + "Close each one there (`Resolved: yes`) or re-route its `Disposition:`, "
      + `then \`tldrx story reopen ${storyId}\``;
  }

  /**
   * How many fix-list rounds this story has already been granted.
   *
   * This process first, then the ledger — the same two-source shape
   * `reviewAttempts` uses, and for the same reason: a bound that a fresh `tldrx
   * next` forgets is not a bound, and a story settled inside THIS invocation has
   * not written its event to a file this can re-read yet.
   */
  private fixlistRoundsSpent(storyId: string): number {
    return this.fixlists.get(storyId) ?? readReviewLedger(this.ctx.runDir, storyId).fixlistRounds;
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
  private narrowFixlist(storyId: string, review: Review): Review {
    // Printed HERE because both doors — a spawned reviewer and a host's
    // `--commit --review` — reach the record through this one call (gh #36).
    if (review.verdictProblem !== null) {
      this.lines.push(`  · ${storyId}: ${review.verdictProblem}`);
    }
    for (const problem of review.fixlistProblems) {
      this.lines.push(`  · ${storyId}: the reviewer's fix list was REFUSED — ${problem}`);
    }
    if (review.fixlistProblems.length > 0) {
      this.lines.push(
        `  · ${storyId}: an unreadable fix list does not buy a free round — read as \`changes\``,
      );
    }
    if (review.verdict !== "fixlist") return review;
    const spent = this.fixlistRoundsSpent(storyId);
    if (spent < MAX_FIXLIST_ROUNDS) {
      // The round is ALLOCATED here, where it is granted — not counted off the
      // ledger later. `recordReview` writes the `verdict: fixlist` event between
      // this and the artifact, so a later re-count would read this very round as
      // one already spent and number the file `-2`.
      this.fixlists.set(storyId, spent + 1);
      return review;
    }
    const previous = latestFixlist(this.ctx.runDir, BUILD_PHASE, storyId);
    this.lines.push(
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
  ): Promise<void> {
    const key = this.writeReviewBundle(story, {
      commit, dod, why: "the run is `attended_by: host`, so the framework does not spawn a reviewer",
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
      review: { verdict: "n-a", summary: "", findings: [], fixlist: [], fixlistProblems: [], verdictProblem: null },
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
    await this.reviewAndSettle(story, resume.dod, resume.commit, 0, null);
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
      const failing = dod.find((r) => r.exitCode !== 0 || r.timedOut);
      await this.block(
        story,
        failing === undefined
          ? "the story declares no dod commands, so nothing could prove it"
          : `\`${failing.command}\` exited ${String(failing.exitCode)} in repo ${story.planned.story.repo}` +
            `${failing.timedOut ? " (timed out)" : ""} — ${failing.tail}`,
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
    const epicBranch = epic.epic.branch;
    if (await ensureBranch(repoDir, epicBranch, base)) {
      this.lines.push(`  · cut \`${epicBranch}\` from \`${base}\` in ${planned.story.repo}`);
    }
    // Whatever happened above, this run is now working on that branch: say so in
    // run.yml (`build.epic_branch`) so its NEXT invocation, and any other run,
    // can tell "I cut this" from "this was already here".
    this.claimedEpics.add(epicBranch);
    // The run id is IN the branch name. Without it, four runs of the same plan
    // all cut `story/S1` — the second found it already there, `addWorktree`
    // checked it out as it stood, and one run's commits landed on another's
    // branch (2026-08-29 audit, §B). `story/<run>/<story>` cannot collide.
    const branch = `story/${this.ctx.runId}/${planned.story.id}`;
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

  /**
   * A story's branch, brought up to its epic's tip before a developer is
   * dispatched onto it — or the precise reason it was left exactly where it is.
   *
   * The live case, notes §11 on `260830-tenancy-identity-customers`: `story
   * reopen` keeps the branch by design, and S3's branch still sat at the S1-era
   * epic tip while the epic had since gained S2 and S5. S3's handlers needed S2's
   * contract, so a dispatch on that base would not have compiled. The host
   * fast-forwarded by hand before dispatching; this is that move, automated, and
   * only in the case where it is a move and not a decision.
   *
   * Three shapes, and only the first changes anything:
   *
   *   - **behind, and the worktree is clean** — the branch is an ancestor of the
   *     epic tip, so `git merge --ff-only` is the entire operation: no commit
   *     written, no history rewritten, and it refuses rather than inventing a
   *     merge. Measured atomic-or-nothing (see `fastForward`).
   *   - **diverged** — commits on both sides. Warn with both counts and both
   *     shas, change NOTHING, and let the dispatch proceed on the old base. This
   *     is the second live case: a dead spawn had left a partial commit on a
   *     stale base, no fast-forward was possible, and the host preserved the
   *     partial on a backup branch and re-pointed the story branch BY HAND. That
   *     is a decision — which of the two histories survives — and the framework
   *     does not get to make it. **Never a rebase**: rewriting a branch a
   *     developer already committed to is the class of move the
   *     run-id-in-branch-name fix exists to prevent (2026-08-29 audit §B).
   *   - **the worktree is dirty** — left alone whatever the topology says. A
   *     dirty tree is the operator's, not ours.
   *
   * An `up to date` branch is silent and emits nothing: this path is byte-for-byte
   * what it was before design §F.2 whenever there was nothing to say.
   */
  private async refreshStoryBase(
    planned: PlannedStory,
    repoDir: string,
    worktree: string,
    branch: string,
    epicBranch: string,
  ): Promise<void> {
    const id = planned.story.id;
    const base = await baseStateOf(repoDir, branch, epicBranch);
    if (base.state === "current") return;

    const where = relative(this.ctx.root, worktree) || worktree;
    if (base.state === "diverged") {
      this.lines.push(
        `  · ${id}: \`${branch}\` (${base.branchSha}) has DIVERGED from \`${epicBranch}\` `
        + `(${base.baseSha}) — ${String(base.ahead)} commit(s) the epic lacks, `
        + `${String(base.behind)} the story lacks`,
        `  · ${id}: nothing was changed — tldrx never rebases a branch a developer has committed to. `
        + `In ${where}: \`git merge ${epicBranch}\`, or preserve the divergent commit(s) on a backup `
        + `branch and re-point \`${branch}\` at \`${epicBranch}\` by hand`,
        `  · ${id}: the dispatch below is on the OLD base (${base.branchSha}), `
        + `${String(base.behind)} commit(s) behind \`${epicBranch}\``,
      );
      return;
    }

    // A story worktree is its own checkout of the SAME repo, so in a
    // `root_is_repo` workspace it holds `tldrx-work/` and `.tldrx/` too. Neither
    // counts as the operator's dirt — the same split `commitIfDirty` makes, from
    // the same prefixes.
    const state = stateDirPrefixes(this.workspace.root, repoDir);
    const dirty = partitionDirty(await dirtyPaths(worktree), state).product;
    if (dirty.length > 0) {
      this.lines.push(
        `  · ${id}: \`${branch}\` (${base.branchSha}) is ${String(base.behind)} commit(s) behind `
        + `\`${epicBranch}\` (${base.baseSha}), but its worktree has ${String(dirty.length)} `
        + "uncommitted change(s) — left alone; a dirty tree is the operator's",
        `  · ${id}: ${dirty.slice(0, 5).join(", ")}`
        + `${dirty.length > 5 ? `, +${String(dirty.length - 5)} more` : ""} in ${where}`,
      );
      return;
    }

    const moved = await fastForward(worktree, epicBranch);
    if (!moved.ok) {
      // `--ff-only` is atomic-or-nothing, so there is nothing to repair: the
      // branch is still at `from` and the dispatch proceeds on it. What would be
      // wrong is a silent one.
      this.lines.push(
        `  · ${id}: \`git merge --ff-only ${epicBranch}\` failed in ${where} — `
        + `${firstLine(moved.stderr) || firstLine(moved.stdout) || `exit ${String(moved.exitCode)}`}`,
        `  · ${id}: \`${branch}\` was left at ${base.branchSha}, `
        + `${String(base.behind)} commit(s) behind \`${epicBranch}\``,
      );
      return;
    }
    this.lines.push(
      `  · ${id}: fast-forwarded \`${branch}\` to \`${epicBranch}\` — `
      + `${String(base.behind)} commit(s), ${base.branchSha} → ${base.baseSha}`,
    );
    this.ctx.emit("story.base_fastforwarded", {
      phase: this.ctx.phaseId,
      story: id,
      repo: planned.story.repo,
      branch,
      base: epicBranch,
      from: base.branchSha,
      to: base.baseSha,
      commits: base.behind,
    });
  }

  /**
   * Touched paths that exist in the repo but are NOT in the tree at the story's
   * branch, so the worktree cannot open them.
   *
   * A path that exists nowhere is left out: that one really is a file the story
   * creates, and the prompt already says so. The difference is the whole point —
   * "this story creates it" and "you were shown a quote of it and nothing more"
   * are opposite instructions, and `existsSync(worktree/path)` cannot tell them
   * apart.
   */
  private async unreadableTouches(
    planned: PlannedStory,
    repoDir: string,
    branch: string,
  ): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    for (const path of planned.story.touches) {
      // A path that is nowhere in the repo is the ordinary "this story creates
      // it", and cheap to rule out before a git call.
      if (!existsSync(join(repoDir, path))) continue;
      if (await pathAtRef(repoDir, branch, path)) continue;
      out.add(path);
      this.advisories.push(
        `warning: input ${path} is not committed, so the story worktree cannot read it`,
      );
    }
    return out;
  }

  /**
   * (d) one developer sub-agent, cwd = the worktree.
   *
   * Returns what it spent and — when it FAILED — what it died with, verbatim.
   * The two are separate on purpose: an errored spawn still costs money, and the
   * money is the operator's clue about why it errored.
   */
  private async spawnDeveloper(story: StoryContext): Promise<{ cost: number; error: string | null }> {
    const cap = this.developerCap(story.planned.story.id);
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
      tools: developerTools(commands),
      yolo: this.ctx.yolo,
      cwd: story.worktree,
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      lane: this.lane(story),
    });
    if (agent.raw !== "") writeRaw(this.ctx.runDir, this.bundleKey(story.planned.story.id), agent.raw);

    this.tasks.push({
      key: story.planned.story.id,
      model: this.model(),
      costUsd: round2(agent.costUsd),
      sessionId: agent.sessionId,
      error: agent.error,
      outputs: agent.envelope?.outputs ?? [],
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
    const timeoutMs = this.ctx.spec.planned.timeout_s * 1000;
    const results: DodResult[] = [];
    for (const command of story.planned.dod.commands) {
      // Same allowlist the hook uses, same refusal. The Build executor runs a dod
      // block in a worktree for real; an undeclared command is a failed check
      // here, not a spawn.
      let outcome;
      try {
        outcome = await runDodCommand(command, story.worktree, timeoutMs, this.workspace.commands);
      } catch (error) {
        if (!(error instanceof DodCommandRefused)) throw error;
        outcome = { command, exitCode: 126, timedOut: false, tail: error.message };
      }
      const result: DodResult = {
        command,
        exitCode: outcome.timedOut ? 124 : outcome.exitCode,
        timedOut: outcome.timedOut,
        tail: outcome.tail,
      };
      results.push(result);
      const green = result.exitCode === 0 && !result.timedOut;
      this.ctx.emit(green ? "check.passed" : "check.failed", {
        phase: this.ctx.phaseId,
        check: "dod",
        story: story.planned.story.id,
        command,
        exit_code: result.exitCode,
        detail: green ? "" : result.tail,
      });
      if (green) continue;
      // Issue #41, the second reader: a red command only faults the STORY if it
      // is green on the untouched base tree. The answer is normally already in
      // the run's cache — the Build-entry pre-flight put it there — and when it
      // is not (a run that entered Build on an older binary, a base that moved
      // under a reopened story) it is measured now rather than assumed. A base
      // that shares the failure halts the build instead of blocking the story.
      const base = await this.baseResult(story.planned.story.repo, command);
      if (base !== null && base.status === "failed") {
        throw new BaseGateFailure(base, story.planned.story.id);
      }
      break;
    }
    return results;
  }

  private async commitIfDirty(story: StoryContext): Promise<string | null> {
    // A story worktree is its own checkout, but of the SAME repo — so when the
    // workspace root is the repo it holds `tldrx-work/` and `.tldrx/` too. Neither
    // the "is there anything to commit" question nor the commit itself may include
    // them: a run that swept its own state into a story commit would put the run
    // log inside the diff a reviewer reads.
    const state = stateDirPrefixes(this.workspace.root, story.repoDir);
    if (await isDirty(story.worktree, state)) {
      const message = `feat(${story.planned.story.id}): ${story.planned.story.title}`;
      const committed = await commitAll(story.worktree, message, state);
      if (!committed.ok) {
        this.lines.push(
          `  · ${story.planned.story.id}: \`git commit\` failed — ` +
            `${firstLine(committed.stderr) || firstLine(committed.stdout)}`,
        );
        return null;
      }
    }
    const sha = await headSha(story.worktree);
    return sha === "" ? null : sha;
  }

  /** (f) `git merge --no-ff story/<id>` inside the epic's own worktree. */
  private async mergeIntoEpic(
    story: StoryContext,
  ): Promise<{ ok: boolean; conflicts: readonly string[]; detail: string }> {
    return await mergeNoFf(
      await this.openEpicWorktree(story),
      story.branch,
      `merge(${story.planned.story.id}): ${story.planned.story.title}`,
    );
  }

  /** (g) the reviewer, read-only, judging the story diff. */
  private async spawnReviewer(
    story: StoryContext,
    dod: readonly DodResult[],
  ): Promise<{ review: Review; cost: number }> {
    const cap = this.reviewerCap(story.planned.story.id);
    this.ctx.emit("agent.spawned", {
      phase: this.ctx.phaseId,
      story: story.planned.story.id,
      role: "reviewer",
      model: this.model(),
      effort: this.ctx.effort,
      max_budget_usd: cap,
    }, 0, "reviewer");

    const agent = await spawnAgent({
      prompt: this.reviewerPrompt(story, dod),
      model: this.model(),
      effort: this.ctx.effort,
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
    const review = this.narrowFixlist(story.planned.story.id, parsed);

    this.recordReview(story, review, {
      costUsd: round2(agent.costUsd),
      sessionId: agent.sessionId,
      error: agent.error,
      metered: true,
      source: "agent",
    });
    return { review, cost: round2(agent.costUsd) };
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
  private reviewerPrompt(story: StoryContext, dod: readonly DodResult[]): string {
    return buildReviewerPrompt({
      runId: this.ctx.runId,
      story: story.planned,
      repoName: story.planned.story.repo,
      branch: story.branch,
      epicBranch: story.epicBranch,
      worktree: story.worktree,
      conventions: renderConventions(this.ctx.root, [story.planned.story.repo]),
      dodResults: dod.map((r) => ({ command: r.command, exitCode: r.exitCode })),
      // Withdrawn once the story's one round is spent, so the prompt never offers
      // a verdict `narrowFixlist` is about to refuse. Computed the same way on
      // both doors, which is what keeps the bundle's prompt byte-identical to the
      // one a spawn would have sent.
      fixlistAvailable: this.fixlistRoundsSpent(story.planned.story.id) < MAX_FIXLIST_ROUNDS,
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
      source: "agent" | "host";
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
    });
    const id = story.planned.story.id;
    // The requeue counter counts VERDICTS THAT COST AN ATTEMPT — two of the five
    // do not. An errored review consumed a turn's money but produced no
    // judgement. A `fixlist` produced a judgement and it was a SIGNATURE: the
    // diff was not faulted, so no second developer attempt is owed for it, and
    // the round it does buy is bounded by `narrowFixlist` instead.
    if (review.verdict !== "error" && review.verdict !== "fixlist") {
      this.reviews.set(id, (this.reviews.get(id) ?? 0) + 1);
    }
    // The reviewer IS a check: `approve` is the pass, `changes` and `error` the
    // two failures. `verdict` is what tells a ledger which one it is reading, and
    // `detail` on an errored review is the ERROR, verbatim.
    //
    // `source: "host"` is written ONLY for a host review — a reader can tell one
    // from a spawn's without joining it back to an `agent.spawned` that, for a
    // host, is deliberately absent. The spawned payload keeps its exact shape:
    // absence of the key means what it has always meant, and the ordinary path's
    // event sequence is unchanged byte for byte.
    this.ctx.emit(review.verdict === "approve" ? "check.passed" : "check.failed", {
      phase: this.ctx.phaseId,
      check: "review",
      story: id,
      verdict: review.verdict,
      attempt: story.attempt,
      ...(task.source === "host" ? { source: "host" } : {}),
      detail: review.summary,
    });
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
      review: { verdict: "n-a", summary: "", findings: [], fixlist: [], fixlistProblems: [], verdictProblem: null },
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
      developerError: parts.developerError ?? null,
      reviewSummary: parts.review.summary,
      reviewFindings: parts.review.findings,
      reviewRel,
      reason: parts.reason,
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
    });
    // Worktrees survive a `review` on purpose: the second attempt continues in
    // the same tree rather than re-cutting the branch it just wrote. A parked
    // developer failure keeps its tree for the same reason.
    if (status !== "review" && parts.keepWorktree !== true) await this.cleanUp(story);
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
    await this.cleanUpEpics();
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
    writeFileSync(path, renderBuildHandoff({
      runId: this.ctx.runId,
      stageId: this.ctx.stageId,
      model: this.model(),
      costUsd: this.spent(),
      budgetUsd: this.ctx.budgetUsd,
      at: this.ctx.at,
      outcomes,
      epics: this.epicRows(),
      storiesRel: this.plan.implicit ? IMPLICIT_PLAN_REL : null,
    }), "utf8");
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

  /** A story settled by an earlier `next`; its log is already on disk. */
  private fromDisk(planned: PlannedStory, status: PlanStatus): StoryOutcome {
    const epic = this.plan.epics.get(planned.story.epic);
    const outcome: StoryOutcome = {
      id: planned.story.id,
      title: planned.story.title,
      wave: planned.wave,
      repo: planned.story.repo,
      epic: planned.story.epic,
      epicBranch: epic?.epic.branch ?? "",
      branch: `story/${planned.story.id}`,
      status,
      attempts: Math.max(this.reviewAttempts(planned.story.id), 1),
      dod: [],
      commit: null,
      merged: status === "done",
      carried: null,
      conflicts: [],
      verdict: status === "done" ? "approve" : "n-a",
      developerError: null,
      reviewSummary: "settled by an earlier `tldrx next`",
      reviewFindings: [],
      reviewRel: `${BUILD_PHASE}/${LOG_DIR}/${planned.story.id}.md`,
      reason: status === "done" ? null : "settled by an earlier `tldrx next`",
      cost_usd: 0,
    };
    if (!existsSync(join(this.ctx.runDir, outcome.reviewRel))) this.writeLog(outcome);
    return outcome;
  }

  private epicRows(): readonly EpicSummaryRow[] {
    const rows: EpicSummaryRow[] = [];
    for (const [id, epic] of this.plan.epics) {
      const merges = this.merged.get(epic.epic.branch) ?? [];
      rows.push({
        id,
        branch: epic.epic.branch,
        repos: epic.epic.repos,
        // A merge that moved nothing is not listed with the ones that did. The
        // Gate section is what a human reads before merging an epic by hand, and
        // "S3, S4, S5, S7 merged" over four identical branches is the sentence
        // this split exists to stop writing (2026-08-30).
        merged: merges.filter((row) => row.carried !== 0).map((row) => row.id),
        emptyMerges: merges.filter((row) => row.carried === 0).map((row) => row.id),
        defaultBranches: epic.epic.repos.map((repo) => this.workspace.defaultBranches.get(repo) ?? "main"),
        rel: epic.rel,
      });
    }
    return rows;
  }

  // --- helpers --------------------------------------------------------------

  /**
   * An `epic/<slug>` that already exists and was NOT cut by this run.
   *
   * Story branches and worktrees now carry the run id, so they cannot collide.
   * The epic branch deliberately does not — an epic is the unit a team merges,
   * and `epic/260829-x-leaderboard` would be a worse name for it. So instead of
   * making collision impossible, this makes it DELIBERATE: a branch this run's
   * `build.epic_branch` does not claim is refused, and `--reuse-epic` is the word
   * that says "yes, stack on it". Measured 2026-08-29: four runs piled onto one
   * `epic/leaderboard` with nothing said.
   *
   * `commit` never asks: it continues a story whose epic was claimed at prepare.
   */
  private async refuseOnForeignEpic(): Promise<ExecutorOutcome | null> {
    const claimed = new Set(this.claimedBranchesOnFile());
    const seen = new Set<string>();
    for (const planned of this.pendingStories()) {
      const epic = this.plan.epics.get(planned.story.epic);
      if (epic === undefined) continue;
      const branch = epic.epic.branch;
      const key = `${planned.story.repo}:${branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const repoDir = repoDirOf(this.workspace, planned.story.repo);
      if (!(await branchExists(repoDir, branch))) continue;   // we are about to cut it
      if (claimed.has(branch)) continue;                       // this run cut it earlier
      if (this.ctx.reuseEpic) {
        this.claimedEpics.add(branch);
        this.lines.push(`  · adopting existing \`${branch}\` in ${planned.story.repo} (--reuse-epic)`);
        continue;
      }
      return {
        ok: false,
        refused: true,
        awaiting: false,
        tasks: [],
        costUsd: 0,
        outputs: [],
        lines: [
          `[tldrx] build: \`${branch}\` already exists in ${planned.story.repo} and run ${this.ctx.runId} ` +
            "did not cut it — refusing to stack this run's commits onto someone else's epic.",
          "  either delete or rename that branch, or run `tldrx next --reuse-epic` to work on it deliberately.",
        ],
        error: `epic branch \`${branch}\` was not created by this run`,
      };
    }
    return null;
  }

  /** `run.yml`'s `build.epic_branch`, or nothing when the file will not open. */
  private claimedBranchesOnFile(): readonly string[] {
    try {
      return RunStore.open(this.ctx.runDir).run.build?.epic_branch ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Issue #41: the gate commands, on the UNTOUCHED base tree, before anything is
   * dispatched or charged.
   *
   * A DoD is a delta gate — "this story did not break the tree" — and a command
   * that is already red on main makes every story in the plan block for something
   * no story caused. Measured on `260829-scoring-leaderboard`: two of three
   * declared commands were red on pristine main, so all 15 stories would have
   * blocked identically, each having spent a developer turn, and one of the two
   * was running paid live AI tests as a routine gate.
   *
   * **Where it runs.** In the repo's own checkout, not a fresh worktree. That is
   * the tree a human calls "the base": it has the installed dependencies, the
   * build cache and the tool state that make the command mean what the team
   * thinks it means, and a pristine worktree would fail half the world's repos
   * for want of `node_modules` — turning this safety net into an outage. The
   * dirty-tree refusal has already run, so the tree is product-clean. The trade
   * is that a gate command which writes build output into a repo that does not
   * gitignore it now leaves that output in the repo rather than in a worktree —
   * a repo shaped like that was already broken for Build, whose commit step
   * would have swept the same files into a story's diff.
   *
   * **What it costs.** Once per run: every result is written to
   * `04-build/preflight.yml` and read back by the next invocation.
   *
   * A command the gate DECLINES to run (undeclared, or needing a shell) is
   * recorded `unmeasured` and refuses nothing — the story-level DoD already has
   * its own refusal for that, and inventing a base failure out of one would block
   * a build for a rule that is enforced elsewhere.
   */
  private async refuseOnRedBase(): Promise<ExecutorOutcome | null> {
    const failures: BaseCommandResult[] = [];
    const seen = new Set<string>();
    for (const planned of this.pendingStories()) {
      for (const command of planned.dod.commands) {
        const key = `${planned.story.repo}\u0000${command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const result = await this.baseResult(planned.story.repo, command);
        if (result !== null && result.status === "failed") failures.push(result);
      }
    }
    if (failures.length === 0) return null;
    const first = failures[0];
    return {
      ok: false,
      refused: true,
      awaiting: false,
      tasks: [],
      costUsd: 0,
      outputs: [],
      lines: [...baseRefusalLines(failures)],
      error: first === undefined
        ? "a workspace command fails on the base tree"
        : `\`${first.command}\` exits ${String(first.exitCode)} on the base tree of ${first.repo}`,
    };
  }

  /**
   * One gate command's result on one repo's base tree — from the run's cache when
   * this run already paid for it, measured and written down when it did not.
   *
   * `null` means the question could not be asked at all (a `repo:` the workspace
   * does not declare). Every caller treats that as "no evidence", never as a
   * verdict.
   */
  private async baseResult(repo: string, command: string): Promise<BaseCommandResult | null> {
    let repoDir: string;
    try {
      repoDir = repoDirOf(this.workspace, repo);
    } catch {
      return null;
    }
    const baseRef = this.workspace.defaultBranches.get(repo) ?? FALLBACK_DEFAULT_BRANCH;
    const baseSha = await shaOf(repoDir, baseRef);
    const cached = baseResultFor(this.basePreflight(), repo, command, baseSha);
    if (cached !== null) return cached;

    const timeoutMs = this.ctx.spec.planned.timeout_s * 1000;
    let measured: BaseCommandResult;
    try {
      const outcome = await runDodCommand(command, repoDir, timeoutMs, this.workspace.commands);
      const exitCode = outcome.timedOut ? 124 : outcome.exitCode;
      measured = {
        repo, command, baseRef, baseSha, exitCode, timedOut: outcome.timedOut, tail: outcome.tail,
        status: exitCode === 0 && !outcome.timedOut ? "ok" : "failed",
      };
    } catch (error) {
      if (!(error instanceof DodCommandRefused)) throw error;
      // The gate would not run it, so nothing was learned ABOUT THE BASE. The
      // story-level DoD refuses it on its own terms; this must not double as a
      // second, differently-worded veto.
      measured = {
        repo, command, baseRef, baseSha, exitCode: 126, timedOut: false,
        tail: error.message, status: "unmeasured",
      };
    }
    await this.writes.run(() => this.rememberBase(measured));
    return measured;
  }

  /** The run's cached base results, read once per process. */
  private basePreflight(): BasePreflight {
    if (!this.preflightLoaded) {
      this.preflight = loadPreflight(this.ctx.runDir);
      this.preflightLoaded = true;
    }
    return this.preflight ?? EMPTY_PREFLIGHT;
  }

  /**
   * Write one measurement into `04-build/preflight.yml`.
   *
   * Through the single writer, and best-effort: a cache that cannot be saved
   * costs the NEXT invocation a re-run, and that is never a reason to fail a
   * build that is otherwise fine.
   */
  private rememberBase(result: BaseCommandResult): void {
    const next = withResult(this.basePreflight(), result, this.ctx.at);
    this.preflight = next;
    this.preflightLoaded = true;
    try {
      savePreflight(this.ctx.runDir, next);
    } catch (error) {
      this.advisories.push(
        `could not write ${PREFLIGHT_REL}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Spec §5, Build executor safety: a repo whose tree is dirty is refused BEFORE
   * anything is cut, because the epic branch is cut from that tree's branch and
   * `git worktree add` would carry the mess forward.
   *
   * PRODUCT dirt only. `tldrx-work/` and `.tldrx/` are the framework's own state,
   * and in a `root_is_repo: true` workspace they sit inside the product repo — so
   * counting them made this command refuse the files it had just written itself
   * (`run.yml`, `events.jsonl`, `.lock`, the freshly synthesised `04-build/`), and
   * made a user's uncommitted answers a precondition of Build. Product dirt still
   * refuses exactly as before, with the same message and the same fix.
   */
  private async refuseOnDirtyRepos(): Promise<ExecutorOutcome | null> {
    const seen = new Set<string>();
    let ignored = 0;
    for (const planned of this.pendingStories()) {
      const name = planned.story.repo;
      if (seen.has(name)) continue;
      seen.add(name);
      const dir = repoDirOf(this.workspace, name);
      const split = partitionDirty(await dirtyPaths(dir), stateDirPrefixes(this.workspace.root, dir));
      ignored += split.state.length;
      const dirty = split.product;
      if (dirty.length === 0) continue;
      const branch = await currentBranch(dir);
      return {
        ok: false,
        refused: true,
        awaiting: false,
        tasks: [],
        costUsd: 0,
        outputs: [],
        lines: [
          `[tldrx] build: repo \`${name}\` has ${String(dirty.length)} uncommitted change(s) on ` +
            `\`${branch}\` — refusing to cut an epic branch from a dirty tree.`,
          `  ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? `, +${String(dirty.length - 5)} more` : ""}`,
          `Commit or stash them in ${relative(this.ctx.root, dir) || "."}/, then run \`tldrx next\` again.`,
        ],
        error: `repo \`${name}\` has uncommitted changes`,
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

  /**
   * Record that this story's branch went onto its epic, and WHAT the merge
   * moved: a count, or `null` when this invocation did not watch it happen.
   */
  private noteMerged(story: StoryContext, carried: number | null): void {
    const list = this.merged.get(story.epicBranch) ?? [];
    const id = story.planned.story.id;
    const at = list.findIndex((row) => row.id === id);
    if (at === -1) list.push({ id, carried });
    else list[at] = { id, carried };
    this.merged.set(story.epicBranch, list);
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
      conventions: renderConventions(this.ctx.root, [repo]),
      facts: renderFacts(facts.facts, [repo]),
      experts: bundles.experts,
      budgetUsd: this.developerCap(story.planned.story.id),
      // The implicit plan writes its own note, naming the facts this story is
      // for; the constant is the fallback for a plan built before it did.
      planNote: this.plan.implicit ? (story.planned.note ?? IMPLICIT_STORY_NOTE) : undefined,
      previousAttempt: story.previousAttempt,
      notInWorktree: story.notInWorktree,
      dispatchNotes: this.dispatchNotesFor(story.planned.story.id).body,
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

  private repoCommands(repo: string): readonly string[] {
    return this.workspace.repoCommands.get(repo) ?? [];
  }

  /**
   * The developer's ceiling for ONE story.
   *
   * Two sources, in order.
   *
   * **The Plan's own price**, when `03-plan/budget.yml` gave this story one. That
   * file is Delivery pricing each story against the stage ceiling, and until
   * 2026-08-30 it was read by nothing: on
   * `260830-tenancy-identity-customers` the executor handed $1.03 to the story
   * priced at $4.75 and the same $1.03 to the one priced at $0.75. The price is
   * divided by the worst case that ONE story can be asked for —
   * `MAX_ATTEMPTS × (1 + REVIEWER_SHARE)` — so a story that runs twice, developer
   * and reviewer both, stays inside what it was priced at.
   *
   * **A uniform share**, otherwise, exactly as before. Measured 2026-08-29: a
   * story's spend was `developer (1/N) + reviewer (0.25/N)` and the whole pipeline
   * could run TWICE, so N stories could charge 2.5x the stage ceiling — the
   * audit's "Build 2.5x su fase". Dividing by the worst case up front fixes that,
   * and a plan with no prices still gets it.
   */
  private developerCap(storyId?: string): number {
    const price = this.priceOf(storyId);
    if (price === null) return this.ctx.agentCap(1 / this.worstCaseShares());
    return this.ctx.agentCap(this.shareOf(price / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE))));
  }

  /**
   * The reviewer's ceiling for ONE story: its derived quarter-share, never below
   * `REVIEWER_FLOOR_USD`, never above what the stage has left or what
   * `per_agent_max_usd` / `--max-usd` allow.
   *
   * The floor is the fix for the failure that produced this code: $0.26 cannot
   * read a 39-file diff, and a reviewer that runs out mid-read costs the whole
   * developer turn it was supposed to judge (`REVIEWER_FLOOR_USD`).
   */
  private reviewerCap(storyId?: string): number {
    const price = this.priceOf(storyId);
    const derived = price === null
      ? this.ctx.agentCap(REVIEWER_SHARE / this.worstCaseShares())
      : this.ctx.agentCap(this.shareOf(price * REVIEWER_SHARE / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE))));
    const floor = Math.min(REVIEWER_FLOOR_USD, Math.max(this.ctx.budgetUsd - this.spent(), 0));
    return round2(Math.min(Math.max(derived, floor), this.ctx.maxBudgetUsd));
  }

  /**
   * What the Plan priced this story at, scaled to fit the stage — or null when it
   * priced nothing, so the uniform share applies.
   */
  private priceOf(storyId: string | undefined): number | null {
    if (storyId === undefined) return null;
    const price = this.plan.prices.get(storyId);
    if (price === undefined || !Number.isFinite(price) || price <= 0) return null;
    return price * this.priceScale();
  }

  /**
   * ≤ 1: what every declared price is multiplied by so the priced stories cannot
   * add up to more than the stage was given.
   *
   * A Plan that prices $22 of stories into an $18 stage is not refused — it is
   * scaled down proportionally, which keeps the RATIO Delivery decided (the
   * useful half) without letting the total escape the ceiling.
   */
  private priceScale(): number {
    if (this.ctx.budgetUsd <= 0) return 1;
    let sum = 0;
    for (const price of this.plan.prices.values()) {
      if (Number.isFinite(price) && price > 0) sum += price;
    }
    return sum <= this.ctx.budgetUsd ? 1 : this.ctx.budgetUsd / sum;
  }

  /** Dollars expressed as the fraction of the stage budget `agentCap` wants. */
  private shareOf(usd: number): number {
    return this.ctx.budgetUsd <= 0 ? 1 : usd / this.ctx.budgetUsd;
  }

  /**
   * How many developer-shares the phase can be asked for at worst:
   * `stories × attempts × (1 + REVIEWER_SHARE)`. Dividing by this makes the sum
   * of every uniform cap the executor can hand out ≤ the stage ceiling.
   */
  private worstCaseShares(): number {
    return Math.max(this.plan.storyCount, 1) * MAX_ATTEMPTS * (1 + REVIEWER_SHARE);
  }

  private spent(): number {
    return round2(this.tasks.reduce((sum, task) => sum + task.costUsd, 0));
  }

  private logPaths(): readonly string[] {
    return [...this.outcomes.values()].map((outcome) => outcome.reviewRel);
  }

  /** `.agent/<stage>/<story>/` — one bundle per sub-agent, never one per stage. */
  private bundleKey(storyId: string): string {
    return join(this.ctx.stageId, storyId);
  }

  /**
   * `.agent/<stage>/<story>/review/` — the reviewer's own bundle, one level below
   * the developer's.
   *
   * Nested rather than suffixed so `preparedBundles` (which walks exactly one
   * level) cannot read a reviewer bundle as a developer one. Two roles, two
   * directories, no flag to get wrong.
   */
  private reviewBundleKey(storyId: string): string {
    return join(this.ctx.stageId, storyId, REVIEW_DIR);
  }

  /** Is a reviewer bundle out for this story? Its presence IS the state. */
  private reviewBundleOut(storyId: string): boolean {
    return existsSync(join(agentDir(this.ctx.runDir, this.reviewBundleKey(storyId)), PENDING_FILE));
  }

  /**
   * Write the reviewer bundle: the prompt a spawn would have been given, plus the
   * facts that make it dispatchable — the diff refs, the merged commit, the DoD
   * already re-run, and the envelope schema `--commit --review` will parse.
   *
   * No cap is spent and no meter starts. `max_budget_usd` is still recorded,
   * because the host is entitled to know what the framework would have paid for
   * this read — but it is a number to compare against, not one to enforce here.
   */
  private writeReviewBundle(story: StoryContext, work: ReviewWork): string {
    const id = story.planned.story.id;
    const key = this.reviewBundleKey(id);
    const review: PendingReview = {
      story: id,
      repo: story.planned.story.repo,
      branch: story.branch,
      epic_branch: story.epicBranch,
      diff: diffCommand(story.epicBranch, story.branch),
      commit: work.commit,
      attempt: story.attempt,
      max_attempts: MAX_ATTEMPTS,
      worktree: relative(this.ctx.root, story.worktree),
      dod: work.dod.map((r) => ({ command: r.command, exit_code: r.exitCode })),
      resumed_from: work.why,
    };
    const pending: PendingStage = {
      version: 1,
      run: this.ctx.runId,
      phase: this.ctx.phaseId,
      stage: this.ctx.stageId,
      expert: "reviewer",
      model: this.model(),
      effort: this.ctx.effort,
      budget_usd: this.ctx.budgetUsd,
      max_budget_usd: this.reviewerCap(id),
      prompt: "prompt.md",
      outputs: [],
      sections: {},
      // The story's own dod is re-run by the executor, never by the reviewer —
      // the prompt says so in as many words. The stage's checks are the gate's.
      checks: [],
      prepared_at: this.ctx.at,
      story: id,
      role: "reviewer",
      result_schema: REVIEW_SCHEMA,
      review,
    };
    // An answer already sitting here is NOT binned. `--prepare` overwrites the
    // prompt and the pending record and leaves `result.json` exactly as the
    // developer half does — a turn somebody has already paid for is not this
    // command's to throw away (`preparedRefusal`'s rule). It is said out loud
    // instead, because a stale answer read as a fresh verdict is the other half
    // of that hazard and `--discard-pending` is the door for it.
    const answered = existsSync(join(agentDir(this.ctx.runDir, key), RESULT_FILE));
    writeBundle(this.ctx.runDir, key, this.reviewerPrompt(story, work.dod), pending);
    if (answered) {
      this.lines.push(
        `  · ${id}: a ${RESULT_FILE} was already in the reviewer bundle and was KEPT — `
        + "settle it with `tldrx next --commit --review`, or bin it with `--discard-pending`",
      );
    }
    return key;
  }

  /** A settled handshake leaves the log, not the bundle. */
  private clearReviewBundle(key: string): void {
    const dir = agentDir(this.ctx.runDir, key);
    for (const file of [PENDING_FILE, RESULT_FILE, RAW_FILE]) rmSync(join(dir, file), { force: true });
  }

  /**
   * Is this story waiting on nothing but a REVIEW — and if so, what does the
   * reviewer need?
   *
   * Two histories, one answer. `resumableReview` is the narrow "the last reviewer
   * died" case that landed on 2026-08-30. The second is a review this framework
   * already handed to the host: the bundle on disk is the record of that, and it
   * is removed the moment `--commit --review` counts a verdict, so its presence
   * is exact rather than a guess about the ledger's shape.
   *
   * A story whose reviewer asked for CHANGES is deliberately NOT here: that one
   * is owed a developer attempt, its bundle was cleared when the verdict was
   * counted, and `prepare()` hands it a developer exactly as it always did.
   */
  private reviewWorkFor(planned: PlannedStory): ReviewWork | null {
    const resume = this.resumableReview(planned);
    if (resume !== null) {
      return { commit: resume.commit, dod: resume.dod, why: `the previous reviewer FAILED (${resume.error})` };
    }
    if (!this.reviewBundleOut(planned.story.id)) return null;
    return this.reviewWorkFromBundle(planned.story.id) ?? this.reviewWorkFromLedger(planned);
  }

  /**
   * The bundle's own account of what it is a review OF.
   *
   * Read in preference to the ledger, and not as a convenience: a story handed
   * over mid-pipeline has NOT settled, so no `task.done` records its commit yet
   * and the ledger genuinely does not know it. The bundle does — it was written
   * from the merge that had just happened. The contract handed to the host is the
   * contract read back from it.
   */
  private reviewWorkFromBundle(storyId: string): ReviewWork | null {
    const path = join(agentDir(this.ctx.runDir, this.reviewBundleKey(storyId)), PENDING_FILE);
    if (!existsSync(path)) return null;
    let doc: PendingStage;
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as PendingStage;
    } catch {
      return null;
    }
    const review = doc.review;
    if (review === undefined || typeof review.commit !== "string" || review.commit === "") return null;
    return {
      commit: review.commit,
      dod: (review.dod ?? []).map((r) => ({
        command: r.command, exitCode: r.exit_code, timedOut: r.exit_code === 124, tail: "",
      })),
      why: review.resumed_from ?? "its review is outstanding",
    };
  }

  /**
   * The same facts, read off the ledger with no opinion about whether a review is
   * OWED — for the paths where the operator has already said so by typing
   * `--review`, or where a bundle is being settled.
   */
  private reviewWorkFromLedger(planned: PlannedStory): ReviewWork | null {
    const status = this.statusOf(planned);
    if (status !== "review" && status !== "in_progress") return null;
    const ledger = readReviewLedger(this.ctx.runDir, planned.story.id);
    if (ledger.commit === null) return null;
    return {
      commit: ledger.commit,
      dod: ledger.dod,
      why: "its review is outstanding",
    };
  }

  /** The story whose reviewer bundle is out, if any. */
  private awaitingReview(): PlannedStory | null {
    return this.pendingStories().find((p) => this.reviewBundleOut(p.story.id)) ?? null;
  }

  /** How many reviewers have already JUDGED this story, from the ledger. */
  private reviewAttempts(storyId: string): number {
    return this.reviews.get(storyId) ?? readReviewLedger(this.ctx.runDir, storyId).verdicts;
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
  private blockedByFailedDeveloper(planned: PlannedStory): string | null {
    const fresh = this.outcomes.get(planned.story.id);
    if (fresh !== undefined) return fresh.developerError;
    const ledger = readReviewLedger(this.ctx.runDir, planned.story.id);
    if (ledger.developerErroredWith !== null) return ledger.developerErroredWith;
    if (ledger.blockedWithNothingRun && planned.dod.commands.length > 0) return DEVELOPER_FAILED;
    return null;
  }

  /**
   * Is this story waiting on nothing but a review that FAILED?
   *
   * Three things have to hold, and all three are read off disk so a fresh process
   * reaches the same answer: the story is not settled, the last review in the
   * ledger errored (nothing has judged it since), and a commit was merged. Miss
   * any one and this returns null and the ordinary pipeline runs.
   *
   * `in_progress` counts as well as `review`, and that is not a nicety: on the
   * run that found this bug the in-session path had already handed the host a
   * developer bundle for "attempt 2", which set the story to `in_progress`. That
   * attempt was never owed and this is where it stops being offered.
   */
  private resumableReview(planned: PlannedStory): ResumableReview | null {
    const status = this.statusOf(planned);
    if (status !== "review" && status !== "in_progress") return null;
    // Once THIS process has settled the story, its own outcome is the truth.
    const fresh = this.outcomes.get(planned.story.id);
    if (fresh !== undefined && fresh.verdict !== "error") return null;
    const ledger = readReviewLedger(this.ctx.runDir, planned.story.id);
    if (ledger.erroredWith === null || ledger.commit === null) return null;
    return { commit: ledger.commit, dod: ledger.dod, error: ledger.erroredWith };
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
        verdictProblem: null,
      });
    }
    const path = join(this.ctx.runDir, BUILD_PHASE, LOG_DIR, `${storyId}.md`);
    if (this.reviewAttempts(storyId) === 0 || !existsSync(path)) return "";
    return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => `> ${line}`).join("\n");
  }

  /**
   * `.tldrx/worktrees/<repo>/<run>-<story>` — the run id is in the PATH too.
   *
   * Same collision, worse: the fourth run of one plan reused the third's LIVE
   * worktree, so two sub-agents were editing the same files at the same time
   * (2026-08-29 audit, §B). A path that names the run cannot be walked into.
   */
  private storyWorktree(planned: PlannedStory): string {
    return join(
      this.ctx.root, PROJECT_FRAMEWORK_DIR, WORKTREES,
      planned.story.repo, `${this.ctx.runId}-${planned.story.id}`,
    );
  }

  /**
   * `.tldrx/worktrees/<repo>/_epic-<run>-<epic>` — the run id is in THIS path too.
   *
   * Same collision as the story worktree above, and worse in kind, because this
   * is the worktree a story MERGES in. Every plan names its first epic `E1`, so
   * `_epic-E1` was a path two runs both computed: the second run's `existsSync`
   * hit the first run's live worktree, `addWorktree` was skipped, and
   * `git merge --no-ff` ran inside a checkout of ANOTHER run's epic branch. It
   * never failed — `commitsBetween` and every handoff line render
   * `story.epicBranch`, so three stories reported "merged into
   * `epic/hardening-d1`" while the commits landed on a closed run's
   * `epic/d1-tenancy-identity-customers` and the run closed with an empty epic
   * (issue #40, measured 2026-08-31).
   *
   * Both halves are load-bearing. The path makes the collision impossible; the
   * `assertWorktreeOn` on EVERY reuse — the remembered path and the one found on
   * disk — makes it impossible to repeat SILENTLY. A mismatch refuses; it never
   * re-points the worktree and never merges anyway.
   */
  private async openEpicWorktree(story: StoryContext): Promise<string> {
    const key = `${story.planned.story.repo}:${story.epicBranch}`;
    const known = this.epicWorktrees.get(key);
    if (known !== undefined && existsSync(known)) {
      await assertWorktreeOn(known, story.epicBranch, "epic worktree");
      return known;
    }
    const path = join(
      this.ctx.root, PROJECT_FRAMEWORK_DIR, WORKTREES,
      story.planned.story.repo, epicWorktreeName(this.ctx.runId, story.planned.story.epic),
    );
    if (existsSync(path)) {
      await assertWorktreeOn(path, story.epicBranch, "epic worktree");
    } else {
      mkdirSync(join(path, ".."), { recursive: true });
      const base = this.workspace.defaultBranches.get(story.planned.story.repo) ?? "main";
      await addWorktree(story.repoDir, path, story.epicBranch, base);
    }
    this.epicWorktrees.set(key, path);
    return path;
  }

  private async cleanUp(story: StoryContext): Promise<void> {
    if (this.ctx.keepWorktrees) return;
    await removeWorktree(story.repoDir, story.worktree);
  }

  private async cleanUpEpics(): Promise<void> {
    if (this.ctx.keepWorktrees) return;
    for (const [key, path] of this.epicWorktrees) {
      try {
        await removeWorktree(repoDirOf(this.workspace, key.split(":")[0] ?? ""), path);
      } catch {
        // A worktree that will not go away is a note, not a failed phase.
      }
    }
  }
}

/**
 * What a story's developer may do: the file tools, exactly the commands its OWN
 * repo declares in `workspace.yml`, and the two git verbs that make a commit.
 * Not `git push`, not `git merge`, not another repo's commands.
 */
export function developerTools(repoCommands: readonly string[]): readonly string[] {
  return [
    ...BASE_TOOLS,
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
  /** The DoD results of the last developer attempt that actually ran one. */
  readonly dod: readonly DodResult[];
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
}

/** Everything the two resume paths and the requeue counter need, in one pass. */
export function readReviewLedger(runDir: string, storyId: string): ReviewLedger {
  const path = join(runDir, "events.jsonl");
  const empty: ReviewLedger = {
    verdicts: 0, fixlistRounds: 0, erroredWith: null, commit: null, dod: [],
    developerErroredWith: null, blockedWithNothingRun: false, reopened: null,
  };
  if (!existsSync(path)) return empty;

  let verdicts = 0;
  let fixlistRounds = 0;
  let erroredWith: string | null = null;
  let commit: string | null = null;
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
  let reopened: ReviewLedger["reopened"] = null;

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
    if (event.type === "agent.spawned" && payload.role === "reviewer") sawReviewer = true;
    if (event.type === "task.done") {
      if (typeof payload.commit === "string" && payload.commit !== "") commit = payload.commit;
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
      const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : 0;
      current.push({
        command: payload.command,
        exitCode,
        timedOut: exitCode === 124,
        tail: typeof payload.detail === "string" ? payload.detail : "",
      });
      continue;
    }
    if (payload.check !== "review") continue;

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
    dod: current.length > 0 ? current : dod,
    developerErroredWith,
    blockedWithNothingRun,
    reopened,
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

function isPlanStatus(value: string | undefined): value is PlanStatus {
  return value !== undefined && ["todo", "in_progress", "review", "done", "blocked"].includes(value);
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
