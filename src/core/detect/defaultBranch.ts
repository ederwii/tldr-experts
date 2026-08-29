/**
 * The epic-branch base for a repo.
 *
 * `git symbolic-ref refs/remotes/origin/HEAD` is the only authority we trust; a
 * repo with no origin falls back to `main` (spec §2.1 example), which is a
 * default, not a measurement — the handoff says so.
 */
import type { CommandRunner } from "./CommandRunner.ts";

export const FALLBACK_BRANCH = "main";

export interface DefaultBranch {
  readonly branch: string;
  /** True when git reported it; false when `main` was assumed. */
  readonly measured: boolean;
}

export async function detectDefaultBranch(runner: CommandRunner, repoDir: string): Promise<DefaultBranch> {
  const result = await runner.run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], repoDir);
  if (result.exitCode === 0) {
    const ref = result.stdout.trim();
    const name = ref.split("/").pop();
    if (name !== undefined && name !== "") return { branch: name, measured: true };
  }
  return { branch: FALLBACK_BRANCH, measured: false };
}
