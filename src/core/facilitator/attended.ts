/**
 * The guard behind `attended_by: host` (spec §2.2).
 *
 * The refusals live where they can say something useful — `runNext` names the
 * `--prepare` command for the stage at the cursor, each executor refuses
 * `mode: "headless"` with `refused: true`, `run auto` refuses at the CLI. Those
 * are the doors. This is the wall behind them.
 *
 * It exists because "no run path can reach `spawnAgent`" is a claim about THREE
 * call sites (`runNext`'s own headless spawn, `build.ts`, `watch.ts`) and a
 * fourth is one merge away. A claim maintained by four separate `if`s is a claim
 * that holds until somebody adds a fifth; a claim maintained by the spawn itself
 * refusing cannot be forgotten. `next` is single-writer and holds the run's
 * `.lock` for the whole of `runNext`, so a process-scoped flag is exactly as wide
 * as the thing it is guarding — including the parallel Build fan-out, which
 * spawns inside that same call.
 *
 * What it is NOT: a policy. It never decides anything. `runNext` arms it from
 * `run.yml` and disarms it in a `finally`; if it ever fires, a refusal that
 * should have happened earlier did not, and the throw says so by name.
 */

export class AttendedSpawnError extends Error {}

/** The run a host session is driving right now, or null. */
let attended: string | null = null;

/**
 * Arm the guard for the duration of `fn` when `runId` is non-null, and disarm it
 * afterwards whatever happens.
 *
 * Re-entrant by save-and-restore rather than by refusing: `runNext` is the only
 * caller today, but a nested one restoring the outer value is the behaviour that
 * cannot surprise anybody.
 */
export async function withAttendedGuard<T>(runId: string | null, fn: () => Promise<T>): Promise<T> {
  const previous = attended;
  attended = runId;
  try {
    return await fn();
  } finally {
    attended = previous;
  }
}

/** The run the guard is armed for, or null. Read by tests and by `spawnAgent`. */
export function attendedRun(): string | null {
  return attended;
}

/**
 * Throw if a spawn is attempted while a host-driven run is in flight.
 *
 * `where` names the call site, because the message is only ever read when the
 * framework has a bug: some path reached a sub-agent on a run that had already
 * declared nobody would.
 */
export function assertNoAttendedSpawn(where: string): void {
  if (attended === null) return;
  throw new AttendedSpawnError(
    `${where}: refusing to spawn — run ${attended} is \`attended_by: host\`, so the framework does not spawn on it. ` +
      "This is a bug: a refusal in runNext or in the stage executor should have stopped this before any prompt was assembled.",
  );
}
