/**
 * The `[src: …]` token grammar (spec §2.8), as a builder and a parser.
 *
 * ```
 * token  := "[src: " src ("; " src)* "]"
 * src    := file | doc | ans | fact | cmd | graph | absent
 * file   := [repo ":"] path ":" line ["-" line]
 * doc    := "https://" nonspace+
 * ans    := "Q" digit+          fact := "F" digit{3,6}
 * cmd    := "$ " command " → exit " digit+
 * graph  := "graph:" nodeid     absent := "absent:" path
 * ```
 *
 * Every regex is anchored and non-backtracking: these run inside a hook with a
 * 50 ms budget.
 */

export const SRC_KINDS = ["file", "doc", "ans", "fact", "cmd", "graph", "absent"] as const;
export type SrcKind = (typeof SRC_KINDS)[number];

export interface FileSrc {
  readonly kind: "file";
  readonly raw: string;
  readonly repo: string | null;
  readonly path: string;
  readonly line: number;
  readonly endLine: number | null;
}

export interface OtherSrc {
  readonly kind: Exclude<SrcKind, "file">;
  readonly raw: string;
}

export type ParsedSrc = FileSrc | OtherSrc;

const FILE_RE = /^(?:([a-z0-9-]{1,32}):)?([^\s:]+):(\d+)(?:-(\d+))?$/;
const DOC_RE = /^https:\/\/[^\s]+$/;
const ANS_RE = /^Q\d+$/;
const FACT_RE = /^F\d{3,6}$/;
const CMD_RE = /^\$ [^`]+ → exit \d+$/;
const GRAPH_RE = /^graph:[^\s]+$/;
const ABSENT_RE = /^absent:[^\s]+$/;

const TOKEN_RE = /\[src: ([^\]]+)\]/g;
/** A bullet must END with the token — a citation in the middle proves nothing about the rest. */
const TRAILING_TOKEN_RE = /\[src: [^\]]+\]$/;

export function parseSrc(raw: string): ParsedSrc | null {
  const file = FILE_RE.exec(raw);
  if (file) {
    const [, repo, path, line, endLine] = file;
    if (path === undefined || line === undefined) return null;
    return {
      kind: "file", raw, repo: repo ?? null, path,
      line: Number(line), endLine: endLine === undefined ? null : Number(endLine),
    };
  }
  if (DOC_RE.test(raw)) return { kind: "doc", raw };
  if (ANS_RE.test(raw)) return { kind: "ans", raw };
  if (FACT_RE.test(raw)) return { kind: "fact", raw };
  if (CMD_RE.test(raw)) return { kind: "cmd", raw };
  if (GRAPH_RE.test(raw)) return { kind: "graph", raw };
  if (ABSENT_RE.test(raw)) return { kind: "absent", raw };
  return null;
}

/** Render `srcs` as one token. Callers pass payloads, never a pre-built token. */
export function srcToken(srcs: readonly string[]): string {
  return `[src: ${srcs.join("; ")}]`;
}

export function endsWithToken(line: string): boolean {
  const trimmed = line.trimEnd();
  if (!TRAILING_TOKEN_RE.test(trimmed)) return false;
  return parseToken(trimmed).every((src) => src !== null);
}

/** Every src inside every token on the line, in order. `null` = unparseable. */
export function parseToken(line: string): readonly (ParsedSrc | null)[] {
  const out: (ParsedSrc | null)[] = [];
  for (const match of line.matchAll(TOKEN_RE)) {
    const payload = match[1];
    if (payload === undefined) continue;
    for (const raw of payload.split("; ")) out.push(parseSrc(raw.trim()));
  }
  return out;
}

/** Markdown bullets: lines starting with `- `. */
export function isBullet(line: string): boolean {
  return /^\s*- \S/.test(line);
}
