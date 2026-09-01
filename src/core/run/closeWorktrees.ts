/**
 * What a CLOSING run does with the epic worktrees it opened (issue #16, owner
 * decision 2026-09-01, option (a)).
 *
 * The policy has one home because it has three callers and they are three
 * different commands: `tldrx next` closing the last stage, `tldrx approve`
 * signing the last gate, and `tldrx run cancel` abandoning the run. Each of them
 * is a run close, and a rule that lived at only one of them would leak the
 * checkouts of every run that closed by another route.
 *
 * The decision it enforces: an epic worktree lives for the life of the RUN, not
 * of the Build stage that opened it — so a later Watch stage can cite code that
 * is committed on the epic branch and merged nowhere — and `--keep-worktrees`,
 * remembered on the run as `keep_worktrees`, means "survive even this".
 */
import { cleanUpRunEpicWorktrees } from "../build/git.ts";
import type { RunFile } from "./RunFile.ts";

/** Returns the worktree paths actually removed — empty when the run says keep. */
export async function closeRunWorktrees(
  run: RunFile,
  root: string,
  runDir: string,
): Promise<readonly string[]> {
  if (run.keep_worktrees === true) return [];
  return await cleanUpRunEpicWorktrees(root, runDir);
}
