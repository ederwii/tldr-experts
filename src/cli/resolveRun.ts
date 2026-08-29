/**
 * "Which run did you mean?", answered once for every command that takes a run.
 *
 * Three outcomes, and only the middle one is new:
 *
 *   one        act on it — exactly today's behaviour, exactly today's exit codes
 *   none       today's `no non-terminal run` / `no run '<id>'` line, exit 3
 *   ambiguous  name every open run and REFUSE, exit 2
 *
 * The refusal is exit 2 (`refused by a gate`, spec §3) rather than 1 or 3: the
 * command is well formed and the runs all exist — the CLI is declining to choose
 * between them. Nothing is read, written or advanced on that path.
 */
import { RunStore } from "../core/run/RunStore.ts";
import { ambiguousRunLines } from "../core/run/openRuns.ts";
import { PROJECT_WORK_DIR } from "../core/paths.ts";
import { EXIT_GATE_REFUSED, EXIT_NOT_FOUND } from "./exitCodes.ts";

/** Either the run to act on, or the exit code the command must return. */
export type RunOrExit = { readonly store: RunStore } | { readonly exit: number };

export function isResolved(result: RunOrExit): result is { readonly store: RunStore } {
  return "store" in result;
}

/**
 * `label` is the command as it already names itself on stderr (`tldrx budget`,
 * `tldrx run status`, …) so the not-found line stays byte-identical to today's.
 */
export function resolveRunOrExplain(label: string, root: string, runId?: string): RunOrExit {
  const resolution = RunStore.resolve(root, runId);
  if (resolution.kind === "one") return { store: resolution.store };
  if (resolution.kind === "none") {
    process.stderr.write(`${label}: ${notFound(runId)} in ${PROJECT_WORK_DIR}/\n`);
    return { exit: EXIT_NOT_FOUND };
  }
  process.stderr.write(renderAmbiguous(label, resolution.open));
  return { exit: EXIT_GATE_REFUSED };
}

export function notFound(runId?: string): string {
  return runId === undefined || runId === "" ? "no non-terminal run" : `no run '${runId}'`;
}

/**
 * `tldrx <cmd>: N runs are open — pass one:` then one two-space-indented line per
 * run. The same shape `tldrx next` produces through its own stderr prefixer, so
 * the message reads identically whichever command refused.
 */
export function renderAmbiguous(label: string, open: readonly RunStore[]): string {
  const lines = ambiguousRunLines(open);
  return `${lines.map((line, i) => (i === 0 ? `${label}: ${line}` : `  ${line}`)).join("\n")}\n`;
}
