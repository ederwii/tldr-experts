/**
 * `bun test` preload (wired via `bunfig.toml`'s `[test].preload`) — runs once, before any
 * test file, in the same process. This is the ONE place the #335 guard needs to be: every
 * spawning fixture resolves its sandbox through `os.tmpdir()`/`$TMPDIR`, so checking the
 * resolved value here catches all ~85 of them without a change to any of those files.
 *
 * Refuses, named, with a non-zero exit, unless the caller opts out via
 * `TLDRX_ALLOW_TMPDIR_IN_WORKTREE=1` (see `test/fixtures/tmpdirGuard.ts` for the check and
 * the mechanism it guards against).
 */
import { tmpdir } from "node:os";
import { checkTmpdirOutsideWorktree, TMPDIR_WORKTREE_OPT_OUT } from "../fixtures/tmpdirGuard.ts";

if (!process.env[TMPDIR_WORKTREE_OPT_OUT]) {
  const result = checkTmpdirOutsideWorktree(tmpdir());
  if (!result.ok) {
    console.error(`[tmpdir-guard] ${result.reason}`);
    process.exit(1);
  }
}
