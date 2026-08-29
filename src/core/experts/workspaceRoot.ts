/**
 * Finding the workspace root for the read-only view commands.
 *
 * `[assumption]` The spec's CLI table (§3) does not say how `expert list`,
 * `replay`, `retro` and `dashboard` locate the workspace, so they take the
 * simplest option: an explicit `--root`, else the nearest ancestor of the cwd
 * that holds a `.tldrx/` directory, else the cwd itself.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";

const MAX_DEPTH = 64;

/** Nearest ancestor of `start` holding `.tldrx/`, or null. */
export function findWorkspaceRoot(start: string): string | null {
  let current = isAbsolute(start) ? start : resolve(start);
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (existsSync(join(current, PROJECT_FRAMEWORK_DIR))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** `--root` when given, else the discovered root, else `start` itself. */
export function resolveWorkspaceRoot(explicit: string | null, start: string = process.cwd()): string {
  if (explicit !== null && explicit !== "") return resolve(explicit);
  return findWorkspaceRoot(start) ?? resolve(start);
}
