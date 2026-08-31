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
import type { StoryOutcome } from "./outcome.ts";

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
  readonly defaultBranches: readonly string[];
  /** Run-relative path of `03-plan/epics/<id>.md`. */
  readonly rel: string;
}

export interface BuildHandoffParts {
  readonly runId: string;
  readonly stageId: string;
  readonly model: string | null;
  readonly costUsd: number;
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
}

export function renderBuildHandoff(parts: BuildHandoffParts): string {
  const done = parts.outcomes.filter((o) => o.status === "done");
  const notDone = parts.outcomes.filter((o) => o.status !== "done");

  const lines = [
    `# Handoff — 04-build / ${parts.stageId} — run ${parts.runId}`,
    `Stage: ${parts.stageId} · Expert: developer + reviewer · Model: ${parts.model ?? "default"} · ` +
      `Cost: $${parts.costUsd.toFixed(2)} of $${parts.budgetUsd.toFixed(2)} ceiling · ${parts.at}`,
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
    ...(notDone.length === 0
      ? [`- none — every scheduled story reached \`done\` [src: absent:04-build/log]`]
      : notDone.map(
          (o) =>
            `- ${o.id} is \`${o.status}\` and needs a human: ${o.reason ?? "see the review"} ` +
            `[src: ${o.reviewRel}:1]`,
        )),
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
      : parts.epics.map(
          (e) =>
            `- \`${e.branch}\` in ${e.repos.join(", ")} → \`${e.defaultBranches.join(", ")}\` ` +
            `(${mergeSummary(e)})`,
        )),
    "",
  ];
  return lines.join("\n");
}

/**
 * What actually landed on this epic branch, in the parentheses a human reads
 * before deciding whether to merge it.
 *
 * A no-op merge is named as one. `git merge --no-ff` of a branch that is already
 * an ancestor exits 0 and moves nothing, and the old rendering — one flat list
 * ending in "merged" — reported four such branches as landed work on
 * `260830-tenancy-identity-customers`.
 */
function mergeSummary(epic: EpicSummaryRow): string {
  const empty = epic.emptyMerges ?? [];
  const parts: string[] = [];
  if (epic.merged.length > 0) parts.push(`${epic.merged.join(", ")} merged`);
  if (empty.length > 0) {
    parts.push(`${empty.join(", ")} added nothing — identical to \`${epic.branch}\``);
  }
  return parts.length === 0 ? "no story merged" : parts.join("; ");
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

function decisions(parts: BuildHandoffParts): readonly string[] {
  const anchor = parts.outcomes[0]?.reviewRel ?? null;
  const rows: string[] = [];
  for (const epic of parts.epics) {
    rows.push(
      `- ${epic.id} is built on \`${epic.branch}\` and left unmerged for a human ` +
        `[src: ${epic.rel}:1]`,
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
 */
function ledger(outcomes: readonly StoryOutcome[]): readonly string[] {
  const rows: string[] = [];
  for (const outcome of outcomes) {
    for (const result of outcome.dod) {
      rows.push(
        `- ${outcome.id}: \`${result.command}\` in ${outcome.repo} ` +
          `[src: $ ${result.command} → exit ${String(result.exitCode)}]`,
      );
    }
  }
  if (rows.length === 0) {
    rows.push("- no Definition of Done ran [src: absent:03-plan/stories]");
  }
  return rows;
}
