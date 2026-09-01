/**
 * The `[src: …]` grammar (spec §2.8) — tokenizer and validator.
 *
 *   token  := "[src: " src ("; " src)* "]"
 *   src    := file | doc | ans | fact | cmd | graph | absent
 *   file   := [repo ":"] path ":" line ["-" line]
 *   doc    := "https://" nonspace+
 *   ans    := "Q" digit+
 *   fact   := "F" digit{3,6}
 *   cmd    := "$ " command " → exit " digit+
 *   graph  := "graph:" nodeid
 *   absent := "absent:" path
 *   aidlc  := "aidlc:" path (":" line | "#" "Q" digit+)   # spec §6 `[assumption]`
 *
 * Everything here is string slicing plus a handful of tiny anchored regexes, so a
 * hook can validate a 256 KB handoff well inside its 50 ms budget (spec §0).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { parseYaml } from "../yaml.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";

export const SRC_KINDS = ["file", "doc", "answer", "fact", "cmd", "graph", "absent", "aidlc"] as const;
export type SrcKind = (typeof SRC_KINDS)[number];

export type SrcRef =
  | { readonly kind: "file"; readonly raw: string; readonly repo: string | null; readonly path: string; readonly startLine: number; readonly endLine: number | null }
  | { readonly kind: "doc"; readonly raw: string; readonly url: string }
  | { readonly kind: "answer"; readonly raw: string; readonly q: string }
  | { readonly kind: "fact"; readonly raw: string; readonly id: string }
  | { readonly kind: "cmd"; readonly raw: string; readonly command: string; readonly exitCode: number }
  | { readonly kind: "graph"; readonly raw: string; readonly node: string }
  | { readonly kind: "absent"; readonly raw: string; readonly path: string }
  | { readonly kind: "aidlc"; readonly raw: string; readonly path: string; readonly line: number | null; readonly q: string | null };

export interface SrcParseError {
  readonly raw: string;
  readonly message: string;
}

export interface SrcToken {
  /** The whole `[src: …]` run, verbatim. */
  readonly raw: string;
  readonly refs: readonly SrcRef[];
  readonly errors: readonly SrcParseError[];
}

/** Context a `src` is resolved against. Everything is optional-by-emptiness. */
export interface SrcContext {
  /** Absolute workspace root; the first base a bare `file` path resolves against. */
  readonly root: string;
  /** workspace.yml repo name -> path relative to the root. */
  readonly repos: ReadonlyMap<string, string>;
  /** Every non-null command string in workspace.yml — the only commands a `cmd` src may cite. */
  readonly commands: ReadonlySet<string>;
  /**
   * Absolute `tldrx-work/<run>/` directory of the handoff being validated, when the
   * caller knows it — the second base a bare `file` path resolves against, so a
   * sub-agent may cite its own run-relative outputs (`01-what/intent.md:1`).
   */
  readonly runDir?: string | null;
  /**
   * This run's epic worktrees, tried BEFORE the working tree by a `file` src
   * (issue #16).
   *
   * The Build phase commits onto an epic branch and deliberately does not merge
   * it: the phase ends at a human gate and nothing it runs pushes or fast-forwards
   * `main`. A Watch stage then writes a handoff ABOUT that work, and every
   * `repo:src/…` citation in it named a file the working tree does not have yet —
   * so the stage's own evidence was refused for being true. The epic's checkout is
   * a real directory on disk (`.tldrx/worktrees/<repo>/_epic-<run>-<epic>`), so the
   * fix is a base, not a new kind of source: the citation is spelled exactly as it
   * always was, and it is looked for in this run's epic checkout first and in the
   * working tree after.
   *
   * Empty when the run has no epic worktree on disk, which is every stage before
   * Build and every run whose worktrees have been cleaned up.
   */
  readonly epicWorktrees?: readonly EpicWorktree[];
}

/** One epic checkout a `file` src may resolve against. */
export interface EpicWorktree {
  /** The `workspace.yml` repo it is a checkout OF. */
  readonly repo: string;
  /** Absolute path of the worktree directory. */
  readonly dir: string;
}

export function emptySrcContext(root: string, runDir?: string | null): SrcContext {
  return { root, repos: new Map(), commands: new Set(), runDir: runDir ?? null, epicWorktrees: [] };
}

