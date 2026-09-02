/**
 * What a model costs, and how much of it fits — the one table both the context
 * ledger and `tldrx cost` read.
 *
 * **`[assumption]`, priced 2026-08-29.** Every USD figure below is a list price
 * this repo was TOLD, not one it measured, and prices change without a commit. It
 * lives in one file with one date on it so that "the estimate is stale" is a
 * one-line fix and a checkable claim, rather than a number buried in a report.
 * `tldrx cost` never uses these for a run that already happened: `agent.result`
 * carries `total_cost_usd` from the CLI itself, which is the real number. They are
 * used ONLY by `tldrx run estimate`, which says out loud that it is an estimate.
 *
 * The ONE measured value here is `claude-haiku-4-5`'s context window. It came off
 * the `result` event of a real call (`test/fixtures/agent/stream-json.jsonl:13`,
 * `claude` 2.1.251, 2026-08-29): `modelUsage["claude-haiku-4-5-20251001"]`
 * reported `contextWindow: 200000`. The other windows are assumed to match it,
 * except the `[1m]` variants, whose whole name is their context.
 *
 * Cache multipliers — write 1.25x an input token, read 0.1x — are the numbers the
 * 2026-08-29 token-economy audit priced with. Also `[assumption]`.
 */

export interface ModelPrice {
  /** The canonical id this row answers for. */
  readonly id: string;
  /** Context window in TOKENS. */
  readonly contextTokens: number;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Bytes per token, for turning a prompt's SIZE into a token estimate.
 *
 * `[assumption]` — 3.6 is the ratio the 2026-08-29 audit used and is only ever
 * applied to English-plus-Markdown prose. It is never used to bill anything: the
 * real token counts arrive on `agent.result`.
 */
export const BYTES_PER_TOKEN = 3.6;

export const DEFAULT_CONTEXT_TOKENS = 200_000;

/** Priced 2026-08-29. `[assumption]` on every USD figure. */
export const MODEL_PRICES: readonly ModelPrice[] = [
  { id: "opus", contextTokens: 200_000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  { id: "opus[1m]", contextTokens: 1_000_000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  { id: "sonnet", contextTokens: 200_000, inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  { id: "sonnet[1m]", contextTokens: 1_000_000, inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  { id: "haiku", contextTokens: 200_000, inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
];

/**
 * The 1M-context suffix a model name carries — `sonnet[1m]`, and equally
 * `claude-sonnet-4-5-20250929[1m]`.
 *
 * It is a MARKER on a name, not part of a family's spelling, and reading it as
 * one was #112: a row id of `sonnet[1m]` could only ever be a substring of the
 * bare alias, so every DATED spelling — the form a `--model` flag and a `result`
 * event actually use — fell through to the 200k row and the context ledger sized
 * a 1M model at a fifth of its window. Family and marker are matched separately
 * below so that both spellings land on the same row.
 */
const ONE_MILLION_MARKER = "[1m]";
const ONE_MILLION_TOKENS = 1_000_000;

/** A row's family name, with its `[1m]` marker taken off. */
function familyOf(id: string): string {
  return id.endsWith(ONE_MILLION_MARKER) ? id.slice(0, -ONE_MILLION_MARKER.length) : id;
}

/**
 * The row for a model name as a stage file, a `--model` flag or a `result` event
 * spells it — `sonnet`, `claude-haiku-4-5-20251001`, `us.anthropic.claude-…`,
 * `claude-sonnet-4-5-20250929[1m]`.
 *
 * A `[1m]` row is offered only to a name that carries the marker, and longest id
 * still wins, so `opus[1m]` is not answered by `opus` and `opus` is not answered
 * by `opus[1m]`. Null when nothing matches: a caller then says "unknown model"
 * rather than quoting a price for a model it has never heard of.
 */
export function priceFor(model: string | null): ModelPrice | null {
  if (model === null) return null;
  const name = model.toLowerCase();
  const oneMillion = name.includes(ONE_MILLION_MARKER);
  let best: ModelPrice | null = null;
  for (const row of MODEL_PRICES) {
    const family = familyOf(row.id);
    // A family with no `[1m]` row has no 1M variant — haiku's 200k is the one
    // MEASURED window here, and a marker does not get to overrule it.
    if (family !== row.id && !oneMillion) continue;
    if (!name.includes(family)) continue;
    if (best === null || row.id.length > best.id.length) best = row;
  }
  return best;
}

/**
 * Context window for a model name, falling back to the documented default.
 *
 * A family this table prices answers for its own windows. For one it does NOT
 * price — `claude-fable-5[1m]`, the spelling this repo's own fixtures use — a
 * `[1m]` in the name is the only window evidence there is, and honouring it is
 * strictly better than a silent 200k. This still quotes no price for it:
 * `priceFor` goes on refusing, so nothing bills a model the table cannot price.
 */
export function contextTokensFor(model: string | null): number {
  const priced = priceFor(model);
  if (priced !== null) return priced.contextTokens;
  if (model !== null && model.toLowerCase().includes(ONE_MILLION_MARKER)) return ONE_MILLION_TOKENS;
  return DEFAULT_CONTEXT_TOKENS;
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN);
}
