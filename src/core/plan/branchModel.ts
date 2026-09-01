/**
 * Which branches a run's Build phase cuts — one per epic, or one for the run
 * (issue #57, owner decision (a), 2026-09-01).
 *
 * ## The failure this replaces
 *
 * Concept §9 gives every epic its own branch: `epic/<epic>` ← `story/<id>`.
 * That holds exactly while the epics are INDEPENDENT. Run
 * `260829-scoring-leaderboard` planned E2 (the API) with E3 and E4 (the two
 * mobile epics) consuming it, and one-branch-per-epic cannot express that: a
 * downstream story's base is cut from its own epic branch, which was cut from
 * the default branch, so it never sees the upstream epic's merged work. It broke
 * twice, and both times the host fast-forwarded the EPIC branches by hand —
 * collapsing branches the owner may have meant to merge separately, using a
 * feature (design §F.2) built for stale STORY bases.
 *
 * ## The rule
 *
 * If any story depends on a story in another epic, the epics form a chain and
 * the run cuts ONE integration branch; the epics stay in the plan as labels and
 * groupings. Otherwise it is branch-per-epic, byte for byte as before.
 *
 * Detection is a property of the PLAN — `validatePlan` reports the edges it
 * read, the `plan` gate check renders them, and the Build executor recomputes
 * them from the same story files. One function, three readers, so the check
 * cannot promise a branch model the executor does not cut.
 *
 * ## Why `epic/<run-slug>` and not `integration/<run-slug>`
 *
 * Conservative on purpose. `EPIC_BRANCH_RE`, `watch/features.ts`'s slug
 * extraction, `ship`, `boundary`, the `--reuse-epic` guard and every operator
 * message in the Build executor are keyed on the `epic/` prefix. A second branch
 * namespace would need all of them changed to buy a word, and the owner asked
 * for a branch model, not a vocabulary. The RUN id is in the name — unlike an
 * ordinary epic branch, which is deliberately unscoped because an epic is the
 * unit a team merges — because an integration branch belongs to one run by
 * definition, and a name that says so can never be mistaken for a foreign epic.
 */
import { EPIC_BRANCH_RE } from "../schemas/planCommon.ts";
import { INTEGRATION_EPIC_SLOT } from "../paths.ts";

/** One literal, two readers: the worktree name is computed in `core/paths.ts`. */
export { INTEGRATION_EPIC_SLOT };

export const BRANCH_MODELS = ["per-epic", "integration"] as const;
export type BranchModelKind = (typeof BRANCH_MODELS)[number];

export function isBranchModelKind(value: unknown): value is BranchModelKind {
  return typeof value === "string" && (BRANCH_MODELS as readonly string[]).includes(value);
}

/**
 * One epic depends on another, and the story pair that says so.
 *
 * Deduplicated per epic PAIR: three stories of E3 all needing E2's work is one
 * relation, and rendering it three times in a gate detail would spend the whole
 * line on the same sentence.
 */
export interface EpicDependencyEdge {
  /** The epic that needs the other's work. */
  readonly from: string;
  /** The epic whose work is needed. */
  readonly to: string;
  /** The first story that declared it — evidence, so the edge is checkable. */
  readonly story: string;
  readonly dependsOn: string;
}

export interface BranchModel {
  readonly kind: BranchModelKind;
  /** The one branch every story merges into. Null for `per-epic`. */
  readonly integrationBranch: string | null;
  /** The cross-epic edges that forced it. Empty for `per-epic`. */
  readonly chain: readonly EpicDependencyEdge[];
}

/**
 * Every cross-epic dependency the plan declares, in story order.
 *
 * `epicOf` is story id -> its `epic:`; `dependsOn` is story id -> its
 * `depends_on`. A dependency naming a story with no epic on file produces NO
 * edge: that is a missing-story error for the plan validator to report, and
 * inventing a branch model out of it would be a guess.
 *
 * "Directly or transitively" needs no closure here. Any single cross-epic edge
 * already means the epics are not independent, which is the whole question; the
 * closure would change which epics are NAMED, never the answer.
 */
export function detectEpicChain(
  epicOf: ReadonlyMap<string, string>,
  dependsOn: ReadonlyMap<string, readonly string[]>,
): readonly EpicDependencyEdge[] {
  const edges: EpicDependencyEdge[] = [];
  const seen = new Set<string>();
  for (const [story, deps] of dependsOn) {
    const from = epicOf.get(story);
    if (from === undefined) continue;
    for (const dep of deps) {
      const to = epicOf.get(dep);
      if (to === undefined || to === from) continue;
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, story, dependsOn: dep });
    }
  }
  return edges;
}

/** True when the epics are not independent, so one branch is the model. */
export function isChained(chain: readonly EpicDependencyEdge[]): boolean {
  return chain.length > 0;
}

/**
 * `epic/<run-slug>` — the run's integration branch, forced into
 * `EPIC_BRANCH_RE`'s shape so every existing reader of an epic branch accepts it.
 */
export function integrationBranchFor(runId: string): string {
  const slug = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 49);
  return `epic/${slug === "" ? "run" : slug}`;
}

/** The model this run will execute, from the chain its plan declares. */
export function branchModelFor(runId: string, chain: readonly EpicDependencyEdge[]): BranchModel {
  if (!isChained(chain)) return { kind: "per-epic", integrationBranch: null, chain: [] };
  return { kind: "integration", integrationBranch: integrationBranchFor(runId), chain };
}

/** A model recorded in `run.yml`, rebuilt without re-reading the plan. */
export function branchModelOfKind(kind: BranchModelKind, runId: string): BranchModel {
  return kind === "integration"
    ? { kind, integrationBranch: integrationBranchFor(runId), chain: [] }
    : { kind, integrationBranch: null, chain: [] };
}

/**
 * The branch an epic's stories are cut from and merged into.
 *
 * `declared` is the epic's own `branch:` — used as-is under `per-epic`, and
 * ignored under `integration`, where the epic is a label.
 */
export function epicBranchOf(model: BranchModel, declared: string): string {
  return model.kind === "integration" && model.integrationBranch !== null
    ? model.integrationBranch
    : declared;
}

/**
 * The `_epic-<run>-<slot>` slot this epic's worktree occupies.
 *
 * Under `integration` every epic shares ONE branch, and git refuses to check the
 * same branch out in two worktrees — so they must share one slot too, or the
 * second epic's first merge would fail on a path git will not create.
 */
export function epicWorktreeSlotOf(model: BranchModel, epicId: string): string {
  return model.kind === "integration" ? INTEGRATION_EPIC_SLOT : epicId;
}

/**
 * The sentence the Plan gate — and the Build stage's own lines — say out loud.
 *
 * The owner must never discover the branch model mid-Build (issue #57), so it is
 * stated wherever the plan is judged, in the same words in both places.
 */
export function describeBranchModel(model: BranchModel): string {
  if (model.kind === "per-epic") {
    return "independent epics → one branch each";
  }
  const named = model.chain.slice(0, MAX_NAMED_EDGES).map((e) => `${e.from}→${e.to}`);
  const rest = model.chain.length - named.length;
  const edges = rest > 0 ? `${named.join(", ")} (+${String(rest)} more)` : named.join(", ");
  return `epics form a chain (${edges}) → single integration branch \`${model.integrationBranch ?? ""}\``;
}

/** How many edges are named before the rest become a count. */
const MAX_NAMED_EDGES = 4;

/** Every `integrationBranchFor` result is a legal `epic/<slug>`; asserted in tests. */
export const INTEGRATION_BRANCH_RE = EPIC_BRANCH_RE;
