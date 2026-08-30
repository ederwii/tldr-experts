/**
 * The deterministic pre-pass: which files a training run may read.
 *
 * No model is asked "what should I look at?", for the same reason the Watch
 * executor does not ask which features shipped — the workspace already says. The
 * answer here comes from three sources, in this order of trust:
 *
 *   1. `.tldrx/map/<repo>/domains.md`, which `tldrx map` wrote from the code and
 *      which already carries resolvable `[src: repo:path:line]` citations;
 *   2. graphify communities, WHEN the graph has any — the extraction `tldrx init`
 *      runs is `graphify update --no-cluster`, so measured on this workspace
 *      (2026-08-29) it has none, and that absence is reported rather than faked;
 *   3. a bounded keyword grep over the expert's repos, on the area id and the
 *      words of its title.
 *
 * The result is capped (40 files, 96 KB) and everything over the cap is listed by
 * name as "not read". A prompt that silently truncated its own inputs would let a
 * sub-agent write "there is no rate limiting in this area" about a file it was
 * never shown.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { isCodeFile } from "../detect/codeFiles.ts";
import { walkFiles } from "../detect/walk.ts";
import { parseSrcToken } from "../text/srcToken.ts";
import { pathsIntersect } from "../experts/expertDomain.ts";
import { MAX_FILE_BYTES, MAX_INLINE_BYTES, MAX_INLINE_FILES } from "./Training.ts";

/** How many files may be scanned per repo before the walk gives up and says so. */
export const MAX_SCANNED_FILES = 4000;
/** Files bigger than this are never read into memory for scoring. */
export const MAX_SCAN_BYTES = 512 * 1024;

/**
 * Words that carry no signal in a competency title. Deliberately short: a list
 * long enough to be clever is a list that silently drops the one word that
 * mattered.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "and", "the", "for", "with", "this", "that", "from", "into", "used", "uses",
  "using", "are", "was", "how", "what", "when", "where", "which", "within",
  "across", "workspace", "its",
]);

export const MAX_KEYWORDS = 12;

/**
 * The area id, its hyphen-separated parts, then the title's words.
 *
 * The id comes first and whole because it is the thing the operator typed, and a
 * grep that ranked `tooling` above `oauth` for area `oauth` would be useless.
 */
export function keywordsFor(areaId: string, title: string): readonly string[] {
  const out: string[] = [];
  const push = (word: string): void => {
    const lower = word.toLowerCase();
    if (lower.length < 3 || STOPWORDS.has(lower) || out.includes(lower)) return;
    out.push(lower);
  };
  push(areaId);
  for (const part of areaId.split(/[-_]/)) push(part);
  for (const word of title.split(/[^A-Za-z0-9]+/)) {
    if (word.length >= 4) push(word);
  }
  return out.slice(0, MAX_KEYWORDS);
}

export interface Candidate {
  readonly repo: string;
  /** Repo-relative, POSIX-separated. */
  readonly path: string;
  readonly bytes: number;
  readonly score: number;
  /** Why it scored — shown in the prompt so the selection is auditable. */
  readonly why: readonly string[];
}

export interface InlinedFile extends Candidate {
  /** File content, line-numbered by the renderer. Truncated files say so. */
  readonly content: string;
  readonly truncated: boolean;
  readonly lines: number;
}

export interface FileSelection {
  readonly keywords: readonly string[];
  readonly repos: readonly string[];
  /** The `## Domain` paths that bounded the walk. Empty ⇒ the whole repo was in scope. */
  readonly domainPaths: readonly string[];
  readonly inlined: readonly InlinedFile[];
  /** Ranked candidates the caps left out, by name — never silently dropped. */
  readonly notRead: readonly Candidate[];
  /** Bullets lifted verbatim from each repo's `domains.md`. */
  readonly domainLines: readonly string[];
  /** What the graph could and could not contribute, stated either way. */
  readonly graphNotes: readonly string[];
  readonly scanned: number;
  readonly scanTruncated: boolean;
}

