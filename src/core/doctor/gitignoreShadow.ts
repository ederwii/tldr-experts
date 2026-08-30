/**
 * Is anything the workspace MUST commit being ignored?
 *
 * `init` writes a managed `.gitignore` block whose negations re-include
 * `tldrx-work/` and `.tldrx/` (see `init/ambientFootprint.ts`). That block only
 * helps a workspace that ran `init` after 2026-08-30, it only lives in the ROOT
 * `.gitignore`, and it cannot see `.git/info/exclude`, a global excludesfile, or
 * a nested `.gitignore` deeper in the tree. So the block is the fix and this is
 * the detector: ask git itself, about the paths that are committed state.
 *
 * The measured failure it exists for: a real user's repo carried the stock .NET
 * `[Ll]og/` rule, which swallowed `tldrx-work/<run>/04-build/log/<story>.md` —
 * the per-story review log the Build handoff cites. Nothing errored. The file was
 * written, `git status` stayed quiet, and the run's own record of what the
 * reviewer said never reached a teammate's clone.
 *
 * A warning, never a blocker: `DoctorReport.healthy` is about the TOOLS this
 * machine has, and someone else's `.gitignore` is not one of them.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";

/** A local `git check-ignore` is milliseconds; this only catches a hung git. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * A file name that cannot collide with a real story, used to probe the
 * `04-build/log/` directory whether or not the run has reached Build. The path
 * does not have to exist: `--no-index` makes `check-ignore` a pure question
 * about the RULES.
 */
export const LOG_PROBE_NAME = "tldrx-doctor-probe.md";

/** Run id used when the workspace has no run yet — the rules still apply to it. */
const SYNTHETIC_RUN = "000000-doctor-probe";

export interface ShadowedPath {
  /** Workspace-relative, POSIX separators — exactly what was handed to git. */
  readonly path: string;
  /** Where the rule lives, as git names it: `.gitignore`, `.git/info/exclude`, … */
  readonly source: string;
  readonly line: number;
  readonly pattern: string;
}

export interface GitignoreShadowResult {
  /** False when git could not answer — which is not the claim "nothing is wrong". */
  readonly ran: boolean;
  readonly error: string | null;
  /** Every path asked about, so the report can say how wide the sample was. */
  readonly probed: readonly string[];
  readonly shadowed: readonly ShadowedPath[];
}

/**
 * The sample: one path per kind of state file, not a walk of the tree.
 *
 * `doctor` must stay a command you run without thinking about what it will
 * touch, and a rule broad enough to eat one run's `run.yml` eats every run's.
 */
export function probePaths(root: string): readonly string[] {
  const run = newestRun(root) ?? SYNTHETIC_RUN;
  const work = PROJECT_WORK_DIR;
  return [
    `${work}/${run}/run.yml`,
    `${work}/${run}/events.jsonl`,
    `${work}/${run}/04-build/log/${LOG_PROBE_NAME}`,
    `${PROJECT_FRAMEWORK_DIR}/memory/facts.yml`,
  ];
}

/** Run ids are `<yymmdd>-<slug>`, so the greatest name is the newest run. */
function newestRun(root: string): string | null {
  const work = join(root, PROJECT_WORK_DIR);
  if (!existsSync(work)) return null;
  let newest: string | null = null;
  try {
    for (const name of readdirSync(work)) {
      if (name.startsWith(".")) continue;
      if (!statSync(join(work, name)).isDirectory()) continue;
      if (newest === null || name > newest) newest = name;
    }
  } catch {
    return null;
  }
  return newest;
}

export async function findGitignoreShadows(root: string): Promise<GitignoreShadowResult> {
  const probed = probePaths(root);
  // `-z` is the only unambiguous output: a pattern may contain a colon and a
  // path may contain a tab, so the human format `source:line:pattern\tpath`
  // cannot be split correctly. `-z` requires `--stdin`, hence the NUL-fed argv.
  // `--no-index` asks about the RULES rather than about what is already tracked:
  // a rule that would swallow the NEXT log is worth reporting even if today's
  // log was added with `git add -f`.
  const result = await runtime.spawn(
    "git",
    ["check-ignore", "--verbose", "--no-index", "-z", "--stdin"],
    { cwd: root, stdin: `${probed.join("\0")}\0`, timeoutMs: GIT_TIMEOUT_MS },
  );

  // Exit 0 = at least one path matched SOME pattern; 1 = none matched at all.
  // With `--verbose` a negated match counts as a match, so the exit code says
  // nothing about ignoring — only the `!` on each pattern does. 128 is a fatal
  // git error (measured: "not a git repository"), and 127 is the seam's
  // could-not-spawn.
  if (result.timedOut) return failed(probed, "`git check-ignore` timed out");
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return failed(probed, firstLine(result.stderr) || `git exited ${String(result.exitCode)}`);
  }

  return { ran: true, error: null, probed, shadowed: parseCheckIgnoreZ(result.stdout) };
}

function failed(probed: readonly string[], error: string): GitignoreShadowResult {
  return { ran: false, error, probed, shadowed: [] };
}

/**
 * `source\0line\0pattern\0path\0` per record (measured against git 2.x).
 *
 * A pattern opening with `!` is a RE-INCLUSION — the path is fine and is not
 * reported. Anything else won, so the path is ignored.
 */
export function parseCheckIgnoreZ(stdout: string): readonly ShadowedPath[] {
  const fields = stdout.split("\0");
  const shadowed: ShadowedPath[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source, rawLine, pattern, path] = [fields[i], fields[i + 1], fields[i + 2], fields[i + 3]];
    if (source === undefined || rawLine === undefined || pattern === undefined || path === undefined) break;
    if (pattern.startsWith("!")) continue;
    const line = Number.parseInt(rawLine, 10);
    shadowed.push({ path, source, line: Number.isNaN(line) ? 0 : line, pattern });
  }
  return shadowed;
}

/** `.gitignore:12:[Ll]og/` — the form `git check-ignore -v` prints. */
export function describeRule(shadow: ShadowedPath): string {
  return `${shadow.source}:${String(shadow.line)}:${shadow.pattern}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}
