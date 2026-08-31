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
 * Prices come from `modelPrices.ts`, which is `[assumption]` and dated. This
 * command therefore prints "estimate" in words, next to the number, every time —
 * `tldrx cost` is where the real figures live, and the two must never be confused
 * by anyone reading a terminal in a hurry.
 */
import { PresetError } from "../run/workflowPreset.ts";
import { RunStore } from "../run/RunStore.ts";
import { loadStageSpec } from "../facilitator/stageSpec.ts";
import { assemblePrompt, declaredInputsOf, seedInputsFor } from "../facilitator/runNext.ts";
import type { ContextLedger } from "../facilitator/contextLedger.ts";
import { attemptTokensForStage, median } from "./costView.ts";
import { economyFor, type Economy } from "./RunBudget.ts";
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
  /** Null when the model has no priced row, or there is no history. */
  readonly usd: number | null;
  readonly inputUsd: number | null;
  readonly cacheWriteUsd: number | null;
  readonly cacheReadUsd: number | null;
  readonly outputUsd: number | null;
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
    usd: complete
      ? round((inputUsd ?? 0) + (cacheWriteUsd ?? 0) + (cacheReadUsd ?? 0) + (outputUsd ?? 0))
      : null,
    inputUsd: priced && inputUsd !== null ? round(inputUsd) : null,
    cacheWriteUsd: priced && cacheWriteUsd !== null ? round(cacheWriteUsd) : null,
    cacheReadUsd: priced && cacheReadUsd !== null ? round(cacheReadUsd) : null,
    outputUsd: priced && outputUsd !== null ? round(outputUsd) : null,
  };
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