export interface SelectOptions {
  readonly root: string;
  readonly repos: readonly { readonly name: string; readonly path: string }[];
  readonly areaId: string;
  readonly areaTitle: string;
  /**
   * The expert's declared `## Domain` paths, repo-relative. When there are any,
   * they are a HARD boundary: a file outside them is never scored and never
   * inlined, however well it greps.
   *
   * The alternative was measured. On `~/aparece-v2` the grep alone put 29-55% of
   * each expert's citations outside its own declared domain — knowledge filed
   * under the wrong name, written at full price, and then warned about on the way
   * back in (`knowledgeFile.ts`, `outside domain`). Bounding the INPUT is cheaper
   * than warning about the output. An expert that declares no domain — a stack or
   * a whole-repo expert — is unbounded, exactly as before.
   */
  readonly domainPaths?: readonly string[];
}

export async function selectFiles(options: SelectOptions): Promise<FileSelection> {
  const keywords = keywordsFor(options.areaId, options.areaTitle);
  const domainPaths = options.domainPaths ?? [];
  const domain = readDomains(options.root, options.repos.map((repo) => repo.name));
  const graph = readCommunities(options.root, options.repos.map((repo) => repo.name), keywords);

  const candidates: Candidate[] = [];
  let scanned = 0;
  let scanTruncated = false;

  for (const repo of options.repos) {
    const dir = join(options.root, repo.path);
    if (!existsSync(dir)) continue;
    const walked = await walkFiles(dir, { maxFiles: MAX_SCANNED_FILES });
    if (walked.length >= MAX_SCANNED_FILES) scanTruncated = true;
    for (const file of walked) {
      if (!isCodeFile(file.path)) continue;
      // The domain boundary is applied BEFORE the file is scored or read: a file
      // outside it cannot rank, cannot be inlined, and is not listed as "not
      // read" either — it was never a candidate for this expert.
      const inDomain = domainPaths.length === 0
        || domainPaths.some((domain) => pathsIntersect(file.path, domain));
      if (!inDomain) continue;
      scanned++;
      const why: string[] = [];
      let score = 0;

      const lowerPath = file.path.toLowerCase();
      const inPath = keywords.filter((word) => lowerPath.includes(word));
      if (inPath.length > 0) {
        score += 3 * weigh(inPath, options.areaId);
        why.push(`path matches ${inPath.join(", ")}`);
      }
      const inCommunity = graph.files.has(`${repo.name}:${file.path}`);
      if (inCommunity) {
        score += 2;
        why.push("in a graphify community for this area");
      }
      const hits = file.size <= MAX_SCAN_BYTES ? contentHits(join(dir, file.path), keywords) : [];
      if (hits.length > 0) {
        score += weigh(hits, options.areaId);
        why.push(`content mentions ${hits.join(", ")}`);
      }

      // The grep and the graph decide whether a file is about this AREA; the map
      // only re-ranks what already matched. Without that rule every file the map
      // happened to cite would be inlined for every area, and an `oauth` prompt
      // would carry the hunt engine.
      //
      // A DECLARED domain overrides that: inside it, every file is a candidate,
      // because the boundary has already answered "is this about this area?" and
      // an unmatched file inside the domain is the one the expert would otherwise
      // never see. It ranks below every keyword hit, so the caps still bite in the
      // right order.
      if (inPath.length === 0 && hits.length === 0 && !inCommunity) {
        if (domainPaths.length === 0) continue;
        why.push("inside the declared `## Domain`");
      }

      if (domain.cited.has(`${repo.name}:${file.path}`)) {
        score += 2;
        why.push("cited in domains.md");
      }
      if (domain.folders.some((folder) => file.path.startsWith(folder))) {
        score += 1;
        why.push("inside a mapped domain folder");
      }

      candidates.push({ repo: repo.name, path: file.path, bytes: file.size, score, why });
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score
    || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const inlined: InlinedFile[] = [];
  const notRead: Candidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (inlined.length >= MAX_INLINE_FILES || bytes >= MAX_INLINE_BYTES) {
      notRead.push(candidate);
      continue;
    }
    const repoDir = options.repos.find((repo) => repo.name === candidate.repo)?.path ?? ".";
    const read = readCapped(join(options.root, repoDir, candidate.path), MAX_INLINE_BYTES - bytes);
    if (read === null) {
      notRead.push(candidate);
      continue;
    }
    bytes += Buffer.byteLength(read.content, "utf8");
    inlined.push({ ...candidate, ...read });
  }

  return {
    keywords,
    repos: options.repos.map((repo) => repo.name),
    domainPaths,
    inlined,
    notRead,
    domainLines: domain.lines,
    graphNotes: graph.notes,
    scanned,
    scanTruncated,
  };
}

// --- domains.md -------------------------------------------------------------

interface DomainFacts {
  /** `<repo>:<path>` of every file cited by a domains.md bullet. */
  readonly cited: ReadonlySet<string>;
  /** Repo-relative folder prefixes the map called domains. */
  readonly folders: readonly string[];
  readonly lines: readonly string[];
}

/**
 * `domains.md` is a map document, not a handoff: a title, a blockquote and a flat
 * bullet list. So it is read as lines, and each bullet's trailing `[src: …]` is
 * parsed with the shared tokenizer — the same one that will judge the citations
 * the sub-agent writes back.
 */
export function readDomains(root: string, repos: readonly string[]): DomainFacts {
  const cited = new Set<string>();
  const folders: string[] = [];
  const lines: string[] = [];

  for (const repo of repos) {
    const path = join(root, PROJECT_FRAMEWORK_DIR, "map", repo, "domains.md");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.startsWith("- ")) continue;
      lines.push(`${repo}: ${line.slice(2).trim()}`);
      const token = parseSrcToken(line.trim());
      for (const ref of token?.refs ?? []) {
        if (ref.kind !== "file") continue;
        cited.add(`${ref.repo ?? repo}:${ref.path}`);
      }
      const folder = /^-\s+`([^`]+)`/.exec(line)?.[1];
      if (folder !== undefined && folder.endsWith("/") && folder !== "./") folders.push(folder);
    }
  }
  return { cited, folders: [...new Set(folders)], lines };
}

// --- graphify communities ---------------------------------------------------

interface CommunityFacts {
  readonly files: ReadonlySet<string>;
  readonly notes: readonly string[];
}

/**
 * Communities, when the graph has any.
 *
 * `[assumption]` — graphify's community/cluster shape is not documented anywhere
 * this framework can cite, and the graph `tldrx init` produces (`graphify update
 * --no-cluster`) carries none: measured 2026-08-29 on the pilot workspace, whose
 * `graph.json` keys are exactly `nodes, input_tokens, output_tokens, links`. So
 * two shapes are accepted — a top-level `communities: [{id|label, nodes|members}]`
 * and a per-node `community`/`cluster` field — and anything else is reported as
 * "no communities in this graph", never inferred.
 *
 * The whole file is string-scanned for `"communit"` before it is parsed, because
 * these graphs run to megabytes and parsing one to learn it has no communities is
 * a cost paid on every training run.
 */
export function readCommunities(
  root: string,
  repos: readonly string[],
  keywords: readonly string[],
): CommunityFacts {
  const files = new Set<string>();
  const notes: string[] = [];

  for (const repo of repos) {
    const path = join(root, PROJECT_FRAMEWORK_DIR, "graphify-out", repo, "graph.json");
    if (!existsSync(path)) {
      notes.push(`${repo}: no graphify graph — nothing from communities [src: absent:${PROJECT_FRAMEWORK_DIR}/graphify-out/${repo}/graph.json]`);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      notes.push(`${repo}: graph.json could not be read`);
      continue;
    }
    if (!text.includes("communit") && !text.includes("cluster")) {
      notes.push(`${repo}: graph present, no community or cluster field (\`--no-cluster\` extraction) — file selection used the map and the grep only`);
      continue;
    }
    // The string scan above is a cheap pre-filter, not a finding: the word can
    // appear in a node label. Only the parse can say whether the graph really
    // carries communities, and the note says which of the two happened.
    const found = communityFiles(text, keywords);
    if (!found.hasCommunities) {
      notes.push(`${repo}: graph present, but no community or cluster FIELD after parsing (the word appears only in node labels) — file selection used the map and the grep only`);
      continue;
    }
    if (found.files.length === 0) {
      notes.push(`${repo}: graph has communities, none whose name matches ${keywords.slice(0, 4).join("/")}`);
      continue;
    }
    for (const file of found.files) files.add(`${repo}:${file}`);
    notes.push(`${repo}: ${String(found.files.length)} file(s) from matching graphify communities`);
  }
  return { files, notes };
}

