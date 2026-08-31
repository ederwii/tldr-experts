/**
 * The Watch executor: one watcher card per shipped feature (concept §10, spec §2.16, §5).
 *
 * Shape of the stage, in order:
 *
 *   1. a DETERMINISTIC pre-pass — done stories grouped by epic, one feature each.
 *      No model is asked which features shipped, because the files already say.
 *   2. one sub-agent per feature, handed the done stories, the epic-branch diff,
 *      the observability/deploy facts and the repos' gotchas, and nothing else.
 *   3. validation of each card the framework does itself, and the status stamp:
 *      `verified` only when nothing under `## Signal` cites `absent:`.
 *   4. `05-watch/handoff.md`, written deterministically from the cards.
 *
 * The one rule everything else serves: a watcher describing a signal that does not
 * exist is worse than no watcher, because it reads as coverage. So the executor
 * never lets the model decide whether it succeeded — it reads the card back off
 * disk and computes the answer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FactsStore } from "../../facts/FactsStore.ts";
import { factsPath, loadWorkspace, toSrcContext } from "../../../hooks/lib/workspace.ts";
import { collectFeatures, PLAN_PHASE, type Feature } from "../../watch/features.ts";
import { epicDiff, readRepoBases, type RepoDiff } from "../../watch/epicDiff.ts";
import { featureBrief, featureInputs, watcherRelPath } from "../../watch/watchPrompt.ts";
import { describeWatcherIssues, parseWatcherCard, setWatcherStatus } from "../../watch/watcherFile.ts";
import { renderWatchHandoff, type WrittenCard } from "../../watch/renderWatchHandoff.ts";
import { WATCH_PHASE } from "../../watch/Watcher.ts";
import { buildPrompt, renderConventions, replaceSection, stackExpertNames } from "../prompt.ts";
import { loadExpertBundles } from "../../experts/expertBundle.ts";
import { agentDir } from "../paths.ts";
import { promptPath, readResult, writeBundle, writeRaw, PendingError, type PendingStage } from "../pending.ts";
import { spawnAgent } from "../spawnAgent.ts";
import type { ExecutorContext, ExecutorOutcome, ExecutorTask } from "./index.ts";

export const HANDOFF_REL = `${WATCH_PHASE}/handoff.md`;

/**
 * `[assumption]` — spec §5 gives one task the whole stage budget because v0 runs
 * one task. Watch runs N, so the ceiling is shared N ways, with a floor: measured
 * 2026-08-29 (spec §7), a cold `claude -p` pays 10–26k cache-creation tokens
 * before its first reply, so anything under ~$0.25 fails as `error_max_budget_usd`
 * before work starts. A share below the floor is a failed spawn, not a saving.
 */
export const MIN_AGENT_USD = 0.25;

