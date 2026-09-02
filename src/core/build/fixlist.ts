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
export const MAX_FIXLIST_ROUNDS = 1;

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

export interface FixFinding {
  /** 1-based, and stable: the number is how a human and a prompt refer to it. */
  readonly n: number;
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
  /** Has the fix landed? Written `no`; a human sets it. */
  readonly resolved: boolean;
}

/** A finding still owed work: `fix-now` and not yet resolved. */
export function isOpen(finding: FixFinding): boolean {
  return finding.disposition === "fix-now" && !finding.resolved;
}

export function openFindings(findings: readonly FixFinding[]): readonly FixFinding[] {
  return findings.filter(isOpen);
}

// --- the envelope ----------------------------------------------------------

export interface ParsedFixlist {
  readonly findings: readonly FixFinding[];
  /** Why this is not a readable fix list. Non-empty ⇒ the verdict is refused. */
  readonly problems: readonly string[];
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
  if (!Array.isArray(value)) {
    return { findings: [], problems: ["`fixlist` is missing or is not an array"] };
  }
  if (value.length === 0) {
    return { findings: [], problems: ["`fixlist` is empty — a fix list with no findings is an approval"] };
  }
  const findings: FixFinding[] = [];
  const problems: string[] = [];
  for (const [index, row] of (value as readonly unknown[]).entries()) {
    const at = index + 1;
    if (!isRecord(row)) {
      problems.push(`finding ${String(at)} is not an object`);
      continue;
    }
    const text = str(row.finding);
    if (text === "") {
      problems.push(`finding ${String(at)} has no \`finding\` text`);
      continue;
    }
    const disposition = row.disposition;
    if (typeof disposition !== "string" || !isDisposition(disposition)) {
      problems.push(
        `finding ${String(at)} has no valid \`disposition\` — one of ${DISPOSITIONS.join(", ")}`,
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
        problems.push(`finding ${String(at)} is \`refuted\` and its citation was not read — ${why}`);
        continue;
      }
    }
    findings.push({
      n: typeof row.n === "number" && Number.isInteger(row.n) && row.n > 0 ? row.n : at,
      severity: str(row.severity) === "" ? "unrated" : str(row.severity),
      finding: text,
      where,
      disposition,
      detail,
      doNot: Array.isArray(row.do_not)
        ? (row.do_not as readonly unknown[]).map(str).filter((line) => line !== "")
        : [],
      resolved: false,
    });
  }
  if (findings.length === 0 && problems.length === 0) {
    problems.push("`fixlist` yielded no readable findings");
  }
  return { findings, problems };
}

