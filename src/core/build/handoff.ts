/**
 * `04-build/handoff.md`, written by the executor rather than by a model.
 *
 * Every other phase asks a sub-agent for its handoff and validates it afterwards.
 * The Build phase does not need to: it RAN the commands, it holds the exit codes,
 * and it knows which branch merged. A model asked to summarise that could only
 * paraphrase it, and would occasionally paraphrase it wrong.
 *
 * So the four §2.8 sections are generated:
 *   Findings        one per story, sourced to its review log
 *   Decisions       what the phase did to the branch graph, and what it refused to do
 *   Unknowns        the stories that are not done, or `- none` with what was looked at
 *   Evidence ledger every dod command that ran, as `[src: $ <cmd> → exit <n>]`
 */
import { DOD_REFUSAL_FALLBACK, dodRefused } from "./outcome.ts";
import type { StoryOutcome } from "./outcome.ts";
import type { CarriedRow, UnreadableStory } from "./carriedRows.ts";
import { PLAN_STATUSES, type PlanStatus } from "../schemas/planCommon.ts";

export interface EpicSummaryRow {
  readonly id: string;
  readonly branch: string;
  readonly repos: readonly string[];
  /** Stories whose merge actually moved commits onto the epic branch. */
  readonly merged: readonly string[];
  /**
   * Stories whose branch was already identical to the epic, so `git merge`
   * exited 0 and moved nothing.
   *
   * They are listed apart from `merged` because a reader of this section is
   * deciding what to ship, and "S3, S4, S5, S7 merged" told them four stories
   * had landed when the epic tip carried one (run
   * `260830-tenancy-identity-customers`, 2026-08-30).
   */
  readonly emptyMerges?: readonly string[];
  /**
   * Stories known to be ON this epic branch whose merge THIS invocation did not
   * watch — a story settled by an earlier `tldrx next`, or one whose errored
   * review is being re-run over a diff that merged in an earlier process.
   *
   * They are a third list because they are a third fact. `merged` and
   * `emptyMerges` are both MEASUREMENTS: `commitsBetween` was run before the
   * merge, and afterwards it cannot be — once the story branch is an ancestor of
   * the epic, `git diff <epic>...<story>` is empty whether it carried thirty
   * commits or none. So what these stories carried is not recoverable, and the
   * row says so instead of picking a side. Folding them into `merged` overclaims
   * (the 2026-08-30 empty-merge trap); leaving them out UNDERclaims, and that is
   * the direction #137 measured: a `epic/e1` carrying two merge commits was
   * reported as `(no story merged)`.
   */
  readonly mergedEarlier?: readonly string[];
  readonly defaultBranches: readonly string[];
  /** Run-relative path of `03-plan/epics/<id>.md`. */
  readonly rel: string;
}

