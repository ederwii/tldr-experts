/**
 * How many tokens one turn DECLARED — counted once, for every surface that asks
 * (#159).
 *
 * Two different facts live in a task row and only one of them existed when
 * `spendBasisOf` was written. `tokens` is what a HOST declared with `--tokens`
 * for a turn nothing here metered. `input_tokens`/`output_tokens` are the
 * PROVIDER's own split for a turn this process watched, written together or not
 * at all (`runNext.ts`'s `tokenSplit` — the WRITE-side rule this is the READ-side
 * pair of; the two headers name each other on purpose). The basis feeders read
 * only the first, so a row carrying a full split and no host scalar counted as
 * having declared NOTHING — and under Codex every Build turn is unmetered, so a
 * whole provider read `absent` over rows that hold the tokens.
 *
 * The scalar wins when both are present: it is the host's own statement about a
 * turn it billed, and the split is a measurement of a turn nobody billed here —
 * they are never both descriptions of the same spend, and adding them would
 * double-count.
 *
 * The two fields are gated DIFFERENTLY, on purpose. `tokens` counts on
 * PRESENCE — a finite number, including an explicit `0` — because `--tokens 0`
 * is a host DECLARING it burned nothing, the same fact `metered: false` +
 * `cost_usd: 0` already treats as a measurement rather than a hole; this is
 * also the pre-#159 behaviour (`task.tokens ?? null`), preserved rather than
 * narrowed. `input_tokens`/`output_tokens` count only on BOTH sides being
 * STRICTLY POSITIVE, and a HALF-known split is absent, for the reason
 * `tokenSplit` refuses to write one: `envelope.ts`'s parse collapses "no usage
 * object" and "usage reported as 0" into the same shape, so one real number
 * beside one defaulted zero is a manufactured total. Absent is honest; a
 * confident number is not — and there is no such ambiguity on the host side,
 * where a `0` only ever reaches the row because something wrote it on purpose.
 */

/** As much of a `run.yml` task row as this reads. Every field optional — old rows have none. */
export interface TokenBearing {
  readonly tokens?: number | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
}

export function turnTokens(task: TokenBearing): number | null {
  if (declared(task.tokens)) return task.tokens as number;
  const input = task.input_tokens;
  const output = task.output_tokens;
  if (!positive(input) || !positive(output)) return null;
  return (input as number) + (output as number);
}

/** A host `tokens` value counts once it EXISTS as a real number — an explicit `0` is a declaration, not an absence. */
function declared(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** A provider split side counts only when it is POSITIVE — see the module docstring for why `0` cannot. */
function positive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
