/**
 * The shape of a repo's source tree, measured once and reused by every document
 * the static provider writes.
 *
 * "Domain" here means exactly one thing: a top-level folder that holds source
 * files. It is a candidate, not a conclusion — the interview asks about it.
 */
import { walkFiles, type WalkedFile } from "../detect/walk.ts";
import { CODE_EXTENSIONS, extensionOf } from "../detect/codeFiles.ts";

/**
 * Extensions counted as source. Data and lock files are not architecture.
 *
 * One definition, two readers: `detect/codeFiles.ts` owns the set because
 * `mode: greenfield` in `workspace.yml` is decided by the same rule the map uses
 * to decide what an architecture is made of. Divergence between them would let a
 * repo be "greenfield" and still have an architecture document.
 */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = CODE_EXTENSIONS;

/** Folders that hold source but are not a domain of the product. */
const NON_DOMAIN_FOLDERS: ReadonlySet<string> = new Set([
  "test", "tests", "spec", "specs", "__tests__", "scripts", "tools", "docs",
  "examples", "example", "assets", "public", "static", "config", "migrations",
]);

export interface FolderSummary {
  readonly folder: string;
  readonly fileCount: number;
  /** A file inside the folder, for the citation. */
  readonly sample: string;
}

export interface SourceTree {
  readonly files: readonly WalkedFile[];
  readonly sourceFiles: readonly WalkedFile[];
  /** Top-level folders holding source, by file count desc then name asc. */
  readonly folders: readonly FolderSummary[];
  /** Extension -> count, by count desc then extension asc. */
  readonly extensions: readonly (readonly [string, number])[];
  /** Largest source files, by size desc. */
  readonly largest: readonly WalkedFile[];
  /** Folder names worth an expert, in `folders` order, excluding scaffolding. */
  readonly domainCandidates: readonly string[];
}

export async function readSourceTree(repoDir: string): Promise<SourceTree> {
  const files = await walkFiles(repoDir);
  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(extensionOf(file.path)));

  const byFolder = new Map<string, { count: number; sample: string }>();
  const byExtension = new Map<string, number>();

  for (const file of sourceFiles) {
    const folder = topFolder(file.path);
    const entry = byFolder.get(folder) ?? { count: 0, sample: file.path };
    entry.count += 1;
    byFolder.set(folder, entry);
    const extension = extensionOf(file.path);
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
  }

  const folders: FolderSummary[] = [...byFolder.entries()]
    .map(([folder, value]) => ({ folder, fileCount: value.count, sample: value.sample }))
    .sort((a, b) => b.fileCount - a.fileCount || (a.folder < b.folder ? -1 : 1));

  const extensions = [...byExtension.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

  const largest = [...sourceFiles].sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1)).slice(0, 5);

  return {
    files, sourceFiles, folders, extensions, largest,
    domainCandidates: folders
      .filter((entry) => entry.folder !== "." && !NON_DOMAIN_FOLDERS.has(entry.folder))
      .map((entry) => entry.folder),
  };
}

/**
 * The folder a domain would live in. `src/`, `lib/` and `app/` are packaging, not
 * domains, so the level below them is used.
 */
const PACKAGING_FOLDERS: ReadonlySet<string> = new Set(["src", "lib", "app", "source", "packages"]);

export function topFolder(path: string): string {
  const parts = path.split("/");
  const first = parts[0];
  if (first === undefined || parts.length === 1) return ".";
  if (PACKAGING_FOLDERS.has(first)) {
    // `src/` is packaging: `src/hunts/x.ts` is the `src/hunts` domain, while
    // `src/index.ts` belongs to no domain at all.
    const second = parts[1];
    return parts.length > 2 && second !== undefined ? `${first}/${second}` : ".";
  }
  return first;
}

export { extensionOf };
