/**
 * WHICH experts a stage prompt loads (spec §2.3).
 *
 * Spec §2.3 gives two rules: `experts:` names folders, and `stack_experts: true`
 * "also load stack expertise for `run.repos`". Measured 2026-08-29 on a fixture
 * whose `.tldrx/experts/` held `product`, `dotnet-stack`, `typescript-stack` and a
 * trained `checkout` domain expert: the What stage loaded three of the four, and
 * the one it left on the floor was the only one that had read the code the run
 * touches. `checkout` is not in any shipped `experts:` list because a stage file
 * is written once, for every workspace, and cannot know that THIS workspace has a
 * checkout domain.
 *
 * Worse, the names the shipped stage files DO use were mostly names `init` never
 * wrote. `stages/what/stage.yml` asked for `product` and `domain`; `init` seeded
 * `product`, `<lang>-stack` and one expert per detected source folder
 * (`src/core/init/planExperts.ts`), so `domain` resolved to nothing and
 * `loadExpertBodies` skipped it in silence. This module reports that gap instead
 * of swallowing it. Wave I closed both halves: `init` now seeds the five ROLE
 * experts the stage files name, and `domain`/`stack` were retired from those
 * lists — they were never expert NAMES, they were rules 2 and 3 below, written
 * out as though they were folders.
 *
 * So there are three reasons an expert loads, and the order below is the order
 * they appear in the prompt:
 *
 *   `stage`   named in `stage.yml experts:`
 *   `stack`   `<language>-stack` for a language of a repo in this run
 *   `domain`  `kind: domain`, and its declared repos or paths intersect the run
 *
 * Deterministic by construction: stage order, then workspace.yml repo order, then
 * path-matched domain experts before repo-matched ones, each group sorted by name.
 * Nothing here reads a clock or a directory mtime.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { expertsDir } from "./loadExperts.ts";
import { pathsIntersect, readExpertDomain, type ExpertDomain } from "./expertDomain.ts";

export type ExpertReason = "stage" | "stack" | "domain";

export interface SelectedExpert {
  readonly name: string;
  readonly reason: ExpertReason;
  /** For `domain`: what it matched on, for the `--prepare` line and `expert list`. */
  readonly match?: string;
}

export interface ExpertSelection {
  readonly experts: readonly SelectedExpert[];
  /** Names a stage file declares that have no folder on disk — a silent gap, said out loud. */
  readonly missing: readonly string[];
  /** Domain experts that matched but fell past the cap. */
  readonly overflow: readonly string[];
  /** `LEGACY_STAGE_EXPERTS` a stage file still names — ignored, and said once. */
  readonly legacy: readonly string[];
}

export interface SelectExpertsInput {
  readonly root: string;
  /** `stage.yml experts:`, in file order. */
  readonly staged: readonly string[];
  /** `run.repos` (or a feature's / story's repos, for the executors). */
  readonly repos: readonly string[];
  /** `stage.yml stack_experts:`. */
  readonly stackExperts: boolean;
  /** `<language>-stack` names for `repos`, already resolved by the caller. */
  readonly stackNames: readonly string[];
  /**
   * Paths this run has already cited — its declared inputs and seed documents.
   * A domain expert whose folder contains one of them ranks above one that only
   * shares a repo.
   */
  readonly citedPaths?: readonly string[];
}

/**
 * `[assumption]` — the same cap `init` puts on seeded domain experts
 * (`planExperts.ts:MAX_DOMAIN_EXPERTS`). A monorepo can hold eight of them and a
 * run that touches the repo intersects all eight; loading every one would spend
 * the prompt on experts nobody asked for. The ones past the cap are NAMED in the
 * overflow rather than dropped quietly.
 */
export const MAX_DOMAIN_SELECTED = 8;

