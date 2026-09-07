/**
 * The reviewer's bundle ON DISK: the two keys, the write, the clear, the stash of a
 * refused envelope, and reading back what a review is OF.
 *
 * The bundle's PRESENCE is the state — `.agent/<stage>/<story>/review/pending.json`
 * exists exactly while a review is outstanding — so nothing here has to keep a flag
 * in step with a directory. Every function is of `runDir` and a bundle key, never of
 * a session or an `ExecutorContext` (spec §2 decision 3), which is what lets both
 * doors a review comes through — a spawned reviewer and a host's `--commit --review`
 * — read and write the same bytes.
 *
 * The prompt is passed IN as a string: `build/reviewRound.ts` owns the one renderer
 * ("ONE renderer, whichever door"), and this module does not need to know how a
 * prompt is made in order to write one into a bundle.
 *
 * `reopenReviewBundle` and `refuseOnEnvelope` stay in the executor — their answer is
 * an `ExecutorOutcome`, and no module under `src/core/build/` may name one.
 */
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { agentDir } from "../facilitator/paths.ts";
import {
  writeBundle, PENDING_FILE, RAW_FILE, RESULT_FILE,
  type PendingReview, type PendingStage,
} from "../facilitator/pending.ts";
import { REVIEW_DIR } from "../run/prepared.ts";
import { MAX_ATTEMPTS } from "./caps.ts";
import { diffCommand } from "./git.ts";
import { REVIEW_SCHEMA } from "./prompts.ts";
import { readReviewLedger } from "./reviewLedger.ts";
import { DOD_REFUSAL_FALLBACK, dodRefused } from "./outcome.ts";
import type { DodResult, StoryOutcome } from "./outcome.ts";
import type { PlannedStory } from "./plan.ts";
import type { PlanStatus } from "../schemas/planCommon.ts";
import type { EffortLevel } from "../schemas/stage.ts";

/**
 * A story that needs its REVIEW re-run and nothing else: the developer half is
 * done, its DoD was green, and the commit is already merged into the epic.
 */
export interface ResumableReview {
  /** The merged story commit, from the ledger's `task.done`. */
  readonly commit: string;
  /** The DoD results of the attempt that produced it, from the ledger. */
  readonly dod: readonly DodResult[];
  /** What the reviewer died with — quoted to the operator, never as a verdict. */
  readonly error: string;
}

/**
 * A story whose REVIEW is the only thing outstanding, and everything a reviewer
 * needs to do it — recovered from the run's own ledger, never re-measured.
 *
 * The superset of `ResumableReview`: that one is the narrow "the last reviewer
 * died" case, this one also covers "the review was handed to the host and has
 * not come back", which is what a reviewer bundle on disk means.
 */
export interface ReviewWork {
  /** The merged story commit the verdict is about. */
  readonly commit: string;
  /** The DoD results of the attempt that produced it. */
  readonly dod: readonly DodResult[];
  /** Why the review is outstanding, in the words the operator reads. */
  readonly why: string;
}

/** Everything `writeReviewBundle` records, as values rather than as a session. */
export interface ReviewBundleParts {
  readonly runDir: string;
  readonly root: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly stageId: string;
  readonly storyId: string;
  readonly repo: string;
  readonly branch: string;
  readonly epicBranch: string;
  readonly worktree: string;
  readonly attempt: number;
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly budgetUsd: number;
  /** What the framework WOULD have paid for this read — recorded, never enforced. */
  readonly reviewerCapUsd: number;
  readonly preparedAt: string;
  readonly work: ReviewWork;
  /** Rendered by `reviewerPromptFor`: this module writes prompts, it does not make them. */
  readonly prompt: string;
  /** The operator-line sink, appended to and never replaced. */
  readonly lines: string[];
}

/** What one story's review is OF — the question `reviewWorkFor` answers. */
export interface ReviewLookup {
  readonly runDir: string;
  readonly stageId: string;
  readonly storyId: string;
  /** The story's status ON DISK (`statusOf`): the file is the state. */
  readonly status: PlanStatus;
  /** This process's own outcome for the story, when it has already settled one. */
  readonly fresh: StoryOutcome | undefined;
}

/** `.agent/<stage>/<story>/` — one bundle per sub-agent, never one per stage. */
export function bundleKeyOf(stageId: string, storyId: string): string {
  return join(stageId, storyId);
}

/**
 * `.agent/<stage>/<story>/review/` — the reviewer's own bundle, one level below
 * the developer's.
 *
 * Nested rather than suffixed so `preparedBundles` (which walks exactly one
 * level) cannot read a reviewer bundle as a developer one. Two roles, two
 * directories, no flag to get wrong.
 */
