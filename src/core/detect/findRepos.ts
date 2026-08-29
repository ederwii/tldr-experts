/**
 * Workspace-mode detection (concept v0.1 "Workspace model").
 *
 * Child directories that are git repos ⇒ multi-repo, and those children are the
 * repos. Otherwise, if the root itself is a repo ⇒ single-repo. Nothing else is
 * inferred: a directory without a `.git` entry is not a repo, however it looks.
 */
import { join } from "node:path";
import { readEntries, SKIPPED_DIRS } from "./walk.ts";
import { runtime } from "../runtime/index.ts";
import type { DetectedMode } from "./types.ts";

export interface FoundRepos {
  readonly mode: DetectedMode;
  readonly rootIsRepo: boolean;
  /** Directory names relative to the root; `["."]` in single-repo mode. */
  readonly repoDirs: readonly string[];
}

/** `.git` may be a directory (normal clone) or a file (worktree/submodule). */
export async function isGitRepo(dir: string): Promise<boolean> {
  return (await runtime.exists(join(dir, ".git", "HEAD")))
    || (await runtime.exists(join(dir, ".git")));
}

export async function findRepos(root: string): Promise<FoundRepos> {
  const rootIsRepo = await isGitRepo(root);
  const children: string[] = [];

  for (const entry of await readEntries(root)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
    if (await isGitRepo(join(root, entry.name))) children.push(entry.name);
  }

  if (children.length > 0) return { mode: "multi-repo", rootIsRepo, repoDirs: children };
  return { mode: "single-repo", rootIsRepo, repoDirs: rootIsRepo ? ["."] : [] };
}
