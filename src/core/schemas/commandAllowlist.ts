/**
 * One rule, one implementation: **a command a data file names must be byte-equal
 * to a command `.tldrx/workspace.yml` declares.**
 *
 * Three data files want to run a shell command — a story's ```dod block (§2.13),
 * a stage's `cmd` check (§2.3) and, since design §F.1, a stage's `preconditions:`
 * — and all three are DATA. Data does not get to invent a command that will be
 * run as the user. Before this module each site spelled the rule for itself:
 * `validateStoryDod` in `story.ts`, `checkCommand` in `run/checks.ts`. Two
 * spellings of one rule is how a third site gets a third, weaker one, so the
 * comparison and both refusal sentences live here and the sites call them.
 *
 * The comparison is `Set.has` on the raw string. Not normalised, not trimmed, not
 * shell-parsed: `docker info && rm -rf ~` is refused because it is not in the set,
 * and the moment the check started being clever about what a command "means" is
 * the moment it could be argued around.
 */

/**
 * The refusal when the workspace declares NO commands at all.
 *
 * The 2026-08-29 audit measured what the old "an empty allowlist means skip the
 * rule" assumption cost: `dod-gate` runs each command through `/bin/sh -c` as the
 * user, so in a workspace with no `commands:` a story saying `dod: rm -rf ~` was
 * legal at plan time and executed at done time. An empty allowlist REFUSES.
 *
 * The wording is subject-neutral ("these commands") because a stage precondition
 * now reaches it too; every substring the dod tests assert is unchanged.
 */
export function noAllowlistMessage(command: string): string {
  return `\`${command}\` cannot be allowed: .tldrx/workspace.yml declares no commands, so there is `
    + "nothing to check it against. Add the command under the repo's `commands:` — these commands are "
    + "run for real, as you, and an empty allowlist is not a permit.";
}

/**
 * The command that repairs the drift this refusal is usually reporting.
 *
 * A story's dod block must name workspace commands VERBATIM, so editing
 * `workspace.yml` orphans every approved story that cited the old string.
 * Measured live on `260829-scoring-leaderboard` (2026-08-31): one edit —
 * a filtered `test:`, `lint:` removed — invalidated the dod blocks of 8 approved
 * stories at once, and the only recoveries on offer were hand-editing
 * agent-approved artefacts or re-running the whole Plan stage for two lines.
 */
export const SYNC_DOD_COMMAND = "tldrx plan sync-dod";

/**
 * The refusal when the workspace declares commands and this is not one of them.
 *
 * A STORY gets the remedy appended, because a story's dod block is data the
 * operator did not type and cannot be asked to retype: the constraint alone
 * states the rule and stops, which is the failure mode this repo keeps finding
 * (see #35). A STAGE does not — its `cmd:` is a line a human wrote in
 * `stage.yml`, and `sync-dod` does not touch stage files.
 */
export function notDeclaredMessage(command: string, subject: string): string {
  const rule = `\`${command}\` is not one of .tldrx/workspace.yml's commands — a ${subject} may not invent one`;
  return subject === "story"
    ? `${rule}. If workspace.yml was edited after the plan was approved, `
      + `\`${SYNC_DOD_COMMAND}\` rewrites the story's dod block to the current commands.`
    : rule;
}

/**
 * The whole rule, once. `null` ⇒ the command is allowed; a string ⇒ the refusal,
 * already worded for `subject` ("story", "stage").
 */
export function allowlistIssue(
  command: string,
  allowed: ReadonlySet<string>,
  subject: string,
): string | null {
  if (allowed.size === 0) return noAllowlistMessage(command);
  return allowed.has(command) ? null : notDeclaredMessage(command, subject);
}
