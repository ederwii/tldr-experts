/**
 * `tldrx seed triage <path>` — the deterministic half (spec §6.2).
 *
 * A big seed is not one problem, it is several pretending to be one, and the
 * first honest thing to do about it is COUNT. Nothing in this file asks a model
 * anything: it reads exactly what `run new --seed` would read (the same
 * `collectSeed`, the same caps, the same skip list) and reports, per document,
 * the handful of facts that decide whether it belongs in a run at all —
 *
 *   size          bytes and ~tokens, because a seed is paid for by the token
 *   headings      H1/H2, the only structure a Markdown document reliably has
 *   references    which other seed documents it points at — the shape of the split
 *   ADR status    `Status: superseded` is a reason to exclude, not to read
 *   open markers  TODO/TBD/open question/?? — unsettled content the run inherits
 *   code-derived  does it mostly cite files a model could read for itself?
 *
 * The last one is the only heuristic here and it is deliberately conservative: a
 * path-like token counts only when it RESOLVES to a real file under one of the
 * workspace's repos. Citing `src/Foo.cs` proves nothing; citing eight paths that
 * all exist is a document describing code the model can open instead, and paying
 * for it as seed is paying twice. Documentation extensions are excluded from the
 * count on purpose — a design doc linking its sibling design docs is a
 * REFERENCE, which this file already reports separately.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SeedDocument, SeedSet, SkippedSeed } from "./collectSeed.ts";

/** `[assumption]` — the spec sets no threshold; this is the §6.2 default. */
export const DEFAULT_THRESHOLD_TOKENS = 20_000;
/** `[assumption]` — how many resolving path citations make a document "code-derived". */
export const DEFAULT_CODE_PATH_MIN = 8;
/** Bound on the stat() calls one document can cause. */
const MAX_CODE_CANDIDATES = 500;

/**
 * Four bytes per token. Crude on purpose: the number decides "split or not",
 * a tokenizer would make it look exact when the model's own count still differs,
 * and being wrong by 15% never changes that answer.
 */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/** `44231` → `~44k`; anything under a thousand keeps its digits. */
export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `~${String(Math.round(tokens / 1000))}k` : `~${String(tokens)}`;
}

export interface CodeDerived {
  /** Distinct path-like, non-document tokens the document cites. */
  readonly cited: number;
  /** How many of those resolve to a real file under the root or one of its repos. */
  readonly resolved: number;
  readonly likely: boolean;
  /** Up to three resolving paths, so the verdict can be checked by hand. */
  readonly examples: readonly string[];
}

export interface InventoryDocument {
  readonly rel: string;
  readonly bytes: number;
  readonly tokens: number;
  readonly lines: number;
  readonly h1: readonly string[];
  readonly h2: readonly string[];
  /** Other seed documents this one links to or names, by rel path, sorted. */
  readonly references: readonly string[];
  /** The value of a `Status:` line, lowercased, or null when the document has none. */
  readonly adrStatus: string | null;
  readonly openMarkers: number;
  readonly codeDerived: CodeDerived;
}

export interface SeedInventory {
  readonly source: string;
  readonly sources: readonly string[];
  readonly documents: readonly InventoryDocument[];
  readonly skipped: readonly SkippedSeed[];
  readonly warnings: readonly string[];
  readonly files: number;
  readonly bytes: number;
  readonly tokens: number;
  readonly thresholdTokens: number;
  readonly overThreshold: boolean;
  readonly codePathMin: number;
}

export interface InventoryOptions {
  readonly root: string;
  readonly seed: SeedSet;
  /** repo name -> path relative to the root, from `.tldrx/workspace.yml`. */
  readonly repos: ReadonlyMap<string, string>;
  readonly thresholdTokens?: number;
  readonly codePathMin?: number;
}

export function buildInventory(options: InventoryOptions): SeedInventory {
  const threshold = options.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
  const codePathMin = options.codePathMin ?? DEFAULT_CODE_PATH_MIN;
  const bases = resolveBases(options.root, options.repos);
  const byRel = new Map(options.seed.documents.map((document) => [document.rel, document] as const));

  const documents = options.seed.documents.map((document) => ({
    rel: document.rel,
    bytes: document.bytes,
    tokens: estimateTokens(document.bytes),
    lines: document.lines,
    h1: headings(document.text, 1),
    h2: headings(document.text, 2),
    references: referencesOf(document, byRel),
    adrStatus: statusOf(document.text),
    openMarkers: countOpenMarkers(document.text),
    codeDerived: codeDerivedOf(document.text, bases, codePathMin),
  }));

  const bytes = documents.reduce((sum, document) => sum + document.bytes, 0);
  const tokens = estimateTokens(bytes);
  return {
    source: options.seed.source,
    sources: options.seed.sources,
    documents,
    skipped: options.seed.skipped,
    warnings: options.seed.warnings,
    files: documents.length,
    bytes,
    tokens,
    thresholdTokens: threshold,
    overThreshold: tokens > threshold,
    codePathMin,
  };
}

/**
 * The one line an operator actually reads.
 *
 * Both halves name the next command, because "you are over the threshold" with no
 * verb attached is a fact nobody can act on.
 */
export function verdictLine(inventory: SeedInventory, seedPath: string): string {
  const size = `seed: ${String(inventory.files)} file${inventory.files === 1 ? "" : "s"}, `
    + `${formatTokens(inventory.tokens)} tokens`;
  const threshold = formatTokens(inventory.thresholdTokens).replace("~", "");
  return inventory.overThreshold
    ? `${size} — above the ${threshold} threshold; run \`tldrx seed triage ${seedPath} --propose\``
    : `${size} — under the ${threshold} threshold; \`tldrx run new --seed ${seedPath}\` will do`;
}

