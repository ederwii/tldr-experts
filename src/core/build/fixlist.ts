/**
 * `04-build/fixlist/<story>-<round>.md` — the third verdict's artifact (design §B.4).
 *
 * The finding this exists for was measured on 2026-08-31, driving
 * `260830-tenancy-identity-customers` by hand: the reviewer SIGNED story S5 —
 * every acceptance criterion met, zero scope violations — and in the same breath
 * surfaced three real correctness and security defects the criteria never
 * covered (a concurrent double-confirm minting two sessions, a non-atomic
 * confirm, a false security comment beside a non-constant-time compare). Binary
 * `approve`/`changes` has nowhere to put those. `approve` throws them away;
 * `changes` spends the story's one requeue on a diff nobody faulted. So the host
 * did it in chat: numbered the findings, decided fix-now vs defer-with-log for
 * each, routed them back to the author, and re-verified. Three stories went
 * through exactly that loop that night — S1, S3, S5 — and none of it reached a
 * file anything could read afterwards.
 *
 * This module is that loop as an artifact. Three rules hold it up:
 *
 *   - **The executor writes it, never the reviewer.** The reviewer holds no write
 *     tool (`REVIEWER_TOOLS`), which is the same reason `renderReviewLog` is
 *     written here rather than by the model that judged the diff.
 *   - **A disposition ROUTES a finding; `Resolved:` CLOSES it.** They are two
 *     questions — where does this go, and has it landed — and one field cannot
 *     answer both without losing the first the moment the second is true.
 *   - **`refuted` costs a citation.** A reviewer's verdict is a claim like any
 *     other, and tonight's host disproved one by grepping both sides before
 *     acting on it. A finding may only be waved away with the evidence that wave
 *     it away attached, in the §2.8 `[src: …]` grammar every other claim in this
 *     framework is held to.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../schemas/validation.ts";
import { describeSrcFailure, diagnoseSrcToken, parseSrcToken, srcRule } from "../text/srcToken.ts";
import { SRC_GRAMMAR_HEADING } from "../text/srcGrammarContract.ts";
import { canonicalSha } from "./git.ts";
import { STAGE_TUNING_DEFAULTS } from "../schemas/stageTuning.ts";

/** `04-build/fixlist/` — a sibling of `04-build/log/`, and tracked like it. */
export const FIXLIST_DIR = "fixlist";

/**
 * One fix-list round per story, and the bound is the point.
 *
 * A verdict that spends no attempt is a free round; an unbounded supply of free
 * rounds is a story that never has to settle. One is what the live loop used —
 * refuse-or-sign-with-notes, author fixes, fresh full review — and the second
 * review is a full one (`approve`/`changes`) precisely because the first already
 * had its free pass.
 */
export const MAX_FIXLIST_ROUNDS = STAGE_TUNING_DEFAULTS.fixlistRounds;

/**
 * Where a finding goes. Four, and every one of them is a DECISION somebody made
 * about the finding rather than a fact about the code:
 *
 *   `fix-now`         this story's own correctness — it blocks `done`
 *   `defer-with-log`  real, not this story's call — it reaches the owner via retro.md
 *   `refuted`         the reviewer was wrong, and here is the proof
 *   `out-of-scope`    true of the repo, not of this diff
 */
