/**
 * The reviewer's verdict, and the log it becomes.
 *
 * Three rules, all fail-closed:
 *   - a verdict that cannot be read is `changes`, never `approve` — an unparseable
 *     review is not a sign-off;
 *   - a reviewer that never RAN produced no verdict at all, and gets `error`
 *     rather than a `changes` invented on its behalf (`reviewerFailed`);
 *   - the log is written by the executor from the envelope, not by the reviewer,
 *     because the reviewer holds no write tool (see `prompts.ts`).
 *
 * `04-build/log/<story-id>.md` exists for EVERY story the phase touched, including
 * one blocked before a reviewer ever ran. The handoff cites it as
 * `[src: 04-build/log/<id>.md:1]`, and a Finding whose source does not resolve is
 * a handoff the claim-sources check rejects.
 */
import { isRecord } from "../schemas/validation.ts";
import { SRC_GRAMMAR_HEADING } from "../text/srcGrammarContract.ts";
import { parseFixFindings, type FixFinding } from "./fixlist.ts";
import type { StoryOutcome, Verdict } from "./outcome.ts";

export interface Review {
  readonly verdict: Verdict;
  readonly summary: string;
  readonly findings: readonly string[];
  /**
   * The numbered findings of a `fixlist` verdict — empty on every other one.
   *
   * Structured, not prose, because the executor writes the artifact from them and
   * the artifact is read back at settle time to answer "is anything still open?".
   */
  readonly fixlist: readonly FixFinding[];
  /**
   * Why a DECLARED fix list was refused, when one was. Non-empty only on a review
   * whose `verdict` was `fixlist` on the wire and is `changes` in this object —
   * so the executor can say what happened instead of silently downgrading it.
   */
  readonly fixlistProblems: readonly string[];
  /**
   * The SUBSET of `fixlistProblems` the claim-sources check raised (gh #78).
   *
   * Non-empty ⇒ at least one of the reasons this envelope was refused is that a
   * `refuted` finding's `[src: …]` does not parse. That is a fault in the REPORT,
   * not in the diff, and `isGrammarRejection` is what decides whether it may be
   * re-prompted for free. Always a subset of `fixlistProblems`, never a
   * replacement for it: an operator still reads every refusal.
   */
  readonly grammarProblems: readonly string[];
  /**
   * The verdict this could not read, named — or null when it read one.
   *
   * The fixlist sibling of `fixlistProblems`, and it exists for the same reason.
   * Measured on `260831-hardening-d1` / S1 (2026-08-31): two verdict grammars
   * coexist — gate evidence is `sign | sign-with-fixlist | refuse`, a story review
   * is `approve | fixlist | changes` — and the host-facing hint named neither. The
   * host wrote `sign`; this fail-closed it to `changes` and said NOTHING, so a
   * clean fix-list verification round read as a second `changes`, the story went
   * `blocked`, and it cost a `story reopen` to record the verdict that had been
   * meant all along.
   *
   * Fail-closed is right and is unchanged. Silent is the part that was wrong.
   */
  readonly verdictProblem: string | null;
}

/** The story-review grammar. NOT the gate-evidence one — see `verdictProblem`. */
export const VERDICT_WORDS = ["approve", "fixlist", "changes"] as const;
const VERDICT_ENUM = VERDICT_WORDS.join("|");

/**
 * How many times one review round may be re-prompted for a corrected envelope
 * before the refusal starts costing the story an attempt (gh #78).
 *
 * Owner decision, 2026-09-01: two. The reasoning is the same shape as
 * `MAX_FIXLIST_ROUNDS`' — a free round nobody counts is a story that never has
 * to settle. A reviewer that cannot write a parseable `[src: …]` in three tries
 * is not having a formatting accident, and the third refusal is recorded as the
 * `changes` it always was.
 *
 * Counted PER ROUND, not per story: a counted verdict starts the next envelope
 * with its two corrections again. The overall bound is still hard — attempts are
 * capped at `MAX_ATTEMPTS`, so a story can burn at most that many rounds.
 */
export const MAX_GRAMMAR_RETRIES = 2;

/**
 * The `structured_output` of a reviewer run, narrowed. Anything odd is `changes`.
 *
 * `fixlist` joins the enum and does NOT weaken that rule — it tightens it. The
 * verdict is only granted when the envelope carries a `fixlist[]` this can read
 * whole: an unreadable envelope must not buy a free round, which is the one thing
 * a malformed review could otherwise get out of the third verdict. Everything it
 * could not read comes back on `fixlistProblems`, so the downgrade is said out
 * loud rather than performed silently.
 */