export interface BuildHandoffParts {
  readonly runId: string;
  readonly stageId: string;
  readonly model: string | null;
  /**
   * What the PHASE has spent, not what the invocation that wrote this file spent
   * (#138). The executor sources it from `run.yml`; see `phaseCostToDate`.
   */
  readonly costUsd: number;
  /**
   * Why `costUsd` is not the whole answer, when it is not — rendered in brackets
   * after the ceiling. `null`/absent means the figure needs no caveat.
   *
   * The absent-with-reason idiom, on a line that had been printing a confident
   * `$0.00` for a phase that had spent $0.44. A number this run cannot produce
   * and a number that is genuinely zero must not read identically.
   */
  readonly costNote?: string | null;
  /**
   * How many of this run's recorded decisions name a decider (#169) — the same
   * sentence the close prints, on the header rather than as a `## Decisions`
   * bullet. Deliberately the header: every list item in a §2.8 section must
   * carry a `[src: …]` token or `claim-sources` refuses the document, and a
   * count over a whole file has no one line to cite.
   *
   * Absent or null means the run recorded no facts, and the header says nothing.
   */
  readonly decidedNote?: string | null;
  readonly budgetUsd: number;
  readonly at: string;
  readonly outcomes: readonly StoryOutcome[];
  readonly epics: readonly EpicSummaryRow[];
  /**
   * Run-relative path of the file the stories were read from and written back to,
   * when it is NOT `03-plan/stories/<id>.md` — a scope that skips the Plan phase
   * keeps both in one `04-build/implicit-plan.yml` (`build/implicitPlan.ts`).
   * Absent or null means the ordinary per-story path.
   */
  readonly storiesRel?: string | null;
  /**
   * Carried findings (`defer-with-log`, unresolved) that no story's declared
   * surface could be shown to cover, computed by `build/carriedRows.ts` and
   * HANDED here — this file parses no fix list and applies no predicate of its
   * own (#171).
   *
   * "Could be shown to cover", not "whose path no `touches:` covers": the leaf
   * emits THREE kinds and only one of them is about a path a story missed
   * (`unownedFindings.ts` `REASONS`). The other two are `unqualified` (the
   * citation names no repo) and `no-src` (there is no path in `where:` at all),
   * and a heading asserting a path would contradict the reason the row itself
   * carries. Each bullet states its own reason; the framing states none.
   *
   * They go in `## Unknowns` and not in a fifth section on purpose:
   * `validateSections` only checks bullets inside the four required sections
   * (`text/handoff.ts:387`), so a fifth section's claims would be the one part of
   * the document nothing validates — precisely the hole §2.8 exists to close.
   * `## Unknowns` is also where they belong by meaning: it already holds "this
   * needs a human".
   *
   * Absent behaves exactly as empty. It is NOT byte-identical to the section
   * before this field existed, and must not be: the `none` sentence now answers
   * for both lists, because a document that says "nothing needs a human" while
   * listing something that does is worse than one that says neither.
   */
  readonly carried?: readonly CarriedRow[];
  /**
   * Story files the walk could not read, from the same leaf (#171).
   *
   * Their fix lists are still on disk and still carry defects, so an unread story
   * silently takes carried findings out of this report with it. Named here with
   * WHY — absent-with-reason — and cited `[src: absent:<rel>]`, which resolves as
   * `noted`: legal, never fatal, never silent (gh #110). A report-only feature
   * must not be able to fail a document.
   */
  readonly unreadableStories?: readonly UnreadableStory[];
}

/**
 * How many carried rows get a bullet of their own before the rest close with one
 * summarising line.
 *
 * A BOUND, not a preference. `validateHandoff` turns a document of more than
 * `MAX_BULLETS` (200) list items into an `unresolved` entry (`text/handoff.ts`),
 * and `run/checks.ts` turns any `describeHandoff` failure into
 * `claim-sources = failed` — so an uncapped list would let a REPORT-ONLY feature
 * block a stage through arithmetic. Carried findings therefore contribute at most
 * `MAX_CARRIED_BULLETS + 1` bullets to `## Unknowns`, however many arrive.
 *
 * Past the cap nothing is dropped: the closing bullet names how many more there
 * are and cites the fix list, which is a claim with evidence behind it rather
 * than a truncated list that silently under-reports what is owed.
 */
export const MAX_CARRIED_BULLETS = 25;