export const DISPOSITIONS = ["fix-now", "defer-with-log", "refuted", "out-of-scope"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * What a finding IS, as opposed to where it goes (#255).
 *
 * A separate axis from `Disposition` on purpose, and the measurement is the
 * reason: on 2026-09-12, three stories with a green DoD, a merged commit and an
 * approving reviewer ended `blocked` — every one of them on a `fix-now` finding
 * whose whole content was a docstring or a citation. The reviewer was not wrong
 * to raise them and was not wrong to call them this story's own: the prompt says
 * `fix-now` is "this story's own correctness", and a stale docstring in the
 * story's own files honestly reads that way. What the record could not say was
 * that the defect was TEXT. A disposition answers "where does this go"; nothing
 * answered "what is it", so a night's run stopped for a comment.
 *
 * Four, and the split is exactly where the framework's appetite for risk
 * changes: `correctness` and `security` are behaviour, and behaviour holds a
 * story; `docs` and `style` are the way the repo reads, which is worth fixing
 * and is not worth a person's night.
 */
export const FINDING_KINDS = ["correctness", "security", "docs", "style"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * The kinds that may be declared to STOP holding a story — and the ones that pay.
 *
 * Owner decision, 2026-09-13 (`authority: owner-decision`, via Slack): declaring
 * a `fix-now` finding `docs` or `style` so it stops blocking costs the SAME
 * `[src: …]` citation `refuted` already costs. One exit, one rule — unblocking
 * costs evidence, whatever it is called. The alternative was a second, free exit
 * with `refuted`'s exact effect on the gate: the wide door beside the narrow one.
 */
export const UNBLOCKING_KINDS: readonly FindingKind[] = ["docs", "style"];

export function isUnblockingKind(kind: FindingKind | null): boolean {
  return kind !== null && UNBLOCKING_KINDS.includes(kind);
}

export interface FixFinding {
  /** 1-based, and stable: the number is how a human and a prompt refer to it. */
  readonly n: number;
  /**
   * What the finding IS (#255) — or null, and ONLY from a record written before
   * this field existed.
   *
   * Null is the tolerant read (§7: `version: 1` formats only grow), not a value
   * a reviewer may produce: `parseFixFindings` refuses an envelope row with no
   * readable `kind`, while `parseFixlistFile` reads a fix list already on disk
   * with no `Kind:` line and reports what it found. The two are different
   * questions — "did the reviewer classify this" and "what does this file say" —
   * and answering the second with a refusal would make a run already in flight
   * unreadable by upgrading the tool under it.
   *
   * Null never unblocks anything: every unblocking path asks
   * `isUnblockingKind`, which is false for it.
   */
  readonly kind: FindingKind | null;
  /**
   * The disposition this finding was SUBMITTED with, when it is not the one it
   * carries now — `fix-now`, on a `docs`/`style` finding routed to
   * `defer-with-log` (#255). Null when nothing was rewritten.
   *
   * Recorded rather than performed silently, for the same reason `markUnverified`
   * writes its sentence into the file: the artifact is the state, and a state
   * that quietly disagrees with what the reviewer said is the failure mode this
   * whole change is one step away from. The finding is still in the document,
   * still in the PR body, still on `retro.md` — what changed is that it no longer
   * holds a story, and the file says who changed it.
   */
  readonly normalisedFrom: Disposition | null;
  /** Free text from the reviewer — `high`, `medium`, `low`, or its own word. */
  readonly severity: string;
  /** The heading: one line a person can act on. */
  readonly finding: string;
  /** Where in the tree, ideally ending in a `[src: …]` token. */
  readonly where: string;
  readonly disposition: Disposition;
  /** Everything else the reviewer said about it. */
  readonly detail: string;
  /** Bounds the fix: things the author must NOT do about this finding. */
  readonly doNot: readonly string[];
  /**
   * Does the file CLAIM the fix has landed? Written `no`; a human sets it.
   *
   * A claim, deliberately — not a fact. `resolvedSha` is what turns it into one,
   * and `isOpen` is where the difference is spent.
   */
  readonly resolved: boolean;
  /**
   * The commit the claim points at — `Resolved: yes <sha>` — or null for a bare
   * `Resolved: yes` that points at nothing (#130).
   *
   * Measured 2026-09-02 on run `260830-money-and-payments`: `S4-1.md` ended with
   * a bare `Resolved: yes` and a result.json describing the fix in detail, over a
   * branch that did not contain it — the worktree holding the fix had been pruned
   * before anything reached a ref (#129). The audit trail said a live defect was
   * closed. This field is the evidence half of that sentence; whether the sha is
   * really on the branch is a git question, answered by the executor.
   */
  readonly resolvedSha: string | null;
  /**
   * Why the `Resolved: yes …` line's sha token was REFUSED — or null when the
   * line carried a readable one, or carried none at all (#163).
   *
   * The distinction this field exists for: "the claim named no commit" and "the
   * claim named something that is not a sha" are different facts, and until this
   * existed they were the same null. `\b([0-9a-f]{7,40})\b` cannot match inside a
   * 41-character hex run — no interior position is a word boundary — so an
   * over-long token read as a bare `Resolved: yes`, and worse, the scan carried
   * on to whatever hex word came NEXT on the line: a `yes <41 hex> (see 9f2c1ab)`
   * resolved to `9f2c1ab`, a different commit from the one the line claims.
   *
   * Non-null keeps the finding open exactly as an unevidenced claim does
   * (`resolvedSha` stays null), and `canonicalizeResolutions` writes this sentence
   * into the file as the `claimed-unverified` reason, so the refusal is NAMED
   * rather than performed in silence.
   */
  readonly resolvedShaRefusal: string | null;
  /**
   * The commit the `Resolved:` line NAMES, whatever verdict word it carries
   * (#163, sub-fix 2) — or null when the line names none.
   *
   * `resolvedSha` answers "what closes this finding", and it is deliberately
   * null for every line that is not a plain `yes`. This answers a different
   * question — "what commit does the record point at" — and it stays readable
   * after the claim has been withdrawn: a `Resolved: claimed-unverified — named
   * \`abc…\`, which is not reachable from \`story/S3\`` still names a commit, and
   * that commit is exactly the candidate the run-level sweep has to re-check
   * against the epic tip once the LATER stories have merged.
   *
   * Read through `readResolvedSha` like every other sha in this file (§7, one
   * grammar), and only off a verdict word this file writes — a `Resolved: no` is
   * never mined for hex, because reading a sha out of prose nobody claimed would
   * invent evidence.
   *
   * Null on every record written before this field existed (§7: `version: 1`
   * formats only grow), which is the same thing it means for a `no`.
   */
  readonly claimedSha: string | null;
  /**
   * The commit a LATER story closed this finding with — `Resolved: yes-on-epic
   * <sha>` — or null (#163, sub-fix 2).
   *
   * Kept apart from `resolvedSha` on purpose, because they are not the same fact:
   * one says "the story that owns this finding fixed it", the other says "the
   * defect is gone from the epic, and somebody else's story is why". Flattening
   * them into one `Resolved: yes` is exactly what made a human narrate the
   * difference by hand at a Build gate (transcript N, 2026-09-05).
   *
   * It closes NOTHING on its own: `yes-on-epic` is not `yes`, so `resolved` is
   * false, `isOpen` still holds the story, and nothing this sweep writes changes
   * what a gate decides. Recording is the whole of it.
   */
  readonly closedOnEpicSha: string | null;
  /**
   * What the run-level sweep recorded about THIS finding — the `Swept:` line — or
   * null when no sweep has run over it (#163, sub-fix 2).
   *
   * Written for every finding the sweep examined, including the ones it closed
   * nothing over: a `Resolved: no` that has been re-checked against the epic tip
   * and a `Resolved: no` nobody ever re-checked are different facts, and until
   * this line existed they read identically — which is how `Resolved: no` came to
   * mean "correct PER STORY" to the one human who knew that, and "unfixed" to
   * everybody else. A sweep that could not be taken writes its REASON here rather
   * than staying silent (§7, absent-with-reason).
   */
  readonly swept: string | null;
}

/**
 * A finding still owed work: `fix-now`, and not closed by an EVIDENCED claim.
 *
 * The `resolvedSha !== null` half is the whole of #130 in one clause. A bare
 * `Resolved: yes` is somebody's report that a fix landed; it closes nothing,
 * because the framework that refuses an uncited claim everywhere else may not
 * make an exception for claims about itself.
 */
export function isOpen(finding: FixFinding): boolean {
  return finding.disposition === "fix-now" && !(finding.resolved && finding.resolvedSha !== null);
}

export function openFindings(findings: readonly FixFinding[]): readonly FixFinding[] {
  return findings.filter(isOpen);
}

/**
 * A finding CARRIED FORWARD: `defer-with-log`, and not closed by an evidenced claim.
 *
 * A second predicate rather than a widening of `isOpen`, and this file already
 * argues why at the top: a disposition ROUTES a finding, `Resolved:` CLOSES it,
 * and they are two questions. "Still owed" gates a story reaching `done`
 * (`isOpen`); "carried forward" does not gate anything — it is a defect the
 * story deliberately did not fix, which somebody outside the story has to own.
 * Widening `isOpen` to cover it would silently change what blocks `done`.
 *
 * The `resolvedSha !== null` half is #130's clause reused verbatim: a bare
 * `Resolved: yes` closes nothing.
 */
export function carriedFindings(findings: readonly FixFinding[]): readonly FixFinding[] {
  return findings.filter(
    (f) => f.disposition === "defer-with-log" && !(f.resolved && f.resolvedSha !== null),
  );
}

/**
 * Findings that CLAIM to be resolved and name no commit — the shape of the lie.
 *
 * Told apart from an ordinary open finding on purpose: "nobody has fixed this
 * yet" and "somebody says they fixed this and there is nothing to look at" are
 * different situations, and only the second one needs the record corrected.
 */
export function unevidencedClaims(findings: readonly FixFinding[]): readonly FixFinding[] {
  return findings.filter((f) => f.disposition === "fix-now" && f.resolved && f.resolvedSha === null);
}

/**
 * What a `Resolved:` line says when a claim was made and could not be verified.
 *
 * Not `no` — that would erase the fact that somebody reported a fix, which is
 * itself information a human needs. Not `yes` either. The third word is the
 * honest one, and it is the reason this is written back into the file at all: an
 * audit record that keeps saying `yes` after the check failed is exactly the
 * failure #130 is named after.
 */
export const CLAIMED_UNVERIFIED = "claimed-unverified";

/**
 * The words the operator line uses when a `fixlist` verdict carries NOTHING to
 * fix now and the story settles `done` on the spot (gh #295).
 *
 * A marker rather than a sentence a test greps for, for the reason every marker
 * in `outcome.ts` exists: a proxy string like a bare English word false-positives
 * on innocent prose (AGENTS.md §8), and the line and the test must not be able
 * to drift apart.
 */
export const FIXLIST_SETTLED_MARK = "every finding is routed away from `fix-now`, so the story is done without a fix round";

/**
 * The provenance words an AUTO-CLOSED `Resolved: yes <sha>` line carries after its
 * sha (gh #327, owner decision 2026-09-14, "A: ronda + auto-cierre").
 *
 * Additive on the line and read tolerantly: `RESOLVED_RE` keeps everything after
 * the sha as prose, so every reader of a fix list — `parseFixlistFile`,
 * `verifyResolutions`, the dashboard, the handoff — reads an auto-closed line
 * exactly as it reads one a person typed. A marker so a test asserts it, not a
 * sentence retyped.
 */
export const AUTO_CLOSED_MARK = "auto-closed: the fix-round reviewer approved this commit with this finding in its prompt";

// --- the envelope ----------------------------------------------------------

export interface ParsedFixlist {
  readonly findings: readonly FixFinding[];
  /** Why this is not a readable fix list. Non-empty ⇒ the verdict is refused. */
  readonly problems: readonly string[];
  /**
   * The SUBSET of `problems` that fault the envelope's FORM (gh #78, gh #79).
   *
   * Every entry here is also in `problems` — an index over the same refusals,
   * not a second list of them, so nothing downstream can report one without the
   * other. It exists because a refusal's KIND is what it costs the story: a
   * fault in how the reviewer wrote its REPORT buys a bounded free re-prompt
   * (`isFormatRejection`), a fault in the WORK costs one of the story's attempts.
   *
   * gh #78 indexed exactly one refusal here, the claim-sources citation check,
   * because that is what the evidence named. Owner decision on gh #79
   * (2026-09-01) widened it to all of them, for one mental model: FORM never
   * costs an attempt, CONTENT/WORK always does. So today every refusal
   * `parseFixFindings` can raise is in here — but that is a fact about today's
   * refusals, NOT a shortcut this may take. The index is still built one push
   * site at a time, through `refuseFormat`, so a refusal about the WORK added
   * later costs the attempt unless somebody writes down that it should not.
   * Defaulting to "costs" is the direction a mistake is recoverable in.
   *
   * Typed rather than sniffed out of the strings on purpose. The strings are
   * what gh #77 rewrote; a caller that matched on them would break the moment
   * the message improved, which is the opposite of what should happen.
   */
  readonly format: readonly string[];
}

/**
 * The envelope's `fixlist[]`, narrowed — or the reasons it is not one.
 *
 * Deliberately strict, and in one direction only: every refusal here makes the
 * verdict fall back to `changes` (`parseReview`), which is the fail-closed
 * default an unreadable review has always had. A free round is the ONE thing a
 * malformed envelope must not be able to buy, so "I could not read this" and "I
 * am not sure about this" both mean the same thing: not a fix list.
 */
export function parseFixFindings(value: unknown): ParsedFixlist {
  const problems: string[] = [];
  // The FORMAT index — see `ParsedFixlist.format`. `refuseFormat` is the ONLY
  // way into it and it always writes BOTH lists, so the index can never drift
  // from the refusals it indexes. A refusal pushed to `problems` alone is one
  // that costs the story an attempt, which is the fail-safe default for
  // anything added here later.
  const format: string[] = [];
  const refuseFormat = (said: string): void => {
    problems.push(said);
    format.push(said);
  };
  if (!Array.isArray(value)) {
    refuseFormat("`fixlist` is missing or is not an array");
    return { findings: [], problems, format };
  }
  if (value.length === 0) {
    refuseFormat("`fixlist` is empty — a fix list with no findings is an approval");
    return { findings: [], problems, format };
  }
  const findings: FixFinding[] = [];
  for (const [index, row] of (value as readonly unknown[]).entries()) {
    const at = index + 1;
    if (!isRecord(row)) {
      refuseFormat(`finding ${String(at)} is not an object`);
      continue;
    }
    const text = str(row.finding);
    if (text === "") {
      refuseFormat(`finding ${String(at)} has no \`finding\` text`);
      continue;
    }
    const disposition = row.disposition;
    if (typeof disposition !== "string" || !isDisposition(disposition)) {
      refuseFormat(
        `finding ${String(at)} has no valid \`disposition\` — one of ${DISPOSITIONS.join(", ")}`,
      );
      continue;
    }
    // What the finding IS, and there is no default (#255). Absent, unreadable or
    // a word outside the enum all land here, and all land the same way: REFUSED,
    // through `refuseFormat`, so the envelope falls back to `changes` and the
    // reviewer is re-prompted for free. Fail-closed without punishing — a
    // reviewer that forgot one field did not do bad work, it wrote a bad report,
    // and this file's whole model is that FORM never costs an attempt. Defaulting
    // instead would be the dangerous direction twice over: a missing word would
    // either invent `correctness` (blocking over nothing) or invent `docs`
    // (unblocking over nothing), and only the second one is silent.
    const kind = row.kind;
    if (typeof kind !== "string" || !isFindingKind(kind)) {
      refuseFormat(
        `finding ${String(at)} has no valid \`kind\` — one of ${FINDING_KINDS.join(", ")}. `
        + "A finding's kind is what decides whether it holds the story: `correctness` and "
        + "`security` do, `docs` and `style` do not. A reviewer that did not classify it did "
        + "not finish reviewing it, and nothing here guesses which one you meant.",
      );
      continue;
    }
    const where = str(row.where);
    const detail = str(row.detail);
    // A reviewer's verdict is a claim too. `refuted` is the one disposition that
    // contradicts the finding it is attached to, and it may only do so with the
    // §2.8 citation that contradicts it — the same grammar, the same parser.
    if (disposition === "refuted") {
      const why = citationProblem(where, detail);
      if (why !== null) {
        // One string in both lists: the free re-prompt carries #77's diagnosis
        // to the reviewer verbatim, and an operator still reads every refusal.
        refuseFormat(`finding ${String(at)} is \`refuted\` and its citation was not read — ${why}`);
        continue;
      }
    }
    // The second exit, held to the first one's price (#255, owner decision
    // 2026-09-13). A `docs` or `style` finding submitted as `fix-now` is asking
    // for `refuted`'s exact effect — this no longer holds the story — by another
    // name, so it costs what `refuted` costs: the §2.8 citation, read by the same
    // parser, refused by the same call. What the citation is FOR is the asymmetry
    // the reproduction found: "the docstring says cents, the code returns dollars"
    // is a sentence whose own words do not say which side is wrong, and calling it
    // `docs` decides a money bug is a typo. The reviewer that points at the
    // behaviour it read has done the work; the one that typed a word has not.
    let routed: Disposition = disposition;
    let normalisedFrom: Disposition | null = null;
    if (disposition === "fix-now" && isUnblockingKind(kind)) {
      const why = citationProblem(where, detail);
      if (why !== null) {
        refuseFormat(
          `finding ${String(at)} is \`fix-now\` and \`kind: ${kind}\`, which asks for it to stop `
          + `holding the story — and its citation was not read — ${why} Cite the behaviour that `
          + "makes it harmless (the code that is already correct, so that only the text is "
          + "wrong), or leave it `fix-now` as `correctness`.",
        );
        continue;
      }
      routed = "defer-with-log";
      normalisedFrom = "fix-now";
    }
    findings.push({
      n: typeof row.n === "number" && Number.isInteger(row.n) && row.n > 0 ? row.n : at,
      kind,
      normalisedFrom,
      severity: str(row.severity) === "" ? "unrated" : str(row.severity),
      finding: text,
      where,
      disposition: routed,
      detail,
      doNot: Array.isArray(row.do_not)
        ? (row.do_not as readonly unknown[]).map(str).filter((line) => line !== "")
        : [],
      resolved: false,
      resolvedSha: null,
      resolvedShaRefusal: null,
      claimedSha: null,
      closedOnEpicSha: null,
      swept: null,
    });
  }
  if (findings.length === 0 && problems.length === 0) {
    refuseFormat("`fixlist` yielded no readable findings");
  }
  return { findings, problems, format };
}

function isDisposition(value: string): value is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(value);
}

function isFindingKind(value: string): value is FindingKind {
  return (FINDING_KINDS as readonly string[]).includes(value);
}

/**
 * Why the refutation's citation was not read — or null when one WAS (gh #77).
 *
 * The old boolean produced the message the issue is named after: "`refuted` with
 * no `[src: …]`", printed at a reviewer that had written one. It had written it
 * mid-sentence, or with a `]` in it, or with `->` for `→` — three different
 * mistakes, one message, none of them stated. Three story attempts went on
 * guessing which.
 *
 * The candidates are the same ones the old check read — `where`, and each LINE of
 * `detail`, because the token is anchored to end-of-line. The first candidate
 * that attempted a citation is the one diagnosed: a reviewer that wrote one
 * malformed token and no good one is told about the token it wrote, not told it
 * wrote none.
 */
function citationProblem(where: string, detail: string): string | null {
  return firstCitationProblem(
    [where, ...detail.split("\n")],
    "a refutation is a claim, and it carries its evidence or it is not one: `where`, or one "
    + "LINE of `detail`, must END with a `[src: …]` token that parses. "
    + `Write e.g. \`${srcRule("file-shape").good}\` — the full grammar is under `
    + `"${SRC_GRAMMAR_HEADING}" in your prompt.`,
  );
}

/**
 * Does any candidate LINE end with a `[src: …]` token that parses? Null when one
 * does; otherwise #77's diagnosis of the first token that was attempted, or
 * `missing` when none was.
 *
 * Exported for #326, which holds a `changes` verdict to the same evidence rule a
 * refutation already paid: one reading of "carries a citation", not two (§7).
 */
export function firstCitationProblem(lines: readonly string[], missing: string): string | null {
  const candidates = lines.map((line) => line.trim());
  for (const candidate of candidates) {
    const token = parseSrcToken(candidate);
    if (token !== null && token.errors.length === 0 && token.refs.length > 0) return null;
  }
  for (const candidate of candidates) {
    const failure = diagnoseSrcToken(candidate);
    if (failure !== null) return describeSrcFailure(failure);
  }
  return missing;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// --- the artifact ----------------------------------------------------------

export interface FixlistParts {
  readonly storyId: string;
  readonly title: string;
  readonly round: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The exact command that produced the diff the reviewer judged. */
  readonly diff: string;
  readonly commit: string;
  readonly summary: string;
  readonly findings: readonly FixFinding[];
}

/**
 * The document. Line 1 is the heading, which is what a story's `evidence:` cites
 * — the same contract `04-build/log/<id>.md` has.
 *
 * The preamble is addressed to the HOST, not to the author, and that is the
 * design: §B.2's third role is the one that routes a fix list, and it is the only
 * one of the three that can write in the run tree. A developer works in a story
 * worktree of another repo and is told in its own prompt that the worktree is the
 * only tree it may write in.
 */
export function renderFixlist(parts: FixlistParts): string {
  const lines = [
    `# Fix list — ${parts.storyId} · ${parts.title}, round ${String(parts.round)}`,
    "",
    "- Reviewer verdict: **fixlist** (signed, with findings the acceptance criteria did not cover)",
    `- Attempt: ${String(parts.attempt)} of ${String(parts.maxAttempts)} · `
      + `round ${String(parts.round)} of ${String(MAX_FIXLIST_ROUNDS)}`,
    `- Diff reviewed: \`${parts.diff}\``,
    `- Commit: ${parts.commit}`,
    ...(parts.summary.trim() === "" ? [] : [`- Reviewer summary: ${oneLine(parts.summary)}`]),
    "",
    "> This round cost the story no attempt, and there is not a second one: the next review",
    "> is a full one, `approve` or `changes`.",
    ">",
    "> **A `fix-now` finding keeps this story out of `done`.** Close it when the fix lands by",
    "> writing `Resolved: yes <sha>` — the commit the fix landed as, on the STORY branch —",
    "> or route it elsewhere by changing its `Disposition:`: `defer-with-log` (it reaches the",
    "> owner through `retro.md`), `out-of-scope`, or `refuted`, which must carry an `[src: …]`",
    "> proving the finding wrong.",
    ">",
    "> `Kind:` is what a finding IS, and it is why some of these are not `fix-now`: `correctness`",
    "> and `security` hold the story, `docs` and `style` do not. A finding the reviewer submitted",
    "> as `fix-now` and classified `docs` or `style` was routed to `defer-with-log` here, with a",
    "> `Normalised-from:` line saying so and the citation that bought it — it is still a defect",
    "> somebody owns. `Kind: (not stated)` is a record written before this field existed; it",
    "> holds the story like anything else unclassified.",
    ">",
    "> A bare `Resolved: yes` closes nothing. The sha is checked — it must be a commit in the",
    "> repo and reachable from the story branch — and a claim that does not check out is",
    `> rewritten here as \`Resolved: ${CLAIMED_UNVERIFIED}\`, with the reason. This record is`,
    "> held to the same standard as every other claim the framework makes.",
    "",
  ];
  for (const finding of parts.findings) {
    lines.push(
      `## ${String(finding.n)} · ${finding.finding}  [${finding.severity}]`,
      "",
      `Where: ${finding.where === "" ? "(not stated)" : finding.where}`,
      `Kind: ${finding.kind ?? "(not stated)"}`,
      `Disposition: **${finding.disposition}**`,
      ...(finding.normalisedFrom === null
        ? []
        // Said in the document, not only in the code that did it. A normalisation
        // the record does not mention is a gate that changed its mind in private.
        : [
          `Normalised-from: ${finding.normalisedFrom} — the reviewer submitted this as `
          + `\`${finding.normalisedFrom}\` and classified it \`${finding.kind ?? "?"}\`, which does `
          + "not hold a story; it is routed here with its citation and keeps its place in the record",
        ]),
      `Resolved: ${resolvedLine(finding)}`,
      // Only when a sweep has actually said something about this finding. A fresh
      // fix list — the only kind this function is ever handed — carries none, so
      // nothing this renderer writes changed shape (#163, sub-fix 2).
      ...(finding.swept === null ? [] : [`Swept: ${finding.swept}`]),
      "",
    );
    if (finding.detail !== "") lines.push(finding.detail, "");
    for (const line of finding.doNot) lines.push(`Do NOT: ${line}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * `no`, `yes <sha>`, or a bare `yes` for a claim that came in without one.
 *
 * The bare form is rendered rather than corrected on purpose: this function's
 * job is to write down what the finding says, and `isOpen` is what decides that
 * it does not close anything.
 */
function resolvedLine(finding: FixFinding): string {
  // An epic-level close is written down as what it IS, never as `yes` and never
  // as `no` (#163, sub-fix 2). It is asked FIRST because it is the one state a
  // `resolved: false` finding can be in that `no` would misreport.
  if (finding.closedOnEpicSha !== null) return `${CLOSED_ON_EPIC} ${finding.closedOnEpicSha}`;
  if (!finding.resolved) return "no";
  return finding.resolvedSha === null ? "yes" : `yes ${finding.resolvedSha}`;
}

const HEADING_RE = /^##\s+(\d{1,4})\s+·\s+(.+?)(?:\s+\[([^\]]*)\])?\s*$/;
const WHERE_RE = /^Where:\s*(.*)$/;
/**
 * `Kind:` — absent from every fix list written before #255, and that is the
 * tolerant read §7 requires: a run in flight when the tool was upgraded has files
 * on disk with no such line, and they stay readable. A line this cannot narrow to
 * the enum reads as "not stated" (null), which unblocks nothing.
 */
const KIND_RE = /^Kind:\s*(.*)$/;
const NORMALISED_RE = /^Normalised-from:\s*([a-z-]+)\s*(?:—.*)?$/;
const DISPOSITION_RE = /^Disposition:\s*\*\*([a-z-]+)\*\*\s*(?:—\s*(.*))?$/;
const RESOLVED_RE = /^Resolved:\s*(\S+)\s*(.*)$/;
/**
 * What the run-level sweep wrote about this finding, verbatim (#163, sub-fix 2).
 *
 * A line of its own rather than prose on the `Resolved:` line, for the reason
 * `Normalised-from:` is a line of its own: the two say different things, a reader
 * has to be able to tell them apart, and a `Resolved:` line that grew a second
 * clause would be one the existing `RESOLVED_RE` tail silently absorbs.
 *
 * Absent from every fix list written before this existed, and `swept: null` is
 * that tolerant read (§7). The parser must consume it explicitly: an unrecognised
 * line falls into the finding's `detail`, and a sweep sentence appearing inside a
 * developer's instructions would be the record leaking into the work.
 */
const SWEPT_RE = /^Swept:\s*(.*)$/;
/**
 * The third and fourth verdict words a `Resolved:` line may carry — the two ways
 * a claim ends up NOT being a plain `yes`.
 *
 * `CLOSED_ON_EPIC` is the sweep's spelling for "a LATER story closed this", and
 * it is deliberately not `yes`: `parseFixlistFile` narrows `resolved` to the
 * literal `yes`, so an epic-level close leaves `isOpen` exactly as it found it.
 * The sweep RECORDS; it does not decide what a gate decides.
 */
export const CLOSED_ON_EPIC = "yes-on-epic";
/**
 * The verdict words whose line may NAME a commit — `claimedSha`'s domain.
 *
 * A `Resolved: no` is not among them: nothing was claimed, so hex on that line is
 * prose, and mining it would invent evidence for a claim nobody made. Same rule
 * the `resolvedSha` read has always obeyed, one list for both.
 */
const CLAIMING_VERDICTS: ReadonlySet<string> = new Set(["yes", CLAIMED_UNVERIFIED, CLOSED_ON_EPIC]);
/** git's own abbreviation floor: fewer hex characters is not a sha to look up. */
export const SHA_ABBREV_MIN = 7;
/** A git object id. Anything longer is not one, however it was produced. */
export const SHA_FULL_LEN = 40;

/**
 * Every standalone hex run on a line — the candidates, before any rule is applied.
 *
 * `(?<!\w)…(?!\w)` is `\b` written so it cannot silently mean "somewhere in the
 * middle": the old `\b([0-9a-f]{7,40})\b` had NO match inside a 41-character run,
 * because no interior position of a word is a boundary, and that is exactly how an
 * over-long token became invisible. Here an over-long run is still a run — it is
 * seen, and then refused by name.
 */
const HEX_RUN_RE = /(?<!\w)[0-9a-fA-F]+(?!\w)/g;
export interface ResolvedShaRead {
  /** The accepted token, lowercased — 7 to 40 hex — or null. */
  readonly sha: string | null;
  /** Where it starts in the text this read, or -1 when nothing was accepted. */
  readonly index: number;
  /** Its length in that text, so a rewriter replaces the token and nothing else. */
  readonly length: number;
  /** Why a token was refused, or null. See `FixFinding.resolvedShaRefusal`. */
  readonly refusal: string | null;
}

/**
 * THE reading of a `Resolved: yes …` line's tail (#163) — one grammar, three
 * answers, and every reader of a fix-list sha goes through it.
 *
 * Deliberately loose about what surrounds the token — `yes 9f2c1ab`,
 * `yes (9f2c1ab)`, `yes — commit 9f2c1ab` all read the same — and strict about
 * the token itself:
 *
 *   - **7 to 39** is an abbreviation, ACCEPTED. Demanding 40 at parse time would
 *     refuse the `yes 9f2c1ab` a person legitimately types; the record is made
 *     exact AFTER the verification instead (`canonicalizeResolutions`), which is
 *     strictly stronger and refuses nobody.
 *   - **40** is the object id itself.
 *   - **41 or more** is REFUSED BY NAME. It cannot be an abbreviation of anything
 *     and it is not an object id, so there is no reading of it that is not a
 *     guess — and the guess this used to make was the dangerous one: the token
 *     vanished from the match, the line read as a bare `Resolved: yes`, and the
 *     scan carried on to the next hex word, closing the finding over a DIFFERENT
 *     commit than the one the line claims.
 *
 * A refusal is a property of the LINE, not of the first token on it: any
 * over-long run anywhere refuses the whole read, so the answer cannot depend on
 * which side of the bad token a good one happens to sit.
 *
 * Runs SHORTER than the floor are skipped rather than refused — a `Resolved: yes,
 * see the abc note` says nothing about a sha, and three hex-looking characters in
 * prose are prose.
 */
export function readResolvedSha(rest: string): ResolvedShaRead {
  const runs = [...rest.matchAll(HEX_RUN_RE)];
  const overLong = runs.find((run) => run[0].length > SHA_FULL_LEN);
  if (overLong !== undefined) {
    return {
      sha: null,
      index: -1,
      length: 0,
      refusal:
        `named \`${overLong[0]}\` — ${String(overLong[0].length)} hex characters, and a git object `
        + `id is ${String(SHA_FULL_LEN)} (an abbreviation, ${String(SHA_ABBREV_MIN)} to `
        + `${String(SHA_FULL_LEN - 1)}, is read as one). Nothing here guesses which of them you `
        + "meant, and a token this long is not read as \"no sha\"",
    };
  }
  const hit = runs.find((run) => run[0].length >= SHA_ABBREV_MIN);
  if (hit === undefined || hit.index === undefined) {
    return { sha: null, index: -1, length: 0, refusal: null };
  }
  return { sha: hit[0].toLowerCase(), index: hit.index, length: hit[0].length, refusal: null };
}

const DO_NOT_RE = /^Do NOT:\s*(.*)$/;
const STORY_RE = /^#\s+Fix list\s+—\s+(\S+)\s+·/;

/**
 * One numbered heading the parse could not read back as a finding (gh #218,
 * correctness half) — its `Disposition:` line was missing, or present but not
 * one of the four recognised words (a typo: `**fix-noww**`).
 *
 * `parseFixlistFile` drops these SILENTLY by design (see its own doc: a
 * heading with no readable disposition is not a finding, and inventing
 * `fix-now` for it would block a story over a typo). That is the right answer
 * for RENDERING — there is nothing to act on — and the wrong answer for
 * deriving "is this round SPENT": a live defect that vanished from the count
 * because of a typo is not a defect anybody dispositioned away, and
 * `openFindings(...).length === 0` cannot tell the two apart on its own
 * (AGENTS.md §7 — a value nothing derived is named, never defaulted to zero).
 * This is that name.
 */
export interface UnreadableFinding {
  readonly n: number;
  readonly finding: string;
  readonly reason: string;
}

interface FixlistParse {
  readonly findings: readonly FixFinding[];
  readonly unreadable: readonly UnreadableFinding[];
}

/**
 * The one parse both `parseFixlistFile` (findings only, the long-standing
 * public shape) and `unreadableFindings`/`fixlistFullyParsed` (the parse's own
 * account of what it could not read, gh #218) are thin views over — ONE
 * derivation for a file that both a renderer and a settle-time gate must read
 * (§7, "one implementation per derivation").
 */
function parseFixlistDocument(text: string): FixlistParse {
  const findings: FixFinding[] = [];
  const unreadable: UnreadableFinding[] = [];
  let current: {
    n: number; finding: string; severity: string; kind: FindingKind | null;
    normalisedFrom: Disposition | null;
    where: string; disposition: Disposition | null; rawDisposition: string | null;
    resolved: boolean; resolvedSha: string | null;
    resolvedShaRefusal: string | null;
    claimedSha: string | null; closedOnEpicSha: string | null; swept: string | null;
    detail: string[]; doNot: string[];
  } | null = null;
  const flush = (): void => {
    if (current === null) return;
    if (current.disposition === null) {
      unreadable.push({
        n: current.n,
        finding: current.finding,
        reason: current.rawDisposition === null
          ? "no `Disposition:` line"
          : `\`Disposition: **${current.rawDisposition}**\` is not one of ${DISPOSITIONS.join(", ")}`,
      });
      return;
    }
    findings.push({
      n: current.n,
      kind: current.kind,
      normalisedFrom: current.normalisedFrom,
      severity: current.severity,
      finding: current.finding,
      where: current.where,
      disposition: current.disposition,
      detail: current.detail.join("\n").trim(),
      doNot: current.doNot,
      resolved: current.resolved,
      resolvedSha: current.resolvedSha,
      resolvedShaRefusal: current.resolvedShaRefusal,
      claimedSha: current.claimedSha,
      closedOnEpicSha: current.closedOnEpicSha,
      swept: current.swept,
    });
  };
  for (const line of text.split("\n")) {
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      flush();
      current = {
        n: Number(heading[1] ?? "0"),
        finding: (heading[2] ?? "").trim(),
        severity: (heading[3] ?? "unrated").trim(),
        kind: null, normalisedFrom: null,
        where: "", disposition: null, rawDisposition: null,
        resolved: false, resolvedSha: null, resolvedShaRefusal: null,
        claimedSha: null, closedOnEpicSha: null, swept: null,
        detail: [], doNot: [],
      };
      continue;
    }
    if (current === null) continue;
    const where = WHERE_RE.exec(line);
    if (where !== null) {
      const value = (where[1] ?? "").trim();
      current.where = value === "(not stated)" ? "" : value;
      continue;
    }
    const kind = KIND_RE.exec(line);
    if (kind !== null) {
      const value = (kind[1] ?? "").trim();
      // Narrowed or dropped, never kept as prose. A word this does not recognise
      // is "not stated", and "not stated" holds the story — the direction a
      // mistake is recoverable in.
      if (isFindingKind(value)) current.kind = value;
      continue;
    }
    const normalised = NORMALISED_RE.exec(line);
    if (normalised !== null) {
      const value = normalised[1] ?? "";
      if (isDisposition(value)) current.normalisedFrom = value;
      continue;
    }
    const disposition = DISPOSITION_RE.exec(line);
    if (disposition !== null) {
      const value = disposition[1] ?? "";
      current.rawDisposition = value;
      if (isDisposition(value)) current.disposition = value;
      continue;
    }
    const resolved = RESOLVED_RE.exec(line);
    if (resolved !== null) {
      const verdict = (resolved[1] ?? "").toLowerCase();
      current.resolved = verdict === "yes";
      // Only a CLAIMING verdict may carry a sha. A `no` line with a hex word in it
      // is prose, and reading a sha out of it would invent evidence for a claim
      // nobody made — which is also why a `no` can carry no refusal: nothing was
      // claimed. One read for all three claiming words (§7): `claimedSha` is what
      // the line points at, `resolvedSha` is what CLOSES it, and only a plain
      // `yes` ever does that.
      const read = CLAIMING_VERDICTS.has(verdict) ? readResolvedSha(resolved[2] ?? "") : null;
      current.claimedSha = read?.sha ?? null;
      current.resolvedSha = current.resolved ? read?.sha ?? null : null;
      current.resolvedShaRefusal = current.resolved ? read?.refusal ?? null : null;
      current.closedOnEpicSha = verdict === CLOSED_ON_EPIC ? read?.sha ?? null : null;
      continue;
    }
    const swept = SWEPT_RE.exec(line);
    if (swept !== null) {
      const value = (swept[1] ?? "").trim();
      current.swept = value === "" ? null : value;
      continue;
    }
    const doNot = DO_NOT_RE.exec(line);
    if (doNot !== null) {
      const value = (doNot[1] ?? "").trim();
      if (value !== "") current.doNot.push(value);
      continue;
    }
    if (line.startsWith("> ") || line === ">") continue;
    current.detail.push(line);
  }
  flush();
  // No numbered heading read at all — not even an unreadable one. A round file
  // is only ever written with at least one finding (`writeFixlistFor` renders
  // the reviewer's own list, never an empty one), so a round that parses to
  // NOTHING — including a fully empty file — is not "a round with zero
  // findings"; it is a file that could not be read as a fix list at all:
  // empty, truncated mid-write, or overwritten. Named here, once, rather than
  // inferred later from a bare `findings: []` (gh #218, measured: an emptied
  // round file read back as "nothing open" and settled the story `done`).
  if (findings.length === 0 && unreadable.length === 0) {
    unreadable.push({
      n: 0,
      finding: "(the file itself)",
      reason: "no numbered `## N · <finding>` heading could be read — the file may be truncated or corrupted",
    });
  }
  return { findings, unreadable };
}

/**
 * Read the artifact back — the half that makes the block possible.
 *
 * The file is EDITABLE by design: a host closes a finding by writing one word in
 * it, so the settle-time question ("is anything still open?") has to be asked of
 * the file on disk rather than of the envelope that produced it. Anything this
 * cannot parse is skipped rather than guessed at; a heading with no readable
 * disposition is not a finding, and inventing `fix-now` for it would block a
 * story over a typo. See `unreadableFindings`/`fixlistFullyParsed` for what this
 * silence drops — a settle-time reader must consult one of those before reading
 * a `findings` list with nothing `fix-now` in it as "this round is spent".
 *
 * gh #269 — this validates SHAPE only, never a `[src: …]` citation: a hand edit
 * pays none of the cost `parseFixFindings` (the envelope door) charges `refuted`
 * or an unblocking `docs`/`style` finding — a documented escape hatch, not an
 * oversight (docs/spec.md, the fix-list section, "the on-disk door").
 */
export function parseFixlistFile(text: string): readonly FixFinding[] {
  return parseFixlistDocument(text).findings;
}

/** Every heading `parseFixlistFile` had to drop from `text` — see `UnreadableFinding`. */
export function unreadableFindings(text: string): readonly UnreadableFinding[] {
  return parseFixlistDocument(text).unreadable;
}

/**
 * Whether `text` parsed CLEANLY — no heading dropped, and at least one heading
 * read at all. `false` means `parseFixlistFile`'s `findings` cannot be trusted
 * as the whole story; a settle-time gate must hold rather than read a low or
 * zero open count as "nothing left to fix" (gh #218).
 */
export function fixlistFullyParsed(text: string): boolean {
  return parseFixlistDocument(text).unreadable.length === 0;
}

/** The story a fix-list file is about, from its own heading. */
export function fixlistStory(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = STORY_RE.exec(line);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/**
 * Rewrite finding `n`'s `Resolved:` line to say the claim did not check out (#130).
 *
 * The file is the state — a host closes a finding by writing one word in it — so
 * correcting the state means correcting the file. Everything else about the
 * finding is left exactly as it was: the disposition still routes it, the detail
 * still describes it, and the next read sees an OPEN `fix-now` because
 * `claimed-unverified` is not `yes`.
 *
 * Text in, text out, no I/O: the caller owns the file, and this owns the sentence.
 */
export function markUnverified(text: string, n: number, why: string): string {
  let at: number | null = null;
  return text.split("\n").map((line) => {
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      at = Number(heading[1] ?? "0");
      return line;
    }
    if (at !== n || !RESOLVED_RE.test(line)) return line;
    return `Resolved: ${CLAIMED_UNVERIFIED} — ${why}`;
  }).join("\n");
}

/** What the run-level sweep leaves on ONE finding (#163, sub-fix 2). */
export interface SweepMark {
  /**
   * The whole value of the `Resolved:` line, or null to leave that line exactly
   * as it is.
   *
   * Null is the common case by a wide margin: most findings a sweep examines are
   * not closed by anybody, and the sweep's only output for them is the sentence
   * below. A non-null value is only ever `yes-on-epic <sha> — …`, which is the
   * one rewrite this whole path may make.
   */
  readonly resolved: string | null;
  /**
   * The `Swept:` sentence — never null, never blank. A finding the sweep LOOKED
   * at and could not close still says so; that is the difference between a record
   * that was checked and one nobody checked, and it is the whole reason this line
   * exists.
   */
  readonly swept: string;
}

/**
 * Write one finding's sweep result into the TEXT of a fix list (#163, sub-fix 2).
 *
 * A sibling of `markUnverified` and `canonicalizeResolvedSha`, and it obeys their
 * rule: text in, text out, no I/O, one finding, and every other byte of the file
 * untouched. It differs from both in that it may ADD a line — the `Swept:` a file
 * written before this existed does not have — and it adds it immediately after
 * the `Resolved:` line so the two facts about a close sit together. An existing
 * `Swept:` line is REPLACED, never appended beside, so a second sweep leaves one
 * sentence rather than a growing pile.
 *
 * A finding with no `Resolved:` line at all is left completely alone: it is not a
 * finding this file's own writer produced, and inventing the two lines for it
 * would be the record asserting a shape it never read.
 */
export function markSwept(text: string, n: number, mark: SweepMark): string {
  let at: number | null = null;
  let wrote = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      at = Number(heading[1] ?? "0");
      out.push(line);
      continue;
    }
    if (at !== n) {
      out.push(line);
      continue;
    }
    // A stale `Swept:` from an earlier pass is dropped here and rewritten below,
    // beside the `Resolved:` line it describes.
    if (SWEPT_RE.test(line)) continue;
    if (!RESOLVED_RE.test(line) || wrote) {
      out.push(line);
      continue;
    }
    wrote = true;
    out.push(mark.resolved === null ? line : `Resolved: ${mark.resolved}`);
    out.push(`Swept: ${mark.swept}`);
  }
  return out.join("\n");
}

