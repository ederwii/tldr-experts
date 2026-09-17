/**
 * ONE derivation of "does a `Resolved:` claim about a fix-list finding check out
 * against git" (§7; #130) — shared by every caller that asks the question,
 * rather than each re-implementing `shaReachability`.
 *
 * Two callers, extracted here in the same change (#344):
 *
 *   - the Build executor's own per-story check (`executors/build.ts`, moved out
 *     unchanged): every time a story tries to settle, each `Resolved: yes …`
 *     already written on its fix list is held to git, and a claim that does not
 *     check out is rewritten `claimed-unverified` (#130).
 *   - the human gate-approval path (`run/gates.ts`'s `approve`, #344, owner
 *     decision "Sí cerrarlo"): a gate-approval NOTE that names the commit which
 *     fixes an open fix-now finding closes that finding — but only on the exact
 *     same evidence rule, never a looser one just because the claim arrived in
 *     an approval note instead of the file.
 *
 * Both a "verify what the file already claims" leaf (`verifyResolutions`) and an
 * "apply what a note claims" leaf (`closeNoted`) live here, because they are the
 * same evidence rule wearing two callers, and #7 says a derivation like that has
 * exactly one implementation.
 */
import {
  autoCloseShown, canonicalizeResolutions, markUnverified, GATE_APPROVED_MARK,
  type FixFinding, type FixlistOnDisk,
} from "./fixlist.ts";
import { shaReachability } from "./git.ts";

/** Everything the reachability check needs about ONE story — data, never a session (§12). */
export interface ResolutionScope {
  readonly repoDir: string;
  readonly branch: string;
  /** The workspace repo name, for the "not a commit in repo X" sentence. */
  readonly repo: string;
}

/**
 * Why a claimed sha does not check out, or null when it does.
 *
 * `sha === null` covers a claim that names no commit at all — the same "named no
 * commit to point at" a bare `Resolved: yes` has always read as.
 */
export async function unverifiedBecause(scope: ResolutionScope, sha: string | null): Promise<string | null> {
  if (sha === null) return "named no commit to point at";
  switch (await shaReachability(scope.repoDir, sha, scope.branch)) {
    case "reachable":
      return null;
    case "absent":
      return `named \`${sha}\`, which is not a commit in repo ${scope.repo}`;
    default:
      return `named \`${sha}\`, which is not reachable from \`${scope.branch}\``;
  }
}

export interface VerifiedResolutions {
  readonly findings: readonly FixFinding[];
  /** `#N — why`, one per claim already on the file that did not check out. */
  readonly refused: readonly { readonly n: number; readonly why: string }[];
  /** `canonicalizeResolutions`'s own report lines, unprefixed — a caller adds the story id. */
  readonly canonicalizedLines: readonly string[];
  /** The rewritten file text, or null when nothing on it changed. */
  readonly text: string | null;
}

/**
 * Hold every `Resolved: yes` already on a fix list to git.
 *
 * Text in (the caller reads the file), text out (the caller writes it): no I/O
 * here, so this stays a leaf a test can call directly against a real repo
 * without a session or an executor around it (§12).
 *
 * Deliberately one-directional, same as before the move: this can only ever
 * move a finding from closed to open; nothing here closes one, and a `no` is
 * never touched.
 */
export async function verifyResolutions(
  scope: ResolutionScope,
  fixlist: FixlistOnDisk,
  fileText: string,
): Promise<VerifiedResolutions> {
  const findings: FixFinding[] = [];
  const refused: { n: number; why: string }[] = [];
  let text: string | null = null;
  for (const finding of fixlist.findings) {
    // A claim whose sha was refused on SHAPE (#163) is downgraded here like any
    // other, with the sentence `readResolvedSha` already wrote — not a second
    // phrasing of it (§7).
    const why = finding.resolved
      ? finding.resolvedShaRefusal ?? await unverifiedBecause(scope, finding.resolvedSha)
      : null;
    if (why === null) {
      findings.push(finding);
      continue;
    }
    findings.push({ ...finding, resolved: false, resolvedSha: null, resolvedShaRefusal: null });
    refused.push({ n: finding.n, why });
    text = markUnverified(text ?? fileText, finding.n, why);
  }
  const canonicalized = await canonicalizeResolutions(scope.repoDir, findings, text ?? fileText);
  if (canonicalized.lines.length > 0) text = canonicalized.text;
  return { findings: canonicalized.findings, refused, canonicalizedLines: canonicalized.lines, text };
}

export interface NotedClosure {
  /** The rewritten file text, or null when nothing changed. */
  readonly text: string | null;
  /** Findings closed by a candidate sha reachable from the story's own branch. */
  readonly closed: readonly { readonly n: number; readonly sha: string }[];
  /** Findings whose claim did not check out against any candidate — recorded, not dropped. */
  readonly refused: readonly { readonly n: number; readonly why: string }[];
}

/**
 * Apply a human gate-approval note's candidate commit(s) to a fixlist's still
 * OPEN findings (#344).
 *
 * Every open finding is tried against every candidate, in the order the note
 * named them; the first one `unverifiedBecause` accepts closes it, through the
 * same writer a spawned fix-round reviewer's auto-close uses
 * (`autoCloseShown`, generalised here to take its own marker text rather than
 * asserting a reviewer read a prompt that, for this caller, never existed).
 * When NONE of the candidates check out for a finding, the claim is not thrown
 * away: `markUnverified` records `claimed-unverified` with the reason, exactly
 * as a file-written claim that fails the same check is downgraded — so a gate
 * approval that named a commit can never SILENTLY close a finding, and never
 * silently drops what the note said either.
 *
 * `open` is the caller's own `openFindings(fixlist.findings)` — only `fix-now`
 * findings still blocking `done` are ever candidates here; the caller decides
 * that, this function does not re-derive it (one derivation, §7).
 */
export async function closeNoted(
  scope: ResolutionScope,
  open: readonly FixFinding[],
  text: string,
  candidates: readonly string[],
  provenance: string,
): Promise<NotedClosure> {
  let body: string | null = null;
  const closed: { n: number; sha: string }[] = [];
  const refused: { n: number; why: string }[] = [];
  for (const finding of open) {
    let closedSha: string | null = null;
    let firstWhy: string | null = null;
    for (const sha of candidates) {
      const why = await unverifiedBecause(scope, sha);
      if (why === null) {
        closedSha = sha;
        break;
      }
      firstWhy ??= why;
    }
    if (closedSha !== null) {
      const result = autoCloseShown(body ?? text, [finding], closedSha, provenance, GATE_APPROVED_MARK);
      if (result.closed.length > 0) {
        body = result.text;
        closed.push({ n: finding.n, sha: closedSha });
      }
    } else if (firstWhy !== null) {
      body = markUnverified(body ?? text, finding.n, firstWhy);
      refused.push({ n: finding.n, why: firstWhy });
    }
  }
  return { text: body, closed, refused };
}
