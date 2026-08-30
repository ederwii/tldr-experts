/**
 * Every child this process has spawned and not yet reaped.
 *
 * Why (2026-08-29 resumability audit, finding #1): a sub-agent is spawned
 * DETACHED — it has to be, or `killProcessTree` has no process group to signal on
 * a timeout — and a detached child is in its own group, so the terminal's Ctrl-C
 * never reaches it. Measured: Ctrl-C during `tldrx next` left a `claude` running
 * with `ppid 1`, still working, still billing against its `--max-budget-usd`, and
 * nothing recorded a cent of it because the cost is only written after the spawn
 * returns.
 *
 * A signal handler cannot fix that without knowing what to kill. This registry is
 * that knowledge, and it lives in `src/core/runtime/` because it is the only
 * place allowed to know how each runtime spawns. Both implementations register a
 * pid the moment they have one and drop it the moment the child settles.
 */
import { killProcessTree } from "./killProcessTree.ts";

const live = new Set<number>();

export function registerChild(pid: number | undefined): void {
  if (pid !== undefined && pid > 0) live.add(pid);
}

export function unregisterChild(pid: number | undefined): void {
  if (pid !== undefined) live.delete(pid);
}

/** Pids currently believed live — for diagnostics and tests, never for control flow. */
export function liveChildren(): readonly number[] {
  return [...live];
}

/**
 * Kill every live child AND everything it started, best effort. Returns how many
 * pids it tried, so the caller can tell "there was a sub-agent in flight" from
 * "there was nothing running" — a distinction the interrupt path needs to decide
 * whether a stage lost a paid turn or merely a stamp.
 *
 * Never throws: this runs from a signal handler, where a throw is a hang.
 */
export function killAllChildren(): number {
  const pids = [...live];
  for (const pid of pids) {
    killProcessTree(pid, () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    });
    live.delete(pid);
  }
  return pids.length;
}
