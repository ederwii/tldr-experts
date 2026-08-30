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
 * Sequential in v1 (spec §5 decision (c)). The ORDER is already the parallel-safe
 * one — `waves.yml` guarantees a dependency is in an earlier wave — so making the
 * inner loop a fan-out later changes nothing else here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../../paths.ts";
import { factsPath, loadWorkspace, type WorkspaceContext } from "../../../hooks/lib/workspace.ts";
import { DodCommandRefused, runDodCommand } from "../../../hooks/lib/story.ts";
import { FactsStore } from "../../facts/FactsStore.ts";
import { renderConventions, renderFacts, stackExpertNames } from "../prompt.ts";
import { loadExpertBundles } from "../../experts/expertBundle.ts";
import { agentDir } from "../paths.ts";
import { spawnAgent, BASE_TOOLS } from "../spawnAgent.ts";
import { PendingError, readResult, writeBundle, writeRaw, type PendingStage } from "../pending.ts";
import {
  addWorktree, commitAll, currentBranch, dirtyPaths, ensureBranch, firstLine, GitError, headSha,
  isDirty, mergeNoFf, removeWorktree, repoDirOf,
} from "../../build/git.ts";
import {
  loadBuildPlan, PlanLoadError, BUILD_PHASE, LOG_DIR, PLAN_PHASE, WORKTREES,
  type BuildPlan, type PlannedEpic, type PlannedStory,
} from "../../build/plan.ts";
import { evidenceFor, updateStoryFront } from "../../build/storyFile.ts";
import { buildDeveloperPrompt, buildReviewerPrompt, REVIEW_SCHEMA } from "../../build/prompts.ts";
import { parseReview, renderPreviousAttempt, renderReviewLog, type Review } from "../../build/review.ts";
import { dodGreen, type DodResult, type StoryOutcome } from "../../build/outcome.ts";
import { renderBuildHandoff, type EpicSummaryRow } from "../../build/handoff.ts";
import type { PlanStatus } from "../../schemas/planCommon.ts";
import type { ExecutorContext, ExecutorOutcome, ExecutorTask } from "./index.ts";

export const HANDOFF_REL = `${BUILD_PHASE}/handoff.md`;

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

