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
import { AUTO_GATE_ACTOR, evaluateAutoGate, unreadableHeadings } from "../run/autoGate.ts";
import { gatePolicyFor } from "../run/gatePolicy.ts";
import { PresetError, type PlannedStage } from "../run/workflowPreset.ts";
import { isHostTokens } from "../budget/RunBudget.ts";
import { remaining } from "../budget/wouldExceed.ts";
import { raiseCommand, shortBy } from "../budget/budgetView.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { factsPath, loadWorkspace } from "../../hooks/lib/workspace.ts";
import type { TldrxEvent } from "../events/Event.ts";
import { setProgressCeiling, setProgressReadCap, setProgressTitle } from "../ui/bus.ts";
import { acquireLock, releaseLock } from "./Lock.ts";
import { onInterrupt, stopInFlightRun } from "./interrupt.ts";
import { loadStageSpec, type StageSpec } from "./stageSpec.ts";
import { countSkipInputs, evaluateSkipIf, openQuestionIds, SkipIfError } from "./skipIf.ts";
import {
  agentDir, expandAll, expandPatterns, missing, present, resolveMany, type PathContext,
} from "./paths.ts";
import { fenceFor, renderConventions, renderFacts, renderParts, stackExpertNames } from "./prompt.ts";
import {
  describeBundles, loadExpertBundles, untrainedNotes, type ExpertBundleSet,
} from "../experts/expertBundle.ts";
import { nearbyPathsFor } from "../experts/domainRank.ts";
import { spawnAgent } from "./spawnAgent.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { validateOutputs, describeProblems } from "./validateOutputs.ts";
import { executorFor, type ExecutorContext, type ExecutorOutcome, type StageExecutor } from "./executors/index.ts";
import { planIsSkipped, satisfiedByImplicitPlan } from "../build/implicitPlan.ts";
import { promptPath, readResult, writeBundle, writeRaw, PendingError, type PendingStage } from "./pending.ts";
import { preparedBundles, PENDING_JSON } from "../run/prepared.ts";
import { capInputs, describeTruncatedInputs, inlineInputs, type InlineResult } from "./seedInputs.ts";
import {
  buildLedger, questionsBytesOf, renderContextWarning, renderLedger, renderRefusal,
  type ContextLedger,
} from "./contextLedger.ts";
import { byteLength } from "../experts/expertKnowledge.ts";
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
  /** `--prompt-max-bytes`, overriding the stage's `prompt_max_bytes` for one run. */
  readonly promptMaxBytes?: number;
  /** `--max-reads`, overriding the stage's `max_reads` for one run. */
  readonly maxReads?: number;
  /**
   * `--commit --cost-usd <n>` — what the host session's sub-agent actually cost.
   *
   * The in-session mode has no meter of its own: the turn was billed to the host,
   * and only the host can say what it came to. Given, it is recorded like any
   * other cost; omitted, the task is `cost_usd: null, metered: false`.
   */
  readonly costUsd?: number;
  /** `--commit --tokens <n>` — optional, recorded beside the declared cost. */
  readonly tokens?: number;
  readonly yolo: boolean;
  /** `--keep-worktrees`: the Build phase keeps its story worktrees after a story settles. */
  readonly keepWorktrees?: boolean;
  /**
   * `--discard-pending`: throw away an orphaned `--prepare` bundle and run the
   * stage again. Without it a stage left `running` with a bundle on disk is
   * REFUSED (exit 2) rather than silently re-spawned — see `preparedRefusal`.
   */
  readonly discardPending?: boolean;
  /** `--reuse-epic`: let Build adopt an `epic/<slug>` branch this run did not cut. */
  readonly reuseEpic?: boolean;
  /**
   * `--parallel N`: how many stories of ONE Build wave may run at once.
   * Overrides the workflow's `<stage>: {parallel: N}` and `stage.yml`'s.
   * Undefined ⇒ whatever those say, and 1 if neither does.
   */
  readonly parallel?: number;
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

  // From here until the `finally`, this process owns the run — so from here until
  // the `finally` it is also responsible for what a Ctrl-C leaves behind. The
  // hook kills nothing itself: `src/cli/signals.ts` has already killed the child
  // tree by the time it runs, and this closes the books on what was killed.
  const forget = onInterrupt((context) => stopInFlightRun(store.runDir, context));
  const notes: string[] = [];
  try {
    if (lock.stale) notes.push(...demoteStaleRunning(store, lock.holder?.pid ?? 0));
    const orphaned = preparedRefusal(store, options, notes);
    if (orphaned !== null) return orphaned;
    return await advance(store, options, notes);
  } finally {
    forget();
    releaseLock(store.runDir);
  }
}

