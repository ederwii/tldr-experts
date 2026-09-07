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
 * A HALF-known split is absent, for the same reason `tokenSplit` refuses to
 * write one: `envelope.ts`'s parse collapses "no usage object" and "usage
 * reported as 0" into the same shape, so one real number beside one defaulted
 * zero is a manufactured total. Absent is honest; a confident number is not.
 */

/** As much of a `run.yml` task row as this reads. Every field optional — old rows have none. */
export interface TokenBearing {
  readonly tokens?: number | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
}

export function turnTokens(task: TokenBearing): number | null {
  if (positive(task.tokens)) return task.tokens as number;
  const input = task.input_tokens;
  const output = task.output_tokens;
  if (!positive(input) || !positive(output)) return null;
  return (input as number) + (output as number);
}

function positive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