export async function buildExecutor(ctx: ExecutorContext): Promise<ExecutorOutcome> {
  const workspace = loadWorkspace(ctx.root);
  let plan: BuildPlan;
  try {
    plan = loadBuildPlan(join(ctx.runDir, PLAN_PHASE), workspace.commands);
  } catch (error) {
    if (error instanceof PlanLoadError) return failed(ctx, error.message, []);
    throw error;
  }

  const session = new BuildSession(ctx, workspace, plan);
  try {
    if (ctx.mode === "prepare") return await session.prepare();
    if (ctx.mode === "commit") return await session.commit();
    return await session.runAll();
  } catch (error) {
    if (error instanceof GitError || error instanceof PlanLoadError) {
      return failed(ctx, error.message, session.tasks);
    }
    throw error;
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

  constructor(
    private readonly ctx: ExecutorContext,
    private readonly workspace: WorkspaceContext,
    private readonly plan: BuildPlan,
  ) {}

  // --- the three entry points ----------------------------------------------

  /** Headless: every wave, every story, in order, then the handoff. */
  async runAll(): Promise<ExecutorOutcome> {
    const refusal = await this.refuseOnDirtyRepos();
    if (refusal !== null) return refusal;

    for (const wave of this.plan.waves) {
      for (const planned of wave.stories) {
        const status = this.statusOf(planned);
        if (status === "done" || status === "blocked") {
          this.lines.push(`  · ${planned.story.id} is already \`${status}\` — left alone`);
          continue;
        }
        await this.driveStory(planned);
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
    const refusal = await this.refuseOnDirtyRepos();
    if (refusal !== null) return refusal;

    const story = await this.openStory(planned);
    const cap = this.developerCap();
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
        `prepared ${planned.story.id} · ${planned.story.title} — ${dir}/prompt.md ` +
          `($${cap.toFixed(2)} ceiling, attempt ${String(story.attempt)} of ${String(MAX_ATTEMPTS)})`,
        `dispatch ONE sub-agent with cwd ${relative(this.ctx.root, story.worktree)}`,
        `then write {outputs, questions_asked, notes} to ${dir}/result.json and run \`tldrx next --commit\``,
      ],
      error: null,
    };
  }

  /** In-session: continue the prepared story from the DoD step. */
  async commit(): Promise<ExecutorOutcome> {
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
      outputs: this.logPaths(),
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
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const story = await this.openStory(planned);
      this.ctx.emit("task.started", {
        phase: this.ctx.phaseId,
        story: planned.story.id,
        wave: planned.wave,
        repo: planned.story.repo,
        branch: story.branch,
        attempt: story.attempt,
      });
      this.setStoryStatus(planned, "in_progress");

      const spent = await this.spawnDeveloper(story);
      if (spent === null) {
        await this.block(story, "the developer sub-agent failed", 0);
        return;
      }
      await this.pipelineFromDod(story, spent);
      if (this.outcomes.get(planned.story.id)?.status !== "review") return;
      this.lines.push(`  · ${planned.story.id}: reviewer asked for changes — requeued once`);
    }
  }

  /** DoD → commit → merge → review → done/blocked. Shared by both modes. */
  private async pipelineFromDod(story: StoryContext, developerCost: number): Promise<void> {
    // (e) the Definition of Done, re-run in the story's own worktree.
    const dod = await this.runDod(story);
    if (!dodGreen({ dod })) {
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

    // (e) commit whatever the agent left behind, if it did not commit itself.
    const commit = await this.commitIfDirty(story);
    if (commit === null) {
      await this.block(story, "the working tree could not be committed", developerCost, dod);
      return;
    }

    // (f) merge into the epic. A conflict blocks the story; the wave carries on.
    const merge = await this.mergeIntoEpic(story);
    if (!merge.ok) {
      await this.block(story, `merge into \`${story.epicBranch}\` failed: ${merge.detail}`, developerCost, dod, {
        commit,
        conflicts: merge.conflicts,
      });
      return;
    }
    this.noteMerged(story);

    // (g) the reviewer.
    const review = await this.spawnReviewer(story, dod);
    const cost = round2(developerCost + review.cost);
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
    const branch = `story/${planned.story.id}`;
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
    };
  }

  /** (d) one developer sub-agent, cwd = the worktree. Returns its cost, or null. */
  private async spawnDeveloper(story: StoryContext): Promise<number | null> {
    const cap = this.developerCap();
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
    if (await isDirty(story.worktree)) {
      const message = `feat(${story.planned.story.id}): ${story.planned.story.title}`;
      const committed = await commitAll(story.worktree, message);
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
    const cap = this.reviewerCap();
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
    });

    // A reviewer that did not finish has not approved anything.
    const review = agent.ok
      ? parseReview(agent.structured, agent.result)
      : { verdict: "changes" as const, summary: agent.error ?? "the reviewer sub-agent failed", findings: [] };

    this.tasks.push({
      key: story.planned.story.id,
      model: this.model(),
      costUsd: round2(agent.costUsd),
      sessionId: agent.sessionId,
      error: agent.error,
      outputs: [],
    });
    const id = story.planned.story.id;
    this.reviews.set(id, (this.reviews.get(id) ?? 0) + 1);
    // The reviewer IS a check: `approve` is the pass, `changes` the failure. That
    // makes a requeued story visible in the ledger as the failed check it was.
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
    this.updateEpicStatus(story.epic);

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
      outputs: [...this.logPaths(), HANDOFF_REL],
      // Build always stops at a human: nothing here merges an epic to a default
      // branch, so somebody has to.
      gate: "approve",
      lines: [
        `${this.ctx.phaseId}/${this.ctx.stageId}: ${String(done)} of ${String(outcomes.length)} story(ies) done ` +
          `across ${String(this.plan.waves.length)} wave(s)`,
        ...this.lines,
        `wrote ${HANDOFF_REL}`,
      ],
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
   * Spec §5, Build executor safety: a repo whose tree is dirty is refused BEFORE
   * anything is cut, because the epic branch is cut from that tree's branch and
   * `git worktree add` would carry the mess forward.
   */
  private async refuseOnDirtyRepos(): Promise<ExecutorOutcome | null> {
    const seen = new Set<string>();
    for (const planned of this.pendingStories()) {
      const name = planned.story.repo;
      if (seen.has(name)) continue;
      seen.add(name);
      const dir = repoDirOf(this.workspace, name);
      const dirty = await dirtyPaths(dir);
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
    writeFileSync(planned.path, updateStoryFront(readFileSync(planned.path, "utf8"), { status, evidence }), "utf8");
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
      knowledgeBytes: this.ctx.spec.expertKnowledgeBytes,
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
      budgetUsd: this.developerCap(),
      previousAttempt: story.previousAttempt,
    });
  }

  private model(): string | null {
    return this.ctx.model ?? this.ctx.spec.planned.model;
  }

  private repoCommands(repo: string): readonly string[] {
    return this.workspace.repoCommands.get(repo) ?? [];
  }

  /**
   * The developer's share, clamped so the phase cannot be overrun.
   *
   * Measured 2026-08-29: a story's spend was `developer (1/N) + reviewer (0.25/N)`
   * and the whole pipeline could run TWICE (`MAX_ATTEMPTS`), so N stories could
   * charge 2.5x the stage ceiling — the audit's "Build 2.5x su fase". The shares
   * are now divided by that worst case up front, so N stories × 2 attempts ×
   * (dev + reviewer) fits inside the stage budget however the attempts fall.
   */
  private developerCap(): number {
    return this.ctx.agentCap(1 / this.worstCaseShares());
  }

  private reviewerCap(): number {
    return this.ctx.agentCap(REVIEWER_SHARE / this.worstCaseShares());
  }

  /**
   * How many developer-shares the phase can be asked for at worst:
   * `stories × attempts × (1 + REVIEWER_SHARE)`. Dividing by this makes the sum
   * of every cap the executor can hand out ≤ the stage ceiling.
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

  /** How many reviewers have already judged this story, from the ledger. */
  private reviewAttempts(storyId: string): number {
    return this.reviews.get(storyId) ?? countReviews(this.ctx.runDir, storyId);
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

  private storyWorktree(planned: PlannedStory): string {
    return join(this.ctx.root, PROJECT_FRAMEWORK_DIR, WORKTREES, planned.story.repo, planned.story.id);
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

/** Reviewer verdicts already in the ledger for a story — the requeue counter. */
function countReviews(runDir: string, storyId: string): number {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (event.type !== "check.passed" && event.type !== "check.failed") continue;
      if (event.payload?.check === "review" && event.payload.story === storyId) count++;
    } catch {
      // A half-written last line is not a reason to lose the count.
    }
  }
  return count;
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