const LINE_RE = /^\d{1,9}$/;
const LINE_RANGE_RE = /^(\d{1,9})-(\d{1,9})$/;
const ANSWER_RE = /^Q\d{1,6}$/;
const FACT_RE = /^F\d{3,6}$/;
const CMD_RE = /^\$ (.+) → exit (\d{1,3})$/;
const TRAILING_TOKEN_RE = /\[src: ([^\]]*)\]$/;
/**
 * Closers and terminal punctuation a bullet may carry AFTER its token.
 *
 * Measured 2026-08-29 on a real user's first `tldrx next`: 9 of 9 bullets carried
 * a citation and all 9 were reported "unsourced", because the token was anchored
 * to end-of-line and the author had written `` `[src: api:src/Foo.cs:12]` `` — a
 * backtick, a period or a closing paren after the `]` was enough to make the
 * whole handoff read as evidence-free. The token must still be the LAST semantic
 * element of the line; what may follow it is punctuation, not words.
 *
 * `]` is deliberately NOT in the set: it is the token's own terminator.
 */
const TRAILING_CLOSER_RE = /[`'"’”»)\s.,;:!?]+$/;
/** Anything with a `[src:` in it is an ATTEMPTED citation, however it is spelled. */
const SRC_MARKER = "[src:";
/** `aidlc:<file>:<line>` (prose) or `aidlc:<file>#Q<n>` (an answered question). */
const AIDLC_LINE_RE = /^(.+):(\d{1,9})$/;
const AIDLC_Q_RE = /^(.+)#(Q\d{1,6})$/;

/**
 * The `[src: …]` token a line ends with, or null when there is none.
 * Trailing whitespace is ignored; anything after the `]` means "no token".
 */
export function parseSrcToken(line: string, repos?: ReadonlySet<string>): SrcToken | null {
  const trimmed = trimTrailingClosers(line);
  const match = TRAILING_TOKEN_RE.exec(trimmed);
  if (match === null) return null;
  const inner = match[1] ?? "";
  const refs: SrcRef[] = [];
  const errors: SrcParseError[] = [];
  for (const piece of inner.split("; ")) {
    const parsed = classifySrc(piece, repos);
    if ("message" in parsed) errors.push(parsed);
    else refs.push(parsed);
  }
  if (inner.trim() === "") {
    return { raw: match[0], refs: [], errors: [{ raw: "", message: "empty [src: ] token" }] };
  }
  return { raw: match[0], refs, errors };
}

/**
 * Strip trailing whitespace, then any run of closing quotes/parens and terminal
 * punctuation, so the `]` of a wrapped token becomes the end of the line.
 * Applied once — `` `[src: x]`. `` and `([src: x]).` both reduce in one pass.
 */
function trimTrailingClosers(line: string): string {
  const trimmed = line.replace(/\s+$/, "");
  if (trimmed.endsWith("]")) return trimmed;
  const stripped = trimmed.replace(TRAILING_CLOSER_RE, "");
  return stripped.endsWith("]") ? stripped : trimmed;
}

/**
 * True when the line TRIED to cite something — it holds a `[src:` marker — even if
 * the token does not parse. The two failures need different advice: "you wrote no
 * citation" and "your citation is malformed" are not the same mistake.
 */
export function hasSrcMarker(line: string): boolean {
  return line.includes(SRC_MARKER);
}

/** One `src` production. Returns a ref, or an error describing why it is not one. */
export function classifySrc(src: string, repos?: ReadonlySet<string>): SrcRef | SrcParseError {
  const raw = src;
  if (raw === "") return { raw, message: "empty source" };

  if (raw.startsWith("https://")) {
    if (raw.length <= "https://".length || /\s/.test(raw)) {
      return { raw, message: "`doc` must be https:// followed by a non-space URL" };
    }
    return { kind: "doc", raw, url: raw };
  }
  if (raw.startsWith("http://")) {
    return { raw, message: "`doc` sources must be https:// — http:// is rejected" };
  }
  if (raw.startsWith("$ ")) {
    const m = CMD_RE.exec(raw);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      return { raw, message: "`cmd` must read `$ <command> → exit <n>`" };
    }
    return { kind: "cmd", raw, command: m[1], exitCode: Number(m[2]) };
  }
  if (raw.startsWith("graph:")) {
    const node = raw.slice("graph:".length);
    if (node === "" || /\s/.test(node)) return { raw, message: "`graph:` needs a non-empty node id" };
    return { kind: "graph", raw, node };
  }
  if (raw.startsWith("aidlc:")) return parseAidlcSrc(raw);
  if (raw.startsWith("absent:")) {
    const path = raw.slice("absent:".length);
    if (path === "") return { raw, message: "`absent:` needs a path" };
    return { kind: "absent", raw, path };
  }
  if (ANSWER_RE.test(raw)) return { kind: "answer", raw, q: raw };
  if (FACT_RE.test(raw)) return { kind: "fact", raw, id: raw };
  if (raw.startsWith("Q") || raw.startsWith("F")) {
    // Looks like an id but is not one — say so rather than falling through to `file`.
    if (!raw.includes(":")) {
      return { raw, message: "expected `Q<n>` or `F<nnn>`" };
    }
  }
  return parseFileSrc(raw, repos);
}

/**
 * `aidlc:<file>:<line>` / `aidlc:<file>#Q<n>` — provenance for a `--from` distill
 * (spec §6). `[assumption]`: the AI-DLC intent folder is OUTSIDE the workspace and
 * may be gone by the time anyone reads the handoff, so an `aidlc` src is never
 * resolved against the filesystem. It records where a claim came from; it is not
 * a promise the file is still there.
 */
function parseAidlcSrc(raw: string): SrcRef | SrcParseError {
  const rest = raw.slice("aidlc:".length);
  if (rest === "") return { raw, message: "`aidlc:` needs a path" };
  if (rest.includes("..")) return { raw, message: "`..` is not allowed in a source path" };

  const question = AIDLC_Q_RE.exec(rest);
  if (question !== null && question[1] !== undefined && question[2] !== undefined) {
    return { kind: "aidlc", raw, path: question[1], line: null, q: question[2] };
  }
  const located = AIDLC_LINE_RE.exec(rest);
  if (located !== null && located[1] !== undefined && located[2] !== undefined) {
    const line = Number(located[2]);
    if (line < 1) return { raw, message: "line numbers are 1-based" };
    return { kind: "aidlc", raw, path: located[1], line, q: null };
  }
  return { raw, message: "expected `aidlc:<file>:<line>` or `aidlc:<file>#Q<n>`" };
}

/** `[repo ":"] path ":" line ["-" line]`, split from the right so paths may contain colons. */
function parseFileSrc(raw: string, repos?: ReadonlySet<string>): SrcRef | SrcParseError {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon <= 0) {
    return { raw, message: "expected `[repo:]path:line[-line]`" };
  }
  const lineSpec = raw.slice(lastColon + 1);
  const head = raw.slice(0, lastColon);
  let startLine: number;
  let endLine: number | null = null;
  if (LINE_RE.test(lineSpec)) {
    startLine = Number(lineSpec);
  } else {
    const range = LINE_RANGE_RE.exec(lineSpec);
    if (range === null || range[1] === undefined || range[2] === undefined) {
      return { raw, message: "expected a line number or `line-line` range after the last `:`" };
    }
    startLine = Number(range[1]);
    endLine = Number(range[2]);
    if (endLine < startLine) return { raw, message: "line range ends before it starts" };
  }
  if (startLine < 1) return { raw, message: "line numbers are 1-based" };

  let repo: string | null = null;
  let path = head;
  const firstColon = head.indexOf(":");
  if (firstColon > 0) {
    const candidate = head.slice(0, firstColon);
    // A repo prefix is a slug; with no repo list to check against, treat any slug as one.
    if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(candidate) && (repos === undefined || repos.has(candidate))) {
      repo = candidate;
      path = head.slice(firstColon + 1);
    }
  }
  if (path === "") return { raw, message: "empty path" };
  if (path.includes("..")) return { raw, message: "`..` is not allowed in a source path" };
  return { kind: "file", raw, repo, path, startLine, endLine };
}

