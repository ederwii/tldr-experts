/**
 * Finding the workspace a command is being run inside.
 *
 * One `.tldrx/` per workspace root (spec §1), located by walking up from the cwd.
 * A command that cannot find one says so and stops — it never guesses a root and
 * writes into it.
 */
import { resolve } from "node:path";
import { findWorkspaceRoot } from "../hooks/lib/workspace.ts";
import { PROJECT_FRAMEWORK_DIR } from "../core/paths.ts";
import { stringFlag, UsageError, type ParsedArgs } from "./argv.ts";

export function requireWorkspaceRoot(cwd: string = process.cwd()): string {
  const root = findWorkspaceRoot(cwd);
  if (root === null) {
    throw new UsageError(
      `no ${PROJECT_FRAMEWORK_DIR}/ found in ${cwd} or any parent — run \`tldrx init\` first`,
    );
  }
  return root;
}

/**
 * The workspace a run-lifecycle command acts on: `--root <path>` when given, else
 * the cwd. Both go through the same walk-up, so `--root` may name the root itself
 * or any directory inside it, and omitting it keeps the old cwd behaviour exactly.
 */
export function workspaceRootFrom(args: ParsedArgs): string {
  const explicit = stringFlag(args, "root");
  return requireWorkspaceRoot(explicit === undefined ? process.cwd() : resolve(explicit));
}
