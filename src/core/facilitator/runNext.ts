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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { ambiguousRunLines } from "../run/openRuns.ts";
import { RunStore } from "../run/RunStore.ts";
import { isAttendedByHost, isTerminal, type GateType, type RunFile, type RunPhase, type RunStage, type RunTask } from "../run/RunFile.ts";
import { runChecks, runPrecondition, type PreconditionOutcome } from "../run/checks.ts";
import { approve } from "../run/gates.ts";
import { AUTO_GATE_ACTOR, evaluateAutoGate, unreadableHeadings } from "../run/autoGate.ts";
import { describeAgentFallthroughs, evaluateAgentGate } from "../run/agentGate.ts";
import { cardForTriggers, type Money } from "../run/decisionCards.ts";
import { renderDecisionCard } from "../ui/decisionCard.ts";
import { gatePolicyFor } from "../run/gatePolicy.ts";
import type { BranchModelKind } from "../plan/branchModel.ts";
import { PresetError, stageMdPath, type PlannedStage } from "../run/workflowPreset.ts";
import { economyFor, isHostTokens } from "../budget/RunBudget.ts";
import { remaining, wouldExceedHostTokens } from "../budget/wouldExceed.ts";
import {
  remainingWork, renderRemainingWork, remainingWorkContext, type RemainingWork,
} from "../budget/remainingWork.ts";
import { raiseCommand, shortBy } from "../budget/budgetView.ts";
import { FactsStore } from "../facts/FactsStore.ts";
import { factsPath, loadWorkspace, toSrcContext } from "../../hooks/lib/workspace.ts";
import { closeRun, describeOpenQuestions, describeStateCommit } from "../run/closeRun.ts";
import { capPayload, type EventType, type TldrxEvent } from "../events/Event.ts";
import { LOG_DIR } from "../build/plan.ts";
import { setProgressCeiling, setProgressReadCap, setProgressTitle } from "../ui/bus.ts";
import { acquireLock, releaseLock } from "./Lock.ts";
import { onInterrupt, stopInFlightRun } from "./interrupt.ts";
import { loadStageSpec, type StageSpec } from "./stageSpec.ts";
import { countSkipInputs, evaluateSkipIf, openQuestionIds, SkipIfError } from "./skipIf.ts";
import {
  agentDir, evidencePath, expandAll, expandPatterns, missing, present, resolveMany, type PathContext,
} from "./paths.ts";
import { fenceFor, renderConventions, renderFacts, renderParts, stackExpertNames } from "./prompt.ts";
import { applyCheckContracts } from "./checkContracts.ts";
import { describeDispatchNotes, loadDispatchNotes, type DispatchNotes } from "./dispatchNotes.ts";
import {
  describeBundles, loadExpertBundles, untrainedNotes, type ExpertBundleSet,
} from "../experts/expertBundle.ts";
import { nearbyPathsFor } from "../experts/domainRank.ts";
import { readStackPacks, renderProjectSkills, skillsFor } from "../experts/stackPacks.ts";
import { agentProvider, describeSpawn, providerBudgetAdvisory, spawnAgent } from "./spawnAgent.ts";
import { withAttendedGuard } from "./attended.ts";
import type { EffortLevel } from "../schemas/stage.ts";
import { validateOutputs, describeProblems } from "./validateOutputs.ts";
import { executorFor, type ExecutorContext, type ExecutorOutcome, type StageExecutor } from "./executors/index.ts";
import { planIsSkipped, satisfiedByImplicitPlan } from "../build/implicitPlan.ts";
import {
  promptPath, readResult, writeBundle, writeRaw, PendingError,
  dispatchNotesRecord, type PendingStage,
} from "./pending.ts";
import { hasReviewBundle, preparedBundles, PENDING_JSON } from "../run/prepared.ts";
import { capInputs, describeTruncatedInputs, inlineInputs, type InlineResult } from "./seedInputs.ts";
import {
  buildLedger, questionsBytesOf, renderContextWarning, renderLedger, renderRefusal,
  type ContextLedger,
} from "./contextLedger.ts";
import { DEVELOPER_RESULT_SCHEMA } from "./envelope.ts";
import { bundlesToCheck, checkBundleResult } from "../build/resultCheck.ts";
import { byteLength } from "../experts/expertKnowledge.ts";
import { SEED_INDEX } from "../seed/renderSeed.ts";

export type NextMode = "headless" | "prepare" | "commit";

export interface NextOptions {
  readonly root: string;
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly mode: NextMode;
  /**
   * `--review` — this half of the handshake is for the story's REVIEWER, not its
   * developer (design §B.3).
   *
   * Only ever true beside `--prepare` or `--commit`; the CLI refuses it on a bare
   * `tldrx next`. Phases with no reviewer ignore it.
   */
  readonly review?: boolean;
  /**
   * `--commit --check` — validate the prepared bundle's `result.json` and STOP.
   *
   * A read-only rehearsal of the commit's envelope reader. It moves no cursor,
   * writes no event, takes no `.lock` and settles nothing; it exists so the
   * author of a turn can find out that its envelope is unreadable while the turn
   * is still open. See `core/build/resultCheck.ts` for the measurement.
   */
  readonly check?: boolean;
  /**
   * `--fixlist <path>` — the fix-list artifact this `--prepare` is a round of
   * (design §B.4). Carried straight to the executor; nothing here reads it.
   */
  readonly fixlist?: string;
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

  // BEFORE the lock, and that placement is the contract: `--check` writes
  // nothing at all, and `.lock` is a file. A check runs happily beside a `next`
  // that is spending money, because it cannot touch anything that one owns.
  if (options.check === true) return checkPrepared(store, options);

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
    // Armed for the whole of `advance`, disarmed however it leaves. The refusals
    // below are the ones an operator reads; this is the wall behind them, and it
    // covers the Build fan-out's spawns too because they happen inside this call.
    return await withAttendedGuard(
      isAttendedByHost(store.run) ? store.runId : null,
      () => advance(store, options, notes),
    );
  } finally {
    forget();
    releaseLock(store.runDir);
  }
}

/**
 * `tldrx next --commit --check` — is the prepared bundle's `result.json` one
 * `--commit` could read?
 *
 * Read-only, and the tests measure that as bytes: `run.yml`, the story file and
 * `events.jsonl` are compared whole either side of the call. The refusal exit is
 * 1 — the "you asked for something that has nothing behind it" family, the same
 * one an out-of-order handshake returns (gh #82). Not 2: nothing was gated and no
 * attempt was charged, because nothing was settled.
 *
 * The stage is the CURSOR's, so this answers for the bundle a `--commit` typed in
 * the same second would settle. Which bundles those are, and whether each reads,
 * is `core/build/resultCheck.ts` — this function is the plumbing around it.
 */
