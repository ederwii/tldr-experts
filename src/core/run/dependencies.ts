/**
 * Which run comes first — resolved once, for `tldrx status` and the dashboard.
 *
 * A run created by `tldrx seed apply` records `triage.depends_on` (spec §2.2):
 * the SLUGS of the sibling runs it was proposed to follow. Wave J taught
 * `tldrx status` to read them, so a run whose dependency has not finished is not
 * offered as the next thing to do however loudly it says `ready`. That logic
 * lived inline in `status/runItems.ts` and could not be reused; this is the same
 * rules, lifted out, so the dashboard answers "blocked by what, and in what
 * order" identically instead of inventing a second answer.
 *
 * Three rules, all inherited from wave J and preserved exactly:
 *
 *   slugs, not ids   `depends_on` names slugs because those are what the split
 *                    proposed. A run id is `<yymmdd>-<slug>`, so a slug is
 *                    matched back to the run carrying it. Input order is
 *                    newest-first, so the newest run wins a slug collision.
 *   missing blocks   A dependency with no run at all counts as unfinished — it
 *                    was proposed to come first and it does not exist. Its raw
 *                    slug stays in `dependsOn`/`blockedBy` as its own id.
 *   `done` releases  Only `status: done` clears a dependency. A cancelled or
 *                    failed sibling still blocks, because it did not deliver
 *                    what the dependent was told to build on.
 *
 * And one rule added by #60:
 *
 *   started wins     A proposal cannot un-start a run that has started. Once a
 *                    run leaves `pending` its OBSERVED state outranks the order
 *                    a split proposed, so it is `runnable` on its own waiting
 *                    kind and the proposal becomes a note. `blockedBy` still
 *                    lists the unfinished dependencies — that is a fact about
 *                    the proposal, and both renderers want it either way — but
 *                    it is no longer allowed to mean "cannot move".
 *
 * Pure: plain records in, plain records out. It reads no file and imports
 * nothing, so both callers can feed it from whichever reader they already have.
 */

/** How many root-to-leaf chains are rendered before the rest are dropped. */
export const MAX_CHAINS = 24;

/** One run, as the ordering needs it. */
export interface DependencyInput {
  readonly id: string;
  /** `run.yml` status. Only `done` releases a dependent. */
  readonly status: string;
  /** Verbatim `triage.depends_on` — SLUGS, not ids. */
  readonly dependsOn: readonly string[];
  /** True when this run's waiting kind is one a human could act on now. */
  readonly movable: boolean;
  readonly updatedAt: string | null;
}

export interface ResolvedRun {
  readonly id: string;
  /** `dependsOn` resolved to run ids; a slug with no run keeps the raw slug. */
  readonly dependsOn: readonly string[];
  /**
   * The subset of `dependsOn` that is not `done` — including ones with no run.
   *
   * A statement about the PROPOSAL, not a verdict on this run: once `started` is
   * true these are runs it was proposed to follow and did not. A renderer that
   * turns this into "blocked by" without checking `started` prints #60.
   */
  readonly blockedBy: readonly string[];
  /** This run has left `pending` — work has observably begun. See `hasStarted`. */
  readonly started: boolean;
  /** A human could move it right now, and nothing that still applies blocks it. */
  readonly runnable: boolean;
}

/**
 * Has this run actually begun?
 *
 * `pending` is the only status a run that has never run a stage can wear: a run
 * is created with every stage `pending` (`newRun.ts`), `run.yml`'s status is
 * re-derived from the stage at the cursor on every save, and every path to any
 * other value — `ready` included — goes through a stage that was `running`.
 * So the question is one comparison, and it is the one the ordering rules ask.
 */
export function hasStarted(status: string): boolean {
  return status !== "pending";
}

export interface DependencyGraph {
  /** One entry per input, in input order. */
  readonly runs: readonly ResolvedRun[];
  /** Every id, topologically sorted, runnable first, then newest-updated. */
  readonly order: readonly string[];
  /**
   * Root-to-leaf dependency paths, each id depending on the one before it.
   * Only real edges between known runs, only chains of two or more, capped at
   * `MAX_CHAINS` so a dense graph cannot blow the page up.
   */
  readonly chains: readonly (readonly string[])[];
}

/** `260829-decisions-gate` → `decisions-gate`; anything else keeps its whole id. */
export function slugOfRun(runId: string): string {
  return /^\d{6}-(.+)$/.exec(runId)?.[1] ?? runId;
}

/**
 * Resolve every run's dependencies, the workspace order, and the chains.
 *
 * Pass EVERY run on disk, not only the open ones: a dependency satisfied by a
 * finished run has to be visible as satisfied, and a caller that only knows
 * about open runs would read every completed prerequisite as missing.
 */
