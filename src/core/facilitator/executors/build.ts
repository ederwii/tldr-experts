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
import { join, relative } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../../paths.ts";
import { factsPath, loadWorkspace, type WorkspaceContext } from "../../../hooks/lib/workspace.ts";
import { DodCommandRefused, runDodCommand } from "../../../hooks/lib/story.ts";
import { FactsStore } from "../../facts/FactsStore.ts";
import { RunStore } from "../../run/RunStore.ts";
import { renderConventions, renderFacts, stackExpertNames } from "../prompt.ts";
import { loadExpertBundles } from "../../experts/expertBundle.ts";
import { agentDir } from "../paths.ts";
import { preparedBundles } from "../../run/prepared.ts";
import { spawnAgent, BASE_TOOLS } from "../spawnAgent.ts";
import {
  PendingError, PENDING_FILE, RAW_FILE, RESULT_FILE, readResult, writeBundle, writeRaw, type PendingStage,
} from "../pending.ts";
import {
  addWorktree, branchExists, commitAll, commitsBetween, currentBranch, dirtyPaths, ensureBranch, firstLine,
  GitError, headSha, isDirty, mergeNoFf, partitionDirty, pathAtRef, removeWorktree, repoDirOf, stateDirPrefixes,
} from "../../build/git.ts";
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
import { dodGreen, type DodResult, type StoryOutcome } from "../../build/outcome.ts";
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

/** What half A of a parallel wave produced for one story. */
interface StoryHalf {
  readonly story: StoryContext;
  readonly cost: number;
  readonly dod: readonly DodResult[];
  readonly commit: string | null;
  /** Non-null when the story is already lost: half B blocks it and stops. */
  readonly failure: string | null;
}