/**
 * Three outcomes, not two (2026-08-29 audit, gap 2).
 *
 * `ok` — checked, and it is there. `refused` — checked, and it is NOT there; the
 * claim is denied. `unverified` — the citation is well formed and the thing it
 * names cannot be checked from disk (an https URL nothing in the workspace
 * mentions; an `absent:` on a file that DOES exist, where the absence is a claim
 * about its content). An `unverified` citation never fails a stage — but it is
 * counted, and an auto gate will not close over one. Before this existed, six of
 * the eight src kinds returned `ok` unconditionally: a handoff citing `F999`,
 * `Q42` and `graph:i-made-this-up` validated clean and auto-approved itself.
 */
export type SrcOutcome = "ok" | "unverified" | "refused";

export interface SrcResolution {
  /** False only for `refused`. An `unverified` src does not fail the stage. */
  readonly ok: boolean;
  readonly outcome: SrcOutcome;
  /** Absolute path a `file` src resolved to, when it is a `file` src. */
  readonly resolved?: string;
  readonly message?: string;
}

const lineCountCache = new Map<string, number>();

const OK: SrcResolution = { ok: true, outcome: "ok" };

function refused(message: string, resolved?: string): SrcResolution {
  return resolved === undefined
    ? { ok: false, outcome: "refused", message }
    : { ok: false, outcome: "refused", message, resolved };
}

