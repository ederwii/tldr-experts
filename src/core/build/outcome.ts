/**
 * What happened to one story — the record everything downstream renders from.
 *
 * The handoff, the review log, `run status` and the story's own `evidence:` are
 * four views of this one object, which is why it carries the raw results (exit
 * codes, conflict paths, the commit sha) rather than sentences about them.
 */
import type { PlanStatus } from "../schemas/planCommon.ts";
import type { ReviewerProvenance } from "./reviewerProvenance.ts";
import { binaryAbsentReason, type AbsentBinary } from "./worktreeDeps.ts";
import { firstLine } from "./git.ts";

/**
 * What the reviewer said — and, for `error`, that it never got to say anything.
 *
 * `approve` and `changes` are VERDICTS: a person's judgement of the diff,
 * delivered. `n-a` is "no reviewer ran for this story". `error` is the fourth
 * case, and it exists because it used to be recorded as the second: a reviewer
 * that died mid-read — spawn failure, timeout, exhausted `--max-budget-usd` —
 * was written down as `changes`, which consumed the story's one requeue and sent
 * a fresh developer at code nobody had faulted. Measured 2026-08-30 on run
 * `260830-tenancy-identity-customers`: a $0.26 reviewer on a 39-file, +1879-line
 * diff exited with `Reached maximum budget ($0.26)` and the story was reported
 * as "the reviewer asked for changes".
 *
 * Fail-closed is right — an unfinished review is never an approval. Inventing the
 * verdict is not.
 *
 * `fixlist` is the fifth, and it is the one the OTHER four could not express: a
 * reviewer that signed and still has findings. Measured 2026-08-31 on story S5 of
 * `260830-tenancy-identity-customers` — every acceptance criterion met, zero
 * scope violations, and three real correctness/security defects the criteria
 * never covered. `approve` discards them; `changes` spends the story's one
 * requeue on a diff nobody faulted. So `fixlist` settles the story at `review`,
 * spends NO attempt, and is bounded at one round (`MAX_FIXLIST_ROUNDS`) — a free
 * round that could be taken twice is a story that never has to settle.
 */
export type Verdict = "approve" | "changes" | "n-a" | "error" | "fixlist";

export interface DodResult {
  readonly command: string;
  /**
   * `ran` ⇒ the command was spawned and this row is a MEASUREMENT. `refused` ⇒
   * the gate declined to run it (not on `.tldrx/workspace.yml`'s allowlist, or
   * it needs a shell this gate does not open), so nothing ran and there is no
   * exit code to report.
   *
   * ADDITIVE and optional: absent means `ran`, which is every record written
   * before this field existed. The invariant readers may rely on is `ran`
   * carries an `exitCode` and `refused` never does — until 2026-09-06 a refusal
   * was written as a fabricated `exitCode: 126` and three documents rendered
   * that fabrication as a measured exit (#165).
   */
  readonly status?: "ran" | "refused";
  /** Present only on `refused`: the gate's own sentence, verbatim. */
  readonly refusedBecause?: string;
  /** The measured exit. Absent — and only ever absent — when `status` is `refused`. */
  readonly exitCode?: number;
  /**
   * Which proof this row is (#257): `paths` ⇒ the repo's `<slot>_scoped` template
   * ran over `paths`, and `command` is the RENDERED line; `full` ⇒ the declared
   * command ran whole. ADDITIVE: absent means the repo declares no template, which
   * is every record written before the suffix existed, and every one of those
   * was a full run.
   */
  readonly scope?: "paths" | "full";
  /** The paths a `scope: "paths"` row was narrowed to. Present only on that scope. */
  readonly paths?: readonly string[];
  /**
   * The line that actually RAN on a `scope: "paths"` row — the template with
   * the paths in place. `command` above stays the DECLARED command on every row,
   * because that is what a story's evidence cites and what the `[src: $ …]`
   * grammar can resolve; a rendered template is not citable by design.
   */
  readonly rendered?: string;
  readonly timedOut: boolean;
  /**
   * One line of the combined output — the operator's first clue.
   *
   * Since #211 it is the FAILURE-looking line (`failureSummaryLine`), not the
   * last line of `stdout + stderr`: the old reading handed a red suite's record
   * a trailing `DeprecationWarning` and threw the failing test away.
   */
  readonly tail: string;
  /**
   * Present only on an exit 127 in a story worktree: what the tree was MISSING
   * (gh #209). ADDITIVE and optional — absent means "not asked", which is every
   * record written before this field existed and every result that is not a 127.
   *
   * It exists so a 127 stops being rendered as a red test. The two are opposite
   * findings: one says the story broke the suite, the other says the suite never
   * ran because the worktree has no `node_modules`.
   */
  readonly absent?: AbsentBinary | null;
  /**
   * Up to `DOD_EXCERPT_MAX_LINES` failure-looking lines, bounded by
   * `DOD_DETAIL_MAX_BYTES` (#211). ADDITIVE and optional: absent on every record
   * written before this field existed, and on a command that passed or was
   * refused. `tail` is its first line, so a reader that has only `tail` is never
   * wrong, only shorter.
   */
  readonly excerpt?: string;
  /**
   * Where the whole kept tail lives, relative to the run dir
   * (`04-build/log/dod-output/<story>-<n>.txt`), and its size. Absent when the
   * command passed, was refused, or printed nothing — never an invented path.
   */
  readonly outputPath?: string;
  readonly outputBytes?: number;
  /**
   * 1-based line INSIDE that file where the excerpt starts, so a citation points
   * at the failure and not at the top of a 200-line tail. Absent on a record
   * written before this field existed; every reader falls back to 1, which is
   * where the old citations pointed anyway.
   */
  readonly outputLine?: number;
  /**
   * The SECOND reading of a red command (#163) — the identical command, run once
   * more in the same tree, so `blocked` carries the evidence that the red was
   * reproducible.
   *
   * ADDITIVE and optional: absent means "not asked", which is every record
   * written before this field existed, every green row and every refusal (a
   * command that never ran has nothing to re-run).
   */
  readonly recheck?: DodRecheck;
}

