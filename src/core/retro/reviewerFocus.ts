/**
 * Feeding the adversarial reviewer this workspace's own recurring defects (#74).
 *
 * The single highest-leverage use of the `retro --all` aggregate, and the one #64
 * named and did not build: tell a story's reviewer what this team's top finding
 * classes ARE before it reads the diff. Every review used to start from zero and
 * rediscover `test-cannot-fail` on its own, run after run, while the evidence
 * that it would was already on disk.
 *
 * Three rules govern what is offered:
 *
 *   - **`other` is never offered.** It is a real row in the table — a table it
 *     dominates says the taxonomy is too small — but "this team keeps producing
 *     `other`" tells a reviewer nothing to look for. Naming a class you cannot
 *     act on is noise in a prompt that is charged per token.
 *   - **Top {@link REVIEWER_FOCUS_TOP_N}, ranked by count.** A prior long enough
 *     to be a checklist becomes one, and a reviewer working a checklist finds
 *     items on it. Three is what #64's own issue asked for.
 *   - **Absence is silence.** No runs, no findings, nothing but `other`, or a
 *     `finding-classes.yml` that will not load — every one of those renders no
 *     section at all. This must never be able to change a verdict by being
 *     broken.
 *
 * What the reviewer is told is exactly the top of what `tldrx retro --all`
 * prints, computed from the same `mineAll` over the same workspace. An operator
 * who wants to know what their reviewers are being primed with runs that command.
 */
import type { RecurringClass } from "../build/prompts.ts";
import { mineAll, OTHER, type AllRetro } from "./findings.ts";
import { FindingClassesError } from "./findingClasses.ts";

/** How many classes reach the prompt. Three, per #64's own wording. */
export const REVIEWER_FOCUS_TOP_N = 3;

/**
 * The top classes of an aggregate, `other` dropped, bounded at `topN`.
 *
 * `report.trends` is already ranked by count with ties broken by the taxonomy's
 * order, so this filters and slices rather than re-sorting: two callers that
 * disagreed about the ranking would be two different priors.
 */
export function recurringClasses(
  report: AllRetro, topN: number = REVIEWER_FOCUS_TOP_N,
): readonly RecurringClass[] {
  return report.trends
    .filter((trend) => trend.cls !== OTHER)
    .slice(0, Math.max(0, topN))
    .map((trend) => ({
      cls: trend.cls,
      count: trend.count,
      runs: trend.runs.length,
      example: trend.example?.text ?? null,
      src: trend.example?.src ?? null,
    }));
}

/** What a workspace's history says, and the reason it could not be read. */
export interface WorkspaceRecurring {
  readonly classes: readonly RecurringClass[];
  /**
   * One line, already fit to print, when `.tldrx/memory/finding-classes.yml` was
   * refused. Null when there was nothing wrong — including when there was simply
   * no history, which is not an error.
   */
  readonly error: string | null;
}

/**
 * The absent-safe entry point the Build executor calls.
 *
 * It never throws. A workspace with a broken taxonomy file loses its reviewer
 * prior, which is a degradation; a workspace whose REVIEW dies because a YAML
 * file has a typo in it has lost a story's attempt, which is a defect. So the
 * refusal comes back as a line the caller can surface — silently swallowing it
 * would leave a team editing a file that had stopped being read.
 *
 * Anything else thrown while mining is also caught. Mining is a read over
 * arbitrary files in a workspace nobody has validated; the only outcome it may
 * ever have on the review path is "no section".
 */
export function workspaceRecurring(
  root: string, topN: number = REVIEWER_FOCUS_TOP_N,
): WorkspaceRecurring {
  try {
    return { classes: recurringClasses(mineAll(root), topN), error: null };
  } catch (error) {
    if (error instanceof FindingClassesError) return { classes: [], error: error.message };
    return {
      classes: [],
      error: `the cross-run retro aggregate could not be read — ${
        error instanceof Error ? error.message : String(error)}`,
    };
  }
}
