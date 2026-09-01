/**
 * The `tldrx retro --all` table: class × count × runs it appeared in × one
 * example, with the citation that lets a reader go and check the example.
 *
 * Two lines per class rather than one very wide one. The citation is the half a
 * trends table usually loses — a count with nothing behind it is an assertion —
 * and cramming it into a column would truncate the thing it exists to make
 * checkable.
 */
import type { AllRetro, ClassTrend } from "./findings.ts";

const HEAD_CLASS = "CLASS";
const HEAD_COUNT = "COUNT";
const HEAD_RUNS = "RUNS";
const HEAD_EXAMPLE = "EXAMPLE";

/** Long enough to recognise a finding, short enough to keep the row on a line. */
const EXAMPLE_MAX = 64;

export function renderTrends(report: AllRetro): string {
  if (report.runs.length === 0) {
    return [
      "no runs found under tldrx-work/ — nothing to aggregate.",
      "Read-only: nothing was written.",
    ].join("\n");
  }
  if (report.findings.length === 0) {
    return [
      counts(report),
      "",
      "no findings to aggregate — none of those runs carried a review log, a fix list,"
      + " a retro or a reopen reason.",
      "",
      SOURCES,
    ].join("\n");
  }

  const width = Math.max(HEAD_CLASS.length, ...report.trends.map((trend) => trend.cls.length));
  const lines = [
    counts(report),
    "",
    `${HEAD_CLASS.padEnd(width)}  ${HEAD_COUNT}  ${HEAD_RUNS}  ${HEAD_EXAMPLE}`,
    `${"-".repeat(width)}  ${"-".repeat(HEAD_COUNT.length)}  ${"-".repeat(HEAD_RUNS.length)}  ${"-".repeat(HEAD_EXAMPLE.length)}`,
  ];
  const indent = " ".repeat(width + 2 + HEAD_COUNT.length + 2 + HEAD_RUNS.length + 2);
  for (const trend of report.trends) {
    lines.push(
      `${trend.cls.padEnd(width)}  ${pad(trend.count, HEAD_COUNT.length)}`
      + `  ${pad(trend.runs.length, HEAD_RUNS.length)}  ${example(trend)}`,
    );
    lines.push(`${indent}${trend.example?.src ?? ""} · seen in: ${trend.runs.join(", ")}`);
  }
  lines.push("", SOURCES);
  return lines.join("\n");
}

const SOURCES = [
  "Read-only: nothing was written. Sources per run — 04-build/log/*.md (a `changes` verdict",
  "and its findings), 04-build/fixlist/*.md (fix-now, defer-with-log and out-of-scope; a",
  "refuted finding is read and dropped), retro.md (## Build feedback, ## Practice proposals)",
  "and events.jsonl (story.reopened reasons). A repeat of the same finding within one run is",
  "collapsed; the same finding in two runs is two occurrences, which is the point.",
].join("\n");

function counts(report: AllRetro): string {
  const parts = [
    `${String(report.runs.length)} run(s) under tldrx-work/`,
    `${String(report.contributed.length)} contributed`,
    `${String(report.findings.length)} finding(s)`,
  ];
  if (report.deduped > 0) parts.push(`${String(report.deduped)} same-run repeat(s) collapsed`);
  return parts.join(" · ");
}

function example(trend: ClassTrend): string {
  const text = trend.example?.text ?? "";
  return `"${text.length <= EXAMPLE_MAX ? text : `${text.slice(0, EXAMPLE_MAX - 1)}…`}"`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width);
}
