/**
 * What the remote issue says, and the line that stops it from being edited.
 *
 * The body is generated from the story file every sync, so a human editing the
 * issue in Jira or GitHub is editing something that will be overwritten. That is
 * a design decision (guard-rail 1: files are the source of truth), and the footer
 * says so on every issue rather than leaving people to find out.
 */
import type { MirrorKind } from "./types.ts";

/** Printed as the last line of every mirrored issue body. Asserted by a test. */
export const TICKET_FOOTER = "managed by tldrx — edits here are not read back";

export interface IssueBodyInput {
  readonly kind: MirrorKind;
  readonly id: string;
  readonly title: string;
  /** A story's `acceptance:`. Empty for an epic. */
  readonly acceptance: readonly string[];
  /** A story's `test_plan:`. Empty for an epic. */
  readonly testPlan: readonly string[];
  /** An epic's `stories:`. Empty for a story. */
  readonly stories: readonly string[];
  /** Run-relative path of the file this mirrors, e.g. `03-plan/stories/S3.md`. */
  readonly rel: string;
  readonly runId: string;
}

/** `S3 · Leaderboard read model` — the id first, so a remote search finds it. */
export function issueTitle(id: string, title: string): string {
  return `${id} · ${title}`;
}

export function renderIssueBody(input: IssueBodyInput): string {
  const lines: string[] = [`# ${issueTitle(input.id, input.title)}`, ""];

  if (input.acceptance.length > 0) {
    lines.push("## Acceptance", "");
    for (const item of input.acceptance) lines.push(`- ${item}`);
    lines.push("");
  }
  if (input.testPlan.length > 0) {
    lines.push("## Test plan", "");
    for (const item of input.testPlan) lines.push(`- ${item}`);
    lines.push("");
  }
  // `[assumption]` — an epic has no acceptance or test plan of its own (spec
  // §2.14), so it mirrors its story list instead of an empty issue.
  if (input.stories.length > 0) {
    lines.push("## Stories", "");
    for (const item of input.stories) lines.push(`- ${item}`);
    lines.push("");
  }

  lines.push("## Source", "", `\`tldrx-work/${input.runId}/${input.rel}\``, "", "---", "", TICKET_FOOTER);
  return `${lines.join("\n")}\n`;
}