/**
 * The one cut with no `.lock` behind it: killed between `--prepare` and
 * `--commit` (2026-08-29 audit, §A).
 *
 * `--prepare` writes the bundle, marks the stage `running` and releases the lock,
 * because the host session — not this process — is going to run the prompt. If
 * that session dies, the run is `running`, nothing holds it, and `tldrx next`
 * used to walk straight past into `runStage` and SPAWN THE STAGE AGAIN, throwing
 * away a sub-agent turn the run has already been billed for.
 *
 * So it refuses, and names all three ways out. `--commit` is exempt: that is the
 * recovery path, not the mistake. `--discard-pending` is the explicit "yes,
 * really, bin it".
 */
function preparedRefusal(store: RunStore, options: NextOptions, notes: string[]): NextOutcome | null {
  if (options.mode === "commit") return null;
  const entry = store.cursorEntry();
  if (entry === null || entry.stage.status !== "running") return null;
  // A phase with an executor stays `running` ACROSS cycles on purpose: the Build
  // executor hands out one story per `--prepare`/`--commit` pair and re-prepares
  // the same stage for the next one (`runExecutor`, `started`). Its bundles are
  // per story and it decides which is live, so this refusal is not ours to make
  // there — applying it broke `--prepare` at story 2 the first time it ran.
  if (executorFor(entry.phase.id) !== null) return null;
  const bundles = preparedBundles(store.runDir, entry.stage.id);
  if (bundles.length === 0) return null;

  const where = relative(options.root, agentDir(store.runDir, entry.stage.id));
  if (options.discardPending === true) {
    for (const dir of bundles) rmSync(join(dir, PENDING_JSON), { force: true });
    setStatus(store, entry.phase.id, entry.stage.id, "ready");
    store.save();
    notes.push(`discarded the --prepare bundle in ${where}/ and demoted ${entry.phase.id}/${entry.stage.id} to ready`);
    return null;
  }
  return out(EXIT_REFUSED, [
    ...notes,
    `${entry.phase.id}/${entry.stage.id} has a --prepare bundle waiting and nothing is holding the run —`,
    `  refusing to run it again: that would discard a sub-agent turn this run has already paid for.`,
    `  finish it:  run ${where}/prompt.md, write ${where}/result.json, then \`tldrx next --commit ${store.runId}\``,
    `  drop it:    \`tldrx reject --run ${store.runId} --note "…"\``,
    `  redo it:    \`tldrx next --discard-pending\` (throws the bundle away and runs the stage again)`,
  ]);
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

  // --- economy gate (spec §2.11, design §E.2) ------------------------------
  // BEFORE the executor, before the prompt, before the budget arithmetic: the
  // first thing checked about a headless invocation is whether the ceiling it is
  // about to spawn under is denominated in money at all.
  const mismatch = economyRefusal(store, options, phaseId, notes);
  if (mismatch !== null) return mismatch;

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
  const seed = seedInputsOf(spec, stage, ctx);
  const inputs = declaredInputsOf(store, spec, stage, ctx);
  const model = options.model ?? stage.model ?? spec.planned.model;
  const effort = options.effort ?? spec.planned.effort ?? null;
  const cap = agentCap(options, store, stage);
  const maxReads = options.maxReads ?? spec.maxReads;
  const assembled = assemblePrompt(store, options, spec, stage, inputs, ctx, new Set(seed));
  const prompt = assembled.prompt;
  // What the experts contributed, said out loud in every mode. Before this was
  // reported, a stage could load three stub experts and nothing on any stream
  // distinguished that from three trained ones.
  notes.push(...describeBundles(assembled.bundles));
  // The context ledger, in every mode: what the prompt is made of, before it is
  // sent. `--prepare` and `--dry-run` also get the per-section breakdown.
  const ledger = assembled.ledger;
  notes.push(...assembled.truncatedNotes);
  if (options.mode === "prepare" || options.dryRun) notes.push(...renderLedger(ledger));

  // --- context gate (spec §5) ---------------------------------------------
  // A refusal, not a warning, and BEFORE the money: over `prompt_max_bytes` the
  // stage does not start. Nothing has been written or spent at this point.
  if (ledger.overLimit) {
    return out(EXIT_REFUSED, [...notes, ...renderRefusal(ledger, stageId)]);
  }
  const advisories = [...untrainedNotes(assembled.bundles), ...renderContextWarning(ledger)];

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
    context: {
      total_bytes: ledger.totalBytes,
      limit_bytes: ledger.limitBytes,
      estimated_tokens: ledger.estimatedTokens,
      stage_bytes: ledger.groups.stage,
      questions_bytes: ledger.groups.questions,
      inputs_bytes: ledger.groups.inputs,
      expert_body_bytes: ledger.groups.expertBodies,
      expert_knowledge_bytes: ledger.groups.expertKnowledge,
      previous_attempt_bytes: ledger.groups.previousAttempt,
      truncated_inputs: ledger.truncatedInputs.map((entry) => entry.path),
    },
    max_reads: maxReads,
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
  // Tell whoever is watching what this turn is. No-op when nobody is.
  announce(store.runId, stageId, taskId, cap, maxReads);
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
    maxReads,
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
    // Null on every ordinary attempt, so run.yml is byte-identical to before
    // unless a cap actually bit. "It ran out of reads" and "it crashed" are
    // different stories and the file has to be able to tell them apart.
    stopped_by: agent.stoppedBy,
  });
  store.append(event(options, store.runId, stageId, "agent.result", {
    phase: phaseId,
    task: taskId,
    session_id: agent.sessionId,
    model,
    effort,
    outputs: agent.envelope?.outputs ?? [],
    reads: agent.reads,
    max_reads: maxReads,
    stopped_by: agent.stoppedBy,
    usage: {
      input_tokens: agent.usage.input_tokens,
      output_tokens: agent.usage.output_tokens,
      cache_creation_input_tokens: agent.usage.cache_creation_input_tokens,
      cache_read_input_tokens: agent.usage.cache_read_input_tokens,
    },
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

/**
 * Merge the epic branches an executor claimed into `run.yml` (`build.epic_branch`).
 *
 * Additive and idempotent. This is what lets the NEXT Build invocation tell an
 * epic branch IT cut from one that was already on the repo — the check that keeps
 * two runs from stacking commits on the same branch.
 */
function claimEpicBranches(store: RunStore, claimed: readonly string[] | undefined): void {
  if (claimed === undefined || claimed.length === 0) return;
  store.mutate((run) => {
    const known = new Set(run.build?.epic_branch ?? []);
    for (const branch of claimed) known.add(branch);
    return { ...run, build: { epic_branch: [...known].sort() } };
  });
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
/**
 * The refusal that would have saved the $9.95 (design §E.2).
 *
 * A phase priced in `host-tokens` carries a number that is NOT dollars — it is a
 * host-session token allowance somebody wrote down for turns this process does
 * not meter. A headless invocation is about to derive `--max-budget-usd` from
 * that number and hand it to a metered `claude -p`. On
 * `260830-tenancy-identity-customers` that is exactly what happened, six times,
 * and six spawns died on `Reached maximum budget` having each spent real money
 * reaching it.
 *
 * So it refuses, exit 2, here — before the executor, before prompt assembly,
 * before a byte is written and before a cent is spent. `--prepare` and
 * `--commit` are untouched: those are the in-session paths, where the host holds
 * the meter and the token figure means what it says.
 *
 * The economy is never CONVERTED. There is no exchange rate between a metered
 * dollar and a host token, and inventing one would be a guess about a price —
 * which is the whole reason the label exists.
 */
function economyRefusal(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  notes: string[],
): NextOutcome | null {
  if (options.mode !== "headless") return null;
  if (!isHostTokens(store.budget, phaseId)) return null;
  const phase = store.budget.phases.find((entry) => entry.id === phaseId);
  const ceiling = phase?.ceiling_usd ?? store.budget.ceiling_usd;
  return out(EXIT_REFUSED, [
    ...notes,
    `refusing to spawn — ${phaseId} is priced in \`host-tokens\` `
      + `($${ceiling.toFixed(2)} is not dollars a spawn may`,
    "spend) and this invocation is headless. Either run it in-session (tldrx next --prepare), or set the",
    `phase to \`economy: metered-usd\` and re-price it (tldrx budget raise ${phaseId} <usd>).`,
  ]);
}

function budgetRefusal(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  notes: string[],
): NextOutcome | null {
  const stage = requireStage(store, phaseId, stageId);
  const phaseRemaining = remaining(store.budget, phaseId);
  // Under `host-tokens` the arithmetic is between two numbers in different units,
  // so it is not arithmetic — it is a category error, and it must never BLOCK
  // (design §E.2). It still says so out loud, once, as a `budget.warned`: an
  // in-session phase whose ceiling nothing here can enforce is a fact an operator
  // should read, not a silence.
  if (isHostTokens(store.budget, phaseId)) {
    hostTokensNote(store, options, phaseId, stageId, notes);
    return null;
  }
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
    // A scope that SKIPS the Plan phase still reaches Build, and Build declares
    // `03-plan/waves.yml` as an input. Refusing it there would make `docs`,
    // `hotfix`, `performance`, `prototype` and `security-patch` unable to build at
    // all — so the executor's synthesised plan satisfies that one input, and only
    // that one. Every other missing input is still exit 1: this excuses the phase
    // that was skipped by decision, not the files nobody wrote by accident.
    const skipsPlan = planIsSkipped(spec.skips);
    const gaps = missing(expandAll(spec.requiredInputs, store.run.repos), ctx)
      .filter((path) => !(skipsPlan && satisfiedByImplicitPlan(path)));
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
  announce(store.runId, stageId, nextTaskId(store, phaseId, stageId), agentCap(options, store, stage));
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
    reuseEpic: options.reuseEpic === true,
    // `--parallel` beats the workflow's `<stage>: {parallel: N}`, which beats
    // `stage.yml`'s. Absent everywhere it is 1 — the sequential path, unchanged.
    parallel: options.parallel ?? spec.parallel ?? 1,
    discardPending: options.discardPending === true,
    agentCap: (share = 1) => agentCap(options, store, stage, share),
    emit: (type, payload, costUsd = 0, actor = null) => {
      store.append(event(options, store.runId, stageId, type, payload, costUsd, actor));
    },
  };

  const outcome = await executor(executorCtx);
  claimEpicBranches(store, outcome.epicBranches);
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
  const advisories = outcome.stderr ?? [];
  if (outcome.awaiting) return out(EXIT_OK, [...notes, ...outcome.lines], advisories);
  return withStderr(
    await finishStage(store, options, phaseId, stageId, spec, [...notes, ...outcome.lines], outcome.gate),
    advisories,
  );
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

  // A questions.md the §2.7 parser cannot read is not "no questions" — it is a
  // file nobody, including the gate, can see into. Refused HERE rather than at the
  // gate because `--commit` is the last moment the host session that wrote it is
  // still around to fix it. Measured 2026-08-29: an in-session stage wrote
  // `### Q1 — …` / `**Answer:**` from the old template, and four questions
  // vanished between the sub-agent and the run.
  const unreadable = unreadableHeadings(join(store.runDir, phaseId, "questions.md"));
  if (unreadable.length > 0) {
    return out(EXIT_AGENT_FAILED, [
      ...notes,
      `${phaseId}/questions.md has ${unreadable.length} question(s) the parser cannot read `
        + `(${unreadable.join(", ")}) — a heading must be \`## Qn · <title>\` with the `
        + "`<!-- id: Qn | status: open | area: … | asked_by: … | asked_at: … -->` line under it.",
      "As written they are invisible: the gate would read this file as \"0 open\" and sign itself.",
      `Fix: \`tldrx questions lint --run ${store.runId} --fix\`, then \`tldrx next --commit\` again.`,
    ]);
  }

  // The cost of an in-session turn is DECLARED, never measured: the sub-agent ran
  // inside the host's session and was billed to it. `--cost-usd` is the host
  // saying what it was; `result.json`'s own `cost_usd` is the other way to say it.
  // With neither, this is `null` + `metered: false` — not `0`, which is a
  // measurement and a false one (2026-08-29 audit, §A: a run's ledger read
  // "$0.00 spent" after real money had gone).
  const declared = options.costUsd ?? result.cost_usd;
  const cost = declared === null || declared === undefined ? null : round2(declared);
  const taskId = nextTaskId(store, phaseId, stageId);
  recordTask(store, phaseId, stageId, {
    id: taskId,
    status: "done",
    expert: stage.expert ?? spec.planned.experts[0] ?? null,
    model: options.model ?? stage.model ?? spec.planned.model,
    cost_usd: cost,
    ...(cost === null ? { metered: false } : {}),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
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
    // `cost_usd` on the ENVELOPE must stay a number ≥ 0 (spec §2.9), so the fact
    // that nothing was declared lives in the payload where it can be null.
    metered: cost !== null,
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
  }, cost ?? 0, stage.expert));
  store.save();
  if (cost === null) {
    notes.push(
      `cost is unmetered (in-session): nothing declared it, so this turn is recorded as `
      + "`cost_usd: null, metered: false` rather than $0.00. Pass `--cost-usd <n>` when you know it.",
    );
  }

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
  const spent = round2(stage.tasks.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0));
  const unmetered = stage.tasks.filter((t) => t.cost_usd === null).length;
  const costLine = unmetered === 0
    ? `$${spent.toFixed(2)} of $${stage.budget_usd.toFixed(2)}`
    : `$${spent.toFixed(2)} of $${stage.budget_usd.toFixed(2)} + ${String(unmetered)} unmetered (in-session)`;

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
      `${phaseId}/${stageId} done — ${costLine} (${checkSummary})`;

    // The gate is now REQUESTED either way. Who closes it is the policy's call —
    // and an `auto` policy only closes it when all six §5 conditions hold.
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
    `${phaseId}/${stageId} done — ${costLine} (${checkSummary})`,
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

/**
 * The declared inputs a stage's prompt gets, in the order the budget spends on
 * them: required, then the optional ones that exist, then the run's seed
 * documents, capped at §2.3's 20.
 *
 * Extracted so `tldrx run estimate` can weigh the NEXT stage's prompt without
 * running it, off exactly the list the facilitator would build — an estimator
 * with its own idea of what the inputs are is an estimator that drifts.
 */
export function declaredInputsOf(
  store: RunStore,
  spec: StageSpec,
  stage: RunStage,
  ctx: PathContext,
): readonly string[] {
  // Patterns are expanded to the CONCRETE files here, not left as `<id>.md`: the
  // prompt inlines content, and there is no content behind a shape. The gap check
  // above deliberately does the opposite — see `expandPatterns` in `paths.ts`.
  const required = expandPatterns(expandAll(spec.requiredInputs, store.run.repos), ctx);
  const optional = present(expandPatterns(expandAll(spec.optionalInputs, store.run.repos), ctx), ctx);
  const seed = seedInputsOf(spec, stage, ctx);
  return capInputs([
    ...required,
    ...optional.filter((p) => !required.includes(p)),
    ...seed.filter((p) => !required.includes(p) && !optional.includes(p)),
  ]);
}

/** The run's seed documents for a stage that asked for them — see below. */
export function seedInputsFor(spec: StageSpec, stage: RunStage, ctx: PathContext): readonly string[] {
  return seedInputsOf(spec, stage, ctx);
}

/** `inlineInputs` speaks `{inputs, note}`; `buildPrompt` speaks `{inputs, inputsNote}`. */
function withNote(result: InlineResult): { inputs: InlineResult["inputs"]; inputsNote?: string } {
  return result.note === null ? { inputs: result.inputs } : { inputs: result.inputs, inputsNote: result.note };
}

export interface AssembledPrompt {
  readonly prompt: string;
  readonly bundles: ExpertBundleSet;
  /** Every section, in bytes, measured off the same parts the prompt is joined from. */
  readonly ledger: ContextLedger;
  /** Declared inputs the shared byte budget could not fit whole. */
  readonly truncatedNotes: readonly string[];
}

export function assemblePrompt(
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
  const workspace = loadWorkspace(options.root);
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
    workspaceRepoCount: workspace.repos.size,
    nearbyPaths: nearbyPathsFor(options.root, store.run.repos, inputs),
    knowledgeBytes: spec.knowledgeMaxBytes,
  });
  // Inputs are filled FIRST, out of their own shared ceiling; the experts share
  // what `knowledge_max_bytes` allows between them afterwards (spec §2.3, §5).
  const inlined = inlineInputs(inputs, {
    ctx,
    seed,
    budgetBytes: spec.inputsMaxBytes,
    exempt: new Set(inputs.filter((path) => path.endsWith(`/${SEED_INDEX}`))),
  });
  const parts = renderParts({
    stageMd,
    previousAttempt: describePreviousAttempt(stage, {
      outputs: expandAll(spec.planned.outputs, store.run.repos),
      ctx,
    }),
    values: {
      run: store.runId,
      repos: store.run.repos.length === 0 ? "(none)" : store.run.repos.join(", "),
      inputs: inputs.length === 0 ? "(none)" : inputs.map((p) => `- ${p}`).join("\n"),
      facts: renderFacts(facts.facts, store.run.repos),
      conventions: renderConventions(options.root, store.run.repos),
      budget_usd: stage.budget_usd.toFixed(2),
    },
    experts: bundles.experts,
    ...withNote(inlined),
  });
  const ledger = buildLedger({
    parts,
    inputBytes: inlined.inputs.map((input) => ({
      path: input.path,
      bytes: byteLength(input.content),
    })),
    truncatedInputs: inlined.truncated,
    limitBytes: options.promptMaxBytes ?? spec.promptMaxBytes,
    model: options.model ?? stage.model ?? spec.planned.model,
    questionsBytes: questionsBytesOf(stageMd),
  });
  return {
    prompt: parts.map((part) => part.text).join(""),
    bundles,
    ledger,
    truncatedNotes: describeTruncatedInputs(inlined),
  };
}

