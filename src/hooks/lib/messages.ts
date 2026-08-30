/**
 * The deny messages, verbatim from spec §4.
 *
 * `[assumption]` — the spec prints them inside a fixed-width block, so some line
 * breaks are the page and some are the message. Taken here: a break that falls on
 * a sentence boundary is a real newline; a break mid-sentence is a wrap and is
 * joined with one space. Everything else, down to the punctuation, is copied.
 */
import type { Fact } from "../../core/facts/Fact.ts";

const GRAMMAR =
  "[src: <repo:path:line> | https://… | Q<n> | F<n> | $ <cmd> → exit <n> | graph:<node> | absent:<path>]";

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function claimSourcesDeny(relPath: string, lines: readonly number[]): string {
  const list = lines.map((n) => `L${n}`).join(", ");
  return (
    `[tldrx] claim-sources: ${lines.length} unsourced bullet(s) in ${relPath} — ${list}.\n` +
    `Every bullet under Findings/Decisions/Unknowns/Evidence ledger must end with ${GRAMMAR}. ` +
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
  const list = sections.map((s) => `"${s.name}" (L${s.line})`).join(", ");
  return (
    `[tldrx] claim-sources: ${sections.length} checked section(s) in ${relPath} contain no list ` +
    `items — ${list}.\n` +
    "Findings/Decisions/Unknowns/Evidence ledger must each hold at least one sourced item; prose alone " +
    "is not a claim anything can check. If there is genuinely nothing, say so as an item: " +
    "`- none [src: absent:<what you looked at>]`."
  );
}

/**
 * A bullet that DID cite something the parser could not read.
 *
 * Split out of `claimSourcesDeny` on 2026-08-29: a real user's first `tldrx next`
 * was refused with "9 unsourced bullet(s)" when all nine carried a citation —
 * they were wrapped in backticks. "You wrote no source" sent them looking for
 * something already on the page. `[assumption]` on the wording; there is no
 * verbatim spec text for this case.
 */
export function claimSourcesMalformedDeny(
  relPath: string,
  issues: readonly { line: number; message: string }[],
): string {
  const list = issues.map((i) => `L${i.line}`).join(", ");
  return (
    `[tldrx] claim-sources: ${issues.length} malformed citation(s) in ${relPath} — ${list}.\n` +
    "The bullet cites a source but the token could not be read. The `[src: …]` token must be the LAST " +
    "thing on the line: remove the backticks around it and any words after it. A closing quote, bracket " +
    "or a final `.` after the `]` is fine."
  );
}

/**
 * The spec gives no verbatim text for a source that parses but does not resolve,
 * so this one is written in its voice. `[assumption]`
 */
export function claimSourcesUnresolvedDeny(
  relPath: string,
  issues: readonly { line: number; message: string }[],
): string {
  const detail = issues.map((i) => `L${i.line}: ${i.message}`).join("\n");
  return (
    `[tldrx] claim-sources: ${issues.length} unresolvable source(s) in ${relPath}.\n` +
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
