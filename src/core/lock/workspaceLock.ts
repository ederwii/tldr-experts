/**
 * `.tldrx/.lock` — the guard on the files SEVERAL runs share.
 *
 * `tldrx-work/<run>/.lock` (see `facilitator/Lock.ts`) protects one run from a
 * second `next`. It protects nothing else, and two files in a workspace are
 * written by every run in it:
 *
 *   `.tldrx/memory/facts.yml`   read-modify-write; the next id is `max(id) + 1`
 *   `tldrx-work/<run>/budget.yml` ceilings a concurrent `budget raise` may change
 *
 * Measured in the 2026-08-29 resumability audit: two writers of `facts.yml` each
 * loaded the file, each computed `F001`, and each wrote it — one fact silently
 * replaced the other. And a `budget raise` that landed while a `next` was in
 * flight was reverted at the end of it, because `next` held the ceilings it had
 * read minutes earlier and wrote them back. Neither is a crash; both are quiet
 * data loss, which is worse.
 *
 * So: one workspace-wide lock, held for the DURATION of a read-modify-write, not
 * just the write. Same shape and same stale rule as the run lock — a pid file,
 * `kill(pid, 0)` to ask whether the holder is alive, a dead holder's lock taken
 * over — because two different answers to "is it stuck?" is one answer too many.
 *
 * Re-entrant WITHIN a process: `RunStore.save()` takes it, and it is routinely
 * called from inside a `withWorkspaceLock` block. Recursion counts up and only
 * the outermost exit releases. Across processes it is exclusive, which is the
 * whole point.
 */
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
import { isAlive } from "../facilitator/Lock.ts";

export const WORKSPACE_LOCK_FILE = ".lock";

/**
 * How long to wait for a LIVE holder before giving up.
 *
 * Every critical section here is a handful of small file writes — milliseconds.
 * Five seconds is far past any honest one and far short of a command that looks
 * hung, and the throw names the pid so the operator knows who to look at.
 */
export const WORKSPACE_LOCK_TIMEOUT_MS = 5_000;

/** How long each spin sleeps. Short enough to be invisible, long enough not to burn a core. */
const SPIN_MS = 25;

export class WorkspaceLockError extends Error {}

export function workspaceLockPath(root: string): string {
  return join(resolve(root), PROJECT_FRAMEWORK_DIR, WORKSPACE_LOCK_FILE);
}

/**
 * `<root>/tldrx-work/<run>` → `<root>`. The layout is spec §1, so this is
 * structure, not a guess — but a run dir that is NOT under `tldrx-work/` (a
 * fixture pointed straight at a folder) would otherwise lock some unrelated
 * parent, so that case keeps the run dir itself and locks nothing shared.
 */
export function workspaceRootOfRunDir(runDir: string): string {
  const parent = dirname(resolve(runDir));
  return parent.endsWith(`/${PROJECT_WORK_DIR}`) || parent.endsWith(`\\${PROJECT_WORK_DIR}`)
    ? dirname(parent)
    : resolve(runDir);
}

/**
 * `<root>/.tldrx/memory/facts.yml` → `<root>`.
 *
 * Only when the path really has that shape. A test or a tool pointing
 * `FactsStore` at some other file must not end up locking `/` — anything that is
 * not the spec §1 layout locks its own directory instead, which is still correct
 * (writers of THAT file serialise) and cannot escape upward.
 */
export function workspaceRootOfFactsPath(factsFile: string): string {
  const full = resolve(factsFile);
  const memory = dirname(full);
  const framework = dirname(memory);
  return basename(memory) === "memory" && basename(framework) === PROJECT_FRAMEWORK_DIR
    ? dirname(framework)
    : memory;
}

/** Depth per lock path, so a nested take does not deadlock on itself. */
const held = new Map<string, number>();

/**
 * Sleep without an event loop turn. `RunStore.save()` is synchronous and has to
 * stay that way — every one of its ~40 call sites is synchronous — so the wait
 * for a live holder cannot be `await`ed. `Atomics.wait` on a private buffer is
 * the stdlib's synchronous sleep; it blocks this thread and nothing else.
 */
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Who holds the lock right now, or null when the file is absent or unreadable.
 *
 * Unparseable holds no pid we can check, so it cannot be proven live. Same rule
 * as the run lock: treat it as stale rather than wedge the workspace forever.
 */
export function readWorkspaceLock(root: string): { pid: number; at: string } | null {
  return readHolder(workspaceLockPath(root));
}

/**
 * Take the lock, or throw. `O_EXCL` (`openSync(..., "wx")`) is the atomic step:
 * the kernel decides who won, not a check-then-write we could lose a race in.
 */
function acquire(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
    const holder = readHolder(path);
    if (holder === null || !isAlive(holder.pid)) {
      // Dead or unreadable: take it over. A racing taker may remove it first and
      // then win the `wx` above — that is fine, the loop simply goes round again.
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new WorkspaceLockError(
        `${path} is held by live pid ${String(holder.pid)}` +
          (holder.at === "" ? "" : ` since ${holder.at}`) +
          ` — waited ${String(timeoutMs)}ms. Wait for it, or remove the file if that process is gone.`,
      );
    }
    sleepSync(SPIN_MS);
  }
}

function readHolder(path: string): { pid: number; at: string } | null {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
    const pid = typeof doc.pid === "number" ? doc.pid : Number.NaN;
    if (!Number.isInteger(pid)) return null;
    return { pid, at: typeof doc.at === "string" ? doc.at : "" };
  } catch {
    return null;
  }
}

/**
 * Run `fn` holding the workspace lock. Synchronous on purpose (see `sleepSync`).
 *
 * The lock is released on the way out of the OUTERMOST call, throw or return —
 * a critical section that threw still has to let the next process in.
 */
export function withWorkspaceLock<T>(root: string, fn: () => T, timeoutMs = WORKSPACE_LOCK_TIMEOUT_MS): T {
  const path = workspaceLockPath(root);
  const depth = held.get(path) ?? 0;
  if (depth === 0) acquire(path, timeoutMs);
  held.set(path, depth + 1);
  try {
    return fn();
  } finally {
    const now = (held.get(path) ?? 1) - 1;
    if (now <= 0) {
      held.delete(path);
      rmSync(path, { force: true });
    } else {
      held.set(path, now);
    }
  }
}

/** True when THIS process is inside a `withWorkspaceLock` for `root`. */
export function holdsWorkspaceLock(root: string): boolean {
  return (held.get(workspaceLockPath(root)) ?? 0) > 0;
}
