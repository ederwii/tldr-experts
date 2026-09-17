/**
 * The guard behind #335 (see `test/fixtures/tmpdirGuard.ts` for the mechanism): a
 * `$TMPDIR` inside a git work tree lets a spawning test's git operations land on the
 * enclosing branch instead of its own throwaway repo.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { checkTmpdirOutsideWorktree, TMPDIR_WORKTREE_OPT_OUT } from "./fixtures/tmpdirGuard.ts";

setDefaultTimeout(spawnTestTimeout());

describe("the shared sandbox refuses a TMPDIR inside a git work tree (#335)", () => {
  test("a fresh throwaway git repo used as TMPDIR is refused, with a named reason", () => {
    const repo = mkdtempSync(join(tmpdir(), "tldrx-guard-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const result = checkTmpdirOutsideWorktree(repo);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("git work tree");
      expect(result.reason).toContain("#335");
      expect(result.reason).toContain(TMPDIR_WORKTREE_OPT_OUT);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a directory outside any git repo is fine", () => {
    const outside = mkdtempSync(join(tmpdir(), "tldrx-guard-clean-"));
    try {
      expect(checkTmpdirOutsideWorktree(outside)).toEqual({ ok: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the opt-out env var has a stable, documented name", () => {
    expect(TMPDIR_WORKTREE_OPT_OUT).toBe("TLDRX_ALLOW_TMPDIR_IN_WORKTREE");
  });
});