/**
 * One re-measurement of a red DoD command (#163).
 *
 * Measured on a .NET workspace 2026-09-05: a DoD gate returned `dotnet test →
 * exit 2`, the operator ran the identical suite twice and got exit 0 with 2860
 * tests and 0 failing — contention over a container runtime — and that one red
 * had spent the story's last attempt. A flake and a defect were written down
 * identically, and `blocked` is terminal in-run.
 *
 * The two shapes are the two honest answers, and only one of them carries a
 * number (§7, absent-with-reason). `exitCode` present: the second run happened
 * and this is what it said. `exitCode` absent: it could not be taken, and
 * `absentBecause` says why — never a confident second number nobody measured.
 */
export interface DodRecheck {
  /** The second run's exit code. Absent — and only absent — when no second run was taken. */
  readonly exitCode?: number;
  /** True when the second run hit the timeout (its `exitCode` is then 124, as the first's is). */
  readonly timedOut?: boolean;
  /** The failure-looking line of the second run, when it was red again. */
  readonly tail?: string;
  /** Why there is no second exit code. Present exactly when `exitCode` is absent. */
  readonly absentBecause?: string;
}

/**
 * Did the red reproduce? `true` measured twice red, `false` measured red then
 * green, `null` NOT ASKED — no second run, or one that could not be taken.
 *
 * ONE derivation (§7): the reason sentence, the event payload and every test
 * read reproducibility off this, never off a re-comparison of two exit codes.
 */
export function dodRecheckReproduced(result: Pick<DodResult, "recheck">): boolean | null {
  const recheck = result.recheck;
  if (recheck === undefined || recheck.exitCode === undefined) return null;
  return recheck.exitCode !== 0 || recheck.timedOut === true;
}

/**
 * The exported phrases the reason sentence is built from — PHRASES, not bare
 * English words, so a test asserting one cannot false-positive on prose (§8).
 */
export const RECHECK_REPRODUCED_MARK = "the identical command was run again and failed again";
export const RECHECK_NOT_REPRODUCED_MARK = "the identical command was run again and PASSED, so this red did not reproduce";
export const RECHECK_ABSENT_MARK = "no second run was taken";

/**
 * What the second reading adds to a red row's sentence, or "" when none was
 * asked for — one derivation, so the block reason, the story log and the
 * handoff cannot disagree about the same two runs.
 */