/**
 * The two names that were never experts.
 *
 * Until wave I the shipped `stages/how/stage.yml` read `experts: [architect,
 * domain, stack]`, and `stages/what/stage.yml` read `[product, domain]`. Neither
 * `domain` nor `stack` is a folder `init` ever wrote or could write: they are
 * placeholders for rules 2 and 3 above, which pick the right stack expert for the
 * run's repos and the right domain expert for the run's paths — by workspace, not
 * by a name a stage file could know.
 *
 * They are removed from the shipped stage files, but a fork or an older workspace
 * will still carry them, and reporting a rule as a MISSING EXPERT on every stage
 * of every run is noise that trains an operator to ignore the missing-expert line
 * — which is the one line that matters when a real name is misspelled. So exactly
 * these two are ignored, once, with a note saying why. A workspace that really
 * does have a `.tldrx/experts/domain/` folder loads it like any other name: the
 * check below runs first, and only a name with NO folder can be legacy.
 */
export const LEGACY_STAGE_EXPERTS: readonly string[] = ["domain", "stack"];

export function selectExperts(input: SelectExpertsInput): ExpertSelection {
  const experts: SelectedExpert[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  const legacy: string[] = [];

  for (const name of input.staged) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!hasExpert(input.root, name)) {
      if (LEGACY_STAGE_EXPERTS.includes(name)) legacy.push(name);
      else missing.push(name);
      continue;
    }
    experts.push({ name, reason: "stage" });
  }

  if (input.stackExperts) {
    for (const name of input.stackNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!hasExpert(input.root, name)) continue;
      experts.push({ name, reason: "stack" });
    }
  }

  const { picked, overflow } = domainMatches(input, seen);
  for (const match of picked) {
    seen.add(match.name);
    experts.push(match);
  }

  return { experts, missing, overflow, legacy };
}

/** Every expert folder on disk, sorted — the same order `loadExperts` uses. */
export function expertNames(root: string): readonly string[] {
  const dir = expertsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => {
      try {
        return statSync(`${dir}/${entry}`).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function hasExpert(root: string, name: string): boolean {
  return existsSync(`${expertsDir(root)}/${name}`);
}

function domainMatches(
  input: SelectExpertsInput,
  seen: ReadonlySet<string>,
): { picked: readonly SelectedExpert[]; overflow: readonly string[] } {
  if (input.repos.length === 0 && (input.citedPaths ?? []).length === 0) {
    return { picked: [], overflow: [] };
  }
  const byPath: SelectedExpert[] = [];
  const byRepo: SelectedExpert[] = [];

  for (const name of expertNames(input.root)) {
    if (seen.has(name)) continue;
    const declared = readExpertDomain(input.root, name);
    if (declared.kind !== "domain") continue;

    const path = matchedPath(declared, input.citedPaths ?? []);
    if (path !== null) {
      byPath.push({ name, reason: "domain", match: path });
      continue;
    }
    const repo = declared.repos.find((r) => input.repos.includes(r));
    if (repo !== undefined) byRepo.push({ name, reason: "domain", match: `repo ${repo}` });
  }

  const ranked = [...byPath, ...byRepo];
  return {
    picked: ranked.slice(0, MAX_DOMAIN_SELECTED),
    overflow: ranked.slice(MAX_DOMAIN_SELECTED).map((item) => item.name),
  };
}

/**
 * The first cited path inside this expert's declared domain.
 *
 * A declared path is repo-RELATIVE (`init` writes the folder, the repo is in the
 * front matter), so each one is tried both as written and prefixed with each of
 * the expert's repos — `src/Checkout` and `api/src/Checkout` are the same claim
 * seen from two directories.
 */
export function matchedPath(declared: ExpertDomain, citedPaths: readonly string[]): string | null {
  for (const cited of citedPaths) {
    for (const path of declared.paths) {
      if (pathsIntersect(path, cited)) return cited;
      for (const repo of declared.repos) {
        if (pathsIntersect(`${repo}/${path}`, cited)) return cited;
      }
    }
  }
  return null;
}
