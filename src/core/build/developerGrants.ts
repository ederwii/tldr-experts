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

/**
 * Does any command `.tldrx/workspace.yml` declares GRANT this line? (gh #285)
 *
 * The read side of `bashGrantsFor` (`facilitator/spawnAgent.ts`), which is the
 * one place a declared command becomes a permission: it writes `Bash(<D>)` and
 * `Bash(<D> *)`, so a line runs iff it IS a declared command or is one followed
 * by arguments. Nothing else — not a shared first token, not a prefix of a
 * token. Measured on the field case behind #285: `dotnet build` and
 * `dotnet test` were declared and `dotnet ef migrations add …` was refused four
 * times, so "the first token is declared" is NOT the rule and a check that used
 * it would have stayed silent on the exact story it exists for.
 *
 * A leaf, and deliberately the ONLY notion of "granted by a workspace command"
 * (AGENTS.md §7): the Plan-time prose warning and the Build-time refusal cure
 * both call it, so they cannot disagree about what the developer can run.
 */
export function grantsCommand(declared: Iterable<string>, line: string): boolean {
  const command = line.trim();
  if (command === "") return false;
  for (const slot of declared) {
    if (command === slot || command.startsWith(`${slot} `)) return true;
  }
  return false;
}

/**
 * The `commands:` slot VALUE that would grant `line` — the operator's cure, and
 * never more of the line than a slot should hold.
 *
 * Two tokens when the line has them (`dotnet ef`, `npm run`, `prisma migrate`),
 * because the shape that keeps being missing is `<tool> <subcommand>` and a slot
 * carrying the whole invocation would grant only that one invocation's tail.
 * One token otherwise. Arguments never ride along: the grant is the slot plus
 * arguments, so the narrowest slot that runs the line is the honest cure.
 */
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]*$/;

export function slotForCommand(line: string): string {
  const argv = line.trim().split(/\s+/).filter((token) => token !== "");
  const head = argv[0] ?? "";
  const second = argv[1] ?? "";
  // The second token joins the slot only when it reads as a SUBCOMMAND: a bare
  // lowercase word. A flag is an argument (`pytest -q` wants `pytest`), and so is
  // a file — caught by the suite, where `sha256sum s1.txt` would otherwise have
  // asked the operator to declare a slot with one story's filename baked into it.
  return SUBCOMMAND_RE.test(second) ? `${head} ${second}` : head;
}