export function dodRecheckNote(result: Pick<DodResult, "recheck" | "exitCode">): string {
  const recheck = result.recheck;
  if (recheck === undefined) return "";
  if (recheck.exitCode === undefined) {
    return ` — ${RECHECK_ABSENT_MARK}: ${recheck.absentBecause ?? "the reason was not recorded"}`;
  }
  const second = `${String(recheck.exitCode)}${recheck.timedOut === true ? " (timed out)" : ""}`;
  return dodRecheckReproduced(result) === true
    ? ` — ${RECHECK_REPRODUCED_MARK} (exit ${String(result.exitCode ?? "?")}, then ${second})`
    : ` — ${RECHECK_NOT_REPRODUCED_MARK}`
      + ` (exit ${String(result.exitCode ?? "?")}, then ${second}); the story is blocked on a red that was`
      + " measured once and not the second time — read the kept output before you read the code";
}

/** True when the gate DECLINED to run this command. Absent status means it ran. */
export function dodRefused(result: Pick<DodResult, "status">): boolean {
  return result.status === "refused";
}

/**
 * What a refusal says when the gate's own sentence did not survive the round
 * trip — one string, five readers (the handoff, the review log, the retro, the
 * blocked-story reason and the reviewer's bundle).
 *
 * It exists because absent-with-reason (§7) has to hold even when the reason is
 * the thing that went missing: "refused, and we no longer know why" is still a
 * refusal, and it must never degrade into an unexplained non-green row.
 */
export const DOD_REFUSAL_FALLBACK = "the gate declined to run it";

/**
 * Work that was in the story worktree and in no ref, when the framework was
 * about to delete the worktree (#129).
 *
 * Measured live 2026-09-02 on run `260830-money-and-payments`: a DoD failed, the
 * story settled `blocked`, and `git worktree remove --force` took the developer's
 * fix with it. `blocked` is the state a human is most likely to want to inspect,
 * so the one path that must never destroy anything destroyed everything.
 *
 * Two shapes, and they are the two honest answers. `sha` set: the changes were
 * committed to the story branch first, and `git show <sha>` gets them back.
 * `sha` null: they could NOT be committed, `failure` says why, and the worktree
 * was kept rather than pruned — because a tree holding the only copy of somebody's
 * work is not the framework's to delete.
 */
export interface RescuedWork {
  /** The rescue commit, or null when none could be made. */
  readonly sha: string | null;
  /** The branch it landed on — the story branch. */
  readonly branch: string;
  /** Where the tree still is, when it was KEPT. Null once it has been pruned. */
  readonly worktree: string | null;
  /** Why nothing could be committed. Measured from git, never guessed. */
  readonly failure: string | null;
}

