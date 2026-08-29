/**
 * `tldrx run new --seed <file|dir>` — finding the documents (spec §6.1).
 *
 * The generic sibling of `--from`. `--from` knows AI-DLC's folder layout by name;
 * `--seed` knows nothing except that a document is Markdown or plain text. It
 * COPIES NOTHING: every document stays where the team put it, and the run cites
 * it as `[src: <workspace-relative path>:<line>]`, which is exactly the §2.8
 * `file` production resolved against the workspace root.
 *
 * Bounds, so a wrong path cannot turn into a five-minute read of somebody's
 * Downloads folder: 50 files, 2 MB each. Anything over either bound is SKIPPED
 * and named — a silent drop is indistinguishable from a bug.
 *
 * PDFs, Word files and everything else are out of scope: extracting them means a
 * parser, a dependency and a whole class of "the text came out scrambled" bugs.
 * A named `.pdf` is an error that says so; one found inside a directory is a
 * warning.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SKIPPED_DIRS, toPosix } from "../detect/walk.ts";

export class SeedError extends Error {}

/** The only extensions `--seed` reads. Case-insensitive. */
export const SEED_EXTENSIONS: readonly string[] = [".md", ".txt"];
/** `[assumption]` — the spec has no seed import; these are the wave-4B brief's bounds. */
export const MAX_SEED_FILES = 50;
export const MAX_SEED_BYTES = 2 * 1024 * 1024;
const MAX_SEED_DEPTH = 8;

/** Extensions worth naming in the "out of scope" warning rather than ignoring. */
const KNOWN_DOCUMENT_EXTENSIONS: readonly string[] = [".pdf", ".doc", ".docx", ".rtf", ".odt", ".pages"];

export interface SeedDocument {
  /** Workspace-root-relative, POSIX — this IS the `src` payload. */
  readonly rel: string;
  readonly abs: string;
  readonly bytes: number;
  readonly lines: number;
  readonly text: string;
}

export interface SkippedSeed {
  readonly rel: string;
  readonly bytes: number;
  readonly reason: string;
}

export interface SeedSet {
  /** What `--seed` named, workspace-relative. Several become one comma-joined line. */
  readonly source: string;
  /** Every `--seed` argument, workspace-relative, in the order they were passed. */
  readonly sources: readonly string[];
  readonly isDirectory: boolean;
  readonly documents: readonly SeedDocument[];
  readonly skipped: readonly SkippedSeed[];
  /** One line per bound hit or unsupported format, for stdout and the ledger. */
  readonly warnings: readonly string[];
}

/**
 * Resolve `--seed` and read what it names.
 *
 * The path is tried against the WORKSPACE ROOT first and the CWD second (first
 * existing wins, as §2.8 resolves a `file` src). Root first, deliberately: a
 * relative `--seed docs` means the workspace's `docs/`, and resolving it against
 * whatever directory the operator happens to stand in silently imported the
 * FRAMEWORK's `docs/` in a test run — measured 2026-08-29. Either way the result
 * must live inside the workspace root: a document the handoff cites but a reviewer
 * cannot open from the repo is not evidence.
 */
export function collectSeed(root: string, seedPath: string): SeedSet {
  const abs = resolveSeed(root, seedPath);
  const rel = toPosix(relative(root, abs));
  if (rel === "" || rel.startsWith(`..${sep}`) || rel.startsWith("../")) {
    throw new SeedError(
      `--seed: ${seedPath} is outside the workspace root (${root}).\n`
      + "A seed document has to live in the workspace: the handoff cites it as "
      + "[src: <path>:<line>], and that resolves against the root.",
    );
  }

  const stats = statSync(abs);
  return stats.isDirectory() ? fromDirectory(abs, rel) : fromFile(abs, rel);
}

function resolveSeed(root: string, seedPath: string): string {
  if (isAbsolute(seedPath)) {
    if (!existsSync(seedPath)) throw new SeedError(`--seed: no such file or directory: ${seedPath}`);
    return seedPath;
  }
  for (const base of [root, process.cwd()]) {
    const candidate = resolve(base, seedPath);
    if (existsSync(candidate)) return candidate;
  }
  throw new SeedError(
    `--seed: no such file or directory: ${seedPath} (looked in ${root} and ${process.cwd()})`,
  );
}

function fromFile(abs: string, rel: string): SeedSet {
  const extension = extensionOf(rel);
  if (!SEED_EXTENSIONS.includes(extension)) {
    throw new SeedError(
      `--seed: ${rel} is a \`${extension || "no-extension"}\` file; `
      + `--seed reads ${SEED_EXTENSIONS.join(" and ")} only.\n`
      + "PDFs and Word documents are out of scope — export or convert to Markdown first.",
    );
  }
  const document = read(abs, rel);
  if (document === null) throw new SeedError(`--seed: ${rel} is larger than ${MAX_SEED_BYTES} bytes`);
  return { source: rel, sources: [rel], isDirectory: false, documents: [document], skipped: [], warnings: [] };
}

