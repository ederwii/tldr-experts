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
import { epicWorktreesOf, loadWorkspace, repoPath, type WorkspaceContext } from "../../hooks/lib/workspace.ts";

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

/** One `git status --porcelain` record, with the path as its own exact bytes. */
export interface DirtyEntry {
  /** The two status letters, verbatim — `??`, ` M`, `A `, `R `. */
  readonly code: string;
  /** The path git named, unquoted and unescaped: what a pathspec must match. */
  readonly path: string;
  /** `code` + a space + `path` — the string this repo has always displayed. */
  readonly entry: string;
}

/**
 * Every changed path, read with `-z`.
 *
 * `-z` rather than the line format, and this is the whole reason the function
 * exists (#164, wave 5): without it git QUOTES a path it considers unusual —
 * `?? "we ird[1].txt"`, `?? "caf\303\251.md"` — and a caller that strips the
 * quotes still holds an escaped string, not the bytes on disk. That was fine
 * while the only consumers COUNTED and PRINTED. It stops being fine the moment a
 * path is handed back to git as a pathspec, because the framework is then writing
 * to somebody's uncommitted work through a name it guessed at. `-z` emits the
 * real bytes and never quotes.
 *
 * A rename record is `XY <new>\0<old>\0` — two fields for one change — so the
 * origin field is consumed and dropped here: the path a pathspec has to name is
 * the one the file has NOW.
 */
export async function dirtyEntries(cwd: string): Promise<readonly DirtyEntry[]> {
  const result = await git(["status", "--porcelain", "-z"], cwd);
  if (!result.ok) throw new GitError(`\`git status\` failed in ${cwd}: ${firstLine(result.stderr)}`);
  const fields = result.stdout.split("\0");
  const out: DirtyEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i] ?? "";
    if (record === "") continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    // `R`/`C` in either column: the NEXT field is where the file came from, and
    // it is not a path anybody may act on now.
    if (code.startsWith("R") || code.startsWith("C") || code[1] === "R" || code[1] === "C") i += 1;
    out.push({ code, path, entry: `${code} ${path}`.trim() });
  }
  return out;
}

/** Porcelain output, one entry per changed path. Empty = a clean tree. */
export async function dirtyPaths(cwd: string): Promise<readonly string[]> {
  return (await dirtyEntries(cwd)).map((entry) => entry.entry);
}

/**
 * A pathspec that matches EXACTLY this path and nothing else.
 *
 * Git pathspecs are globs by default: a file really named `we ird[1].txt` is a
 * character class to `git stash push -- <path>`, and the file it was asked to set
 * aside is not the file it sets aside. `:(literal)` turns the magic off for that
 * one operand (`gitglossary(7)`), which is the only form allowed anywhere the
 * framework writes to a tree it does not own.
 */
export function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

/** Every submodule `.gitmodules` declares, as repo-relative paths. Empty when there is none. */
export async function submodulePaths(cwd: string): Promise<ReadonlySet<string>> {
  const result = await git(["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], cwd);
  const paths = new Set<string>();
  if (!result.ok) return paths;   // exit 1 = no .gitmodules, which is not a failure
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at === -1) continue;
    const path = line.slice(at + 1).trim();
    if (path !== "") paths.add(path);
  }
  return paths;
}

/**
 * The multi-step git operation this repo is in the middle of, or null.
 *
 * Named rather than counted, because the caller's whole job is to say WHICH one:
 * a tree mid-merge is not a tree anybody may stash out from under, and "there is
 * something in progress" is not a sentence an operator can act on.
 */
export async function operationInProgress(cwd: string): Promise<string | null> {
  const gitDir = await git(["rev-parse", "--git-dir"], cwd);
  if (!gitDir.ok) return null;
  const dir = resolve(cwd, gitDir.stdout.trim());
  for (const [name, what] of [
    ["MERGE_HEAD", "a merge"],
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase or `git am`"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
    ["BISECT_LOG", "a bisect"],
  ] as const) {
    if (existsSync(join(dir, name))) return what;
  }
  return null;
}

