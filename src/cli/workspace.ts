/**
 * Finding the workspace a command is being run inside.
 *
 * One `.tldrx/` per workspace root (spec §1), located by walking up from the cwd.
 * A command that cannot find one says so and stops — it never guesses a root and
 * writes into it.
 */
import { findWorkspaceRoot } from "../hooks/lib/workspace.ts";
import { PROJECT_FRAMEWORK_DIR } from "../core/paths.ts";
import { UsageError } from "./argv.ts";

export function requireWorkspaceRoot(cwd: string = process.cwd()): string {
  const root = findWorkspaceRoot(cwd);
  if (root === null) {
    throw new UsageError(
      `no ${PROJECT_FRAMEWORK_DIR}/ found in ${cwd} or any parent — run \`tldrx init\` first`,
    );
  }
  return root;
}