export async function buildExecutor(ctx: ExecutorContext): Promise<ExecutorOutcome> {
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
    if (ctx.mode === "prepare") return withClaims(await session.prepare());
    if (ctx.mode === "commit") return withClaims(await session.commit());
    return withClaims(await session.runAll());
  } catch (error) {
    if (error instanceof GitError || error instanceof PlanLoadError) {
      return withClaims(failed(ctx, error.message, session.tasks));
    }
    throw error;
  }
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
    for (const file of [PENDING_FILE, RESULT_FILE, RAW_FILE]) rmSync(join(dir, file), { force: true });
    lines.push(`  · discarded the --prepare bundle in ${relative(ctx.root, dir)}/`);
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
  private readonly merged = new Map<string, string[]>();
  private readonly lines: string[] = [];
  /** Per-story reviewer verdicts seen in THIS process, for the requeue counter. */
  private readonly reviews = new Map<string, number>();
  /** Epic branches this run cut or adopted; `runNext` writes them to run.yml. */
  readonly claimedEpics = new Set<string>();
  /** The single writer every state-changing step goes through (see `SerialQueue`). */
  private readonly writes = new SerialQueue();
  /** stderr lines: advice for the operator, never a reason to stop. */
  private readonly advisories: string[] = [];
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
    const refusal = await this.refuseOnDirtyRepos() ?? await this.refuseOnForeignEpic();
    if (refusal !== null) return refusal;
    this.recordGateFeedback();

    for (const wave of this.plan.waves) {
      const pending: PlannedStory[] = [];
      for (const planned of wave.stories) {
        const status = this.statusOf(planned);
        if (status === "done" || status === "blocked") {
          this.lines.push(`  · ${planned.story.id} is already \`${status}\` — left alone`);
          continue;
        }
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
    const refusal = await this.refuseOnDirtyRepos() ?? await this.refuseOnForeignEpic();
    if (refusal !== null) return refusal;

    // The reviewer is the FRAMEWORK's sub-agent in both modes — only the
    // developer is delegated to the host session — so a story waiting on nothing
    // but a re-review is finished here and now rather than handed out as a
    // second developer attempt. That hand-out is exactly what this path did on
    // 2026-08-30: `task.started … attempt: 2, mode: prepare`, for a story whose
    // diff nobody had ever read.
    // An errored review produced no `changes` verdict, so no developer attempt is
    // owed and none is offered. A bundle a previous version of this code ALREADY
    // handed out is not stranded by that: `tldrx next --commit` still reads its
    // `result.json` and runs the full pipeline over it, exactly as before.
    const resume = this.resumableReview(planned);
    if (resume !== null) return await this.prepareRereview(planned, resume);

    const story = await this.openStory(planned);
    const cap = this.developerCap(planned.story.id);
    const key = this.bundleKey(planned.story.id);
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
    };
    writeBundle(this.ctx.runDir, key, this.developerPrompt(story), pending);
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

  /** The in-session answer to a story waiting on a review: run the review. */
  private async prepareRereview(planned: PlannedStory, resume: ResumableReview): Promise<ExecutorOutcome> {
    await this.rereview(planned, resume);
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
        `${planned.story.id} → \`${outcome?.status ?? "?"}\` (review only — no developer attempt was owed)`,
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
    await this.pipelineFromDod(story, round2(result.cost_usd ?? 0));

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
      if (outcome?.status !== "review") return;
      // Only a real `changes` verdict buys another developer attempt. An errored
      // review leaves the story parked for the NEXT invocation's review-only
      // path — retrying the same reviewer under the same ceiling in the same
      // process would just buy the same error twice.
      if (outcome.verdict === "error") return;
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
    await Promise.all(Array.from({ length: Math.min(this.lanes, queue.length) }, lane));
    return halves;
  }

  /** Half A for one story: worktree → developer → DoD → commit. */
  private async buildHalf(planned: PlannedStory): Promise<StoryHalf> {
    // (a)(b)(c) touch the SHARED repo — `git branch`, `git worktree add` — so they
    // go through the one writer even though the sub-agent below does not.
    const story = await this.writes.run(() => this.openStory(planned));
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

    const spent = await this.spawnDeveloper(story);
    if (spent === null) {
      return { story, cost: 0, dod: [], commit: null, failure: "the developer sub-agent failed" };
    }

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
      };
    }

    // (e) commit whatever the agent left behind, if it did not commit itself.
    const commit = await this.writes.run(() => this.commitIfDirty(story));
    if (commit === null) {
      return { story, cost: spent, dod, commit: null, failure: "the working tree could not be committed" };
    }
    return { story, cost: spent, dod, commit, failure: null };
  }

  /** Half B for one story: merge → review → done/blocked. Always serial. */
  private async settleHalf(half: StoryHalf): Promise<void> {
    const { story, dod, commit } = half;
    if (half.failure !== null) {
      await this.block(story, half.failure, half.cost, dod);
      return;
    }
    // `buildHalf` sets `failure` whenever it has no commit, so this is
    // unreachable — but the reviewer path needs a sha it can hand forward, and a
    // narrowing the compiler can see beats one it has to be told about.
    if (commit === null) {
      await this.block(story, "the story produced no commit to review", half.cost, dod);
      return;
    }

    // (f) merge into the epic. A conflict blocks the story; the wave carries on.
    const merge = await this.mergeIntoEpic(story);
    if (!merge.ok) {
      await this.block(story, `merge into \`${story.epicBranch}\` failed: ${merge.detail}`, half.cost, dod, {
        commit,
        conflicts: merge.conflicts,
      });
      return;
    }
    this.noteMerged(story);

    // (g)(h) the reviewer, and whatever it decides.
    await this.reviewAndSettle(story, dod, commit, half.cost);
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
  ): Promise<void> {
    const review = await this.spawnReviewer(story, dod);
    const cost = round2(priorCost + review.cost);

    // A reviewer that FAILED said nothing about the diff. The story parks at
    // `review` — pending, worktree kept, requeue counter untouched — and the next
    // `tldrx next` re-runs the REVIEW, not the developer.
    if (review.review.verdict === "error") {
      await this.settle(story, "review", {
        dod, commit, merged: true, verdict: "error", review: review.review, cost,
        reason: `the reviewer FAILED and returned no verdict — ${review.review.summary}`,
      });
      return;
    }

    const requeue = review.review.verdict === "changes" && story.attempt < MAX_ATTEMPTS;
    if (review.review.verdict === "changes") {
      await this.settle(story, requeue ? "review" : "blocked", {
        dod, commit, merged: true, verdict: "changes", review: review.review, cost,
        reason: requeue
          ? `the reviewer asked for changes: ${review.review.summary}`
          : `the reviewer asked for changes twice: ${review.review.summary}`,
      });
      return;
    }

    // (h) done — DoD green AND the reviewer approved. Write the evidence.
    await this.settle(story, "done", {
      dod, commit, merged: true, verdict: "approve", review: review.review, cost, reason: null,
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
    this.noteMerged(story);
    this.lines.push(
      `  · ${planned.story.id}: the previous reviewer FAILED (${resume.error}) — `
      + `re-running the REVIEW only; \`${resume.commit}\` is already merged into \`${story.epicBranch}\``,
    );
    await this.reviewAndSettle(story, resume.dod, resume.commit, 0);
  }

  /** True when any story of this wave settled at `blocked`. */
  private waveFailed(wave: BuildWave): boolean {
    return wave.stories.some((planned) => this.statusOf(planned) === "blocked");
  }

  /** DoD → commit → merge → review → done/blocked, for the `--commit` cycle. */
  private async pipelineFromDod(story: StoryContext, developerCost: number): Promise<void> {
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
      return;
    }
    const commit = await this.commitIfDirty(story);
    if (commit === null) {
      await this.block(story, "the working tree could not be committed", developerCost, dod);
      return;
    }
    await this.settleHalf({ story, cost: developerCost, dod, commit, failure: null });
  }

  // --- steps ----------------------------------------------------------------

  /** (a)(b)(c): repo, epic branch, story worktree. */
  private async openStory(planned: PlannedStory): Promise<StoryContext> {
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

  /** (d) one developer sub-agent, cwd = the worktree. Returns its cost, or null. */
  private async spawnDeveloper(story: StoryContext): Promise<number | null> {
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
    return agent.ok ? round2(agent.costUsd) : null;
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
      if (!green) break;
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
      prompt: buildReviewerPrompt({
        runId: this.ctx.runId,
        story: story.planned,
        repoName: story.planned.story.repo,
        branch: story.branch,
        epicBranch: story.epicBranch,
        worktree: story.worktree,
        conventions: renderConventions(this.ctx.root, [story.planned.story.repo]),
        dodResults: dod.map((r) => ({ command: r.command, exitCode: r.exitCode })),
      }),
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
    const review = agent.ok ? parseReview(agent.structured, agent.result) : reviewerFailed(agent.error);

    this.tasks.push({
      key: story.planned.story.id,
      model: this.model(),
      costUsd: round2(agent.costUsd),
      sessionId: agent.sessionId,
      error: agent.error,
      outputs: [],
    });
    const id = story.planned.story.id;
    // The requeue counter counts VERDICTS. An errored review consumed a turn's
    // money but produced no judgement, so it may not consume an attempt as well.
    if (review.verdict !== "error") this.reviews.set(id, (this.reviews.get(id) ?? 0) + 1);
    // The reviewer IS a check: `approve` is the pass, `changes` and `error` the
    // two failures. `verdict` is what tells a ledger which one it is reading, and
    // `detail` on an errored review is the ERROR, verbatim.
    this.ctx.emit(review.verdict === "approve" ? "check.passed" : "check.failed", {
      phase: this.ctx.phaseId,
      check: "review",
      story: id,
      verdict: review.verdict,
      attempt: story.attempt,
      detail: review.summary,
    });
    return { review, cost: round2(agent.costUsd) };
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
      conflicts: extra.conflicts ?? [],
      verdict: "n-a",
      review: { verdict: "n-a", summary: "", findings: [] },
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
      conflicts?: readonly string[];
      verdict: StoryOutcome["verdict"];
      review: Review;
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
      conflicts: parts.conflicts ?? [],
      verdict: parts.verdict,
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
    // the same tree rather than re-cutting the branch it just wrote.
    if (status !== "review") await this.cleanUp(story);
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
      conflicts: [],
      verdict: status === "done" ? "approve" : "n-a",
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
      rows.push({
        id,
        branch: epic.epic.branch,
        repos: epic.epic.repos,
        merged: this.merged.get(epic.epic.branch) ?? [],
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
        if (status === "done" || status === "blocked") continue;
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

  private noteMerged(story: StoryContext): void {
    const list = this.merged.get(story.epicBranch) ?? [];
    if (!list.includes(story.planned.story.id)) list.push(story.planned.story.id);
    this.merged.set(story.epicBranch, list);
  }

  private developerPrompt(story: StoryContext): string {
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
    });
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

  /** How many reviewers have already JUDGED this story, from the ledger. */
  private reviewAttempts(storyId: string): number {
    return this.reviews.get(storyId) ?? readReviewLedger(this.ctx.runDir, storyId).verdicts;
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

  private async openEpicWorktree(story: StoryContext): Promise<string> {
    const key = `${story.planned.story.repo}:${story.epicBranch}`;
    const known = this.epicWorktrees.get(key);
    if (known !== undefined && existsSync(known)) return known;
    const path = join(
      this.ctx.root, PROJECT_FRAMEWORK_DIR, WORKTREES,
      story.planned.story.repo, `_epic-${story.planned.story.epic}`,
    );
    if (!existsSync(path)) {
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
 * What `events.jsonl` already says about one story, for the two questions a
 * fresh process cannot answer from memory: how many times has it really been
 * REVIEWED, and is it waiting on a review that FAILED?
 */
export interface ReviewLedger {
  /**
   * Real verdicts — `approve` or `changes`. This is the requeue counter, and an
   * errored review is deliberately not one of them.
   */
  readonly verdicts: number;
  /** The error of the LAST review, when it errored and nothing judged it since. */
  readonly erroredWith: string | null;
  /** The story commit the last `task.done` recorded — the diff already merged. */
  readonly commit: string | null;
  /** The DoD results of the last developer attempt that actually ran one. */
  readonly dod: readonly DodResult[];
}

/** Everything `resumableReview` and the requeue counter need, in one pass. */
export function readReviewLedger(runDir: string, storyId: string): ReviewLedger {
  const path = join(runDir, "events.jsonl");
  const empty: ReviewLedger = { verdicts: 0, erroredWith: null, commit: null, dod: [] };
  if (!existsSync(path)) return empty;

  let verdicts = 0;
  let erroredWith: string | null = null;
  let commit: string | null = null;
  // `dod` is the last attempt that got as far as running its DoD; `current` is
  // what THIS attempt has run so far. An attempt that was started and produced
  // nothing must not erase the proof of the one before it — measured on the live
  // run, where the wrongly-prepared "attempt 2" left S1 with no DoD at all.
  let dod: DodResult[] = [];
  let current: DodResult[] = [];

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: string; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      // A half-written last line is not a reason to lose the count.
      continue;
    }
    const payload = event.payload ?? {};
    if (payload.story !== storyId) continue;

    // A new attempt starts a new DoD run; only the latest one that RAN describes
    // the diff on the branch now.
    if (event.type === "task.started") {
      if (current.length > 0) dod = current;
      current = [];
    }
    if (event.type === "task.done" && typeof payload.commit === "string" && payload.commit !== "") {
      commit = payload.commit;
    }
    if (event.type !== "check.passed" && event.type !== "check.failed") continue;

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
    verdicts++;
    erroredWith = null;
  }
  return { verdicts, erroredWith, commit, dod: current.length > 0 ? current : dod };
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