export function renderBuildHandoff(parts: BuildHandoffParts): string {
  const done = parts.outcomes.filter((o) => o.status === "done");
  const notDone = parts.outcomes.filter((o) => o.status !== "done");

  const lines = [
    `# Handoff — 04-build / ${parts.stageId} — run ${parts.runId}`,
    `Stage: ${parts.stageId} · Expert: developer + reviewer · Model: ${parts.model ?? "default"} · ` +
      `Cost: $${parts.costUsd.toFixed(2)} of $${parts.budgetUsd.toFixed(2)} ceiling` +
      `${parts.costNote == null ? "" : ` (${parts.costNote})`}` +
      `${parts.decidedNote == null ? "" : ` · ${parts.decidedNote}`} · ${parts.at}`,
    "",
    "## Findings",
    "",
    ...(parts.outcomes.length === 0
      ? ["- no story was scheduled for this run [src: absent:03-plan/waves.yml]"]
      : parts.outcomes.map(finding)),
    "",
    "## Decisions",
    "",
    ...decisions(parts),
    "",
    "## Unknowns",
    "",
    // The `none` sentence answers for EVERY list this section carries, because it
    // is read as "nothing here needs a human": a document that said so while
    // listing a carried finding nobody owns, or a story file it could not read,
    // would be worse than one that said neither.
    ...(notDone.length === 0 && (parts.carried ?? []).length === 0
      && (parts.unreadableStories ?? []).length === 0
      ? [`- none — every scheduled story reached \`done\` and no carried finding is unowned `
        + `[src: absent:04-build/log]`]
      : []),
    ...notDone.map(
      (o) =>
        `- ${o.id} is \`${o.status}\` and needs a human: ${o.reason ?? "see the review"} ` +
        `[src: ${o.reviewRel}:1]`,
    ),
    ...carriedBullets(parts.carried ?? []),
    ...(parts.unreadableStories ?? []).map((row) =>
      `- a story file could not be read, so its carried findings were not checked: ` +
      `\`${row.rel}\` — ${row.reason} [src: absent:${row.rel}]`),
    "",
    "## Evidence ledger",
    "",
    ...ledger(parts.outcomes),
    "",
    "## Outputs written",
    "",
    ...(parts.outcomes.length === 0
      ? ["- (nothing)"]
      : parts.outcomes.map((o) => `- \`${o.reviewRel}\` — the review log for ${o.id}`)),
    ...done.map((o) =>
      `- \`${parts.storiesRel ?? `03-plan/stories/${o.id}.md`}\` — status \`done\`, evidence written`),
    "",
    "## Gate",
    "",
    "Blocked on: **human approval**. These epic branches are ready to merge, by hand,",
    "into the branch named beside them — nothing in this phase pushed, and nothing in it",
    "merged an epic into a default branch:",
    "",
    ...(parts.epics.length === 0
      ? ["- (no epic branch was written)"]
      : gateRows(parts.epics).map(
          (e) =>
            `- \`${e.branch}\` in ${e.repos.join(", ")} → \`${e.defaultBranches.join(", ")}\` ` +
            `(${mergeSummary(e)})`,
        )),
    "",
  ];
  return lines.join("\n");
}

/**
 * One Gate row per BRANCH, not per epic (issue #57).
 *
 * A run whose epics form a dependency chain merges every story into one
 * integration branch, so the per-epic rows all name the same branch. Listing it
 * three times, each with a third of the stories, tells a reader deciding what to
 * merge that there are three things to merge. Grouping is a no-op under
 * `per-epic`, where every epic has a branch of its own.
 */
function gateRows(epics: readonly EpicSummaryRow[]): readonly EpicSummaryRow[] {
  const byBranch = new Map<string, EpicSummaryRow>();
  for (const epic of epics) {
    const seen = byBranch.get(epic.branch);
    if (seen === undefined) {
      byBranch.set(epic.branch, epic);
      continue;
    }
    byBranch.set(epic.branch, {
      ...seen,
      id: `${seen.id}, ${epic.id}`,
      repos: unique([...seen.repos, ...epic.repos]),
      merged: unique([...seen.merged, ...epic.merged]),
      emptyMerges: unique([...(seen.emptyMerges ?? []), ...(epic.emptyMerges ?? [])]),
      mergedEarlier: unique([...(seen.mergedEarlier ?? []), ...(epic.mergedEarlier ?? [])]),
      defaultBranches: unique([...seen.defaultBranches, ...epic.defaultBranches]),
    });
  }
  return [...byBranch.values()];
}

function unique(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}