/**
 * What the last attempt at this stage left behind (spec §5, failure path: the
 * reject note is "fed into the next prompt").
 *
 * Three sources now. Two were always here — the error of the last failed task and
 * an operator's rejection note — and either one means this is a retry, so the
 * agent is told so rather than handed the original prompt as if nothing happened.
 *
 * **The third is the work itself (wave N).** Measured 2026-08-29: attempt 2 got
 * the error and the note and NOTHING ELSE, so a stage rejected over one missing
 * section paid full price to write four documents again from a blank page, and
 * whatever was right about the first draft was rewritten by a model that had
 * never seen it. The declared outputs that exist on disk are now inlined under an
 * explicit instruction to EDIT them, capped at `MAX_PREVIOUS_ATTEMPT_BYTES`.
 *
 * The cap is shared across the outputs and spent in declared order, and a file
 * that does not fit is NAMED rather than silently dropped — the same rule the
 * declared inputs follow, for the same reason.
 */
export const MAX_PREVIOUS_ATTEMPT_BYTES = 32 * 1024;

export interface PreviousAttemptOptions {
  /** The stage's declared outputs, already `{repo}`-expanded. */
  readonly outputs: readonly string[];
  readonly ctx: PathContext;
  readonly maxBytes?: number;
}

export function describePreviousAttempt(
  stage: RunStage,
  options?: PreviousAttemptOptions,
): string {
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
  if (options !== undefined) lines.push(...priorOutputs(options));
  return lines.join("\n");
}

