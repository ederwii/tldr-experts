/**
 * Writing `competencies.yml` back after a training run (spec §2.6).
 *
 * Four rules, all of them the spec's:
 *
 *   - `level` is COMPUTED. Every area's level is recomputed on this write, not
 *     just the trained one — "a hand-edited value is overwritten on the next
 *     write" is the sentence that makes the star chart a measurement.
 *   - evidence is deduped by `src` and capped at 50 per area.
 *   - every incoming row's `src` matches the §2.6/§2.8 grammar for its `kind`,
 *     and a row that does not is REFUSED rather than warned about. This is the
 *     one asymmetry with the reader: `readEvidenceRows` warns and drops, because
 *     it is reading a file a human may have edited, while everything reaching
 *     THIS function was derived by `codeEvidence`/`runEvidence` from a knowledge
 *     file the framework already validated. A bad row here is not bad input, it
 *     is a bug in the harness, and a bug that writes itself into the star chart
 *     is a bug nobody finds.
 *   - the document keeps its shape. The file is parsed, mutated and re-emitted
 *     rather than regenerated, so a team that added a key to it does not lose it
 *     to a training run.
 *
 * `tldrx expert recompute` lives here rather than beside the CLI on purpose: it
 * must produce a file byte-identical to the one training produces, so it shares
 * the reader (`readDocument`), the serializer (`serialize`) and the level
 * function line for line. Two writers of one file is how the shapes diverge.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringifyYaml, parseYaml } from "../yaml.ts";
import { competencyLevel, type CompetencyEvidence } from "../init/competencyLevel.ts";
import { COMPETENCIES_FILE, expertDir } from "../experts/loadExperts.ts";
import { readEvidenceRows, ignoredRowWarnings } from "../experts/readEvidenceRows.ts";
import { checkEvidenceSrc, describeSrcProblem } from "../experts/evidenceSrc.ts";
import { mergeEvidence } from "./knowledgeFile.ts";

const HEADER = "# Written by `tldrx expert train` (spec §2.6). `level` is computed, never hand-set.\n";

export interface WriteCompetenciesOptions {
  readonly root: string;
  readonly expert: string;
  readonly areaId: string;
  readonly evidence: readonly CompetencyEvidence[];
  readonly status: string;
  readonly lastTrained: string;
  readonly now: Date;
}

export interface CompetenciesWrite {
  readonly path: string;
  readonly added: readonly CompetencyEvidence[];
  readonly levelBefore: number;
  readonly levelAfter: number;
  readonly evidenceCount: number;
  readonly dropped: number;
  /**
   * Rows already in the file that this write could not count, one line per
   * unknown kind per area. Training reports them: a merge that quietly discards
   * half an area's evidence and then prints a level is the same silent failure
   * `expert list` had.
   */
  readonly warnings: readonly string[];
}

export class CompetenciesError extends Error {}

interface LoadedCompetencies {
  readonly path: string;
  /** The file exactly as it was on disk, so a no-op write can be detected. */
  readonly text: string;
  readonly doc: Record<string, unknown>;
  readonly areas: readonly unknown[];
}

function readDocument(root: string, expert: string): LoadedCompetencies {
  const path = join(expertDir(root, expert), COMPETENCIES_FILE);
  if (!existsSync(path)) throw new CompetenciesError(`${path} is missing — \`tldrx expert create\` writes it`);

  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CompetenciesError(`${path} is not a mapping`);
  }
  const doc = { ...(parsed as Record<string, unknown>) };
  return { path, text, doc, areas: Array.isArray(doc.areas) ? [...(doc.areas as unknown[])] : [] };
}

/** The one serializer. Both writers go through it, so both produce the same bytes. */
function serialize(loaded: LoadedCompetencies, doc: Record<string, unknown>): string {
  return `${headerOf(loaded.text)}${stringifyYaml(doc)}`;
}

/** `id:`, or the v0 draft's `area:` — the same fallback the reader uses. */
function areaId(area: Record<string, unknown>): string {
  return str(area.id) !== "" ? str(area.id) : str(area.area);
}

