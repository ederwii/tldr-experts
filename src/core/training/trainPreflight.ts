/**
 * Before a training run spawns anything: can this mode, on THIS model, against
 * THIS ceiling, possibly finish?
 *
 * **What happened (#96, live 2026-09-02).** `tldrx expert train discoverer
 * --area discoverer --mode full` inherited the claude CLI's last-used model —
 * `fable-5`, a premium tier — and ran against the DEFAULT ceiling. Full mode
 * splits that ceiling between its two sub-agents (`runTraining.ts`), so the code
 * pass was handed $1.00. It was killed with `Reached maximum budget ($1)` at
 * 54 s, after **$1.31 was spent and recorded, with nothing written to
 * competencies.yml**. Three defaults compounded and not one of them was said out
 * loud before the money: the model was inherited, the ceiling was a number
 * measured for a different tier, and a budget death discards everything.
 *
 * This module is the sentence that was missing. It is PURE — it reads no clock,
 * no disk and no environment; the caller hands it what it resolved — so the
 * refusal is a unit test rather than a live invoice.
 *
 * **Why a refusal and not a smaller default.** `--max-budget-usd` is a stop
 * after the turn a sub-agent is already in, not a cap on it (spec §2.6.1: a
 * $1.50 ceiling realised $5.15 on a 1M-context model). Lowering a number cannot
 * make a premium turn cheaper; only not starting it can. And the remedy is two
 * words long, which is the test for whether a refusal is fair: `--model sonnet`
 * trains on the tier the default was measured for, `--max-usd <n>` says the
 * operator has looked at the number and chosen it anyway.
 *
 * **An explicit `--max-usd` is never refused.** The owner typed a ceiling; that
 * is the whole decision this module exists to ask for. It warns in one line and
 * proceeds.
 */
import { DEFAULT_FULL_TRAIN_USD, MEASURED_FULL_TRAIN_USD, type TrainingMode } from "./Training.ts";

/**
 * The tier a model name belongs to, for the one question asked here: is the
 * ceiling in force a number that was ever measured for this class of model?
 *
 * `unknown` is a real answer and is treated as one: a model this table has never
 * heard of gets a stated "tier unknown", never a refusal. Refusing on a guess
 * would be the same mistake in the other direction.
 */
export type ModelTier = "premium" | "mid" | "economy" | "unknown";

/** Longest match wins, exactly as `priceFor` resolves a price. */
const TIERS: readonly { readonly family: string; readonly tier: ModelTier }[] = [
  { family: "opus", tier: "premium" },
  { family: "fable", tier: "premium" },
  { family: "sonnet", tier: "mid" },
  { family: "haiku", tier: "economy" },
];

export function modelTier(model: string | null): ModelTier {
  if (model === null || model === "") return "unknown";
  const name = model.toLowerCase();
  let best: { family: string; tier: ModelTier } | null = null;
  for (const row of TIERS) {
    if (!name.includes(row.family)) continue;
    if (best === null || row.family.length > best.family.length) best = { ...row };
  }
  return best?.tier ?? "unknown";
}

/**
 * What one sub-agent pass costs on each tier, relative to the mid tier the
 * measured band was recorded on.
 *
 * Straight off the price table (`core/budget/modelPrices.ts`, list-priced
 * 2026-08-29): opus $5/$25 against sonnet's $2/$10 is 2.5x on both halves of the
 * row, haiku's $1/$5 is 0.5x. `[assumption]` for `fable`, which that table does
 * not price at all — it is read as premium on the strength of the one live
 * measurement there is (#96: $1.31 spent against a $1.00 share, in a single
 * turn).
 *
 * `unknown` deliberately has no multiplier. A model nothing here can price
 * yields no projection, and no projection means no refusal.
 */
export const TIER_MULTIPLIER: Readonly<Record<ModelTier, number | null>> = {
  premium: 2.5,
  mid: 1,
  economy: 0.5,
  unknown: null,
};

/**
 * What ONE sub-agent pass is expected to cost on this tier, in USD.
 *
 * `MEASURED_FULL_TRAIN_USD` is the cost of a full run END TO END, and a full run
 * on a code expert is two sub-agent passes — so half the MIDPOINT of that band is
 * one pass on a mid model, scaled by the tier. Today: $0.70 mid, $1.76 premium,
 * $0.35 economy.
 *
 * **The midpoint, deliberately, and not the lucky end of the band.** A ceiling
 * that only clears the cheapest run ever observed is a ceiling that fails on a
 * typical one, and the failure mode is not "it costs more" — it is
 * `error_max_budget_usd` with the money spent and the knowledge thrown away
 * (#96). Sizing on the best case would also make the refusal turn on a penny:
 * the optimistic figure lands at $1.51 against a $1.50 share, which is a coin
 * flip dressed as arithmetic.
 */
export function perAgentExpectedUsd(tier: ModelTier): number | null {
  const multiplier = TIER_MULTIPLIER[tier];
  if (multiplier === null) return null;
  const midpoint = (MEASURED_FULL_TRAIN_USD.low + MEASURED_FULL_TRAIN_USD.high) / 2;
  return (midpoint / 2) * multiplier;
}

/** What the model will be, and where that answer came from. */
export interface AmbientModel {
  /** The model name, as the setting spells it. */
  readonly model: string;
  /** Human-readable provenance, e.g. `~/.claude/settings.json`. */
  readonly source: string;
}

