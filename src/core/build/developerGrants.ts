/**
 * The git verbs a spawned developer holds — ONE constant, three readers (gh #278).
 *
 * `developerTools()` (`executors/build.ts`) builds the `Bash(git <verb> *)`
 * grants from it; the developer prompt (`build/prompts.ts`) lists it, so the
 * agent is TOLD which verbs it has instead of reaching for the commonest one and
 * being refused; and `classifyRefusal` (`build/refusalKind.ts`) reads it to say
 * whether a refused `git <verb>` is a verb the allowance lacks. Measured on a
 * field run: `git checkout -- <path>` refused on a "mutate, observe RED, restore"
 * story, with `git restore` granted and nothing in the prompt saying so. A list
 * that lived in three places would drift; this one cannot.
 *
 * The verbs themselves are #261's (`rm`, `mv`, `restore` beside `add` and
 * `commit`): index operations on the story's own tree, on a branch that never
 * leaves the machine. Adding one here adds it to the grant, the prompt and the
 * classifier at once — which is the point, and also why it is a decision.
 */
export const DEVELOPER_GIT_VERBS = ["add", "commit", "rm", "mv", "restore"] as const;

export type DeveloperGitVerb = (typeof DEVELOPER_GIT_VERBS)[number];

/** Space form, not `:*` — one spelling per grammar, the same one `bashGrantsFor` writes. */
export function developerGitGrants(): readonly string[] {
  return DEVELOPER_GIT_VERBS.map((verb) => `Bash(git ${verb} *)`);
}

export function isDeveloperGitVerb(verb: string): verb is DeveloperGitVerb {
  return (DEVELOPER_GIT_VERBS as readonly string[]).includes(verb);
}
