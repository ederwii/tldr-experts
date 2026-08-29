/**
 * Read `.tldrx/experts/*` into `ExpertRecord`s, recomputing every level.
 *
 * The level on disk is never believed: spec §2.6 says `level` is computed and "a
 * hand-edited value is overwritten on the next write", so the reader recomputes
 * from `evidence` with the shared `competencyLevel` function that `tldrx init`
 * already writes files with, and reports the disagreement instead of hiding it.
 *
 * Reading is tolerant on purpose. `src/core/schemas/competencies.ts` still
 * validates the v0 draft shape (`schema_version`, `areas[].area`, string
 * evidence) and *rejects* the §2.6 files `init` actually writes (`version`,
 * `areas[].id`, `evidence[].{kind,src,at}`) — measured 2026-08-28 by running
 * `validate("competencies", …)` over an init-shaped document. Until that
 * validator is reconciled with the spec, a read-only view must not refuse to
 * show a file the framework itself produced.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { PROJECT_FRAMEWORK_DIR } from "../paths.ts";
import { competencyLevel } from "../init/competencyLevel.ts";
import { readEvidenceRows } from "./readEvidenceRows.ts";
import type { CompetencyEvidence } from "../init/competencyLevel.ts";
import type { AreaRecord, ExpertRecord } from "./ExpertRecord.ts";

export const EXPERTS_DIRNAME = "experts";
export const COMPETENCIES_FILE = "competencies.yml";
export const EXPERT_FILE = "expert.md";

export function expertsDir(root: string): string {
  return join(root, PROJECT_FRAMEWORK_DIR, EXPERTS_DIRNAME);
}

export function expertDir(root: string, name: string): string {
  return join(expertsDir(root), name);
}

/** Every expert folder, sorted by name. Missing `.tldrx/experts/` yields []. */
export function loadExperts(root: string, now: Date = new Date()): readonly ExpertRecord[] {
  const dir = expertsDir(root);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isDirectory())
    .sort();
  return names.map((name) => loadExpert(root, name, now));
}

export function loadExpert(root: string, name: string, now: Date = new Date()): ExpertRecord {
  const dir = expertDir(root, name);
  const path = join(dir, COMPETENCIES_FILE);
  const empty = { name, dir, status: "unknown", lastTrained: null, areas: [], drifted: [] };

  if (!existsSync(path)) return { ...empty, error: `${COMPETENCIES_FILE} is missing` };

  let doc: Record<string, unknown>;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...empty, error: `${COMPETENCIES_FILE} is not a mapping` };
    }
    doc = parsed as Record<string, unknown>;
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }

  const areas = Array.isArray(doc.areas)
    ? (doc.areas as unknown[]).map((area) => toArea(name, area, now)).filter((area): area is AreaRecord => area !== null)
    : [];

  return {
    name: typeof doc.expert === "string" && doc.expert !== "" ? doc.expert : name,
    dir,
    status: typeof doc.status === "string" ? doc.status : "unknown",
    lastTrained: typeof doc.last_trained === "string" ? doc.last_trained : null,
    areas,
    drifted: areas.filter((area) => area.storedLevel !== null && area.storedLevel !== area.level),
    error: null,
  };
}

function toArea(expert: string, input: unknown, now: Date): AreaRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  // `[assumption]` `area:` is the v0 draft's key for what §2.6 calls `id:`; both
  // are accepted so a workspace written before the rename still renders.
  const id = str(raw.id) !== "" ? str(raw.id) : str(raw.area);
  if (id === "") return null;

  const { evidence, ignored } = readEvidenceRows(raw.evidence);

  return {
    id,
    title: str(raw.title) !== "" ? str(raw.title) : id,
    storedLevel: typeof raw.level === "number" ? raw.level : null,
    level: competencyLevel(evidence, now),
    trainPrompt: str(raw.train_prompt) !== ""
      ? str(raw.train_prompt)
      : `tldrx expert train ${expert} --area ${id} --mode light`,
    evidence,
    ignored,
    newestEvidence: newestDate(evidence),
  };
}

function newestDate(evidence: readonly CompetencyEvidence[]): string | null {
  let newest: string | null = null;
  for (const item of evidence) {
    if (newest === null || item.at > newest) newest = item.at;
  }
  return newest;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