/** Paths git currently reports as unmerged — the conflict half of a failed apply. */
export async function unmergedPaths(cwd: string): Promise<readonly string[]> {
  const result = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

export interface StashPush {
  readonly ok: boolean;
  /** The stash commit's full sha — the durable name. `""` when nothing was pushed. */
  readonly hash: string;
  readonly message: string;
  readonly detail: string;
}

/**
 * `git stash push -u -m <message> -- <literal pathspecs>`: exactly these paths.
 *
 * Never a bare `-u`. Measured on a live 0.14.2 run (#164): the refusal's printed
 * remedy said `git stash push -u -m "…"` with no pathspec, an owner ran it, and
 * it swept the run's OWN untracked records under `tldrx-work/<run>/` into the
 * stash — after which `tldrx next` answered `no run '<id>' in tldrx-work/`.
 * Nothing was lost, and the framework had made its own run disappear.
 *
 * The hash is read from `refs/stash` immediately after the push, and it is the
 * hash — not `stash@{0}` — that is recorded: another stash pushed in between
 * would renumber every entry, and a restore that trusted the number would pop
 * somebody else's work.
 */
export async function stashPushPaths(
  cwd: string, message: string, paths: readonly string[],
): Promise<StashPush> {
  if (paths.length === 0) return { ok: false, hash: "", message, detail: "no paths to set aside" };
  const pushed = await git(["stash", "push", "-u", "-m", message, "--", ...paths.map(literalPathspec)], cwd);
  if (!pushed.ok) {
    return { ok: false, hash: "", message, detail: firstLine(pushed.stderr) || firstLine(pushed.stdout) };
  }
  const hash = await fullShaOf(cwd, "refs/stash");
  if (hash === "") return { ok: false, hash: "", message, detail: "`git stash push` left no refs/stash to name" };
  return { ok: true, hash, message, detail: firstLine(pushed.stdout) };
}

/**
 * The `stash@{n}` that IS this commit, or `""` when the stash is no longer there.
 *
 * Measured 2026-09-09: `git stash pop <sha>` is refused outright —
 * `'<sha>' is not a stash reference` — so a hash cannot be popped directly, and
 * `stash@{0}` cannot be trusted (a second stash pushed meanwhile renumbers it).
 * Locating the index BY the hash is the only form that is both possible and
 * correct, and it is what makes the record's `stash_ref` a durable name.
 */
export async function stashRefFor(cwd: string, hash: string): Promise<string> {
  const listed = await git(["stash", "list", "--format=%H %gd"], cwd);
  if (!listed.ok) return "";
  for (const line of listed.stdout.split("\n")) {
    const [sha, ref] = line.trim().split(" ");
    if (sha === hash && ref !== undefined) return ref;
  }
  return "";
}

export interface StashPop {
  readonly restored: boolean;
  /**
   * Did the INDEX come back as it was — a path staged at one version and modified
   * further in the worktree, restored to both?
   *
   * `false` is a real, named partial success: the files are back and unstaged.
   * `true` when `--index` took, and when there was nothing staged to lose.
   */
  readonly indexRestored: boolean;
  /** Paths left unmerged, when git applied part of it. Empty when it aborted whole. */
  readonly conflicts: readonly string[];
  /** The `stash@{n}` this hash was found at, for the line an operator retypes. */
  readonly ref: string;
  readonly detail: string;
}

/**
 * Give the stash back — and never force.
 *
 * `pop`, not `apply` + `drop`: on a clean apply git drops the entry itself, and
 * on a refusal it KEEPS it (measured 2026-09-09 both ways). The refusal is
 * atomic in the case that matters here — a path the tree has changed since
 * produces `Your local changes … would be overwritten by merge` / `Aborting`
 * with the tree untouched and the entry intact — so a failed restore leaves the
 * operator's work exactly where this function found it. Nothing here checks out,
 * resets or drops anything.
 */
export async function stashPop(cwd: string, hash: string): Promise<StashPop> {
  const ref = await stashRefFor(cwd, hash);
  if (ref === "") {
    return {
      restored: false, indexRestored: false, conflicts: [], ref: "",
      detail: "the stash entry is no longer in `git stash list`",
    };
  }
  // `--index` FIRST, because a plain pop silently throws the staging away.
  // Measured 2026-09-09 on HEAD `A` / staged `B` / worktree `C`: a plain pop came
  // back ` M` with `git show :f.txt` reading `A` — the staged `B` gone — where
  // `--index` came back `MM` with `B` staged and `C` in the tree. One of the three
  // workspaces this feature was measured on had exactly that shape (a script and a
  // `package.json` line staged in a sub-repo), so losing it is losing real work.
  //
  // `--keep-index` is deliberately NOT used on the PUSH side: measured on the same
  // repo, it leaves the staged content in the working tree (`M  f.txt`, the tree
  // holding `B`), which is the very dirt this whole path exists to take out of the
  // base pre-flight's measurement.
  const withIndex = await git(["stash", "pop", "--index", ref], cwd);
  if (withIndex.ok) return { restored: true, indexRestored: true, conflicts: [], ref, detail: firstLine(withIndex.stdout) };
  // `--index` refuses in cases a plain pop survives (it cannot reinstate an index
  // over a path the tree has since staged differently). Falling back is strictly
  // better than leaving the files in the stash — and it is NAMED, never silent.
  const plain = await git(["stash", "pop", ref], cwd);
  if (plain.ok) {
    return {
      restored: true,
      indexRestored: false,
      conflicts: [],
      ref,
      detail: `${firstLine(plain.stdout)} — the index could not be reinstated (${firstLine(withIndex.stderr)})`,
    };
  }
  return {
    restored: false,
    indexRestored: false,
    conflicts: await unmergedPaths(cwd),
    // Re-read: a partial apply renumbers nothing, but an operator retypes what
    // this prints, so the ref is measured at the moment the line is composed.
    ref: await stashRefFor(cwd, hash),
    detail: firstLine(plain.stderr) || firstLine(plain.stdout) || `git stash pop exited ${String(plain.exitCode)}`,
  };
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

/**
 * The FULL 40-character sha `ref` resolves to, or `""` when it resolves to
 * nothing.
 *
 * `shaOf`'s sibling, and the difference is which side of a record it is for.
 * `shaOf` is `--short` and feeds OPERATOR LINES, where an abbreviation is the
 * readable thing. This one feeds DURABLE RECORDS — `review.epic_base` in a
 * bundle, `epic_base` on `task.done` — where an abbreviation is a prefix, and a
 * prefix that is unambiguous the day it is written can go ambiguous as the repo
 * grows, at which point the `git diff <base>...<branch>` a reviewer was handed
 * simply fails (task 5 review, M2). Same `""`-not-throw contract as `shaOf`, for
 * the same reason: a caller that needs the difference asks `branchExists`.
 */
export async function fullShaOf(cwd: string, ref: string): Promise<string> {
  const result = await git(["rev-parse", ref], cwd);
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

/**
 * A worktree that is NOT on the branch its caller is about to write to.
 *
 * Its own class because the one thing that must never happen here is a silent
 * recovery: the caller may not re-point the worktree, may not merge anyway, and
 * may not fall back to a fresh path. It is a `GitError`, so the Build executor's
 * existing handler turns it into a failed stage with this message rather than an
 * unhandled crash — loud, and still nothing merged.
 */
export class WorktreeBranchMismatchError extends GitError {}

/**
 * Refuse to reuse `path` unless it is checked out on exactly `branch`.
 *
 * The invariant behind every reuse of an epic worktree (issue #40). A path that
 * two runs could both compute — `_epic-E1`, before the run id went into it — made
 * `git merge --no-ff` run inside a worktree belonging to a DIFFERENT run, and
 * every progress line rendered the branch the story MEANT to merge into, so three
 * stories reported "merged into epic/hardening-d1" while the commits landed on a
 * closed run's `epic/d1-tenancy-identity-customers` (measured 2026-08-31). Naming
 * the run in the path prevents that collision; this check makes it impossible to
 * repeat silently even if some future path ever collides again.
 *
 * The message names BOTH branches and the path on purpose: the operator's next
 * move is `git -C <path> status`, and a mismatch this class can see is one a
 * human has to adjudicate.
 */
export async function assertWorktreeOn(path: string, branch: string, what = "worktree"): Promise<void> {
  const on = await currentBranch(path);
  if (on === branch) return;
  throw new WorktreeBranchMismatchError(
    `${what} ${path} is checked out on \`${on === "" ? "(no branch)" : on}\`, not \`${branch}\` — `
    + "refusing to touch it, because a merge here would land on another run's branch",
  );
}

/**
 * Is `sha` a commit this repo has, and is it reachable from `ref`?
 *
 * Three answers rather than two, because the two failures are different
 * sentences to the person reading a refused claim: `absent` is "that is not a
 * commit here at all", `unreachable` is "that commit exists, and it is not on
 * this branch". Both refuse; only one of them is a typo.
 *
 * Added for #130, where a fix list recorded `Resolved: yes` over a fix that had
 * reached no ref anywhere. A close is a claim like any other, and this is the
 * measurement that either backs it or does not.
 */
export type ShaReachability = "reachable" | "unreachable" | "absent";

export async function shaReachability(cwd: string, sha: string, ref: string): Promise<ShaReachability> {
  // `^{commit}` on purpose: a blob or a tree whose id somebody pasted is not a
  // commit a fix landed as, and `rev-parse` would otherwise resolve it happily.
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], cwd);
  if (!resolved.ok) return "absent";
  return (await git(["merge-base", "--is-ancestor", sha, ref], cwd)).ok ? "reachable" : "unreachable";
}

/**
 * The full 40-hex object id `sha` names, or null when git will not resolve it to a
 * commit.
 *
 * `shaReachability` already runs this exact `rev-parse` and throws the answer away.
 * A second call rather than a changed return type, on purpose: the three-value
 * reachability answer is what every caller switches on, and widening it to carry a
 * payload would make every one of them handle a shape it does not need. The cost is
 * one extra `rev-parse` on a path that already ran one — a local, sub-millisecond
 * plumbing command, not a network round trip.
 */
export async function canonicalSha(cwd: string, sha: string): Promise<string | null> {
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], cwd);
  const full = resolved.stdout.trim();
  return resolved.ok && /^[0-9a-f]{40}$/.test(full) ? full : null;
}

