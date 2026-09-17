/**
 * The check behind #335: a spawning test that git-inits or git-commits under `$TMPDIR`
 * commits its scratch paths onto the enclosing branch when `$TMPDIR` resolves inside a
 * git work tree — git's own upward repo search walks out of the fixture and finds the
 * WORKTREE's repo, so `git add`/`git commit` land on whatever branch is checked out
 * there. Measured on 490f637: a worktree's `.tmp/` used as `$TMPDIR` reproduces the exact
 * two failures the issue reported (`test/gitignore-shadow.test.ts` "when git cannot
 * answer", `test/install.test.ts` "refuses outside a git repo") because with `$TMPDIR`
 * inside a repo there IS a repo where the fixture expected none.
 *
 * This is the ONE place that derivation lives (§7): the preload guard
 * (`test/preload/tmpdirGuard.ts`) calls it before any test file runs, and this file's own
 * test (`test/tmpdir-guard.test.ts`) calls it directly so the check itself has a red/green
 * proof independent of a whole-suite spawn.
 */
import { execFileSync } from "node:child_process";

/** Set to opt out — only once you have verified the isolation some other way. */
export const TMPDIR_WORKTREE_OPT_OUT = "TLDRX_ALLOW_TMPDIR_IN_WORKTREE";

export interface TmpdirCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/** True when `dir` is inside a git work tree — its own repo, or one enclosing it. */
export function isInsideGitWorkTree(dir: string): boolean {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return out === "true";
  } catch {
    // Not a git repo, `dir` does not exist yet, or `git` is unavailable — none of those
    // is "inside a work tree", so the guard has nothing to refuse.
    return false;
  }
}

/** Refuses, named, when `dir` (a candidate `$TMPDIR`) sits inside a git work tree. */
export function checkTmpdirOutsideWorktree(dir: string): TmpdirCheck {
  if (!isInsideGitWorkTree(dir)) return { ok: true };
  return {
    ok: false,
    reason:
      `TMPDIR (${dir}) is inside a git work tree (#335). A spawning test that git-inits or ` +
      "git-commits under $TMPDIR can have its scratch paths committed onto the enclosing " +
      "branch, because git's repo search walks out of the fixture and finds the worktree's " +
      `own repo. Point TMPDIR outside every git repo, or set ${TMPDIR_WORKTREE_OPT_OUT}=1 ` +
      "once you have verified the isolation some other way.",
  };
}
