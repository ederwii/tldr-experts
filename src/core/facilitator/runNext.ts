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
import { RunStore } from "../run/RunStore.ts";
import { isTerminal, type RunFile, type RunPhase, type RunStage, type RunTask } from "../run/RunFile.ts";
import { runChecks } from "../run/checks.ts";
import { PresetError, type PlannedStage } from "../run/workflowPreset.ts";
import { remaining } from "../budget/wouldExceed.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { factsPath, loadWorkspace } from "../../hooks/lib/workspace.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { acquireLock, releaseLock } from "./Lock.ts";
import { loadStageSpec, type StageSpec } from "./stageSpec.ts";
import { countSkipInputs, evaluateSkipIf, openQuestionIds, SkipIfError } from "./skipIf.ts";
import { agentDir, expandAll, missing, present, resolveDeclared, type PathContext } from "./paths.ts";
import {
  buildPrompt, loadExpertBodies, renderConventions, renderFacts, stackExpertNames,
} from "./prompt.ts";
import { spawnAgent } from "./spawnAgent.ts";
import { validateOutputs, describeProblems } from "./validateOutputs.ts";
import { promptPath, readResult, writeBundle, writeRaw, PendingError, type PendingStage } from "./pending.ts";

export type NextMode = "headless" | "prepare" | "commit";

export interface NextOptions {
  readonly root: string;
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly mode: NextMode;
  /** `--model`, overriding the stage pin. */
  readonly model?: string;
  /** `--max-usd`, an extra cap on top of the stage share and per_agent_max_usd. */
  readonly maxUsd?: number;
  readonly yolo: boolean;
  readonly actor: string;
  readonly at: string;
}

export interface NextOutcome {
  readonly code: number;
  readonly lines: readonly string[];
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
  const store = RunStore.find(options.root, options.runId);
  if (store === null) {
    return out(EXIT_NOT_FOUND, [
      options.runId === undefined
        ? `no non-terminal run in ${PROJECT_WORK_DIR}/`
        : `no run '${options.runId}' in ${PROJECT_WORK_DIR}/`,
    ]);
  }

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
  if (options.mode === "commit") return await commitStage(store, options, phaseId, stageId, spec, notes);

  if (options.dryRun && !spec.dryRunAllowed) {
    return out(EXIT_USAGE, [...notes, `stage '${stageId}' sets dry_run_allowed: false — refusing --dry-run`]);
  }

  const stage = requireStage(store, phaseId, stageId);
  const ctx: PathContext = { root: options.root, runDir: store.runDir };

  // --- budget gate (spec §5, §2.11) ---------------------------------------
  // `[assumption]` — the stage ceiling compared against is run.yml's, not
  // stage.yml's: `run new` scales every stage budget to the run's `--budget`, and
  // budget.yml's phase ceilings are scaled the same way. Comparing a scaled
  // ceiling against an unscaled stage file would refuse work it can afford.
  const phaseRemaining = remaining(store.budget, phaseId);
  if (phaseRemaining < stage.budget_usd && store.budget.on_exceed === "block") {
    store.append(event(options, store.runId, stageId, "budget.blocked", {
      phase: phaseId,
      remaining_usd: phaseRemaining,
      estimate_usd: stage.budget_usd,
      ceiling_usd: store.budget.phases.find((p) => p.id === phaseId)?.ceiling_usd ?? store.budget.ceiling_usd,
    }));
    return out(EXIT_REFUSED, [
      ...notes,
      `[tldrx] budget: refusing to start stage "${stageId}" — phase ${phaseId} has ` +
        `$${phaseRemaining.toFixed(2)} left and the stage estimate is $${stage.budget_usd.toFixed(2)}.`,
      `Raise phases[${phaseId}].ceiling_usd in budget.yml, lower budget_usd in the stage, or set on_exceed: warn.`,
    ]);
  }
  warnOnce(store, options, phaseId, stageId, stage.budget_usd, phaseRemaining, notes);

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
  const inputs = [...required, ...optional.filter((p) => !required.includes(p))];
  const model = options.model ?? stage.model ?? spec.planned.model;
  const cap = agentCap(options, store, stage);
  const prompt = assemblePrompt(store, options, spec, stage, inputs, ctx);

  const pending: PendingStage = {
    version: 1,
    run: store.runId,
    phase: phaseId,
    stage: stageId,
    expert: stage.expert ?? spec.planned.experts[0] ?? null,
    model,
    budget_usd: stage.budget_usd,
    max_budget_usd: cap,
    prompt: relative(store.runDir, promptPath(store.runDir, stageId)),
    outputs: expandAll(spec.planned.outputs, store.run.repos),
    sections: Object.fromEntries(expandedSections(spec.planned, store.run.repos)),
    checks: spec.planned.checks,
    prepared_at: options.at,
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
      `prepared ${phaseId}/${stageId} — prompt bundle in ${dir}/ ($${cap.toFixed(2)} agent ceiling, model ${model ?? "default"})`,
      `dispatch ONE sub-agent with ${dir}/prompt.md; it may write only: ${pending.outputs.join(", ") || "(no declared outputs)"}`,
      `then write {outputs, questions_asked, notes} to ${dir}/result.json and run \`tldrx next --commit\``,
    ]);
  }

  // --- headless spawn -----------------------------------------------------
  const taskId = nextTaskId(store, phaseId, stageId);
  store.append(event(options, store.runId, stageId, "agent.spawned", {
    phase: phaseId,
    task: taskId,
    model,
    max_budget_usd: cap,
  }, 0, stage.expert));

  const workspace = loadWorkspace(options.root);
  const agent = await spawnAgent({
    prompt,
    model,
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
    outputs: agent.envelope?.outputs ?? [],
    usage: { input_tokens: agent.usage.input_tokens, output_tokens: agent.usage.output_tokens },
  }, round2(agent.costUsd), stage.expert));
  store.save();

  if (!agent.ok) {
    return failStage(store, options, phaseId, stageId, agent.error ?? "the sub-agent failed", notes);
  }
  return await finishStage(store, options, phaseId, stageId, spec, notes);
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

  if (spec.planned.gateType === "approve") {
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
    return out(EXIT_AWAITING_HUMAN, [
      ...notes,
      `${phaseId}/${stageId} done — $${spent.toFixed(2)} of $${stage.budget_usd.toFixed(2)} (${checkSummary})`,
      `gate pending: tldrx approve`,
    ]);
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

function assemblePrompt(
  store: RunStore,
  options: NextOptions,
  spec: StageSpec,
  stage: RunStage,
  inputs: readonly string[],
  ctx: PathContext,
): string {
  const stageMd = readStageMd(spec.planned);
  const facts = FactsStore.loadOrEmpty(factsPath(options.root));
  const expertNames = [
    ...spec.planned.experts,
    ...(spec.stackExperts ? stackExpertNames(options.root, store.run.repos) : []),
  ];
  return buildPrompt({
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
    experts: loadExpertBodies(options.root, expertNames),
    inputs: inputs.map((path) => ({ path, content: readOrEmpty(resolveDeclared(path, ctx)) })),
  });
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

/** `min(task share, per_agent_max_usd)` (spec §5), with `--max-usd` on top. */
function agentCap(options: NextOptions, store: RunStore, stage: RunStage): number {
  // `[assumption]` — v0 runs ONE task per stage (spec §5 decision (c): "v0 runs
  // tasks sequentially"), so the task share is the whole stage budget.
  const candidates = [stage.budget_usd, store.budget.per_agent_max_usd];
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

function out(code: number, lines: readonly string[]): NextOutcome {
  return { code, lines };
}