export interface StoryOutcome {
  readonly id: string;
  readonly title: string;
  readonly wave: string;
  readonly repo: string;
  readonly epic: string;
  readonly epicBranch: string;
  readonly branch: string;
  /**
   * `done`, `blocked`, or `review` when it is waiting for something more.
   *
   * `review` carries two different situations, told apart by `verdict`: a
   * `changes` verdict means the DEVELOPER is owed another attempt, and an `error`
   * means only the REVIEW is missing — the diff is merged and its DoD was green.
   */
  readonly status: PlanStatus;
  /** How many developer attempts this story took (1 or 2). */
  readonly attempts: number;
  readonly dod: readonly DodResult[];
  /**
   * DoD commands the story's plan DECLARES whose results could not be recovered
   * — set only on a row rebuilt from disk for a story an earlier `tldrx next`
   * settled, and only when `events.jsonl` holds no `check` for them.
   *
   * It exists so that an empty `dod` has two readings and the documents can tell
   * them apart. `dod: []` with this empty means the story declares no commands,
   * and "no Definition of Done ran" is true. `dod: []` with commands listed here
   * means results EXIST and this process could not read them — a different fact,
   * and rendering it as the first is the false claim #137 was filed for.
   */
  readonly dodUnrecovered?: readonly string[];
  readonly commit: string | null;
  readonly merged: boolean;
  /**
   * How many commits the story branch carried beyond the epic when it merged.
   *
   * `0` is a merge that moved NOTHING — `git merge` says "Already up to date"
   * and exits 0, and until 2026-08-30 the handoff rendered that as "merged".
   * On run `260830-tenancy-identity-customers` the Gate section read
   * "(S1, S3, S5, S4, S7 merged)" when only S1's merge carried a commit and the
   * other four branches were byte-identical to the epic.
   *
   * `null` means this invocation did not measure it — a story merged by an
   * earlier `tldrx next`, which is known to have merged and not known to have
   * carried nothing.
   */
  readonly carried: number | null;
  readonly conflicts: readonly string[];
  readonly verdict: Verdict;
  /**
   * WHICH REVIEWER produced `verdict` — model, effort and the basis of the claim
   * (`build/reviewerProvenance.ts`), or null when nothing recorded it.
   *
   * OPTIONAL and additive: absent is what every outcome built before this field
   * existed carries, and `renderReviewLog` renders absent and null identically,
   * as `not recorded`. Never inferred from the stage's pin — a story whose
   * reviewer ran on a `reviewer_by_stakes:` override and a story whose reviewer
   * ran on the stage's own model are not the same review, and only the record
   * can tell them apart.
   */
  readonly reviewer?: ReviewerProvenance | null;
  /**
   * What the DEVELOPER sub-agent died with, when it never delivered — a spawn
   * failure, a timeout, an exhausted `--max-budget-usd`. Null on every story
   * whose developer RAN, whatever it produced.
   *
   * This is the developer-side sibling of `verdict: "error"`, and it exists for
   * the same reason: on `260830-tenancy-identity-customers` five developers died
   * with `Reached maximum budget (…)` before writing a line, and each one was
   * recorded as a story `blocked` after a consumed attempt. A sub-agent that
   * never ran is not an attempt, and `verdict` stays `n-a` here because that is
   * the truth: no reviewer judged anything.
   */
  readonly developerError: string | null;
  readonly reviewSummary: string;
  readonly reviewFindings: readonly string[];
  /** Run-relative path of the review log — every Finding cites it. */
  readonly reviewRel: string;
  /** One line saying why, when the story did not reach `done`. */
  readonly reason: string | null;
  /**
   * The command the agent's own permission layer refused this attempt, when the
   * story went on anyway because its tree held committed work and the DoD
   * decided (gh #271). Optional and absent on every record written before it
   * existed; a blocked story carries the same command inside `reason` instead.
   */
  readonly permissionRefused?: string | null;
  /**
   * The repo's declared `commands:` AS THE REFUSED DEVELOPER HELD THEM (gh #285).
   *
   * Recorded at the moment the story settles, so the three surfaces that write a
   * refusal — the session log, `renderReviewLog`, the handoff's `## Unknowns` —
   * all name the same cure without re-deriving it, and a record read later is
   * not re-judged against a `workspace.yml` somebody edited since. Optional and
   * absent on every record written before it existed, where the refusal keeps
   * #278's wording exactly.
   */
  readonly declaredCommands?: readonly string[];
  /**
   * The `Reached maximum budget (…)` the developer died on this attempt, when
   * the story went on anyway because its tree held work and the DoD decided
   * (gh #277). Optional and absent on every record written before it existed; a
   * story the DoD then FAULTED carries the same sentence inside `reason`.
   */
  readonly budgetDeath?: string | null;
  /**
   * Why NO REVIEWER WAS SPAWNED for this story — the stage had less left than a
   * review costs, so the turn was refused before it was paid for (gh #289).
   *
   * The reviewer-side sibling of `developerError`, and `verdict` stays `n-a`
   * here for the same reason it does there: an agent that never started formed
   * no opinion, and writing its absence down as a verdict — `error` included,
   * which means "it died mid-read" — is an audit record lying in the dangerous
   * direction. Optional and absent on every record written before it existed.
   */
  readonly reviewerUnfunded?: string | null;
  /**
   * Uncommitted work found in the worktree as the story settled — null on the
   * ordinary case, where `commitIfDirty` already put every byte on the branch.
   */
  readonly rescued: RescuedWork | null;
  /**
   * Set when this story was settled from its branch AS IT STANDS (#279): a
   * person finished the work by hand and signed `tldrx story reopen <id>
   * --as-is`, and NO developer was spawned for this turn.
   *
   * Optional and absent on every record written before it existed, and on every
   * ordinary turn — where a developer really did deliver the diff. It is the
   * field that keeps the record from lying about who did the work: with it set,
   * the review log says the branch was taken as it stands and names the person
   * who asked for that; without it, the log reads exactly as it always has.
   */
  readonly asIs?: AsIsSettlement | null;
  /**
   * gh #364: this attempt settled because the developer ASKED instead of
   * acting and left the tree unchanged, in an unattended run — the attempt
   * `askedNoDiffReason` above is about. Optional and absent on every record
   * written before this existed and on every ordinary turn; `true` only on
   * the settle `settleAskedNoDiff` writes, so `task.done`'s ADDITIVE
   * `asked_no_diff` field and `reviewLedger.ts`'s count of it agree with the
   * one place that decides.
   */
  readonly askedNoDiff?: boolean;
  readonly cost_usd: number;
}