export function reviewBundleKeyOf(stageId: string, storyId: string): string {
  return join(stageId, storyId, REVIEW_DIR);
}

/** Is a reviewer bundle out for this story? Its presence IS the state. */
export function reviewBundleOut(runDir: string, key: string): boolean {
  return existsSync(join(agentDir(runDir, key), PENDING_FILE));
}

/**
 * Write the reviewer bundle: the prompt a spawn would have been given, plus the
 * facts that make it dispatchable — the diff refs, the merged commit, the DoD
 * already re-run, and the envelope schema `--commit --review` will parse.
 *
 * No cap is spent and no meter starts. `max_budget_usd` is still recorded,
 * because the host is entitled to know what the framework would have paid for
 * this read — but it is a number to compare against, not one to enforce here.
 */
export function writeReviewBundle(parts: ReviewBundleParts): string {
  const id = parts.storyId;
  const key = reviewBundleKeyOf(parts.stageId, id);
  const review: PendingReview = {
    story: id,
    repo: parts.repo,
    branch: parts.branch,
    epic_branch: parts.epicBranch,
    diff: diffCommand(parts.epicBranch, parts.branch),
    commit: parts.work.commit,
    attempt: parts.attempt,
    max_attempts: MAX_ATTEMPTS,
    worktree: relative(parts.root, parts.worktree),
    // A refused row hands the host `refused` and NO `exit_code`: the bundle is
    // the contract read back from the host, so an invented number here would
    // come back as a measurement (#165). Keyed off `status`, not off whether a
    // reason happens to be set — a refusal with an empty reason would otherwise
    // write NEITHER key and read back as an unexplained non-green, which is
    // absent-with-reason losing its reason. Same fallback sentence the handoff,
    // the review log and the retro use.
    dod: parts.work.dod.map((r) => (dodRefused(r)
      ? { command: r.command, refused: r.refusedBecause ?? DOD_REFUSAL_FALLBACK }
      : { command: r.command, ...(r.exitCode === undefined ? {} : { exit_code: r.exitCode }) })),
    resumed_from: parts.work.why,
  };
  const pending: PendingStage = {
    version: 1,
    run: parts.runId,
    phase: parts.phaseId,
    stage: parts.stageId,
    expert: "reviewer",
    model: parts.model,
    effort: parts.effort,
    budget_usd: parts.budgetUsd,
    max_budget_usd: parts.reviewerCapUsd,
    prompt: "prompt.md",
    outputs: [],
    sections: {},
    // The story's own dod is re-run by the executor, never by the reviewer —
    // the prompt says so in as many words. The stage's checks are the gate's.
    checks: [],
    prepared_at: parts.preparedAt,
    story: id,
    role: "reviewer",
    result_schema: REVIEW_SCHEMA,
    review,
  };
  // An answer already sitting here is NOT binned. `--prepare` overwrites the
  // prompt and the pending record and leaves `result.json` exactly as the
  // developer half does — a turn somebody has already paid for is not this
  // command's to throw away (`preparedRefusal`'s rule). It is said out loud
  // instead, because a stale answer read as a fresh verdict is the other half
  // of that hazard and `--discard-pending` is the door for it.
  const answered = existsSync(join(agentDir(parts.runDir, key), RESULT_FILE));
  writeBundle(parts.runDir, key, parts.prompt, pending);
  if (answered) {
    parts.lines.push(
      `  · ${id}: a ${RESULT_FILE} was already in the reviewer bundle and was KEPT — `
      + "settle it with `tldrx next --commit --review`, or bin it with `--discard-pending`",
    );
  }
  return key;
}

/** A settled handshake leaves the log, not the bundle. */
export function clearReviewBundle(runDir: string, key: string): void {
  const dir = agentDir(runDir, key);
  for (const file of [PENDING_FILE, RESULT_FILE, RAW_FILE]) rmSync(join(dir, file), { force: true });
}

/**
 * Move a FORMAT-refused envelope aside, and say what it was kept as (#78).
 *
 * Renamed rather than left or deleted, and both halves of that matter — the
 * reasoning is on `reopenReviewBundle`, the only caller, which stays in the
 * executor because its answer is an `ExecutorOutcome`.
 */
export function stashRefusedEnvelope(runDir: string, key: string, spent: number): string {
  const dir = agentDir(runDir, key);
  const kept = `result.refused-${String(spent)}.json`;
  renameSync(join(dir, RESULT_FILE), join(dir, kept));
  rmSync(join(dir, RAW_FILE), { force: true });
  return kept;
}

