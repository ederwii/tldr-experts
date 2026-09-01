/**
 * `tldrx retro --all --json` — the machine shape (#74).
 *
 * #64 shipped the aggregate as a TABLE and nothing else, so the only consumer
 * was a human's eyes and the issue's stated purpose ("feeding expert training
 * and stage prompts") had no seam to attach to. This is the seam.
 *
 * It is a deliberate PROJECTION of `AllRetro`, not `JSON.stringify(report)`.
 * Dumping the internal interface would make every future field an unannounced
 * change to a published contract, and every rename a silent break in somebody's
 * script. Written out here, adding a field is a visible act — and
 * `retro-consumers.test.ts` asserts the key sets literally, so it is an act that
 * breaks a test first.
 *
 * `version` is the shape's own, not the workspace's: a consumer reads it to know
 * whether the keys below are the keys it was written against.
 */
import type { AllRetro, MinedFinding } from "./findings.ts";

/** Bumped when a key is removed or changes meaning. Adding a key does not bump it. */
export const ALL_RETRO_JSON_VERSION = 1;

export interface AllRetroJsonExample {
  readonly run: string;
  readonly kind: string;
  readonly text: string;
  /** `[src: tldrx-work/<run>/<rel>:<line>]` — always resolvable from `root`. */
  readonly src: string;
}

export interface AllRetroJsonTrend {
  readonly cls: string;
  readonly count: number;
  /** The run ids this class was seen in, sorted. `runs.length` is its spread. */
  readonly runs: readonly string[];
  /** The first occurrence in mining order. Null is impossible for `count > 0`. */
  readonly example: AllRetroJsonExample | null;
}

export interface AllRetroJsonFinding extends AllRetroJsonExample {
  readonly cls: string;
}

export interface AllRetroJson {
  readonly version: number;
  /** Absolute path of the workspace the citations resolve against. */
  readonly root: string;
  /** Every run folder read, newest first. */
  readonly runs: readonly string[];
  /** The subset that yielded at least one finding. */
  readonly contributed: readonly string[];
  /** Lines dropped because a primary artefact already accounted for them. */
  readonly deduped: number;
  /** The effective taxonomy in precedence order, workspace extensions included. */
  readonly classes: readonly string[];
  /** Ranked by count, ties broken by the taxonomy's order. */
  readonly trends: readonly AllRetroJsonTrend[];
  /**
   * Every mined row. The table has no use for these; an expert trainer does —
   * a class that caught this team six times across four runs is a stronger
   * signal than any single retro bullet, and this is where it can read them.
   */
  readonly findings: readonly AllRetroJsonFinding[];
}

export function toAllRetroJson(report: AllRetro): AllRetroJson {
  return {
    version: ALL_RETRO_JSON_VERSION,
    root: report.root,
    runs: [...report.runs],
    contributed: [...report.contributed],
    deduped: report.deduped,
    classes: [...report.classes],
    trends: report.trends.map((trend) => ({
      cls: trend.cls,
      count: trend.count,
      runs: [...trend.runs],
      example: trend.example === null ? null : example(trend.example),
    })),
    findings: report.findings.map((finding) => ({ ...example(finding), cls: finding.cls })),
  };
}

function example(finding: MinedFinding): AllRetroJsonExample {
  return { run: finding.run, kind: finding.kind, text: finding.text, src: finding.src };
}