function unverified(message: string): SrcResolution {
  return { ok: true, outcome: "unverified", message };
}

/**
 * Resolve one ref against the workspace.
 *
 * `claim` is the bullet's own text, which only `absent:` needs: an absence can
 * source a NEGATIVE claim ("no retention policy is recorded") and nothing else.
 * The audit's probe sourced "we removed the auth check from /admin" with
 * `absent:ops/backup.yml`, and that is the shape being refused.
 */
export function resolveSrc(ref: SrcRef, ctx: SrcContext, section: string, claim = ""): SrcResolution {
  switch (ref.kind) {
    case "file": {
      if (ref.repo !== null && !ctx.repos.has(ref.repo)) {
        return refused(`unknown repo \`${ref.repo}\` (not in workspace.yml)`);
      }
      const bases = fileBases(ref, ctx);
      // Every base is tried, and a base where the file EXISTS but is too short no
      // longer ends the search. Since issue #16 added the epic worktree ahead of
      // the working tree, stopping at the first existing copy would refuse a
      // citation that resolves perfectly well one base later — a file truncated on
      // the epic branch would deny a claim about the line it still has on `main`.
      // The short copy is remembered so the failure message stays the precise one
      // when NO base can carry the line.
      let short: SrcResolution | null = null;
      for (const base of bases) {
        if (!existsSync(base.abs) || !statSync(base.abs).isFile()) continue;
        const lines = countLines(base.abs);
        const highest = ref.endLine ?? ref.startLine;
        if (highest > lines) {
          short ??= refused(`${ref.path} has ${lines} line(s); cited line ${highest}`, base.abs);
          continue;
        }
        return { ok: true, outcome: "ok", resolved: base.abs };
      }
      if (short !== null) return short;
      const tried = bases.map((b) => b.label).join(", ");
      return refused(`no such file: ${ref.path} — tried ${tried}`, bases[0]?.abs);
    }
    case "cmd": {
      if (section !== "Evidence ledger") {
        return refused("`$ … → exit n` sources are only allowed in the Evidence ledger");
      }
      // `[assumption]` — with no workspace.yml commands to check against (no file, or
      // an empty one) a `cmd` src cannot be checked. That used to read as `ok`; it is
      // `unverified` now, because "there was nothing to check against" and "it checks
      // out" are different sentences and only one of them may close a gate.
      if (ctx.commands.size === 0) {
        return unverified("no workspace.yml commands to check `$ … → exit n` against");
      }
      if (!ctx.commands.has(ref.command)) {
        return refused(`command \`${ref.command}\` is not one of workspace.yml's commands`);
      }
      // Membership is checked; the EXIT CODE is the agent's word and is not re-run here.
      return OK;
    }
    case "fact":
      return resolveFact(ref.id, ctx);
    case "answer":
      return resolveAnswer(ref.q, ctx);
    case "graph":
      return resolveGraph(ref.node, ctx);
    case "doc":
      return resolveDoc(ref.url, ctx);
    case "absent":
      return resolveAbsent(ref.path, ctx, section, claim);
    case "aidlc":
      // Unchanged by design (§6): the AI-DLC intent folder is OUTSIDE the workspace
      // and may be gone. An `aidlc:` src records where a claim came from; it was
      // never a promise the file is still there, so it is not made one now.
      return OK;
  }
}

