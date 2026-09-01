/**
 * `tldrx retro --all` — cross-run mining of what the loop kept catching (#64).
 *
 * Every run already leaves the gold: a reviewer's verdict and its findings in
 * `04-build/log/<story>.md`, a fix list with a DISPOSITION per finding in
 * `04-build/fixlist/<story>-<n>.md`, a `## Build feedback` section in `retro.md`,
 * and a `story.reopened` event carrying the operator's reason. Across the first
 * six real runs the same finding CLASSES kept coming back — structure built and
 * never reached, a comment that lies about the code beside it, a test that cannot
 * fail, no negative control, an authorization that did not widen with the scope —
 * and nobody aggregated them, because nothing read more than one run at a time.
 *
 * Three properties are the whole design:
 *
 *   - **It is a READER.** Not one byte is written anywhere: no state, no cache,
 *     no `retro.md`, no `practices.md`. A command a person runs out of curiosity
 *     must be safe to run out of curiosity.
 *   - **Every count is deterministic.** The classifier is ordered keyword rules
 *     over text — no model, no scoring, no threshold — so the same tree always
 *     produces the same table, and a rule that misfires can be pointed at.
 *   - **Absence is never an error.** A run with no Build phase, no retro, no
 *     events log, or an unreadable one, contributes what it has and is counted.
 *     The aggregate is over the runs that exist, and it says how many that was.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRuns, runDir } from "../replay/loadRun.ts";
import { BUILD_PHASE, LOG_DIR } from "../build/plan.ts";
import { FIXLIST_DIR, parseFixlistFile, type Disposition } from "../build/fixlist.ts";
import { BUILD_RETRO_SECTION, RETRO_FILE } from "../build/retroLog.ts";
import { RETRO_SECTIONS } from "./renderRetro.ts";

/**
 * The taxonomy. Small on purpose, and ORDERED: the classifier takes the first
 * rule that matches, so this list is also the precedence.
 *
 * The order is by how specific the evidence is, not by how much the class
 * matters. `test-cannot-fail` and `missing-negative-control` fire on phrases that
 * mean one thing only. `authorization-not-widened` sits below `stale-comment`
 * deliberately: the S5 finding that produced both classes — "a false security
 * comment beside a non-constant-time compare" — is a defect IN THE COMMENT, and a
 * security keyword appearing anywhere in a sentence would otherwise swallow every
 * finding that mentions auth in passing.
 *
 * `other` is last and matches everything. It is a real answer, not a failure:
 * a table where `other` dominates is telling you the taxonomy is too small, which
 * is a finding about this command rather than about the runs.
 */
export const FINDING_CLASSES = [
  "test-cannot-fail",
  "missing-negative-control",
  "unreachable-structure",
  "stale-comment",
  "authorization-not-widened",
  "schema-drift",
  "other",
] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

/** Where one mined line came from. The kind is kept because it is evidence too. */
export type FindingKind =
  /** The reviewer's own summary on a `changes` verdict. */
  | "verdict"
  /** A bullet under `## Findings` in a review log. */
  | "review-finding"
  /** A fix-list finding routed `fix-now` or `out-of-scope`. */
  | "fixlist"
  /** A fix-list finding routed `defer-with-log` — a defect the team chose not to fix yet. */
  | "deferred"
  /** A bullet in `retro.md` that no primary artefact accounted for. */
  | "retro-bullet"
  /** The operator's reason on a `story.reopened` event. */
  | "reopen";

export interface MinedFinding {
  readonly run: string;
  readonly kind: FindingKind;
  /** What is shown. One line; the classifier may have read more than this. */
  readonly text: string;
  /** The §2.8 token, always resolvable from the workspace root. */
  readonly src: string;
  readonly cls: FindingClass;
}

export interface ClassTrend {
  readonly cls: FindingClass;
  readonly count: number;
  /** The run ids this class was seen in, sorted. */
  readonly runs: readonly string[];
  /** The first occurrence, in mining order. Never null when `count > 0`. */
  readonly example: MinedFinding | null;
}

