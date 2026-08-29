/** Where the framework's own shipped files live, resolved from this module. */
import { dirname, join } from "node:path";

/** Repo root of tldr-experts itself (this file is at <root>/src/core/paths.ts). */
export const FRAMEWORK_ROOT: string = dirname(dirname(import.meta.dir));

export const ENV_MANIFEST_PATH: string = join(FRAMEWORK_ROOT, "env.yml");
export const STAGES_DIR: string = join(FRAMEWORK_ROOT, "stages");
export const WORKFLOWS_DIR: string = join(FRAMEWORK_ROOT, "workflows");
export const TEMPLATES_DIR: string = join(FRAMEWORK_ROOT, "templates");
export const PLUGIN_DIR: string = join(FRAMEWORK_ROOT, "plugin");

/** Names of the per-project directories the framework writes into. */
export const PROJECT_FRAMEWORK_DIR = ".tldrx";
export const PROJECT_WORK_DIR = "tldrx-work";
