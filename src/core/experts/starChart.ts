/**
 * The star chart — `competencies.yml` rendered, nothing more (concept §6).
 *
 * One line per area:
 *   `ef-core  ★★★☆☆ 3  (4 evidence, newest 2026-08-20)`
 *
 * The evidence count and the newest date are on the line because a level with no
 * visible evidence behind it is exactly the self-declared number the formula
 * exists to prevent.
 */
import type { AreaRecord } from "./ExpertRecord.ts";

export const MAX_LEVEL = 5;
const FILLED = "★";
const EMPTY = "☆";

export function stars(level: number): string {
  const filled = Math.max(0, Math.min(MAX_LEVEL, Math.trunc(level)));
  return FILLED.repeat(filled) + EMPTY.repeat(MAX_LEVEL - filled);
}

/** `[assumption]` Zero evidence prints "(no evidence)" rather than "(0 evidence…)". */
export function evidenceNote(area: AreaRecord): string {
  const count = area.evidence.length;
  if (count === 0) return "(no evidence)";
  const newest = area.newestEvidence === null ? "" : `, newest ${area.newestEvidence}`;
  return `(${count} evidence${newest})`;
}

export function starChartLine(area: AreaRecord, width: number): string {
  return `${area.id.padEnd(width)}  ${stars(area.level)} ${area.level}  ${evidenceNote(area)}`;
}

export function starChart(areas: readonly AreaRecord[]): readonly string[] {
  const width = areas.reduce((max, area) => Math.max(max, area.id.length), 0);
  return areas.map((area) => starChartLine(area, width));
}
