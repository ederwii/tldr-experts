/** CI definition files found in a repo — reported, never interpreted. */
import { join } from "node:path";
import { readEntries } from "./walk.ts";
import { runtime } from "../runtime/index.ts";

const SINGLE_FILE_CI: readonly string[] = [
  "azure-pipelines.yml", ".gitlab-ci.yml", "Jenkinsfile", ".travis.yml", "bitbucket-pipelines.yml",
];

export async function detectCi(repoDir: string): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readEntries(join(repoDir, ".github", "workflows"))) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
    found.push(`.github/workflows/${entry.name}`);
  }
  for (const name of SINGLE_FILE_CI) {
    if (await runtime.exists(join(repoDir, name))) found.push(name);
  }
  if (await runtime.exists(join(repoDir, ".circleci", "config.yml"))) found.push(".circleci/config.yml");

  return found.sort();
}
