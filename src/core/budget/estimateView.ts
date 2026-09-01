/**
 * `tldrx run estimate` — what the NEXT stage is likely to cost, said as a guess.
 *
 * Four terms, and they are honest in different ways:
 *
 *  - **The input side is measured.** The prompt is assembled exactly as `next`
 *    would assemble it (same declared inputs, same experts, same budgets) and
 *    weighed with the same context ledger, so the byte count is not a model of
 *    the prompt — it IS the prompt. Only the bytes-to-tokens ratio is assumed.
 *  - **Cache write, cache read and output are guesses with a stated basis:** the
 *    MEDIAN of each counter over past attempts at a stage with this id anywhere
 *    in this workspace, falling back to past attempts at ANY stage, and saying
 *    which of the two it used. With no history at all there is no estimate for
 *    those three, and the report says so rather than substituting a number
 *    nobody measured.
 *
 * **Why cache is in here at all.** It was not, and that was the bug. A What stage
 * was estimated at $0.33; the one comparable real attempt cost $1.70 — 5x. Its
 * ledger: 56 input · 29.0k output · 166.3k cache write · 3,747.1k cache read.
 * Pricing input + output only, this command was adding up the two columns the
 * money was NOT in. The counters had been recorded on every `agent.result` since
 * wave N and `modelPrices.ts` had carried the multipliers the whole time; nothing
 * here needed new data, only arithmetic that used it.
 *
 * The input term and the cache-write term OVERLAP on a first turn — bytes sent
 * cold are billed as cache creation, not as fresh input — so a cold stage's total
 * leans high by roughly the prompt. That is the safe direction for a ceiling, and
 * it is stated rather than silently corrected: the honest fix is a measurement of
 * cache lifetime, which this repo does not have.
 *
 * **What is LEFT, not what a stage was priced at (issue #21).** The four terms
 * above answer "what will the next TURN cost". They are silent about the other
 * half of the same question — how much of this stage, and of this run, is still
 * to be paid for — and until 2026-08-31 this command answered that with nothing
 * at all while the budget brake answered it with `remainingWork()`. Two models,
 * one question, and the one people read was the one that never shrank: a Build
 * stage with five of six stories done was still quoted the number the Plan wrote
 * before any of them ran. So the SAME function the brake and `budget show` call
 * is called here — not a second implementation of it — and its answer is
 * reported beside the token estimate:
 *
 *  - `remaining` is the stage-level figure. On a Build stage with a plan it is
 *    the sum of the caps the executor would still hand out, done stories excluded
 *    and blocked ones named; everywhere else it is the stage's static
 *    `budget_usd`, and it says which of the two it is.
 *  - `runRemaining` is the run-level roll-up: the stages that are not terminal,
 *    and what they are priced at. A finished stage contributes nothing, which is
 *    the whole of what "remaining-work aware" means one level up.
 *
 * Neither of them is a token estimate and neither pretends to be. They are read
 * off `run.yml`, the plan and the ledger — measured numbers about work that has
 * not happened yet, which is a different kind of claim from a median.
 *
 * Prices come from `modelPrices.ts`, which is `[assumption]` and dated. This
 * command therefore prints "estimate" in words, next to the number, every time —
 * `tldrx cost` is where the real figures live, and the two must never be confused
 * by anyone reading a terminal in a hurry.
 */
import { PresetError } from "../run/workflowPreset.ts";
import { RunStore } from "../run/RunStore.ts";
import { flatten, isTerminal } from "../run/RunFile.ts";
import { loadStageSpec } from "../facilitator/stageSpec.ts";
import { assemblePrompt, declaredInputsOf, seedInputsFor } from "../facilitator/runNext.ts";
import type { ContextLedger } from "../facilitator/contextLedger.ts";
import { attemptTokensForStage, median } from "./costView.ts";
import { economyFor, type Economy } from "./RunBudget.ts";
import {
  remainingWork, renderRemainingWork, remainingWorkContext, type RemainingWork,
} from "./remainingWork.ts";
import {
  estimateTokensFromBytes, priceFor, BYTES_PER_TOKEN,
  CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER,
} from "./modelPrices.ts";

/** Which attempts the medians came from. `none` is "say so", never "assume zero". */
export type HistoryBasis = "stage" | "workspace" | "none";

