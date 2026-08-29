/**
 * `tldrx next` — the facilitator (spec §5).
 *
 * The algorithm in the spec is fifteen lines of pseudocode and this file is its
 * transcription, in order: lock, cursor, gate, answers, skip_if, budget, inputs,
 * prompt, spawn, validate-from-disk, checks, gate-or-advance. The only thing it
 * adds is that BOTH execution modes converge: headless spawns `claude -p` itself,
 * in-session hands the same prompt to the host session and comes back through
 * `--commit`, and from the validation step down there is exactly one code path.
 *
 * Money is never rolled back on failure (spec §5, failure path). A stage that
 * fails keeps its cost, because the API call happened whether we liked it or not.
 */
import { rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { ambiguousRunLines } from "../run/openRuns.ts";
import { RunStore } from "../run/RunStore.ts";
import { isTerminal, type GateType, type RunFile, type RunPhase, type RunStage, type RunTask } from "../run/RunFile.ts";
import { runChecks } from "../run/checks.ts";
import { approve } from "../run/gates.ts";
import { AUTO_GATE_ACTOR, evaluateAutoGate } from "../run/autoGate.ts";
import { gatePolicyFor } from "../run/gatePolicy.ts";
import { PresetError, type PlannedStage } from "../run/workflowPreset.ts";
import { remaining } from "../budget/wouldExceed.ts";
import { raiseCommand, shortBy } from "../budget/budgetView.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { factsPath, loadWorkspace } from "../../hooks/lib/workspace.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { acquireLock, releaseLock } from "./Lock.ts";
import { loadStageSpec, type StageSpec } from "./stageSpec.ts";
import { countSkipInputs, evaluateSkipIf, openQuestionIds, SkipIfError } from "./skipIf.ts";
import { agentDir, expandAll, missing, present, resolveDeclared, type PathContext } from "./paths.ts";
import { buildPrompt, renderConventions, renderFacts, stackExpertNames } from "./prompt.ts";
import {
  describeBundles, loadExpertBundles, untrainedNotes, type ExpertBundleSet,
} from "../experts/expertBundle.ts";
import { spawnAgent } from "./spawnAgent.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { validateOutputs, describeProblems } from "./validateOutputs.ts";
import { executorFor, type ExecutorContext, type ExecutorOutcome, type StageExecutor } from "./executors/index.ts";
import { promptPath, readResult, writeBundle, writeRaw, PendingError, type PendingStage } from "./pending.ts";
import { capInputs, inlineInputs, type InlineResult } from "./seedInputs.ts";
import { SEED_INDEX } from "../seed/renderSeed.ts";

export type NextMode = "headless" | "prepare" | "commit";

export interface NextOptions {
  readonly root: string;
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly mode: NextMode;
  /** `--model`, overriding the stage pin. */
  readonly model?: string;
  /** `--effort`, overriding the stage's `effort:`. Undefined ⇒ the stage decides. */
  readonly effort?: EffortLevel;
  /** `--max-usd`, an extra cap on top of the stage share and per_agent_max_usd. */
  readonly maxUsd?: number;
  readonly yolo: boolean;
  /** `--keep-worktrees`: the Build phase keeps its story worktrees after a story settles. */
  readonly keepWorktrees?: boolean;
  readonly actor: string;
  readonly at: string;
}

export interface NextOutcome {
  readonly code: number;
  readonly lines: readonly string[];
  /**
   * Advisory lines for stderr — never a reason to stop. Today that is the
   * "this expert has no evidence" nudge (§2.6): a stub expert reads exactly like a
   * trained one inside the prompt, so the one place it can be noticed is here.
   * They are kept off `lines` so `--prepare`'s stdout stays a machine-readable
   * instruction for the host session.
   */
  readonly stderr?: readonly string[];
}

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_REFUSED = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_AWAITING_HUMAN = 4;
const EXIT_AGENT_FAILED = 5;

/** Guard against a cursor that will not settle; §2.2 caps a run at 40 stages. */
const MAX_CURSOR_STEPS = 64;

export async function runNext(options: NextOptions): Promise<NextOutcome> {
  const resolution = RunStore.resolve(options.root, options.runId);
  // `next` is the one command that spends money, so it is the one that must never
  // guess. The lines come back unprefixed; `src/cli/commands/next.ts` puts
  // `tldrx next: ` on the first and two spaces on the rest.
  if (resolution.kind === "ambiguous") {
    return out(EXIT_REFUSED, [...ambiguousRunLines(resolution.open)]);
  }
  if (resolution.kind === "none") {
    return out(EXIT_NOT_FOUND, [
      options.runId === undefined
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`,
    ]);
  }
  const store = resolution.store;

  const lock = acquireLock(store.runDir, options.at);
  if (!lock.ok) {
    const holder = lock.holder;
    return out(EXIT_REFUSED, [
      `another next is running — .lock is held by live pid ${String(holder?.pid ?? 0)}` +
        (holder?.at ? ` since ${holder.at}` : ""),
    ]);
  }

  const notes: string[] = [];
  try {
    if (lock.stale) notes.push(...demoteStaleRunning(store, lock.holder?.pid ?? 0));
    return await advance(store, options, notes);
  } finally {
    releaseLock(store.runDir);
  }
}

/**
 * Spec §5 resume path: "a `running` left by a crash is demoted to `ready` when
 * `.lock` holds a dead pid". Nothing else about a stale lock is interesting — the
 * files are the state, and they are all still there.
 */
function demoteStaleRunning(store: RunStore, deadPid: number): readonly string[] {
  const stuck: string[] = [];
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) => {
        if (stage.status !== "running") return stage;
        stuck.push(`${phase.id}/${stage.id}`);
        return { ...stage, status: "ready" as const };
      }),
    })),
  }));
  if (stuck.length === 0) return [`cleared a stale .lock (pid ${String(deadPid)} is not running)`];
  store.save();
  return [
    `cleared a stale .lock (pid ${String(deadPid)} is not running); ` +
      `demoted ${stuck.join(", ")} from running to ready`,
  ];
}

async function advance(store: RunStore, options: NextOptions, notes: string[]): Promise<NextOutcome> {
  for (let step = 0; step < MAX_CURSOR_STEPS; step++) {
    if (store.run.status === "done" || store.run.status === "cancelled") {
      return out(EXIT_OK, [...notes, `run ${store.runId} is ${store.run.status} — nothing to advance`]);
    }
    const entry = store.cursorEntry();
    if (entry === null) {
      return out(EXIT_USAGE, [
        ...notes,
        `cursor ${store.run.cursor.phase}/${store.run.cursor.stage} does not resolve to a stage`,
      ]);
    }
    const phaseId = entry.phase.id;
    const stageId = entry.stage.id;

    // Spec §5, failure path: "`stage.failed` never advances the cursor." Running
    // `next` on a failed stage IS the retry, so it falls through and runs the
    // stage again rather than being walked past.
    //
    // `[assumption]` — for the OTHER terminal statuses the spec's pseudocode never
    // reaches a terminal cursor stage, because `approve` advances it. A `--dry-run`
    // or a rejected-then-skipped stage can, so those the cursor walks forward
    // rather than refusing to move.
    if (isTerminal(entry.stage.status) && entry.stage.status !== "failed") {
      const moved = advanceCursor(store);
      if (moved === null) {
        store.save();
        return out(EXIT_OK, [...notes, `every stage of ${store.runId} is terminal — nothing to advance`]);
      }
      store.save();
      notes.push(`cursor moved past ${phaseId}/${stageId} (${entry.stage.status}) to ${moved.phase}/${moved.stage}`);
      continue;
    }

    if (entry.stage.status === "failed") {
      notes.push(`retrying ${phaseId}/${stageId} (it failed; cost already spent is not refunded)`);
    }

    if (entry.stage.status === "awaiting_gate") {
      return out(EXIT_AWAITING_HUMAN, [...notes, `gate pending: tldrx approve`, `  at ${phaseId}/${stageId}`]);
    }

    if (entry.stage.status === "awaiting_answer") {
      const open = openQuestionIds(join(store.runDir, phaseId, "questions.md"));
      if (open.length > 0) {
        return out(EXIT_AWAITING_HUMAN, [
          ...notes,
          `awaiting answers: ${open.length} open question(s) in ${phaseId}/questions.md (${open.join(", ")})`,
          `  answer with \`tldrx answer ${open[0] ?? "Q1"} "…"\``,
        ]);
      }
      setStatus(store, phaseId, stageId, "ready");
      store.save();
      notes.push(`${phaseId}/${stageId}: every question is answered — back to ready`);
      continue;
    }

    let spec: StageSpec;
    try {
      spec = loadStageSpec(options.root, store.run.scope, stageId);
    } catch (error) {
      if (error instanceof PresetError) return out(EXIT_USAGE, [...notes, error.message]);
      throw error;
    }

    if (spec.skipIf !== null) {
      let holds: boolean;
      try {
        holds = evaluateSkipIf(spec.skipIf, countSkipInputs(store.runDir, store.run));
      } catch (error) {
        if (error instanceof SkipIfError) return out(EXIT_USAGE, [...notes, error.message]);
        throw error;
      }
      if (holds) {
        skipStage(store, options, phaseId, stageId, `skip_if: ${spec.skipIf}`);
        const moved = advanceCursor(store);
        store.save();
        notes.push(`skipped ${phaseId}/${stageId} (skip_if: ${spec.skipIf})`);
        if (moved === null) {
          return out(EXIT_OK, [...notes, `every stage of ${store.runId} is terminal`]);
        }
        continue;
      }
    }

    return await runStage(store, options, phaseId, stageId, spec, notes);
  }
  return out(EXIT_USAGE, [...notes, "the cursor did not settle on a runnable stage"]);
}

