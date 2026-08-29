/**
 * Who is sitting here, according to git.
 *
 * `process.yml approvers` must be non-empty (spec §2.12), and the only name the
 * install loop can know without asking is `git config user.name`. Extracted from
 * `runInit` so the interview can create the same file with the same approver
 * through the same `CommandRunner` seam — never a second spawn path.
 */
import type { CommandRunner } from "../detect/CommandRunner.ts";

export const FALLBACK_APPROVER = "owner";

export async function gitUserName(runner: CommandRunner, cwd: string): Promise<string> {
  const result = await runner.run(["git", "config", "user.name"], cwd);
  const name = result.stdout.trim();
  return result.exitCode === 0 && name !== "" ? name : FALLBACK_APPROVER;
}
