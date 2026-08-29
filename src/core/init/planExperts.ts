/**
 * Which experts `init` seeds (concept §4.5).
 *
 * One stack expert per language actually detected, one domain expert per
 * top-level source folder the map found, capped so a large monorepo does not
 * produce fifty stubs nobody trains. Frameworks become competency AREAS of the
 * language expert rather than experts of their own — react without typescript
 * is not a thing this workspace has.
 */
import { repoSlug } from "../detect/repoSlug.ts";
import type { DetectedWorkspace } from "../detect/types.ts";
import type { MapFacts } from "../map/MapFacts.ts";
import type { AreaSeed } from "./competenciesDocument.ts";

export const MAX_DOMAIN_EXPERTS = 8;

const LANGUAGES: readonly string[] = ["typescript", "javascript", "dotnet", "python", "go", "rust"];

export interface ExpertPlan {
  readonly name: string;
  readonly kind: "stack" | "domain";
  /** Repo names this expert speaks for. */
  readonly repos: readonly string[];
  /** Source folders, for domain experts. */
  readonly folders: readonly string[];
  readonly areas: readonly AreaSeed[];
}

export function planExperts(
  workspace: DetectedWorkspace,
  facts: readonly MapFacts[],
): ExpertPlan[] {
  const plans: ExpertPlan[] = [];
  const taken = new Set<string>();

  for (const language of LANGUAGES) {
    const repos = workspace.repos.filter((repo) => repo.languages.includes(language));
    if (repos.length === 0) continue;
    const name = `${language}-stack`;
    taken.add(name);
    const frameworks = [...new Set(repos.flatMap((repo) =>
      repo.stack.filter((item) => !LANGUAGES.includes(item))))].sort();
    plans.push({
      name,
      kind: "stack",
      repos: repos.map((repo) => repo.name),
      folders: [],
      areas: [
        { id: language, title: `${language} language, build and test tooling` },
        ...frameworks.map((framework) => ({ id: framework, title: `${framework} as used in this workspace` })),
      ],
    });
  }

  // Round-robin across repos: the cap is a budget for the workspace, and the
  // first repo in the list must not spend all of it.
  let domains = 0;
  for (let rank = 0; domains < MAX_DOMAIN_EXPERTS; rank += 1) {
    const round = facts.filter((item) => rank < item.domains.length);
    if (round.length === 0) break;
    for (const item of round) {
      if (domains >= MAX_DOMAIN_EXPERTS) break;
      const folder = item.domains[rank];
      if (folder === undefined) continue;
      const name = repoSlug(folder.split("/").pop() ?? folder);
      if (taken.has(name)) continue;
      taken.add(name);
      domains += 1;
      plans.push({
        name,
        kind: "domain",
        repos: [item.repo],
        folders: [folder],
        areas: [{ id: name, title: `The ${name} domain in ${item.repo}` }],
      });
    }
  }
  return plans;
}
