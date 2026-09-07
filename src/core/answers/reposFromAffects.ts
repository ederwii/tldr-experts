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
 */
export interface AffectsRepos {
  /** Declared repo names, de-duplicated, in the order they were named. */
  readonly repos: readonly string[];
  /** `repo:path` entries whose prefix is not a declared repo — named, never guessed at. */
  readonly unresolved: readonly string[];
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
      if (!repos.includes(entry)) repos.push(entry);
      continue;
    }
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;            // an unqualified path: nothing, and no complaint
    const prefix = entry.slice(0, colon);
    if (repoNames.has(prefix)) {
      if (!repos.includes(prefix)) repos.push(prefix);
      continue;
    }
    unresolved.push(entry);
  }
  return { repos, unresolved };
}
