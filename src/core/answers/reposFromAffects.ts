/**
 * Which workspace repos an answered question's `affects:` names — ONE derivation.
 *
 * `affects:` has two disjoint readers and this is the second one. `affectedDocs`
 * (`stampSuperseded.ts:100-125`) takes the run-relative `.md` documents an answer
 * overtook; this takes the repo names. An existing `affects:` line full of
 * document paths keeps meaning exactly what it meant, and each reader takes only
 * what it understands.
 *
 * An entry counts when it IS a declared repo name, or when the half before its
 * first `:` is one — the `repo:path` production of the `[src: …]` grammar.
 * Everything else contributes NOTHING, and the reason is the framework's own
 * (`src/core/build/implicitPlan.ts:1350-1352`): "A citation with no repo prefix
 * is skipped rather than guessed at — the run may have several repos, and a
 * wrong guess would put another repo's file in front of an agent told it may
 * edit only this one."
 *
 * A `repo:path` whose prefix matched nothing is NOT silently dropped: it comes
 * back in `unresolved` so the caller can name it. `repos: []` recorded after a
 * `ghost:src/db.ts` would read as "no repo was named" when one WAS named and was
 * wrong, and that is the dangerous direction.
 *
 * Both callers keep that promise, for every block they capture and not just the
 * one an invocation named: `tldrx answer` prints the line on stdout, and the
 * `answer-capture` hook posts it as context. Both render it through
 * `unresolvedEntries` (`captureAnswers.ts`) — one sentence, one spelling.
 */
export interface AffectsRepos {
  /** Declared repo names, de-duplicated, in the order they were named. */
  readonly repos: readonly string[];
  /** `repo:path` entries whose prefix is not a declared repo — named, never guessed at. */
  readonly unresolved: readonly string[];
}

/**
 * Repo names with the duplicates dropped, first mention winning.
 *
 * The ONE de-duplication of a fact's `repos`, used by both halves that can
 * produce one: this file's `affects:` reading, and `tldrx answer --repo` passed
 * more than once. Before fix round 1 only the first half de-duplicated, so
 * `--repo api --repo api` wrote `repos: [api, api]` while `affects: api api`
 * wrote `[api]` — the same scoping spelled two ways depending on where it came
 * from, and any count over `fact.repos` double-counting one of them.
 */
export function uniqueRepos(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

export function reposFromAffects(
  affects: readonly string[],
  repoNames: ReadonlySet<string>,
): AffectsRepos {
  const repos: string[] = [];
  const unresolved: string[] = [];
  for (const raw of affects) {
    const entry = raw.trim();
    if (entry === "") continue;
    if (repoNames.has(entry)) {
      repos.push(entry);
      continue;
    }
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;            // an unqualified path: nothing, and no complaint
    const prefix = entry.slice(0, colon);
    if (repoNames.has(prefix)) {
      repos.push(prefix);
      continue;
    }
    unresolved.push(entry);
  }
  return { repos: uniqueRepos(repos), unresolved };
}
