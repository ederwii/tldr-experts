/**
 * Where the framework's own shipped files live.
 *
 * This has to be right in two very different layouts: running from source
 * (`<root>/src/core/paths.ts`) and running from the Node build
 * (`<root>/dist/tldrx.js`, `<root>/dist/hooks/*.js`). Counting `..` segments works
 * for exactly one of those, so instead we walk up looking for the marker set that
 * only the framework root has: `env.yml` + `workflows/` + `stages/` + `package.json`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const MARKERS = ["env.yml", "workflows", "stages", "package.json"] as const;

function isFrameworkRoot(dir: string): boolean {
  return MARKERS.every((marker) => existsSync(join(dir, marker)));
}

function findFrameworkRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 16; i++) {
    if (isFrameworkRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Source layout fallback: <root>/src/core/paths.ts -> <root>.
  return dirname(dirname(start));
}

/** Repo root of tldr-experts itself. */
export const FRAMEWORK_ROOT: string = findFrameworkRoot(dirname(fileURLToPath(import.meta.url)));

export const ENV_MANIFEST_PATH: string = join(FRAMEWORK_ROOT, "env.yml");
export const STAGES_DIR: string = join(FRAMEWORK_ROOT, "stages");
export const WORKFLOWS_DIR: string = join(FRAMEWORK_ROOT, "workflows");
export const TEMPLATES_DIR: string = join(FRAMEWORK_ROOT, "templates");
export const PLUGIN_DIR: string = join(FRAMEWORK_ROOT, "plugin");

/** Names of the per-project directories the framework writes into. */
export const PROJECT_FRAMEWORK_DIR = ".tldrx";
export const PROJECT_WORK_DIR = "tldrx-work";

/**
 * `.tldrx/workspace.yml` — the workspace's own RECORD of its repos (spec §2.1).
 *
 * Spelled once and shared, because three readers now name it in operator-facing
 * text and they must all name the same path: the Watch refusal, the `boundary`
 * note, and the `doctor` finding for a `default_branch` that does not resolve
 * (gh #92). A path in a message the operator is meant to go and edit is not a
 * place for three independent string literals.
 *
 * It also has to live in a LEAF module, not in `init/runInit.ts` where the
 * `init` copy of this string used to be declared (gh #94):
 * `init/loadWorkspaceFile.ts` is the small module several commands read the
 * repo list through, and taking the constant off `runInit` dragged all of
 * `init` — detection, map providers, the MCP probe — into every module that
 * read it. That pushed `dist/hooks/session-start.js` from 37,937 to 54,467
 * bytes, past the 50 KB entry-point cap `test/build.test.ts` enforces.
 */
export const PROJECT_WORKSPACE_FILE = `${PROJECT_FRAMEWORK_DIR}/workspace.yml`;

/**
 * `.tldrx/worktrees/` — where the Build phase opens its story and epic worktrees.
 * `init` gitignores it; it holds real checkouts, never framework state.
 */
export const PROJECT_WORKTREES_DIR = "worktrees";

/**
 * The prefix that tells an EPIC worktree apart from a story's.
 *
 * The convention has exactly one home because two readers of it disagree the
 * moment either moves: the Build executor WRITES the directory
 * (`facilitator/executors/build.ts`), and the §2.8 src resolver READS it, so that
 * a handoff written at Watch time can cite code that is committed on the epic
 * branch and deliberately not merged (issue #16).
 */
export const EPIC_WORKTREE_PREFIX = "_epic-";

/**
 * The slot an integration run's ONE epic worktree occupies, in place of an epic
 * id (issue #57).
 *
 * A run whose epics form a dependency chain merges every story into one branch,
 * and git refuses to check one branch out in two worktrees — so the epics share
 * a slot as well as a branch. It is not an `E<n>`, so it can never collide with
 * a real epic id.
 */
export const INTEGRATION_EPIC_SLOT = "integration";

/** `_epic-<run>-<epic>` — the run id is in the name so two runs cannot collide (issue #40). */
export function epicWorktreeName(runId: string, epicId: string): string {
  return `${EPIC_WORKTREE_PREFIX}${runId}-${epicId}`;
}

/** Is this directory name an epic worktree belonging to THIS run, and no other? */
export function isEpicWorktreeOf(name: string, runId: string): boolean {
  return name.startsWith(`${EPIC_WORKTREE_PREFIX}${runId}-`);
}