export interface AllRetro {
  readonly root: string;
  /** Every run folder read, newest first. */
  readonly runs: readonly string[];
  /** The subset that yielded at least one finding. */
  readonly contributed: readonly string[];
  readonly findings: readonly MinedFinding[];
  /** Lines dropped because a primary artefact already accounted for them. */
  readonly deduped: number;
  readonly trends: readonly ClassTrend[];
}

// --- the rules ---------------------------------------------------------------

/**
 * One rule per class, each a list of alternatives. They are written to fire on
 * how a reviewer actually phrases the thing, not on the class name: nobody has
 * ever written "unreachable-structure" in a finding.
 */
const RULES: readonly (readonly [FindingClass, readonly RegExp[]])[] = [
  ["test-cannot-fail", [
    /cannot fail/i,
    /can(?:no|')t fail/i,
    /always passe?s/i,
    /\btautolog/i,
    /asserts? nothing/i,
    /no assertions?\b/i,
    /\bvacuous/i,
    /tests? nothing/i,
    /would (?:still )?pass (?:even )?(?:if|without|with)/i,
    /passes with the (?:code|implementation|line) (?:removed|deleted|commented)/i,
  ]],
  ["missing-negative-control", [
    /negative control/i,
    /negative (?:test|case|path)/i,
    /happy[- ]path/i,
    /no (?:failure|error|refusal) (?:case|test|path)/i,
    /does(?:n't| not) (?:test|cover|exercise) the (?:failure|error|unhappy|refus)/i,
    /never tests? the (?:refus|reject|fail|denial)/i,
  ]],
  ["unreachable-structure", [
    /unreachable/i,
    /not reachable/i,
    /never (?:called|invoked|reached|registered|wired|used|exported|mounted)/i,
    /\bno caller/i,
    /dead code/i,
    /\borphan/i,
    /built but (?:not|never)/i,
    /not (?:wired|registered|routed)\b/i,
    /nothing (?:calls|implements|references) it/i,
  ]],
  ["stale-comment", [
    /stale comment/i,
    /comments?[^.]{0,60}\b(?:claim|says?|state[sd]?|describ|assert|lie|wrong|false|outdated)/i,
    /\bdocstring/i,
    /comment (?:no longer|contradicts|is misleading)/i,
    /misleading comment/i,
  ]],
  ["authorization-not-widened", [
    /\b(?:authoriz|authentic|unauthoriz|permission|privilege|access control|acl|rls|tenant|otp|credential|password|secret|constant[- ]time)/i,
    /\bmint\w*\b[^.]{0,60}\bsessions?\b/i,
    /session (?:fixation|hijack)/i,
  ]],
  ["schema-drift", [
    /\bschema\b/i,
    /\bmigration/i,
    /\bdrift/i,
    /out of sync with/i,
    /\bdtos?\b/i,
    /\bcontracts?\b[^.]{0,40}\b(?:disagree|diverge|mismatch|no longer)/i,
    /(?:type|interface) no longer matches/i,
  ]],
];

/** The first rule that matches, else `other`. Deterministic; no model runs. */
export function classify(text: string): FindingClass {
  for (const [cls, patterns] of RULES) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return cls;
    }
  }
  return "other";
}

// --- mining one run ----------------------------------------------------------

/**
 * `[src: tldrx-work/<run>/<rel>:<line>]` — the §2.8 grammar every other claim in
 * this framework is held to, so a row of the table can be gone and checked.
 */
