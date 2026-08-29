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
 */
import { isEvidenceKind, ALLOWED_KINDS, type CompetencyEvidence, type EvidenceKind } from "../init/competencyLevel.ts";

export interface IgnoredKind {
  /** The unrecognised `kind:` value, verbatim (`""` when the key was missing). */
  readonly kind: string;
  readonly count: number;
}

export interface EvidenceRows {
  readonly evidence: readonly CompetencyEvidence[];
  /** Otherwise well-formed rows refused for an unknown `kind`, tallied in first-seen order. */
  readonly ignored: readonly IgnoredKind[];
}

export function readEvidenceRows(input: unknown): EvidenceRows {
  if (!Array.isArray(input)) return { evidence: [], ignored: [] };

  const evidence: CompetencyEvidence[] = [];
  const counts = new Map<string, number>();

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
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      continue;
    }
    evidence.push({ kind: kind as EvidenceKind, src, at });
  }

  const ignored = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  return { evidence, ignored };
}

/** One line per unknown kind, in the shape `expert list`, the dashboard and training all print. */
export function unknownKindWarnings(
  expert: string,
  area: string,
  ignored: readonly IgnoredKind[],
): readonly string[] {
  return ignored.map(
    (row) =>
      `warning: ${expert}/${area}: ${String(row.count)} evidence row(s) ignored — `
      + `unknown kind '${row.kind}' (allowed: ${ALLOWED_KINDS})`,
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