interface CommunityScan {
  /** True only when the parsed graph really carries a community/cluster field. */
  readonly hasCommunities: boolean;
  readonly files: readonly string[];
}

export function communityFiles(text: string, keywords: readonly string[]): CommunityScan {
  const none: CommunityScan = { hasCommunities: false, files: [] };
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return none;
    doc = parsed as Record<string, unknown>;
  } catch {
    return none;
  }

  const nodes = Array.isArray(doc.nodes) ? (doc.nodes as Record<string, unknown>[]) : [];
  const sourceById = new Map<string, string>();
  const matched = new Set<string>();
  let hasCommunities = false;

  for (const node of nodes) {
    const id = typeof node.id === "string" ? node.id : null;
    const source = typeof node.source_file === "string" ? node.source_file : null;
    if (id !== null && source !== null) sourceById.set(id, source);
    const label = typeof node.community === "string" ? node.community
      : typeof node.cluster === "string" ? node.cluster : null;
    if (label === null) continue;
    hasCommunities = true;
    if (source !== null && matches(label, keywords)) matched.add(source);
  }

  const communities = Array.isArray(doc.communities) ? (doc.communities as Record<string, unknown>[]) : [];
  if (communities.length > 0) hasCommunities = true;
  for (const community of communities) {
    const label = typeof community.label === "string" ? community.label
      : typeof community.name === "string" ? community.name
        : typeof community.id === "string" ? community.id : "";
    if (!matches(label, keywords)) continue;
    const members = Array.isArray(community.nodes) ? community.nodes
      : Array.isArray(community.members) ? community.members : [];
    for (const member of members) {
      if (typeof member !== "string") continue;
      const source = sourceById.get(member);
      if (source !== undefined) matched.add(source);
    }
  }
  return { hasCommunities, files: [...matched].sort() };
}

