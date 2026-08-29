/**
 * Every git call the Build phase makes, and the only place it makes one.
 *
 * Two rules this file exists to keep:
 *   - **Through the runtime seam.** `runtime.spawn` is the one process boundary
 *     (`src/core/runtime/`), so no host-specific global appears here and the Node
 *     build behaves identically.
 *   - **Always with a cwd inside a `workspace.yml` repo.** Git resolves its
 *     repository from the working directory, so a wrong cwd is not a wrong
 *     argument — it is a write into somebody else's repo. `repoDirOf` is the only
 *     way a cwd is produced, and it refuses anything the workspace does not name.
 *
 * `git push` has no wrapper here on purpose (spec §5, Build executor): the phase
 * ends at a human gate, and nothing it runs may publish a branch.
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { runtime } from "../runtime/index.ts";
import { repoPath, type WorkspaceContext } from "../../hooks/lib/workspace.ts";

/** A git call is a local filesystem operation; a minute is already generous. */
export const GIT_TIMEOUT_MS = 60_000;

export interface GitResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export class GitError extends Error {}

export async function git(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const outcome = await runtime.spawn("git", args, { cwd, timeoutMs });
  return {
    ok: outcome.exitCode === 0 && !outcome.timedOut,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
  };
}

/**
 * The absolute directory of a repo `workspace.yml` names — and nothing else.
 *
 * A story's `repo:` is data written by a planning agent, so it gets the same
 * treatment as a dod command: it must already be declared, and it must land
 * inside the workspace root.
 */
export function repoDirOf(workspace: WorkspaceContext, name: string): string {
  const dir = repoPath(workspace, name);
  if (dir === null) throw new GitError(`repo \`${name}\` is not in .tldrx/workspace.yml`);
  const resolved = resolve(dir);
  const outside = relative(resolve(workspace.root), resolved);
  if (outside.startsWith("..") || outside === "..") {
    throw new GitError(`repo \`${name}\` resolves to ${resolved}, which is outside the workspace root`);
  }
  if (!existsSync(resolved)) throw new GitError(`repo \`${name}\` resolves to ${resolved}, which does not exist`);
  return resolved;
}

/** Porcelain output, one entry per changed path. Empty = a clean tree. */
export async function dirtyPaths(cwd: string): Promise<readonly string[]> {
  const result = await git(["status", "--porcelain"], cwd);
  if (!result.ok) throw new GitError(`\`git status\` failed in ${cwd}: ${firstLine(result.stderr)}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await dirtyPaths(cwd)).length > 0;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)).ok;
}

export async function currentBranch(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return result.ok ? result.stdout.trim() : "";
}

export async function headSha(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--short", "HEAD"], cwd);
  return result.ok ? result.stdout.trim() : "";
}

/** Create `branch` off `base` when it is not already there. Returns true if created. */
export async function ensureBranch(cwd: string, branch: string, base: string): Promise<boolean> {
  if (await branchExists(cwd, branch)) return false;
  const result = await git(["branch", branch, base], cwd);
  if (!result.ok) {
    throw new GitError(`cannot cut \`${branch}\` from \`${base}\`: ${firstLine(result.stderr)}`);
  }
  return true;
}

/**
 * A worktree at `path` on `branch`. The branch is created off `base` when it does
 * not exist; an existing branch is checked out as it stands, which is what makes
 * a second attempt at the same story resume rather than start over.
 */
export async function addWorktree(cwd: string, path: string, branch: string, base: string): Promise<void> {
  const args = (await branchExists(cwd, branch))
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, base];
  const result = await git(args, cwd);
  if (!result.ok) {
    throw new GitError(`cannot add a worktree at ${path} on \`${branch}\`: ${firstLine(result.stderr)}`);
  }
}

/** Best effort: a worktree that will not go away is a warning, never a failure. */
export async function removeWorktree(cwd: string, path: string): Promise<boolean> {
  if (!existsSync(path)) return true;
  const removed = await git(["worktree", "remove", "--force", path], cwd);
  await git(["worktree", "prune"], cwd);
  return removed.ok;
}

export async function commitAll(cwd: string, message: string): Promise<GitResult> {
  const staged = await git(["add", "-A"], cwd);
  if (!staged.ok) return staged;
  return await git(["commit", "-m", message], cwd);
}

export interface MergeOutcome {
  readonly ok: boolean;
  /** Paths left in conflict, when the merge stopped. */
  readonly conflicts: readonly string[];
  readonly detail: string;
}

/**
 * `git merge --no-ff <branch>` inside the epic's own worktree.
 *
 * Concept §9: a story merges to its epic on green. On a conflict the merge is
 * aborted so the epic branch is left exactly as it was — the next story in the
 * wave still has somewhere to land.
 */
export async function mergeNoFf(cwd: string, branch: string, message: string): Promise<MergeOutcome> {
  const merged = await git(["merge", "--no-ff", "-m", message, branch], cwd);
  if (merged.ok) return { ok: true, conflicts: [], detail: firstLine(merged.stdout) };
  const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  const conflicts = conflicted.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  await git(["merge", "--abort"], cwd);
  return {
    ok: false,
    conflicts,
    detail: conflicts.length > 0
      ? `conflict in ${conflicts.join(", ")}`
      : firstLine(merged.stderr) || firstLine(merged.stdout) || `git merge exited ${String(merged.exitCode)}`,
  };
}

/** The diff a reviewer is asked to read: everything the story branch adds. */
export function diffCommand(base: string, branch: string): string {
  return `git diff ${base}...${branch}`;
}

export function firstLine(text: string, max = 200): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
