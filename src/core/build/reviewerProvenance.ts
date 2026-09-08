/**
 * WHICH REVIEWER PRODUCED THIS VERDICT — the record of it, and the one sentence
 * that reports it.
 *
 * Before this file, no review record in the framework said which model judged
 * the diff. Measured this week across three real workspaces: 168 Build stories,
 * every reviewer on the stage's own `model:`/`effort:`, and the only thing
 * anybody could say afterwards was that the two `changes` verdicts in one run
 * came from sonnet reviewers — because that was inferable from a single run's
 * `agent.spawned` lines, not because any verdict recorded it. With
 * `reviewer_by_stakes:` able to move a reviewer onto a stronger model, an
 * unlabelled verdict stops being merely incomplete and starts being misleading.
 *
 * Two BASES, and they are not the same claim:
 *
 *   - `spawned` — the framework passed these exact arguments to the provider CLI.
 *     A measurement.
 *   - `host-declared` — a host session judged the diff and TOLD us what it ran
 *     on (`tldrx next --commit --review --model <m> --effort <e>`). The host's
 *     word, recorded as the host's word.
 *
 * There is deliberately no third basis for "a host reviewed it and said nothing".
 * The reviewer bundle records a model as a SUGGESTION, and reading that back as
 * the model that produced the verdict would be exactly the dangerous direction
 * AGENTS.md §7 forbids: the framework would be quoting its own suggestion as a
 * measurement of somebody else's session. Absent is the honest answer and
 * `renderReviewerProvenance` says it in words.
 */
import type { EffortLevel } from "../schemas/stage.ts";

export type ReviewerBasis = "spawned" | "host-declared";

export interface ReviewerProvenance {
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly basis: ReviewerBasis;
}

/**
 * What every document says for a verdict whose reviewer is unknown. Exported so
 * a test asserts the marker rather than retyping an English phrase that would
 * false-positive on innocent prose (AGENTS.md §8).
 */
export const REVIEWER_NOT_RECORDED = "not recorded";

/** `opus · effort high` · `opus` · `the CLI default` — the model half, alone. */
export function renderReviewerModel(model: string | null, effort: EffortLevel | null): string {
  // Null model is not "unknown": it is the shape a spawn takes when nothing
  // pinned one and the provider CLI uses its own session default. Saying so is
  // the point — a bare "null" in a review log reads as a bug.
  const name = model === null || model === "" ? "the CLI default" : model;
  return effort === null ? name : `${name} · effort ${effort}`;
}

/**
 * The one sentence every review record uses. `null`/`undefined` — an old record
 * written before these fields existed, or a host review nobody declared — reads
 * as `not recorded`, never as a guess.
 */
export function renderReviewerProvenance(provenance: ReviewerProvenance | null | undefined): string {
  if (provenance === null || provenance === undefined) return REVIEWER_NOT_RECORDED;
  return `${renderReviewerModel(provenance.model, provenance.effort)} (${provenance.basis})`;
}

/**
 * Read a provenance back off a recorded payload — an `agent.spawned` for a
 * reviewer, or the `check.passed`/`check.failed` a HOST review wrote.
 *
 * Tolerant by construction: a row with neither key is `null`, which every reader
 * turns into `not recorded`. That is the whole compatibility story for records
 * written before this shipped (AGENTS.md §7, "`version: 1` formats only grow").
 */
export function provenanceFromPayload(
  payload: Readonly<Record<string, unknown>>,
  basis: ReviewerBasis,
): ReviewerProvenance | null {
  const model = typeof payload.model === "string" && payload.model !== "" ? payload.model : null;
  const effort = typeof payload.effort === "string" && payload.effort !== ""
    ? (payload.effort as EffortLevel)
    : null;
  if (model === null && effort === null) return null;
  return { model, effort, basis };
}

/**
 * WHO produced the verdict this `check.passed`/`check.failed` records — the ONE
 * rule, shared by every reader of the log.
 *
 * A host review's declaration is on the check event itself; a spawned review's is
 * on the `agent.spawned` that preceded it. `source: "host"` decides WHICH of the
 * two is even eligible, and that is load-bearing rather than tidy: the shape a
 * host review most often arrives in is a story whose SPAWNED reviewer died and
 * was handed over, so the last reviewer spawn in the trail is a corpse that
 * produced no verdict at all. Falling back to it would attribute a person's
 * judgement to a model that never finished reading the diff — a record lying in
 * the dangerous direction (AGENTS.md §7). A host review that declared nothing is
 * `null`, and `null` is reported as `not recorded`.
 *
 * `lastSpawn` is the caller's own bookkeeping — `readReviewLedger` scopes it to
 * one story, `renderReplay` keeps one per story — because the two walk the log
 * differently. What they must not do differently is decide WHICH of the two
 * sources answers, which is this function.
 */
export function verdictReviewer(
  checkPayload: Readonly<Record<string, unknown>>,
  lastSpawn: ReviewerProvenance | null,
): ReviewerProvenance | null {
  if (checkPayload.source === "host") return provenanceFromPayload(checkPayload, "host-declared");
  return lastSpawn;
}