export function parseReview(structured: unknown, fallback: string): Review {
  if (!isRecord(structured)) {
    return {
      verdict: "changes",
      summary: fallback.trim() === "" ? "the reviewer returned no envelope" : fallback.trim(),
      findings: [],
      fixlist: [],
      fixlistProblems: [],
      grammarProblems: [],
      // No envelope at all is already said in the summary; naming a verdict that
      // was never on the wire would be a second sentence for one fault.
      verdictProblem: null,
    };
  }
  const declared = structured.verdict;
  const parsed = declared === "fixlist" ? parseFixFindings(structured.fixlist) : null;
  const verdict: Verdict = declared === "approve"
    ? "approve"
    : parsed !== null && parsed.problems.length === 0
      ? "fixlist"
      : "changes";
  const summary = typeof structured.summary === "string" && structured.summary.trim() !== ""
    ? structured.summary.trim()
    : verdict === "approve"
      ? "approved with no comment"
      : verdict === "fixlist"
        ? "signed with a fix list and no comment"
        : "changes requested with no comment";
  // A DECLARED `fixlist` that fell to `changes` is already reported on
  // `fixlistProblems`; reporting it twice would read as two different faults.
  const verdictProblem = declared === "fixlist" ? null : unreadableVerdict(declared);
  const findings = [
    ...readFindings(structured.findings),
    ...(verdictProblem === null ? [] : [verdictProblem]),
  ];
  return {
    verdict,
    summary,
    findings,
    fixlist: verdict === "fixlist" ? (parsed?.findings ?? []) : [],
    fixlistProblems: verdict === "fixlist" ? [] : (parsed?.problems ?? []),
    grammarProblems: verdict === "fixlist" ? [] : (parsed?.grammar ?? []),
    verdictProblem,
  };
}

/**
 * Is this refusal a claim-sources GRAMMAR fault and nothing else (gh #78)?
 *
 * The whole scope guard of #78 is in this predicate, so it is deliberately hard
 * to satisfy. Four conditions, and the last two are the guard:
 *
 *   - the envelope fell to `changes` (an approval or a granted fix list is not a
 *     refusal at all);
 *   - the claim-sources check raised at least one of the reasons;
 *   - it raised ALL of them — an envelope also missing a `disposition` is not
 *     merely mis-cited, and widening the free retry to cover that shape is a
 *     decision nobody has made (filed separately);
 *   - and the verdict WORD itself parsed. `sign` instead of `approve` is a
 *     different fault with its own message (gh #36), and it keeps its cost.
 *
 * Measured on run `260830-ordering-inventory` (2026-09-01): S2, S3 and S5 each
 * recorded `verdict: changes, attempt: 1` over a summary beginning "I would sign
 * this" — three envelopes that satisfied exactly this predicate, and three
 * attempts spent on formatting.
 */
export function isGrammarRejection(review: Review): boolean {
  return review.verdict === "changes"
    && review.grammarProblems.length > 0
    && review.grammarProblems.length === review.fixlistProblems.length
    && review.verdictProblem === null;
}

/**
 * The refusal, rendered for the corrected envelope's prompt (gh #78).
 *
 * `problems` is `Review.fixlistProblems` verbatim — deliberately not re-worded and
 * deliberately not supplemented. gh #77 landed first and made those strings name
 * the rule they enforced, quote the offending line and show a corrected one, and
 * it splices the full grammar into this very prompt under `SRC_GRAMMAR_HEADING`.
 * So this section says what was refused and points at that; restating the rules
 * here would be the second copy #77 exists to abolish.
 */
export function renderGrammarRefusal(problems: readonly string[]): string {
  return [
    "## Your previous envelope was REFUSED",
    "",
    "It did not reach the story. This round cost the story NO attempt, and there are",
    `${String(MAX_GRAMMAR_RETRIES)} such corrections in total — after that a refusal is recorded as \`changes\`,`,
    "which does cost one. What the check said, verbatim:",
    "",
    ...problems.map((problem) => `- ${problem}`),
    "",
    `Return the SAME judgement again with the citation fixed. The rule each refusal names is`,
    `spelled out, with a worked example, under "${SRC_GRAMMAR_HEADING}" in this prompt.`,
    "",
    "Do not soften the verdict to get past this check: the judgement is not what was refused.",
    "",
  ].join("\n");
}

/** The sentence for a verdict outside the enum, or null for one inside it. */
function unreadableVerdict(declared: unknown): string | null {
  if (typeof declared === "string" && (VERDICT_WORDS as readonly string[]).includes(declared)) return null;
  const said = typeof declared === "string" && declared.trim() !== ""
    ? `\`${declared.trim()}\``
    : "(the envelope declared none)";
  return `the reviewer's verdict ${said} is not ${VERDICT_ENUM} — recorded as \`changes\``;
}

