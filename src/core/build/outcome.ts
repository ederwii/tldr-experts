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
   * Uncommitted work found in the worktree as the story settled — null on the
   * ordinary case, where `commitIfDirty` already put every byte on the branch.
   */
  readonly rescued: RescuedWork | null;
  readonly cost_usd: number;
}

/** What the executor records when the spawn layer had nothing else to say. */
export const DEVELOPER_FAILED = "the developer sub-agent failed";

/** True when the merge that put this story on its epic moved no commits. */
export function mergedNothing(outcome: Pick<StoryOutcome, "carried">): boolean {
  return outcome.carried === 0;
}

export function dodGreen(outcome: Pick<StoryOutcome, "dod">): boolean {
  return outcome.dod.length > 0
    && outcome.dod.every((r) => !dodRefused(r) && r.exitCode === 0 && !r.timedOut);
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
    return binaryAbsentReason(result, repo, result.absent);
  }
  // The kept output is CITED, not inlined: this sentence is a bullet in the
  // handoff and a line on the executor's stdout, and the whole failure report
  // belongs in the file the citation names (#211).
  return `\`${result.command}\` exited ${String(result.exitCode ?? "?")} in repo ${repo}`
    + `${result.timedOut ? " (timed out)" : ""} — ${result.tail}`
    + (result.outputPath === undefined
      ? ""
      : ` [src: ${result.outputPath}:${String(result.outputLine ?? 1)}]`);
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
}

/**
 * The executor's single writer (`SerialQueue.run` in `executors/build.ts`),
 * passed in wherever a leaf needs to serialize a disk or `run.yml` write —
 * never re-implemented alongside it.
 */
export type SerialWrite = <T>(work: () => Promise<T> | T) => Promise<T>;