function src(run: string, rel: string, line: number): string {
  return `[src: tldrx-work/${run}/${rel}:${String(line)}]`;
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

const VERDICT_RE = /^-\s+Verdict:\s+\*\*([a-z-]+)\*\*/;

/**
 * A review log's `changes` summary and every bullet under `## Findings`.
 *
 * The summary is mined ONLY on `changes`, and that is the whole judgement here:
 * on `approve` it says nothing was wrong, on `error` it is a transport failure
 * with no opinion in it, and on `fixlist` the findings live in the fix-list file
 * with dispositions attached — mining the summary there would count them twice
 * with the routing thrown away.
 */
function fromReviewLog(run: string, rel: string, text: string): readonly MinedFinding[] {
  const lines = text.split("\n");
  const found: MinedFinding[] = [];
  let verdict = "";
  let section = "";

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading !== null) {
      section = heading[1] ?? "";
      continue;
    }
    const asVerdict = VERDICT_RE.exec(raw);
    if (asVerdict !== null) {
      verdict = asVerdict[1] ?? "";
      continue;
    }
    if (section === "Summary" && verdict === "changes" && raw.trim() !== ""
      && !raw.startsWith(">") && !raw.startsWith("**")) {
      // The first prose line under the heading is the reviewer's sentence; the
      // rest of the section elaborates it and would be counted as second findings.
      if (!found.some((item) => item.kind === "verdict")) {
        found.push(mined(run, "verdict", raw.trim(), src(run, rel, line)));
      }
      continue;
    }
    if (section === "Findings" && raw.startsWith("- ") && raw.trim() !== "- none") {
      found.push(mined(run, "review-finding", raw.slice(2).trim(), src(run, rel, line)));
    }
  }
  return found;
}

/** `## <n> · <finding>` -> the 1-based line it is on. */
function fixlistHeadingLines(text: string): ReadonlyMap<number, number> {
  const lines = new Map<number, number>();
  for (const [index, raw] of text.split("\n").entries()) {
    const match = /^##\s+(\d{1,4})\s+·/.exec(raw);
    if (match !== null) lines.set(Number(match[1] ?? "0"), index + 1);
  }
  return lines;
}

/**
 * Fix-list findings, minus the refuted ones.
 *
 * `refuted` is the one disposition that says the reviewer was WRONG — and it may
 * only be written with an `[src: …]` proving it. Ranking a class by findings that
 * were disproven would make the table a report on the reviewer's mistakes rather
 * than on the code's, so refutations are read and dropped.
 */
function fromFixlist(run: string, rel: string, text: string): readonly MinedFinding[] {
  const headings = fixlistHeadingLines(text);
  const found: MinedFinding[] = [];
  for (const finding of parseFixlistFile(text)) {
    const disposition: Disposition = finding.disposition;
    if (disposition === "refuted") continue;
    const kind: FindingKind = disposition === "defer-with-log" ? "deferred" : "fixlist";
    found.push(mined(
      run, kind, finding.finding, src(run, rel, headings.get(finding.n) ?? 1),
      `${finding.finding} ${finding.where} ${finding.detail}`,
    ));
  }
  return found;
}

/** The H2s of `retro.md` this reads. Practice proposals are process, and count too. */
const RETRO_SECTIONS_MINED: readonly string[] = [BUILD_RETRO_SECTION, RETRO_SECTIONS[1]];

function fromRetro(run: string, text: string): readonly MinedFinding[] {
  const found: MinedFinding[] = [];
  let inside = false;
  for (const [index, raw] of text.split("\n").entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading !== null) {
      inside = RETRO_SECTIONS_MINED.includes(heading[1] ?? "");
      continue;
    }
    if (!inside || !raw.startsWith("- ")) continue;
    found.push(mined(run, "retro-bullet", raw.slice(2).trim(), src(run, RETRO_FILE, index + 1)));
  }
  return found;
}

/**
 * `story.reopened` notes.
 *
 * Read line by line with its own tolerant parser rather than through `loadRun`,
 * because a run whose `run.yml` will not parse still has an events log, and the
 * whole point of this command is that a broken artefact costs the aggregate that
 * artefact and nothing more.
 */
function fromEvents(run: string, text: string): readonly MinedFinding[] {
  const found: MinedFinding[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    let event: { type?: unknown; payload?: { note?: unknown; story?: unknown } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "story.reopened") continue;
    const note = typeof event.payload?.note === "string" ? event.payload.note.trim() : "";
    if (note === "") continue;
    found.push(mined(run, "reopen", note, src(run, "events.jsonl", index + 1)));
  }
  return found;
}

/**
 * A finding's own `[src: …]` token is removed from BOTH the shown text and the
 * text the rules read.
 *
 * From the shown text because the row already carries a citation — this module's
 * own, which always resolves, rather than the artefact's claim about where the
 * defect was. From the classified text because a token is a FILE PATH, and a rule
 * matching `…/migrations/0007.sql` would be classifying the tree layout instead
 * of the finding.
 */