export interface PreflightInput {
  readonly mode: TrainingMode;
  /** How many sub-agents this run will spawn — the ceiling is split between them. */
  readonly agents: number;
  /** The ceiling in force, default or not. */
  readonly ceilingUsd: number;
  /** Did the operator type `--max-usd`? An explicit ceiling is never refused. */
  readonly ceilingExplicit: boolean;
  /** `--model`, or null when the sub-agent inherits whatever the CLI defaults to. */
  readonly model: string | null;
  /** What that inherited model resolves to, when it could be read. */
  readonly ambient: AmbientModel | null;
  /** False for `--prepare`/`--commit`, which spawn nothing here. */
  readonly spawns: boolean;
}

export interface TrainPreflight {
  /** The model the sub-agent will actually get, as far as this can be known. */
  readonly model: string | null;
  readonly tier: ModelTier;
  /** True when `model` came from the environment rather than `--model`. */
  readonly inherited: boolean;
  /** The one line printed before the money. Empty when nothing spawns. */
  readonly notice: readonly string[];
  /** Non-null ⇒ refuse, exit 2, spawn nothing. */
  readonly refusal: readonly string[] | null;
}

/**
 * The measured band, said the same way everywhere it is quoted so the number and
 * its provenance never drift apart.
 */
export function measuredBand(): string {
  return `$${MEASURED_FULL_TRAIN_USD.low.toFixed(2)}-$${MEASURED_FULL_TRAIN_USD.high.toFixed(2)}`;
}

export function trainPreflight(input: PreflightInput): TrainPreflight {
  const model = input.model ?? input.ambient?.model ?? null;
  const inherited = input.model === null && input.ambient !== null;
  const tier = modelTier(model);
  const base: Omit<TrainPreflight, "notice" | "refusal"> = { model, tier, inherited };

  if (!input.spawns) return { ...base, notice: [], refusal: null };

  const share = input.ceilingUsd / Math.max(1, input.agents);
  const expected = perAgentExpectedUsd(tier);
  // The whole test, and it is arithmetic rather than a category: does the share
  // this run can hand ONE sub-agent reach what a pass on this tier is expected to
  // cost? On the shipped full-mode default that is $1.50 against $1.76 for a
  // premium pass — it does not, which is why it is refused rather than warned
  // about. A role expert's full run spawns one sub-agent and keeps the whole
  // ceiling, so the same arithmetic lets it through.
  const cannotFit = expected !== null && share < expected;

  const named = describeModel(model, tier, inherited ? input.ambient : null);
  if (cannotFit && !input.ceilingExplicit) {
    return { ...base, notice: [], refusal: refusal(input, named, share, expected ?? 0) };
  }

  const money = `$${input.ceilingUsd.toFixed(2)} across ${String(input.agents)} sub-agent(s)`
    + `, $${share.toFixed(2)} each`;
  const notice = [`${named} · --mode ${input.mode} · ${money}`];
  if (cannotFit) {
    notice.push(
      `warning: $${share.toFixed(2)} per sub-agent is under the $${(expected ?? 0).toFixed(2)} one`
      + ` ${tier} pass is expected to cost (${measuredBand()} end to end on a mid model,`
      + ` x${String(TIER_MULTIPLIER[tier] ?? 1)} for this tier) — and --max-budget-usd stops a turn,`
      + " it does not cap one. You passed --max-usd, so this proceeds.",
    );
  }
  return { ...base, notice, refusal: null };
}

/**
 * `model fable-5 (premium, inherited from your claude CLI via …) — pass --model
 * to override`, or `model sonnet (mid, --model)`, or the honest "could not read
 * it" line when nothing on this box says what the CLI will pick.
 */
function describeModel(model: string | null, tier: ModelTier, inherited: AmbientModel | null): string {
  if (model === null) {
    return "model: whatever your claude CLI defaults to — tldrx could not read it here;"
      + " pass --model to pin it";
  }
  // `inherited` is non-null only when the model came from the environment. An
  // explicit `--model` says `--model`, even on a box whose settings name one
  // too: what the run WILL use is the flag, and a line that hedged would be
  // describing a model this run is not going to spawn.
  if (inherited === null) return `model ${model} (${tier}, --model)`;
  return `model ${model} (${tier}, inherited from your claude CLI via ${inherited.source})`
    + " — pass --model to override";
}

function refusal(
  input: PreflightInput, model: string, share: number, expected: number,
): readonly string[] {
  return [
    `refusing to spawn: --mode ${input.mode} on a ${modelTier(input.model ?? input.ambient?.model ?? null)}`
    + ` model against the DEFAULT $${input.ceilingUsd.toFixed(2)} ceiling — nothing was spent.`,
    `  ${model}`,
    `  This run splits that ceiling between ${String(input.agents)} sub-agent(s), $${share.toFixed(2)}`
    + ` each, and one repair round`,
    "  comes out of the same money. A full training has measured "
    + `${measuredBand()} END TO END on a mid`,
    "  model (docs/audits/2026-08-29/experts-knowledge.md) — two sub-agent passes, so ~$"
    + `${((MEASURED_FULL_TRAIN_USD.low + MEASURED_FULL_TRAIN_USD.high) / 4).toFixed(2)} each,`,
    `  and this tier lists at x${String(TIER_MULTIPLIER[modelTier(model)] ?? 1)} of that: $`
    + `${expected.toFixed(2)} a pass, which $${share.toFixed(2)} does not reach.`,
    "  And --max-budget-usd is a STOP AFTER THE TURN, not a cap: a $1.50 ceiling has realised",
    "  $5.15 on a 1M-context model (spec §2.6.1). The last run down this path died at $1.31",
    "  with nothing written to competencies.yml (#96, 2026-09-02).",
    "  Pick one:",
    "    --model sonnet     train on the tier this default was measured for",
    "    --max-usd <n>      you choose the ceiling — an explicit one is never refused"
    + ` (the default is $${DEFAULT_FULL_TRAIN_USD.toFixed(2)} for full mode)`,
  ];
}