/** What the executor records when the spawn layer had nothing else to say. */
export const DEVELOPER_FAILED = "the developer sub-agent failed";

/**
 * Is this story's REVIEW still owed — nothing judged the diff and nothing is
 * going to without an operator moving something?
 *
 * Two shapes, one question, and one place that answers it: a reviewer that died
 * mid-read (`verdict: "error"`) and a reviewer that was never funded enough to
 * start (`reviewerUnfunded`, gh #289). Every caller of the first was a caller of
 * the second the day it shipped — the requeue rule, the review-only resume path,
 * the retro — and a second copy of "or the other one" in each of them is how the
 * two drift into different fates for the same story.
 */
export function reviewStillOwed(outcome: StoryOutcome): boolean {
  return outcome.verdict === "error" || (outcome.reviewerUnfunded ?? null) !== null;
}

/**
 * The words a record uses for a story settled from its branch AS IT STANDS
 * (#279) — `tldrx story reopen <id> --as-is`.
 *
 * Exported so the review log, the operator line and the tests all say the same
 * thing, and so a test asserts THIS marker rather than a word of English prose
 * that innocent text could carry (AGENTS.md §8). It is deliberately blunt: the
 * one thing this record must never let a reader believe is that a developer
 * delivered the diff, because none was spawned.
 */
export const AS_IS_MARK = "the branch was taken AS IT STANDS — no developer was spawned for it";

/**
 * The marker in the refusal of an as-is settlement over a branch that carries
 * NOTHING its epic has not already got — or a branch git would not count.
 *
 * Its own constant for the reason every marker here is: a test must be able to
 * assert the refusal happened without matching a word of English that innocent
 * prose could carry, and the operator line and the story's `reason:` must not be
 * able to drift apart.
 */
export const AS_IS_NOT_AHEAD_MARK = "nothing to take as it stands";

/**
 * The marker in the refusal of an as-is settlement over a branch that carries
 * nothing beyond its epic AND whose last review over that work STANDS (#295):
 * `approve`, `changes` or `fixlist` was recorded against the merged diff, so
 * the review is not owed — a fix is. Beside `AS_IS_NOT_AHEAD_MARK`, never
 * instead of it.
 */
export const AS_IS_JUDGED_MARK = "the last review of that work stands";

/**
 * The words a record uses for the REVIEW-ONLY case of an as-is settlement
 * (#295): the story's work was already on its epic from an earlier turn and
 * nothing had judged it, so this turn merged nothing, ran the DoD on the epic
 * head and the review over the range the story was merged as. Distinct from
 * `AS_IS_MARK` on purpose — "the branch was taken" would be false here.
 */
export const AS_IS_REVIEW_ONLY_MARK = "the review was run AS IT STANDS — nothing was merged and no developer was spawned";

/**
 * The marker in the refusal of a developer attempt on a story a PERSON put back
 * — a fix round or a plain reopen — whose tree is the one it was handed (#308).
 *
 * Its own constant for the reason every marker here is: a test asserts THIS,
 * not a word of English innocent prose could carry, and the operator line and
 * the story's `reason:` cannot drift apart.
 */
export const NO_DIFF_MARK = "the developer produced no diff";

/**
 * The marker for gh #364's shape: a developer that ASKED instead of acting,
 * in a run where nobody answers. Its own constant for the same reason every
 * marker here is one — a test asserts THIS, not a word of English innocent
 * prose could carry.
 */
export const ASKED_NO_DIFF_MARK = "the developer asked instead of acting, and left no diff";

