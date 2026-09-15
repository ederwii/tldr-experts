/**
 * The Plan phase's ONE bounded fix round (gh #288).
 *
 * ## The defect
 *
 * Measured on a live unattended run (0.18.3, `run auto --until-done`): the planner
 * wrote two front-matter keys on ONE line — `acceptance: [ … ], test_plan: [ … ]`,
 * a flow-mapping comma inside a block mapping — in three of three stories. The
 * `plan` check refused it correctly, naming the file, the line and the column. The
 * stage then FAILED, because `next` on a failed stage is a fresh stage: the whole
 * Plan turn was re-run from scratch at $2.19, the second planner happened to put
 * one key per line, and one of the five `--until-done` relaunches was spent. A
 * two-character formatting slip cost a full re-plan and a relaunch, with the
 * checker's own diagnosis — file, line, message — thrown away.
 *
 * Build already had the shape this needs: a developer gets a verdict and a second
 * turn on the SAME branch. Plan had nothing between "refused" and "plan again".
 *
 * ## What this module is, and is not
 *
 * A leaf. It takes DATA — a list of `PlanIssue`s, some strings — and returns a
 * verdict and a prompt. It opens no file, spawns nothing, and knows nothing about
 * a run store or a session (AGENTS.md §12): `runNext.ts` owns the spawn, the
 * money and the ledger, exactly as it owns the gate signer's.
 *
 * It is deliberately NOT an extraction of Build's fix-round code. Build's
 * `fixRound` is a reviewer verdict routed back to a developer in a worktree; this
 * is a checker's refusal routed back to the planner over files already on disk.
 * They share a bound — ONE — and nothing else.
 */
import type { PlanIssue } from "./validatePlan.ts";

/**
 * `run.yml`'s `role:` for the turn this round spawns, and the marker that says
 * the round is SPENT.
 *
 * The bound is read off the rows rather than off a counter: the fix round is
 * appended immediately after the planner turn it repairs, so "the last row is a
 * fix round" is exactly "this attempt has already had its one round". A later
 * `tldrx next` on the failed stage appends a fresh planner row, and the round is
 * available again for THAT attempt — which is the bound the issue asks for, one
 * per attempt, without a second place for an attempt counter to drift.
 */
export const PLAN_FIX_ROLE = "plan-fix";

/**
 * A string the fix-round prompt is guaranteed to contain and a Plan stage prompt
 * never does. Exported for the tests' fake agent, which has to tell the two
 * spawns of one invocation apart the same way the gate-signer tests already do.
 */
export const PLAN_FIX_MARKER = "# Plan fix round";

/**
 * Whether a `plan` refusal is one a second turn could repair IN PLACE.
 *
 * The rule is structural, not lexical: every issue must name a file that EXISTS
 * and has a defect in it (`absent !== true`). The three absent cases — no story
 * file, no epic file, no `waves.yml` — are the ones where there is nothing on
 * disk to edit, so a turn told to "correct these files" would have to invent a
 * plan, which is a re-plan wearing a fix round's clothes and costs the same.
 *
 * Matching on the WORDING of the refusal was the alternative and it is the one
 * this repo forbids: a message is someone's claim about the code, and the
 * validators reword theirs freely (`cascadeMessage` alone has been rewritten
 * twice). `absent` is set by `validatePlan` at the three sites that know.
 *
 * An empty list is not repairable — there is no refusal to repair.
 */
export function planIssuesAreRepairable(issues: readonly PlanIssue[]): boolean {
  return issues.length > 0 && issues.every((issue) => issue.absent !== true);
}

/**
 * The phase-relative files the repair turn is pointed at, deduplicated, in order.
 *
 * ROOT violations only. A `cascade` issue exists only because another file did
 * not validate (gh #37) — `waves.yml` reporting "S1 has no file" when `S1.md` is
 * right there, 5,794 bytes of it, having failed its own front-matter check — so
 * the file it names has nothing wrong with it and telling a repair turn to fix it
 * is how a round spends itself editing two healthy files. Fixing the root takes
 * the cascade with it, which is what `cascadeMessage` has been saying in prose
 * since #37.
 *
 * The fallback is deliberate rather than defensive: a cascade implies a root, so
 * a root-free list should be impossible, and if the validators ever make one the
 * round still gets files instead of silently getting none.
 */