/** Best effort: a worktree that will not go away is a warning, never a failure. */
export async function removeWorktree(cwd: string, path: string): Promise<boolean> {
  if (!existsSync(path)) return true;
  const removed = await git(["worktree", "remove", "--force", path], cwd);
  await git(["worktree", "prune"], cwd);
  return removed.ok;
}

/**
 * Remove every epic worktree belonging to ONE run — the run-close half of #16
 * (owner decision, 2026-09-01, option (a)).
 *
 * This used to happen when the BUILD STAGE finished, which put the checkout a
 * later Watch stage needs to resolve `[src: …]` against beyond reach before the
 * Build handoff was even written: the shipped half of #16 resolved a `file` src
 * against the epic worktree, and then there was no epic worktree. Cleanup belongs
 * to the RUN's lifetime instead, so the tree lives exactly as long as the thing
 * that owns it.
 *
 * This run's trees and no others. `epicWorktreesOf` keys on the run id embedded in
 * the directory name (issue #40) and answers by reading the directory rather than
 * by asking a live `BuildSession` — which is what makes this callable from a
 * different PROCESS than the one that opened them. Every close path is exactly
 * that: `tldrx next` closing the last stage, or `tldrx run cancel` days later.
 *
 * Best effort per tree, like `removeWorktree` itself: a checkout that will not go
 * away must not turn closing a run into a failed close. The returned list is
 * MEASURED — a path is in it because it is no longer on disk, not because git
 * reported success.
 */
