/**
 * Writing `competencies.yml` back after a training run (spec §2.6).
 *
 * Three rules, all of them the spec's:
 *
 *   - `level` is COMPUTED. Every area's level is recomputed on this write, not
 *     just the trained one — "a hand-edited value is overwritten on the next
 *     write" is the sentence that makes the star chart a measurement.
 *   - evidence is deduped by `src` and capped at 50 per area.
 *   - the document keeps its shape. The file is parsed, mutated and re-emitted
 *     rather than regenerated, so a team that added a key to it does not lose it
 *     to a training run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringifyYaml, parseYaml } from "../yaml.ts";
import { competencyLevel, type CompetencyEvidence } from "../init/competencyLevel.ts";
import { COMPETENCIES_FILE, expertDir } from "../experts/loadExperts.ts";
import { readEvidenceRows, unknownKindWarnings } from "../experts/readEvidenceRows.ts";
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

export function writeCompetencies(options: WriteCompetenciesOptions): CompetenciesWrite {
  const dir = expertDir(options.root, options.expert);
  const path = join(dir, COMPETENCIES_FILE);
  if (!existsSync(path)) throw new CompetenciesError(`${path} is missing — \`tldrx expert create\` writes it`);

  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CompetenciesError(`${path} is not a mapping`);
  }
  const doc = { ...(parsed as Record<string, unknown>) };
  const areas = Array.isArray(doc.areas) ? [...(doc.areas as unknown[])] : [];

  let write: CompetenciesWrite | null = null;
  const warnings: string[] = [];
  const next = areas.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const area = { ...(raw as Record<string, unknown>) };
    const id = str(area.id) !== "" ? str(area.id) : str(area.area);
    const rows = readEvidenceRows(area.evidence);
    const existing = rows.evidence;
    warnings.push(...unknownKindWarnings(options.expert, id, rows.ignored));

    if (id === options.areaId) {
      const merged = mergeEvidence(existing, options.evidence, options.now);
      area.evidence = merged.evidence.map((item) => ({ kind: item.kind, src: item.src, at: item.at }));
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
  writeFileSync(path, `${headerOf(text)}${stringifyYaml(doc)}`, "utf8");
  return { ...(write as CompetenciesWrite), warnings };
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
