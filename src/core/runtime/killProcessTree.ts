/**
 * Kill a spawned child AND everything it started.
 *
 * Why this exists (2026-08-28, a Linux-only CI failure): a DoD command runs as
 * `sh -c "<command>"`. On macOS `/bin/sh` is bash, which `exec`s a lone simple
 * command, so the shell *becomes* `sleep 30` and killing the child's pid kills
 * the real work. On Linux `/bin/sh` is dash, which forks instead — so `sleep`
 * is a GRANDCHILD, it survives a kill aimed at the shell, and because it
 * inherited the stdout/stderr pipes those pipes never reach EOF. The spawn
 * promise then waits for output from a process nobody is going to stop, and the
 * DoD gate hangs instead of denying. Verified in `oven/bun:1.3.14`: the shell
 * died at 1s and the spawn resolved at 30s.
 *
 * The fix is to signal the process GROUP. Both runtimes spawn timed commands
 * detached, which makes the child a group leader, so `kill(-pid)` reaches the
 * shell and every descendant. A negative pid can only be used once that is true;
 * `pid > 0` is checked here because `process.kill(-0, …)` would signal *our own*
 * group.
 */

/**
 * Best effort, never throws. Falls back to killing the child alone when there is
 * no process group to signal (an undetached spawn, an already-reaped child, or
 * a platform without process groups).
 */
export function killProcessTree(pid: number | undefined, killChild: () => void): void {
  if (pid !== undefined && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through: no such process group, or not permitted.
    }
  }
  try {
    killChild();
  } catch {
    // Already gone — nothing left to kill.
  }
}