/**
 * Why a developer's turn earns `failure_kind: "asked_no_diff"` (gh #364,
 * `AgentFailureKind` in `facilitator/spawnAgent.ts` — reused, not a second
 * vocabulary).
 *
 * Measured live, 2026-09-16: a headless `--questions none` developer read a
 * hard read/write restriction in its own brief (fixed alongside this), could
 * not see how to satisfy the acceptance criteria inside it, and narrated a
 * question in its result text instead of opening the file it needed — no
 * diff, $0.50, and the story sat `blocked` until an operator noticed and
 * reopened it. Unlike `noDiffAfterReopenReason`, no person's note is quoted:
 * this is the FIRST time the story has stalled this way, and the "note" is
 * the developer's own `questions_asked`.
 */
export function askedNoDiffReason(questions: readonly string[]): string {
  const first = questions[0] ?? "(no question text recorded)";
  const count = questions.length;
  return `${ASKED_NO_DIFF_MARK}: \`questions_asked\` named ${String(count)} thing${count === 1 ? "" : "s"} `
    + `it did not resolve on its own — "${firstLine(first)}". Nobody in this run answers a developer's `
    + "question, so the attempt is requeued rather than left for a person to notice.";
}

/**
 * Why a reopened story's attempt was refused before its DoD ran: the developer
 * changed nothing since the tree it was handed (#308).
 *
 * Measured live: a `--for-fix` round whose developer read the file, said it
 * "already satisfies every acceptance criterion", and spent $1.69 changing
 * nothing — and the story settled `done` again, because `commitIfDirty` hands
 * back the OLD head on a clean tree and the "no commit to review" gate never saw
 * it. A person's note names a concrete gap; a tree that did not move cannot have
 * closed it, so the attempt is refused with the note's first line in the
 * sentence. The same shape as `asIsNotAheadReason`: what was measured, what the
 * person signed, what to do next.
 */
export function noDiffAfterReopenReason(parts: {
  /** HEAD of the story worktree BEFORE the developer was spawned. */
  readonly handed: string;
  readonly note: string;
  readonly actor: string;
  /** True when the open round is `--for-fix` — the wording names the fix round. */
  readonly fix: boolean;
}): string {
  const round = parts.fix ? "the fix round" : "the reopen";
  return `${NO_DIFF_MARK}: the tree is the one it was handed (\`${parts.handed.slice(0, 7)}\`), `
    + `and ${round} ${parts.actor} signed says \`${firstLine(parts.note)}\`. `
    + "Nothing changed, so nothing could have landed it — no DoD ran and no reviewer was spawned. "
    + "Reopen it with a note that names what the developer has to change";
}

/**
 * Why an as-is settlement was refused before it ran a thing.
 *
 * `ahead` is `commitsBetween`'s `number | null` contract (#273) and the two
 * values mean DIFFERENT things, so they get different sentences: `0` is "the
 * branch really carries nothing", `null` is "git could not count, and I will not
 * merge on a measurement I do not have". Both refuse — a verb that takes a
 * branch without a developer may not also guess at what the branch holds.
 */
export function asIsNotAheadReason(
  branch: string,
  epicBranch: string,
  ahead: number | null,
  /**
   * The last review recorded over this story's merged work, when one STANDS
   * (#295) — the reason the review-only case did not apply. Absent when there is
   * no recorded merge at all, which is the sentence #279 always printed.
   */
  judged?: { readonly commit: string; readonly verdict: string },
): string {
  if (ahead === null) {
    return `${AS_IS_NOT_AHEAD_MARK}: git could not count what \`${branch}\` carries beyond `
      + `\`${epicBranch}\`, and a settlement that spawns no developer will not merge on a `
      + "measurement it does not have. Nothing was merged";
  }
  return `${AS_IS_NOT_AHEAD_MARK}: \`${branch}\` carries no commit \`${epicBranch}\` has not already `
    + "got, so there is no work to settle"
    + (judged === undefined
      ? ""
      : `, and ${AS_IS_JUDGED_MARK} — \`${judged.commit.slice(0, 7)}\` is on \`${epicBranch}\` and its `
        + `review said \`${judged.verdict}\`, so the review is not what is owed`)
    + ". Commit the fix to the story branch first, then reopen it --as-is. Nothing was merged";
}

