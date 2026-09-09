/**
 * Wall-clock budgets that survive a busy machine (#43).
 *
 * Measured 2026-08-31 on an untouched `origin/main`: `bun test` reported
 * `2155 pass · 5 fail`, and the same two files run alone reported `91 pass · 0 fail`.
 * Four of the five were the 5000 ms per-test default expiring on tests that spawn a
 * REAL git (a fifth, in `cli.test.ts`, expired on the merge that was fixing this); the fifth was a 50 ms performance budget measured at 66.4 ms. Nothing in
 * the code had changed — three live `tldrx` runs and two other agents were sharing the
 * box. A red gate that means "the machine was busy" is worse than no gate: it is
 * indistinguishable from a regression, and the natural response is to re-run until
 * green, which is how a real one eventually gets pushed.
 *
 * The lever is the CLOCK, never the assertion. A test that spawns a process still asserts
 * exactly what it asserted before; it is simply given a budget proportional to what
 * the machine can currently deliver, and a hang is still caught. `bun test` runs test
 * FILES sequentially in one process (verified: `setDefaultTimeout` in one file does
 * not leak into the next, and a 5.5 s test in the second file still timed out at
 * 5000 ms), so serialising the suite would not have helped — the contention is other
 * processes on the box, which only a load-aware budget can see.
 */
import { cpus, loadavg } from "node:os";

/** No budget is ever stretched further than this, however loaded the box. */
export const LOAD_FACTOR_CAP = 8;

/** The per-test budget for a file that spawns real processes, on an idle machine. */
export const SPAWN_TEST_BASE_MS = 30_000;

/**
 * How much slower than an idle machine this one currently is, in [1, LOAD_FACTOR_CAP].
 * The 1-minute run-queue length per core: 1 means "a core is free for me".
 * `TLDRX_TEST_LOAD_FACTOR` pins it, which is how the tests of this module measure it.
 */
export function loadFactor(): number {
  const pinned = Number(process.env.TLDRX_TEST_LOAD_FACTOR);
  if (Number.isFinite(pinned) && pinned > 0) return clamp(pinned);
  const cores = Math.max(1, cpus().length);
  return clamp((loadavg()[0] ?? 0) / cores);
}

function clamp(factor: number): number {
  return Math.min(LOAD_FACTOR_CAP, Math.max(1, factor));
}

/** A per-test timeout for a file whose tests spawn real processes. Still catches a hang. */
export function spawnTestTimeout(baseMs: number = SPAWN_TEST_BASE_MS): number {
  return Math.round(baseMs * loadFactor());
}

/**
 * The base a wait for a PUSHED event gets on an idle machine (#193).
 *
 * 15 s, not the 5 s the dashboard tests hard-coded: the server debounces a write burst
 * (`DEBOUNCE_MS` 300, 20 in the tests) and the mtime fallback sweeps every 500 ms, so the
 * floor is tens of milliseconds and everything above it is the OS getting round to
 * delivering an `fs.watch` notification — a property of the box, exactly like process
 * startup. A base an order of magnitude over the mechanism's own cost is a hang catcher,
 * not a stopwatch.
 */
export const EVENT_WAIT_BASE_MS = 15_000;

/**
 * How long to wait for an event the MACHINE has to deliver — an SSE frame behind a file
 * watcher, a line on a child's stdout — scaled exactly like the per-test budget (#193).
 *
 * `setDefaultTimeout(spawnTestTimeout())` scaled the test's budget with load while the
 * deadline inside the assertion stayed a literal, so load never reached the number that
 * actually decided the result: `test/dashboard-live.test.ts` and
 * `test/dashboard-server.test.ts` reddened on a different SSE wait every time, at
 * 5031/5085/5408/5683/5830 ms against a fixed 5000, and at 2002-2005 ms against a fixed
 * 2000. This is the SAME derivation — `spawnTestTimeout` with a different base, never a
 * second scaler — so a box that gets twice the budget for starting a process also gets
 * twice the patience for a notification from it.
 *
 * The caller passes a smaller base for a NEGATIVE wait ("and nothing else arrived"),
 * where the number is how long the test is willing to sit still, not how long the machine
 * may take.
 */
export function eventWaitMs(baseMs: number = EVENT_WAIT_BASE_MS): number {
  return spawnTestTimeout(baseMs);
}

/** A performance budget, scaled to the machine. On an idle box it is `baseMs`, exactly. */
export function perfBudgetMs(baseMs: number): number {
  return Math.round(baseMs * loadFactor());
}

/**
 * The floor of `runs` timings of `fn`, in ms — what the operation costs when the
 * scheduler happens to leave it alone. A stall inflates some runs, never the floor,
 * so the floor is the honest instrument for "is this code fast", and averaging or
 * taking a single sample is not.
 */
export function fastestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < Math.max(1, runs); i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