function checkPrepared(store: RunStore, options: NextOptions): NextOutcome {
  const review = options.review === true;
  const half = review ? "reviewer" : "developer";
  const entry = store.cursorEntry();
  if (entry === null) {
    return out(EXIT_USAGE, [`${store.runId} has no stage at its cursor — there is no bundle to check`]);
  }
  const bundles = bundlesToCheck(store.runDir, entry.stage.id, review);
  if (bundles.length === 0) {
    const where = relative(options.root, agentDir(store.runDir, entry.stage.id));
    return out(EXIT_USAGE, [
      `no ${half} bundle is out under ${where}/ — `
        + `run \`tldrx next --prepare${review ? " --review" : ""}\` first`,
    ]);
  }
  const lines: string[] = [];
  let ok = true;
  for (const bundle of bundles) {
    const where = relative(options.root, agentDir(store.runDir, bundle.key));
    const checked = checkBundleResult(store.runDir, bundle, where);
    if (!checked.ok) ok = false;
    lines.push(...checked.lines);
  }
  lines.push(ok
    ? "checked and wrote nothing — no state moved, no event was recorded, no attempt was spent"
    : `wrote nothing — no attempt was spent. Fix the envelope and run \`tldrx next --commit${review ? " --review" : ""} --check\` again`);
  return out(ok ? EXIT_OK : EXIT_USAGE, lines);
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
  // `attended_by: host` (spec §2.2): the run is being driven by a host session,
  // so the framework does not spawn on it. First thing in `runStage`, which is
  // before the budget gate, before an input is read, before a prompt is
  // assembled and before an executor is chosen — nothing is billed and nothing
  // is written for this stage.
  //
  // Deliberately here rather than at the top of `runNext`: `advance` walks past
  // terminal stages and evaluates `skip_if` first, and those are free. Refusing
  // ahead of them would name a stage the run is no longer on, which is the one
  // thing this message exists to get right.
  const attended = attendedRefusal(store, options, phaseId, stageId, notes);
  if (attended !== null) return attended;

  if (options.dryRun && !spec.dryRunAllowed) {
    return out(EXIT_USAGE, [...notes, `stage '${stageId}' sets dry_run_allowed: false — refusing --dry-run`]);
  }

  // --- economy gate (spec §2.11, design §E.2) ------------------------------
  // BEFORE the executor, before the prompt, before the budget arithmetic: the
  // first thing checked about a headless invocation is whether the ceiling it is
  // about to spawn under is denominated in money at all.
  const mismatch = economyRefusal(store, options, phaseId, notes);
  if (mismatch !== null) return mismatch;

  // --- preconditions (design §F.1) -----------------------------------------
  // Before the executor, before the bundle, before the spawn. A stage that
  // declares none does not reach a line of this.
  const red = await preconditionRefusal(store, options, phaseId, stageId, spec, notes);
  if (red !== null) return red;

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
  notes.push(...assembled.absentNotes);
  notes.push(...describeDispatchNotes(assembled.dispatchNotes));
  if (options.mode === "prepare" || options.dryRun) notes.push(...renderLedger(ledger));

  // --- context gate (spec §5) ---------------------------------------------
  // A refusal, not a warning, and BEFORE the money: over `prompt_max_bytes` the
  // stage does not start. Nothing has been written or spent at this point.
  if (ledger.overLimit) {
    return out(EXIT_REFUSED, [...notes, ...renderRefusal(ledger, stageId)]);
  }
  const providerAdvisory = providerBudgetAdvisory(agentProvider(), cap);
  const advisories = [
    ...untrainedNotes(assembled.bundles),
    ...renderContextWarning(ledger),
    ...(providerAdvisory === null ? [] : [providerAdvisory]),
  ];

  // --- dry run (issue #17) -------------------------------------------------
  // The LAST thing that happens on a dry run, and it happens HERE: after the
  // prompt is assembled and priced — so the report is about the real bundle, not
  // a guess at one — and before `writeBundle`, before `stage.started`, before
  // the spawn. Nothing is written and nothing is spent.
  //
  // It used to run the stage for real and revert the non-handoff files
  // afterwards: one `claude -p`, one `agent.spawned`, one `agent.result`, $0.42
  // on the 2026-08-30 pilot's ledger. `tldrx next --help` had said "Spawns
  // nothing and writes nothing" the whole time; this is the code catching up to
  // the promise, rather than the promise being watered down to the code.
  if (options.dryRun) {
    return out(EXIT_OK, [
      ...notes,
      ...dryRunReport(store, options, phaseId, stageId, {
        outputs: expandAll(spec.planned.outputs, store.run.repos),
        promptBytes: byteLength(prompt),
        cap, model, effort, maxReads,
        command: describeSpawn({
          prompt, model, effort, maxBudgetUsd: cap,
          workspaceCommands: [...loadWorkspace(options.root).commands],
          yolo: options.yolo, cwd: options.root,
          timeoutMs: spec.planned.timeout_s * 1000, maxReads,
        }),
      }),
    ], advisories);
  }

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
      dispatch_notes_bytes: ledger.groups.dispatchNotes,
      project_skills_bytes: ledger.groups.projectSkills,
      previous_attempt_bytes: ledger.groups.previousAttempt,
      truncated_inputs: ledger.truncatedInputs.map((entry) => entry.path),
    },
    ...dispatchNotesRecord(assembled.dispatchNotes),
    max_reads: maxReads,
    // The same contract the Build developer bundle carries, for the same reason:
    // a host answering by hand must not have to read this file to learn what
    // `--commit` will read back. `commitStage` below goes through `readResult`,
    // which is what this schema describes.
    result_schema: DEVELOPER_RESULT_SCHEMA,
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
    cost_usd: agent.metered ? round2(agent.costUsd) : null,
    ...(agent.metered ? {} : { metered: false }),
    error: agent.error,
    session_id: agent.sessionId,
    started_at: options.at,
    ended_at: nowish(options),
    outputs: agent.envelope?.outputs ?? [],
    // Null on every ordinary attempt, so run.yml is byte-identical to before
    // unless a cap actually bit. "It ran out of reads" and "it crashed" are
    // different stories and the file has to be able to tell them apart.
    stopped_by: agent.stoppedBy,
    ...tokenSplit(agent.usage.input_tokens, agent.usage.output_tokens),
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
    ...(agent.metered ? {} : { metered: false }),
    usage: {
      input_tokens: agent.usage.input_tokens,
      output_tokens: agent.usage.output_tokens,
      cache_creation_input_tokens: agent.usage.cache_creation_input_tokens,
      cache_read_input_tokens: agent.usage.cache_read_input_tokens,
    },
  }, agent.metered ? round2(agent.costUsd) : 0, stage.expert));
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
 * Merge the branches an executor claimed into `run.yml` (`build.epic_branch`),
 * with the branch model it used beside them (`build.branch_model`, issue #57).
 *
 * Additive and idempotent. The branches are what lets the NEXT Build invocation
 * tell a branch IT cut from one that was already on the repo — the check that
 * keeps two runs from stacking commits on the same branch. The model is what lets
 * that invocation cut the SAME branches again rather than re-deciding: a run that
 * started per-epic stays per-epic, whatever its plan says today.
 */
function claimEpicBranches(
  store: RunStore,
  claimed: readonly string[] | undefined,
  model: BranchModelKind | undefined,
): void {
  if ((claimed === undefined || claimed.length === 0) && model === undefined) return;
  store.mutate((run) => {
    const known = new Set(run.build?.epic_branch ?? []);
    for (const branch of claimed ?? []) known.add(branch);
    // The model is written once and never rewritten: it is the record of what
    // this run DID, and a later invocation that read it must not be able to
    // change the answer it read.
    const kept = run.build?.branch_model;
    const branchModel = kept ?? model;
    return {
      ...run,
      build: {
        epic_branch: [...known].sort(),
        ...(branchModel === undefined ? {} : { branch_model: branchModel }),
      },
    };
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
    // `expert_md_bytes` stays `expert.md`'s own bytes, never the composed one — a
    // stack expert's overlay bytes are a SEPARATE additive key (AGENTS.md §7).
    expert_md_bytes: expert.expertMdBytes,
    ...(expert.overlays.length === 0 ? {} : { overlays: expert.overlays, overlay_bytes: expert.overlayBytes }),
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
 * Exit `4` on a bare `tldrx next` over a run marked `attended_by: host`.
 *
 * Four, not two: the run is not refusing the work, it is waiting on the host to
 * do a turn — the same shape as waiting at a gate, and the code `run auto`
 * already stops cleanly on. The message names the exact command for where the
 * stage actually is, because "use --prepare" on a stage whose bundle is already
 * out is the wrong half of the handshake.
 *
 * THREE halves, not two, since the reviewer became delegable (design §B.3). A
 * Build stage holding a reviewer bundle is `running` exactly like one holding a
 * developer bundle, so `--commit` alone used to be named for both — and on the
 * review it is the wrong door: it reads the DEVELOPER's `result.json` and re-runs
 * a pipeline that has already merged. The review bundle is checked first because
 * it is the more specific fact.
 *
 * `--dry-run` is refused with everything else, but no longer because it costs
 * anything: since issue #17 it spawns nothing. It is refused because it is
 * `mode: "headless"` and describes a dispatch the framework will never make on
 * this run — the useful rehearsal here is `--prepare`, which writes the bundle
 * the host is actually going to carry.
 */
function attendedRefusal(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  notes: string[],
): NextOutcome | null {
  if (!isAttendedByHost(store.run) || options.mode !== "headless") return null;
  const running = requireStage(store, phaseId, stageId).status === "running";
  const reviewing = hasReviewBundle(store.runDir, stageId);
  const half = reviewing ? "--commit --review" : running ? "--commit" : "--prepare";
  const waiting = reviewing
    ? "has a REVIEW bundle out and is waiting for its verdict"
    : running
      ? "has a bundle out and is waiting for its result"
      : "is waiting on a host turn";
  return out(EXIT_AWAITING_HUMAN, [
    ...notes,
    `${store.runId} is attended_by: host — the framework does not spawn on this run.`,
    `  ${phaseId}/${stageId} ${waiting}: tldrx next ${half} ${store.runId}`,
    ...(options.dryRun
      ? ["  (--dry-run is headless too: it spawns nothing, but it describes a dispatch this run never makes — "
        + "`--prepare` writes the bundle you are going to carry)"]
      : []),
    `  (to hand the whole run back to the framework: tldrx run attend --none ${store.runId})`,
  ]);
}

/**
 * `preconditions:` — the operational facts a dispatch is only worth making if they
 * hold (design §F.1, spec §2.3).
 *
 * The grounding is measured: on 2026-08-30 a host checked the Docker daemon and
 * the .NET SDK BY HAND before dispatching a Build story, because a dead daemon
 * does not fail the story — it fails the ATTEMPT, and a story has two. An agent
 * cannot debug its way out of an environment that is down, so the whole turn is
 * spent proving something the operator could have read in 1.2 seconds.
 *
 * So they run here: after the stage is known to be runnable and before ANYTHING
 * is written or spawned. Both dispatching modes are covered, deliberately —
 * `--prepare` no less than headless, because a bundle written for a host whose
 * Docker is down is the same wasted attempt as a spawn into one. `--commit` is
 * excluded: it settles work that already happened, and re-checking the daemon
 * cannot change what a finished turn produced.
 *
 * A red precondition is `refused`, not `failed`: exit 2 with the command and its
 * exit code named, the stage left exactly where it was (`ready`), nothing spent.
 * That is the outcome an operator can fix and re-run, which is the whole point.
 */
async function preconditionRefusal(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  spec: StageSpec,
  notes: string[],
): Promise<NextOutcome | null> {
  // `--commit` settles a turn the host already took. Nothing is dispatched, so
  // there is nothing to protect and no line to print.
  if (options.mode === "commit") return null;
  const preconditions = spec.planned.preconditions;
  // The byte-identical path: a stage with none emits no event and no note.
  if (preconditions.length === 0) return null;

  const ctx = { root: options.root, runDir: store.runDir, stage: spec.planned };
  for (const precondition of preconditions) {
    const ran = await runPrecondition(precondition, ctx);
    store.append(event(options, store.runId, stageId, ran.ok ? "check.passed" : "check.failed", {
      phase: phaseId,
      check: precondition.id,
      kind: "precondition",
      repo: precondition.repo,
      command: precondition.command,
      exit_code: ran.exitCode,
      ms: ran.ms,
      status: ran.ok ? "passed" : "failed",
      detail: ran.detail,
    }));
    notes.push(preconditionLine(ran));
    if (ran.ok) continue;
    // No `store.save()`: nothing here mutated `run.yml` or `budget.yml`, and
    // "nothing was spent" in the message below is only true if it is also
    // literally true of the files. The events are already on disk — `append`
    // writes the line, `save` does not.
    return out(EXIT_REFUSED, [
      ...notes,
      `refusing to dispatch ${phaseId}/${stageId} — precondition \`${precondition.id}\` is red.`,
      `  ${ran.detail}`,
      // The status is READ, not asserted. `next` re-runs a `failed` stage — that is
      // the retry — and this line used to tell the operator `ready` regardless, a
      // claim the file did not hold (gh #25). Unchanged when the stage IS ready.
      `Fix it and run the same command again: the stage is still \`${stageStatusOf(store, phaseId, stageId)}\` and nothing was spent.`,
    ]);
  }
  return null;
}

/** `· precondition: docker info → exit 0 (1.2s)` — one line per run, green or red. */
function preconditionLine(ran: PreconditionOutcome): string {
  const exit = ran.exitCode === null ? "no exit code" : `exit ${ran.exitCode}`;
  return `· precondition: ${ran.command} → ${exit} (${(ran.ms / 1000).toFixed(1)}s)`;
}

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
    return hostTokensNote(store, options, phaseId, stageId, notes);
  }
  // What is still to be DISPATCHED, not what the stage was priced at. On a Build
  // stage with a plan on disk this is the sum of the caps the executor would
  // actually hand out for the stories that are left; everywhere else it is
  // `stage.budget_usd`, exactly as it always was (design §E.2).
  const work = stageRemainingWork(store, options, phaseId, stage);
  const estimate = work.usd;
  // An `attended_by: host` run spawns nothing, so the dollars this brake would
  // refuse are spend that provably will not happen (issue #22, owner decision
  // 2026-09-01, policy (a)). It says the numbers and allows. In headless mode
  // `attendedRefusal` has already returned above; this is the `--prepare` path,
  // where the run genuinely continues and used to be refused on money nobody
  // was going to spend.
  if (phaseRemaining < estimate && isAttendedByHost(store.run)) {
    notes.push(
      `budget: phase ${phaseId} has $${phaseRemaining.toFixed(2)} left and the estimate is `
        + `$${estimate.toFixed(2)} — NOT refusing: this run is attended_by: host and nothing here spawns`,
    );
    if (!alreadyWarned(store, phaseId)) {
      store.append(event(options, store.runId, stageId, "budget.warned", {
        phase: phaseId,
        economy: economyFor(store.budget, phaseId),
        attended_by: store.run.attended_by ?? null,
        remaining_usd: phaseRemaining,
        estimate_usd: estimate,
        reason: "attended_by: host — no dollar gate applied",
      }));
    }
    return null;
  }
  if (phaseRemaining < estimate && store.budget.on_exceed === "block") {
    store.append(event(options, store.runId, stageId, "budget.blocked", {
      phase: phaseId,
      remaining_usd: phaseRemaining,
      estimate_usd: estimate,
      estimate_basis: work.basis,
      ...(work.basis === "plan"
        ? { static_estimate_usd: work.staticUsd, stories_done: work.done, stories_total: work.total }
        : {}),
      ceiling_usd: store.budget.phases.find((p) => p.id === phaseId)?.ceiling_usd ?? store.budget.ceiling_usd,
    }));
    // Name the command, not the field. The pilot's hand-edit of `ceiling_usd`
    // under-shot the estimate and the retry was refused a second time.
    const fix = raiseCommand(store.runId, phaseId, shortBy(estimate, phaseRemaining));
    return out(EXIT_REFUSED, [
      ...notes,
      `[tldrx] budget: refusing to start stage "${stageId}" — phase ${phaseId} has ` +
        `$${phaseRemaining.toFixed(2)} left and ${work.basis === "plan"
          ? `the remaining work is $${estimate.toFixed(2)}`
          : `the stage estimate is $${estimate.toFixed(2)}`}.`,
      ...(work.basis === "plan"
        ? [renderRemainingWork(work), ...remainingWorkContext(work)]
        : []),
      `Run \`${fix}\` (add \`--take-from <phase>\` to move the money instead of adding it), ` +
        `lower budget_usd in the stage, or set on_exceed: warn.`,
      `See the whole picture first: \`tldrx budget show --run ${store.runId}\`.`,
    ]);
  }
  warnOnce(store, options, phaseId, stageId, estimate, phaseRemaining, notes);
  return null;
}

/**
 * The estimate the brake compares against.
 *
 * `budget/budgetView.ts` calls the same `remainingWork` with the same inputs for
 * `budget show`'s `est.` column, deliberately: an operator told "$2.50" by the
 * refusal and "$18.00" by `budget show` would rightly trust neither.
 */
function stageRemainingWork(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stage: RunStage,
): RemainingWork {
  return remainingWork({
    runDir: store.runDir,
    phaseId,
    stageBudgetUsd: stage.budget_usd,
    stageSpentUsd: stage.cost_usd,
    perAgentMaxUsd: store.budget.per_agent_max_usd,
    maxUsd: options.maxUsd ?? null,
    economy: economyFor(store.budget, phaseId),
    // Attended ⇒ the host pays the developer turns, so they are not money this
    // brake is protecting (#22 (c)).
    attended: isAttendedByHost(store.run),
  });
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

  // The stage exactly as this invocation found it, so a SEQUENCING refusal can
  // hand it back untouched (gh #82). Read before the budget gate and before the
  // `running` stamp, because those are the two things an invocation writes on its
  // way in — and an invocation that turns out to have been the wrong half of the
  // handshake had no business writing either.
  const stageOnEntry = requireStage(store, phaseId, stageId);

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
    // `stage.started` is a claim that THIS invocation started the stage, and a
    // `--commit` never does one (gh #87). It settles a cycle a `--prepare`
    // started, so on the ordinary commit — the stage already `running` — no
    // event was emitted here anyway. The stage NOT being running is what makes
    // a commit out of order in the first place, and the executor is a few lines
    // below with the refusal for it. Emitting first meant the refusal came too
    // late to prevent anything: #82 restores the stage's STATUS, but the log is
    // append-only and the line cannot be unwritten. The live run
    // `260901-leaderboard-v2` left one behind at 2026-09-02T00:36:37Z — a
    // `stage.started` with no matching `stage.done` or `stage.failed`, which
    // `renderReplay` and anything counting starts read as a start.
    //
    // The STAMP stays, and only the event goes. A `--commit` that does settle a
    // cycle on a stage something demoted (a stale `.lock` cleared, a failure the
    // operator fixed) still needs `running` to finish through, and `markRunning`
    // keeps the original `started_at` — so nothing is lost and nothing is
    // claimed twice.
    if (options.mode !== "commit") {
      store.append(event(options, store.runId, stageId, "stage.started", {
        phase: phaseId,
        model,
        effort,
        budget_usd: requireStage(store, phaseId, stageId).budget_usd,
        mode: options.mode,
        executor: phaseId,
      }));
    }
    store.save();
  }

  const stage = requireStage(store, phaseId, stageId);
  // `--keep-worktrees` is typed on the invocation that BUILDS, and the run is
  // usually closed by another command in another process — `tldrx approve`, or
  // `tldrx run cancel` days later (issue #16). Record the intent on the run once,
  // so every close path can honour a flag it never sees.
  if (options.keepWorktrees === true && store.run.keep_worktrees !== true) {
    store.mutate((run) => ({ ...run, keep_worktrees: true }));
    store.save();
  }
  announce(store.runId, stageId, nextTaskId(store, phaseId, stageId), agentCap(options, store, stage));

  // Payload-cap sidecar bookkeeping for THIS invocation (spec §2.9, fix round 1).
  // A counter, not just a timestamp: the bug this closes was measured as TWO
  // oversized verdicts for the same story (an attempt-1 `changes`, an attempt-2
  // `approve`) — a timestamp alone can collide within the same wall-clock second,
  // and the second write must never silently overwrite the first.
  let overflowSeq = 0;

  /**
   * Save omitted text to a sidecar file BEFORE the event that names it is built,
   * so the pointer `capPayload` writes is true by construction — never a promise
   * about a file that does not exist yet (`writeLog` runs later, inside
   * `settle`), never one that later holds a DIFFERENT verdict's prose (only the
   * FINAL review's summary survives in the story's own log), and never one that
   * is simply never written at all (a story that does not settle this
   * invocation). A failed write is named, never a path that does not exist.
   *
   * Keyed on THIS invocation's own `phaseId`, not the `BUILD_PHASE` constant:
   * `runExecutor` also runs Watch stages, and a Watch failure's sidecar must not
   * be filed under a directory named `04-build`. `LOG_DIR` ("log") is the
   * generic convention both phases already share for their own artefacts.
   */
  const saveOverflow = (type: EventType, text: string): string => {
    overflowSeq += 1;
    const stamp = nowish(options).replace(/:/g, "-");
    const relPath = `${phaseId}/${LOG_DIR}/overflow/${stamp}-${String(overflowSeq)}-${type}-detail.txt`;
    try {
      mkdirSync(join(store.runDir, phaseId, LOG_DIR, "overflow"), { recursive: true });
      writeFileSync(join(store.runDir, relPath), text, "utf8");
      return `omitted text saved at ${relPath}`;
    } catch (error) {
      return `could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  /**
   * Cap, THEN append — the ONE seam every executor event goes through, and the
   * same one this function's own catch block below uses for its `error` event,
   * so a giant thrown message is bounded by the exact same byte-accurate rule
   * (fix round 1, finding 2) rather than a second, character-based one.
   */
  const appendCapped = (
    type: EventType,
    payload: Record<string, unknown>,
    costUsd = 0,
    actor: string | null = null,
  ): void => {
    const capped = capPayload(payload, (text) => saveOverflow(type, text));
    store.append(event(options, store.runId, stageId, type, capped, costUsd, actor));
  };

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
    review: options.review === true,
    ...(options.fixlist === undefined ? {} : { fixlist: options.fixlist }),
    attendedByHost: isAttendedByHost(store.run),
    // #68: the host's `--commit --cost-usd/--tokens` declaration, so an executor
    // can attach it the way `commitStage` does for a single-agent stage.
    costUsd: options.costUsd ?? null,
    tokens: options.tokens ?? null,
    agentCap: (share = 1) => agentCap(options, store, stage, share),
    emit: (type, payload, costUsd = 0, actor = null) => {
      appendCapped(type, payload, costUsd, actor);
    },
  };

  // How many rows this stage already had before the executor ran. `failStage`
  // rewrites the LAST row as `failed`, which is right only for a row THIS
  // invocation put there — and on the throw path below there is never one, since
  // `ExecutorOutcome.tasks` exists only at return. A retried stage keeps its
  // earlier attempts' rows (a gate reject, an in-session cycle that finished a
  // story), so without this floor the throw repainted a `done` turn as `failed`
  // with an error it did not produce.
  const tasksBefore = requireStage(store, phaseId, stageId).tasks.length;

  let outcome: ExecutorOutcome;
  try {
    outcome = await executor(executorCtx);
  } catch (error) {
    // A throw out of an executor used to escape past everything below: the stage
    // stayed `running` in a file nobody saved, and whatever the executor had
    // already put on disk — an epic merge, a story marked done — stood with no
    // record of what it cost.
    //
    // What CAN be recovered here is recovered: the stage is failed by name, the
    // throw is recorded as an `error` event, and the store is saved. What cannot
    // is said out loud rather than guessed at — `ExecutorOutcome.tasks` only
    // exists at RETURN, so a turn the executor completed before the throw has no
    // row here, and the message says so instead of inventing a count or implying
    // the ledger is whole.
    const why = error instanceof Error ? error.message : String(error);
    // `detail`, not a bespoke field: `appendCapped` runs this through the SAME
    // `capPayload` every other event does, so a giant thrown message (an error
    // thrown FOR being oversized, say) is bounded by bytes, not characters, and
    // is never lost to a second, unrecoverable throw right here.
    appendCapped("error", {
      phase: phaseId,
      where: "executor",
      detail: why,
      tasks_recorded: false,
    }, 0);
    store.save();
    return failStage(store, options, phaseId, stageId,
      `the executor threw before returning its task rows — this invocation's turn costs are not in run.yml: ${why}`,
      notes, tasksBefore);
  }

  // The handshake called by the wrong end, and nothing else wrong (gh #82). Its
  // door is HERE, before anything is recorded or saved, because the property it
  // has to keep is that `run.yml` comes out of the invocation byte for byte as it
  // went in — and `store.save()` alone would move `updated_at`.
  //
  // Nothing is skipped by taking it: `isSequencingRefusal` already established
  // there are no tasks to record and no branches to claim. The only write left is
  // undoing the `running` stamp this invocation may have put on the way in, and
  // that is a write that puts the stage BACK, not one that moves it.
  if (isSequencingRefusal(outcome)) {
    // `started` is false exactly when this invocation stamped the stage `running`
    // on its way in — `markRunning` above is the one and only write to the stage
    // between entry and here, so undoing it is the whole restoration. When the
    // stage was ALREADY running, which is the live shape this fixes, there is
    // nothing to undo and nothing is written at all.
    if (!started) {
      mapStage(store, phaseId, stageId, () => stageOnEntry);
      store.save();
    }
    // Exit 1, matching `commitStage`'s refusal for the same mistake on a
    // single-agent stage: spec §3's "you asked for something impossible".
    return out(EXIT_USAGE, [...notes, ...outcome.lines]);
  }

  claimEpicBranches(store, outcome.epicBranches, outcome.branchModel);
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
  const providerAdvisory = providerBudgetAdvisory(agentProvider(), executorCtx.maxBudgetUsd);
  const advisories = [
    ...(outcome.stderr ?? []),
    ...(providerAdvisory === null ? [] : [providerAdvisory]),
  ];
  if (outcome.awaiting) return out(EXIT_OK, [...notes, ...outcome.lines], advisories);
  return withStderr(
    await finishStage(store, options, phaseId, stageId, spec, [...notes, ...outcome.lines], outcome.gate),
    advisories,
  );
}

/**
 * Is this outcome a pure SEQUENCING refusal — safe to return without writing
 * anything at all (gh #82)?
 *
 * The flag alone is not enough. Every condition beyond it is a thing that WOULD
 * have been written on the ordinary path: a task carries money and an
 * `agent.result`, an epic branch is a claim the next invocation reads out of
 * `run.yml`. An outcome carrying either has work to record, so it takes the
 * ordinary path and records it — the flag can widen what refuses for free, but it
 * can never make the framework forget a dollar it spent or a branch it cut.
 */
function isSequencingRefusal(outcome: ExecutorOutcome): boolean {
  return outcome.sequencing === true
    && outcome.refused === true
    && outcome.tasks.length === 0
    && outcome.costUsd === 0
    && (outcome.epicBranches?.length ?? 0) === 0;
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
    // An unmetered task is a HOST turn: nothing here watched it, so `$0.00` would
    // be a measurement and a false one. Same spelling `commitStage` uses for the
    // single-agent in-session path — `cost_usd: null` plus `metered: false`.
    const metered = task.metered !== false;
    recordTask(store, phaseId, stageId, {
      id,
      status: task.error === null ? "done" : "failed",
      expert: spec.planned.experts[0] ?? null,
      model: task.model,
      cost_usd: metered ? round2(task.costUsd) : null,
      ...(metered ? {} : { metered: false }),
      ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
      error: task.error,
      session_id: task.sessionId,
      started_at: options.at,
      ended_at: nowish(options),
      outputs: task.outputs,
      ...tokenSplit(task.inputTokens, task.outputTokens),
    });
    store.append(event(options, store.runId, stageId, "agent.result", {
      phase: phaseId,
      task: id,
      key: task.key,
      session_id: task.sessionId,
      model: task.model,
      effort: options.effort ?? spec.planned.effort ?? null,
      outputs: task.outputs,
      ...(metered ? {} : { mode: "in-session", metered: false }),
      ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
    }, metered ? round2(task.costUsd) : 0));
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

  // The cost of an in-session turn is DECLARED, never measured: the sub-agent ran
  // inside the host's session and was billed to it. `--cost-usd` is the host
  // saying what it was; `result.json`'s own `cost_usd` is the other way to say it.
  // With neither, this is `null` + `metered: false` — not `0`, which is a
  // measurement and a false one (2026-08-29 audit, §A: a run's ledger read
  // "$0.00 spent" after real money had gone).
  const declared = options.costUsd ?? result.cost_usd;
  const cost = declared === null || declared === undefined ? null : round2(declared);

  // Decided BEFORE the recording block below, not after: whether THIS row is
  // about to be followed by the refusal is exactly what marks it
  // `banked_before_refusal` — the one fact that makes a later re-run's
  // fingerprint safe to match against. Recomputing this after recording would
  // record the row blind to its own fate.
  //
  // A questions.md the §2.7 parser cannot read is not "no questions" — it is a
  // file nobody, including the gate, can see into. Refused BELOW rather than at
  // the gate because `--commit` is the last moment the host session that wrote
  // it is still around to fix it. Measured 2026-08-29: an in-session stage
  // wrote `### Q1 — …` / `**Answer:**` from the old template, and four
  // questions vanished between the sub-agent and the run.
  const unreadable = unreadableHeadings(join(store.runDir, phaseId, "questions.md"));
  const willRefuseOnQuestions = unreadable.length > 0;

  // Recorded BEFORE the refusal returned below. The turn RAN: a refusal that
  // exits first is the ledger forgetting money it saw, which is the failure
  // this file's own `cost_usd: null` rule exists to prevent, pointing the
  // other way.
  //
  // Which makes the second `--commit` the hazard — but ONLY when this refusal
  // is what the operator is fixing and re-running over. The questions refusal
  // leaves the stage `running`, so the operator fixes `questions.md` and runs
  // the same command over the same `result.json`, and nothing but a fingerprint
  // would stop a second row for that one turn. `banked` is that fingerprint:
  // same session, same declared cost, same outputs, against rows this file
  // itself marked `banked_before_refusal` — and ONLY those. An ordinary
  // completed task (including one a gate rejected and sent back for a genuine
  // retry — `--prepare` re-marks the stage `running` without clearing `tasks`,
  // spec §5) is never a candidate: it never refused anything, so a second,
  // real attempt that happens to share a cost (`null` is the common case) and
  // the same output paths must NOT be mistaken for a re-read of it.
  //
  // Fresh `requireStage` rather than the `stage` snapshot from the top of this
  // function: `banked` must see whatever `tasks` holds right now.
  const currentStage = requireStage(store, phaseId, stageId);
  const banked = result.session_id === null ? null : alreadyBanked(currentStage, result, cost);
  const taskId = banked === null ? nextTaskId(store, phaseId, stageId) : banked;
  if (banked === null) {
    // Only ever true for a null session id, and only against a row THIS file
    // marked `banked_before_refusal` — an ordinary completed task sharing a
    // cost and outputs is unremarkable (a retry after a gate reject looks
    // exactly like this) and gets no note. A null session id identifies
    // nothing, so it is NEVER used to collapse two rows into one; when it also
    // happens to resemble an earlier BANKED row, the resemblance is named
    // rather than silently left for an auditor to wonder about.
    const looksLikeARepeat = result.session_id === null
      && currentStage.tasks.some((t) =>
        t.banked_before_refusal === true && t.cost_usd === cost && sameOutputs(t.outputs, result.outputs));
    recordTask(store, phaseId, stageId, {
      id: taskId,
      status: "done",
      expert: currentStage.expert ?? spec.planned.experts[0] ?? null,
      model: options.model ?? currentStage.model ?? spec.planned.model,
      cost_usd: cost,
      ...(cost === null ? { metered: false } : {}),
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
      error: null,
      session_id: result.session_id,
      started_at: currentStage.started_at ?? options.at,
      ended_at: options.at,
      outputs: result.outputs,
      ...(willRefuseOnQuestions ? { banked_before_refusal: true } : {}),
      ...(looksLikeARepeat ? { dedupe: "none — no session id" } : {}),
    });
    store.append(event(options, store.runId, stageId, "agent.result", {
      phase: phaseId,
      task: taskId,
      session_id: result.session_id,
      model: options.model ?? currentStage.model ?? spec.planned.model,
      effort: options.effort ?? spec.planned.effort ?? null,
      outputs: result.outputs,
      mode: "in-session",
      // `cost_usd` on the ENVELOPE must stay a number ≥ 0 (spec §2.9), so the fact
      // that nothing was declared lives in the payload where it can be null.
      metered: cost !== null,
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    }, cost ?? 0, currentStage.expert));
    store.save();
    if (looksLikeARepeat) {
      notes.push(
        `dedupe: none — no session id. This turn's cost and outputs match an earlier row on `
        + `this stage, but with no \`session_id\` to fingerprint it, it cannot be told apart from `
        + "a second, genuinely distinct unmetered turn — so it is recorded as its own row "
        + `(${taskId}) rather than assumed identical. Declare a session id (or \`--cost-usd\`) to `
        + "make a re-run safe to dedupe.",
      );
    }
  } else {
    // The marker is a claim ticket, and it is SINGLE-USE. It was written and
    // never consumed: the re-run the refusal was waiting for matched the row and
    // left it armed, so the row stayed a legitimate fingerprint target forever —
    // and the NEXT genuinely distinct turn on this stage with the same shape (a
    // gate reject, `--prepare`, the same host session, the same outputs, the
    // same `null` cost — the ordinary unmetered retry) was dropped as "already
    // recorded". That is the ledger forgetting a turn, which is the exact
    // failure the marker exists to prevent, pointing the other way.
    //
    // The marker itself STAYS: "this row was banked ahead of a refusal" is a
    // fact about how it got there and it does not stop being true. What is added
    // is that the re-run it was holding a place for has now been taken, which
    // `alreadyBanked` requires to be absent — so the ticket cannot be spent
    // twice, and a reader of `run.yml` alone can see why.
    claimBankedRow(store, phaseId, stageId, banked, options.at);
    store.save();
    notes.push(
      `this turn's cost is already recorded as ${banked} — an earlier \`--commit\` banked it `
      + "before refusing, so it is not recorded a second time. That row's marker is now spent: "
      + "a later attempt on this stage is recorded as its own row, however much it resembles this one.",
    );
  }
  if (cost === null && banked === null) {
    notes.push(
      `cost is unmetered (in-session): nothing declared it, so this turn is recorded as `
      + "`cost_usd: null, metered: false` rather than $0.00. Pass `--cost-usd <n>` when you know it.",
    );
  }

  if (willRefuseOnQuestions) {
    return out(EXIT_AGENT_FAILED, [
      ...notes,
      `${phaseId}/questions.md has ${unreadable.length} question(s) the parser cannot read `
        + `(${unreadable.join(", ")}) — a heading must be \`## Qn · <title>\` with the `
        + "`<!-- id: Qn | status: open | area: … | asked_by: … | asked_at: … -->` line under it.",
      "As written they are invisible: the gate would read this file as \"0 open\" and sign itself.",
      `Fix: \`tldrx questions lint --run ${store.runId} --fix\`, then \`tldrx next --commit\` again.`,
    ]);
  }

  return await finishStage(store, options, phaseId, stageId, spec, notes);
}

/**
 * The id of the task row that already banked THIS `result.json`, or null when
 * none has.
 *
 * Only called when `result.session_id` is non-null (see `commitStage` above) —
 * a null session id is never used to fingerprint a re-run. And even then, only
 * rows carrying `banked_before_refusal: true` are candidates: that flag is the
 * ONLY thing that tells "a row a refusal already recorded, expecting this exact
 * `result.json` back" apart from "an ordinary completed task that a gate sent
 * back for a genuine retry" — `--prepare` re-marks a rejected stage `running`
 * without clearing `tasks` (spec §5), so an ordinary row is always still there
 * to be mismatched against, and a retry commonly shares both the previous
 * cost (`null`, the unmetered case, most plausibly) and the same output paths.
 * Scanning every task, marked or not, was exactly that bug (found in review):
 * a real second turn silently dropped because it looked like the first.
 *
 * The fingerprint itself is every part of the result a second turn would have
 * changed — the session it ran in, the cost it declared, and the outputs it
 * named. All three matching a MARKED row is the same artefact being re-read,
 * not a second turn that happened to cost the same.
 */
function alreadyBanked(
  stage: RunStage,
  result: { session_id: string | null; outputs: readonly string[] },
  cost: number | null,
): string | null {
  const hit = stage.tasks.find((task) =>
    task.banked_before_refusal === true
    // …and UNCLAIMED. `claimBankedRow` stamps a row the moment its re-run
    // matches it, and a spent marker is not a second licence: without this the
    // row matched every later turn of the same shape for the life of the stage.
    && task.dedupe === undefined
    && task.session_id === result.session_id
    && task.cost_usd === cost
    && sameOutputs(task.outputs, result.outputs));
  return hit?.id ?? null;
}

/**
 * Spend the `banked_before_refusal` marker on the row a re-run just matched.
 *
 * Additive, in the field that already carries "why this row was or was not
 * deduped": the marker stays (it says how the row got there), and the row gains
 * the fact that the re-run it was holding a place for has arrived. `at` is the
 * `--commit` that claimed it, which is the one thing the row could not otherwise
 * say — its own `ended_at` belongs to the turn, not to the match.
 */
function claimBankedRow(
  store: RunStore,
  phaseId: string,
  stageId: string,
  taskId: string,
  at: string,
): void {
  mapStage(store, phaseId, stageId, (stage) => ({
    ...stage,
    tasks: stage.tasks.map((task) => (task.id === taskId
      ? { ...task, dedupe: `matched by the re-run committed at ${at} — the marker is spent` }
      : task)),
  }));
}

/** Element by element, so no separator character has to be chosen or escaped. */
function sameOutputs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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

    // The gate is now REQUESTED either way. Who closes it is the policy's call.
    // An `agent` policy is the strongest of the three: all seven auto conditions,
    // no budget event in the window, AND a structured evidence note that signs.
    const policy = gatePolicyFor(store.run.gates_policy, stageId);
    if (policy === "agent") {
      const agent = await evaluateAgentGate({
        root: options.root,
        runDir: store.runDir,
        phaseId,
        stage: requireStage(store, phaseId, stageId),
        planned: spec.planned,
        budget: store.budget,
        checks,
        gate: `${phaseId}/${stageId}`,
        evidencePath: evidencePath(store.runDir, stageId),
        srcCtx: toSrcContext(loadWorkspace(options.root), store.runDir, { epicRefs: true }),
        events: store.events.read(),
      });
      if (agent.ok && agent.actor !== null && agent.record !== null && agent.text !== null) {
        const provider = agentProvider();
        const executorId = provider === "codex" ? codexGateExecutorId(requireStage(store, phaseId, stageId)) : null;
        if (provider === "codex" && executorId === null) {
          return out(EXIT_AWAITING_HUMAN, [
            ...notes,
            doneLine,
            "agent gate not taken — the evidence cannot be bound to exactly one measured Codex thread",
            "gate pending: tldrx approve",
          ]);
        }
        // The SAME door a person and the facilitator use: `approve` re-runs the
        // checks off disk, copies the note into the run tree, records
        // `by`/`at`/`note`/`evidence`, appends gate.approved + stage.done and
        // advances the cursor. A refusal there is a refusal here.
        const approved = await approve(store, {
          root: options.root,
          actor: agent.actor,
          ...(executorId === null ? {} : { executorId }),
          at: nowish(options),
          note: agent.note,
          evidence: { text: agent.text, record: agent.record },
        });
        if (approved.ok) {
          return out(EXIT_OK, [
            ...notes,
            `${doneLine} · agent-approved by ${agent.actor}`,
            `  ${agent.note}`,
            `  evidence → ${approved.evidencePath ?? ""}`,
            approved.advancedTo === null
              ? `run ${store.runId} is finished`
              : `cursor → ${approved.advancedTo.phase}/${approved.advancedTo.stage} (ready)`,
          ]);
        }
        return out(EXIT_AWAITING_HUMAN, [
          ...notes,
          doneLine,
          `agent gate not taken — approve re-ran the checks and \`${approved.failed?.id ?? "unknown"}\` `
            + `failed: ${approved.failed?.detail ?? ""}`,
          `gate pending: tldrx approve`,
        ]);
      }
      // The interrupt surface (design §F.3). The fallthrough list above says what
      // the machine measured; the card says what the PERSON has to decide, in the
      // shape a host hand-composed in chat on 2026-08-30 and an owner answered in
      // seconds. Appended, never substituted: nothing that reads these lines today
      // loses a byte, and a fallthrough the card cannot shape still reports itself.
      const card = cardForTriggers(
        {
          runDir: store.runDir,
          runId: store.runId,
          phaseId,
          stageId,
        },
        agent.fallthroughs,
        phaseMoney(store, phaseId),
      );
      return out(EXIT_AWAITING_HUMAN, [
        ...notes,
        doneLine,
        `agent gate not taken — ${String(agent.fallthroughs.length)} reason(s), `
          + "this gate falls to a person:",
        ...describeAgentFallthroughs(agent.fallthroughs),
        `gate pending: tldrx approve`,
        ...(card === null ? [] : ["", ...renderDecisionCard(card)]),
      ]);
    }
    if (policy === "auto") {
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
  const closing: string[] = [];
  if (store.run.status === "done") {
    store.append(event(options, store.runId, null, "run.closed", { reason: "every stage terminal" }));
    // The run owns its epic worktrees and its own state, so the run's close is what
    // takes the one (#16) and commits the other (#102).
    const closed = await closeRun(store.run, options.root, store.runDir, store.runId);
    // First, and above the bookkeeping: an unanswered question is a decision
    // nobody made, and the close is the last moment anyone is looking (#141).
    const asked = describeOpenQuestions(closed.openQuestions);
    if (asked !== null) closing.push(`  ${asked}`);
    const said = describeStateCommit(closed.state);
    if (said !== null) closing.push(`  ${said}`);
  }
  return out(EXIT_OK, [
    ...notes,
    `${phaseId}/${stageId} done — ${costLine} (${checkSummary})`,
    moved === null ? `run ${store.runId} is finished` : `cursor → ${moved.phase}/${moved.stage} (ready)`,
    ...closing,
  ]);
}

/** A machine signature is attributable only when one measured Codex thread can own it. */
export function codexGateExecutorId(stage: RunStage): string | null {
  const identities = new Set(
    stage.tasks.flatMap((task) => typeof task.session_id === "string" && task.session_id !== ""
      ? [task.session_id]
      : []),
  );
  return identities.size === 1 ? [...identities][0] ?? null : null;
}

/**
 * Fail the stage by name, and attribute the failure to the row that earned it.
 *
 * `tasksBefore` is how many rows the stage had when THIS invocation entered the
 * executor. Given one, the last row is rewritten `failed` only when the stage
 * GREW since — because the last row is otherwise a previous, completed attempt's
 * (a gate reject and an in-session cycle both leave finished rows in place,
 * spec §5), and repainting a `done` turn `failed` puts an error in the ledger
 * that that turn did not produce. Omitted, the old behaviour stands: every other
 * caller runs after `recordExecutorTasks`, so the last row IS this invocation's.
 *
 * The stage still fails and the reason is still said out loud either way — what
 * a nameless loss may not do is borrow someone else's row to be named on.
 */
function failStage(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  reason: string,
  notes: readonly string[],
  tasksBefore?: number,
): NextOutcome {
  mapStage(store, phaseId, stageId, (stage) => ({
    ...stage,
    status: "failed",
    ended_at: nowish(options),
    tasks: tasksBefore !== undefined && stage.tasks.length <= tasksBefore
      ? stage.tasks
      : stage.tasks.map((task, i) =>
        i === stage.tasks.length - 1
          ? { ...task, status: "failed" as const, error: task.error ?? oneLine(reason) }
          : task,
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

/**
 * The declared inputs that resolve to NOTHING, in declaration order (gh #131).
 *
 * The complement of `declaredInputsOf`, off exactly the same list: `{repo}` is
 * expanded first, so `.tldrx/map/{repo}/architecture.md` reports the repo that is
 * missing one and not the token; a PATTERN keeps its shape, because `<id>.md`
 * naming no file is a declaration that went unanswered rather than a file that is
 * gone (the rule `missing` already follows).
 *
 * Required gaps are exit 1 before a prompt is ever assembled, so in practice this
 * is the OPTIONAL half — the half that used to disappear in silence. It is derived
 * from both lists anyway: which of them a path sits in is a fact about `stage.yml`,
 * not about whether an absence is worth stating.
 */
export function absentDeclaredInputs(
  store: RunStore,
  spec: StageSpec,
  ctx: PathContext,
): readonly string[] {
  const declared = expandAll([...spec.requiredInputs, ...spec.optionalInputs], store.run.repos);
  return missing(declared, ctx);
}

/** One stdout line per declared input nothing resolves to. */
export function describeAbsentInputs(absent: readonly string[]): readonly string[] {
  return absent.map((path) => `declared input absent: ${path} — the stage runs without it`);
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
  /** Declared inputs that resolve to nothing — one stdout line each (gh #131). */
  readonly absentNotes: readonly string[];
  /** The host's own context for this cycle, already read and capped. */
  readonly dispatchNotes: DispatchNotes;
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
  // The stage body plus the contracts its own `checks:` enforce (gh #35, #38):
  // the Plan agent used to be told the output FILENAMES and left to discover the
  // front-matter schema and the list caps by having a paid attempt refused.
  const stageMd = applyCheckContracts(readStageMd(spec.planned), {
    checks: spec.planned.checks.map((check) => check.id),
    outputs: spec.planned.outputs,
  });
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
  // The host's own context for this cycle (spec §5). Read here, with the rest of
  // the prompt's material, so every mode sees the same document: a note left for
  // a headless stage is as much a caveat as one left for a prepared bundle.
  const dispatchNotes = loadDispatchNotes(store.runDir, [stage.id]);
  const absentInputs = absentDeclaredInputs(store, spec, ctx);
  const parts = renderParts({
    stageMd,
    absentInputs,
    dispatchNotes: dispatchNotes.body,
    // The project's own skills, named to every stage — not gated on the packs
    // switch: `stack_packs.enabled` governs pack CONTENT, and a repo's
    // `.claude/skills` is the repo, not a pack (design §4.5, decision 6).
    projectSkills: renderProjectSkills(skillsFor(readStackPacks(options.root), store.run.repos)),
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
    absentNotes: describeAbsentInputs(absentInputs),
    dispatchNotes,
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

/**
 * The stage body: the override's own `stage.md`, else the packaged one.
 *
 * NOT `readOrEmpty`. A missing body used to be an empty string, and an empty
 * string dispatches (gh #39) — `stageMdPath` refuses instead, by name.
 */
function readStageMd(planned: PlannedStage): string {
  return readFileSync(stageMdPath(planned.id, planned.source), "utf8");
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

/** One stage's status as `run.yml` currently holds it, or `unchanged` when it is not there. */
function stageStatusOf(store: RunStore, phaseId: string, stageId: string): string {
  const stage = store.run.phases
    .find((phase: RunPhase) => phase.id === phaseId)?.stages
    .find((entry) => entry.id === stageId);
  return stage?.status ?? "unchanged";
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

/** Everything `--dry-run` reports about the turn it is NOT taking (issue #17). */
interface DryRunFacts {
  readonly outputs: readonly string[];
  readonly promptBytes: number;
  readonly cap: number;
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly maxReads: number;
  readonly command: string;
}

/**
 * What a dry run prints: the dispatch, described, and the two commands that
 * would actually make it.
 *
 * The context ledger (bytes per section, the total against `prompt_max_bytes`)
 * is already in `notes` by the time this is called — a dry run gets the same
 * breakdown `--prepare` does — so this adds only what the ledger cannot say: the
 * ceiling, the model, the read cap, the files the sub-agent would be allowed to
 * write, and the argv. The bundle PATH is named rather than written: writing a
 * `pending.json` nobody dispatched would leave a `--commit` looking at a turn
 * that never happened.
 */
function dryRunReport(
  store: RunStore,
  options: NextOptions,
  phaseId: string,
  stageId: string,
  facts: DryRunFacts,
): readonly string[] {
  const dir = relative(options.root, agentDir(store.runDir, stageId));
  return [
    "dry run: nothing was spawned and nothing was written.",
    `would dispatch ${phaseId}/${stageId} — ONE sub-agent, $${facts.cap.toFixed(2)} ceiling, `
      + `model ${facts.model ?? "default"}, effort ${facts.effort ?? "default"}, `
      + `max_reads ${String(facts.maxReads)}`,
    `  prompt: ${String(facts.promptBytes)} B — would be written to ${dir}/prompt.md`,
    `  it may write: ${facts.outputs.join(", ") || "(no declared outputs)"}`,
    `  command: ${facts.command}  # prompt on stdin`,
    `Dispatch it for real with \`tldrx next ${store.runId}\`, or hand it to this session with `
      + `\`tldrx next --prepare ${store.runId}\`.`,
  ];
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
): NextOutcome | null {
  notes.push(
    `budget: phase ${phaseId} is priced in \`host-tokens\` — this process meters none of it, `
      + "so no dollar ceiling was enforced here",
  );
  // The declared tokens against a ceiling that IS a token allowance — the one
  // comparison here whose sides share a unit (issue #22 (b)). It warns; it stops
  // only under the explicit `on_host_tokens_exceed: block`, and never on an
  // attended run (policy (a) beats policy (b)).
  const tokens = wouldExceedHostTokens(store.budget, phaseId, declaredTokensIn(store.run, phaseId));
  const stops = tokens !== null && tokens.blocked && !isAttendedByHost(store.run);
  if (tokens !== null && tokens.over) {
    notes.push(
      `budget: phase ${phaseId} is OVER its host-token ceiling — ${String(tokens.spent)} declared `
        + `of ${String(tokens.ceiling)} allowed`,
    );
  }
  // `alreadyWarned` is a WARN-once guard and must not silence a REFUSAL. A phase
  // that emitted the "no dollar ceiling here" note on an earlier stage and later
  // crosses its token ceiling would otherwise be refused with no `budget.blocked`
  // on the record — a run stopped for a reason its own audit trail never states,
  // which is the failure issue #22 exists to close.
  if (stops || !alreadyWarned(store, phaseId)) {
    store.append(event(options, store.runId, stageId, stops ? "budget.blocked" : "budget.warned", {
      phase: phaseId,
      economy: "host-tokens",
      ...(tokens === null ? {} : { host_tokens: tokens.spent, ceiling_tokens: tokens.ceiling }),
      reason: tokens !== null && tokens.over
        ? "declared host tokens are over the phase ceiling"
        : "ceiling is not denominated in USD; no dollar gate applied",
    }));
  }
  if (!stops || tokens === null) return null;
  return out(EXIT_REFUSED, [
    ...notes,
    `[tldrx] budget: refusing to start stage "${stageId}" — phase ${phaseId} is priced in \`host-tokens\` `
      + `and has declared ${String(tokens.spent)} of ${String(tokens.ceiling)} allowed.`,
    "Raise that phase's ceiling in budget.yml (under this economy the number is a TOKEN allowance), "
      + "or set `on_host_tokens_exceed: warn` to go back to a note.",
  ]);
}

/** Declared `tokens:` recorded against one phase of a run (issue #22 (b)). */
function declaredTokensIn(run: RunFile, phaseId: string): number {
  let tokens = 0;
  for (const phase of run.phases) {
    if (phase.id !== phaseId) continue;
    for (const stage of phase.stages) {
      for (const task of stage.tasks) tokens += task.tokens ?? 0;
    }
  }
  return tokens;
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

/**
 * The phase's two numbers, straight off `budget.yml`, for a budget decision card.
 *
 * Null when the phase has no row: a card that printed `$0.00 of $0.00` would be
 * stating a measurement nobody made.
 */
function phaseMoney(store: RunStore, phaseId: string): Money | null {
  const phase = store.budget.phases.find((entry) => entry.id === phaseId);
  if (phase === undefined) return null;
  return { spentUsd: phase.spent_usd, ceilingUsd: phase.ceiling_usd };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `input_tokens`/`output_tokens` for a run.yml task row — written together or
 * not at all, and never an invented zero (a Task 2/3-class bug: `null` cost_usd
 * written as `$0.00` was exactly this shape of lie).
 *
 * `AgentUsage` (and `ExecutorTask.inputTokens`/`outputTokens`, copied from it)
 * already collapse "the provider's result document carried no usage object at
 * all" into `{0, 0}` via `envelope.ts`'s `toUsage`/`EMPTY_USAGE` — the same
 * shape a turn that genuinely reported zero, or reported only ONE side of the
 * split, would leave the other side at (`number()`'s own default, 0). There is
 * no signal left at THIS layer to split "not reported" from "reported as 0" apart,
 * so a HALF-known split (`{0, 56}`) is exactly as untrustworthy as a fully
 * unknown one: writing the reported 56 next to an invented 0 would still be
 * one manufactured number on the row. Requiring BOTH strictly positive is the
 * only rule that never writes a number nothing measured — negative inputs
 * (never legitimately produced, but not this function's job to assume that)
 * are absent for the same reason.
 *
 * This is the WRITE-side rule; `budget/turnTokens.ts`'s `turnTokens` is the
 * READ-side rule that decides what a row — this one's or an older one's —
 * counts as having declared, and the two headers name each other on purpose.
 */
export function tokenSplit(
  inputTokens: number | undefined, outputTokens: number | undefined,
): { input_tokens: number; output_tokens: number } | Record<string, never> {
  if (inputTokens === undefined || outputTokens === undefined) return {};
  if (inputTokens > 0 && outputTokens > 0) return { input_tokens: inputTokens, output_tokens: outputTokens };
  return {};
}

function out(code: number, lines: readonly string[], stderr: readonly string[] = []): NextOutcome {
  return stderr.length === 0 ? { code, lines } : { code, lines, stderr };
}
