/**
 * `tldrx expert list` — the table, the star charts, and the drift warnings.
 *
 * Every level printed here was recomputed from evidence at read time. When the
 * number on disk disagrees, both are shown and the computed one wins: silently
 * printing a stale level would make the star chart a claim rather than a
 * measurement.
 */
import { starChart } from "./starChart.ts";
import { unknownKindWarnings } from "./readEvidenceRows.ts";
import { describeStageLoads, type StageLoad } from "./stageCoverage.ts";
import type { ExpertRecord } from "./ExpertRecord.ts";

/** Expert name -> the stages that would load it (`stageCoverage.ts`). */
export type StageLoads = ReadonlyMap<string, readonly StageLoad[]>;

const HEADERS = ["expert", "status", "last_trained", "areas", "evidence", "levels"] as const;

/** Total evidence rows across an expert's areas — what a level is made of. */
export function evidenceCount(expert: ExpertRecord): number {
  return expert.areas.reduce((total, area) => total + area.evidence.length, 0);
}

/** `2/1/0` — every area's computed level, highest first. `—` when there are none. */
export function levelSummary(expert: ExpertRecord): string {
  if (expert.areas.length === 0) return "—";
  return [...expert.areas].map((area) => area.level).sort((a, b) => b - a).join("/");
}

export function driftWarnings(expert: ExpertRecord): readonly string[] {
  return expert.drifted.map(
    (area) =>
      `warning: ${expert.name}/${area.id} — competencies.yml stores level ${area.storedLevel}, `
      + `evidence computes ${area.level}; showing the computed level (spec §2.6). `
      + `Run \`tldrx expert recompute ${expert.name}\` to settle it.`,
  );
}

/**
 * One line per area that declared evidence nobody could count.
 *
 * Kept apart from `driftWarnings` because the two say different things: drift is
 * "the number on disk is stale", an ignored row is "this file contains data the
 * tool refused". Both must reach a human — a dropped row silently lowers a level,
 * which is the failure this whole module exists to prevent.
 */
export function evidenceWarnings(expert: ExpertRecord): readonly string[] {
  return expert.areas.flatMap((area) => unknownKindWarnings(expert.name, area.id, area.ignored));
}

export function renderExpertList(experts: readonly ExpertRecord[], loads?: StageLoads): string {
  if (experts.length === 0) {
    return [
      "No experts yet.",
      "",
      "`tldrx init` seeds them from detection; `tldrx expert create <name>` adds one by hand.",
    ].join("\n");
  }

  const rows = experts.map((expert) => [
    expert.name,
    expert.status,
    expert.lastTrained ?? "never",
    String(expert.areas.length),
    String(evidenceCount(expert)),
    levelSummary(expert),
  ]);
  const widths = HEADERS.map((header, column) =>
    rows.reduce((max, row) => Math.max(max, (row[column] ?? "").length), header.length),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();

  const out: string[] = [
    line(HEADERS),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
  ];

  for (const expert of experts) {
    out.push("", `${expert.name} — ${expert.status}`);
    // Where this expert's knowledge actually lands. An expert nobody's stage loads
    // is training nobody will ever read, and until this line existed that fact was
    // spread across five stage files and one selection rule.
    if (loads !== undefined) out.push(`  ${describeStageLoads(loads.get(expert.name))}`);
    if (expert.error !== null) {
      out.push(`  unreadable: ${expert.error}`);
      continue;
    }
    if (expert.areas.length === 0) {
      out.push("  no areas yet — `tldrx expert train` is what gives an expert evidence.");
      continue;
    }
    for (const chart of starChart(expert.areas)) out.push(`  ${chart}`);
  }

  const warnings = experts.flatMap(driftWarnings);
  if (warnings.length > 0) out.push("", ...warnings);

  return out.join("\n");
}

/** `--json`: the same data, levels already recomputed. */
export function expertListJson(experts: readonly ExpertRecord[], loads?: StageLoads): string {
  return JSON.stringify(
    experts.map((expert) => ({
      name: expert.name,
      status: expert.status,
      last_trained: expert.lastTrained,
      evidence_count: evidenceCount(expert),
      error: expert.error,
      ...(loads === undefined
        ? {}
        : { loaded_by: (loads.get(expert.name) ?? []).map((load) => ({ stage: load.stage, reason: load.reason })) }),
      areas: expert.areas.map((area) => ({
        id: area.id,
        title: area.title,
        level: area.level,
        stored_level: area.storedLevel,
        level_matches_evidence: area.storedLevel === null || area.storedLevel === area.level,
        evidence_count: area.evidence.length,
        newest_evidence: area.newestEvidence,
        train_prompt: area.trainPrompt,
      })),
    })),
    null,
    2,
  );
}