async function runStage(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  spec: StageSpec,
  notes: string[],
): Promise<NextOutcome> {
  if (options.dryRun && !spec.dryRunAllowed) {
    return out(EXIT_USAGE, [...notes, `stage '${stageId}' sets dry_run_allowed: false — refusing --dry-run`]);
  }

  // The phase-specific half, when the phase has one (`executors/index.ts`). A
  // phase with no executor keeps the single-agent path below, unchanged.
  const executor = executorFor(phaseId);
  if (executor !== null) return await runExecutor(store, options, phaseId, stageId, spec, notes, executor);

  if (options.mode === "commit") return await commitStage(store, options, phaseId, stageId, spec, notes);

  const stage = requireStage(store, phaseId, stageId);
  const ctx: PathContext = { root: options.root, runDir: store.runDir };

  // --- budget gate (spec §5, §2.11) ---------------------------------------
  const refused = budgetRefusal(store, options, phaseId, stageId, notes);
  if (refused !== null) return refused;

  // --- required inputs (spec §5: exit 1) ----------------------------------
  const required = expandAll(spec.requiredInputs, store.run.repos);
  const gaps = missing(required, ctx);
  if (gaps.length > 0) {
    return out(EXIT_USAGE, [
      ...notes,
      `stage '${stageId}' requires ${gaps.length} input(s) that do not exist: ${gaps.join(", ")}`,
    ]);
  }

  // --- prompt assembly ----------------------------------------------------
  const optional = present(expandAll(spec.optionalInputs, store.run.repos), ctx);
  const seed = seedInputsOf(spec, stage, ctx);
  const inputs = capInputs([
    ...required,
    ...optional.filter((p) => !required.includes(p)),
    ...seed.filter((p) => !required.includes(p) && !optional.includes(p)),
  ]);
  const model = options.model ?? stage.model ?? spec.planned.model;
  const effort = options.effort ?? spec.planned.effort ?? null;
  const cap = agentCap(options, store, stage);
  const assembled = assemblePrompt(store, options, spec, stage, inputs, ctx, new Set(seed));
  const prompt = assembled.prompt;
  // What the experts contributed, said out loud in every mode. Before this was
  // reported, a stage could load three stub experts and nothing on any stream
  // distinguished that from three trained ones.
  notes.push(...describeBundles(assembled.bundles));
  const advisories = untrainedNotes(assembled.bundles);

  const pending: PendingStage = {
    version: 1,
    run: store.runId,
    phase: phaseId,
    stage: stageId,
    expert: stage.expert ?? spec.planned.experts[0] ?? null,
    model,
    effort,
    budget_usd: stage.budget_usd,
    max_budget_usd: cap,
    prompt: relative(store.runDir, promptPath(store.runDir, stageId)),
    outputs: expandAll(spec.planned.outputs, store.run.repos),
    sections: Object.fromEntries(expandedSections(spec.planned, store.run.repos)),
    checks: spec.planned.checks,
    prepared_at: options.at,
    experts: bundleSummary(assembled.bundles),
  };
  writeBundle(store.runDir, stageId, prompt, pending);

  markRunning(store, phaseId, stageId, options.at);
  store.append(event(options, store.runId, stageId, "stage.started", {
    phase: phaseId,
    model,
    budget_usd: stage.budget_usd,
    inputs,
    mode: options.mode,
  }));
  store.save();

  if (options.mode === "prepare") {
    const dir = relative(options.root, agentDir(store.runDir, stageId));
    return out(EXIT_OK, [
      ...notes,
      `prepared ${phaseId}/${stageId} — prompt bundle in ${dir}/ ($${cap.toFixed(2)} agent ceiling, `
        + `model ${model ?? "default"}, effort ${effort ?? "default"})`,
      `dispatch ONE sub-agent with ${dir}/prompt.md; it may write only: ${pending.outputs.join(", ") || "(no declared outputs)"}`,
      `then write {outputs, questions_asked, notes} to ${dir}/result.json and run \`tldrx next --commit\``,
    ], advisories);
  }

  // --- headless spawn -----------------------------------------------------
  const taskId = nextTaskId(store, phaseId, stageId);
  store.append(event(options, store.runId, stageId, "agent.spawned", {
    phase: phaseId,
    task: taskId,
    model,
    effort,
    max_budget_usd: cap,
  }, 0, stage.expert));

  const workspace = loadWorkspace(options.root);
  const agent = await spawnAgent({
    prompt,
    model,
    effort,
    maxBudgetUsd: cap,
    workspaceCommands: [...workspace.commands],
    yolo: options.yolo,
    cwd: options.root,
    timeoutMs: spec.planned.timeout_s * 1000,
  });
  if (agent.raw !== "") writeRaw(store.runDir, stageId, agent.raw);

  recordTask(store, phaseId, stageId, {
    id: taskId,
    status: agent.ok ? "done" : "failed",
    expert: stage.expert ?? spec.planned.experts[0] ?? null,
    model,
    cost_usd: round2(agent.costUsd),
    error: agent.error,
    session_id: agent.sessionId,
    started_at: options.at,
    ended_at: nowish(options),
    outputs: agent.envelope?.outputs ?? [],
  });
  store.append(event(options, store.runId, stageId, "agent.result", {
    phase: phaseId,
    task: taskId,
    session_id: agent.sessionId,
    model,
    effort,
    outputs: agent.envelope?.outputs ?? [],
    usage: { input_tokens: agent.usage.input_tokens, output_tokens: agent.usage.output_tokens },
  }, round2(agent.costUsd), stage.expert));
  store.save();

  if (!agent.ok) {
    return withStderr(
      failStage(store, options, phaseId, stageId, agent.error ?? "the sub-agent failed", notes),
      advisories,
    );
  }
  return withStderr(await finishStage(store, options, phaseId, stageId, spec, notes), advisories);
}