export function planFixFiles(issues: readonly PlanIssue[]): readonly string[] {
  const roots = names(issues.filter((issue) => issue.cascade !== true));
  return roots.length > 0 ? roots : names(issues);
}

function names(issues: readonly PlanIssue[]): readonly string[] {
  const seen: string[] = [];
  for (const issue of issues) {
    if (issue.absent === true) continue;
    if (!seen.includes(issue.file)) seen.push(issue.file);
  }
  return seen;
}

export interface PlanFixPrompt {
  /** `<run>/<phase>` as the stage writes it, e.g. `03-plan`. */
  readonly phaseDir: string;
  /** The run id, for the heading. */
  readonly run: string;
  /** The check refusal, VERBATIM — the whole point of the round. */
  readonly refusal: string;
  /** Phase-relative paths the refusal names, from `planFixFiles`. */
  readonly files: readonly string[];
  /** `renderPlanSchemaContract()` — the same contract the planner's own turn got. */
  readonly contract: string;
}

/**
 * The fix-round prompt.
 *
 * Short on purpose. The planner has just written these files and the refusal
 * localises every defect, so the expensive half of a Plan turn — reading the
 * phase inputs, deciding what the stories ARE — is precisely what must not happen
 * again. What it carries is the refusal verbatim, the files, and the contract the
 * files are being judged against (generated, so it cannot drift from the checker).
 *
 * The prohibitions are explicit because the failure mode of a vague repair prompt
 * is a re-plan: a turn that renumbers stories or drops one has invalidated the
 * epics and the waves that reference it, and the second refusal would then be
 * about damage this round caused.
 */
export function renderPlanFixPrompt(input: PlanFixPrompt): string {
  return [
    PLAN_FIX_MARKER,
    "",
    `Run \`${input.run}\`. The Plan files you just wrote are on disk under \`${input.phaseDir}/\`,`,
    "and the `plan` check refused them. This is a REPAIR, not a re-plan.",
    "",
    "## The refusal, verbatim",
    "",
    "```",
    input.refusal,
    "```",
    "",
    "## The files it names",
    "",
    ...input.files.map((file) => `- \`${input.phaseDir}/${file}\``),
    "",
    "## What to do",
    "",
    "Open each file above, fix exactly what the refusal names, and stop. In particular:",
    "",
    "- Do NOT re-plan. Do not add, remove, rename or renumber a story, an epic or a wave,",
    "  and do not change any prose the refusal does not name — every id is referenced from",
    "  at least one other file, so a renumbered story breaks the two files that were fine.",
    "- Do NOT read the phase's inputs again. Everything you need is the refusal above and",
    "  the contract below.",
    "- You get ONE turn. The check is re-run the moment you stop; if it refuses again the",
    "  stage fails and both refusals are recorded.",
    "",
    "## The contract these files are judged against",
    "",
    input.contract,
    "",
    "## Stop",
    "",
    "Edit the named files in place, then stop.",
  ].join("\n");
}

/**
 * The stage-death reason when a fix round has been spent and the check still
 * refuses.
 *
 * The stage dies with the exit and the family it always did; what is new is that
 * the sentence can no longer be read as "refused once". It carries BOTH details
 * because it is also the supervisor's signature (gh #297) and two different
 * second refusals must not read alike — but it is passed through `oneLine`
 * downstream like every other reason, so the UNTRUNCATED pair lives in the two
 * `check.failed` rows this stage appended and in the lines `describeFixRoundRefusals`
 * puts on the operator's output. A reason is a summary; the rows are the record.
 */
export function describeSpentFixRound(first: string, after: string): string {
  return `check \`plan\` refused again after one fix round — first: ${first} — after: ${after}`;
}

/**
 * The two refusals, one line each, in full — for the operator, who is reading the
 * command's output and not `events.jsonl`.
 *
 * Numbered rather than labelled "before/after" so the bound itself is legible:
 * "1 of 2" says there was never a third turn to wait for.
 */
export function describeFixRoundRefusals(first: string, after: string): readonly string[] {
  return [
    `plan refusal 1 of 2, before the fix round: ${first}`,
    `plan refusal 2 of 2, after the fix round: ${after}`,
  ];
}