/**
 * Did NOTHING judge the diff this `task.done` settled (#295)? `n-a` is a turn
 * no reviewer was spawned for (blocked before one, or refused for want of
 * money, gh #289); `error` is a reviewer that died mid-read. Every other verdict
 * is a reviewer's opinion about the bytes, and it stands until a fix or a
 * person's plain reopen moves it. One predicate, because the review-only case
 * and the refusal that names the standing verdict must not disagree.
 */
export function reviewNeverCompleted(verdict: string): boolean {
  return verdict === "n-a" || verdict === "error";
}

/** Who signed a story's as-is settlement, and why (#279). */
export interface AsIsSettlement {
  /** The actor on the `story.reopened` that asked for it. */
  readonly actor: string;
  /** The `--note` — the whole of what the next reader gets. */
  readonly note: string;
  /** When that reopen was signed. */
  readonly at: string;
  /**
   * WHICH case the Build decided this signature was (#295), or absent for the
   * one #279 shipped: the branch taken as it stands and merged. `review-only`
   * means the work was already on the epic from an earlier turn and nothing had
   * judged it, so this turn merged nothing and ran the DoD and the review. Set
   * by the executor once it has measured the branch, never by the reopen.
   */
  readonly reason?: "review-only";
  /**
   * The merge the review-only turn reviewed — the commit and the epic base the
   * story was merged as, off the ledger (#295). Present exactly when `reason`
   * is `review-only`.
   */
  readonly reviewed?: { readonly commit: string; readonly epicBase: string };
}

/** True when the merge that put this story on its epic moved no commits. */
export function mergedNothing(outcome: Pick<StoryOutcome, "carried">): boolean {
  return outcome.carried === 0;
}

/**
 * ` (the story's \`npm run test\`, scoped to 2 path(s))` on a row that ran a
 * `<slot>_scoped` template; empty on every other row (#257). One spelling, for
 * the failure reason and the review log both.
 */
export function scopedNote(result: Pick<DodResult, "scope" | "paths" | "command" | "rendered">): string {
  if (result.scope !== "paths" || result.rendered === undefined) return "";
  return ` (the story's \`${result.command}\`, scoped to ${String(result.paths?.length ?? 0)} path(s))`;
}

export function dodGreen(outcome: Pick<StoryOutcome, "dod">): boolean {
  return outcome.dod.length > 0
    && outcome.dod.every((r) => !dodRefused(r) && r.exitCode === 0 && !r.timedOut);
}

/**
 * The row a DoD faulted on, or `undefined` when every row is green — the row
 * `dodFailureReason` is then asked about.
 *
 * Same reason as the sentence below: three call sites in the executor spelled
 * this `find` out themselves, and the negation of `dodGreen` has to be read off
 * the SAME predicate or a story can block with no row to name (§7).
 */
export function dodFailure<T extends Pick<DodResult, "status" | "exitCode" | "timedOut">>(
  dod: readonly T[],
): T | undefined {
  return dod.find((r) => dodRefused(r) || r.exitCode !== 0 || r.timedOut);
}

/**
 * The fields `dodRequeueRed` reads — a `DodResult` has them, and so does the row
 * `readReviewLedger` rebuilds from a `check.*` event, whose `absent_binary` key
 * says only THAT the binary was absent, not the rest of `AbsentBinary`.
 */
export type RequeueRow = Pick<DodResult, "status" | "exitCode" | "timedOut"> & { readonly absent?: unknown };

/**
 * Is this DoD red in the one way a second developer attempt could fix (gh #313)?
 *
 * Every non-green row RAN — not REFUSED (it would be refused again) and not a
 * binary ABSENT from the tree (#209, the workspace's `install:`, not the code) —
 * and there is at least one. ONE predicate, two callers: `dodRedRequeue` decides
 * the requeue with it, and `readReviewLedger` counts the attempts it spent with
 * it, so the bound can never be charged for an attempt it would not have granted.
 */
export function dodRequeueRed(dod: readonly RequeueRow[]): boolean {
  const red = dod.filter((r) => dodFailure([r]) !== undefined);
  return red.length > 0 && red.every((r) => !dodRefused(r) && (r.absent === undefined || r.absent === null));
}