/** Carry advisories out through an outcome another function already built. */
function withStderr(outcome: NextOutcome, stderr: readonly string[]): NextOutcome {
  if (stderr.length === 0) return outcome;
  return { ...outcome, stderr: [...(outcome.stderr ?? []), ...stderr] };
}

/** The `experts:` block of `pending.json` — what loaded, why, and how many bytes. */
function bundleSummary(set: ExpertBundleSet): PendingStage["experts"] {
  return set.experts.map((expert) => ({
    name: expert.name,
    reason: expert.reason,
    ...(expert.match === undefined ? {} : { match: expert.match }),
    expert_md_bytes: expert.bodyBytes,
    knowledge_bytes: expert.knowledgeBytes,
    knowledge_files: expert.files.map((file) => file.path),
    truncated: expert.truncated,
  }));
}

/**
 * Spec §5, §2.11: refuse a stage the phase budget cannot cover, and warn once when
 * the phase is past `warn_at_pct`. Non-null means refuse with that outcome.
 *
 * `[assumption]` — the stage ceiling compared against is run.yml's, not
 * stage.yml's: `run new` scales every stage budget to the run's `--budget`, and
 * budget.yml's phase ceilings are scaled the same way. Comparing a scaled ceiling
 * against an unscaled stage file would refuse work it can afford.
 */
