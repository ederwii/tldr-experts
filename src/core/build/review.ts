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
   * Every reason this envelope was refused that is a fault in its FORM (#78, #79).
   *
   * The union of two indexes, because a review envelope has two things that can
   * be malformed: `ParsedFixlist.format` (the `fixlist[]` shape — a missing
   * `disposition`, a row that is not an object, an empty array, an unparseable
   * `[src: …]`) and `verdictProblem` (the verdict WORD, gh #36). Both are faults
   * in how the reviewer wrote its REPORT rather than in the diff it judged, and
   * `isFormatRejection` is what decides that they may be re-prompted for free.
   *
   * This is what the corrected envelope's prompt is rendered from, so a refusal
   * missing here is a refusal the reviewer is never told about. Never a
   * replacement for `fixlistProblems`/`verdictProblem`: an operator still reads
   * every refusal through those.
   */
  readonly formatProblems: readonly string[];
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
 * before the refusal starts costing the story an attempt (gh #78, gh #79).
 *
 * Owner decision, 2026-09-01: two. The reasoning is the same shape as
 * `MAX_FIXLIST_ROUNDS`' — a free round nobody counts is a story that never has
 * to settle. A reviewer that cannot write a readable envelope in three tries is
 * not having a formatting accident, and the third refusal is recorded as the
 * `changes` it always was. gh #79 widened WHAT earns a correction and changed
 * nothing about how many: one bound, one counter, one economy.
 *
 * Counted PER ROUND, not per story: a counted verdict starts the next envelope
 * with its two corrections again. The overall bound is still hard — attempts are
 * capped at `MAX_ATTEMPTS`, so a story can burn at most that many rounds.
 */
export const MAX_FORMAT_RETRIES = 2;

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
      formatProblems: [],
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
    // The union described on `Review.formatProblems`. A GRANTED `fixlist` was
    // refused for nothing, and a declared `fixlist` can carry no verdict fault,
    // so the two halves can never both be non-empty — but they are spread rather
    // than chosen between, because that is an argument about today's parser and
    // this has to stay right when the parser changes.
    formatProblems: [
      ...(verdict === "fixlist" ? [] : (parsed?.format ?? [])),
      ...(verdictProblem === null ? [] : [verdictProblem]),
    ],
    verdictProblem,
  };
}

/**
 * Was this envelope refused for its FORM, and for nothing else (gh #78, gh #79)?
 *
 * The scope guard of both issues is in this one predicate. Three conditions:
 *
 *   - the envelope fell to `changes` — an approval or a GRANTED fix list is not
 *     a refusal at all, and neither is a fix-list round refused for being the
 *     second one (`narrowFixlist`), which is a bound rather than a fault;
 *   - something was refused as FORM;
 *   - and EVERY reason it was refused is one of those. This is the guard, and it
 *     is a guard about the index rather than about any particular shape: the
 *     free round is granted only when the typed index claims all of it, so a
 *     refusal about the WORK added to `parseFixFindings` later costs the attempt
 *     until somebody deliberately indexes it as form.
 *
 * gh #78 scoped this to the claim-sources citation check alone. Owner decision
 * on gh #79 (2026-09-01): all envelope-FORMAT refusals, one mental model — FORM
 * never costs an attempt, CONTENT/WORK always does. So a missing `disposition`,
 * a non-object row, an empty `fixlist[]` and a verdict word outside the enum
 * (gh #36) join the mis-placed `[src: …]`, and #36's message is unchanged; only
 * its price is.
 *
 * **What is deliberately NOT part of the guard: a non-empty `findings[]`.** It
 * looks like the obvious way to spell "the reviewer also judged the WORK", and
 * it is the wrong instrument. Measured across the nine `aparece-v2` runs on
 * 2026-09-01: all 25 recorded review logs carry a non-empty `findings[]`, and
 * all 25 are `approve` — the one verdict whose own prompt line says "Empty on
 * `approve`". Reviewers use `findings[]` as a narrative evidence log whatever
 * the verdict, so gating on it would have made this predicate almost never fire
 * and quietly narrowed #78 as well. A judgement about the work is caught where
 * it is actually stated: a DECLARED `changes` raises no format refusal at all,
 * so it fails the second condition and costs its attempt.
 *
 * Measured on run `260830-ordering-inventory` (2026-09-01): S2, S3 and S5 each
 * recorded `verdict: changes, attempt: 1` over a summary beginning "I would sign
 * this" — three envelopes that satisfy this predicate, and three attempts spent
 * on formatting.
 */
export function isFormatRejection(review: Review): boolean {
  // Every reason the envelope was refused, counted where each is RECORDED.
  const refusals = review.fixlistProblems.length + (review.verdictProblem === null ? 0 : 1);
  return review.verdict === "changes"
    && review.formatProblems.length > 0
    && review.formatProblems.length === refusals;
}

/**
 * The refusal, rendered for the corrected envelope's prompt (gh #78, gh #79).
 *
 * `problems` is `Review.formatProblems` verbatim — deliberately not re-worded and
 * deliberately not supplemented. Every refusal already names the rule it
 * enforced: gh #77 made the citation ones quote the offending line and show a
 * corrected one, and the shape ones have always spelled out what was required
 * (`one of fix-now, defer-with-log, refuted, out-of-scope`). So this section
 * says what was refused and points at the grammar #77 splices into this same
 * prompt; restating any of it here would be the second copy #77 exists to
 * abolish.
 */
/**
 * The heading `renderFormatRefusal` opens with — exported so a test can assert its
 * ABSENCE without spelling it twice, the same reason `SRC_GRAMMAR_HEADING` and
 * `REVIEWER_FOCUS_HEADING` are exported.
 *
 * The instrument matters (gh #135). "This prompt carries no format refusal" used to
 * be proved by the bare word REFUSED being absent from a ~14 KB document — but the
 * word is ordinary English, it appears in prompt prose that has nothing to do with a
 * refusal, and the assertion went red over one such sentence while the prompt was
 * correct. The SECTION is what "carries a refusal" means, so the section is what is
 * asserted, and the renderer and the test now read the same constant.
 */
export const FORMAT_REFUSAL_HEADING = "## Your previous envelope was REFUSED";

export function renderFormatRefusal(problems: readonly string[]): string {
  return [
    FORMAT_REFUSAL_HEADING,
    "",
    "It could not be read, so it did not reach the story. Nothing about your JUDGEMENT was",
    "refused — this is about the SHAPE of the envelope you returned. The round cost the story",
    `NO attempt, and there are ${String(MAX_FORMAT_RETRIES)} such corrections in total; after that a refusal is`,
    "recorded as `changes`, which does cost one. What the check said, verbatim:",
    "",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "Return the SAME judgement again, in an envelope that fixes exactly those. Each refusal",
    `names the rule it enforced; for a citation, the grammar is spelled out with a worked`,
    `example under "${SRC_GRAMMAR_HEADING}" in this prompt.`,
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
    formatProblems: [],
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
  if (outcome.rescued !== null) {
    lines.push("## Uncommitted work rescued", "", ...rescueLines(outcome), "");
  }
  if (outcome.reason !== null) {
    lines.push("## Why it is not done", "", outcome.reason, "");
  }
  return lines.join("\n");
}

/**
 * What happened to changes the worktree held and no ref did (#129).
 *
 * Written into the review log rather than only onto stdout because the sha is
 * the whole point: a blocked story is read hours later by somebody who wants the
 * work back, and a line that scrolled past in a terminal is not a record.
 */
function rescueLines(outcome: StoryOutcome): readonly string[] {
  const rescued = outcome.rescued;
  if (rescued === null) return [];
  if (rescued.sha !== null) {
    return [
      `This story's worktree still held changes that had reached no ref when it settled`,
      `\`${outcome.status}\`. They were committed to \`${rescued.branch}\` as \`${rescued.sha}\``,
      "before the worktree was removed — `git show " + rescued.sha + "` has them back.",
      "",
      "The commit is a `wip:` rescue, not a delivery: nothing reviewed it and nothing merged it.",
    ];
  }
  return [
    "This story's worktree held changes that had reached no ref, and they could NOT be committed",
    `(${rescued.failure ?? "no reason recorded"}).`,
    "",
    `The worktree was KEPT rather than pruned, because it is the only copy of that work:`,
    `\`${rescued.worktree ?? "(path not recorded)"}\``,
  ];
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
