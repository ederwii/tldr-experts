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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runtime } from "../runtime/index.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
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

/**
 * `tldrx-work/` and `.tldrx/` as paths relative to `repoDir` — empty when they
 * are not inside it.
 *
 * In a `root_is_repo: true` workspace the framework's state lives INSIDE the
 * product repo, so a dirty-tree check that counts every porcelain entry counts
 * this very command's writes: `run.yml` and `events.jsonl` are rewritten on every
 * `next`, `.lock` is the run lock, and `04-build/` is the plan just synthesised.
 * Measured 2026-08-30: `tldrx next --prepare` refused its own four state files
 * before it had touched a line of product code. A user's uncommitted answers under
 * `tldrx-work/` blocked it the same way, and those are committed on the user's
 * cadence — not as a precondition of Build.
 *
 * In the multi-repo shape the state sits at the workspace root and the repos are
 * subdirectories, so `relative` escapes upward and nothing is excused: that shape
 * behaves exactly as it always did.
 */
export function stateDirPrefixes(workspaceRoot: string, repoDir: string): readonly string[] {
  const base = resolve(repoDir);
  const prefixes: string[] = [];
  for (const name of [PROJECT_WORK_DIR, PROJECT_FRAMEWORK_DIR]) {
    const rel = relative(base, resolve(join(workspaceRoot, name)));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    prefixes.push(rel.split(sep).join("/"));
  }
  return prefixes;
}

/** The path a `git status --porcelain` entry names, minus its status letters. */
export function porcelainPath(entry: string): string {
  const at = entry.indexOf(" ");
  const rest = at === -1 ? "" : entry.slice(at + 1).trim();
  // `XY ORIG -> PATH` for a rename or copy: the destination is what it is now.
  const arrow = rest.lastIndexOf(" -> ");
  const path = arrow === -1 ? rest : rest.slice(arrow + 4);
  return path.startsWith('"') && path.endsWith('"') && path.length > 1 ? path.slice(1, -1) : path;
}

export interface DirtySplit {
  /** Entries the human owns — the only ones that may refuse a Build. */
  readonly product: readonly string[];
  /** Entries under `tldrx-work/` or `.tldrx/` — the framework's own writes. */
  readonly state: readonly string[];
}

/** Split porcelain entries into product dirt and tldrx's own state files. */
export function partitionDirty(entries: readonly string[], prefixes: readonly string[]): DirtySplit {
  if (prefixes.length === 0) return { product: entries, state: [] };
  const product: string[] = [];
  const state: string[] = [];
  for (const entry of entries) {
    const path = porcelainPath(entry);
    // An untracked directory arrives with a trailing slash (`?? 04-build/`), so
    // the `${prefix}/` test catches it as well as a file below the prefix.
    const isState = prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    (isState ? state : product).push(entry);
  }
  return { product, state };
}

/** Dirty for the caller's purposes: `ignore` holds prefixes that do not count. */
export async function isDirty(cwd: string, ignore: readonly string[] = []): Promise<boolean> {
  return partitionDirty(await dirtyPaths(cwd), ignore).product.length > 0;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)).ok;
}

/**
 * Is `path` in the tree at `ref`? `git cat-file -e <ref>:<path>`, which answers
 * for a blob and for a tree alike and needs no checkout.
 *
 * Asked of a story's `touches` before its prompt is written: the developer works
 * in a worktree of the story branch, so a path that is not committed at that
 * branch is a path the developer cannot open however clearly the prompt names it.
 * A failed call is `false` — "I could not prove it is there", which is the answer
 * that makes the prompt tell the truth.
 */
export async function pathAtRef(cwd: string, ref: string, path: string): Promise<boolean> {
  return (await git(["cat-file", "-e", `${ref}:${path}`], cwd)).ok;
}

export async function currentBranch(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return result.ok ? result.stdout.trim() : "";
}

export async function headSha(cwd: string): Promise<string> {
  return await shaOf(cwd, "HEAD");
}