function budgetRefusal(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  notes: string[],
): NextOutcome | null {
  const stage = requireStage(store, phaseId, stageId);
  const phaseRemaining = remaining(store.budget, phaseId);
  if (phaseRemaining < stage.budget_usd && store.budget.on_exceed === "block") {
    store.append(event(options, store.runId, stageId, "budget.blocked", {
      phase: phaseId,
      remaining_usd: phaseRemaining,
      estimate_usd: stage.budget_usd,
      ceiling_usd: store.budget.phases.find((p) => p.id === phaseId)?.ceiling_usd ?? store.budget.ceiling_usd,
    }));
    // Name the command, not the field. The pilot's hand-edit of `ceiling_usd`
    // under-shot the estimate and the retry was refused a second time.
    const fix = raiseCommand(store.runId, phaseId, shortBy(stage.budget_usd, phaseRemaining));
    return out(EXIT_REFUSED, [
      ...notes,
      `[tldrx] budget: refusing to start stage "${stageId}" — phase ${phaseId} has ` +
        `$${phaseRemaining.toFixed(2)} left and the stage estimate is $${stage.budget_usd.toFixed(2)}.`,
      `Run \`${fix}\` (add \`--take-from <phase>\` to move the money instead of adding it), ` +
        `lower budget_usd in the stage, or set on_exceed: warn.`,
      `See the whole picture first: \`tldrx budget show --run ${store.runId}\`.`,
    ]);
  }
  warnOnce(store, options, phaseId, stageId, stage.budget_usd, phaseRemaining, notes);
  return null;
}

/**
 * A phase that owns its own middle (`executors/index.ts`).
 *
 * Everything either side stays here: the budget gate, the required inputs, the
 * `running` stamp, `run.yml`'s tasks, the declared outputs re-read off disk, the
 * checks and the gate. The executor gets the step between "the stage may run" and
 * "here is what it produced", and nothing else — an executor that could move the
 * cursor would be a second facilitator.
 */
async function runExecutor(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  spec: StageSpec,
  notes: string[],
  executor: StageExecutor,
): Promise<NextOutcome> {
  const ctx: PathContext = { root: options.root, runDir: store.runDir };

  // A stage already `running` is mid-pipeline — a Build phase hands out one story
  // per `--prepare`/`--commit` cycle — and re-charging the whole stage estimate
  // against a phase it has already spent from would refuse the second cycle every
  // time. Measured on the in-session fixture: cycle 2 refused with $7.60 of $8.00.
  const started = requireStage(store, phaseId, stageId).status === "running";
  if (options.mode !== "commit" && !started) {
    const refused = budgetRefusal(store, options, phaseId, stageId, notes);
    if (refused !== null) return refused;
  }
  if (options.mode !== "commit") {
    const gaps = missing(expandAll(spec.requiredInputs, store.run.repos), ctx);
    if (gaps.length > 0) {
      return out(EXIT_USAGE, [
        ...notes,
        `stage '${stageId}' requires ${gaps.length} input(s) that do not exist: ${gaps.join(", ")}`,
      ]);
    }
  }

  const model = options.model ?? requireStage(store, phaseId, stageId).model ?? spec.planned.model;
  const effort = options.effort ?? spec.planned.effort ?? null;
  if (!started) {
    markRunning(store, phaseId, stageId, options.at);
    store.append(event(options, store.runId, stageId, "stage.started", {
      phase: phaseId,
      model,
      effort,
      budget_usd: requireStage(store, phaseId, stageId).budget_usd,
      mode: options.mode,
      executor: phaseId,
    }));
    store.save();
  }

  const stage = requireStage(store, phaseId, stageId);
  const executorCtx: ExecutorContext = {
    root: options.root,
    runId: store.runId,
    runDir: store.runDir,
    phaseId,
    stageId,
    spec,
    repos: store.run.repos,
    mode: options.mode,
    model,
    effort,
    budgetUsd: stage.budget_usd,
    maxBudgetUsd: agentCap(options, store, stage),
    yolo: options.yolo,
    at: options.at,
    keepWorktrees: options.keepWorktrees === true,
    agentCap: (share = 1) => agentCap(options, store, stage, share),
    emit: (type, payload, costUsd = 0, actor = null) => {
      store.append(event(options, store.runId, stageId, type, payload, costUsd, actor));
    },
  };

  const outcome = await executor(executorCtx);
  recordExecutorTasks(store, options, phaseId, stageId, spec, outcome);
  store.save();

  // A refusal is a precondition the operator can fix (spec §3 exit 2), not a
  // failure: the stage goes back to `ready` so the next run picks it up cleanly.
  if (outcome.refused === true) {
    setStatus(store, phaseId, stageId, "ready");
    store.save();
    return out(EXIT_REFUSED, [...notes, ...outcome.lines]);
  }
  if (!outcome.ok) {
    return failStage(store, options, phaseId, stageId, outcome.error ?? "the executor failed", notes);
  }
  if (outcome.awaiting) return out(EXIT_OK, [...notes, ...outcome.lines]);
  return await finishStage(store, options, phaseId, stageId, spec, [...notes, ...outcome.lines], outcome.gate);
}

