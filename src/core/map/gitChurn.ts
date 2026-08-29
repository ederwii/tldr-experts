/**
 * Churn from `git log --numstat`, parsed, not estimated.
 *
 * The window is 90 days because that is what `map/hotspots.md` claims; if the
 * window changes, the claim in the rendered bullet changes with it.
 */
import type { CommandRunner } from "../detect/CommandRunner.ts";

export const CHURN_WINDOW_DAYS = 90;
export const CHURN_ARGV: readonly string[] = [
  "git", "log", `--since=${CHURN_WINDOW_DAYS}.days`, "--numstat", "--format=%s",
];
/** The `[src: …]` payload proving where churn numbers came from. */
export const CHURN_SRC = `$ git log --since=${CHURN_WINDOW_DAYS}.days --numstat → exit 0`;

export interface FileChurn {
  readonly path: string;
  readonly commits: number;
  readonly added: number;
  readonly deleted: number;
}

export interface ChurnReport {
  readonly ok: boolean;
  readonly commitCount: number;
  readonly subjects: readonly string[];
  /** Sorted by commits desc, then lines changed desc, then path asc. */
  readonly files: readonly FileChurn[];
}

export async function collectChurn(runner: CommandRunner, repoDir: string): Promise<ChurnReport> {
  const result = await runner.run(CHURN_ARGV, repoDir);
  if (result.exitCode !== 0) return { ok: false, commitCount: 0, subjects: [], files: [] };
  return parseChurn(result.stdout);
}

/**
 * `--format=%s --numstat` prints one subject line per commit, then its numstat
 * rows (three tab-separated fields). Anything else non-empty is a subject.
 */
export function parseChurn(stdout: string): ChurnReport {
  const totals = new Map<string, { commits: number; added: number; deleted: number }>();
  const subjects: string[] = [];
  let seenInCommit = new Set<string>();

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length !== 3) {
      subjects.push(line);
      seenInCommit = new Set<string>();
      continue;
    }
    const [added, deleted, path] = parts;
    if (added === undefined || deleted === undefined || path === undefined || path === "") continue;
    const entry = totals.get(path) ?? { commits: 0, added: 0, deleted: 0 };
    if (!seenInCommit.has(path)) {
      entry.commits += 1;
      seenInCommit.add(path);
    }
    entry.added += Number.parseInt(added, 10) || 0;
    entry.deleted += Number.parseInt(deleted, 10) || 0;
    totals.set(path, entry);
  }

  const files: FileChurn[] = [...totals.entries()]
    .map(([path, value]) => ({ path, ...value }))
    .sort((a, b) =>
      b.commits - a.commits
      || (b.added + b.deleted) - (a.added + a.deleted)
      || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { ok: true, commitCount: subjects.length, subjects, files };
}
