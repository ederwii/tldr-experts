/** Reads and validates `env.yml`. Throws with the validation issues if it is malformed. */
import { readYamlFile } from "../yaml.ts";
import { validateEnv, type EnvManifest } from "../schemas/env.ts";
import { ENV_MANIFEST_PATH } from "../paths.ts";

export async function loadEnvManifest(path: string = ENV_MANIFEST_PATH): Promise<EnvManifest> {
  const parsed = await readYamlFile(path);
  const check = validateEnv(parsed);
  if (!check.ok) {
    const detail = check.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n");
    throw new Error(`invalid env manifest at ${path}:\n${detail}`);
  }
  return parsed as EnvManifest;
}