/**
 * Every finding the envelope carried, as text. Nothing is dropped in silence.
 *
 * `findings` was `filter(typeof f === "string")`, which threw away the rich ones:
 * on `260831-hardening-d1` the attempt-1 adversarial reviewer wrote seven
 * `{severity, file, line, claim, evidence, fix}` objects and the recorded review
 * kept ZERO of them. The verdict survived; the evidence it rested on did not.
 */
function readFindings(value: unknown): readonly string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? (value as unknown[]) : [value];
  const out: string[] = [];
  for (const item of items) {
    const text = renderFinding(item);
    if (text !== null) out.push(text);
  }
  return out;
}

/** One finding as one line: `[severity] file:line — claim · evidence: … · fix: …`. */
function renderFinding(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isRecord(value)) return null;
  const parts: string[] = [];
  const severity = text(value.severity);
  if (severity !== null) parts.push(`[${severity}]`);
  const where = locationOf(value);
  if (where !== null) parts.push(where);
  const claim = text(value.claim) ?? text(value.finding) ?? text(value.text)
    ?? text(value.message) ?? text(value.title);
  if (claim !== null) parts.push(parts.length === 0 ? claim : `— ${claim}`);
  const evidence = text(value.evidence);
  if (evidence !== null) parts.push(`· evidence: ${evidence}`);
  const fix = text(value.fix);
  if (fix !== null) parts.push(`· fix: ${fix}`);
  // Nothing this knows how to name: keep the object whole rather than lose it.
  // An unreadable finding in the log beats a finding that is not in the log.
  return parts.length === 0 ? JSON.stringify(value) : parts.join(" ");
}

function locationOf(value: Record<string, unknown>): string | null {
  const file = text(value.file) ?? text(value.where) ?? text(value.path);
  const line = typeof value.line === "number" ? String(value.line) : text(value.line);
  if (file === null) return line === null ? null : `line ${line}`;
  return line === null ? file : `${file}:${line}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** What `reviewerFailed` says when the spawn layer had nothing to say. */
export const REVIEWER_FAILED = "the reviewer sub-agent failed";

/**
 * The reviewer FAILED: a spawn error, a timeout, an exhausted budget, a killed
 * process. There is no verdict here to record, so none is invented.
 *
 * This is the distinction the executor used to lose. `parseReview` is for a
 * reviewer that ANSWERED and whose answer is unreadable — that one is `changes`,
 * fail-closed, and correctly consumes the story's requeue. This one is for a
 * reviewer that never answered, and it must not.
 */
export function reviewerFailed(error: string | null | undefined): Review {
  const said = (error ?? "").trim();
  return {
    verdict: "error",
    summary: said === "" ? REVIEWER_FAILED : said,
    findings: [],
    fixlist: [],
    fixlistProblems: [],
    grammarProblems: [],
    // A reviewer that never answered declared no verdict to misread.
    verdictProblem: null,
  };
}

/**
 * Does a recorded review `detail` read as a TRANSPORT failure rather than a
 * verdict? COMPAT ONLY.
 *
 * A run recorded before `verdict: "error"` existed wrote a reviewer crash as
 * `verdict: "changes"` with the spawn layer's own error string as its detail.
 * Measured 2026-08-30 in `260830-tenancy-identity-customers/events.jsonl`:
 *
 *   {"check":"review","story":"S1","verdict":"changes",
 *    "detail":"claude exited 1 with is_error=true: Reached maximum budget ($0.26)"}
 *
 * Every string this can match is produced by the framework itself — `describe()`
 * in `spawnAgent.ts`, `readCapError` in `readCap.ts`, or `REVIEWER_FAILED` here —
 * never by a model, because a model's summary goes through `parseReview`. A NEW
 * run never reaches this function: it reads `verdict: "error"` off the event.
 */
export function looksLikeReviewerError(detail: string): boolean {
  const text = detail.trim();
  return text === REVIEWER_FAILED || looksLikeSpawnError(text);
}

/**
 * Does this string come from the SPAWN layer rather than from a model?
 *
 * The three prefixes are the framework's own words for "the sub-agent did not
 * finish": `describe()` in `spawnAgent.ts` (`claude exited …`, `claude timed
 * out …`) and `readCapError` in `readCap.ts` (`stopped after N reads …`). A
 * model never writes any of them — its own summary reaches disk through
 * `parseReview` or through an envelope.
 *
 * Split out of `looksLikeReviewerError` so the sentence that is about REVIEWS —
 * its own fallback summary — is visibly separate from the three that are about
 * the spawn layer and belong to no role in particular.
 */
function looksLikeSpawnError(detail: string): boolean {
  const text = detail.trim();
  return text.startsWith("claude exited ")
    || text.startsWith("claude timed out")
    || text.startsWith("stopped after ");
}

/** `04-build/log/<story-id>.md`. Line 1 is the heading, which is what handoffs cite. */
export function renderReviewLog(outcome: StoryOutcome): string {
  const lines = [
    `# Review — ${outcome.id} · ${outcome.title}`,
    "",
    `- Verdict: **${outcome.verdict}**`,
    `- Story status: \`${outcome.status}\``,
    `- Attempt: ${String(outcome.attempts)}`,
    `- Repo: \`${outcome.repo}\` · wave ${outcome.wave} · epic ${outcome.epic}`,
    `- Branch: \`${outcome.branch}\` → \`${outcome.epicBranch}\` (${mergeWord(outcome)})`,
    `- Commit: ${outcome.commit ?? "(none)"}`,
    ...(outcome.developerError === null ? [] : [`- Developer: **FAILED** — ${outcome.developerError}`]),
    "",
    "## Definition of done",
    "",
    ...(outcome.dod.length === 0
      ? ["- (the story declares no dod commands)"]
      : outcome.dod.map((r) =>
          `- \`${r.command}\` → exit ${String(r.exitCode)}${r.timedOut ? " (timed out)" : ""}` +
          (r.exitCode === 0 ? "" : ` — ${r.tail}`),
        )),
    "",
    "## Summary",
    "",
    ...summaryLines(outcome),
    "",
    "## Findings",
    "",
    ...(outcome.reviewFindings.length === 0
      ? ["- none"]
      : outcome.reviewFindings.map((f) => `- ${f}`)),
    "",
  ];
  if (outcome.conflicts.length > 0) {
    lines.push(
      "## Merge conflict",
      "",
      `\`${outcome.branch}\` could not be merged into \`${outcome.epicBranch}\`. The merge was aborted,`,
      "so the epic branch is unchanged. Conflicting paths:",
      "",
      ...outcome.conflicts.map((path) => `- \`${path}\``),
      "",
    );
  }
  if (outcome.reason !== null) {
    lines.push("## Why it is not done", "", outcome.reason, "");
  }
  return lines.join("\n");
}

