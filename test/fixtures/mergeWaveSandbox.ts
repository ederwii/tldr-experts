/**
 * Whether `test/merge-wave.test.ts`'s per-test sandbox survives past its own process
 * (#373, see #237).
 *
 * `afterEach` in that file used to `rmSync` every sandbox unconditionally, pass or fail —
 * hermetic and self-cleaning by default (§8), which is right for a local run but wrong
 * for CI on the one occasion that matters: the file's own `evidence()` comment already
 * named the trap ("merge-wave keeps a red run's logs ON PURPOSE, and `afterEach` deletes
 * the sandbox they sit in before any human can read them"), and ci.yml's #373 upload step
 * runs OUTSIDE the bun process, after `afterEach` has already run — an unconditional
 * cleanup would hand it an empty directory every time, on the one run it was built for.
 *
 * `keepSandbox` is the single, pure, unit-testable decision: `cleanupSandbox` calls it and
 * skips the `rmSync` when it says keep; ci.yml sets the env var it reads. A module
 * boundary (not an inline check) so `test/ci-workflow.test.ts` can assert the exact env
 * var name ci.yml must set, and unit-test the decision and the cleanup it gates, without
 * importing `merge-wave.test.ts` itself and re-running its whole suite as a side effect
 * of the import.
 */
import { rmSync } from "node:fs";

/** The env var CI sets to keep a sandbox past its process instead of deleting it. */
export const MERGE_WAVE_KEEP_SANDBOX_ENV = "MERGE_WAVE_KEEP_SANDBOX";

/**
 * Any value other than exactly unset/empty means keep — `"1"` is what ci.yml sets, but a
 * human re-running the file locally with `MERGE_WAVE_KEEP_SANDBOX=1 bun test
 * test/merge-wave.test.ts` to look at a failure's sandbox gets the same behavior. Local
 * runs stay self-cleaning (§8) unless this is explicitly set.
 */
export function keepSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[MERGE_WAVE_KEEP_SANDBOX_ENV];
  return value !== undefined && value !== "";
}

/**
 * The mkdtemp prefix for the sandboxes `keepSandbox` gates — recognisable so ci.yml's
 * upload step can scope `path:` to exactly these directories (`${{ runner.temp
 * }}/mw/mw-sandbox-*`) rather than the whole shared tmpdir, which ~85 other test files
 * also mkdtemp-and-self-clean under.
 */
export const SANDBOX_PREFIX = "mw-sandbox-";

/**
 * The ONE place that deletes (or, per `keepSandbox`, doesn't) a sandbox directory.
 * `merge-wave.test.ts`'s `afterEach` calls this for every sandbox it opened and nothing
 * else does — so a unit test against this function directly is a unit test of the
 * `afterEach` guard itself, with no git sandbox required to exercise it.
 */
export function cleanupSandbox(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!keepSandbox(env)) rmSync(dir, { recursive: true, force: true });
}
