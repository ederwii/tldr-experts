/**
 * `tldrx run estimate` — what the NEXT stage is likely to cost, said as a guess.
 *
 * Two halves, and they are honest in different ways:
 *
 *  - **The input side is measured.** The prompt is assembled exactly as `next`
 *    would assemble it (same declared inputs, same experts, same budgets) and
 *    weighed with the same context ledger, so the byte count is not a model of
 *    the prompt — it IS the prompt. Only the bytes-to-tokens ratio is assumed.
 *  - **The output side is a guess with a stated basis:** the MEDIAN output
 *    tokens of every past attempt at a stage with this id anywhere in this
 *    workspace. With no history there is no estimate for that half, and the
 *    report says so rather than substituting a number nobody measured.
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
import { median, outputTokensForStage } from "./costView.ts";
import { estimateTokensFromBytes, priceFor, BYTES_PER_TOKEN } from "./modelPrices.ts";

export interface StageEstimate {
  readonly run: string;
  readonly phase: string;
  readonly stage: string;
  readonly model: string | null;
  readonly ledger: ContextLedger;
  readonly promptBytes: number;
  readonly promptTokens: number;
  /** Median output tokens of past attempts at this stage id. Null with no history. */
  readonly medianOutputTokens: number | null;
  readonly sampleSize: number;
  /** Null when the model has no priced row, or there is no output history. */
  readonly usd: number | null;
  readonly inputUsd: number | null;
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
  const history = outputTokensForStage(root, stageId);
  const medianOutput = median(history);
  const price = priceFor(model);

  const inputUsd = price === null ? null : (promptTokens / 1_000_000) * price.inputUsdPerMTok;
  const outputUsd = price === null || medianOutput === null
    ? null
    : (medianOutput / 1_000_000) * price.outputUsdPerMTok;

  return {
    run: store.run.run,
    phase: phaseId,
    stage: stageId,
    model,
    ledger: assembled.ledger,
    promptBytes,
    promptTokens,
    medianOutputTokens: medianOutput,
    sampleSize: history.length,
    usd: inputUsd === null || outputUsd === null ? null : round(inputUsd + outputUsd),
    inputUsd: inputUsd === null ? null : round(inputUsd),
    outputUsd: outputUsd === null ? null : round(outputUsd),
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
  if (estimate.medianOutputTokens === null) {
    lines.push(
      "output: no past attempt at a stage with this id in this workspace, so there is no",
      "basis for the output half. Run the stage once and the estimate becomes possible.",
    );
  } else {
    lines.push(
      `output ≈ ${estimate.medianOutputTokens.toLocaleString("en-US")} tokens `
      + `(median of ${String(estimate.sampleSize)} past attempt(s) at \`${estimate.stage}\` here)`,
    );
  }
  if (estimate.usd === null) {
    lines.push(
      `ESTIMATE: unavailable — ${estimate.medianOutputTokens === null
        ? "no output history"
        : `no priced row for model \`${estimate.model ?? "default"}\``}.`,
    );
  } else {
    lines.push(
      `ESTIMATE: $${estimate.usd.toFixed(2)} `
      + `($${(estimate.inputUsd ?? 0).toFixed(2)} in + $${(estimate.outputUsd ?? 0).toFixed(2)} out). `
      + "This is an ESTIMATE, not a price: list prices in src/core/budget/modelPrices.ts are "
      + "an [assumption] dated 2026-08-29, and a stage that reads more than it was given "
      + "costs more than this. `tldrx cost` reports what was actually charged.",
    );
  }
  return lines.join("\n");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