/**
 * Close, in the TEXT of a fix list, every finding a fix-round reviewer was SHOWN
 * and then approved over (gh #327, owner decision "A: ronda + auto-cierre").
 *
 * Audited in the direction §7 cares about: a finding is closed only when it is
 * STILL open in the file as it reads now AND it was rendered into that reviewer's
 * prompt — same number, same heading. A finding written after the prompt, one a
 * person re-numbered or re-worded, or one whose `Resolved:` line is missing, is
 * left exactly as it is, so it still holds the story. The line written is the
 * existing grammar, `Resolved: yes <sha>`, with the provenance after it as prose
 * `RESOLVED_RE` already tolerates — and `verifyResolutions` reads it like any
 * other claim, so a sha that does not check out is reopened as
 * `claimed-unverified` on the very next read.
 *
 * Text in, text out, no I/O: the caller owns the file.
 */
export function autoCloseShown(
  text: string,
  shown: readonly FixFinding[],
  sha: string,
  provenance: string,
): { text: string; closed: readonly number[] } {
  const current = parseFixlistFile(text);
  const closable = new Set(
    current
      .filter((f) => isOpen(f) && shown.some((s) => s.n === f.n && s.finding === f.finding))
      .map((f) => f.n),
  );
  const closed = new Set<number>();
  let at: number | null = null;
  const body = text.split("\n").map((line) => {
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      at = Number(heading[1] ?? "0");
      return line;
    }
    if (at === null || !closable.has(at) || closed.has(at) || !RESOLVED_RE.test(line)) return line;
    closed.add(at);
    return `Resolved: yes ${sha} — ${AUTO_CLOSED_MARK} (${provenance})`;
  }).join("\n");
  return { text: body, closed: [...closed].sort((a, b) => a - b) };
}

