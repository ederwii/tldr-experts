/**
 * The deny messages, verbatim from spec §4.
 *
 * `[assumption]` — the spec prints them inside a fixed-width block, so some line
 * breaks are the page and some are the message. Taken here: a break that falls on
 * a sentence boundary is a real newline; a break mid-sentence is a wrap and is
 * joined with one space. Everything else, down to the punctuation, is copied.
 */
import type { Fact } from "../../core/facts/Fact.ts";
import { BULLET_RULE, EMPTY_SECTION_RULE, noneBullet } from "../../core/text/handoff.ts";
import { srcRule, type SrcRuleId } from "../../core/text/srcToken.ts";

const GRAMMAR =
  "[src: <repo:path:line> | https://… | Q<n> | F<n> | $ <cmd> → exit <n> | graph:<node> | absent:<path>]";

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** An issue as every claim-sources deny receives it: a line, a reason, maybe a rule. */
export interface DenyIssue {
  readonly line: number;
  readonly message: string;
  readonly rule?: SrcRuleId;
}

/** Longest offending line quoted back before it stops helping. */
const MAX_QUOTED_CHARS = 200;

/**
 * Line `n` of the document, as written (gh #77).
 *
 * Every deny on this path now takes the file's text and quotes the line it is
 * refusing. Naming L12 and nothing else asks the author to go and find L12, then
 * work out for themselves which of its characters the reader objected to — which
 * is precisely the loop that cost run `260830-ordering-inventory` three attempts.
 * A line number that cannot be resolved (an out-of-range index, no text passed)
 * degrades to no quote rather than to a wrong one.
 */
function quoteLine(text: string, line: number): string | null {
  if (text === "" || line < 1) return null;
  const found = text.split("\n")[line - 1];
  if (found === undefined || found.trim() === "") return null;
  const trimmed = found.trim();
  return trimmed.length <= MAX_QUOTED_CHARS ? trimmed : `${trimmed.slice(0, MAX_QUOTED_CHARS)}…`;
}

/**
 * One issue, rendered as the rule it broke, the line as written, and a line that
 * would pass.
 *
 * The corrected example comes from `SRC_RULES` — the same registry the reader
 * diagnoses with — so it can never suggest a spelling the parser would refuse:
 * `test/src-grammar.test.ts` pushes every one of them back through the parser.
 */
function issueBlock(issue: DenyIssue, text: string): string {
  const out = [`L${String(issue.line)}: ${issue.message}`];
  const quoted = quoteLine(text, issue.line);
  if (quoted !== null) out.push(`      you wrote: ${quoted}`);
  if (issue.rule !== undefined) {
    const rule = srcRule(issue.rule);
    // Most messages on this path ARE the rule's clause — `refuse()` builds them
    // from it, so a caller that prints nothing else still says what was enforced.
    // Print it a second time only when the message did not already carry it.
    out.push(issue.message.includes(rule.rule)
      ? `      rule:      \`${rule.id}\``
      : `      rule \`${rule.id}\`: ${rule.rule}`);
    out.push(`      corrected: ${rule.good}`);
  }
  return out.join("\n");
}

export function claimSourcesDeny(relPath: string, lines: readonly number[], text = ""): string {
  const list = lines.map((n) => `L${String(n)}`).join(", ");
  const quotes = lines
    .map((n) => ({ n, quoted: quoteLine(text, n) }))
    .filter((row): row is { n: number; quoted: string } => row.quoted !== null)
    .map((row) => `L${String(row.n)}: ${row.quoted}`);
  return (
    `[tldrx] claim-sources: ${String(lines.length)} unsourced bullet(s) in ${relPath} — ${list}.\n` +
    (quotes.length === 0 ? "" : `${quotes.join("\n")}\n`) +
    `Rule: ${BULLET_RULE}. The token goes at the END of the line: ${GRAMMAR}.\n` +
    "Add the source or delete the claim."
  );
}

/**
 * Spec §2.8: each of the four checked sections must contain at least one list
 * item. Verbatim text for this one is written in the spec's voice. `[assumption]`
 */
export function claimSourcesEmptySectionDeny(
  relPath: string,
  sections: readonly { name: string; line: number }[],
): string {
  const list = sections.map((s) => `"${s.name}" (L${String(s.line)})`).join(", ");
  return (
    `[tldrx] claim-sources: ${String(sections.length)} checked section(s) in ${relPath} contain no list ` +
    `items — ${list}.\n` +
    `Rule: ${EMPTY_SECTION_RULE}.\n` +
    "If there is genuinely nothing, say so as an item: " +
    `\`${noneBullet("<what you looked at>")}\`.`
  );
}

/**
 * A bullet that DID cite something the parser could not read.
 *
 * Split out of `claimSourcesDeny` on 2026-08-29: a real user's first `tldrx next`
 * was refused with "9 unsourced bullet(s)" when all nine carried a citation —
 * they were wrapped in backticks. "You wrote no source" sent them looking for
 * something already on the page.
 *
 * Rewritten again for gh #77. The one sentence it used to print — "the token must
 * be the LAST thing on the line" — is right for one of the three ways a token
 * fails to tokenise and actively misleading for the other two: a nested `]` fails
 * with the token sitting exactly where that advice puts it. It now prints the
 * rule the reader actually fired, the line as written, and a corrected line.
 */
