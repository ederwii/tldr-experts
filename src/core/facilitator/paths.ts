/**
 * Where a stage's declared paths actually live.
 *
 * `stage.yml` mixes two roots in one list: `01-what/intent.md` is inside the run,
 * `.tldrx/map/api/architecture.md` is inside the workspace. The spec never says
 * which is which because to a human it is obvious, so the rule is written down
 * here once: anything starting with `.tldrx/` (or `tldrx-work/`) is workspace-
 * relative, everything else is run-relative. `[assumption]`
 *
 * A run's SEED documents (`run new --seed`) break that rule from the other side:
 * `requirements.md` lives at the workspace root and is never copied into the run.
 * So a path that is not workspace-prefixed falls back to the workspace root when
 * it does not exist inside the run — the same "first existing base wins" order
 * §2.8 already uses to resolve a bare `file` src. It can only make MORE paths
 * resolve, never fewer.
 *
 * **Patterns.** A third kind of declared path exists and used to be treated as a
 * literal: `03-plan/stories/<id>.md`. The Plan stage cannot name its outputs — it
 * does not know how many stories there will be until it has written them — so
 * `stage.yml` declares the SHAPE and the angle-bracket token stands for the part
 * that varies. Measured 2026-08-30 on a live `feature` run: Plan wrote
 * `epics/E1.md` and `stories/S1.md`..`S7.md`, and `next --commit` failed with
 * "`03-plan/stories/<id>.md` was declared as an output but does not exist on
 * disk" — because `existsSync` was asked about a path with a literal `<id>` in
 * it. A pattern is not a path; it is a question about a directory. Everywhere a
 * declared path meets the filesystem it goes through `resolveMany` /
 * `existsDeclared` below, which answer that question by reading the directory.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PROJECT_FRAMEWORK_DIR, PROJECT_WORK_DIR } from "../paths.ts";
import { EVIDENCE_FILE, gateEvidenceRelPath } from "../text/evidence.ts";

const REPO_TOKEN = "{repo}";

export interface PathContext {
  readonly root: string;
  readonly runDir: string;
}

export function isWorkspaceRelative(declared: string): boolean {
  return declared.startsWith(`${PROJECT_FRAMEWORK_DIR}/`) || declared.startsWith(`${PROJECT_WORK_DIR}/`);
}

export function resolveDeclared(declared: string, ctx: PathContext): string {
  if (isWorkspaceRelative(declared)) return join(ctx.root, declared);
  const inRun = join(ctx.runDir, declared);
  if (existsSync(inRun)) return inRun;
  const inWorkspace = join(ctx.root, declared);
  return existsSync(inWorkspace) ? inWorkspace : inRun;
}

/**
 * Spec §2.3: "`{repo}` expands per repo." One declared path with the token becomes
 * one path per repo in the run; a path without it is returned unchanged.
 */
export function expandRepos(declared: string, repos: readonly string[]): readonly string[] {
  if (!declared.includes(REPO_TOKEN)) return [declared];
  return repos.map((repo) => declared.split(REPO_TOKEN).join(repo));
}

export function expandAll(declared: readonly string[], repos: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const entry of declared) {
    for (const expanded of expandRepos(entry, repos)) {
      if (!out.includes(expanded)) out.push(expanded);
    }
  }
  return out;
}

/**
 * An angle-bracket token — `<id>`, `<epic>`, `<story-id>` — inside one path
 * segment. `{repo}` is deliberately NOT one of these: it expands to a known list
 * before anything looks at the disk (`expandRepos`), while a pattern can only be
 * answered by the directory it points at.
 */
const PATTERN_TOKEN_RE = /<[^<>/]+>/;

/** True when `declared` stands for a SET of files rather than one file. */
export function isPattern(declared: string): boolean {
  return PATTERN_TOKEN_RE.test(declared);
}

/** One file a declared path stands for. */
export interface ResolvedPath {
  /**
   * How to cite it: the declared string itself for a plain path, and the
   * CONCRETE relative path (`03-plan/stories/S1.md`) for a pattern match — a
   * prompt or a revert line that says `<id>` teaches nobody anything.
   */
  readonly path: string;
  readonly absolute: string;
}

/**
 * Every file a declared path stands for, in a stable order.
 *
 * A plain path is one entry, resolved exactly as `resolveDeclared` always has —
 * including when it does not exist, so callers that want to write it, delete it
 * or report it missing keep the path they had. A pattern is zero or more, and
 * only ever files that are really there.
 */
export function resolveMany(declared: string, ctx: PathContext): readonly ResolvedPath[] {
  if (!isPattern(declared)) return [{ path: declared, absolute: resolveDeclared(declared, ctx) }];
  return matchPattern(declared, ctx);
}