// --- per-document facts -----------------------------------------------------

const H1_RE = /^#\s+(.+?)\s*$/;
const H2_RE = /^##\s+(.+?)\s*$/;

export function headings(text: string, level: 1 | 2): readonly string[] {
  const re = level === 1 ? H1_RE : H2_RE;
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const match = re.exec(line);
    if (match !== null && match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/**
 * `Status: accepted`, `**Status:** Superseded by ADR-7`, `status : proposed`,
 * and — since wave J — `- Status: proposed — owner decision pending`.
 *
 * The leading list marker is not a nicety. Measured 2026-08-29 on `~/aparece-v2`:
 * thirteen ADRs, every one of them writing its status as a bullet in the header
 * block, and the inventory reported `adrStatus: null` for all thirteen. A field
 * whose whole job is "is this document still current" answered "no idea" for the
 * single most common way an ADR writes it.
 *
 * The first such line wins and only the first word of the value is kept: the
 * question this answers is "is this document still current", and
 * "superseded by ADR-7" and "superseded" are the same answer. `statusLineOf`
 * returns the line as well, for a report that must show a human what it read.
 */
const STATUS_RE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*status\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*([A-Za-z][A-Za-z-]*)/i;

export interface StatusLine {
  /** The value's first word, lower-cased — `proposed`, `accepted`, `superseded`. */
  readonly status: string;
  /** The whole line as written, trimmed. */
  readonly line: string;
}

export function statusLineOf(text: string): StatusLine | null {
  for (const line of text.split("\n")) {
    const match = STATUS_RE.exec(line);
    if (match !== null && match[1] !== undefined) {
      return { status: match[1].toLowerCase(), line: line.trim() };
    }
  }
  return null;
}

export function statusOf(text: string): string | null {
  return statusLineOf(text)?.status ?? null;
}

const OPEN_MARKERS: readonly RegExp[] = [
  /\bTODO\b/g,
  /\bTBD\b/g,
  /open question/gi,
  /\?\?/g,
];

export function countOpenMarkers(text: string): number {
  let count = 0;
  for (const marker of OPEN_MARKERS) count += (text.match(marker) ?? []).length;
  return count;
}

/**
 * Which other seed documents this one points at.
 *
 * Two ways, because teams write both: a Markdown link whose target resolves to
 * another seed document, and a bare mention of its filename in prose ("see
 * 03-TENANCY.md"). Both are the same signal — these two belong in the same run.
 */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

export function referencesOf(
  document: SeedDocument,
  byRel: ReadonlyMap<string, SeedDocument>,
): readonly string[] {
  const found = new Set<string>();
  const dir = document.rel.includes("/") ? document.rel.slice(0, document.rel.lastIndexOf("/")) : "";

  for (const match of document.text.matchAll(LINK_RE)) {
    const target = (match[1] ?? "").split("#")[0]?.split("?")[0] ?? "";
    if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const resolved = target.startsWith("/") ? target.slice(1) : normalizeRel(dir, target);
    if (resolved !== document.rel && byRel.has(resolved)) found.add(resolved);
  }

  for (const rel of byRel.keys()) {
    if (rel === document.rel) continue;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (base !== "" && document.text.includes(base)) found.add(rel);
  }
  return [...found].sort();
}

/** POSIX join + `.`/`..` collapse, without touching the filesystem. */
function normalizeRel(dir: string, target: string): string {
  const parts = (dir === "" ? target : `${dir}/${target}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * Documents are not code. A design doc that links its sibling design docs is
 * cited by `references`, and counting those here would flag every well-linked
 * folder as "go read the code instead".
 */
const DOCUMENT_EXTENSIONS = new Set([".md", ".txt", ".markdown", ".rst", ".adoc", ".pdf", ".doc", ".docx"]);
const PATH_TOKEN_RE = /[A-Za-z0-9_@][A-Za-z0-9_@.\-]*(?:\/[A-Za-z0-9_@.\-]+)*\.[A-Za-z0-9]{1,6}/g;

export function codeDerivedOf(
  text: string,
  bases: readonly string[],
  minimum: number,
): CodeDerived {
  const candidates = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    const token = match[0];
    if (token.includes("..")) continue;
    const dot = token.lastIndexOf(".");
    const extension = token.slice(dot).toLowerCase();
    if (DOCUMENT_EXTENSIONS.has(extension)) continue;
    if (/^\d+$/.test(extension.slice(1))) continue;
    candidates.add(token);
    if (candidates.size >= MAX_CODE_CANDIDATES) break;
  }

  const examples: string[] = [];
  let resolved = 0;
  for (const token of candidates) {
    if (!resolvesUnder(token, bases)) continue;
    resolved += 1;
    if (examples.length < 3) examples.push(token);
  }
  return { cited: candidates.size, resolved, likely: resolved >= minimum, examples };
}

/** The workspace root plus every repo path — the bases a cited path may live under. */
export function resolveBases(root: string, repos: ReadonlyMap<string, string>): readonly string[] {
  const bases = [root];
  for (const rel of repos.values()) {
    const abs = rel === "." || rel === "" ? root : join(root, rel);
    if (!bases.includes(abs)) bases.push(abs);
  }
  return bases;
}

function resolvesUnder(token: string, bases: readonly string[]): boolean {
  for (const base of bases) {
    const abs = join(base, token);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Every document by rel path — the set a `seed:<rel>` src must name. */
export function inventoryRels(inventory: SeedInventory): ReadonlySet<string> {
  return new Set(inventory.documents.map((document) => document.rel));
}
