/**
 * What a run does on its way out: take back the epic worktrees it opened, and
 * commit the state it wrote (issue #16 and issue #102).
 *
 * The policy has one home because it has three callers and they are three
 * different commands: `tldrx next` closing the last stage, `tldrx approve`
 * signing the last gate, and `tldrx run cancel` abandoning the run. Each of them
 * is a run close, and a rule that lived at only one of them would leak the
 * checkouts — or the state — of every run that closed by another route.
 *
 * ## Worktrees (#16, owner decision 2026-09-01, option (a))
 *
 * An epic worktree lives for the life of the RUN, not of the Build stage that
 * opened it — so a later Watch stage can cite code that is committed on the epic
 * branch and merged nowhere — and `--keep-worktrees`, remembered on the run as
 * `keep_worktrees`, means "survive even this".
 *
 * ## State (#102)
 *
 * In a `root_is_repo` workspace the facilitator writes `run.yml`, `events.jsonl`,
 * `budget.yml` and every phase document into the operator's WORKING TREE. Before
 * this, nothing committed them, so they sat dirty for the length of the run and
 * any commit of the same paths arriving from anywhere else met a dirty tree.
 *
 * Measured on aparece-v2 (run `260830-ordering-inventory`, 2026-09-02): the run
 * closed at 14:14:00Z; ninety-two seconds later the operator's agent — filling a
 * gap the framework had left — committed a snapshot of the whole live tree onto
 * `epic/ordering-inventory`; PR #10 merged it; the operator's `git pull` was
 * refused over five modified and about forty untracked paths, and the recovery was
 * a rebase.
 *
 * So the close commits that state itself, and three properties decide where:
 *
 *   - **In the operator's checkout, on the branch it is on.** The live copy is the
 *     truth — it is the one the facilitator has been writing to all run — and a
 *     branch it is already on cannot collide with itself.
 *   - **Never on the run's own epic.** An epic under review carries feature code;
 *     process meta-state on it is the thing that collides. A checkout that happens
 *     to sit on the epic gets `on-epic` and no commit, which is a report, not a
 *     failure: the state is still on disk and still the truth.
 *   - **Only tldrx's own paths.** `commitPathsOnly` commits `tldrx-work/<run>/`
 *     and `.tldrx/memory/` and leaves everything else — including whatever the
 *     operator had staged — exactly where it was. `partitionDirty` has drawn this
 *     same line since 2026-08-30: these paths are the framework's writes, not the
 *     operator's dirt.
 *
 * It never pushes. Spec §5 — publishing a branch is the operator's decision — and
 * a local commit on their own branch is the smallest thing that makes the next
 * `git pull` clean.
 */
import { relative, resolve, sep } from "node:path";
import { cleanUpRunEpicWorktrees, commitPathsOnly, currentBranch, git, headSha } from "../build/git.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
import type { RunFile } from "./RunFile.ts";

/** Where the run's own state ended up, and why, when it did not end up committed. */
export type StateCommit =
  | { readonly kind: "committed"; readonly branch: string; readonly sha: string; readonly files: readonly string[] }
  /** Nothing had changed — a re-close, or a workspace whose state is committed as it goes. */
  | { readonly kind: "clean" }
  /** The workspace root is not inside a git checkout, or the state lives outside it. */
  | { readonly kind: "outside-git" }
  /** The checkout sits on the run's own epic branch. Deliberately not committed. */
  | { readonly kind: "on-epic"; readonly branch: string }
  /** Detached HEAD: there is no branch for this to belong to. */
  | { readonly kind: "detached" }
  | { readonly kind: "failed"; readonly detail: string };

export interface RunCloseOutcome {
  /** Worktree paths actually removed — empty when the run says keep. */
  readonly worktreesRemoved: readonly string[];
  readonly state: StateCommit;
}

/** Which verb closed the run. It reaches the commit message and nothing else. */
export type CloseReason = "closed" | "cancelled";

export async function closeRun(
  run: RunFile,
  root: string,
  runDir: string,
  runId: string,
  reason: CloseReason = "closed",
): Promise<RunCloseOutcome> {
  const worktreesRemoved = run.keep_worktrees === true ? [] : await cleanUpRunEpicWorktrees(root, runDir);
  const state = await commitRunState(run, root, runDir, runId, reason);
  return { worktreesRemoved, state };
}

