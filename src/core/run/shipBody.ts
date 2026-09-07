/**
 * The body `tldrx ship` puts on a pull request (issue #167).
 *
 * ## What was wrong
 *
 * `ship` sent the run's LAST phase handoff as the PR body, unedited. A Build
 * handoff is a GATE document: it opens `Blocked on: **human approval**` and
 * carries instructions addressed to the operator of the run — "these epic
 * branches are ready to merge, by hand". So every PR the verb opened led with an
 * instruction to somebody who was not reading it, and said nothing at all about
 * the two things a reviewer opens a PR to learn: what landed, and what is still
 * owed. A story sitting at `review`, and a `fix-now` reviewer finding nobody has
 * closed, were both invisible.
 *
 * ## What this renders, and the three rules it holds
 *
 * **The handoff goes in verbatim and is never edited.** It is the gate document,
 * other records cite it by line, and a PR that paraphrases it is a PR that
 * disagrees with the run. It is folded into a `<details>` block so it is complete
 * and not first.
 *
 * **Nothing here is re-derived.** The done/not-done split is READ off the handoff
 * (`text/handoff.ts` parses it, `build/handoff.ts` says how a bullet states its
 * status) rather than recomputed from the run — the document is what shipped. The
 * open findings arrive as a parameter, obtained by CALLING `build/fixlist.ts`;
 * this file never parses a fix list.
 *
 * **A finding is settled by evidence, not by this body.** `openFindings` is the
 * one implementation of that judgement (`fixlist.ts` `isOpen`: `fix-now`, and no
 * verified resolution sha). Whatever it hands over is listed; nothing here
 * decides that something has been dealt with.
 */
import { parseHandoff } from "../text/handoff.ts";
import { findingStatus } from "../build/handoff.ts";
import type { FixFinding } from "../build/fixlist.ts";
import type { CarriedRow, UnreadableStory } from "../build/carriedRows.ts";

/** One open fix-list finding, with the file it is still open in. */
export interface OpenFindingRow {
  /** Run-relative path of the fix list — every bullet cites its own. */
  readonly rel: string;
  readonly finding: FixFinding;
}

export interface ShipBodyParts {
  readonly runId: string;
  readonly title: string;
  readonly branch: string;
  /** The handoff text, verbatim — it goes inside the `<details>` block. */
  readonly handoff: string;
  readonly handoffRel: string;
  /** Open fix-list findings, from `build/fixlist.ts`. NEVER re-parsed here. */
  readonly openFindings: readonly OpenFindingRow[];
  /**
   * Carried findings (`defer-with-log`, unresolved) no story's declared surface
   * could be shown to cover, from `build/carriedRows.ts` (#171). NEVER re-derived
   * here.
   *
   * "Could be shown to cover" and not "whose path no `touches:` covers": the leaf
   * emits three kinds (`unownedFindings.ts` `REASONS`), and a `no-src` row's own
   * reason says there is no path to check at all — so a heading asserting a path
   * would contradict, in the same document, the row it introduces. Each row
   * carries its reason; the framing asserts no cause.
   *
   * The same rows the Build handoff's `## Unknowns` carries, from the same leaf:
   * `ship` runs in its own process, so it CALLS that leaf rather than holding a
   * second opinion about what "carried" or "unowned" means. Empty leaves the
   * section out entirely — an empty section would be a claim that this was
   * checked and found none, which is a different sentence from "nothing to say".
   */
  readonly carriedFindings: readonly CarriedRow[];
  /**
   * Story files the leaf could not read, with why (#171).
   *
   * Listed for the same reason the handoff lists them: an unread story takes its
   * fix list's carried findings out of the report with it, and a reader deciding
   * on this PR is owed the fact that something was not checked.
   */
  readonly unreadableStories: readonly UnreadableStory[];
}

/** `## Findings` in a handoff: one bullet per story, with its status in it. */
const FINDINGS = "Findings";
/** `## Unknowns` in a handoff: what did not settle, and who has to look at it. */
const UNKNOWNS = "Unknowns";

export function renderShipBody(parts: ShipBodyParts): string {
  const handoff = parseHandoff(parts.handoff);
  const bullets = (name: string): readonly string[] =>
    handoff.sections.find((section) => section.name === name)?.bullets.map((b) => b.text) ?? [];

  // Only what the document itself says reached `done`. A handoff from a phase
  // that writes no status per bullet (a Shape or What handoff) reports none, and
  // the empty line below says so rather than implying the run shipped nothing.
  const shipped = bullets(FINDINGS).filter((text) => findingStatus(text) === "done");
  const notDone = bullets(UNKNOWNS);

  const lines = [
    `# ${parts.title}`,
    "",
    `Run \`${parts.runId}\` · branch \`${parts.branch}\``,
    "",
    "## What shipped",
    "",
    ...(shipped.length === 0
      ? ["- (nothing settled `done` in this run)"]
      : shipped.map((text) => `- ${text}`)),
    "",
    "## Not done",
    "",
    ...(notDone.length === 0 ? ["- none"] : notDone.map((text) => `- ${text}`)),
    "",
  ];

  if (parts.openFindings.length > 0) {
    lines.push(
      "## Open findings",
      "",
      "Reviewer findings still dispositioned `fix-now`, with no resolution commit the",
      "fix list can point at:",
      "",
      ...parts.openFindings.map((row) =>
        `- ${String(row.finding.n)} · ${row.finding.finding} [${row.finding.severity}] — \`${row.rel}\``),
      "",
    );
  }

  if (parts.carriedFindings.length > 0 || parts.unreadableStories.length > 0) {
    lines.push(
      "## Carried findings",
      "",
      "Reviewer findings this run deliberately did NOT fix (`defer-with-log`) that no story's declared",
      "surface could be shown to cover — each row says why:",
      "",
      ...parts.carriedFindings.map((row) =>
        `- ${String(row.row.finding.n)} · ${row.row.finding.finding} [${row.row.finding.severity}] — `
        + `${row.row.reason} — \`${row.rel}\``),
      ...parts.unreadableStories.map((row) =>
        `- a story file could not be read, so its carried findings were not checked: `
        + `\`${row.rel}\` — ${row.reason}`),
      "",
    );
  }

  // Concatenated rather than pushed as lines, so the handoff crosses this
  // function as ONE string and `body.includes(handoff)` stays true whatever it
  // ends with. The blank lines around the block are markdown's, not decoration:
  // an HTML block butted against a list item, or against the text inside it, is
  // rendered as literal text by every CommonMark parser GitHub runs.
  return `${lines.join("\n")}\n<details>\n<summary>The full handoff (${parts.handoffRel})</summary>\n\n`
    + `${parts.handoff}\n</details>\n`;
}