/**
 * Rewrite finding `n`'s `Resolved: yes …` line so its sha names the FULL 40-hex
 * object id, touching nothing else the line says.
 *
 * The 7-40 grammar stays: demanding 40 at parse time would refuse the `yes
 * 9f2c1ab` a person legitimately types. What that grammar cannot tell apart is a
 * deliberate abbreviation and a sha that lost a character in transit — a 39-hex
 * string resolves in git exactly as happily as a 7-hex one, and the record then
 * keeps a spelling no later reader can check against anything. Canonicalising
 * AFTER the verification is strictly stronger and refuses nobody.
 *
 * Only the sha TOKEN is replaced — `yes (9f2c1ab)` becomes `yes (<40hex>)`, `yes
 * — commit 9f2c1ab` becomes `yes — commit <40hex>` — so whatever prose the
 * grammar tolerates around it survives untouched.
 *
 * A sibling of `markUnverified`, and deliberately its mirror image: that one can
 * only move a finding from closed to open, this one changes nothing but the
 * sha's spelling. Text in, text out, no I/O — the caller owns the file, this
 * owns the line.
 */
export function canonicalizeResolvedSha(text: string, n: number, sha: string): string {
  let at: number | null = null;
  return text.split("\n").map((line) => {
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      at = Number(heading[1] ?? "0");
      return line;
    }
    if (at !== n) return line;
    const resolved = RESOLVED_RE.exec(line);
    // Only a `yes` may carry a sha, so only a `yes` is rewritten. A `no` line
    // with a hex word in it is prose.
    if (resolved === null || (resolved[1] ?? "").toLowerCase() !== "yes") return line;
    const rest = resolved[2] ?? "";
    // The same grammar the parser read, so the token this replaces and the token
    // that was verified can never be two different spans (§7: one implementation
    // per derivation). It reports the span in `rest`'s ORIGINAL casing, which is
    // the only text whose offsets line up with the line being rewritten.
    const read = readResolvedSha(rest);
    if (read.sha === null) return line;
    // `rest` is `(.*)$` in `RESOLVED_RE` — it is always the line's own tail, so
    // its start position in `line` is exact without a second search.
    const start = line.length - rest.length + read.index;
    return `${line.slice(0, start)}${sha}${line.slice(start + read.length)}`;
  }).join("\n");
}