/**
 * The files a pattern matches, resolved against the same bases in the same order
 * `resolveDeclared` uses: the run dir first, then the workspace root, and the
 * first base that matches ANYTHING wins. A pattern that matches nothing is an
 * empty list — never a made-up path.
 */
export function matchPattern(declared: string, ctx: PathContext): readonly ResolvedPath[] {
  const segments = declared.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return [];
  const bases = isWorkspaceRelative(declared) ? [ctx.root] : [ctx.runDir, ctx.root];
  for (const base of bases) {
    const hits = walk(base, segments);
    if (hits.length > 0) return hits.map((absolute) => ({ path: toPosix(relative(base, absolute)), absolute }));
  }
  return [];
}

/** Does this declared path have something behind it? A pattern needs one match. */
export function existsDeclared(declared: string, ctx: PathContext): boolean {
  if (isPattern(declared)) return matchPattern(declared, ctx).length > 0;
  return existsSync(resolveDeclared(declared, ctx));
}

/**
 * Declared paths with every pattern replaced by the concrete files it matches,
 * in declaration order, deduplicated. A pattern that matches nothing drops out —
 * there is nothing to read. Plain paths pass through untouched, present or not.
 *
 * This is what a PROMPT wants: the sub-agent is handed real files. The gap check
 * wants the opposite (`missing`), which keeps the pattern so the operator is told
 * which declaration went unanswered rather than being told nothing at all.
 */
export function expandPatterns(declared: readonly string[], ctx: PathContext): readonly string[] {
  const out: string[] = [];
  const add = (path: string): void => {
    if (!out.includes(path)) out.push(path);
  };
  for (const entry of declared) {
    if (!isPattern(entry)) {
      add(entry);
      continue;
    }
    for (const hit of matchPattern(entry, ctx)) add(hit.path);
  }
  return out;
}

/** Declared paths that resolve to a file on disk, in declaration order. */
export function present(declared: readonly string[], ctx: PathContext): readonly string[] {
  return declared.filter((entry) => existsDeclared(entry, ctx));
}

export function missing(declared: readonly string[], ctx: PathContext): readonly string[] {
  return declared.filter((entry) => !existsDeclared(entry, ctx));
}

/** Walk `segments` down from `base`, branching wherever a segment is a pattern. */
function walk(base: string, segments: readonly string[]): readonly string[] {
  let current: readonly string[] = [base];
  for (const segment of segments) {
    const next: string[] = [];
    if (isPattern(segment)) {
      const matcher = segmentMatcher(segment);
      const hidden = segment.startsWith(".");
      for (const dir of current) {
        for (const name of namesIn(dir)) {
          if (!hidden && name.startsWith(".")) continue;
          if (matcher.test(name)) next.push(join(dir, name));
        }
      }
    } else {
      for (const dir of current) {
        const candidate = join(dir, segment);
        if (existsSync(candidate)) next.push(candidate);
      }
    }
    if (next.length === 0) return [];
    current = next;
  }
  return current.filter(isFile);
}

/** `<id>.md` -> /^.+\.md$/. The token matches within one segment only. */
function segmentMatcher(segment: string): RegExp {
  const source = segment
    .split(/(<[^<>/]+>)/)
    .map((part) => (part.startsWith("<") && part.endsWith(">") && part.length > 2 ? "[^/]+" : escapeRe(part)))
    .join("");
  return new RegExp(`^${source}$`);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sorted so a pattern's matches come back in the same order on every machine. */
function namesIn(dir: string): readonly string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** `tldrx-work/<run>/.agent/<stage>/` — raw agent traffic, gitignored (spec §1). */
export function agentDir(runDir: string, stageId: string): string {
  return join(runDir, ".agent", stageId);
}

/**
 * `.agent/<stage>/evidence.md` — where an agent WRITES its gate evidence note
 * (design §A.5), beside `prompt.md`.
 *
 * Scratch, and deliberately so: the copy that gets committed is the one
 * `approve --as-agent` makes into `<phase>/gate-evidence/<stage>.md`. A gate whose
 * evidence lives only in a gitignored directory is a gate nobody can audit from a
 * clone.
 */
export function evidencePath(runDir: string, stageId: string): string {
  return join(agentDir(runDir, stageId), EVIDENCE_FILE);
}

/**
 * `<run>/<phase>/gate-evidence/<stage>.md` — the COMMITTED copy of the note an
 * `agent` gate was closed over (design §A.5).
 *
 * The scratch original lives under `.agent/`, which is gitignored; this is the
 * one a reviewer finds in a clone six weeks later, which is the only kind of
 * evidence a gate can actually rest on.
 */
export function gateEvidencePath(runDir: string, phaseId: string, stageId: string): string {
  return join(runDir, ...gateEvidenceRelPath(phaseId, stageId).split("/"));
}
