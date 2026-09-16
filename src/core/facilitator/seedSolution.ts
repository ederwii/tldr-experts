/**
 * The seed's own EXPLICIT technical-solution marker (gh #346).
 *
 * Owner decision, 2026-09-16: when a seed already declares its technical
 * solution, `how` is skipped and `plan` reads the seed's declared solution
 * instead. The skip must fire on an EXPLICIT, documented seed marker — never
 * inferred from prose — so this file recognises exactly ONE heading shape and
 * nothing softer.
 *
 * `run new --seed` never copies a seed document (`seed/collectSeed.ts`'s own
 * docstring: "It COPIES NOTHING: every document stays where the team put it").
 * So "does the seed carry a solution" is answered by re-reading those same
 * files off disk, through the run's OWN record of which paths they were —
 * `run.phases[0]`'s first stage's `inputs`, minus that stage's OWN
 * template-declared inputs (`.tldrx/memory/...`, `.tldrx/map/...` — never a
 * blanket `.tldrx/` prefix, which would also swallow a seed placed under the
 * documented `.tldrx/seeds/`, gh #358) and the run-relative index `run new`
 * writes itself (`<phase>/seed-index.md`).
 *
 * Heading detection reuses `seed/seedClaims.ts`'s fence-aware `seedHeadings` —
 * never a second regex over the same grammar (§7, "one implementation per
 * derivation").
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspaceRootOfRunDir } from "../lock/workspaceLock.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { resolveDeclared, type PathContext } from "./paths.ts";
import { seedHeadings, type SeedHeading } from "../seed/seedClaims.ts";
import type { SeedDocument } from "../seed/collectSeed.ts";
import type { RunFile } from "../run/RunFile.ts";

/**
 * The ONLY heading `run new --seed` reads as "the seed already declares the
 * technical solution" (gh #346 owner decision). An H2, matched WHOLE — a
 * `### Solution` (nested under something else) or a `## Solution and rollout`
 * do not count. Two spellings, both named in the owner decision; picking one
 * grammar for both keeps this a closed, deterministic check rather than a
 * softer "looks like a solution section" heuristic.
 */
export const SEED_SOLUTION_HEADING_RE = /^(Solution|Technical approach)$/i;

/** The heading level the marker must sit at — an H2, spelled out for the tests that pin it. */
export const SEED_SOLUTION_HEADING_LEVEL = 2;

/** A phase-folder-relative path (`01-what/seed-index.md`) — never a seed doc, which is workspace-root-relative. */
const PHASE_RELATIVE_RE = /^0[1-9]-[a-z]+\//;

/**
 * The `what` stage's OWN template-declared inputs (`stages/what/stage.yml`,
 * `seed: true`'s stage) — the only `.tldrx/`-rooted paths that stage ever
 * declares for itself, as opposed to a seed document `run new --seed` appended.
 *
 * gh #358: the old filter dropped every `.tldrx/`-rooted path, which also
 * swallowed `.tldrx/seeds/<name>.md` — where `run new --seed` and the docs put
 * a seed. Excluding by these two families instead (not the whole `.tldrx/`
 * tree) leaves a seed placed anywhere else under `.tldrx/`, `.tldrx/seeds/`
 * included, visible to `seedDocumentPaths`. If `stages/what/stage.yml` ever
 * declares another `.tldrx/`-rooted input, add its family here — this is the
 * one place seed detection reads that stage's own inputs.
 */
const WHAT_STAGE_OWN_INPUT_PREFIXES = [
  `${PROJECT_FRAMEWORK_DIR}/memory/`,
  `${PROJECT_FRAMEWORK_DIR}/map/`,
];

/** The seed's own declared solution, verbatim, plus what a citation needs. */
export interface SeedSolution {
  /** The section body, heading line included, trimmed. */
  readonly text: string;
  /** Workspace-relative — the same spelling a `[src:]` token already uses. */
  readonly srcPath: string;
  /** 1-based, the heading's own line. */
  readonly srcLine: number;
}

/**
 * The run's seed documents, resolved back to real files — every path the FIRST
 * stage's `inputs` carries (`newRun.ts`'s `declareSeedInputs`) that is neither
 * that stage's OWN template-declared input (`WHAT_STAGE_OWN_INPUT_PREFIXES`,
 * spec §2.3 — never a blanket `.tldrx/` prefix, gh #358) nor inside a phase
 * folder (`seed-index.md`, the table of contents `run new` writes itself). A
 * seed placed under `.tldrx/seeds/`, the documented location, is a seed
 * document like any other. An unseeded run's first stage has no such entries,
 * so this is `[]` for it — never a guess dressed as an empty seed.
 */