/** One `run.yml` task and one `agent.result` per sub-agent the executor ran. */
function recordExecutorTasks(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  spec: StageSpec,
  outcome: ExecutorOutcome,
): void {
  for (const task of outcome.tasks) {
    const id = nextTaskId(store, phaseId, stageId);
    recordTask(store, phaseId, stageId, {
      id,
      status: task.error === null ? "done" : "failed",
      expert: spec.planned.experts[0] ?? null,
      model: task.model,
      cost_usd: round2(task.costUsd),
      error: task.error,
      session_id: task.sessionId,
      started_at: options.at,
      ended_at: nowish(options),
      outputs: task.outputs,
    });
    store.append(event(options, store.runId, stageId, "agent.result", {
      phase: phaseId,
      task: id,
      key: task.key,
      session_id: task.sessionId,
      model: task.model,
      effort: options.effort ?? spec.planned.effort ?? null,
      outputs: task.outputs,
    }, round2(task.costUsd)));
  }
}

async function commitStage(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  spec: StageSpec,
  notes: string[],
): Promise<NextOutcome> {
  const stage = requireStage(store, phaseId, stageId);
  if (stage.status !== "running") {
    return out(EXIT_USAGE, [
      ...notes,
      `${phaseId}/${stageId} is \`${stage.status}\`, not \`running\` — run \`tldrx next --prepare\` first`,
    ]);
  }
  let result;
  try {
    result = readResult(store.runDir, stageId);
  } catch (error) {
    if (error instanceof PendingError) return out(EXIT_USAGE, [...notes, error.message]);
    throw error;
  }

  const taskId = nextTaskId(store, phaseId, stageId);
  recordTask(store, phaseId, stageId, {
    id: taskId,
    status: "done",
    expert: stage.expert ?? spec.planned.experts[0] ?? null,
    model: options.model ?? stage.model ?? spec.planned.model,
    cost_usd: round2(result.cost_usd ?? 0),
    error: null,
    session_id: result.session_id,
    started_at: stage.started_at ?? options.at,
    ended_at: options.at,
    outputs: result.outputs,
  });
  store.append(event(options, store.runId, stageId, "agent.result", {
    phase: phaseId,
    task: taskId,
    session_id: result.session_id,
    model: options.model ?? stage.model ?? spec.planned.model,
    effort: options.effort ?? spec.planned.effort ?? null,
    outputs: result.outputs,
    mode: "in-session",
  }, round2(result.cost_usd ?? 0), stage.expert));
  store.save();

  return await finishStage(store, options, phaseId, stageId, spec, notes);
}

/**
 * Everything after the sub-agent, shared by both modes: outputs re-read from
 * disk, the stage's checks re-run, then dry-run / gate / advance.
 */
