/**
 * A training pass whose OUTPUT earned nothing, said out loud after the money
 * (gh #154).
 *
 * **What was there.** `runTraining` records `problems` in `training.jsonl` only
 * on the failure path — the fix for the 2026-08-31 case where a $1.02 run failed
 * on 12 problems and the ledger remembered the count but not which twelve. On the
 * PASS path there was no equivalent: a file that validated, cost real money and
 * added zero evidence rows was written down as `check.passed` with
 * `evidence_added: 0` and nothing beside it. The reasons existed — `softWarnings`
 * reach the terminal — but the terminal is not a record, which is the argument
 * the failure path already accepted.
 *
 * Measured on `~/scavtopia` at 0.8.0: `architect` ($1.61) and `operations`
 * ($1.63) both read `check.passed`, `evidence_added: 0`, with no reason on disk.
 * `developer` ($5.02 over four turns) is the only one whose reason survives, and
 * only by accident — an unrelated `error` failed its check and dragged the 13
 * `outside domain` warnings into the rejection record with it. The operator's
 * next signal was `tldrx status` telling them to train all three again.
 *
 * **This is a REPORT, not a refusal, and that is deliberate.** #101's sibling
 * question is "is there anything to read", asked before the spawn, and it exits.
 * This one is asked after, when the money is already gone and a validated file is
 * already on disk. A warning is a way of being worth nothing, not a lie — the
 * file is honest and it is kept, the exit stays `EXIT_OK`, and what changes is
 * that the run says it bought nothing and the ledger remembers why. Quarantining
 * an honest file to make a point would destroy the one thing that was paid for.
 *
 * Pure — no clock, no disk, no environment. The caller hands it what the write
 * already returned.
 */

/** How many warnings are printed in full before the note defers to the ledger. */
const SHOWN = 3;

/**
 * The lines that go under `evidence: +0 row(s)`, or empty when a row was added.
 *
 * `added` is the count `writeCompetencies` actually merged, not the count of
 * bullets: a file can be full of good sentences and still add nothing, and that
 * gap is the whole subject of this note.
 */
export function noEvidenceNote(
  costUsd: number,
  added: number,
  warnings: readonly string[],
): readonly string[] {
  if (added > 0) return [];

  const lines = [`  the level did not move — $${costUsd.toFixed(2)} bought 0 evidence row(s)`];
  if (warnings.length === 0) {
    // No warning either: the file validated and simply made no claim that could
    // become a row — every citation was `absent:`, a recap, or a fact token.
    lines.push(
      "    nothing was refused: this file's citations are all of kinds that never earn a row",
      "    (`absent:`, the `## Sources` recap, or a fact already on record)",
    );
    return lines;
  }

  lines.push(`    ${String(warnings.length)} citation(s) earned no row:`);
  for (const warning of warnings.slice(0, SHOWN)) lines.push(`      ${warning}`);
  if (warnings.length > SHOWN) {
    lines.push(`      … and ${String(warnings.length - SHOWN)} more, all of them in the ledger`);
  }
  return lines;
}