export interface StageEstimate {
  readonly run: string;
  readonly phase: string;
  readonly stage: string;
  readonly model: string | null;
  readonly ledger: ContextLedger;
  readonly promptBytes: number;
  readonly promptTokens: number;
  /** Median output tokens of the attempts named by `historyBasis`. Null with no history. */
  readonly medianOutputTokens: number | null;
  /** Median cache-WRITE tokens of those same attempts. Null with no history. */
  readonly medianCacheWriteTokens: number | null;
  /** Median cache-READ tokens of those same attempts. Null with no history. */
  readonly medianCacheReadTokens: number | null;
  readonly historyBasis: HistoryBasis;
  readonly sampleSize: number;
  /**
   * What this stage's phase is priced in (spec §2.11). Under `host-tokens` every
   * USD field below is null — the tokens are estimated exactly as before and are
   * simply never converted, because there is no rate to convert them at.
   */
  readonly economy: Economy;
  /**
   * What this STAGE still has to pay for, from the same `remainingWork()` the
   * budget brake and `budget show` use (issue #21). `basis: "plan"` on a Build
   * stage with a plan on disk — done stories excluded, blocked ones named;
   * `basis: "static"` everywhere else, carrying `stage.budget_usd`.
   */
  readonly remaining: RemainingWork;
  /** What the RUN still has to pay for: the stages that are not terminal. */
  readonly runRemaining: RunRemaining;
  /** Null when the model has no priced row, or there is no history. */
  readonly usd: number | null;
  readonly inputUsd: number | null;
  readonly cacheWriteUsd: number | null;
  readonly cacheReadUsd: number | null;
  readonly outputUsd: number | null;
}

/**
 * The stages a run has not finished, and what they are priced at.
 *
 * Deliberately the STATIC prices rather than a projection: a stage that has never
 * run has no history to be remaining-work aware ABOUT, and `budget_usd` is the
 * number its own budget was sized on. The one narrowing is the stage the cursor
 * is on, which `remaining` may already know more about — see `usd` below.
 */
export interface RunRemaining {
  /** `<phase>/<stage>` of every stage still to run, in execution order. */
  readonly stages: readonly string[];
  /** Stages already terminal, and therefore excluded. */
  readonly done: number;
  /** Σ `budget_usd` over `stages`. */
  readonly staticUsd: number;
  /** The same sum with the cursor stage narrowed by `remaining`, when it could be. */
  readonly usd: number;
}

export class EstimateError extends Error {}

