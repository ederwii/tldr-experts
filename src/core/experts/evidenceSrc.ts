/**
 * Does an evidence row's `src` mean what its `kind` says it does?
 *
 * Until 2026-08-29 nothing checked. `readEvidenceRows` rejected an empty `src`
 * and nothing else, and `competenciesWrite` never looked at one at all — so
 * `{kind: run, src: "the tests pass"}` counted as a run, and under the wave-E
 * ladder that row alone is the difference between level 3 and level 4. A gate
 * that anything can satisfy is not a gate.
 *
 * The grammar is spec §2.8's, parsed by the same `classifySrc` the `claim-sources`
 * hook uses, so an evidence row is judged by exactly the rule a handoff bullet is.
 * Two readers of one grammar is how the two drift apart.
 *
 * `classifySrc` is called WITHOUT a repo list. This module has no workspace — a
 * reader must work on a `competencies.yml` read out of a tarball — so any slug
 * before the first `:` is taken as a repo name. That is deliberately permissive:
 * the job here is to catch a `src` that is not a citation at all, not to
 * re-resolve one against a filesystem that may not be present.
 */
import type { EvidenceKind } from "../init/competencyLevel.ts";
import { classifySrc, type SrcRef } from "../text/srcToken.ts";

/** Why a row was refused. `unknown-kind` is decided before this module is reached. */
export const IGNORED_REASONS = ["unknown-kind", "malformed-src", "kind-mismatch"] as const;
export type IgnoredReason = (typeof IGNORED_REASONS)[number];

export interface SrcProblem {
  readonly reason: Exclude<IgnoredReason, "unknown-kind">;
}

/**
 * What each kind's `src` must be, as spec §2.6's "where evidence comes from"
 * table states it. Typed as a total record so adding an evidence kind without
 * saying what its `src` looks like fails to compile.
 *
 * `run` accepts two forms, and both are the harness's own output: `codeEvidence`
 * mints `$ <cmd> → exit <n>` from a command the sub-agent executed, and
 * `runEvidence` mints `tldrx-work/<run>/<file>:<line>` from a past run's handoff
 * or retro. A strictly-cmd-only `run` class would make the framework reject rows
 * it writes itself in full mode. `test` likewise accepts a file or a command,
 * per the same table ("`repo:path:line`, or `$ cmd → exit n` for a test run").
 */
export const EXPECTED_SRC: Readonly<Record<EvidenceKind, string>> = {
  code: "'<repo>:<path>:<line>'",
  run: "'$ <cmd> → exit <n>' or 'tldrx-work/<run>/<file>:<line>'",
  test: "'<repo>:<path>:<line>' or '$ <cmd> → exit <n>'",
  doc: "'https://…'",
  answer: "'F<n>'",
};

/** Null when the row is well-formed; otherwise which of the two ways it is not. */
export function checkEvidenceSrc(kind: EvidenceKind, src: string): SrcProblem | null {
  const parsed = classifySrc(src);
  if ("message" in parsed) return { reason: "malformed-src" };
  return matchesKind(kind, parsed) ? null : { reason: "kind-mismatch" };
}

function matchesKind(kind: EvidenceKind, ref: SrcRef): boolean {
  switch (kind) {
    case "code":
      return ref.kind === "file";
    case "run":
      return ref.kind === "cmd" || isRunArtifact(ref);
    case "test":
      return ref.kind === "file" || ref.kind === "cmd";
    case "doc":
      return ref.kind === "doc";
    case "answer":
      return ref.kind === "fact";
  }
}

/** Exactly what `runEvidence` mints: a bare (repo-less) path under `tldrx-work/`. */
function isRunArtifact(ref: SrcRef): boolean {
  return ref.kind === "file" && ref.repo === null && ref.path.startsWith("tldrx-work/");
}

/** The `— …` half of a warning or a rejection, so both readers word it identically. */
export function describeSrcProblem(kind: EvidenceKind, src: string, problem: SrcProblem): string {
  return problem.reason === "malformed-src"
    ? `malformed src '${src}'`
    : `kind '${kind}' needs a ${EXPECTED_SRC[kind]} src`;
}
