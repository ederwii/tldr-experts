/**
 * Every version of `.tldrx/workspace.yml` this workspace can still show you,
 * read as `repo -> role -> the commands that role has ever named`.
 *
 * `plan sync-dod` needs one thing the current file cannot tell it: whether
 * `npm run test` in an approved story's dod block is a command that was RENAMED
 * (so the story should follow it to `npm run test -- --filter core`) or one a
 * planning agent invented (so the story must be flagged, never rewritten). The
 * difference is a fact about the PAST, and guessing at it from string similarity
 * is exactly the kind of cleverness `commandAllowlist.ts` refuses to allow near a
 * command that will be run as the user.
 *
 * So the evidence is git's: `.tldrx/` is committed state (spec §1), and the
 * history of that file IS the history of those commands. Nothing is inferred —
 * a version that will not parse teaches nothing and is skipped, and a workspace
 * with no git history simply has no ancestors, which makes every non-current dod
 * line a flag rather than a silent rewrite. Refusing is the safe direction.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { git } from "../build/git.ts";
import { parseYaml } from "../yaml.ts";
import { commandRolesOf } from "../../hooks/lib/workspace.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";

/** The file whose history is read, relative to the workspace root. */
export const WORKSPACE_REL = `${PROJECT_FRAMEWORK_DIR}/workspace.yml`;

/**
 * How far back to look. A workspace.yml with fifty revisions has long since
 * answered the only question asked of it, and each version costs a `git show`.
 */
export const MAX_VERSIONS = 50;

/** `repo -> role -> every command that role has named, newest version first. */
export type CommandHistory = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

export interface HistoryReading {
  readonly history: CommandHistory;
  /** How many versions of the file were read, the working copy included. */
  readonly versions: number;
  /** Null when git had one; a sentence for the operator when it did not. */
  readonly unavailable: string | null;
}

/**
 * The working copy first, then each committed version newest-first, folded into
 * one `role -> commands` list per repo.
 */
export async function readWorkspaceHistory(root: string): Promise<HistoryReading> {
  const documents: unknown[] = [];
  const live = join(root, WORKSPACE_REL);
  if (existsSync(live)) {
    const parsed = parse(readFileSync(live, "utf8"));
    if (parsed !== null) documents.push(parsed);
  }
  const committed = await committedVersions(root);
  for (const text of committed.texts) {
    const parsed = parse(text);
    if (parsed !== null) documents.push(parsed);
  }

  const history = new Map<string, Map<string, string[]>>();
  for (const doc of documents) {
    for (const [repo, roles] of commandRolesOf(doc)) {
      const forRepo = history.get(repo) ?? new Map<string, string[]>();
      history.set(repo, forRepo);
      for (const [role, command] of roles) {
        const seen = forRepo.get(role) ?? [];
        if (!seen.includes(command)) seen.push(command);
        forRepo.set(role, seen);
      }
    }
  }
  return { history, versions: documents.length, unavailable: committed.why };
}

/** Every command any version ever declared for `repo`, in one set. */
export function everDeclared(history: CommandHistory, repo: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const commands of (history.get(repo) ?? new Map()).values()) {
    for (const command of commands) out.add(command);
  }
  return out;
}

/** The roles of `repo` that have, at some version, named exactly `command`. */
export function rolesThatNamed(history: CommandHistory, repo: string, command: string): readonly string[] {
  const roles: string[] = [];
  for (const [role, commands] of (history.get(repo) ?? new Map<string, readonly string[]>())) {
    if (commands.includes(command)) roles.push(role);
  }
  return roles.sort();
}

/** `realpathSync`, or the path unchanged when it names nothing yet. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function parse(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    // A version that will not parse is not evidence about anything. Skipping it
    // can only make the sync flag MORE lines, never rewrite one it should not.
    return null;
  }
}

async function committedVersions(root: string): Promise<{ texts: readonly string[]; why: string | null }> {
  const top = await git(["rev-parse", "--show-toplevel"], root);
  if (!top.ok) return { texts: [], why: `${root} is not inside a git repository, so workspace.yml has no history` };
  const toplevel = top.stdout.trim();
  if (toplevel === "") return { texts: [], why: "git named no repository root" };
  // Both sides through `realpath` before they are compared. On macOS `git
  // rev-parse --show-toplevel` answers `/private/var/…` for a root the caller
  // knows as `/var/…` (a symlink), and the raw `relative` of those two is `../..`
  // — which read as "workspace.yml is outside the repository" and silently cost
  // every story its ancestry. Measured in this file's own tests.
  const rel = relative(real(toplevel), join(real(root), WORKSPACE_REL)).split(sep).join("/");
  if (rel === "" || rel.startsWith("..")) {
    return { texts: [], why: `${WORKSPACE_REL} is outside the git repository at ${toplevel}` };
  }
  const log = await git(["log", `--max-count=${String(MAX_VERSIONS)}`, "--format=%H", "--", rel], toplevel);
  if (!log.ok) return { texts: [], why: `git log could not read ${rel}` };
  const shas = log.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (shas.length === 0) return { texts: [], why: `${rel} has never been committed, so it has no history` };
  const texts: string[] = [];
  for (const sha of shas) {
    const show = await git(["show", `${sha}:${rel}`], toplevel);
    if (show.ok) texts.push(show.stdout);
  }
  return { texts, why: null };
}
