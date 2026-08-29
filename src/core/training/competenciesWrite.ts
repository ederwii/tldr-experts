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
import { competencyLevel, EVIDENCE_KINDS, type CompetencyEvidence, type EvidenceKind } from "../init/competencyLevel.ts";
import { COMPETENCIES_FILE, expertDir } from "../experts/loadExperts.ts";
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
  const next = areas.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const area = { ...(raw as Record<string, unknown>) };
    const id = str(area.id) !== "" ? str(area.id) : str(area.area);
    const existing = readEvidence(area.evidence);

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
  return write;
}

/** Keep whatever comment the file opened with; write ours when it had none. */
function headerOf(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  return first.startsWith("#") ? `${first}\n` : HEADER;
}

export function readEvidence(input: unknown): readonly CompetencyEvidence[] {
  if (!Array.isArray(input)) return [];
  const out: CompetencyEvidence[] = [];
  for (const raw of input as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const kind = str(row.kind);
    const src = str(row.src);
    const at = str(row.at);
    if (src === "" || at === "" || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) continue;
    out.push({ kind: kind as EvidenceKind, src, at });
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