/**
 * Make every `Resolved: yes` claim's RECORD checkable, not only the claim itself
 * (#130 follow-up, measured 2026-09-06: `RESOLVED_SHA_RE` accepts 7-40 hex, so a
 * 39-character sha reads as an abbreviation, `git rev-parse` resolves it exactly
 * as happily as a real one, and the record kept the truncated form — a sha a
 * later reader cannot tell from a deliberate prefix of a DIFFERENT commit).
 *
 * Walks the SURVIVORS of verification — a finding still `resolved` with a
 * non-null `resolvedSha` — and for each whose sha git resolves to something
 * OTHER than what is already written, rewrites both the in-memory finding and
 * the text to the full object id. A finding that failed verification arrives
 * here with `resolvedSha: null` already, so it is left alone; a finding whose
 * sha already IS the 40-hex object id costs one `rev-parse` and changes
 * nothing — which is what makes a second run idempotent.
 *
 * The git resolution and the "did anything change" conditional both live HERE,
 * not at the call site: the caller (`verifyResolutions`) makes one call and
 * routes the three things back — the possibly-rewritten findings, the
 * possibly-rewritten text, and the report lines to say what happened.
 *
 * The OTHER edge of the same grammar — a token of 41+ hex characters, which
 * `readResolvedSha` refuses by name (#163) — is deliberately NOT handled here.
 * That is a DOWNGRADE, and `verifyResolutions` is the one place a claim is ever
 * withdrawn (`markUnverified`, one direction only); a second site that could also
 * withdraw one is the duplicate §7 refuses. A refused finding arrives here with
 * `resolvedSha: null` already, so this walks past it like any other open finding.
 */