/**
 * Kept as its own export because `tldrx run cancel` and the two gate paths all
 * want the same sentence out of it, and because a test that asks only "where did
 * the state go" should not have to remove worktrees to find out.
 */
export async function commitRunState(
  run: RunFile,
  root: string,
  runDir: string,
  runId: string,
  reason: CloseReason,
): Promise<StateCommit> {
  // Is the workspace root inside a git checkout at all? The ANSWER is what is
  // wanted, never the path it prints: on macOS `--show-toplevel` resolves
  // `/var/folders/...` to `/private/var/folders/...`, so path arithmetic against
  // it says the workspace escapes its own repo (measured 2026-09-02, in this
  // file's own fixture). Pathspecs below are relative to `root`, which is the cwd
  // git resolves them against, so no path arithmetic is needed at all.
  const inRepo = await git(["rev-parse", "--is-inside-work-tree"], root);
  if (!inRepo.ok || inRepo.stdout.trim() !== "true") return { kind: "outside-git" };
  const runRel = relativeInside(root, runDir);
  const memoryRel = `${PROJECT_FRAMEWORK_DIR}/memory`;
  if (runRel === null) return { kind: "outside-git" };

  const branch = await currentBranch(root);
  if (branch === "") return { kind: "failed", detail: "`git rev-parse --abbrev-ref HEAD` failed" };
  if (branch === "HEAD") return { kind: "detached" };
  if ((run.build?.epic_branch ?? []).includes(branch)) return { kind: "on-epic", branch };

  const paths = [runRel, memoryRel];
  const done = await commitPathsOnly(
    root,
    message(runId, reason),
    paths,
    // Belt as well as braces: `init` gitignores these, but a workspace whose
    // managed block predates that (aparece-v2's did) would otherwise have the
    // close commit the backups of the very files it is committing. This is the
    // seam that reaches EXISTING workspaces, which get the widened ignore only on
    // their next `tldrx init`.
    //
    // `*` and not `**`: a git pathspec is fnmatch WITHOUT FNM_PATHNAME, so `*`
    // already crosses directories and `<path>/*.bak` excludes at every depth.
    // `<path>/**/*.bak` needs a literal slash for the `**` to sit in and MISSES
    // `tldrx-work/<run>/run.yml.bak` — measured 2026-09-02, both patterns, same
    // tree.
    paths.map((path) => `${path}/*.bak`),
  );
  if (!done.ok) return { kind: "failed", detail: done.detail };
  if (!done.committed) return { kind: "clean" };
  return { kind: "committed", branch, sha: await headSha(root), files: done.files };
}

/**
 * One line the operator can read in `git log`, and a body that says why the commit
 * exists at all — the next person to see it will be wondering whether tldrx was
 * supposed to be committing in their repo.
 */
function message(runId: string, reason: CloseReason): string {
  return [
    `tldrx: run ${runId} ${reason} — its own state, on the branch it was written on`,
    "",
    `Only ${PROJECT_WORK_DIR}/${runId}/ and ${PROJECT_FRAMEWORK_DIR}/memory/ — the framework's`,
    "writes, never the product. The epic branch carries feature code; run state on it",
    "collides with this working tree on the next pull (gh #102).",
  ].join("\n");
}

/** `path` as a POSIX path relative to `base`, or null when it escapes it. */
function relativeInside(base: string, path: string): string | null {
  const rel = relative(resolve(base), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("/")) return null;
  return rel.split(sep).join("/");
}

/** Describe the state half of a close in one line, or null when there is nothing to say. */
export function describeStateCommit(state: StateCommit): string | null {
  switch (state.kind) {
    case "committed":
      return `run state committed on \`${state.branch}\` (${state.sha}, ${String(state.files.length)} file(s)) `
        + "— the epic carries feature code only";
    case "on-epic":
      return `run state NOT committed — this checkout is on \`${state.branch}\`, the run's own epic branch. `
        + "Switch to your trunk and commit it there; run state on the epic collides on the next pull.";
    case "failed":
      return `run state could not be committed — ${state.detail}. It is still on disk; commit it yourself.`;
    case "detached":
      return "run state NOT committed — this checkout is on a detached HEAD, so there is no branch to put it on.";
    case "clean":
    case "outside-git":
      return null;
  }
}