function priorOutputs(options: PreviousAttemptOptions): readonly string[] {
  const budget = options.maxBytes ?? MAX_PREVIOUS_ATTEMPT_BYTES;
  const blocks: string[] = [];
  const skipped: string[] = [];
  let spent = 0;

  // `resolveMany`, not `resolveDeclared`: a declared output can be a pattern, and
  // the previous attempt's seven stories are exactly the draft this stage is
  // being paid to fix rather than rewrite.
  for (const { path, absolute } of options.outputs.flatMap((declared) => resolveMany(declared, options.ctx))) {
    const text = readOrEmpty(absolute);
    if (text.trim() === "") continue;
    const size = Buffer.byteLength(text, "utf8");
    if (spent + size > budget) {
      skipped.push(`${path} (${size.toLocaleString("en-US")} B)`);
      continue;
    }
    spent += size;
    const fence = fenceFor(text);
    blocks.push(`#### \`${path}\``, "", fence, text.replace(/\n$/, ""), fence, "");
  }
  if (blocks.length === 0 && skipped.length === 0) return [];

  const out = [
    "",
    "### Previous attempt — edit, do not restart",
    "",
    "These files are on disk RIGHT NOW, exactly as the last attempt left them. They are",
    "not a suggestion and they are not history: they are the draft you are being paid to",
    "fix. Keep every part that is already correct, change what the note above says is",
    "wrong, and write the files back. Starting from a blank page throws away work that",
    "has already been paid for, and loses the parts nobody objected to.",
    "",
  ];
  if (skipped.length > 0) {
    out.push(
      `_Not inlined (past the ${budget.toLocaleString("en-US")}-byte previous-attempt budget): `
      + `${skipped.join(", ")}. They are on disk; read them before you rewrite them._`,
      "",
    );
  }
  return [...out, ...blocks];
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
    // Running again is what un-stales a stage: the flag says "produced from a
    // decision that was later withdrawn", and this turn is the redo.
    stale: undefined,
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

/**
 * The progress view's heading and money bar for this turn.
 *
 * `t3` is the third task of this stage, which is the third attempt at it — a
 * retry after `reject` is exactly what a person watching wants to know they are
 * looking at. Both calls are no-ops unless a driver is installed.
 */
function announce(
  runId: string,
  stageId: string,
  taskId: string,
  ceilingUsd: number,
  maxReads = 0,
): void {
  const attempt = Number(taskId.replace(/^t/, ""));
  const suffix = Number.isFinite(attempt) ? ` · attempt ${String(attempt)}` : "";
  setProgressTitle(`${stageId} · ${runId}${suffix}`);
  setProgressCeiling(ceilingUsd);
  setProgressReadCap(maxReads);
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
    // A pattern reverts every file it matched, and the line names them: "reverted
    // 03-plan/stories/<id>.md" would leave the operator guessing what went.
    for (const hit of resolveMany(declared, ctx)) {
      rmSync(hit.absolute, { force: true });
      dropped.push(hit.path);
    }
  }
  return dropped;
}

/** Spec §2.11 `warn_at_pct`: "emits `budget.warned` once per phase". */
/**
 * The one line a `host-tokens` phase gets in place of a dollar refusal, appended
 * once per phase (the same "once" `warnOnce` means, and for the same reason: a
 * per-stage repeat of a phase-level fact is noise).
 */
function hostTokensNote(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  notes: string[],
): void {
  notes.push(
    `budget: phase ${phaseId} is priced in \`host-tokens\` — this process meters none of it, `
      + "so no dollar ceiling was enforced here",
  );
  if (alreadyWarned(store, phaseId)) return;
  store.append(event(options, store.runId, stageId, "budget.warned", {
    phase: phaseId,
    economy: "host-tokens",
    reason: "ceiling is not denominated in USD; no dollar gate applied",
  }));
}

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