export function estimateNextStage(root: string, runId?: string): StageEstimate {
  const resolution = RunStore.resolve(root, runId);
  if (resolution.kind !== "one") {
    throw new EstimateError(
      resolution.kind === "none"
        ? "no run to estimate — name one with `tldrx run estimate <run>`"
        : "several runs are open — name the one you mean: `tldrx run estimate <run>`",
    );
  }
  const store = resolution.store;
  const { phase: phaseId, stage: stageId } = store.run.cursor;
  const phase = store.run.phases.find((p) => p.id === phaseId);
  const stage = phase?.stages.find((s) => s.id === stageId);
  if (stage === undefined) {
    throw new EstimateError(`the cursor points at ${phaseId}/${stageId}, which is not in run.yml`);
  }

  let spec;
  try {
    spec = loadStageSpec(root, store.run.workflow, stageId);
  } catch (error) {
    throw error instanceof PresetError ? new EstimateError(error.message) : error;
  }

  const ctx = { root, runDir: store.runDir };
  // The same assembly `next` runs, with nothing written and nothing spawned.
  const options = {
    root, dryRun: true, mode: "prepare" as const, yolo: false,
    actor: "estimate", at: new Date(0).toISOString(),
  };
  const inputs = declaredInputsOf(store, spec, stage, ctx);
  const assembled = assemblePrompt(
    store, options, spec, stage, inputs, ctx, new Set(seedInputsFor(spec, stage, ctx)),
  );

  const model = stage.model ?? spec.planned.model;
  const promptBytes = assembled.ledger.totalBytes;
  const promptTokens = estimateTokensFromBytes(promptBytes);

  // Same stage kind first; anything in the workspace second; then nothing, said
  // out loud. A median over other stages is a worse basis than a median over
  // this one, which is exactly why the report names which it used.
  const sameKind = attemptTokensForStage(root, stageId);
  const history = sameKind.length > 0 ? sameKind : attemptTokensForStage(root, null);
  const basis: HistoryBasis = sameKind.length > 0
    ? "stage"
    : history.length > 0 ? "workspace" : "none";

  const medianOutput = median(history.map((t) => t.output));
  const medianCacheWrite = median(history.map((t) => t.cacheCreation));
  const medianCacheRead = median(history.map((t) => t.cacheRead));
  const price = priceFor(model);

  const inputUsd = price === null ? null : perMTok(promptTokens, price.inputUsdPerMTok);
  const cacheWriteUsd = price === null || medianCacheWrite === null
    ? null
    : perMTok(medianCacheWrite, price.inputUsdPerMTok * CACHE_WRITE_MULTIPLIER);
  const cacheReadUsd = price === null || medianCacheRead === null
    ? null
    : perMTok(medianCacheRead, price.inputUsdPerMTok * CACHE_READ_MULTIPLIER);
  const outputUsd = price === null || medianOutput === null
    ? null
    : perMTok(medianOutput, price.outputUsdPerMTok);

  // A `host-tokens` phase is not priced in dollars, so this command does not
  // produce one for it (design §E.2). The token medians are the estimate; the
  // conversion is the guess, and it is the guess the label exists to refuse.
  const economy = economyFor(store.budget, phaseId);
  const complete = economy === "metered-usd" && inputUsd !== null && cacheWriteUsd !== null
    && cacheReadUsd !== null && outputUsd !== null;
  const priced = economy === "metered-usd";

  // The SAME call the brake makes (`runNext.stageRemainingWork`) and `budget
  // show`'s `est.` column makes, with the same inputs. An operator told one
  // number by a refusal and a different one by this command would rightly trust
  // neither — which is exactly the state #21 was filed about.
  const work = remainingWork({
    runDir: store.runDir,
    phaseId,
    stageBudgetUsd: stage.budget_usd,
    stageSpentUsd: stage.cost_usd,
    perAgentMaxUsd: store.budget.per_agent_max_usd,
    // No `--max-usd` here: this command spawns nothing, so there is no per-turn
    // ceiling of its own to fold in. `run auto --max-usd` narrows the brake, not
    // the report of what is left.
    maxUsd: null,
    economy,
  });

  return {
    run: store.run.run,
    phase: phaseId,
    stage: stageId,
    model,
    ledger: assembled.ledger,
    promptBytes,
    promptTokens,
    medianOutputTokens: medianOutput,
    medianCacheWriteTokens: medianCacheWrite,
    medianCacheReadTokens: medianCacheRead,
    historyBasis: basis,
    sampleSize: history.length,
    economy,
    remaining: work,
    runRemaining: runRemainingOf(store, phaseId, stageId, work),
    usd: complete
      ? round((inputUsd ?? 0) + (cacheWriteUsd ?? 0) + (cacheReadUsd ?? 0) + (outputUsd ?? 0))
      : null,
    inputUsd: priced && inputUsd !== null ? round(inputUsd) : null,
    cacheWriteUsd: priced && cacheWriteUsd !== null ? round(cacheWriteUsd) : null,
    cacheReadUsd: priced && cacheReadUsd !== null ? round(cacheReadUsd) : null,
    outputUsd: priced && outputUsd !== null ? round(outputUsd) : null,
  };
}

/**
 * The run-level roll-up: the stages that are not terminal, and what they cost.
 *
 * `isTerminal` is the same predicate `run status` counts its bars with, so a
 * stage this excludes is one that screen already shows as finished. The cursor
 * stage's contribution is `remaining.usd` when the plan gave a narrower answer
 * than `budget_usd` — that is the one stage this process knows more about than
 * the Plan did, and using the wider number there would put the run-level figure
 * at odds with the stage-level one printed two lines above it.
 */
function runRemainingOf(
  store: RunStore,
  phaseId: string,
  stageId: string,
  work: RemainingWork,
): RunRemaining {
  const stages: string[] = [];
  let staticUsd = 0;
  let usd = 0;
  let done = 0;
  for (const entry of flatten(store.run)) {
    if (isTerminal(entry.stage.status)) {
      done += 1;
      continue;
    }
    stages.push(`${entry.phase.id}/${entry.stage.id}`);
    staticUsd += entry.stage.budget_usd;
    const isCursor = entry.phase.id === phaseId && entry.stage.id === stageId;
    usd += isCursor && work.basis === "plan" ? work.usd : entry.stage.budget_usd;
  }
  return { stages, done, staticUsd: round(staticUsd), usd: round(usd) };
}