/**
 * The most conflicted files a conflict turn is handed (gh #286). The field case
 * was ONE file (a counted migrations list both stories bumped); its recurrence
 * 1.5 h later was four, after three more siblings had merged. Past three, a
 * merge is not a registration line two stories both touched — it is two stories
 * that overlap, and that is a plan question a person answers.
 */
export const MAX_CONFLICT_TURN_FILES = 3;

/**
 * Why a conflict turn left the story unfit for a DoD or a commit (gh #286) — the
 * block reason, one sentence, exported so tests assert it rather than prose.
 * `markers` empty and `inProgress` true is the developer that resolved but never
 * ran `git commit`; markers present is a resolution that is not one, whether or
 * not it was committed.
 */
export function leftoverMergeReason(markers: readonly string[], inProgress: boolean): string {
  const parts = [
    ...(markers.length === 0
      ? []
      : [`the conflict turn left conflict markers in ${markers.map((f) => `\`${f}\``).join(", ")}`]),
    ...(inProgress
      ? ["the merge the conflict turn was handed is still in progress (`MERGE_HEAD` is set — "
        + "`git add` and `git commit` close it)"]
      : []),
  ];
  return `${parts.join("; and ")} — nothing was proven, committed or merged`;
}

/**
 * Why a story blocked on its Definition of Done — one sentence, one derivation.
 *
 * Two call sites in the executor built this string independently
 * (`buildHalf` and `pipelineFromDod`); a refusal has to read differently from a
 * red exit in both, and two copies of one sentence is how they stop agreeing.
 */
export function dodFailureReason(result: DodResult, repo: string): string {
  if (dodRefused(result)) {
    return `\`${result.command}\` was REFUSED in repo ${repo} and never ran — `
      + `${result.refusedBecause ?? DOD_REFUSAL_FALLBACK}`;
  }
  // An exit 127 whose tree never had the binary is not a red test, and the
  // sentence that says so is derived in ONE place (gh #209).
  if (result.absent !== undefined && result.absent !== null) {
    // #163: the second reading is named here too — for a 127 it is always the
    // absent one, and saying WHY none was taken is the whole point of the field.
    return `${binaryAbsentReason(result, repo, result.absent)}${dodRecheckNote(result)}`;
  }
  // The kept output is CITED, not inlined: this sentence is a bullet in the
  // handoff and a line on the executor's stdout, and the whole failure report
  // belongs in the file the citation names (#211).
  return `\`${result.rendered ?? result.command}\`${scopedNote(result)} exited ${String(result.exitCode ?? "?")} in repo ${repo}`
    + `${result.timedOut ? " (timed out)" : ""} — ${result.tail}`
    + (result.outputPath === undefined
      ? ""
      : ` [src: ${result.outputPath}:${String(result.outputLine ?? 1)}]`)
    // #163: and what the SECOND reading of the same command said — appended, so
    // a record written before the re-measure existed reads exactly as it did.
    + dodRecheckNote(result);
}

/** One line for `run status` and the executor's stdout: `S1 done`, `S2 blocked`. */
export function describeOutcome(outcome: StoryOutcome): string {
  return `${outcome.id} ${outcome.status}`;
}

/**
 * A refusal a Build step raises, as DATA: the operator lines and the one-line
 * `stage.error`. `src/core/build/` never builds an `ExecutorOutcome` — the
 * executor owns the shape of what it returns, and a refusal that could be
 * assembled in two places would be two refusals.
 */
export interface BuildRefusal {
  readonly lines: readonly string[];
  readonly error: string;
  /**
   * Whether the evidence behind `error` was MEASURED by this attempt or re-used
   * from what an earlier one wrote down (#339).
   *
   * ADDITIVE and optional: a refusal that does not say is read as "unknown", which
   * is what the supervisor's repeat guard already assumed of every refusal before
   * this existed — not as "measured", which would be a freshness nobody established.
   */
  readonly freshness?: "measured" | "cached";
}

/**
 * The executor's single writer (`SerialQueue.run` in `executors/build.ts`),
 * passed in wherever a leaf needs to serialize a disk or `run.yml` write —
 * never re-implemented alongside it.
 */
export type SerialWrite = <T>(work: () => Promise<T> | T) => Promise<T>;
