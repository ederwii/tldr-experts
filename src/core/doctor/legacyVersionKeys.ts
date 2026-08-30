/**
 * Find workspace files still opening with `schema_version:` instead of `version:`.
 *
 * Spec §0 has always said every schema's first key is `version: 1`. Seven skeleton
 * validators asked for `schema_version` instead, and seven templates printed
 * `schema_version: 0` — while `tldrx init` had been writing `version: 1` all
 * along. As of 2026-08-29 the validators take `version` and merely TOLERATE
 * `schema_version`, for one release. This is the report that lets a workspace see
 * what it has to change before that release ends.
 *
 * Read-only and shallow on purpose: a fixed list of candidate paths, one small
 * YAML parse each, no recursion into unknown directories. `doctor` must stay a
 * command you run without thinking about what it will touch.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseYaml } from "../yaml.ts";
import { isRecord } from "../schemas/validation.ts";
import { LEGACY_VERSION_KEY, VERSION_KEY } from "../schemas/validation.ts";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";

/** A cap so a workspace with hundreds of runs cannot make `doctor` slow. */
const MAX_SCANNED = 500;

/**
 * Workspace-relative paths of every file that still says `schema_version`.
 *
 * A file carrying BOTH keys does not count: `version` is what the validators
 * read, so such a file is already correct and the stale key is inert.
 */
export function findLegacyVersionFiles(root: string): readonly string[] {
  const found: string[] = [];
  let budget = MAX_SCANNED;
  for (const path of candidates(root)) {
    if (budget-- <= 0) break;
    if (usesLegacyKey(path)) found.push(relative(root, path));
  }
  return found.sort();
}

function candidates(root: string): readonly string[] {
  const tldrx = join(root, PROJECT_FRAMEWORK_DIR);
  const work = join(root, PROJECT_WORK_DIR);
  return [
    join(tldrx, "workspace.yml"),
    join(tldrx, "process.yml"),
    join(tldrx, "env.yml"),
    join(tldrx, "memory", "facts.yml"),
    ...dirsIn(join(tldrx, "experts")).map((dir) => join(dir, "competencies.yml")),
    ...dirsIn(work).flatMap((dir) => [join(dir, "run.yml"), join(dir, "budget.yml")]),
  ].filter((path) => existsSync(path));
}

function dirsIn(parent: string): readonly string[] {
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent)
      .map((name) => join(parent, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function usesLegacyKey(path: string): boolean {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    // An unreadable or malformed file is somebody else's error to report; this
    // scan answers one narrow question and stays silent about everything else.
    return false;
  }
  if (!isRecord(doc)) return false;
  return LEGACY_VERSION_KEY in doc && !(VERSION_KEY in doc);
}