function fromDirectory(abs: string, rel: string): SeedSet {
  const walked = walkSeedDir(abs);
  const documents: SeedDocument[] = [];
  const skipped: SkippedSeed[] = [];
  const warnings: string[] = [];
  let unsupported = 0;

  for (const file of walked) {
    const childRel = rel === "" ? file.path : `${rel}/${file.path}`;
    const extension = extensionOf(file.path);
    if (!SEED_EXTENSIONS.includes(extension)) {
      if (KNOWN_DOCUMENT_EXTENSIONS.includes(extension)) unsupported += 1;
      continue;
    }
    if (file.size > MAX_SEED_BYTES) {
      skipped.push({ rel: childRel, bytes: file.size, reason: `larger than ${MAX_SEED_BYTES} bytes` });
      continue;
    }
    if (documents.length >= MAX_SEED_FILES) {
      skipped.push({ rel: childRel, bytes: file.size, reason: `over the ${MAX_SEED_FILES}-file cap` });
      continue;
    }
    const document = read(join(abs, ...file.path.split("/")), childRel);
    if (document !== null) documents.push(document);
  }

  if (documents.length === 0) {
    throw new SeedError(
      `--seed: ${rel} holds no ${SEED_EXTENSIONS.join(" or ")} document`
      + (unsupported > 0 ? ` (${unsupported} PDF/Word file(s) found — out of scope)` : ""),
    );
  }
  for (const entry of skipped) {
    warnings.push(`skipped ${entry.rel} (${entry.bytes} bytes) — ${entry.reason}`);
  }
  if (unsupported > 0) {
    warnings.push(
      `ignored ${unsupported} PDF/Word file(s) in ${rel} — --seed reads `
      + `${SEED_EXTENSIONS.join(" and ")} only; convert them first`,
    );
  }
  return { source: rel, sources: [rel], isDirectory: true, documents, skipped, warnings };
}

/**
 * `--seed a.md --seed docs/` — several arguments, one seed set.
 *
 * ONE argument is `collectSeed` verbatim, byte for byte: the repeatable form is
 * additive, and a workspace that never passes the flag twice must not be able to
 * tell it exists. Several are collected in argument order, merged, deduped by
 * path (naming a file and the directory holding it is a normal way to say "these
 * and that one"), and re-sorted by path so two runs of the same command produce
 * the same list. The 50-file cap applies to the MERGED set, not per argument —
 * otherwise `--seed` five times would quietly raise a documented bound.
 */
export function collectSeeds(root: string, seedPaths: readonly string[]): SeedSet {
  if (seedPaths.length === 0) throw new SeedError("--seed: no path given");
  const first = seedPaths[0] ?? "";
  if (seedPaths.length === 1) return collectSeed(root, first);

  const documents: SeedDocument[] = [];
  const skipped: SkippedSeed[] = [];
  const warnings: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  let anyDirectory = false;

  for (const path of seedPaths) {
    const set = collectSeed(root, path);
    sources.push(set.source);
    anyDirectory = anyDirectory || set.isDirectory;
    for (const document of set.documents) {
      if (seen.has(document.rel)) continue;
      seen.add(document.rel);
      documents.push(document);
    }
    for (const entry of set.skipped) skipped.push(entry);
    for (const warning of set.warnings) warnings.push(warning);
  }

  documents.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const kept = documents.slice(0, MAX_SEED_FILES);
  for (const dropped of documents.slice(MAX_SEED_FILES)) {
    const entry = { rel: dropped.rel, bytes: dropped.bytes, reason: `over the ${MAX_SEED_FILES}-file cap` };
    skipped.push(entry);
    warnings.push(`skipped ${entry.rel} (${entry.bytes} bytes) — ${entry.reason}`);
  }

  return { source: sources.join(", "), sources, isDirectory: anyDirectory, documents: kept, skipped, warnings };
}

/**
 * Every file under `dir`, recursive, sorted by path — the synchronous twin of
 * `detect/walk.ts`, which is async and cannot be used from `createRun`. Skips the
 * same build-output and vendored directories, so `--seed .` on a project root
 * does not read `node_modules`.
 */
function walkSeedDir(dir: string, depth = 0): { path: string; size: number }[] {
  if (depth > MAX_SEED_DEPTH) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { path: string; size: number }[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      for (const child of walkSeedDir(abs, depth + 1)) {
        found.push({ path: `${entry.name}/${child.path}`, size: child.size });
      }
      continue;
    }
    if (!entry.isFile()) continue;
    found.push({ path: entry.name, size: sizeOf(abs) });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sizeOf(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function read(abs: string, rel: string): SeedDocument | null {
  const bytes = statSync(abs).size;
  if (bytes > MAX_SEED_BYTES) return null;
  const text = readFileSync(abs, "utf8");
  return { rel, abs, bytes, lines: text.split("\n").length, text };
}

export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
