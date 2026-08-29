/**
 * A bounded, deterministic file walk.
 *
 * Bounded because init must stay fast on a real monorepo; deterministic because
 * two runs on an unchanged tree must produce byte-identical maps.
 */
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Directories never worth walking: build output, vendored code, our own state. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", "dist", "build", "out", "bin", "obj", "target",
  ".venv", "venv", "__pycache__", ".next", ".expo", ".gradle", "vendor",
  "coverage", "graphify-out", ".tldrx", "tldrx-work", ".idea", ".vscode",
  "Pods", "DerivedData", ".terraform", ".turbo", ".cache",
  // Generated report/build output that looks like source until you open it.
  "storybook-static", "playwright-report", "test-results",
]);

export interface WalkedFile {
  /** Path relative to the walk root, always `/`-separated. */
  readonly path: string;
  readonly size: number;
}

export interface WalkOptions {
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 8;

/** Files under `root`, sorted by path. Hidden entries are skipped except at depth 0. */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const found: WalkedFile[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && found.length < maxFiles) {
    const next = queue.shift();
    if (next === undefined) break;
    const entries = await readEntries(next.dir);
    for (const entry of entries) {
      const abs = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (next.depth + 1 <= maxDepth) queue.push({ dir: abs, depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (found.length >= maxFiles) break;
      const size = await fileSize(abs);
      found.push({ path: toPosix(relative(root, abs)), size });
    }
  }
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/** Entries directly under `dir`, sorted by name. Unreadable directories yield nothing. */
export async function readEntries(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function fileSize(abs: string): Promise<number> {
  try {
    return (await stat(abs)).size;
  } catch {
    return 0;
  }
}
