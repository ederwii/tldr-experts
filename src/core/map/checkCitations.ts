/**
 * `tldrx map --check` — drift detection.
 *
 * A map is worth exactly as much as its citations: if `[src: api:src/X.cs:41]`
 * no longer resolves, the bullet is a memory, not a fact. This resolves every
 * `file` src in `.tldrx/map/**` and `.tldrx/init-handoff.md` against the
 * filesystem and reports the ones that no longer land.
 *
 * Only `file` srcs are resolvable here. `absent:`, `$ cmd`, `graph:`, `Q…`, `F…`,
 * `aidlc:` and `https://` are grammatical, not resolvable — they are checked
 * elsewhere (or, for `absent:`, by definition cannot be).
 *
 * ## One grammar (gh #80)
 *
 * This file used to read `[src: …]` through `core/map/srcToken.ts`, a SECOND and
 * divergent implementation: its `file` regex refused a path containing a colon,
 * its token regex was GLOBAL so a citation written mid-sentence counted, it
 * stripped no trailing backtick or period, and it had never heard of `aidlc:`.
 * A citation `claim-sources` accepted could be reported here as a problem, and
 * one it refused could be reported here as fine — the "two readers of one
 * question drift, and the looser one wins the argument at the wrong moment"
 * hazard `core/text/handoff.ts` is written against.
 *
 * The parser is gone. Everything grammatical below comes from
 * `core/text/srcToken.ts`, which means the #77 treatment arrives here by
 * construction: a rejection names the RULE it enforced, quotes the line as
 * written, and shows a line that would have passed, instead of the two
 * symptom-only strings (`unparseable src token` was one) this path used to print.
 *
 * Measured before the switch, over the two real `.tldrx/map` trees available
 * (39 documents, 692 lines, 435 carrying a citation): the two grammars disagreed
 * on ZERO lines. `test/map-citations.test.ts` pins the axes where they WOULD
 * differ, in both directions.
 */
import { join } from "node:path";
import { countLines } from "../detect/lineOf.ts";
import {
  describeSrcFailure, diagnoseSrcToken, hasSrcMarker, parseSrcToken, srcRule,
  type SrcRef, type SrcRuleId,
} from "../text/srcToken.ts";
import { readEntries, toPosix } from "../detect/walk.ts";
import { MAP_DIR } from "./buildMap.ts";
import { runtime } from "../runtime/index.ts";
import type { DetectedRepo } from "../detect/types.ts";

export const HANDOFF_FILE = ".tldrx/init-handoff.md";

/** The `file` production, as the canonical reader returns it. */
type FileRef = Extract<SrcRef, { kind: "file" }>;

/**
 * The one rule this checker owns that the grammar does not.
 *
 * `[src: …]` is a TOKEN grammar; "which lines must carry one" is a document
 * policy, and the map's policy is not the handoff's (`BULLET_RULE` names the
 * handoff's required sections, which a map document does not have). So it is
 * stated here, once, and quoted verbatim by the rejection — the #77 property,
 * applied to the one rule #77 could not supply.
 */
export const MAP_BULLET_RULE =
  "every bullet in `.tldrx/map/**` and the init handoff ends with a `[src: …]` token";

/** The document rule's own id, alongside the grammar's own (`SRC_RULE_IDS`). */
export const MAP_BULLET_RULE_ID = "map-bullet";

export interface CitationProblem {
  /** Workspace-relative path of the document holding the citation. */
  readonly file: string;
  readonly line: number;
  readonly src: string;
  /**
   * What is wrong, at whatever length it takes to be actionable.
   *
   * A GRAMMAR failure is three lines — the rule, the line as written, a line that
   * would pass — because that is what #77 measured the writer needs. A RESOLUTION
   * failure ("file does not exist") is one clause, because there is no rule to
   * state: the citation is well formed and the thing it names is not there.
   */
  readonly reason: string;
  /**
   * The rule that refused it, or `null` when the citation parsed and simply did
   * not resolve. Lets a caller tell "you wrote it wrong" from "it has drifted"
   * without parsing `reason`.
   */
  readonly rule: SrcRuleId | typeof MAP_BULLET_RULE_ID | null;
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

/**
 * Markdown bullets: lines starting with `- `.
 *
 * Lives here rather than in the grammar because it is about DOCUMENTS, not about
 * `[src: …]` — the thing the deleted second grammar got wrong was mixing the two.
 */
export function isBullet(line: string): boolean {
  return /^\s*- \S/.test(line);
}

/**
 * A missing citation, in `describeSrcFailure`'s three-line shape.
 *
 * The corrected line is `file-shape`'s own `good` example rather than a fourth
 * copy of a token written out by hand: the registry already owns a line that
 * parses, and one that stops parsing turns `test/src-grammar.test.ts` red.
 */
function describeMissingToken(line: string): string {
  return [
    `rule \`${MAP_BULLET_RULE_ID}\`: ${MAP_BULLET_RULE}`,
    `      you wrote: ${line.trim()}`,
    `      corrected: ${srcRule("file-shape").good}`,
  ].join("\n");
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

      // A line that never attempted a citation: only a BULLET owes one.
      if (!hasSrcMarker(line)) {
        if (isBullet(line)) {
          problems.push({
            file: relative, line: i + 1, src: "",
            reason: describeMissingToken(line), rule: MAP_BULLET_RULE_ID,
          });
        }
        continue;
      }

      // It tried. Either it parses, or exactly one rule says why it does not.
      //
      // `repos` is deliberately NOT passed: with no repo list, any slug-shaped
      // prefix is READ as a repo, so `lab:src/a.ts:1` in a workspace with no
      // `lab` still lands on "unknown repo `lab`" below — which names the
      // mistake — rather than degrading into a hunt for a file literally called
      // `lab:src/a.ts`.
      const token = parseSrcToken(line);
      if (token === null || token.errors.length > 0) {
        const failure = diagnoseSrcToken(line);
        // Unreachable: `hasSrcMarker` is true and the token did not parse clean.
        if (failure === null) continue;
        problems.push({
          file: relative, line: i + 1, src: failure.piece ?? "",
          reason: describeSrcFailure(failure), rule: failure.rule.id,
        });
        if (token === null) continue;
      }

      for (const ref of token.refs) {
        if (ref.kind !== "file") continue;
        checked += 1;
        const problem = await resolveFileSrc(ref, options, relative, i + 1);
        if (problem !== null) problems.push(problem);
      }
    }
  }
  return { checked, documents: documents.length, problems };
}

async function resolveFileSrc(
  src: FileRef,
  options: CheckOptions,
  document: string,
  line: number,
): Promise<CitationProblem | null> {
  let base = options.workspaceDir;
  if (src.repo !== null) {
    const repo = options.repos.find((candidate) => candidate.name === src.repo);
    if (repo === undefined) {
      return { file: document, line, src: src.raw, reason: `unknown repo \`${src.repo}\``, rule: null };
    }
    base = repo.path === "." ? options.root : join(options.root, repo.path);
  }

  const target = join(base, src.path);
  if (!(await runtime.exists(target))) {
    return { file: document, line, src: src.raw, reason: "file does not exist", rule: null };
  }
  const lineCount = countLines(await runtime.readText(target));
  const highest = src.endLine ?? src.startLine;
  if (highest > lineCount || src.startLine < 1) {
    return {
      file: document, line, src: src.raw,
      reason: `line out of range (file has ${lineCount})`, rule: null,
    };
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
