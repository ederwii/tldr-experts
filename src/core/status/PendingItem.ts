/**
 * One thing that is waiting on a human, in this workspace, right now.
 *
 * `tldrx status` (spec §3) answers a question no other command could: "what is
 * pending HERE" — not "where is this run", which is `run status`, and not "what
 * would this run do next", which is `next`. The pending work is all on disk
 * already: init questions nobody answered, a proposed split nobody decided, a run
 * waiting on a gate, an expert a stage will load that has never been trained.
 * Until this existed, nothing read those four places as ONE list, so a session
 * that opened with no run could only ask "what do you want to do?".
 *
 * Deterministic and read-only: files in, lines out, no model, no network, nothing
 * written. It is a report, so it exits 0 whatever it finds — the only non-zero is
 * `3` for "there is no `.tldrx/` here at all", which is not a finding, it is the
 * absence of the thing being reported on.
 */

/**
 * The four sources of pending work, in the order a human should deal with them,
 * plus the placeholder for an empty report.
 *
 * The order is not cosmetic. Init questions gate every later stage's facts; a
 * proposed split decides what the runs even ARE; a run is the work itself; an
 * untrained expert degrades a stage's quality but blocks nothing.
 */
export type PendingKind = "init-questions" | "seed-split" | "run" | "expert" | "none";

export interface PendingItem {
  readonly kind: PendingKind;
  /** One sentence, plain language, no jargon a non-user of this tool would miss. */
  readonly summary: string;
  /** The exact command to run next — `""` when the next move is not a command. */
  readonly command: string;
  /** Everything the summary had to leave out: ids, paths, blocked-by, options. */
  readonly details: readonly string[];
}

export interface WorkspaceStatus {
  readonly root: string;
  /** Items in priority order. Never empty: an idle workspace gets one `none` item. */
  readonly items: readonly PendingItem[];
  /** How many items are real pending work — `0` when the only item is `none`. */
  readonly pending: number;
}

export function isPending(item: PendingItem): boolean {
  return item.kind !== "none";
}
