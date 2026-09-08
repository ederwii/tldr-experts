/**
 * WHICH MODEL JUDGES THE DIFF — one derivation, four layers, and the record of
 * which layer decided.
 *
 * Until this file existed there was nothing to derive: `model:` and `effort:` in
 * `stage.yml` were per STAGE, and Build's developer spawn and its reviewer spawn
 * read the same two lines through one accessor. Measured this week across three
 * real workspaces and 168 Build stories: all 168 ran the same model at the same
 * effort for both roles, zero reviewers ran on a stronger one, and no review
 * record says which model produced its verdict — so "does a stronger reviewer
 * find more" was not a question anyone could answer from the data. Hosts had
 * already decided informally that it does: they upgraded the reviewer BY HAND on
 * stories whose own text said they were security-bearing, because the framework
 * had no way to express it.
 *
 * The precedence, strongest first, and each field resolves on its own:
 *
 *   1. the CLI flag — `tldrx next --model <m>` / `--effort <e>`. An explicit flag
 *      is the operator's word about THIS invocation and outranks every file.
 *   2. `reviewer_by_stakes:[<the story's declared stakes>]` — the calibration,
 *      read only when the STORY declared `stakes:` and the map has that key.
 *   3. `reviewer:` — this stage's reviewer, whatever the story is.
 *   4. the stage's own `model:` / `effort:` — where every reviewer has always run.
 *
 * Per FIELD, not per block: a `reviewer: {model: opus}` that named no effort used
 * to have to restate the stage's, and restating a value in a second place is how
 * two files start disagreeing. Layer 4 is therefore never absent — it is the
 * value the executor would have used anyway — so this function's answer with an
 * empty stage file is byte-identical to the accessor it replaced.
 *
 * DATA in, data out (AGENTS.md §12): no `ctx`, no session, no file reads. The
 * caller has the four layers in hand and owns which one it passes.
 */
import { renderReviewerModel } from "../build/reviewerProvenance.ts";
import type { EffortLevel, ReviewerOverride } from "../schemas/stage.ts";
import type { StoryStakes } from "../schemas/planCommon.ts";

/** Which of the four layers supplied a value. Recorded, never guessed. */
export type ReviewerLayer = "cli" | "stakes" | "reviewer" | "stage";

export interface ReviewerResolution {
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  /** The layer `model` came from. */
  readonly modelFrom: ReviewerLayer;
  /** The layer `effort` came from — independently of `model`. */
  readonly effortFrom: ReviewerLayer;
}

export interface ReviewerLayers {
  /** `--model` as TYPED, or null. Never the resolved stage model — that is `stageModel`. */
  readonly cliModel: string | null;
  /** `--effort` as TYPED, or null. */
  readonly cliEffort: EffortLevel | null;
  /** The story's declared `stakes:`, or null when it declared none. */
  readonly stakes: StoryStakes | null;
  /** `stage.yml`'s `reviewer_by_stakes:`, or an empty map. */
  readonly byStakes: Readonly<Record<string, ReviewerOverride>>;
  /** `stage.yml`'s `reviewer:`, or null. */
  readonly reviewer: ReviewerOverride | null;
  /** Where the reviewer has always run: the stage's resolved model and effort. */
  readonly stageModel: string | null;
  readonly stageEffort: EffortLevel | null;
}

/** The one resolution. Both spawn and `--prepare --review` call it, never a copy. */
export function resolveReviewer(layers: ReviewerLayers): ReviewerResolution {
  // Read ONLY when the story declared stakes: an undeclared story must not pick
  // up a calibration by matching the string "undefined", and `stakes: null` is
  // "not declared", not a key.
  const byStakes = layers.stakes === null ? undefined : layers.byStakes[layers.stakes];
  const model = pick<string>(
    [layers.cliModel, "cli"],
    [byStakes?.model, "stakes"],
    [layers.reviewer?.model, "reviewer"],
    [layers.stageModel, "stage"],
  );
  const effort = pick<EffortLevel>(
    [layers.cliEffort, "cli"],
    [byStakes?.effort, "stakes"],
    [layers.reviewer?.effort, "reviewer"],
    [layers.stageEffort, "stage"],
  );
  return {
    model: model.value,
    effort: effort.value,
    modelFrom: model.from,
    effortFrom: effort.from,
  };
}

/**
 * Does this resolution differ from what the DEVELOPER on the same story gets?
 *
 * True exactly when a stage file decided it — layers 2 or 3. A `--model` flag is
 * not a difference: it is given to both roles, by the same `runNext` line, so a
 * reviewer running on it is running on what the developer ran on.
 */
export function reviewerIsOverridden(resolution: ReviewerResolution): boolean {
  return isFileLayer(resolution.modelFrom) || isFileLayer(resolution.effortFrom);
}

/** The operator line for an overridden reviewer, or null when nothing overrode it. */
export function reviewerOverrideLine(
  storyId: string,
  resolution: ReviewerResolution,
  stakes: StoryStakes | null,
): string | null {
  if (!reviewerIsOverridden(resolution)) return null;
  const why = isFileLayer(resolution.modelFrom) ? resolution.modelFrom : resolution.effortFrom;
  const reason = why === "stakes"
    // `stakes` is non-null whenever a `stakes` layer won — that layer is only
    // read when the story declared one — but it is read off the argument rather
    // than asserted, so a caller that passed a mismatched pair says "declared"
    // and nothing else.
    ? `stakes \`${stakes ?? "declared"}\``
    : "the stage's `reviewer:` block";
  return `  · ${storyId}: reviewer on ${describeReviewer(resolution)} — ${reason}`;
}

/**
 * `opus · effort high`. ONE renderer, shared with the review records
 * (`build/reviewerProvenance.ts`): the operator line that announces an override
 * and the log line that reports what judged the diff must not be able to spell
 * the same pair two ways.
 */
export function describeReviewer(resolution: ReviewerResolution): string {
  return renderReviewerModel(resolution.model, resolution.effort);
}

function isFileLayer(layer: ReviewerLayer): boolean {
  return layer === "stakes" || layer === "reviewer";
}

/**
 * The first layer that supplied a value, and which one it was.
 *
 * The last pair is the stage's own, whose value may itself be null (no `effort:`
 * anywhere means the flag is not passed at all) — so "nothing supplied a value"
 * is still attributed to `stage`, which is where it came from.
 */
function pick<T>(
  ...candidates: readonly (readonly [T | null | undefined, ReviewerLayer])[]
): { value: T | null; from: ReviewerLayer } {
  for (const [value, from] of candidates) {
    if (value !== null && value !== undefined) return { value, from };
  }
  const last = candidates[candidates.length - 1];
  return { value: null, from: last === undefined ? "stage" : last[1] };
}
