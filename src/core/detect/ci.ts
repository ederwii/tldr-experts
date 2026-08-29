/** CI definition files found in a repo — reported, never interpreted. */
import { join } from "node:path";
import { readEntries } from "./walk.ts";

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
    if (await Bun.file(join(repoDir, name)).exists()) found.push(name);
  }
  if (await Bun.file(join(repoDir, ".circleci", "config.yml")).exists()) found.push(".circleci/config.yml");

  return found.sort();
}
