/**
 * The reviewer's verdict, and the log it becomes.
 *
 * Two rules, both fail-closed:
 *   - a verdict that cannot be read is `changes`, never `approve` — an unparseable
 *     review is not a sign-off;
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

/** `04-build/log/<story-id>.md`. Line 1 is the heading, which is what handoffs cite. */
export function renderReviewLog(outcome: StoryOutcome): string {
  const lines = [
    `# Review — ${outcome.id} · ${outcome.title}`,
    "",
    `- Verdict: **${outcome.verdict}**`,
    `- Story status: \`${outcome.status}\``,
    `- Attempt: ${String(outcome.attempts)}`,
    `- Repo: \`${outcome.repo}\` · wave ${outcome.wave} · epic ${outcome.epic}`,
    `- Branch: \`${outcome.branch}\` → \`${outcome.epicBranch}\` (${outcome.merged ? "merged" : "not merged"})`,
    `- Commit: ${outcome.commit ?? "(none)"}`,
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
    outcome.reviewSummary === "" ? "_No reviewer ran for this story._" : outcome.reviewSummary,
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
