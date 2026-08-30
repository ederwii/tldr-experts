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
  /**
   * Whether this expert earns a share of the stage's knowledge budget (wave N).
   * `false` means body only: nothing it declares intersects anything this stage
   * cites. Absent is treated as `true` by every caller.
   */
  readonly relevant?: boolean;
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
  /**
   * How many repos `workspace.yml` declares. A repo match is only evidence in a
   * workspace that HAS more than one repo (wave N); see `domainMatches`.
   */
  readonly workspaceRepoCount?: number;
  /**
   * Paths within `GRAPH_HOPS` links of a cited path in `graphify-out/graph.json`
   * (`domainRank.ts`). Empty or absent ⇒ only direct path matches score, which is
   * what a workspace with no graph gets.
   */
  readonly nearbyPaths?: ReadonlySet<string>;
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
    // A stage NAMED it. That is the strongest relevance signal there is, and a
    // role expert has no `## Domain` paths to score.
    experts.push({ name, reason: "stage", relevant: true });
  }

  if (input.stackExperts) {
    for (const name of input.stackNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!hasExpert(input.root, name)) continue;
      experts.push({ name, reason: "stack", relevant: true });
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

/**
 * Rule 3, ranked by RELEVANCE rather than by co-residence (wave N).
 *
 * Three things changed, and the first is the load-bearing one:
 *
 * 1. **A repo match is only evidence in a workspace that has more than one
 *    repo.** In a single-repo workspace every domain expert shares the run's
 *    repo, so `repos:` selects everybody and selects nothing. Measured
 *    2026-08-29 on `~/aparece-v2` (`mode: single-repo`): eight of the nine
 *    experts a What prompt loaded were there by repo alone, they contributed
 *    52% of a 159,575-byte prompt, and not one of them had read a file the run
 *    cited. `workspaceRepoCount` is what decides; when a caller does not say,
 *    the old behaviour is kept, because a caller with no opinion must not have
 *    one imposed.
 * 2. **Rank is a score, not a bucket.** A direct path match — the expert's
 *    `## Domain` naming a folder that contains a cited path — is worth
 *    `DIRECT_WEIGHT`; being within `GRAPH_HOPS` links of one in `graph.json` is
 *    worth 1. Scores add, so an expert that owns two cited paths outranks one
 *    that owns one, deterministically.
 * 3. **Zero score means body only.** An expert with no intersection at all still
 *    loads when its repo qualifies (rule 3 is unchanged in a multi-repo
 *    workspace) but earns none of the shared knowledge budget: `relevant: false`.
 *    Its `expert.md` is ~1 KB; its knowledge was 25 KB.
 */
export const DIRECT_WEIGHT = 10;
export const GRAPH_HOPS = 2;

interface Scored {
  readonly expert: SelectedExpert;
  readonly score: number;
}

function domainMatches(
  input: SelectExpertsInput,
  seen: ReadonlySet<string>,
): { picked: readonly SelectedExpert[]; overflow: readonly string[] } {
  if (input.repos.length === 0 && (input.citedPaths ?? []).length === 0) {
    return { picked: [], overflow: [] };
  }
  // A single-repo workspace cannot use `repos:` to tell experts apart, so it does
  // not try. `undefined` means the caller did not say, and nothing changes.
  const repoIsEvidence = (input.workspaceRepoCount ?? 2) >= 2;
  const cited = input.citedPaths ?? [];
  const nearby = input.nearbyPaths ?? new Set<string>();
  const scored: Scored[] = [];

  for (const name of expertNames(input.root)) {
    if (seen.has(name)) continue;
    const declared = readExpertDomain(input.root, name);
    if (declared.kind !== "domain") continue;

    const direct = countMatches(declared, cited);
    const near = direct > 0 ? 0 : countMatches(declared, [...nearby]);
    const score = direct * DIRECT_WEIGHT + near;

    if (score > 0) {
      const match = direct > 0
        ? matchedPath(declared, cited) ?? "path"
        : `${String(near)} path(s) within ${String(GRAPH_HOPS)} hops in graph.json`;
      scored.push({ expert: { name, reason: "domain", match, relevant: true }, score });
      continue;
    }
    if (!repoIsEvidence) continue;
    const repo = declared.repos.find((r) => input.repos.includes(r));
    if (repo !== undefined) {
      scored.push({
        expert: { name, reason: "domain", match: `repo ${repo}`, relevant: false },
        score: 0,
      });
    }
  }

  // Score desc, then name asc: total, and identical on every machine.
  const ranked = [...scored]
    .sort((a, b) => b.score - a.score
      || (a.expert.name < b.expert.name ? -1 : a.expert.name > b.expert.name ? 1 : 0))
    .map((entry) => entry.expert);
  return {
    picked: ranked.slice(0, MAX_DOMAIN_SELECTED),
    overflow: ranked.slice(MAX_DOMAIN_SELECTED).map((item) => item.name),
  };
}

/** How many of `paths` this expert's declared domain contains. */
export function countMatches(declared: ExpertDomain, paths: readonly string[]): number {
  let count = 0;
  for (const cited of paths) {
    if (matchedPath(declared, [cited]) !== null) count += 1;
  }
  return count;
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
