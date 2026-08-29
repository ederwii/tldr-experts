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