// --- verifying the five kinds that used to wave through ---------------------

/** `F<n>` must be a row in `.tldrx/memory/facts.yml`, and must not be retired. */
function resolveFact(id: string, ctx: SrcContext): SrcResolution {
  const facts = loadFacts(ctx.root);
  if (facts === null) {
    return unverified(`no ${PROJECT_FRAMEWORK_DIR}/memory/facts.yml to check ${id} against`);
  }
  if (facts.retired.has(id)) {
    return refused(`${id} is RETIRED in facts.yml — a retired fact is not evidence`);
  }
  if (!facts.live.has(id)) {
    const known = facts.live.size === 0 ? "it has no live facts" : `it has ${String(facts.live.size)} live fact(s)`;
    return refused(`no such fact ${id} in ${PROJECT_FRAMEWORK_DIR}/memory/facts.yml — ${known}`);
  }
  return OK;
}

/** `Q<n>` must be a question block in one of this run's `questions.md` files. */
function resolveAnswer(q: string, ctx: SrcContext): SrcResolution {
  const runDir = ctx.runDir ?? null;
  if (runDir === null || runDir === "") {
    return unverified(`no run directory in context to look ${q} up in`);
  }
  const ids = loadQuestionIds(runDir);
  if (ids === null) return refused(`no questions.md anywhere in this run — ${q} cites a question nobody asked`);
  if (!ids.has(q)) {
    const known = ids.size === 0 ? "none are declared" : `declared: ${[...ids].sort().join(", ")}`;
    return refused(`no such question ${q} in this run's questions.md — ${known}`);
  }
  return OK;
}

/** `graph:<node>` must be a node id in `graphify-out/graph.json`, or named in the map. */
function resolveGraph(node: string, ctx: SrcContext): SrcResolution {
  const graph = loadGraphNodes(ctx.root);
  if (graph !== null) {
    if (graph.has(node)) return OK;
    return refused(`no node \`${node}\` in graphify-out/graph.json (${String(graph.size)} node(s))`);
  }
  const map = loadMapTokens(ctx.root);
  if (map === null) {
    return unverified(`no graphify-out/graph.json and no ${PROJECT_FRAMEWORK_DIR}/map/ to check \`${node}\` against`);
  }
  if (map.has(node)) return OK;
  return refused(`\`${node}\` is not a node id or a path named anywhere in ${PROJECT_FRAMEWORK_DIR}/map/`);
}

/**
 * `https://…` cannot be fetched — a hook has no network and a gate must not gain
 * one. So the check is provenance rather than content: the URL is accepted when
 * something in the workspace ALREADY names it (a knowledge file, the map, a
 * declared input of this run). Otherwise it is `unverified`: not a lie, not a
 * check either, and never enough on its own to close a gate.
 */