export function writeCompetencies(options: WriteCompetenciesOptions): CompetenciesWrite {
  rejectBadEvidence(options.expert, options.areaId, options.evidence);
  const loaded = readDocument(options.root, options.expert);
  const { path, doc, areas } = loaded;

  let write: CompetenciesWrite | null = null;
  const warnings: string[] = [];
  const next = areas.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const area = { ...(raw as Record<string, unknown>) };
    const id = areaId(area);
    const rows = readEvidenceRows(area.evidence);
    const existing = rows.evidence;
    warnings.push(...ignoredRowWarnings(options.expert, id, rows.ignored));

    if (id === options.areaId) {
      const merged = mergeEvidence(existing, options.evidence, options.now);
      // `cross` and `confidence` are written only when set, so a row that has
      // neither serialises byte-for-byte the way it always did (§2.6, additive).
      area.evidence = merged.evidence.map((item) => ({
        kind: item.kind,
        src: item.src,
        at: item.at,
        ...(item.cross === true ? { cross: true } : {}),
        ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
      }));
      area.level = merged.levelAfter;
      write = {
        path,
        added: merged.added,
        levelBefore: merged.levelBefore,
        levelAfter: merged.levelAfter,
        evidenceCount: merged.evidence.length,
        dropped: merged.dropped,
        warnings: [],
      };
      return area;
    }
    // Untouched areas still get their level recomputed — see the header.
    area.level = competencyLevel(existing, options.now);
    return area;
  });

  if (write === null) {
    throw new CompetenciesError(
      `${options.expert} has no area '${options.areaId}' — training may only add evidence to an area that exists`,
    );
  }

  doc.areas = next;
  doc.status = options.status;
  doc.last_trained = options.lastTrained;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(loaded, doc), "utf8");
  return { ...(write as CompetenciesWrite), warnings };
}

/**
 * Refuse to write a row whose `src` is not a citation of its `kind`.
 *
 * Thrown, not warned: these rows come from the harness. Writing one would put a
 * number on the star chart that nothing supports — and for `kind: run` it would
 * put it two rungs up, since §2.6 caps a runless area at 3.
 */
function rejectBadEvidence(
  expert: string,
  areaId: string,
  evidence: readonly CompetencyEvidence[],
): void {
  for (const row of evidence) {
    const problem = checkEvidenceSrc(row.kind, row.src);
    if (problem === null) continue;
    throw new CompetenciesError(
      `${expert}/${areaId}: refusing to write evidence — ${describeSrcProblem(row.kind, row.src, problem)}`,
    );
  }
}

export interface RecomputeOptions {
  readonly root: string;
  readonly expert: string;
  readonly now: Date;
}

export interface RecomputedArea {
  readonly id: string;
  /** The number that was on disk, or null when the file declared none. */
  readonly levelBefore: number | null;
  readonly levelAfter: number;
  readonly evidenceCount: number;
  readonly changed: boolean;
}

export interface CompetenciesRecompute {
  readonly path: string;
  /** False when the serialized document was byte-identical — nothing was written. */
  readonly written: boolean;
  readonly areas: readonly RecomputedArea[];
  readonly warnings: readonly string[];
}

/**
 * Recompute `level` for every area of one expert and write it back.
 *
 * The gap this closes: only the headless/`--commit` training path ever wrote a
 * level. A human who pasted the printed prompt into their own session ended with
 * `level: 0` on disk while the formula computed 5, and `expert list` and the
 * dashboard warned about the disagreement forever with no command to settle it.
 *
 * `status` and `last_trained` are deliberately untouched — this recomputes an
 * arithmetic result from evidence that is already on disk; it is not a training
 * run and must not claim to be one. Idempotent: a second run re-serializes to the
 * same bytes and writes nothing at all.
 */
export function recomputeCompetencies(options: RecomputeOptions): CompetenciesRecompute {
  const loaded = readDocument(options.root, options.expert);
  const { path, doc, areas } = loaded;

  const recomputed: RecomputedArea[] = [];
  const warnings: string[] = [];

  doc.areas = areas.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const area = { ...(raw as Record<string, unknown>) };
    const id = areaId(area);
    const rows = readEvidenceRows(area.evidence);
    warnings.push(...ignoredRowWarnings(options.expert, id, rows.ignored));

    const levelBefore = typeof area.level === "number" ? area.level : null;
    const levelAfter = competencyLevel(rows.evidence, options.now);
    area.level = levelAfter;
    recomputed.push({
      id,
      levelBefore,
      levelAfter,
      evidenceCount: rows.evidence.length,
      changed: levelBefore !== levelAfter,
    });
    return area;
  });

  const next = serialize(loaded, doc);
  if (next === loaded.text) return { path, written: false, areas: recomputed, warnings };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf8");
  return { path, written: true, areas: recomputed, warnings };
}

/** Keep whatever comment the file opened with; write ours when it had none. */
function headerOf(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  return first.startsWith("#") ? `${first}\n` : HEADER;
}

/**
 * Kept as the narrow "just the rows" view for callers that have nowhere to put a
 * warning. Everything that CAN report uses `readEvidenceRows` directly — this
 * function is where the silent drop lived, and the tally is the fix.
 */
export function readEvidence(input: unknown): readonly CompetencyEvidence[] {
  return readEvidenceRows(input).evidence;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