function isDisposition(value: string): value is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(value);
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
  const candidates = [where, ...detail.split("\n")].map((line) => line.trim());
  for (const candidate of candidates) {
    const token = parseSrcToken(candidate);
    if (token !== null && token.errors.length === 0 && token.refs.length > 0) return null;
  }
  for (const candidate of candidates) {
    const failure = diagnoseSrcToken(candidate);
    if (failure !== null) return describeSrcFailure(failure);
  }
  return "a refutation is a claim, and it carries its evidence or it is not one: `where`, or one "
    + "LINE of `detail`, must END with a `[src: …]` token that parses. "
    + `Write e.g. \`${srcRule("file-shape").good}\` — the full grammar is under `
    + `"${SRC_GRAMMAR_HEADING}" in your prompt.`;
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
    "> setting its `Resolved:` line to `yes`, or route it elsewhere by changing its",
    "> `Disposition:` — `defer-with-log` (it reaches the owner through `retro.md`),",
    "> `out-of-scope`, or `refuted`, which must carry an `[src: …]` proving the finding wrong.",
    "",
  ];
  for (const finding of parts.findings) {
    lines.push(
      `## ${String(finding.n)} · ${finding.finding}  [${finding.severity}]`,
      "",
      `Where: ${finding.where === "" ? "(not stated)" : finding.where}`,
      `Disposition: **${finding.disposition}**`,
      `Resolved: ${finding.resolved ? "yes" : "no"}`,
      "",
    );
    if (finding.detail !== "") lines.push(finding.detail, "");
    for (const line of finding.doNot) lines.push(`Do NOT: ${line}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const HEADING_RE = /^##\s+(\d{1,4})\s+·\s+(.+?)(?:\s+\[([^\]]*)\])?\s*$/;
const WHERE_RE = /^Where:\s*(.*)$/;
const DISPOSITION_RE = /^Disposition:\s*\*\*([a-z-]+)\*\*\s*(?:—\s*(.*))?$/;
const RESOLVED_RE = /^Resolved:\s*(\S+)/;
const DO_NOT_RE = /^Do NOT:\s*(.*)$/;
const STORY_RE = /^#\s+Fix list\s+—\s+(\S+)\s+·/;

/**
 * Read the artifact back — the half that makes the block possible.
 *
 * The file is EDITABLE by design: a host closes a finding by writing one word in
 * it, so the settle-time question ("is anything still open?") has to be asked of
 * the file on disk rather than of the envelope that produced it. Anything this
 * cannot parse is skipped rather than guessed at; a heading with no readable
 * disposition is not a finding, and inventing `fix-now` for it would block a
 * story over a typo.
 */
export function parseFixlistFile(text: string): readonly FixFinding[] {
  const findings: FixFinding[] = [];
  let current: {
    n: number; finding: string; severity: string;
    where: string; disposition: Disposition | null; resolved: boolean;
    detail: string[]; doNot: string[];
  } | null = null;
  const flush = (): void => {
    if (current === null || current.disposition === null) return;
    findings.push({
      n: current.n,
      severity: current.severity,
      finding: current.finding,
      where: current.where,
      disposition: current.disposition,
      detail: current.detail.join("\n").trim(),
      doNot: current.doNot,
      resolved: current.resolved,
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
        where: "", disposition: null, resolved: false, detail: [], doNot: [],
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
    const disposition = DISPOSITION_RE.exec(line);
    if (disposition !== null) {
      const value = disposition[1] ?? "";
      if (isDisposition(value)) current.disposition = value;
      continue;
    }
    const resolved = RESOLVED_RE.exec(line);
    if (resolved !== null) {
      current.resolved = (resolved[1] ?? "").toLowerCase() === "yes";
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
  return findings;
}

/** The story a fix-list file is about, from its own heading. */
export function fixlistStory(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = STORY_RE.exec(line);
    if (match !== null) return match[1] ?? null;
  }
  return null;
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
    rows.push({ round, path, rel: fixlistRel(phaseDir, storyId, round), findings: readFindings(path) });
  }
  return rows.sort((a, b) => a.round - b.round);
}

/** The latest round on disk, or null when this story never got one. */
export function latestFixlist(runDir: string, phaseDir: string, storyId: string): FixlistOnDisk | null {
  const rounds = fixlistRounds(runDir, phaseDir, storyId);
  return rounds[rounds.length - 1] ?? null;
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
  const findings = parseFixlistFile(text);
  if (findings.length === 0) return null;
  const round = Number(/-(\d{1,4})\.md$/.exec(path)?.[1] ?? "1");
  return { round: Number.isFinite(round) ? round : 1, path, rel, findings };
}

function readFindings(path: string): readonly FixFinding[] {
  try {
    return parseFixlistFile(readFileSync(path, "utf8"));
  } catch {
    return [];
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
        + (finding.resolved ? " (resolved)" : ""),
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
      `- \`${storyId}\` — reviewer finding DEFERRED (${finding.severity}): `
      + `${oneLine(finding.finding)}${finding.detail === "" ? "" : ` — ${oneLine(finding.detail)}`} ${src}`,
    );
}

/** One line: a summary that spans three is a bullet that breaks the list. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