/**
 * The short sha `ref` resolves to, or `""` when it resolves to nothing.
 *
 * `""` rather than a throw for the same reason `commitsBetween` returns 0: every
 * caller here is composing an operator line, and a branch that is not there yet
 * has no sha to name. A caller that needs the difference asks `branchExists`.
 */
export async function shaOf(cwd: string, ref: string): Promise<string> {
  const result = await git(["rev-parse", "--short", ref], cwd);
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

/**
 * Stage everything and commit it. `exclude` holds paths relative to `cwd` that the
 * commit may never carry — the framework's own state dirs, which a story worktree
 * ALSO has a checkout of whenever the workspace root is the repo. Without the
 * pathspec a dod command that happens to run `tldrx` would sweep `tldrx-work/`
 * into a story commit.
 */
export async function commitAll(cwd: string, message: string, exclude: readonly string[] = []): Promise<GitResult> {
  const pathspec = exclude.length === 0 ? [] : ["--", ".", ...exclude.map((path) => `:(exclude)${path}`)];
  const staged = await git(["add", "-A", ...pathspec], cwd);
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
/**
 * How many commits `head` carries that `base` does not.
 *
 * Used to answer one question — "has anything been built on this story branch
 * yet?" — before a `--discard-pending` re-derives the plan the branch was cut
 * for. A branch that does not exist has no commits on it, which is the same
 * answer for the caller's purposes, so a failed `rev-list` is 0 and not a throw.
 */
export async function commitsBetween(cwd: string, base: string, head: string): Promise<number> {
  const result = await git(["rev-list", "--count", `${base}..${head}`], cwd);
  if (!result.ok) return 0;
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Where a story branch stands against the branch it was cut from.
 *
 * `current` covers "identical" and "ahead of the base and nothing else", because
 * both mean the same thing to the caller: there is nothing on the base this
 * branch has not already got.
 */
export type BaseStaleness = "current" | "behind" | "diverged";

export interface BaseState {
  readonly state: BaseStaleness;
  /** Commits `branch` carries that `base` does not. */
  readonly ahead: number;
  /** Commits `base` carries that `branch` does not. */
  readonly behind: number;
  /** Short shas, for the operator line. `""` when the ref does not resolve. */
  readonly branchSha: string;
  readonly baseSha: string;
}

/**
 * Measure `branch` against `base` in both directions, and say which of the three
 * shapes it is.
 *
 * Both numbers come from `commitsBetween`, which is already the one place this
 * repo counts commits, so `behind === 0` here means exactly what
 * `git merge-base --is-ancestor base branch` means and no second notion of
 * ancestry enters the codebase.
 */
export async function baseStateOf(cwd: string, branch: string, base: string): Promise<BaseState> {
  const ahead = await commitsBetween(cwd, base, branch);
  const behind = await commitsBetween(cwd, branch, base);
  return {
    state: behind === 0 ? "current" : ahead === 0 ? "behind" : "diverged",
    ahead,
    behind,
    branchSha: await shaOf(cwd, branch),
    baseSha: await shaOf(cwd, base),
  };
}

/**
 * `git merge --ff-only <onto>` in `cwd` — advance the checked-out branch to
 * `onto`, and refuse rather than create a merge commit.
 *
 * **Never a rebase.** Rewriting a branch a developer has already committed to is
 * the class of move the run-id-in-branch-name fix exists to prevent (2026-08-29
 * audit §B), and a fast-forward writes no commit at all: it moves a ref and
 * checks out the tree already recorded at the other end.
 *
 * Measured 2026-08-31 against a real repo, which is what §I.5 of the design asked
 * for: with an untracked file in the way, `--ff-only` exits 1, prints
 * `Aborting`, and leaves HEAD on the ORIGINAL commit with the file untouched. It
 * is atomic-or-nothing, so a failed call needs no repair — only a line saying it
 * did not happen.
 */
export async function fastForward(cwd: string, onto: string): Promise<GitResult> {
  return await git(["merge", "--ff-only", onto], cwd);
}

export function diffCommand(base: string, branch: string): string {
  return `git diff ${base}...${branch}`;
}

export function firstLine(text: string, max = 200): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