export function seedDocumentPaths(run: RunFile): readonly string[] {
  const first = run.phases[0]?.stages[0];
  if (first === undefined) return [];
  return first.inputs.filter(
    (path) => !WHAT_STAGE_OWN_INPUT_PREFIXES.some((prefix) => path.startsWith(prefix))
      && !PHASE_RELATIVE_RE.test(path),
  );
}

/**
 * Those same paths, READ off disk as `SeedDocument`s — the run dir first, then
 * the workspace root, the same fallback order `resolveDeclared` already uses
 * for a bare seed path (`paths.ts`). A path neither base has is skipped, not
 * refused: a seed doc `run new` accepted can still vanish before `how` runs,
 * and the marker is then simply not there.
 */
export function readSeedDocuments(runDir: string, run: RunFile): readonly SeedDocument[] {
  const ctx: PathContext = { root: workspaceRootOfRunDir(runDir), runDir };
  const documents: SeedDocument[] = [];
  for (const rel of seedDocumentPaths(run)) {
    const abs = resolveDeclared(rel, ctx);
    if (!existsSync(abs)) continue;
    try {
      const text = readFileSync(abs, "utf8");
      const bytes = statSync(abs).size;
      documents.push({ rel, abs, bytes, lines: text.split("\n").length, text });
    } catch {
      continue;
    }
  }
  return documents;
}

interface SolutionLocation {
  readonly document: SeedDocument;
  readonly heading: SeedHeading;
  readonly bodyEndExclusive: number;
}

/** The FIRST seed document carrying the marker, and where its section ends. */
function locateSolution(documents: readonly SeedDocument[]): SolutionLocation | null {
  for (const document of documents) {
    const headings = seedHeadings(document);
    const index = headings.findIndex(
      (h) => h.level === SEED_SOLUTION_HEADING_LEVEL && SEED_SOLUTION_HEADING_RE.test(h.text.trim()),
    );
    if (index === -1) continue;
    const heading = headings[index];
    if (heading === undefined) continue;
    const next = headings.slice(index + 1).find((h) => h.level <= SEED_SOLUTION_HEADING_LEVEL);
    const lineCount = document.text.split("\n").length;
    return { document, heading, bodyEndExclusive: next === undefined ? lineCount : next.line - 1 };
  }
  return null;
}

/** True the moment ANY seed document carries the H2 marker (gh #346). */
export function hasDeclaredSeedSolution(runDir: string, run: RunFile): boolean {
  return locateSolution(readSeedDocuments(runDir, run)) !== null;
}

/**
 * The seed's declared solution, verbatim (heading included) — `null` when no
 * seed document carries the marker.
 */
export function extractSeedSolution(runDir: string, run: RunFile): SeedSolution | null {
  const found = locateSolution(readSeedDocuments(runDir, run));
  if (found === null) return null;
  const lines = found.document.text.split("\n");
  const text = lines.slice(found.heading.line - 1, found.bodyEndExclusive).join("\n").trim();
  return { text, srcPath: found.document.rel, srcLine: found.heading.line };
}

/**
 * Materialises `<phaseId>/design.md` from the seed's declared solution — the
 * ONLY writer of that file when `how` never ran (gh #346). Deterministic, no
 * model involved: the same shape as the Build executor's `retro.md` append, a
 * mechanical writer that never fights an LLM one over the same file, because
 * there is no LLM one here at all.
 *
 * A no-op when: the skipped stage declares no `design.md`-named output
 * (nothing downstream is looking for that name), the file is already there
 * (never clobber real work — a re-run must not overwrite anything a person or
 * an agent already wrote), or the seed carries no marker (`extractSeedSolution`
 * returned `null` — belt and suspenders: `evaluateSkipIf` should not reach here
 * without one, but a stage.yml wiring `skip_if` to a run this predicate never
 * held for must still write nothing rather than invent content).
 */
export function materializeSeedSolution(
  runDir: string,
  run: RunFile,
  phaseId: string,
  outputs: readonly string[],
): void {
  const designOutput = outputs.find((path) => path === "design.md" || path.endsWith("/design.md"));
  if (designOutput === undefined) return;
  const relPath = designOutput.includes("/") ? designOutput : `${phaseId}/${designOutput}`;
  const absPath = join(runDir, ...relPath.split("/"));
  if (existsSync(absPath)) return;
  const section = extractSeedSolution(runDir, run);
  if (section === null) return;
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, renderMaterializedDesign(section), "utf8");
}

function renderMaterializedDesign(section: SeedSolution): string {
  return [
    "# Design",
    "",
    "> `how` was skipped (`skip_if: seed_solution==1`, gh #346): the seed already declared",
    "> its own technical solution, so this file is that section COPIED VERBATIM rather than",
    "> written by a `how` sub-agent. Nobody judged it — treat every claim in it as the",
    "> seed's, not this stage's.",
    "",
    section.text,
    "",
    `[src: ${section.srcPath}:${section.srcLine}]`,
    "",
  ].join("\n");
}
