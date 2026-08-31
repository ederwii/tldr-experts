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
import type { StoryOutcome, Verdict } from "./outcome.ts";

export interface Review {
  readonly verdict: Verdict;
  readonly summary: string;
  readonly findings: readonly string[];
}

/** The `structured_output` of a reviewer run, narrowed. Anything odd is `changes`. */
export function parseReview(structured: unknown, fallback: string): Review {
  if (!isRecord(structured)) {
    return {
      verdict: "changes",
      summary: fallback.trim() === "" ? "the reviewer returned no envelope" : fallback.trim(),
      findings: [],
    };
  }
  const verdict = structured.verdict === "approve" ? "approve" : "changes";
  const summary = typeof structured.summary === "string" && structured.summary.trim() !== ""
    ? structured.summary.trim()
    : verdict === "approve" ? "approved with no comment" : "changes requested with no comment";
  const findings = Array.isArray(structured.findings)
    ? (structured.findings as unknown[]).filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];
  return { verdict, summary, findings };
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
  const text = (error ?? "").trim();
  return { verdict: "error", summary: text === "" ? REVIEWER_FAILED : text, findings: [] };
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
