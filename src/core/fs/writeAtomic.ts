/**
 * The one durable-write path for the framework's state files.
 *
 * `run.yml`, `budget.yml` and `facts.yml` are the resume point: lose one and the
 * work is not recoverable from anywhere else. Two things protect them here, and
 * they protect against different failures.
 *
 * 1. **Temp + rename**, so a reader sees the whole old file or the whole new one
 *    and never the truncated middle of a `writeFileSync` that was killed.
 *    `renameSync` is atomic within a filesystem.
 * 2. **The previous version is kept** as `<file>.bak`. Atomicity guarantees a
 *    WHOLE file; it does not guarantee a GOOD one. A save that writes a whole,
 *    well-formed, wrong file — or a whole, unparseable one, which is exactly what
 *    the unescaped-newline bug did on 2026-08-31 — leaves the operator with
 *    nothing to go back to. Now there is always exactly one step back.
 *
 * This file exists because `RunStore` and `FactsStore` had grown a byte-identical
 * copy of (1) each, and a fix to one would not have reached the other.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Appended to the path of the version a save replaced. */
export const BACKUP_SUFFIX = ".bak";

/** Where `writeAtomic` keeps the version it is about to replace. */
export function backupPathFor(path: string): string {
  return `${path}${BACKUP_SUFFIX}`;
}

/**
 * Write `content` to `path`, keeping the version it replaces at `path.bak`.
 *
 * The temp name carries the pid so two processes writing the same file cannot
 * collide on the temp itself, and it is removed on the failure path so a crashed
 * write leaves no litter next to the real file.
 *
 * Order matters: the temp is written FIRST, the backup is taken SECOND, and the
 * rename happens LAST. Copying rather than renaming the old file means `path`
 * itself is never absent for even an instant — a statusline or hook reading it
 * without the lock cannot catch a gap — and a torn `.bak` can only ever cost a
 * backup, never the live file. That trade is deliberate: never risk the file
 * that is good to protect the copy of it.
 */
export function writeAtomic(path: string, content: string): void {
  const temp = `${path}.tmp-${String(process.pid)}`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, content, "utf8");
    keepPreviousVersion(path);
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) rmSync(temp, { force: true });
    } catch {
      // Nothing to clean up, or not ours to clean up.
    }
    throw error;
  }
}

/**
 * Best effort, and deliberately silent on failure: a read-only directory or a
 * `.bak` someone else owns must not turn a working save into a failed one. The
 * backup is a convenience for recovery, not a precondition for writing.
 */
function keepPreviousVersion(path: string): void {
  if (!existsSync(path)) return;
  try {
    copyFileSync(path, backupPathFor(path));
  } catch {
    // No backup this time. The save itself still stands.
  }
}
