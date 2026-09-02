/**
 * Read back `.tldrx/workspace.yml`.
 *
 * `map --refresh` and `map --check` both need to know where the repos are, and
 * neither may guess: if the file is missing or unreadable the command fails and
 * says to run `tldrx init`, rather than mapping whatever happens to be in cwd.
 */
import { isAbsolute, join, resolve } from "node:path";
import { readYamlFile } from "../yaml.ts";
import { runtime } from "../runtime/index.ts";
// From `paths.ts`, NOT from `runInit.ts` where `init` re-exports it: this module is
// a leaf several commands read the repo list through, and importing the constant
// from `runInit` dragged all of `init` into every one of their bundles (gh #94).
import { PROJECT_WORKSPACE_FILE as WORKSPACE_FILE } from "../paths.ts";

export interface LoadedWorkspace {
  /** Absolute path of the workspace root the repo paths are relative to. */
  readonly root: string;
  readonly repos: readonly { readonly name: string; readonly path: string }[];
  readonly provider: string | null;
}

export async function loadWorkspaceFile(workspaceDir: string): Promise<LoadedWorkspace> {
  const path = join(workspaceDir, WORKSPACE_FILE);
  if (!(await runtime.exists(path))) {
    throw new Error(`${WORKSPACE_FILE} not found in ${workspaceDir} — run \`tldrx init\` first`);
  }
  const parsed = await readYamlFile(path);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${WORKSPACE_FILE} is not a mapping`);
  const document = parsed as Record<string, unknown>;

  const declaredRoot = typeof document.root === "string" ? document.root : ".";
  const root = declaredRoot === "." ? workspaceDir
    : isAbsolute(declaredRoot) ? declaredRoot : resolve(workspaceDir, declaredRoot);

  const repos: { name: string; path: string }[] = [];
  if (Array.isArray(document.repos)) {
    for (const entry of document.repos) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== "string" || typeof record.path !== "string") continue;
      repos.push({ name: record.name, path: record.path });
    }
  }
  return { root, repos, provider: typeof document.provider === "string" ? document.provider : null };
}