/**
 * What actually landed on this epic branch, in the parentheses a human reads
 * before deciding whether to merge it.
 *
 * A no-op merge is named as one. `git merge --no-ff` of a branch that is already
 * an ancestor exits 0 and moves nothing, and the old rendering — one flat list
 * ending in "merged" — reported four such branches as landed work on
 * `260830-tenancy-identity-customers`.
 *
 * A merge this process did not WATCH is named as that, third (#137). The
 * alternative on offer was to say nothing about it, and saying nothing is what
 * printed `(no story merged)` over an epic branch carrying two merge commits —
 * the same sentence as the 2026-08-30 defect, arriving from the other side.
 * "Not re-measured" plus the command that settles it is the only claim this
 * function has the evidence for.
 */
function mergeSummary(epic: EpicSummaryRow): string {
  const empty = epic.emptyMerges ?? [];
  const earlier = epic.mergedEarlier ?? [];
  const parts: string[] = [];
  if (epic.merged.length > 0) parts.push(`${epic.merged.join(", ")} merged`);
  if (empty.length > 0) {
    parts.push(`${empty.join(", ")} added nothing — identical to \`${epic.branch}\``);
  }
  if (earlier.length > 0) {
    parts.push(
      `${earlier.join(", ")} merged by an earlier \`tldrx next\` — what each carried was not ` +
        `re-measured here, run \`git log ${epic.branch}\``,
    );
  }
  return parts.length === 0 ? "no story merged" : parts.join("; ");
}

/**
 * How a `## Findings` bullet states its story's status, as a pattern.
 *
 * `finding()` below writes `<id> · <title> — <status> — …`, and `run/shipBody.ts`
 * reads it back to say what SHIPPED in a PR body. That is one derivation with two
 * users, so it lives here, beside the renderer it has to agree with: a second
 * regex over in `run/` would go on matching the day this sentence changed shape,
 * and a PR body that quietly reports nothing as done is worse than one that
 * reports the wrong thing loudly.
 *
 * `[assumption]` the first ` — <status> — ` in a bullet is the story's status.
 * A title carrying one of the five status words between em dashes would fool it;
 * the whole handoff sits in the body below, so the reader can always check.
 */
const FINDING_STATUS_RE = new RegExp(`—\\s+(${PLAN_STATUSES.join("|")})\\s+—`);

/** The status a Findings bullet reports, or null when it names none. */
export function findingStatus(bullet: string): PlanStatus | null {
  const found = FINDING_STATUS_RE.exec(bullet)?.[1];
  return found === undefined ? null : (found as PlanStatus);
}

function finding(outcome: StoryOutcome): string {
  const where = `repo \`${outcome.repo}\`, \`${outcome.branch}\``;
  const landed = outcome.carried === 0
    // Green, and it moved nothing. Both halves are true and the second is the
    // one a reader would otherwise supply wrongly from the word "merged".
    ? `done — ${where}, but its branch is identical to \`${outcome.epicBranch}\`: nothing was merged`
    : `done — ${where}, merged into \`${outcome.epicBranch}\` at ${outcome.commit ?? "(no commit)"}`;
  const head = outcome.status === "done"
    ? landed
    : `${outcome.status} — ${where}: ${outcome.reason ?? "see the review"}`;
  return `- ${outcome.id} · ${outcome.title} — ${head} [src: ${outcome.reviewRel}:1]`;
}

/**
 * One `## Unknowns` bullet per carried row, capped and never truncated (#171).
 *
 * The citation is the RUN-RELATIVE fix-list path — `[src: <rel>:1]` — which is
 * how every other bullet in this document spells one (`finding()` cites
 * `o.reviewRel` the same way), and `pathBases` resolves a bare `file` path
 * against the workspace root first and the run dir second. Spec §3.2 suggested a
 * `tldrx-work/<run>/…` prefix; one document carrying two spellings of one
 * citation is worse than a document that disagrees with a sentence in the spec,
 * and this deviation is deliberate.
 */