/**
 * `attended_by: host` and a headless invocation: refuse, spawn nothing.
 *
 * `refused: true` rather than a failure — the stage goes back to `ready` and the
 * operator fixes it by using the other half of the handshake (spec §3 exit 2).
 * `runNext` refuses this before an executor is reached; this is the second layer,
 * for the day a fork replaces the Watch phase with an executor of its own.
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

export async function watchExecutor(ctx: ExecutorContext): Promise<ExecutorOutcome> {
  // Before a feature is collected and long before a prompt: a host-driven run
  // never spawns one sub-agent per shipped feature behind the host's back.
  if (ctx.attendedByHost && ctx.mode === "headless") return attendedRefusal(ctx);
  const features = collectFeatures(ctx.runDir);

  if (features.length === 0) {
    // Nothing shipped. The stage still COMPLETES — and says why, with a source.
    writeHandoff(ctx, []);
    return {
      ok: true,
      awaiting: false,
      tasks: [],
      costUsd: 0,
      outputs: [HANDOFF_REL],
      lines: [
        `${ctx.phaseId}/${ctx.stageId}: no story reached \`status: done\` — no feature shipped, so no watcher was written`,
        `wrote ${HANDOFF_REL} (\`- none [src: absent:${PLAN_PHASE}/stories]\`)`,
      ],
      error: null,
    };
  }

  // Before a single prompt is assembled, let alone spawned: if every feature
  // cannot get the floor inside the stage ceiling, refuse and say by how much.
  const overrun = floorOverrun(ctx, features.length);
  if (overrun !== null) {
    return {
      ok: false, awaiting: false, tasks: [], costUsd: 0, outputs: [],
      lines: [overrun], error: null, refused: true,
    };
  }

  const prompts = await Promise.all(features.map((feature) => featurePrompt(ctx, feature)));

  if (ctx.mode === "prepare") return prepare(ctx, features, prompts);

  const tasks: ExecutorTask[] = [];
  if (ctx.mode === "commit") {
    const collected = collectResults(ctx, features);
    if (collected.error !== null) return failed(ctx, collected.error, collected.tasks);
    tasks.push(...collected.tasks);
  } else {
    for (const [i, feature] of features.entries()) {
      const outcome = await spawnAgent({
        prompt: prompts[i] ?? "",
        model: ctx.model ?? ctx.spec.planned.model,
        effort: ctx.effort,
        maxBudgetUsd: agentShare(ctx, features.length),
        workspaceCommands: [...loadWorkspace(ctx.root).commands],
        yolo: ctx.yolo,
        cwd: ctx.root,
        timeoutMs: ctx.spec.planned.timeout_s * 1000,
      });
      if (outcome.raw !== "") writeRaw(ctx.runDir, taskKey(ctx, feature), outcome.raw);
      tasks.push({
        key: feature.id,
        model: ctx.model ?? ctx.spec.planned.model,
        costUsd: round2(outcome.costUsd),
        sessionId: outcome.sessionId,
        error: outcome.error,
        outputs: outcome.envelope?.outputs ?? [],
      });
      if (!outcome.ok) {
        return failed(ctx, `\`${feature.id}\`: ${outcome.error ?? "the sub-agent failed"}`, tasks);
      }
    }
  }

  // --- validate every card off disk, then stamp its status ------------------
  const srcCtx = toSrcContext(loadWorkspace(ctx.root), ctx.runDir);
  const written: WrittenCard[] = [];
  for (const feature of features) {
    const rel = watcherRelPath(feature.id);
    const abs = join(ctx.runDir, rel);
    if (!existsSync(abs)) {
      return failed(ctx, `\`${feature.id}\`: ${rel} was never written`, tasks);
    }
    const text = readFileSync(abs, "utf8");
    const card = parseWatcherCard(text, srcCtx, feature.id);
    if (!card.ok) {
      return failed(
        ctx,
        `\`${feature.id}\`: ${rel} does not validate — ${describeWatcherIssues(card.issues, 3).join(" ").trim()}`,
        tasks,
      );
    }
    const stamped = setWatcherStatus(text, card.decidedStatus);
    if (stamped !== text) writeFileSync(abs, stamped, "utf8");
    written.push({ feature, path: rel, card });
  }

  writeHandoff(ctx, written, tasks.reduce((sum, task) => sum + task.costUsd, 0));

  const verified = written.filter((w) => w.card.decidedStatus === "verified").length;
  return {
    ok: true,
    awaiting: false,
    tasks,
    costUsd: round2(tasks.reduce((sum, task) => sum + task.costUsd, 0)),
    outputs: [...written.map((w) => w.path), HANDOFF_REL],
    lines: [
      `${ctx.phaseId}/${ctx.stageId}: ${String(written.length)} watcher card(s) — `
        + `${String(verified)} verified, ${String(written.length - verified)} draft`,
      ...written.map((w) =>
        `  ${w.card.decidedStatus === "verified" ? "✓" : "·"} ${w.feature.id} (${w.feature.epicId}) — ${w.card.decidedStatus}`,
      ),
      `wrote ${HANDOFF_REL}`,
    ],
    error: null,
  };
}

// --- the two in-session halves ---------------------------------------------

/**
 * `--prepare`, per feature. Each card gets its own `.agent/<stage>/<feature>/`
 * bundle, so the host session dispatches N sub-agents and each one is told about
 * exactly one feature — the same isolation the headless path gives them.
 */
function prepare(
  ctx: ExecutorContext,
  features: readonly Feature[],
  prompts: readonly string[],
): ExecutorOutcome {
  const lines: string[] = [
    `prepared ${ctx.phaseId}/${ctx.stageId} — ${String(features.length)} feature(s), one sub-agent each `
      + `($${agentShare(ctx, features.length).toFixed(2)} ceiling each)`,
  ];
  for (const [i, feature] of features.entries()) {
    const key = taskKey(ctx, feature);
    const rel = watcherRelPath(feature.id);
    const pending: PendingStage = {
      version: 1,
      run: ctx.runId,
      phase: ctx.phaseId,
      stage: ctx.stageId,
      expert: ctx.spec.planned.experts[0] ?? null,
      model: ctx.model ?? ctx.spec.planned.model,
      effort: ctx.effort,
      budget_usd: ctx.budgetUsd,
      max_budget_usd: agentShare(ctx, features.length),
      prompt: relative(ctx.runDir, promptPath(ctx.runDir, key)),
      outputs: [rel],
      sections: { [rel]: [] },
      checks: ctx.spec.planned.checks,
      prepared_at: ctx.at,
    };
    writeBundle(ctx.runDir, key, prompts[i] ?? "", pending);
    lines.push(`  ${feature.id}: ${relative(ctx.root, agentDir(ctx.runDir, key))}/prompt.md → writes ${rel}`);
  }
  lines.push(
    `each sub-agent writes {outputs, questions_asked, notes} to its own result.json, then run \`tldrx next --commit\``,
  );
  return { ok: true, awaiting: true, tasks: [], costUsd: 0, outputs: [], lines, error: null };
}

/** `--commit`: one `result.json` per feature, read before anything is validated. */
function collectResults(
  ctx: ExecutorContext,
  features: readonly Feature[],
): { tasks: ExecutorTask[]; error: string | null } {
  const tasks: ExecutorTask[] = [];
  for (const feature of features) {
    try {
      const result = readResult(ctx.runDir, taskKey(ctx, feature));
      tasks.push({
        key: feature.id,
        model: ctx.model ?? ctx.spec.planned.model,
        costUsd: round2(result.cost_usd ?? 0),
        sessionId: result.session_id,
        error: null,
        outputs: result.outputs,
      });
    } catch (error) {
      if (error instanceof PendingError) return { tasks, error: `\`${feature.id}\`: ${error.message}` };
      throw error;
    }
  }
  return { tasks, error: null };
}

