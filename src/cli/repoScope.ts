/**
 * "Is `--repo <name>` a repo this workspace declares?", answered once for every
 * command that scopes a fact with it.
 *
 * `tldrx answer` has asked this since wave 4 and `tldrx facts add` did not (#186):
 * the same flag, writing the same `repos:` field on the same record through the
 * same store, was validated on one path and copied straight onto the record on the
 * other. `facts add --repo ghost` exited 0 and wrote `repos: [ghost]`. That is the
 * dangerous direction — a fact scoped to a repo that does not exist is not a loud
 * failure but a silent one: `renderFacts`'s filter is keyed on the real repo name,
 * so the fact is simply never shown to anyone again, and nothing surfaces the
 * mismatch.
 *
 * It is a leaf and not a copy because the refusal is a SENTENCE, and two sentences
 * drift while both commands' own tests keep passing. Both halves of the derivation
 * live here: the de-duplication (`uniqueRepos`, which is itself the one
 * de-duplication a fact's `repos` has — `reposFromAffects.ts`) and the check.
 *
 * It returns the refusal rather than throwing it, so each caller keeps the name it
 * already answers to on stderr: `tldrx answer:` raises it as a `UsageError` through
 * `fail`, `tldrx facts add:` prints it under its own sub-command prefix. Both are
 * exit 1 — spec §3's "usage/schema error", the family `answer`'s refusal already
 * lived in (AGENTS §7: one condition, one family).
 */
import { uniqueRepos } from "../core/answers/reposFromAffects.ts";

/** Either the repos to scope with, de-duplicated, or the one sentence saying why not. */
export type RepoScope =
  | { readonly repos: readonly string[] }
  | { readonly problem: string };

export function isScoped(result: RepoScope): result is { readonly repos: readonly string[] } {
  return "repos" in result;
}

export function scopeRepos(
  names: readonly string[],
  repoNames: ReadonlySet<string>,
): RepoScope {
  const wanted = uniqueRepos(names);
  for (const repo of wanted) {
    if (repoNames.has(repo)) continue;
    // A workspace with no declared repos is its own sentence: "— it has " with
    // nothing after it reads as a truncated message, not as an answer.
    return {
      problem: `--repo ${repo} is not a repo in this workspace — `
        + (repoNames.size === 0
          ? "this workspace declares no repos"
          : `it has ${[...repoNames].join(", ")}`),
    };
  }
  return { repos: wanted };
}