function resolveDoc(url: string, ctx: SrcContext): SrcResolution {
  const known = loadDeclaredUrls(ctx);
  if (known.has(url) || known.has(url.replace(/[/#?]+$/, ""))) return OK;
  return unverified(`${url} is not fetched offline and no input, map or knowledge file cites it`);
}

/**
 * `absent:<path>` — "looked here, found nothing". Two halves:
 *
 *  1. The claim must be NEGATIVE. An absence can source "no retention policy is
 *     recorded"; it cannot source "we removed the auth check from /admin". This is
 *     the half that catches the audit's probe, and it is a refusal.
 *
 *     `## Unknowns` is exempt, because that heading IS the negation: §2.8's own
 *     example is `- Retention period for historical rankings [src: absent:…]`,
 *     which reads as a positive noun phrase and means "we do not know it". A
 *     word-level rule applied there would outlaw the spec's documented shape.
 *  2. The path itself. If it does not exist, the absence is literal and checked.
 *     If it DOES exist — the spec's other idiom is
 *     `- none [src: absent:.tldrx/memory/facts.yml]`, and facts.yml is a file that
 *     exists — then the claim is about that file's CONTENT, which nothing here can
 *     read. That is `unverified`, not a refusal: refusing it would outlaw §2.8's
 *     documented spelling of an empty section.
 */
function resolveAbsent(path: string, ctx: SrcContext, section: string, claim: string): SrcResolution {
  if (section !== "Unknowns" && claim !== "" && !isNegativeClaim(claim)) {
    return refused(
      `absent:${path} sources a positive claim — an absence can only support a negative one ` +
        "(say what is NOT there: `no`, `not`, `never`, `none`, `absent`), or move it under Unknowns",
    );
  }
  const abs = isAbsolute(path) ? normalize(path) : normalize(join(ctx.root, path));
  if (!existsSync(abs)) return OK;
  return unverified(`${path} EXISTS — "found nothing in it" is a claim about its contents, unchecked here`);
}

/** Word-boundary negation. Substring matching would read "nothing" out of "notation". */
const NEGATIVE_RE =
  /\b(no|not|none|never|nothing|nobody|nowhere|neither|nor|absent|absence|missing|lacks?|lacking|without|unknown|undocumented|unrecorded|untracked|zero|n\/a)\b|n't\b/i;

export function isNegativeClaim(text: string): boolean {
  return NEGATIVE_RE.test(text);
}

interface FileBase {
  /** Human-readable name of the base, for the "tried …" half of a failure message. */
  readonly label: string;
  readonly abs: string;
}

/**
 * The bases a `file` src is resolved against, in order — first existing wins (spec §2.8).
 *
 * A bare `path:line` is ambiguous by design: the sub-agent writing a handoff thinks
 * run-relatively (`01-what/intent.md:1`) while the workspace thinks root-relatively
 * (`.tldrx/memory/facts.yml:4`). Both are legal, so both are tried:
 *
 *   (a) this run's epic worktree for the repo, when there is one (issue #16),
 *   (b) the workspace root,
 *   (c) the run directory of the handoff being validated (when the caller knows it),
 *   (d) the repo dir, when the path starts with a known repo name + `/` — i.e.
 *       `api/src/Hunt.cs` is accepted as a spelling of `api:src/Hunt.cs`.
 *
 * (a) comes first because the epic branch is the code the run is ABOUT: at Watch
 * time the working tree is deliberately behind it, and "the file is not on `main`
 * yet" is the expected state rather than a bad citation. A repo-qualified
 * `repo:path` and an absolute path still resolve to exactly one place in the
 * working tree; the epic worktree adds one more, never a different repo's.
 */
function fileBases(
  ref: Extract<SrcRef, { kind: "file" }>,
  ctx: SrcContext,
): readonly FileBase[] {
  if (isAbsolute(ref.path)) {
    return [{ label: "the absolute path as written", abs: normalize(ref.path) }];
  }
  if (ref.repo !== null) {
    const rel = ctx.repos.get(ref.repo) ?? "";
    return [
      ...epicBases(ctx, ref.repo, ref.path),
      { label: repoLabel(ref.repo, rel), abs: normalize(join(ctx.root, rel, ref.path)) },
    ];
  }
  const bases: FileBase[] = [];
  const slash = ref.path.indexOf("/");
  const named = slash > 0 ? ref.path.slice(0, slash) : "";
  const rel = named === "" ? undefined : ctx.repos.get(named);
  if (rel !== undefined) bases.push(...epicBases(ctx, named, ref.path.slice(slash + 1)));
  bases.push({ label: "workspace root", abs: normalize(join(ctx.root, ref.path)) });
  const runDir = ctx.runDir ?? null;
  if (runDir !== null && runDir !== "") {
    bases.push({ label: `run dir ${displayPath(ctx.root, runDir)}`, abs: normalize(join(runDir, ref.path)) });
  }
  if (rel !== undefined) {
    bases.push({
      label: repoLabel(named, rel),
      abs: normalize(join(ctx.root, rel, ref.path.slice(slash + 1))),
    });
  }
  return bases;
}

/** This run's epic checkouts of ONE repo, as bases for a path inside that repo. */
function epicBases(ctx: SrcContext, repo: string, path: string): readonly FileBase[] {
  const trees = ctx.epicWorktrees ?? [];
  const bases: FileBase[] = [];
  for (const tree of trees) {
    if (tree.repo !== repo) continue;
    bases.push({
      label: `epic worktree ${displayPath(ctx.root, tree.dir)}`,
      abs: normalize(join(tree.dir, path)),
    });
  }
  return bases;
}

function repoLabel(name: string, rel: string): string {
  const at = rel === "" || rel === "." ? "workspace root" : rel;
  return `repo \`${name}\` (${at})`;
}

/** Workspace-relative when it can be — an absolute temp path in a deny message is noise. */
function displayPath(root: string, dir: string): string {
  const rel = relative(root, dir);
  return rel === "" || rel.startsWith("..") ? dir : rel.split(sep).join("/");
}

function countLines(path: string): number {
  const cached = lineCountCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(path, "utf8");
  const count = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  lineCountCache.set(path, count);
  return count;
}

// --- the evidence indexes ---------------------------------------------------
//
// Every one of these is LAZY and memoised per process: a handoff with no `F<n>`
// never opens facts.yml, and one with forty opens it once. That is what keeps the
// hook inside its 50 ms budget (spec §0) now that it actually checks things.

interface FactIndex {
  readonly live: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
}

const factsCache = new Map<string, FactIndex | null>();
const questionsCache = new Map<string, ReadonlySet<string> | null>();
const graphCache = new Map<string, ReadonlySet<string> | null>();
const mapCache = new Map<string, ReadonlySet<string> | null>();
const urlCache = new Map<string, ReadonlySet<string>>();

/** Files read per index, and bytes per file — a runaway workspace must not stall a hook. */
const MAX_SCAN_FILES = 400;
const MAX_SCAN_BYTES = 512 * 1024;
const MAX_SCAN_DEPTH = 4;

function loadFacts(root: string): FactIndex | null {
  const cached = factsCache.get(root);
  if (cached !== undefined) return cached;
  const index = readFacts(join(root, PROJECT_FRAMEWORK_DIR, "memory", "facts.yml"));
  factsCache.set(root, index);
  return index;
}

function readFacts(path: string): FactIndex | null {
  if (!existsSync(path)) return null;
  const live = new Set<string>();
  const retired = new Set<string>();
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    const rows = (doc as { facts?: unknown } | null)?.facts;
    if (!Array.isArray(rows)) return { live, retired };
    for (const row of rows as Record<string, unknown>[]) {
      const id = typeof row?.id === "string" ? row.id : null;
      if (id === null) continue;
      const gone = row.retired;
      const isGone =
        gone !== null && gone !== undefined && typeof gone === "object" &&
        (gone as { at?: unknown }).at !== null && (gone as { at?: unknown }).at !== undefined;
      if (isGone) retired.add(id);
      else live.add(id);
    }
  } catch {
    // An unreadable facts.yml is "cannot check", not "check failed".
    return null;
  }
  return { live, retired };
}

/** Every `## Q<n>` heading in every `questions.md` under the run, any phase. */
function loadQuestionIds(runDir: string): ReadonlySet<string> | null {
  const cached = questionsCache.get(runDir);
  if (cached !== undefined) return cached;
  const files = findFiles(runDir, (name) => name === "questions.md", MAX_SCAN_DEPTH);
  if (files.length === 0) {
    questionsCache.set(runDir, null);
    return null;
  }
  const ids = new Set<string>();
  const heading = /^#{2,4}\s*(Q\d{1,6})\b/gm;
  for (const file of files) {
    const text = readCapped(file);
    for (const match of text.matchAll(heading)) {
      if (match[1] !== undefined) ids.add(match[1]);
    }
  }
  questionsCache.set(runDir, ids);
  return ids;
}

/**
 * Node ids from graphify's export. Both layouts are tried — `.tldrx/graphify-out/`
 * (what `map --refresh` writes) and a bare `graphify-out/` beside the workspace.
 */
function loadGraphNodes(root: string): ReadonlySet<string> | null {
  const cached = graphCache.get(root);
  if (cached !== undefined) return cached;
  const ids = readGraphNodes(root);
  graphCache.set(root, ids);
  return ids;
}

function readGraphNodes(root: string): ReadonlySet<string> | null {
  const roots = [join(root, PROJECT_FRAMEWORK_DIR, "graphify-out"), join(root, "graphify-out")];
  const files: string[] = [];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    files.push(...findFiles(dir, (name) => name === "graph.json", MAX_SCAN_DEPTH));
  }
  if (files.length === 0) return null;
  const ids = new Set<string>();
  for (const file of files) {
    try {
      const doc: unknown = JSON.parse(readCapped(file));
      const nodes = (doc as { nodes?: unknown } | null)?.nodes;
      if (!Array.isArray(nodes)) continue;
      for (const node of nodes as Record<string, unknown>[]) {
        for (const key of ["id", "name", "label"] as const) {
          const value = node?.[key];
          if (typeof value === "string" && value !== "") {
            ids.add(value);
            break;
          }
        }
      }
    } catch {
      // A graph.json we cannot parse contributes no ids; another one still may.
    }
  }
  return ids.size === 0 ? null : ids;
}

/** Words and paths the code map names — the fallback when there is no graph.json. */
function loadMapTokens(root: string): ReadonlySet<string> | null {
  const cached = mapCache.get(root);
  if (cached !== undefined) return cached;
  const dir = join(root, PROJECT_FRAMEWORK_DIR, "map");
  if (!existsSync(dir)) {
    mapCache.set(root, null);
    return null;
  }
  const tokens = new Set<string>();
  const word = /[A-Za-z0-9_./-]{2,}/g;
  for (const file of findFiles(dir, (name) => name.endsWith(".md") || name.endsWith(".json"), MAX_SCAN_DEPTH)) {
    for (const match of readCapped(file).matchAll(word)) tokens.add(match[0]);
  }
  mapCache.set(root, tokens);
  return tokens;
}

/**
 * Every https URL the workspace already names: the run's own artefacts (its
 * declared inputs and outputs all live there), the code map, and trained expert
 * knowledge. A `doc` src that appears in none of them is `unverified`.
 */
function loadDeclaredUrls(ctx: SrcContext): ReadonlySet<string> {
  const key = `${ctx.root} ${ctx.runDir ?? ""}`;
  const cached = urlCache.get(key);
  if (cached !== undefined) return cached;
  const urls = new Set<string>();
  const url = /https:\/\/[^\s)\]"'`<>]+/g;
  const runDir = ctx.runDir ?? "";
  const dirs: readonly string[] = [
    join(ctx.root, PROJECT_FRAMEWORK_DIR, "map"),
    join(ctx.root, PROJECT_FRAMEWORK_DIR, "knowledge"),
    join(ctx.root, PROJECT_FRAMEWORK_DIR, "experts"),
    ...(runDir === "" ? [] : [runDir]),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    // handoff.md is excluded on purpose: a handoff citing its own URL would be
    // evidence for itself.
    for (const file of findFiles(dir, (name) => name.endsWith(".md") && name !== "handoff.md", MAX_SCAN_DEPTH)) {
      for (const match of readCapped(file).matchAll(url)) {
        urls.add(match[0].replace(/[.,;:]+$/, ""));
      }
    }
  }
  urlCache.set(key, urls);
  return urls;
}

/** Depth- and count-capped directory walk. Dot-directories are skipped except the two we own. */
function findFiles(dir: string, accept: (name: string) => boolean, depth: number): readonly string[] {
  const found: string[] = [];
  const walk = (current: string, left: number): void => {
    if (left < 0 || found.length >= MAX_SCAN_FILES) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found.length >= MAX_SCAN_FILES) return;
      if (name.startsWith(".") && name !== PROJECT_FRAMEWORK_DIR) continue;
      if (name === "node_modules") continue;
      const abs = join(current, name);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(abs, left - 1);
      else if (accept(name)) found.push(abs);
    }
  };
  walk(dir, depth);
  return found;
}

function readCapped(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
  } catch {
    return "";
  }
}

/** Drop every memoised index — tests that rewrite fixtures need this. */
export function clearSrcCaches(): void {
  lineCountCache.clear();
  factsCache.clear();
  questionsCache.clear();
  graphCache.clear();
  mapCache.clear();
  urlCache.clear();
}