export function renderEstimate(estimate: StageEstimate): string {
  const lines = [
    `${estimate.run} · next stage ${estimate.phase}/${estimate.stage} `
      + `· model ${estimate.model ?? "default"}`,
    `prompt ${estimate.promptBytes.toLocaleString("en-US")} B `
      + `≈ ${estimate.promptTokens.toLocaleString("en-US")} input tokens `
      + `[measured bytes; ~${String(BYTES_PER_TOKEN)} B/token is an assumption]`,
  ];
  if (estimate.historyBasis === "none") {
    lines.push(
      "output: no past attempt at a stage with this id in this workspace, so there is no",
      "basis for the output half. Run the stage once and the estimate becomes possible.",
      "cache traffic not modelled — first attempt of this kind",
    );
  } else {
    lines.push(basisLine(estimate), breakdown(estimate));
  }
  lines.push(...remainingLines(estimate));
  if (estimate.economy === "host-tokens") {
    lines.push(
      `ESTIMATE: ${ktok(estimate.promptTokens)} input `
      + `+ ${ktok(estimate.medianCacheWriteTokens ?? 0)} cache write `
      + `+ ${ktok(estimate.medianCacheReadTokens ?? 0)} cache read `
      + `+ ${ktok(estimate.medianOutputTokens ?? 0)} out TOKENS. `
      + "This phase is priced in `host-tokens`, so there is no dollar figure here and none is "
      + "computed: the turn is billed to the host session, which this process does not meter. "
      + "Converting would need an exchange rate nobody here has.",
    );
  } else if (estimate.usd === null) {
    lines.push(
      `ESTIMATE: unavailable — ${estimate.historyBasis === "none"
        ? "no output history"
        : `no priced row for model \`${estimate.model ?? "default"}\``}.`,
    );
  } else {
    lines.push(
      `ESTIMATE: $${estimate.usd.toFixed(2)} `
      + `($${(estimate.inputUsd ?? 0).toFixed(2)} in `
      + `+ $${(estimate.cacheWriteUsd ?? 0).toFixed(2)} cache write `
      + `+ $${(estimate.cacheReadUsd ?? 0).toFixed(2)} cache read `
      + `+ $${(estimate.outputUsd ?? 0).toFixed(2)} out). `
      + "This is an ESTIMATE, not a price: list prices in src/core/budget/modelPrices.ts are "
      + "an [assumption] dated 2026-08-29, the cache multipliers (write 1.25x, read 0.1x) with "
      + "them, and a stage that reads more than it was given costs more than this. "
      + "`tldrx cost` reports what was actually charged.",
    );
  }
  return lines.join("\n");
}

/**
 * What is LEFT — the half of the question the token medians do not answer.
 *
 * Two lines minimum: what this STAGE still has to pay for, and what the RUN still
 * has to run. The stage half only shows the arithmetic when there IS arithmetic
 * to show — on a `static` basis it is one number the stage file already carries,
 * and printing "remaining work: $6.00" for it would dress a declared estimate up
 * as a measurement.
 */
function remainingLines(estimate: StageEstimate): readonly string[] {
  const work = estimate.remaining;
  const run = estimate.runRemaining;
  const lines: string[] = [];
  if (work.basis === "plan") {
    lines.push(renderRemainingWork(work), ...remainingWorkContext(work).map((line) => `  ${line}`));
  } else {
    lines.push(
      `this stage is priced at $${work.staticUsd.toFixed(2)} \u2014 its declared budget_usd, `
      + "which is what it is until a plan gives something narrower to measure",
    );
  }
  if (run.stages.length === 0) {
    lines.push(`still to run: nothing \u2014 every stage of this run is terminal`);
    return lines;
  }
  lines.push(
    `still to run: ${String(run.stages.length)} stage(s) \u2014 ${run.stages.join(", ")} `
    + `\u00b7 $${run.usd.toFixed(2)} priced`
    + (run.done === 0 ? "" : ` (${String(run.done)} already terminal, excluded)`),
  );
  return lines;
}

/** Names the sample the three medians came from — never leaves it to be assumed. */
function basisLine(estimate: StageEstimate): string {
  const n = `${String(estimate.sampleSize)} past attempt(s)`;
  return estimate.historyBasis === "stage"
    ? `cache and output: medians of ${n} at \`${estimate.stage}\` here`
    : `cache and output: no past attempt at \`${estimate.stage}\`, so medians of ${n} `
      + "at ANY stage here — a weaker basis, stated as one";
}

function breakdown(estimate: StageEstimate): string {
  const tokens = `input ${ktok(estimate.promptTokens)} `
    + `· cache write ${ktok(estimate.medianCacheWriteTokens ?? 0)} `
    + `· cache read ${ktok(estimate.medianCacheReadTokens ?? 0)} `
    + `· output ${ktok(estimate.medianOutputTokens ?? 0)}`;
  return estimate.usd === null
    ? `${tokens} → unpriced (no row for model \`${estimate.model ?? "default"}\`)`
    : `${tokens} → ~$${estimate.usd.toFixed(2)}`;
}

function perMTok(tokens: number, usdPerMTok: number): number {
  return (tokens / 1_000_000) * usdPerMTok;
}

/** `~166k`, `~3,747k` — thousands, because these are medians, not measurements. */
function ktok(n: number): string {
  return n < 1000
    ? `~${String(Math.round(n))}`
    : `~${Math.round(n / 1000).toLocaleString("en-US")}k`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
