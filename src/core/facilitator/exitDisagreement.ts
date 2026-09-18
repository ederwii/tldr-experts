/**
 * The verdict of a turn whose PROCESS exit code disagrees with what the
 * provider's own result document said (gh #375).
 *
 * Measured on a live autonomous run (issue #375, `260917-status-idle-false-clear`,
 * tldrx 0.33.0): a watch developer wrote its declared output, `claude` exited 1
 * with `is_error: true`, and the result document's own `subtype` said `"success"`.
 * The facilitator classified this as a stage failure — "no reason named (the
 * provider's own subtype said "success")" — and `run auto` spent one of five
 * relaunches re-running work that was already done. The proposed fix: a turn is
 * DONE when the provider's own record says so AND the filesystem agrees — every
 * declared output is on disk and non-empty — whatever the process exit code was.
 * When either signal disagrees with "done", the turn stays failed exactly as it
 * does today; this module only ever turns a failure INTO a success, never the
 * other way, and it never touches a turn that already succeeded (`outcome.ok`),
 * timed out, or was stopped by the read cap — each of those already has a full,
 * more specific account of its own end that this rule has no business overriding.
 *
 * `spawnAgent.ts` cannot make this call: it has no idea what a stage declared as
 * its outputs. `runNext.ts`'s three spawn sites do, so this is the ONE place the
 * rule is written, called from all three — a second copy is exactly the kind of
 * derivation AGENTS.md §7 forbids.
 */
import { statSync } from "node:fs";
import type { AgentOutcome } from "./spawnAgent.ts";
import { SUCCESS_SUBTYPES } from "./spawnAgent.ts";
import { existsDeclared, resolveMany, type PathContext } from "./paths.ts";

/**
 * `null` when there is no disagreement to settle — either the turn already
 * agrees with itself (ok, timed out, stopped by a cap, or a subtype that is not
 * one of `SUCCESS_SUBTYPES`), or it disagrees but at least one declared output
 * is missing or empty, in which case the turn stays failed under its existing
 * `failureKind` exactly as before this existed.
 *
 * A non-null return is the row's additive `exit_disagreement` value verbatim
 * (`"exit <n>, subtype success"`) — the caller is the one that decides what a
 * non-null return means for `status` and `error`, because only the caller knows
 * what a "done" row of this shape looks like for its own site.
 */
export function settleExitDisagreement(
  outcome: AgentOutcome,
  declaredOutputs: readonly string[],
  ctx: PathContext,
): string | null {
  // Already agrees with itself, one way or the other — nothing to settle.
  if (outcome.ok || outcome.timedOut || outcome.stoppedBy !== null) return null;
  // The rule is about the EXIT CODE disagreeing with the result document, not
  // about `is_error` — the measured case had both, but the issue's own proposal
  // ties settlement to `exit code ≠ 0` alone (gh #375).
  if (outcome.exitCode === 0) return null;
  if (outcome.resultSubtype === null || !SUCCESS_SUBTYPES.has(outcome.resultSubtype)) return null;
  for (const declared of declaredOutputs) {
    if (!existsDeclared(declared, ctx)) return null;
    for (const hit of resolveMany(declared, ctx)) {
      if (!isNonEmptyFile(hit.absolute)) return null;
    }
  }
  return `exit ${String(outcome.exitCode)}, subtype success`;
}

function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    // Between `existsDeclared` finding it and this stat, the file vanished (or
    // was never a real file, e.g. a broken symlink) — that is "missing", not a
    // crash.
    return false;
  }
}