// --- prompt ----------------------------------------------------------------

async function featurePrompt(ctx: ExecutorContext, feature: Feature): Promise<string> {
  const diffs = await featureDiffs(ctx, feature);
  const facts = FactsStore.loadOrEmpty(factsPath(ctx.root)).facts;
  const stageMd = readOrEmpty(ctx.spec.planned.source.replace(/stage\.yml$/, "stage.md"));
  const bundles = loadExpertBundles({
    root: ctx.root,
    staged: ctx.spec.planned.experts,
    repos: feature.repos,
    stackExperts: ctx.spec.stackExperts,
    stackNames: stackExpertNames(ctx.root, feature.repos),
    citedPaths: feature.stories.flatMap((done) => done.story.touches),
    knowledgeBytes: ctx.spec.knowledgeMaxBytes,
  });
  const body = buildPrompt({
    stageMd,
    values: {
      run: ctx.runId,
      repos: feature.repos.length === 0 ? "(none)" : feature.repos.join(", "),
      inputs: "(replaced below)",
      facts: "(inlined under Inputs)",
      conventions: renderConventions(ctx.root, feature.repos),
      budget_usd: agentShare(ctx, 1).toFixed(2),
    },
    experts: bundles.experts,
    inputs: featureInputs({ root: ctx.root, runDir: ctx.runDir, feature, diffs, facts }),
  });
  return replaceSection(body, "Feature", featureBrief(feature));
}

/** The epic branch against each repo's default branch, read-only. */
async function featureDiffs(ctx: ExecutorContext, feature: Feature): Promise<readonly RepoDiff[]> {
  const bases = readRepoBases(ctx.root);
  const branch = feature.epic?.branch ?? "";
  const diffs: RepoDiff[] = [];
  for (const repo of feature.repos) {
    const base = bases.get(repo);
    if (base === undefined) continue;
    diffs.push(await epicDiff({ repo, dir: join(ctx.root, base.path), base: base.defaultBranch, branch }));
  }
  return diffs;
}

// --- odds and ends ---------------------------------------------------------

function writeHandoff(ctx: ExecutorContext, cards: readonly WrittenCard[], costUsd = 0): void {
  const abs = join(ctx.runDir, HANDOFF_REL);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    renderWatchHandoff(cards, {
      runId: ctx.runId,
      stageId: ctx.stageId,
      experts: ctx.spec.planned.experts,
      model: ctx.model ?? ctx.spec.planned.model,
      costUsd,
      budgetUsd: ctx.budgetUsd,
      at: ctx.at,
    }),
    "utf8",
  );
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

/** `.agent/<stage>/<feature>/` — one bundle per sub-agent, never one per stage. */
function taskKey(ctx: ExecutorContext, feature: Feature): string {
  return join(ctx.stageId, feature.id);
}

/**
 * The per-feature ceiling — a share of the stage budget, with a floor.
 *
 * The floor is real (a spawn under ~$0.25 fails before it works) but it used to be
 * applied blind: with N features and a small stage ceiling, `N × MIN_AGENT_USD`
 * could exceed the ceiling the floor was supposed to sit inside, and the phase
 * quietly overran (audit §A, `watch.ts:298`). `fitsFloor` below is the check that
 * catches it BEFORE anything spawns; this function keeps the floor for the case
 * where it does fit.
 */
function agentShare(ctx: ExecutorContext, features: number): number {
  const share = features <= 1 ? ctx.maxBudgetUsd : ctx.maxBudgetUsd / features;
  return round2(Math.max(MIN_AGENT_USD, share));
}

/**
 * Can N features each get the floor without the stage ceiling being overrun?
 *
 * Null when they can. A string when they cannot — the refusal, naming the numbers
 * and the command that fixes it, so the operator is not left to work out how much
 * to add.
 */
export function floorOverrun(ctx: ExecutorContext, features: number): string | null {
  const needed = round2(features * MIN_AGENT_USD);
  if (needed <= ctx.budgetUsd + 0.001) return null;
  const short = round2(Math.ceil((needed - ctx.budgetUsd) * 100) / 100);
  return (
    `${ctx.phaseId}/${ctx.stageId} refuses to start: ${features} feature(s) need at least `
    + `$${MIN_AGENT_USD.toFixed(2)} each ($${needed.toFixed(2)} in total) and the stage ceiling is `
    + `$${ctx.budgetUsd.toFixed(2)}. A spawn under the floor fails as \`error_max_budget_usd\` before it `
    + `does any work, so splitting it further would just buy N failures. `
    + `Run \`tldrx budget raise ${ctx.phaseId} ${short.toFixed(2)}\` (add \`--take-from <phase>\` to move `
    + "the money instead of adding it), or ship fewer features in one run."
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
