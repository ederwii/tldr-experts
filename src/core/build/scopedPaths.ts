/**
 * The paths a story's SCOPED Definition of Done is narrowed to (#257).
 *
 * One derivation (AGENTS.md §7): the union of what the story DECLARED it would
 * touch, what it has COMMITTED on its branch, and what is DIRTY in its worktree
 * at the moment the gate runs — the DoD runs before `commitIfDirty`, so the
 * developer's uncommitted work is exactly the part a committed diff cannot see.
 * Filtered to paths that exist in the worktree: a deleted file handed to a test
 * runner is a false red about a file that is not there. Which of the surviving
 * paths a runner can DO anything with is the template's problem — `pytest` will
 * skip a `.md`, and a template that wants only sources says so in its own argv.
 *
 * DATA in, data out. No `ctx`, no session: the executor owns the range and the
 * declared list and passes them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirtyEntries, git } from "./git.ts";

export interface ScopedPathsParts {
  /** The story's `touches:` as declared — off disk when the run has a story file. */
  readonly declared: readonly string[];
  /** The repo checkout the committed diff is measured in. */
  readonly repoDir: string;
  /** The story's worktree — where the dirty entries and the existence check live. */
  readonly worktree: string;
  /** `reviewDiffRange(...)` — the ONE definition of "the story's diff". */
  readonly range: string;
}

/** Declared ∪ committed ∪ dirty, existing in the worktree, deduped, sorted. */
export async function scopedPathsFor(parts: ScopedPathsParts): Promise<readonly string[]> {
  const union = new Set<string>();
  for (const path of parts.declared) union.add(path);
  const diff = await git(["diff", "--name-only", parts.range], parts.repoDir);
  if (diff.ok) {
    for (const line of diff.stdout.split("\n")) {
      const path = line.trim();
      if (path !== "") union.add(path);
    }
  }
  for (const entry of await dirtyEntries(parts.worktree)) union.add(entry.path);
  return [...union]
    .filter((path) => path !== "" && existsSync(join(parts.worktree, path)))
    .sort();
}