function withoutSrc(text: string): string {
  return text.replace(/\s*\[src:[^\]]*\]/g, " ");
}

function mined(
  run: string, kind: FindingKind, text: string, source: string, classifyOn?: string,
): MinedFinding {
  return {
    run,
    kind,
    text: oneLine(withoutSrc(text)),
    src: source,
    cls: classify(withoutSrc(classifyOn ?? text)),
  };
}

/**
 * The dedup key: lowercase, `[src: …]` removed, everything else collapsed to
 * single spaces.
 *
 * Collapsing punctuation is what makes CONTAINMENT work, and containment is what
 * the retro needs: `appendBuildRetro` writes a deferred finding as
 * "`S5` — reviewer finding DEFERRED (medium): <heading> — <detail>", which embeds
 * the fix list's heading verbatim. Equality would miss it; a label allowlist
 * would rot the first time a label was reworded.
 */
function dedupKey(text: string): string {
  return text.toLowerCase().replace(/\[src:[^\]]*\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Short keys are not compared, because containment over a fragment is a false
 * positive waiting to happen: "no caller" is inside a dozen unrelated sentences.
 */
const MIN_DEDUP_KEY = 20;

/** One run's findings, in source order, with same-run repeats collapsed. */
export function mineRun(root: string, run: string): { findings: readonly MinedFinding[]; deduped: number } {
  const dir = runDir(root, run);
  const logDir = join(dir, BUILD_PHASE, LOG_DIR);
  const fixDir = join(dir, BUILD_PHASE, FIXLIST_DIR);

  const candidates: MinedFinding[] = [];
  for (const entry of listFiles(logDir)) {
    const rel = `${BUILD_PHASE}/${LOG_DIR}/${entry}`;
    const text = readText(join(logDir, entry));
    if (text !== null) candidates.push(...fromReviewLog(run, rel, text));
  }
  for (const entry of listFiles(fixDir)) {
    const rel = `${BUILD_PHASE}/${FIXLIST_DIR}/${entry}`;
    const text = readText(join(fixDir, entry));
    if (text !== null) candidates.push(...fromFixlist(run, rel, text));
  }
  const retro = readText(join(dir, RETRO_FILE));
  if (retro !== null) candidates.push(...fromRetro(run, retro));
  const events = readText(join(dir, "events.jsonl"));
  if (events !== null) candidates.push(...fromEvents(run, events));

  const kept: MinedFinding[] = [];
  const keys: string[] = [];
  let deduped = 0;
  for (const candidate of candidates) {
    const key = dedupKey(candidate.text);
    if (key === "") continue;
    if (keys.some((seen) => overlaps(seen, key))) {
      deduped += 1;
      continue;
    }
    keys.push(key);
    kept.push(candidate);
  }
  return { findings: kept, deduped };
}

function overlaps(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= MIN_DEDUP_KEY && longer.includes(shorter);
}

// --- the aggregate -----------------------------------------------------------

export function mineAll(root: string): AllRetro {
  const runs = listRuns(root);
  const findings: MinedFinding[] = [];
  const contributed: string[] = [];
  let deduped = 0;

  for (const run of runs) {
    const mined = mineRun(root, run);
    deduped += mined.deduped;
    if (mined.findings.length === 0) continue;
    contributed.push(run);
    findings.push(...mined.findings);
  }
  return { root, runs, contributed, findings, deduped, trends: trendsOf(findings) };
}

/** Ranked by count, ties broken by the taxonomy's own order — never by chance. */
function trendsOf(findings: readonly MinedFinding[]): readonly ClassTrend[] {
  const trends: ClassTrend[] = [];
  for (const cls of FINDING_CLASSES) {
    const of = findings.filter((finding) => finding.cls === cls);
    if (of.length === 0) continue;
    trends.push({
      cls,
      count: of.length,
      runs: [...new Set(of.map((finding) => finding.run))].sort(),
      example: of[0] ?? null,
    });
  }
  return trends.sort((a, b) =>
    b.count - a.count || FINDING_CLASSES.indexOf(a.cls) - FINDING_CLASSES.indexOf(b.cls));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