/**
 * The area id counts double.
 *
 * It is the word the operator typed; the rest are the title's, and a title like
 * "typescript language, build and test tooling" contributes `build` and `test`,
 * which match half a repo. Without this, an `oauth` area would rank a test file
 * above the token exchange because the title happened to say "and test".
 */
function weigh(matched: readonly string[], areaId: string): number {
  return matched.reduce((total, word) => total + (word === areaId.toLowerCase() ? 2 : 1), 0);
}

function matches(label: string, keywords: readonly string[]): boolean {
  const lower = label.toLowerCase();
  return keywords.some((word) => lower.includes(word));
}

// --- reading ----------------------------------------------------------------

/** Distinct keywords present in a file's text. Unreadable files contribute none. */
export function contentHits(abs: string, keywords: readonly string[]): readonly string[] {
  let text: string;
  try {
    text = readFileSync(abs, "utf8").toLowerCase();
  } catch {
    return [];
  }
  return keywords.filter((word) => text.includes(word));
}

function readCapped(abs: string, remaining: number): { content: string; truncated: boolean; lines: number } | null {
  let text: string;
  try {
    if (statSync(abs).size > MAX_SCAN_BYTES) return null;
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const cap = Math.min(MAX_FILE_BYTES, Math.max(0, remaining));
  const lines = text.split("\n").length;
  if (Buffer.byteLength(text, "utf8") <= cap) return { content: text, truncated: false, lines };
  return { content: Buffer.from(text, "utf8").subarray(0, cap).toString("utf8"), truncated: true, lines };
}