async function finishStage(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  spec: StageSpec,
  notes: string[],
  gateOverride?: GateType,
): Promise<NextOutcome> {
  const ctx: PathContext = { root: options.root, runDir: store.runDir };
  const outputs = expandAll(spec.planned.outputs, store.run.repos);

  const problems = validateOutputs(outputs, expandedSections(spec.planned, store.run.repos), ctx);
  if (problems.length > 0) {
    return failStage(store, options, phaseId, stageId, describeProblems(problems), notes);
  }

  const checks = await runChecks(spec.planned.checks, {
    root: options.root,
    runDir: store.runDir,
    stage: spec.planned,
  });
  for (const check of checks) {
    store.append(event(options, store.runId, stageId, check.status === "failed" ? "check.failed" : "check.passed", {
      phase: phaseId,
      check: check.id,
      status: check.status,
      detail: check.detail,
    }));
  }
  const failed = checks.find((c) => c.status === "failed");
  if (failed !== undefined) {
    store.save();
    return failStage(store, options, phaseId, stageId, `check \`${failed.id}\` failed: ${failed.detail}`, notes);
  }
  const checkSummary = checks.length === 0 ? "no checks declared" : checks.map((c) => `${c.id}:${c.status}`).join(", ");

  // --- dry run (spec §5: keep the handoff, skip the stage) -----------------
  if (options.dryRun) {
    const dropped = revertNonHandoff(outputs, ctx);
    skipStage(store, options, phaseId, stageId, "dry run");
    store.save();
    return out(EXIT_OK, [
      ...notes,
      `dry run: ${phaseId}/${stageId} skipped after producing its handoff (${checkSummary})`,
      dropped.length === 0 ? "no non-handoff outputs to revert" : `reverted ${dropped.join(", ")}`,
    ]);
  }

  // --- gate or advance -----------------------------------------------------
  const stage = requireStage(store, phaseId, stageId);
  const spent = round2(stage.tasks.reduce((sum, t) => sum + t.cost_usd, 0));

  // An executor may FORCE a human gate whatever the stage file says. Build does:
  // concept §9 ends it at "epic merges to main after integration tests + human
  // gate", and a stage file spelling `gate: auto` would otherwise let a run walk
  // past the one decision a person has to make.
  if ((gateOverride ?? spec.planned.gateType) === "approve") {
    mapStage(store, phaseId, stageId, (s) => ({
      ...s,
      status: "awaiting_gate",
      ended_at: nowish(options),
      gate: { ...s.gate, type: "approve", status: "pending" },
    }));
    store.append(event(options, store.runId, stageId, "gate.requested", {
      phase: phaseId,
      cost_usd: spent,
      outputs,
      checks: checks.map((c) => `${c.id}:${c.status}`),
    }));
    store.save();
    const doneLine =
      `${phaseId}/${stageId} done — $${spent.toFixed(2)} of $${stage.budget_usd.toFixed(2)} (${checkSummary})`;

    // The gate is now REQUESTED either way. Who closes it is the policy's call —
    // and an `auto` policy only closes it when all five §5 conditions hold.
    if (gatePolicyFor(store.run.gates_policy, stageId) === "auto") {
      const verdict = await evaluateAutoGate({
        root: options.root,
        runDir: store.runDir,
        phaseId,
        stage: requireStage(store, phaseId, stageId),
        planned: spec.planned,
        budget: store.budget,
        checks,
      });
      let why = verdict.why;
      if (verdict.ok) {
        // Through the SAME door a person uses: `approve` re-runs the checks off
        // disk, records `by`/`at`/`note`, appends gate.approved + stage.done and
        // advances the cursor. A refusal there is a refusal here.
        const approved = await approve(store, {
          root: options.root,
          actor: AUTO_GATE_ACTOR,
          at: nowish(options),
          note: verdict.note,
        });
        if (approved.ok) {
          return out(EXIT_OK, [
            ...notes,
            `${doneLine} · auto-approved`,
            `  ${verdict.note}`,
            approved.advancedTo === null
              ? `run ${store.runId} is finished`
              : `cursor → ${approved.advancedTo.phase}/${approved.advancedTo.stage} (ready)`,
          ]);
        }
        why = `approve re-ran the checks and \`${approved.failed?.id ?? "unknown"}\` failed: `
          + `${approved.failed?.detail ?? ""}`;
      }
      return out(EXIT_AWAITING_HUMAN, [
        ...notes,
        doneLine,
        `auto gate not taken — ${why}`,
        `gate pending: tldrx approve`,
      ]);
    }
    return out(EXIT_AWAITING_HUMAN, [...notes, doneLine, `gate pending: tldrx approve`]);
  }

  mapStage(store, phaseId, stageId, (s) => ({
    ...s,
    status: "done",
    ended_at: nowish(options),
    gate: { ...s.gate, status: s.gate.type === "approve" ? s.gate.status : "n-a" },
  }));
  const moved = advanceCursor(store);
  store.append(event(options, store.runId, stageId, "stage.done", {
    phase: phaseId,
    cost_usd: spent,
    outputs,
    checks: checks.map((c) => `${c.id}:${c.status}`),
  }));
  store.save();
  if (store.run.status === "done") {
    store.append(event(options, store.runId, null, "run.closed", { reason: "every stage terminal" }));
  }
  return out(EXIT_OK, [
    ...notes,
    `${phaseId}/${stageId} done — $${spent.toFixed(2)} of $${stage.budget_usd.toFixed(2)} (${checkSummary})`,
    moved === null ? `run ${store.runId} is finished` : `cursor → ${moved.phase}/${moved.stage} (ready)`,
  ]);
}

function failStage(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  reason: string,
  notes: readonly string[],
): NextOutcome {
  mapStage(store, phaseId, stageId, (stage) => ({
    ...stage,
    status: "failed",
    ended_at: nowish(options),
    tasks: stage.tasks.map((task, i) =>
      i === stage.tasks.length - 1 ? { ...task, status: "failed" as const, error: task.error ?? oneLine(reason) } : task,
    ),
  }));
  store.append(event(options, store.runId, stageId, "stage.failed", { phase: phaseId, reason: oneLine(reason) }));
  store.save();
  return out(EXIT_AGENT_FAILED, [
    ...notes,
    `${phaseId}/${stageId} failed: ${oneLine(reason)}`,
    `cost is recorded, not refunded — retry with \`tldrx next\`, or \`tldrx reject --note "…"\``,
  ]);
}

// --- prompt ----------------------------------------------------------------

/**
 * The run's seed documents for a stage that asked for them (`inputs.seed: true`).
 *
 * They are the entries `run new --seed` added to THIS stage's `inputs` in
 * `run.yml` — everything the stage file does not already declare. Reading them
 * off `run.yml` rather than `stage.yml` is the whole point: the stage says "I take
 * the seed", the run says what the seed was.
 */