export async function canonicalizeResolutions(
  repoDir: string,
  findings: readonly FixFinding[],
  text: string,
): Promise<{ findings: readonly FixFinding[]; text: string; lines: readonly string[] }> {
  const out: FixFinding[] = [];
  const rewrites: string[] = [];
  let body = text;
  for (const finding of findings) {
    if (!finding.resolved || finding.resolvedSha === null) {
      out.push(finding);
      continue;
    }
    const full = await canonicalSha(repoDir, finding.resolvedSha);
    if (full === null || full === finding.resolvedSha) {
      out.push(finding);
      continue;
    }
    out.push({ ...finding, resolvedSha: full });
    body = canonicalizeResolvedSha(body, finding.n, full);
    rewrites.push(
      `fix-list finding #${String(finding.n)} named \`${finding.resolvedSha}\` — `
      + `rewritten to the full object id \`${full}\`, so the record names one commit and not a prefix`,
    );
  }
  return { findings: out, text: body, lines: rewrites };
}

// --- where it lives --------------------------------------------------------

export function fixlistRel(phaseDir: string, storyId: string, round: number): string {
  return `${phaseDir}/${FIXLIST_DIR}/${storyId}-${String(round)}.md`;
}

export function fixlistDir(runDir: string, phaseDir: string): string {
  return join(runDir, phaseDir, FIXLIST_DIR);
}

