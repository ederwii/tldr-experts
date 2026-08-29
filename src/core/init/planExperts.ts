/**
 * Which experts `init` seeds (concept §4.5).
 *
 * Three kinds, and the order below is the order they are written:
 *
 *  - **role**, always exactly the five the shipped stage files name
 *    (`ROLE_EXPERTS`): product · architect · delivery · developer · operations.
 *    They are unconditional because `stages/<stage>/stage.yml` names them, and until
 *    wave I `init` seeded only `product` — so on every real workspace four of the
 *    five printed `expert <name> — NOT LOADED` and the stage ran with no body for
 *    that role at all (measured 2026-08-29 on `~/aparece-v2`). Their subject is
 *    the workflow rather than a folder, so their bodies ship as editable files
 *    under `templates/experts/<role>.md` instead of being generated from
 *    detection, which knows nothing about them.
 *  - **stack**, one per language actually detected, plus one per language the
 *    operator DECLARED (`--stack`, or the greenfield interview answer) when there
 *    is no code to detect it from. Frameworks become competency AREAS of the
 *    language expert rather than experts of their own — react without typescript
 *    is not a thing this workspace has.
 *  - **domain**, one per top-level source folder the map found, capped so a large
 *    monorepo does not produce fifty stubs nobody trains.
 */
import { repoSlug } from "../detect/repoSlug.ts";
import { ROLE_AREA_TITLES, ROLE_EXPERTS } from "../experts/roleExperts.ts";
import type { DetectedWorkspace } from "../detect/types.ts";
import type { MapFacts } from "../map/MapFacts.ts";
import type { AreaSeed } from "./competenciesDocument.ts";

export const MAX_DOMAIN_EXPERTS = 8;
export const PRODUCT_EXPERT = "product";

const LANGUAGES: readonly string[] = ["typescript", "javascript", "dotnet", "python", "go", "rust"];

export type ExpertKind = "role" | "stack" | "domain";

export interface ExpertPlan {
  readonly name: string;
  readonly kind: ExpertKind;
  /** Repo names this expert speaks for. */
  readonly repos: readonly string[];
  /** Source folders, for domain experts. */
  readonly folders: readonly string[];
  readonly areas: readonly AreaSeed[];
}

export interface ExpertPlanOptions {
  /**
   * Languages the operator declared rather than the filesystem showed — the
   * greenfield answer to "which stack will this project use?". Each one gets a
   * `<lang>-stack` expert even though no manifest proves it yet.
   */
  readonly declaredLanguages?: readonly string[];
  /** Slug of the project the product expert speaks for; defaults to the first repo. */
  readonly project?: string;
}

export function planExperts(
  workspace: DetectedWorkspace,
  facts: readonly MapFacts[],
  options: ExpertPlanOptions = {},
): ExpertPlan[] {
  const plans: ExpertPlan[] = [];
  const taken = new Set<string>();
  const repoNames = workspace.repos.map((repo) => repo.name);
  const project = options.project ?? repoNames[0] ?? "product";

  for (const role of ROLE_EXPERTS) {
    taken.add(role);
    // `product` keeps the area id `init` has always given it — the project's own
    // slug — because it is the one role whose subject has a real name this
    // workspace knows. The other four are named for the role itself.
    const area: AreaSeed = role === PRODUCT_EXPERT
      ? { id: project, title: `The ${project} product: what it is for and what counts as done`, mode: "full" }
      : { id: role, title: ROLE_AREA_TITLES[role] ?? `The ${role} role in this workflow`, mode: "full" };
    plans.push({ name: role, kind: "role", repos: repoNames, folders: [], areas: [area] });
  }

  for (const language of languagesOf(workspace, options.declaredLanguages ?? [])) {
    const repos = workspace.repos.filter((repo) => repo.languages.includes(language));
    const name = `${language}-stack`;
    if (taken.has(name)) continue;
    taken.add(name);
    const frameworks = [...new Set(repos.flatMap((repo) =>
      repo.stack.filter((item) => !LANGUAGES.includes(item))))].sort();
    plans.push({
      name,
      kind: "stack",
      // A declared language has no repo that proves it, so it speaks for all of them.
      repos: repos.length > 0 ? repos.map((repo) => repo.name) : repoNames,
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

/**
 * Detected languages first (in the fixed `LANGUAGES` order, so ids are stable),
 * then declared ones the detection did not already find.
 */
function languagesOf(
  workspace: DetectedWorkspace,
  declared: readonly string[],
): readonly string[] {
  const found = LANGUAGES.filter((language) =>
    workspace.repos.some((repo) => repo.languages.includes(language)));
  const extra = declared.filter((language) => language !== "" && !found.includes(language));
  return [...found, ...new Set(extra)];
}