function carriedBullets(rows: readonly CarriedRow[]): readonly string[] {
  const shown = rows.slice(0, MAX_CARRIED_BULLETS);
  const bullets = shown.map((row) =>
    `- a carried finding no story could be shown to own: ${row.row.finding.finding} `
    + `[${row.row.finding.severity}] — ${row.row.reason} [src: ${row.rel}:1]`);
  if (rows.length <= MAX_CARRIED_BULLETS) return bullets;
  const first = rows[0];
  return [
    ...bullets,
    `- +${String(rows.length - MAX_CARRIED_BULLETS)} more carried findings — see the fix list `
    + `[src: ${first === undefined ? "absent:04-build/fixlist" : `${first.rel}:1`}]`,
  ];
}

function decisions(parts: BuildHandoffParts): readonly string[] {
  const anchor = parts.outcomes[0]?.reviewRel ?? null;
  const rows: string[] = [];
  for (const epic of parts.epics) {
    rows.push(
      `- ${epic.id} is built on \`${epic.branch}\` and left unmerged for a human ` +
        `[src: ${epic.rel}:1]`,
    );
  }
  // Said out loud, once, rather than left to be inferred from three rows that
  // happen to name the same branch (issue #57).
  const shared = gateRows(parts.epics).filter((row) => row.id.includes(", "));
  for (const row of shared) {
    rows.push(
      `- ${row.id} form a dependency chain, so they share the one integration branch ` +
        `\`${row.branch}\` — the epics are labels here, not branches ` +
        `[src: ${parts.epics.find((e) => e.branch === row.branch)?.rel ?? row.rel}:1]`,
    );
  }
  if (anchor !== null) {
    rows.push(
      "- Nothing was pushed and no epic was merged into a default branch — the phase " +
        `ends at the gate below [src: ${anchor}:1]`,
    );
  }
  if (rows.length === 0) {
    rows.push("- nothing was built, so nothing was decided [src: absent:03-plan/waves.yml]");
  }
  return rows;
}

/**
 * Spec §2.8: `cmd` sources are legal only here, and only for a command
 * `workspace.yml` declares. A story's dod block is already checked against that
 * set by the §2.13 validator, so every command that reaches this point qualifies.
 *
 * The fallback row is a NEGATIVE claim, so it is only allowed to be written when
 * the negative is what was found (#137). A story whose declared commands ran in
 * an earlier `tldrx next` and whose exit codes this process could not read is
 * not "no Definition of Done ran" — it is a row of its own, naming the command
 * and the log that recorded the result, because an absence has to say what was
 * looked at or it is not evidence.
 */
function ledger(outcomes: readonly StoryOutcome[]): readonly string[] {
  const rows: string[] = [];
  for (const outcome of outcomes) {
    for (const result of outcome.dod) {
      // A command the gate REFUSED never ran, so it has no `cmd` citation to
      // give: `src/core/text/srcToken.ts:10` defines `cmd := "$ " command
      // " → exit " digit+`, and there is no exit. The citation is the review
      // log, where the refusal is written verbatim — the same shape the
      // `dodUnrecovered` rows below already use (#165).
      rows.push(
        dodRefused(result)
          ? `- ${outcome.id}: \`${result.command}\` in ${outcome.repo} was REFUSED and never ran — `
            + `${result.refusedBecause ?? DOD_REFUSAL_FALLBACK} [src: ${outcome.reviewRel}:1]`
          // `?? "?"`, the spelling the base side already uses: a `ran` row with
          // no exit code is only reachable from a truncated `events.jsonl`, and
          // `?` fails the `digit+` grammar CLOSED rather than printing the word
          // `undefined` as if it were a measurement.
          : `- ${outcome.id}: \`${result.command}\` in ${outcome.repo} `
            + `[src: $ ${result.command} → exit ${String(result.exitCode ?? "?")}]`,
      );
    }
    for (const command of outcome.dodUnrecovered ?? []) {
      rows.push(
        `- ${outcome.id}: \`${command}\` in ${outcome.repo} ran in an earlier \`tldrx next\` and ` +
          `its exit code is not in this run's event log — not re-asserted here ` +
          `[src: ${outcome.reviewRel}:1]`,
      );
    }
  }
  if (rows.length === 0) {
    rows.push("- no Definition of Done ran [src: absent:03-plan/stories]");
  }
  return rows;
}
