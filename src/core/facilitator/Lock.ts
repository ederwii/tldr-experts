/**
 * `tldrx-work/<run>/.lock` — the single-writer guard (spec §1, §5).
 *
 * The lock is a pid, not a mutex: the only thing it has to survive is a crashed
 * `next`, and the only honest way to tell "still running" from "died holding it"
 * is to ask the OS whether that pid is alive. Spec §5's resume path spells the
 * consequence out — "a `running` left by a crash is demoted to `ready` when
 * `.lock` holds a dead pid" — so a stale lock is not an error, it is information.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCK_FILE = ".lock";

export interface LockHolder {
  readonly pid: number;
  readonly at: string;
}

export interface LockAcquisition {
  /** False when a LIVE process holds the lock — the caller must refuse to run. */
  readonly ok: boolean;
  /** Who holds it, when `ok` is false; who held it, when `stale` is true. */
  readonly holder: LockHolder | null;
  /** True when the lock we took over was left behind by a dead pid. */
  readonly stale: boolean;
}

export function lockPath(runDir: string): string {
  return join(runDir, LOCK_FILE);
}

export function readLock(runDir: string): LockHolder | null {
  const path = lockPath(runDir);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
    const pid = typeof doc.pid === "number" ? doc.pid : Number.NaN;
    if (!Number.isInteger(pid)) return null;
    return { pid, at: typeof doc.at === "string" ? doc.at : "" };
  } catch {
    // An unparseable lock file holds no pid we can check, so it cannot be proven
    // live. Treat it as stale rather than deadlocking the run forever.
    return null;
  }
}

/**
 * Is this pid still running? `kill(pid, 0)` sends no signal — it only asks. EPERM
 * means "alive, but not yours", which is still alive.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Take the lock, or report who has it. Never blocks and never waits. */
export function acquireLock(runDir: string, at: string, pid: number = process.pid): LockAcquisition {
  const held = readLock(runDir);
  if (held !== null && held.pid !== pid && isAlive(held.pid)) {
    return { ok: false, holder: held, stale: false };
  }
  const path = lockPath(runDir);
  const stale = existsSync(path) && (held === null || held.pid !== pid);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ pid, at }, null, 2)}\n`, "utf8");
  return { ok: true, holder: held, stale };
}

export function releaseLock(runDir: string): void {
  rmSync(lockPath(runDir), { force: true });
}
