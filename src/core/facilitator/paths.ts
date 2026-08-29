/**
 * Where a stage's declared paths actually live.
 *
 * `stage.yml` mixes two roots in one list: `01-what/intent.md` is inside the run,
 * `.tldrx/map/api/architecture.md` is inside the workspace. The spec never says
 * which is which because to a human it is obvious, so the rule is written down
 * here once: anything starting with `.tldrx/` (or `tldrx-work/`) is workspace-
 * relative, everything else is run-relative. `[assumption]`
 *
 * A run's SEED documents (`run new --seed`) break that rule from the other side:
 * `requirements.md` lives at the workspace root and is never copied into the run.
 * So a path that is not workspace-prefixed falls back to the workspace root when
 * it does not exist inside the run — the same "first existing base wins" order
 * §2.8 already uses to resolve a bare `file` src. It can only make MORE paths
 * resolve, never fewer.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";

const REPO_TOKEN = "{repo}";

export interface PathContext {
  readonly root: string;
  readonly runDir: string;
}

export function isWorkspaceRelative(declared: string): boolean {
  return declared.startsWith(`${PROJECT_FRAMEWORK_DIR}/`) || declared.startsWith(`${PROJECT_WORK_DIR}/`);
}

export function resolveDeclared(declared: string, ctx: PathContext): string {
  if (isWorkspaceRelative(declared)) return join(ctx.root, declared);
  const inRun = join(ctx.runDir, declared);
  if (existsSync(inRun)) return inRun;
  const inWorkspace = join(ctx.root, declared);
  return existsSync(inWorkspace) ? inWorkspace : inRun;
}

/**
 * Spec §2.3: "`{repo}` expands per repo." One declared path with the token becomes
 * one path per repo in the run; a path without it is returned unchanged.
 */
export function expandRepos(declared: string, repos: readonly string[]): readonly string[] {
  if (!declared.includes(REPO_TOKEN)) return [declared];
  return repos.map((repo) => declared.split(REPO_TOKEN).join(repo));
}

export function expandAll(declared: readonly string[], repos: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const entry of declared) {
    for (const expanded of expandRepos(entry, repos)) {
      if (!out.includes(expanded)) out.push(expanded);
    }
  }
  return out;
}

/** Declared paths that resolve to a file on disk, in declaration order. */
export function present(declared: readonly string[], ctx: PathContext): readonly string[] {
  return declared.filter((entry) => existsSync(resolveDeclared(entry, ctx)));
}

export function missing(declared: readonly string[], ctx: PathContext): readonly string[] {
  return declared.filter((entry) => !existsSync(resolveDeclared(entry, ctx)));
}

/** `tldrx-work/<run>/.agent/<stage>/` — raw agent traffic, gitignored (spec §1). */
export function agentDir(runDir: string, stageId: string): string {
  return join(runDir, ".agent", stageId);
}
