/**
 * `ticket_tool.project` for the github provider — read from a real remote, never
 * guessed from a folder name.
 *
 * The GitHub adapter needs `owner/repo` (`adapters/github.ts` REPO_RE) and refuses
 * anything else, so the interview answering "GitHub Issues" is only half a decision:
 * the other half is which repo. `git remote get-url origin` is the one place that
 * fact already exists, and it is read through the same `CommandRunner` seam
 * detection uses — argv only, no shell, no second spawn path.
 *
 * A remote that is not GitHub, a repo with no `origin`, or a URL that does not
 * reduce to `owner/repo` all yield `null`: the caller writes `kind: github` with no
 * project and prints a note, because inventing a project key would put a wrong
 * `owner/repo` in front of `gh issue create`.
 */
import { join } from "node:path";
import { loadWorkspace } from "../../hooks/lib/workspace.ts";
import { REPO_RE } from "../adapters/github.ts";
import type { CommandRunner } from "../detect/CommandRunner.ts";

/**
 * The forms `git remote get-url` actually prints for GitHub:
 *   https://github.com/o/r        https://github.com/o/r.git
 *   https://user@github.com/o/r   ssh://git@github.com/o/r.git
 *   git@github.com:o/r            git@github.com:o/r.git
 * Anything else — a GitLab URL, a local path, an enterprise host — is not GitHub
 * and is reported as such rather than half-parsed.
 */
const GITHUB_URL_RE =
  /^(?:(?:https?|ssh):\/\/(?:[^@/\s]*@)?github\.com\/|(?:[^@\s]+@)?github\.com:)(.+)$/i;

/** `owner/repo`, or null when the URL is not a GitHub repo URL. */
export function parseGithubRemote(url: string): string | null {
  const match = GITHUB_URL_RE.exec(url.trim());
  if (match === null) return null;
  const path = (match[1] ?? "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return REPO_RE.test(path) ? path : null;
}

export interface GithubProjectResult {
  /** `owner/repo`, or null when no candidate had a GitHub `origin`. */
  readonly project: string | null;
  /** Which candidate it came from: a `workspace.yml` repo name, or `.` for the root. */
  readonly from: string | null;
  /** Remotes that were read and rejected, in the order they were tried. */
  readonly rejected: readonly string[];
}

/**
 * The workspace root first, then every `workspace.yml` repo in file order — the
 * first one whose `origin` is a GitHub URL wins. A multi-repo workspace mirrors to
 * one issue tracker, so "first" is a choice and the result says which repo made it.
 */
export async function resolveGithubProject(
  root: string,
  runner: CommandRunner,
): Promise<GithubProjectResult> {
  const candidates: { name: string; dir: string }[] = [{ name: ".", dir: root }];
  for (const [name, rel] of loadWorkspace(root).repos) candidates.push({ name, dir: join(root, rel) });

  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.dir)) continue;
    seen.add(candidate.dir);
    const result = await runner.run(["git", "remote", "get-url", "origin"], candidate.dir);
    if (result.exitCode !== 0) continue;
    const url = result.stdout.trim();
    if (url === "") continue;
    const project = parseGithubRemote(url);
    if (project !== null) return { project, from: candidate.name, rejected };
    rejected.push(url);
  }
  return { project: null, from: null, rejected };
}
