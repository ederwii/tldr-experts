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
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

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
  /** Absolute workspace root; `file` paths without a repo prefix resolve here. [assumption] */
  readonly root: string;
  /** workspace.yml repo name -> path relative to the root. */
  readonly repos: ReadonlyMap<string, string>;
  /** Every non-null command string in workspace.yml — the only commands a `cmd` src may cite. */
  readonly commands: ReadonlySet<string>;
}

export function emptySrcContext(root: string): SrcContext {
  return { root, repos: new Map(), commands: new Set() };
}

const LINE_RE = /^\d{1,9}$/;
const LINE_RANGE_RE = /^(\d{1,9})-(\d{1,9})$/;
const ANSWER_RE = /^Q\d{1,6}$/;
const FACT_RE = /^F\d{3,6}$/;
const CMD_RE = /^\$ (.+) → exit (\d{1,3})$/;
const TRAILING_TOKEN_RE = /\[src: ([^\]]*)\]$/;
/** `aidlc:<file>:<line>` (prose) or `aidlc:<file>#Q<n>` (an answered question). */
const AIDLC_LINE_RE = /^(.+):(\d{1,9})$/;
const AIDLC_Q_RE = /^(.+)#(Q\d{1,6})$/;

/**
 * The `[src: …]` token a line ends with, or null when there is none.
 * Trailing whitespace is ignored; anything after the `]` means "no token".
 */
export function parseSrcToken(line: string, repos?: ReadonlySet<string>): SrcToken | null {
  const trimmed = line.replace(/\s+$/, "");
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

export interface SrcResolution {
  readonly ok: boolean;
  /** Absolute path a `file` src resolved to, when it is a `file` src. */
  readonly resolved?: string;
  readonly message?: string;
}

const lineCountCache = new Map<string, number>();

/** Resolve one ref against the workspace. Only `file` and `cmd` refs can fail here. */
export function resolveSrc(ref: SrcRef, ctx: SrcContext, section: string): SrcResolution {
  switch (ref.kind) {
    case "file": {
      const base = ref.repo === null ? ctx.root : join(ctx.root, ctx.repos.get(ref.repo) ?? "");
      if (ref.repo !== null && !ctx.repos.has(ref.repo)) {
        return { ok: false, message: `unknown repo \`${ref.repo}\` (not in workspace.yml)` };
      }
      const abs = isAbsolute(ref.path) ? ref.path : normalize(join(base, ref.path));
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return { ok: false, resolved: abs, message: `no such file: ${ref.path}` };
      }
      const lines = countLines(abs);
      const highest = ref.endLine ?? ref.startLine;
      if (highest > lines) {
        return { ok: false, resolved: abs, message: `${ref.path} has ${lines} line(s); cited line ${highest}` };
      }
      return { ok: true, resolved: abs };
    }
    case "cmd": {
      if (section !== "Evidence ledger") {
        return { ok: false, message: "`$ … → exit n` sources are only allowed in the Evidence ledger" };
      }
      // `[assumption]` — with no workspace.yml commands to check against (no file, or
      // an empty one) a `cmd` src is accepted; the hook must not invent a rule it
      // has no data for. `absent:` is never resolved: it asserts a hole, not a file.
      if (ctx.commands.size > 0 && !ctx.commands.has(ref.command)) {
        return { ok: false, message: `command \`${ref.command}\` is not one of workspace.yml's commands` };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

function countLines(path: string): number {
  const cached = lineCountCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(path, "utf8");
  const count = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  lineCountCache.set(path, count);
  return count;
}

/** Drop the memoised line counts — tests that rewrite fixtures need this. */
export function clearSrcCaches(): void {
  lineCountCache.clear();
}
