/**
 * Reads and validates `env.yml`. Throws with the validation issues if it is malformed.
 *
 * Goes through `validateFile` rather than `validateEnv` so a manifest still
 * opening with `schema_version:` says so on stderr, with its own path attached.
 */
import { readYamlFile } from "../yaml.ts";
import { validateFile } from "../schemas/index.ts";
import { type EnvManifest } from "../schemas/env.ts";
import { ENV_MANIFEST_PATH } from "../paths.ts";

export async function loadEnvManifest(path: string = ENV_MANIFEST_PATH): Promise<EnvManifest> {
  const parsed = await readYamlFile(path);
  const check = validateFile("env", parsed, path);
  if (!check.ok) {
    const detail = check.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n");
    throw new Error(`invalid env manifest at ${path}:\n${detail}`);
  }
  return parsed as EnvManifest;
}