/**
 * `merged`, `not merged`, or the third case that used to be spelled as the
 * first: a merge of a branch that was already an ancestor of the epic. Git
 * exits 0 and moves nothing, and calling that "merged" is how a handoff came to
 * list four stories as merged when their branches were byte-identical to the
 * epic (2026-08-30).
 */
function mergeWord(outcome: StoryOutcome): string {
  if (!outcome.merged) return "not merged";
  return outcome.carried === 0 ? "nothing to merge — identical to the epic" : "merged";
}

/**
 * The Summary section: what the reviewer said, or — when one of the two
 * sub-agents FAILED — that it failed and with what, in those words. "The
 * reviewer asked for changes" over a transport error is the sentence this whole
 * file exists to stop printing.
 */
function summaryLines(outcome: StoryOutcome): readonly string[] {
  // The developer never delivered, so there was nothing for a reviewer to read.
  // Saying "no reviewer ran" alone would be true and useless: what happened is
  // that the turn before it died, and with what.
  if (outcome.developerError !== null) {
    return [
      "**The developer FAILED and produced no work.** No reviewer ran, because there was",
      "nothing to review. The error it died with:",
      "",
      `> ${outcome.developerError}`,
    ];
  }
  if (outcome.verdict === "error") {
    return [
      "**The reviewer FAILED and returned no verdict.** This is not a request for changes:",
      "nothing about the diff was judged. The error it died with:",
      "",
      `> ${outcome.reviewSummary === "" ? REVIEWER_FAILED : outcome.reviewSummary}`,
    ];
  }
  return [outcome.reviewSummary === "" ? "_No reviewer ran for this story._" : outcome.reviewSummary];
}

/**
 * The review, rendered for the NEXT attempt's `## Previous attempt` section.
 * Spec §5's failure path already feeds a reject note forward this way; a `changes`
 * verdict is the same move with a different author.
 */
export function renderPreviousAttempt(review: Review): string {
  return [
    `> Verdict: **changes**`,
    ">",
    ...review.summary.split("\n").map((line) => `> ${line}`),
    ...(review.findings.length === 0 ? [] : [">", ...review.findings.map((f) => `> - ${f}`)]),
  ].join("\n");
}
