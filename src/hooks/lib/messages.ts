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

export function budgetGateDeny(
  stage: string,
  phase: string,
  left: number,
  ceiling: number,
  estimate: number,
): string {
  return (
    `[tldrx] budget-gate: refusing to start stage "${stage}" — phase ${phase} has ${usd(left)} left of ` +
    `${usd(ceiling)} and the stage estimate is ${usd(estimate)}. Raise phases[${phase}].ceiling_usd in ` +
    `budget.yml, lower budget_usd in .tldrx/stages/${stage}/stage.yml, or set on_exceed: warn.`
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
