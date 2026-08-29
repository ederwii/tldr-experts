/**
 * What counts as CODE, decided once and by extension alone.
 *
 * "This repo has no code yet" is a claim `tldrx init` makes in `workspace.yml`
 * (`mode: greenfield`) and in the map, so the rule behind it has to be something a
 * reader can re-run rather than a feeling. It is:
 *
 *   a file, under the bounded walk of `walkFiles` (which already skips `.git`,
 *   `node_modules`, build output and vendored trees), whose lowercased extension
 *   is in `CODE_EXTENSIONS` below.
 *
 * A README, a `package.json`, a lockfile, a YAML pipeline and a `.env` are all NOT
 * code: they describe or configure a build that may not exist. That is exactly the
 * greenfield case — a repo holding a requirements document and nothing else.
 */
import { walkFiles } from "./walk.ts";

/**
 * Source extensions. Data, config, docs and lock files are deliberately absent:
 * a repo of nothing but manifests has nothing to reverse-engineer.
 */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cs", ".py", ".go", ".rs",
  ".java", ".kt", ".swift", ".rb", ".php", ".scala", ".c", ".h", ".cpp", ".hpp",
  ".sql", ".sh", ".razor", ".vue", ".svelte",
]);

/** The lowercased extension of a path, `""` when it has none. */
export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(path));
}

/** How many code files this directory holds. `0` is the greenfield signal. */
export async function countCodeFiles(repoDir: string): Promise<number> {
  const files = await walkFiles(repoDir);
  return files.filter((file) => isCodeFile(file.path)).length;
}
