/**
 * `tldrx map --check` — drift detection.
 *
 * A map is worth exactly as much as its citations: if `[src: api:src/X.cs:41]`
 * no longer resolves, the bullet is a memory, not a fact. This resolves every
 * `file` src in `.tldrx/map/**` and `.tldrx/init-handoff.md` against the
 * filesystem and reports the ones that no longer land.
 *
 * Only `file` srcs are checkable here. `absent:`, `$ cmd`, `graph:`, `Q…`, `F…`
 * and `https://` are grammatical, not resolvable — they are checked elsewhere
 * (or, for `absent:`, by definition cannot be).
 */
import { join } from "node:path";
import { countLines } from "../detect/lineOf.ts";
import { isBullet, parseToken, type FileSrc } from "./srcToken.ts";
import { readEntries, toPosix } from "../detect/walk.ts";
import { MAP_DIR } from "./buildMap.ts";
import { runtime } from "../runtime/index.ts";
import type { DetectedRepo } from "../detect/types.ts";

export const HANDOFF_FILE = ".tldrx/init-handoff.md";

export interface CitationProblem {
  /** Workspace-relative path of the document holding the citation. */
  readonly file: string;
  readonly line: number;
  readonly src: string;
  readonly reason: string;
}

export interface CheckResult {
  readonly checked: number;
  readonly documents: number;
  readonly problems: readonly CitationProblem[];
}

export interface CheckOptions {
  /** Absolute directory holding `.tldrx/`. */
  readonly workspaceDir: string;
  /** Absolute workspace root the repo paths are relative to. */
  readonly root: string;
  readonly repos: readonly Pick<DetectedRepo, "name" | "path">[];
}

export async function checkCitations(options: CheckOptions): Promise<CheckResult> {
  const documents = await citedDocuments(options.workspaceDir);
  const problems: CitationProblem[] = [];
  let checked = 0;

  for (const relative of documents) {
    const text = await readOrEmpty(join(options.workspaceDir, relative));
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      if (isBullet(line) && parseToken(line).length === 0) {
        problems.push({ file: relative, line: i + 1, src: "", reason: "bullet has no [src: …] token" });
        continue;
      }
      for (const src of parseToken(line)) {
        if (src === null) {
          problems.push({ file: relative, line: i + 1, src: "", reason: "unparseable src token" });
          continue;
        }
        if (src.kind !== "file") continue;
        checked += 1;
        const problem = await resolveFileSrc(src, options, relative, i + 1);
        if (problem !== null) problems.push(problem);
      }
    }
  }
  return { checked, documents: documents.length, problems };
}

async function resolveFileSrc(
  src: FileSrc,
  options: CheckOptions,
  document: string,
  line: number,
): Promise<CitationProblem | null> {
  let base = options.workspaceDir;
  if (src.repo !== null) {
    const repo = options.repos.find((candidate) => candidate.name === src.repo);
    if (repo === undefined) {
      return { file: document, line, src: src.raw, reason: `unknown repo \`${src.repo}\`` };
    }
    base = repo.path === "." ? options.root : join(options.root, repo.path);
  }

  const target = join(base, src.path);
  if (!(await runtime.exists(target))) {
    return { file: document, line, src: src.raw, reason: "file does not exist" };
  }
  const lineCount = countLines(await runtime.readText(target));
  const highest = src.endLine ?? src.line;
  if (highest > lineCount || src.line < 1) {
    return { file: document, line, src: src.raw, reason: `line out of range (file has ${lineCount})` };
  }
  return null;
}

/** Every document `--check` reads: the whole map tree plus the init handoff. */
export async function citedDocuments(workspaceDir: string): Promise<string[]> {
  const found: string[] = [];
  if (await runtime.exists(join(workspaceDir, HANDOFF_FILE))) found.push(HANDOFF_FILE);

  const mapDir = join(workspaceDir, MAP_DIR);
  for (const entry of await readEntries(mapDir)) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(toPosix(`${MAP_DIR}/${entry.name}`));
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const child of await readEntries(join(mapDir, entry.name))) {
      if (child.isFile() && child.name.endsWith(".md")) {
        found.push(toPosix(`${MAP_DIR}/${entry.name}/${child.name}`));
      }
    }
  }
  return found.sort();
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await runtime.readText(path);
  } catch {
    return "";
  }
}