function seedInputsOf(spec: StageSpec, stage: RunStage, ctx: PathContext): readonly string[] {
  if (!spec.seedInputs) return [];
  const fromStageFile = new Set([...spec.requiredInputs, ...spec.optionalInputs]);
  return present(stage.inputs.filter((entry) => !fromStageFile.has(entry)), ctx);
}

/** `inlineInputs` speaks `{inputs, note}`; `buildPrompt` speaks `{inputs, inputsNote}`. */
function withNote(result: InlineResult): { inputs: InlineResult["inputs"]; inputsNote?: string } {
  return result.note === null ? { inputs: result.inputs } : { inputs: result.inputs, inputsNote: result.note };
}

interface AssembledPrompt {
  readonly prompt: string;
  readonly bundles: ExpertBundleSet;
}

function assemblePrompt(
  store: RunStore,
  options: NextOptions,
  spec: StageSpec,
  stage: RunStage,
  inputs: readonly string[],
  ctx: PathContext,
  seed: ReadonlySet<string>,
): AssembledPrompt {
  const stageMd = readStageMd(spec.planned);
  const facts = FactsStore.loadOrEmpty(factsPath(options.root));
  // The declared inputs ARE the run's cited paths at this point: they are what the
  // seed put on the stage and what the stage file names, and nothing else has been
  // read yet. A domain expert whose folder holds one of them ranks first.
  const bundles = loadExpertBundles({
    root: options.root,
    staged: spec.planned.experts,
    repos: store.run.repos,
    stackExperts: spec.stackExperts,
    stackNames: stackExpertNames(options.root, store.run.repos),
    citedPaths: inputs,
    knowledgeBytes: spec.expertKnowledgeBytes,
  });
  const prompt = buildPrompt({
    stageMd,
    previousAttempt: describePreviousAttempt(stage),
    values: {
      run: store.runId,
      repos: store.run.repos.length === 0 ? "(none)" : store.run.repos.join(", "),
      inputs: inputs.length === 0 ? "(none)" : inputs.map((p) => `- ${p}`).join("\n"),
      facts: renderFacts(facts.facts, store.run.repos),
      conventions: renderConventions(options.root, store.run.repos),
      budget_usd: stage.budget_usd.toFixed(2),
    },
    experts: bundles.experts,
    ...withNote(inlineInputs(inputs, {
      ctx,
      seed,
      exempt: new Set(inputs.filter((path) => path.endsWith(`/${SEED_INDEX}`))),
    })),
  });
  return { prompt, bundles };
}

/**
 * What the last attempt at this stage left behind (spec §5, failure path: the
 * reject note is "fed into the next prompt").
 *
 * Two sources, both already on the stage: the error of its last failed task, and
 * an operator's rejection note. Either one means this is a retry, and the agent
 * is told so rather than being handed the original prompt as if nothing happened.
 */
export function describePreviousAttempt(stage: RunStage): string {
  const lines: string[] = [];
  const failure = [...stage.tasks].reverse().find((task) => task.error !== null)?.error ?? null;
  if (failure !== null && failure.trim() !== "") {
    lines.push(`The previous attempt at this stage FAILED: ${failure.trim()}`);
  }
  if (stage.gate.status === "rejected" && stage.gate.note.trim() !== "") {
    if (lines.length > 0) lines.push("");
    lines.push(
      "A human rejected the previous attempt. Their note is the primary instruction for this one:",
      "",
      ...stage.gate.note.trim().split("\n").map((line) => `> ${line}`),
    );
  }
  if (lines.length === 0) return "";
  lines.push("", "Fix what is described above. Everything else in this prompt still applies.");
  return lines.join("\n");
}