export function resolveDependencies(inputs: readonly DependencyInput[]): DependencyGraph {
  const idBySlug = new Map<string, string>();
  const statusById = new Map<string, string>();
  for (const input of inputs) {
    statusById.set(input.id, input.status);
    const slug = slugOfRun(input.id);
    if (!idBySlug.has(slug)) idBySlug.set(slug, input.id);
  }

  const runs: ResolvedRun[] = inputs.map((input) => {
    const dependsOn = input.dependsOn.map((slug) => idBySlug.get(slug) ?? slug);
    const blockedBy = dependsOn.filter((id) => statusById.get(id) !== "done");
    const started = hasStarted(input.status);
    // #60: a started run is runnable on its own waiting kind. The live case was a
    // run RUNNING at 04-build with stories in flight that `tldrx status` demoted
    // out of the `← next` slot in favour of a sibling that had not begun.
    return {
      id: input.id,
      dependsOn,
      blockedBy,
      started,
      runnable: input.movable && (started || blockedBy.length === 0),
    };
  });

  return { runs, order: orderOf(inputs, runs), chains: chainsOf(inputs, runs) };
}

/**
 * Topological, runnable first, then newest-updated, then by id.
 *
 * Kahn's algorithm with a sorted ready-set: at every step the available run a
 * human would pick is emitted next, so the head of the list is the run to work
 * on. Anything left over after the sweep — a cycle, or a run whose dependency
 * points outside the workspace — is appended in the same tie-break order rather
 * than dropped: this is a reading order, not a scheduler, and a run that cannot
 * be placed still has to appear.
 */
function orderOf(
  inputs: readonly DependencyInput[],
  runs: readonly ResolvedRun[],
): readonly string[] {
  const known = new Set(inputs.map((input) => input.id));
  const byId = new Map(runs.map((run) => [run.id, run]));
  const inputById = new Map(inputs.map((input) => [input.id, input]));
  const waitingOn = new Map<string, Set<string>>();
  for (const run of runs) {
    waitingOn.set(run.id, new Set(run.dependsOn.filter((id) => known.has(id) && id !== run.id)));
  }

  const rank = (a: string, b: string): number => {
    const left = byId.get(a);
    const right = byId.get(b);
    const leftRunnable = left !== undefined && left.runnable;
    const rightRunnable = right !== undefined && right.runnable;
    if (leftRunnable !== rightRunnable) return leftRunnable ? -1 : 1;
    const leftAt = inputById.get(a)?.updatedAt ?? "";
    const rightAt = inputById.get(b)?.updatedAt ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return a.localeCompare(b);
  };

  const placed: string[] = [];
  const left = new Set(known);
  while (left.size > 0) {
    const ready = [...left].filter((id) => (waitingOn.get(id)?.size ?? 0) === 0).sort(rank);
    const next = ready[0];
    if (next === undefined) break;
    placed.push(next);
    left.delete(next);
    for (const id of left) waitingOn.get(id)?.delete(next);
  }
  return [...placed, ...[...left].sort(rank)];
}

/**
 * Every root-to-leaf path through the dependency graph.
 *
 * A path, not a topological flattening: each arrow the renderer draws is a real
 * `depends_on` edge, so `A → B → C` never claims an ordering nobody asked for.
 * A tree therefore yields one chain per branch, which is what a reader wants to
 * see — the branches are genuinely independent after the fork.
 */
function chainsOf(
  inputs: readonly DependencyInput[],
  runs: readonly ResolvedRun[],
): readonly (readonly string[])[] {
  const known = new Set(inputs.map((input) => input.id));
  const parents = new Map<string, readonly string[]>();
  const children = new Map<string, string[]>();
  for (const id of known) children.set(id, []);
  for (const run of runs) {
    const edges = run.dependsOn.filter((id) => known.has(id) && id !== run.id);
    parents.set(run.id, edges);
    for (const parent of edges) children.get(parent)?.push(run.id);
  }

  const roots = [...known].filter((id) => (parents.get(id) ?? []).length === 0).sort();
  const chains: string[][] = [];
  const walk = (path: readonly string[]): void => {
    if (chains.length >= MAX_CHAINS) return;
    const head = path[path.length - 1] ?? "";
    const next = (children.get(head) ?? []).filter((id) => !path.includes(id)).sort();
    if (next.length === 0) {
      if (path.length > 1) chains.push([...path]);
      return;
    }
    for (const child of next) walk([...path, child]);
  };
  for (const root of roots) walk([root]);
  return chains;
}