export async function cleanUpRunEpicWorktrees(root: string, runDir: string): Promise<readonly string[]> {
  let workspace: WorkspaceContext;
  try {
    workspace = loadWorkspace(root);
  } catch {
    return [];   // no readable workspace.yml — nothing here could be ours to remove
  }
  const removed: string[] = [];
  for (const tree of epicWorktreesOf(workspace, runDir)) {
    try {
      await removeWorktree(repoDirOf(workspace, tree.repo), tree.dir);
    } catch {
      // A worktree that will not go away is a note, not a failed close.
    }
    if (!existsSync(tree.dir)) removed.push(tree.dir);
  }
  return removed;
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

export interface PathCommit {
  readonly ok: boolean;
  /** True only when a commit was actually made — nothing to commit is `ok` and false. */
  readonly committed: boolean;
  /** What went in, repo-relative, as git named it. */
  readonly files: readonly string[];
  readonly detail: string;
}

/**
 * Commit exactly these paths, and NOTHING else — not even what the operator has
 * already staged.
 *
 * The inverse of `commitAll`, and it exists for the one place tldrx writes into a
 * checkout that is not its own: the run's close, in the operator's live tree
 * (gh #102). `commitAll`'s `git add -A` would sweep whatever the operator had in
 * flight into the framework's commit, which is exactly the move that turned a
 * refused pull into a divergent fork on aparece-v2.
 *
 * Two git behaviours carry it, both MEASURED rather than assumed (2026-09-02):
 *
 *   - `git commit -- <pathspec>` commits the given paths and leaves the rest of
 *     the index alone. A `README.md` the operator had staged is still staged, and
 *     still uncommitted, afterwards.
 *   - it only picks up paths git already KNOWS, so the `git add` below is what
 *     brings a run's brand-new files in — and an `:(exclude)` on that add really
 *     does keep a path out of the commit, because `commit -- <path>` will not
 *     resurrect a file that is neither tracked nor in the index.
 *
 * Two shapes are DROPPED rather than turned into a failed close, because git
 * treats both as an error and neither is one:
 *
 *   - a path that does not exist (`git add` on an unmatched pathspec exits 1), and
 *   - a path the repo gitignores. A workspace that deliberately ignores
 *     `tldrx-work/` is not a workspace whose close should report a failure at it;
 *     `git add <ignored dir>` exits 1 with "Use -f if you really want to add
 *     them", and forcing is exactly what must not happen.
 */
export async function commitPathsOnly(
  cwd: string,
  message: string,
  paths: readonly string[],
  exclude: readonly string[] = [],
): Promise<PathCommit> {
  const onDisk = paths.filter((path) => existsSync(join(cwd, path)));
  const present = onDisk.length === 0 ? [] : await notIgnored(cwd, onDisk);
  if (present.length === 0) return { ok: true, committed: false, files: [], detail: "nothing git will take" };

  const staged = await git(["add", "--", ...present, ...exclude.map((path) => `:(exclude)${path}`)], cwd);
  if (!staged.ok) return { ok: false, committed: false, files: [], detail: firstLine(staged.stderr) };

  const listed = await git(["diff", "--cached", "--name-only", "--", ...present], cwd);
  const files = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (files.length === 0) return { ok: true, committed: false, files: [], detail: "already committed" };

  const committed = await git(["commit", "-m", message, "--", ...present], cwd);
  if (!committed.ok) {
    return { ok: false, committed: false, files, detail: firstLine(committed.stderr) || firstLine(committed.stdout) };
  }
  return { ok: true, committed: true, files, detail: firstLine(committed.stdout) };
}

/**
 * The subset of `paths` this repo does NOT gitignore.
 *
 * `git check-ignore` prints the ones it DOES ignore and exits 1 when it matched
 * nothing — which is the common case, and not a failure. A `check-ignore` that
 * errors outright (128) answers "none of them are ignored": a probe that could not
 * tell must not silently drop the state the caller asked to commit.
 */
async function notIgnored(cwd: string, paths: readonly string[]): Promise<readonly string[]> {
  const asked = await git(["check-ignore", "--", ...paths], cwd);
  if (asked.exitCode !== 0) return paths;
  const ignored = new Set(asked.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  return paths.filter((path) => !ignored.has(path));
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
  return `git diff ${diffRange(base, branch)}`;
}

/** The range both the reviewer's command and the measured surface are read over. */
export function diffRange(base: string, branch: string): string {
  return `${base}...${branch}`;
}

/**
 * The reviewer's diff command, and the ONE place its BASE is derived (#166).
 *
 * `diffBase` is the epic's sha as it was immediately before the story merged.
 * Unknown — absent, null or empty — falls back to the epic BRANCH, which is
 * byte-for-byte the command this produced before the field existed: a bundle or
 * a ledger written by an older binary reads exactly as it did.
 *
 * It lives here, beside `diffCommand`, because THREE readers need the same
 * answer and a second copy of the fallback is how they would come to disagree:
 * `buildReviewerPrompt` renders it into the prompt, `writeReviewBundle` records
 * it in `pending.json`, and the handshake's whole claim is that those two are
 * the same string. `diffCommand` itself is unchanged — a sha and a branch are
 * both refs.
 */
export function reviewDiffCommand(
  diffBase: string | null | undefined, epicBranch: string, branch: string,
): string {
  return `git diff ${reviewDiffRange(diffBase, epicBranch, branch)}`;
}

/**
 * The same answer as a RANGE, for the callers that run git rather than print it.
 *
 * Added by #185, which measures a story's changed paths against its declared
 * `touches:`: "the story's diff" must have ONE definition, and it is this one.
 * A second `${base}...${branch}` derivation beside it is how the measurement and
 * the review would come to disagree about which commits are the story's.
 */
export function reviewDiffRange(
  diffBase: string | null | undefined, epicBranch: string, branch: string,
): string {
  return diffRange(
    diffBase === undefined || diffBase === null || diffBase === "" ? epicBranch : diffBase,
    branch,
  );
}

export function firstLine(text: string, max = 200): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