/** `stage.md` sits beside the `stage.yml` the preset resolved. */
function readStageMd(planned: PlannedStage): string {
  const path = planned.source.replace(/stage\.yml$/, "stage.md");
  return readOrEmpty(path);
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// --- run.yml mutation ------------------------------------------------------

function requireStage(store: RunStore, phaseId: string, stageId: string): RunStage {
  const phase = store.run.phases.find((p) => p.id === phaseId);
  const stage = phase?.stages.find((s) => s.id === stageId);
  if (stage === undefined) throw new Error(`no stage ${phaseId}/${stageId} in run.yml`);
  return stage;
}

function mapStage(
  store: RunStore,
  phaseId: string,
  stageId: string,
  fn: (stage: RunStage) => RunStage,
): void {
  store.mutate((run: RunFile) => ({
    ...run,
    phases: run.phases.map((phase: RunPhase) =>
      phase.id !== phaseId
        ? phase
        : { ...phase, stages: phase.stages.map((stage) => (stage.id === stageId ? fn(stage) : stage)) },
    ),
  }));
}

function setStatus(store: RunStore, phaseId: string, stageId: string, status: RunStage["status"]): void {
  mapStage(store, phaseId, stageId, (stage) => ({ ...stage, status }));
}

function markRunning(store: RunStore, phaseId: string, stageId: string, at: string): void {
  mapStage(store, phaseId, stageId, (stage) => ({
    ...stage,
    status: "running",
    started_at: stage.started_at ?? at,
    ended_at: null,
  }));
}

function skipStage(store: RunStore, options: NextOptions, phaseId: string, stageId: string, reason: string): void {
  mapStage(store, phaseId, stageId, (stage) => ({
    ...stage,
    status: "skipped",
    ended_at: nowish(options),
    gate: { ...stage.gate, status: "n-a" },
  }));
  store.append(event(options, store.runId, stageId, "stage.skipped", { phase: phaseId, reason }));
}

function recordTask(store: RunStore, phaseId: string, stageId: string, task: RunTask): void {
  mapStage(store, phaseId, stageId, (stage) => ({ ...stage, tasks: [...stage.tasks, task] }));
}

function nextTaskId(store: RunStore, phaseId: string, stageId: string): string {
  return `t${String(requireStage(store, phaseId, stageId).tasks.length + 1)}`;
}

/** Move the cursor to the stage after the current one, marking it ready. */
function advanceCursor(store: RunStore): { phase: string; stage: string } | null {
  const next = store.nextEntry();
  if (next === null) return null;
  store.mutate((run) => ({
    ...run,
    cursor: { phase: next.phase.id, stage: next.stage.id, task: null },
    phases: run.phases.map((phase) =>
      phase.id !== next.phase.id
        ? phase
        : {
            ...phase,
            stages: phase.stages.map((stage) =>
              stage.id === next.stage.id && stage.status === "pending" ? { ...stage, status: "ready" } : stage,
            ),
          },
    ),
  }));
  return { phase: next.phase.id, stage: next.stage.id };
}

// --- odds and ends ---------------------------------------------------------

/**
 * `min(task share, per_agent_max_usd)` (spec §5), with `--max-usd` on top.
 *
 * `share` is the fraction of the stage budget ONE sub-agent gets: 1 for a stage
 * that spawns one (spec §5 decision (c): "v0 runs tasks sequentially"), `1/n` for
 * an executor that splits the stage — Build, between the stories of `waves.yml`.
 */
function agentCap(options: NextOptions, store: RunStore, stage: RunStage, share = 1): number {
  const candidates = [stage.budget_usd * share, store.budget.per_agent_max_usd];
  if (options.maxUsd !== undefined) candidates.push(options.maxUsd);
  return round2(Math.min(...candidates));
}

/** Output paths whose `{repo}` token has been expanded, keyed to their sections. */
function expandedSections(planned: PlannedStage, repos: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const [declared, sections] of planned.sections) {
    for (const path of expandAll([declared], repos)) map.set(path, sections);
  }
  return map;
}

/** Spec §5 `--dry-run`: "revert non-handoff outputs". */
function revertNonHandoff(outputs: readonly string[], ctx: PathContext): readonly string[] {
  const dropped: string[] = [];
  for (const declared of outputs) {
    if (declared.endsWith("handoff.md")) continue;
    rmSync(resolveDeclared(declared, ctx), { force: true });
    dropped.push(declared);
  }
  return dropped;
}

/** Spec §2.11 `warn_at_pct`: "emits `budget.warned` once per phase". */
function warnOnce(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  estimate: number,
  phaseRemaining: number,
  notes: string[],
): void {
  const phase = store.budget.phases.find((p) => p.id === phaseId);
  if (phase === undefined || phase.ceiling_usd <= 0) return;
  // Actuals, not projections: a phase whose ceiling equals the sum of its own
  // stage budgets would otherwise warn on the very first stage, every time.
  const pct = (phase.spent_usd / phase.ceiling_usd) * 100;
  if (pct < store.budget.warn_at_pct) return;
  if (alreadyWarned(store, phaseId)) return;
  store.append(event(options, store.runId, stageId, "budget.warned", {
    phase: phaseId,
    spent_usd: phase.spent_usd,
    estimate_usd: estimate,
    ceiling_usd: phase.ceiling_usd,
    pct: Math.round(pct),
  }));
  notes.push(
    `budget: phase ${phaseId} is at ${String(Math.round(pct))}% of its $${phase.ceiling_usd.toFixed(2)} ceiling ` +
      `after this stage ($${phaseRemaining.toFixed(2)} left before it)`,
  );
}

function alreadyWarned(store: RunStore, phaseId: string): boolean {
  try {
    return store.events
      .read()
      .some((e) => e.type === "budget.warned" && (e.payload as { phase?: unknown }).phase === phaseId);
  } catch {
    return false;
  }
}

function event(
  options: NextOptions,
  run: string,
  stage: string | null,
  type: TldrxEvent["type"],
  payload: Record<string, unknown>,
  cost = 0,
  actor?: string | null,
): TldrxEvent {
  return {
    ts: nowish(options),
    run,
    stage,
    type,
    actor: actor ?? "facilitator",
    cost_usd: cost,
    payload,
  };
}

/**
 * `[assumption]` — events must be non-decreasing in `ts` (spec §2.9) and a single
 * `next` can span minutes, so the clock is read live rather than frozen at
 * `options.at`. `options.at` remains the lock/started_at stamp.
 */
function nowish(options: NextOptions): string {
  const now = `${new Date().toISOString().slice(0, 19)}Z`;
  return now < options.at ? options.at : now;
}

function oneLine(text: string, max = 220): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function out(code: number, lines: readonly string[], stderr: readonly string[] = []): NextOutcome {
  return stderr.length === 0 ? { code, lines } : { code, lines, stderr };
}