/**
 * Is this story waiting on nothing but a REVIEW — and if so, what does the
 * reviewer need?
 *
 * Two histories, one answer. `resumableReview` is the narrow "the last reviewer
 * died" case that landed on 2026-08-30. The second is a review this framework
 * already handed to the host: the bundle on disk is the record of that, and it
 * is removed the moment `--commit --review` counts a verdict, so its presence
 * is exact rather than a guess about the ledger's shape.
 *
 * A story whose reviewer asked for CHANGES is deliberately NOT here: that one
 * is owed a developer attempt, its bundle was cleared when the verdict was
 * counted, and `prepare()` hands it a developer exactly as it always did.
 */
export function reviewWorkFor(parts: ReviewLookup): ReviewWork | null {
  const resume = resumableReview(parts.runDir, parts.storyId, parts.status, parts.fresh);
  if (resume !== null) {
    return { commit: resume.commit, dod: resume.dod, why: `the previous reviewer FAILED (${resume.error})` };
  }
  const key = reviewBundleKeyOf(parts.stageId, parts.storyId);
  if (!reviewBundleOut(parts.runDir, key)) return null;
  return reviewWorkFromBundle(parts.runDir, key)
    ?? reviewWorkFromLedger(parts.runDir, parts.storyId, parts.status);
}

/**
 * The bundle's own account of what it is a review OF.
 *
 * Read in preference to the ledger, and not as a convenience: a story handed
 * over mid-pipeline has NOT settled, so no `task.done` records its commit yet
 * and the ledger genuinely does not know it. The bundle does — it was written
 * from the merge that had just happened. The contract handed to the host is the
 * contract read back from it.
 */
export function reviewWorkFromBundle(runDir: string, key: string): ReviewWork | null {
  const path = join(agentDir(runDir, key), PENDING_FILE);
  if (!existsSync(path)) return null;
  let doc: PendingStage;
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as PendingStage;
  } catch {
    return null;
  }
  const review = doc.review;
  if (review === undefined || typeof review.commit !== "string" || review.commit === "") return null;
  return {
    commit: review.commit,
    dod: (review.dod ?? []).map((r) => {
      // `undefined === 124` is false, which is the right answer by accident and
      // the wrong thing to rely on. The refusal is explicit, and a missing
      // `exit_code` is never defaulted to anything (#165).
      const refused = typeof r.refused === "string" && r.refused !== "";
      return {
        command: r.command,
        ...(refused
          ? { status: "refused" as const, refusedBecause: r.refused as string }
          : { status: "ran" as const, ...(r.exit_code === undefined ? {} : { exitCode: r.exit_code }) }),
        timedOut: !refused && r.exit_code === 124,
        tail: "",
      };
    }),
    why: review.resumed_from ?? "its review is outstanding",
  };
}

/**
 * The same facts, read off the ledger with no opinion about whether a review is
 * OWED — for the paths where the operator has already said so by typing
 * `--review`, or where a bundle is being settled.
 */
export function reviewWorkFromLedger(
  runDir: string, storyId: string, status: PlanStatus,
): ReviewWork | null {
  if (status !== "review" && status !== "in_progress") return null;
  const ledger = readReviewLedger(runDir, storyId);
  if (ledger.commit === null) return null;
  return {
    commit: ledger.commit,
    dod: ledger.dod,
    why: "its review is outstanding",
  };
}

/** The story whose reviewer bundle is out, if any. */
export function awaitingReview(
  runDir: string, stageId: string, pending: readonly PlannedStory[],
): PlannedStory | null {
  return pending.find((p) => reviewBundleOut(runDir, reviewBundleKeyOf(stageId, p.story.id)))
    ?? null;
}

/**
 * Is this story waiting on nothing but a review that FAILED?
 *
 * Three things have to hold, and all three are read off disk so a fresh process
 * reaches the same answer: the story is not settled, the last review in the
 * ledger errored (nothing has judged it since), and a commit was merged. Miss
 * any one and this returns null and the ordinary pipeline runs.
 *
 * `in_progress` counts as well as `review`, and that is not a nicety: on the
 * run that found this bug the in-session path had already handed the host a
 * developer bundle for "attempt 2", which set the story to `in_progress`. That
 * attempt was never owed and this is where it stops being offered.
 */
export function resumableReview(
  runDir: string, storyId: string, status: PlanStatus, fresh: StoryOutcome | undefined,
): ResumableReview | null {
  if (status !== "review" && status !== "in_progress") return null;
  // Once THIS process has settled the story, its own outcome is the truth.
  if (fresh !== undefined && fresh.verdict !== "error") return null;
  const ledger = readReviewLedger(runDir, storyId);
  if (ledger.erroredWith === null || ledger.commit === null) return null;
  return { commit: ledger.commit, dod: ledger.dod, error: ledger.erroredWith };
}