export function writeFixlist(runDir: string, phaseDir: string, parts: FixlistParts): string {
  const dir = fixlistDir(runDir, phaseDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${parts.storyId}-${String(parts.round)}.md`), renderFixlist(parts), "utf8");
  return fixlistRel(phaseDir, parts.storyId, parts.round);
}

export interface FixlistOnDisk {
  readonly round: number;
  readonly path: string;
  readonly rel: string;
  readonly findings: readonly FixFinding[];
  /**
   * What this round's parse could not read back as a finding (gh #218) — empty
   * when the file parsed cleanly. Every reader that decides "is this round
   * SPENT" off `openFindings(findings).length === 0` must check this is ALSO
   * empty first: `findings` silently omits a dropped heading, so a zero count
   * here can mean either "everything is closed or routed away" or "the parse
   * lost a live defect" (AGENTS.md §7), and only this field tells them apart.
   */
  readonly unreadable: readonly UnreadableFinding[];
}

/** Every round written for one story, lowest round first. */
export function fixlistRounds(runDir: string, phaseDir: string, storyId: string): readonly FixlistOnDisk[] {
  const dir = fixlistDir(runDir, phaseDir);
  if (!existsSync(dir)) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: FixlistOnDisk[] = [];
  for (const entry of entries) {
    const match = new RegExp(`^${escapeRe(storyId)}-(\\d{1,4})\\.md$`).exec(entry);
    if (match === null) continue;
    const round = Number(match[1] ?? "0");
    const path = join(dir, entry);
    const { findings, unreadable } = readFixlistParse(path);
    rows.push({ round, path, rel: fixlistRel(phaseDir, storyId, round), findings, unreadable });
  }
  return rows.sort((a, b) => a.round - b.round);
}

/** The latest round on disk, or null when this story never got one. */
export function latestFixlist(runDir: string, phaseDir: string, storyId: string): FixlistOnDisk | null {
  const rounds = fixlistRounds(runDir, phaseDir, storyId);
  return rounds[rounds.length - 1] ?? null;
}

/**
 * The latest round on disk while it still holds an OPEN `fix-now` finding, or
 * null (gh #327).
 *
 * ONE derivation for the three readers that must agree: the developer handed the
 * list, the reviewer shown its open findings, and the auto-close that may close
 * only what that reviewer was shown. A fix list whose every finding is closed or
 * routed away is finished, and re-rendering it would ask for work somebody
 * already decided not to do.
 */
export function openFixlist(runDir: string, phaseDir: string, storyId: string): FixlistOnDisk | null {
  const latest = latestFixlist(runDir, phaseDir, storyId);
  return latest !== null && openFindings(latest.findings).length > 0 ? latest : null;
}

/** Read one fix-list file, wherever it is. Null when it is not one. */
export function readFixlistAt(path: string, rel: string): FixlistOnDisk | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { findings, unreadable } = parseFixlistDocument(text);
  if (findings.length === 0 && unreadable.length === 0) return null;
  const round = Number(/-(\d{1,4})\.md$/.exec(path)?.[1] ?? "1");
  return { round: Number.isFinite(round) ? round : 1, path, rel, findings, unreadable };
}

function readFixlistParse(path: string): FixlistParse {
  try {
    return parseFixlistDocument(readFileSync(path, "utf8"));
  } catch {
    return { findings: [], unreadable: [] };
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- the two renderings ----------------------------------------------------

/**
 * `## Fix list` for the AUTHOR's next prompt (design §B.4, "the router").
 *
 * Numbered findings and their `Do NOT` lines verbatim — a bound the reviewer put
 * on the fix is worth exactly as much as the fix, and paraphrasing it is how a
 * "do not add a lockout policy" becomes a lockout policy.
 *
 * Only the findings the author is being asked to ACT on are rendered as work;
 * the rest are listed so the author does not fix them by accident and then have
 * to explain the diff.
 */
export function renderFixlistSection(rel: string, findings: readonly FixFinding[]): string {
  const open = openFindings(findings);
  const rest = findings.filter((f) => !isOpen(f));
  const lines = [
    `A reviewer SIGNED your last attempt at this story and attached a fix list: \`${rel}\`.`,
    "It is the primary instruction for this attempt; everything else in this prompt still",
    "applies. This round cost the story no attempt and there is not a second one.",
    "",
  ];
  if (open.length === 0) {
    lines.push("Every finding is already dispositioned away from `fix-now` — there is nothing here to fix.", "");
  } else {
    lines.push("**Fix these, and only these:**", "");
    for (const finding of open) {
      lines.push(`${String(finding.n)}. **${finding.finding}** [${finding.severity}]`);
      if (finding.where !== "") lines.push(`   Where: ${finding.where}`);
      for (const detail of finding.detail.split("\n")) {
        if (detail.trim() !== "") lines.push(`   ${detail.trim()}`);
      }
      for (const line of finding.doNot) lines.push(`   Do NOT: ${line}`);
      lines.push("");
    }
  }
  if (rest.length > 0) {
    lines.push("**Not yours this round** — listed so you do not fix them by accident:", "");
    for (const finding of rest) {
      lines.push(
        `- ${String(finding.n)}. ${finding.finding} — \`${finding.disposition}\``
        + (finding.resolved
          ? finding.resolvedSha === null ? " (claimed resolved, no sha — still open)" : ` (resolved ${finding.resolvedSha})`
          : ""),
      );
    }
    lines.push("");
  }
  lines.push(
    "Do not edit the fix list itself: it lives in the run tree, and this worktree is the",
    "only tree you may write in. Report what you changed and stop.",
  );
  return lines.join("\n");
}

/**
 * `defer-with-log` findings, as `retro.md` bullets.
 *
 * The existing second writer, the existing dedup (`appendBuildRetro`). A deferred
 * defect is a thing the team decided not to do yet, which is exactly the kind of
 * push-back `## Build feedback` exists to carry to a role expert — and it reaches
 * the owner through a channel that already exists rather than a new one.
 */
export function fixlistRetroLines(
  storyId: string,
  runId: string,
  rel: string,
  findings: readonly FixFinding[],
): readonly string[] {
  const src = `[src: tldrx-work/${runId}/${rel}:1]`;
  return findings
    .filter((finding) => finding.disposition === "defer-with-log")
    .map((finding) =>
      `- \`${storyId}\` — reviewer finding DEFERRED (${finding.severity}`
      + `${finding.kind === null ? "" : `, ${finding.kind}`}`
      // A finding that was ROUTED here rather than filed here says so on the
      // bullet the owner actually reads (#255). The retro is where a deferred
      // defect reaches a person, and "the reviewer wanted this fixed now and the
      // taxonomy moved it" is the one thing about it a person needs to be able to
      // disagree with.
      + `${finding.normalisedFrom === null ? "" : `, submitted \`${finding.normalisedFrom}\``}`
      + `): ${oneLine(finding.finding)}`
      + `${finding.detail === "" ? "" : ` — ${oneLine(finding.detail)}`} ${src}`,
    );
}

/** One line: a summary that spans three is a bullet that breaks the list. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
