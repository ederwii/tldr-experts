/**
 * One reader for `areas[].evidence`, shared by everything that reads a
 * `competencies.yml`.
 *
 * It exists because the two copies that used to do this both dropped a row whose
 * `kind` was not recognised and said NOTHING about it. Measured 2026-08-29 on a
 * real workspace: a training session wrote two `kind: test` rows, `expert list`
 * printed "15 evidence" over a file holding 17, and there was no message on any
 * stream to explain the missing two. A reader that silently discards data makes
 * every count downstream of it a claim rather than a measurement — so the rows it
 * refuses are tallied here and every caller reports them.
 *
 * Since 2026-08-29 it refuses two more shapes, through the same channel: a `src`
 * that is not a §2.8 citation at all, and a `src` that is a citation of the wrong
 * class for its `kind` (`{kind: run, src: "api:src/Thing.cs:1"}` — a file read,
 * filed as a command executed). Nothing checked either before, so `kind: run` —
 * the row the ladder gates levels 4 and 5 on — could be earned by typing the
 * word. See `evidenceSrc.ts` for the class table.
 */
import {
  isEvidenceConfidence, isEvidenceKind, ALLOWED_KINDS,
  type CompetencyEvidence, type EvidenceKind,
} from "../init/competencyLevel.ts";
import { checkEvidenceSrc, describeSrcProblem, type IgnoredReason } from "./evidenceSrc.ts";

export interface IgnoredRow {
  readonly reason: IgnoredReason;
  /** The row's `kind:` value, verbatim (`""` when the key was missing). */
  readonly kind: string;
  /** The row's `src:` value, verbatim. `""` for `unknown-kind`, where it is beside the point. */
  readonly src: string;
  readonly count: number;
}

export interface EvidenceRows {
  readonly evidence: readonly CompetencyEvidence[];
  /** Otherwise well-formed rows this reader refused, tallied in first-seen order. */
  readonly ignored: readonly IgnoredRow[];
}

export function readEvidenceRows(input: unknown): EvidenceRows {
  if (!Array.isArray(input)) return { evidence: [], ignored: [] };

  const evidence: CompetencyEvidence[] = [];
  const counts = new Map<string, IgnoredRow>();
  const refuse = (reason: IgnoredReason, kind: string, src: string): void => {
    // Keyed by what the message will say, so N rows with one complaint are one line.
    const key = `${reason} ${reason === "unknown-kind" ? kind : `${kind} ${src}`}`;
    const seen = counts.get(key);
    counts.set(key, seen === undefined ? { reason, kind, src, count: 1 } : { ...seen, count: seen.count + 1 });
  };

  for (const raw of input as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const kind = str(row.kind);
    const src = str(row.src);
    const at = str(row.at);
    // A row missing `src` or `at` is malformed rather than misclassified; only a
    // row that would otherwise have counted is worth telling the operator about.
    if (src === "" || at === "") continue;
    if (!isEvidenceKind(kind)) {
      refuse("unknown-kind", kind, "");
      continue;
    }
    const problem = checkEvidenceSrc(kind, src);
    if (problem !== null) {
      refuse(problem.reason, kind, src);
      continue;
    }
    // `cross`, `confidence` and `rescored_at` are ADDITIVE (§2.6): a row written
    // before they existed simply carries none of them, and an unrecognised
    // confidence value is dropped rather than refused — it changes a weight, it
    // is not a citation.
    //
    // `rescored_at` is the one field here that is NOT dropped when it fails to
    // parse: it is kept verbatim whenever it is a non-empty string. Dropping it
    // would turn a row that was scored for free into one that reads as paid for,
    // which is the dangerous direction (§7) and the exact confusion the field
    // was added to end.
    const confidence = str(row.confidence);
    const rescoredAt = str(row.rescored_at);
    evidence.push({
      kind: kind as EvidenceKind,
      src,
      at,
      ...(row.cross === true ? { cross: true } : {}),
      ...(isEvidenceConfidence(confidence) ? { confidence } : {}),
      ...(rescoredAt === "" ? {} : { rescored_at: rescoredAt }),
    });
  }

  return { evidence, ignored: [...counts.values()] };
}

/** One line per refusal, in the shape `expert list`, the dashboard and training all print. */
export function ignoredRowWarnings(
  expert: string,
  area: string,
  ignored: readonly IgnoredRow[],
): readonly string[] {
  return ignored.map(
    (row) => `warning: ${expert}/${area}: ${String(row.count)} evidence row(s) ignored — ${explain(row)}`,
  );
}

function explain(row: IgnoredRow): string {
  if (row.reason === "unknown-kind") return `unknown kind '${row.kind}' (allowed: ${ALLOWED_KINDS})`;
  return describeSrcProblem(row.kind as EvidenceKind, row.src, { reason: row.reason });
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
