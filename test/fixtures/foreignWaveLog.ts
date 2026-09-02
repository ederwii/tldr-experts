/**
 * Where `test/merge-wave.test.ts` plants the "foreign wave log" of #95 — the deliberately
 * KEPT log directory of a merge wave that has already exited, sitting in the machine's
 * SHARED tmpdir where `merge-wave.sh` used to write every run's logs.
 *
 * It lives in a fixture module rather than inline in that test for one reason: the
 * property that matters is a CROSS-PROCESS one. Two `bun test` processes running that
 * file at the same time must never choose the same directory, and only a module a second
 * process can import lets a test MEASURE that instead of asserting it about itself.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A pid that is not running, and not the same one in two concurrent test processes.
 *
 * Dead, because #95's story is a wave that exited and left its log behind for somebody to
 * read: the offset is far above any pid this OS will hand out (macOS caps at 99998, Linux
 * at 4194304), so nothing is ever alive at it.
 *
 * Unique, because a FIXED one was #113. `mw-999999` was a single constant path in a
 * namespace shared by every process on the box: each concurrent run of that file planted
 * it, and each one DELETED it in its `finally`, so the first to finish removed the
 * directory its siblings were still about to assert on. Measured 2026-09-02, four
 * concurrent runs of `test/merge-wave.test.ts` at 965eb54: 9 failures in 12, every one of
 * them `expect(existsSync(foreign)).toBe(true)` receiving false. `process.pid` is unique
 * among the live processes on this box, so pid-derived names cannot collide.
 */
export function foreignWavePid(pid: number = process.pid): number {
  return 999_000_000 + pid;
}

/**
 * The directory that wave's log would sit in — DIRECTLY in the machine's shared tmpdir,
 * named `mw-<pid>` like a real one. Both of those are load-bearing: the pre-#95 script
 * listed exactly this directory and matched exactly this prefix, so a regression to that
 * machine-global scan still finds this plant and still goes red.
 */
export function foreignWaveLogPath(pid: number = process.pid): string {
  return join(tmpdir(), `mw-${foreignWavePid(pid)}`);
}