export function claimSourcesMalformedDeny(
  relPath: string,
  issues: readonly DenyIssue[],
  text = "",
): string {
  const list = issues.map((i) => `L${String(i.line)}`).join(", ");
  return (
    `[tldrx] claim-sources: ${String(issues.length)} malformed citation(s) in ${relPath} — ${list}.\n` +
    `${issues.map((issue) => issueBlock(issue, text)).join("\n")}\n` +
    "The bullet cites a source but the token could not be read. Fix the citation or delete the claim."
  );
}

/**
 * The spec gives no verbatim text for a source that parses but does not resolve,
 * so this one is written in its voice. `[assumption]`
 *
 * It carries GRAMMAR failures too — a piece inside a token that no `src` rule
 * accepts is reported here rather than as `malformed`, because the token itself
 * tokenised. Those arrive with a `rule` and get the same three lines the
 * malformed ones do (gh #77).
 */
export function claimSourcesUnresolvedDeny(
  relPath: string,
  issues: readonly DenyIssue[],
  text = "",
): string {
  const detail = issues.map((issue) => issueBlock(issue, text)).join("\n");
  return (
    `[tldrx] claim-sources: ${String(issues.length)} unresolvable source(s) in ${relPath}.\n` +
    `${detail}\n` +
    "A cited file must exist with the line in range, a command must be one of workspace.yml's, and " +
    "`$ … → exit n` belongs only in the Evidence ledger. Fix the citation or delete the claim."
  );
}

export function noReAskDeny(questionId: string, questionTitle: string, fact: Fact): string {
  const who = fact.source.who;
  const when = fact.source.when.slice(0, 10);
  const run = fact.source.run ?? "init";
  return (
    `[tldrx] no-re-ask: ${questionId} "${questionTitle}" is already answered by ${fact.id} ` +
    `(${who}, ${when}, run ${run}): "${ellipsise(fact.fact)}". Cite it as [src: ${fact.id}] instead of asking.\n` +
    "If the fact is stale, set its `retired: {at, by, reason}` in .tldrx/memory/facts.yml first, " +
    "then re-write the question."
  );
}

export function dodGateDeny(
  storyId: string,
  command: string,
  repo: string,
  exitCode: number,
  outputTail: string,
): string {
  const tail = outputTail.trim() === "" ? "(no output)" : outputTail.trim();
  return (
    `[tldrx] DoD-gate: story ${storyId} cannot be marked done — \`${command}\` in repo ${repo} ` +
    `exited ${exitCode} (expected 0).\n` +
    `Command output tail: ${tail}\n` +
    "Fix the code or the story's dod block; done means proven, not asserted."
  );
}

/** No verbatim spec text for the missing-block case; written in its voice. `[assumption]` */
export function dodGateMissingBlockDeny(storyId: string, relPath: string): string {
  return (
    `[tldrx] DoD-gate: story ${storyId} cannot be marked done — no fenced \`\`\`dod block in ${relPath}.\n` +
    "Add the commands that prove it (test, lint, typecheck from map/commands.md) and let the gate re-run them; " +
    "done means proven, not asserted."
  );
}

/**
 * A dod command the gate will not run at all.
 *
 * Distinct from `dodGateDeny`, which reports a command that ran and failed. This
 * one never ran: it is not in `workspace.yml`, or it needs a shell the gate does
 * not open. `[assumption]` on the wording — the spec has no verbatim text for a
 * refusal that did not exist until 2026-08-29.
 */
export function dodGateRefusedCommandDeny(storyId: string, command: string, why: string): string {
  return (
    `[tldrx] DoD-gate: story ${storyId} cannot be marked done — refusing to RUN \`${command}\`.\n` +
    `${why}\n` +
    "This gate executes its commands for real, as you. It runs only what the workspace declared, " +
    "argv-split with no shell — a story is data, and data does not get to invent a command."
  );
}

/** DoD-gate is the one hook that fails CLOSED (spec §4). `[assumption]` on the wording. */
export function dodGateInternalErrorDeny(storyId: string, message: string): string {
  return (
    `[tldrx] DoD-gate: story ${storyId} cannot be marked done — the gate itself failed: ${message}\n` +
    "This gate fails closed: an unproven story stays not-done. Fix the gate's inputs and try again."
  );
}

/**
 * Spec §4's message, with its first remedy replaced by the command that performs it.
 *
 * The original said "Raise phases[<phase>].ceiling_usd in budget.yml" — true, and
 * in the pilot it produced a hand-edit that under-shot the estimate, so the retry
 * was refused a second time. `tldrx budget raise` computes the shortfall and
 * rounds it up, so naming the command instead of the field is the fix.
 */
export function budgetGateDeny(
  stage: string,
  phase: string,
  left: number,
  ceiling: number,
  estimate: number,
  fixCommand: string,
): string {
  return (
    `[tldrx] budget-gate: refusing to start stage "${stage}" — phase ${phase} has ${usd(left)} left of ` +
    `${usd(ceiling)} and the stage estimate is ${usd(estimate)}. Run \`${fixCommand}\` (add \`--take-from ` +
    `<phase>\` to move the money instead of adding it), lower budget_usd in .tldrx/stages/${stage}/stage.yml, ` +
    "or set on_exceed: warn."
  );
}

/** Spec §4 quotes a fact as `"Backend deploys run via deploy.yml…"` — cut at a word, then `…`. */
export function ellipsise(text: string, max = 40): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s.,;:—-]+$/, "")}…`;
}
