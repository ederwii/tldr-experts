/**
 * The four numbers the Build loop used to keep as code constants, as optional
 * `stage.yml` keys — `attempts`, `fixlist_rounds`, `reviewer_share`,
 * `gate_signer_share`.
 *
 * ## Why they moved
 *
 * Each one is a calibration, not an invariant. "Two attempts" is the framework's
 * opinion about how many developer turns a story deserves before a human should
 * look at it; a workspace shipping a hardening wave over a legacy repo has a
 * different opinion, and until 2026-09-09 the only way to hold it was a fork.
 * `parallel:` made exactly this move already (`build/caps.ts DEFAULT_PARALLEL`)
 * and the argument is the same one: the value nobody chose should be the one
 * that surprises nobody, and the value somebody DID choose should be readable in
 * the file where they chose it.
 *
 * ## The contract
 *
 * **Absent ⇒ today's constant, exactly.** Every default below is the number the
 * code shipped before this file existed, so a workspace that writes none of these
 * keys gets byte-identical behaviour — that is what `STAGE_TUNING_DEFAULTS` is
 * for and what the golden test proves.
 *
 * **ONE derivation.** `caps.ts`, `remainingWork.ts`, `gateSigner.ts` and
 * `fixlist.ts` each keep the constant they always exported — the prose that
 * justifies the number lives with the code the number governs — but each is now
 * DEFINED as its field here, so the default cannot be raised in one file and not
 * the other. `test/remaining-work.test.ts` already pins the caps/hook mirror; the
 * defaults are pinned the same way.
 *
 * **Range-checked, and out of range is a REFUSAL, not a clamp.** `validateStage`
 * refuses `attempts: 40` by name. A clamp would let an operator write a number,
 * pay for something else, and never be told which. The reader below is separately
 * TOLERANT — it falls back to the default for a value `validateStage` would have
 * refused — because a reader whose job is to not turn junk into a spawn argument
 * must never throw on a hot path; the refusal is the validator's job, and it runs
 * first.
 *
 * This file imports nothing but the validation helpers on purpose: it is read by
 * `budget/remainingWork.ts`, which the `budget-gate` PreToolUse hook loads before
 * every Bash command a session issues.
 */
import { isRecord, type ValidationIssue } from "./validation.ts";

/** What a stage runs on when `stage.yml` says nothing. */
export interface StageTuning {
  /**
   * Developer attempts one Build story gets before it blocks. Default 2: one
   * pass, plus one more if the reviewer asks for changes. A second `changes`
   * blocks it — beyond that is an operator's decision, which is now spellable.
   */
  readonly attempts: number;
  /**
   * Fix-list rounds one story gets. A `fixlist` verdict spends no attempt, so an
   * unbounded supply of them is a story that never has to settle. Default 1.
   */
  readonly fixlistRounds: number;
  /** The reviewer's share of a story's price. Default 0.25. */
  readonly reviewerShare: number;
  /** The gate signer's share of the stage ceiling. Default 0.25. */
  readonly gateSignerShare: number;
  /**
   * What a story's PLANNED price is multiplied by to get the developer's
   * ceiling (gh #277). Default 3 — see `build/caps.ts STORY_CAP_MULTIPLIER`,
   * where the number is argued next to the arithmetic it governs.
   */
  readonly storyCapMultiplier: number;
  /**
   * The least a priced story's developer may be given, whatever the multiplied
   * price says (gh #277). Default 4. Argued in `build/caps.ts
   * STORY_CAP_FLOOR_USD`.
   */
  readonly storyCapFloorUsd: number;
}

export const STAGE_TUNING_DEFAULTS: StageTuning = {
  attempts: 2,
  fixlistRounds: 1,
  reviewerShare: 0.25,
  gateSignerShare: 0.25,
  storyCapMultiplier: 3,
  storyCapFloorUsd: 4,
};

/** One key: its `stage.yml` spelling, its bounds, and whether it counts things. */
export interface TuningRange {
  /** The `stage.yml` key. */
  readonly key: string;
  readonly min: number;
  readonly max: number;
  /** True ⇒ a count, so a fractional value is refused rather than truncated. */
  readonly integer: boolean;
}

export const STAGE_TUNING_RANGES: Readonly<Record<keyof StageTuning, TuningRange>> = {
  attempts: { key: "attempts", min: 1, max: 5, integer: true },
  fixlistRounds: { key: "fixlist_rounds", min: 0, max: 3, integer: true },
  reviewerShare: { key: "reviewer_share", min: 0, max: 1, integer: false },
  gateSignerShare: { key: "gate_signer_share", min: 0, max: 1, integer: false },
  // Min 1, not 0: a multiplier below 1 spends LESS than the plan asked for,
  // which is the shape gh #277 was filed about. An operator who wants the
  // price taken literally writes 1; nothing here lets them write 0.8 by
  // accident and rediscover the wall.
  storyCapMultiplier: { key: "story_cap_multiplier", min: 1, max: 20, integer: false },
  storyCapFloorUsd: { key: "story_cap_floor_usd", min: 0, max: 200, integer: false },
};

const FIELDS = Object.keys(STAGE_TUNING_RANGES) as readonly (keyof StageTuning)[];

/** True when `value` is a number this key would accept. */
export function inTuningRange(range: TuningRange, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (range.integer && !Number.isInteger(value)) return false;
  return value >= range.min && value <= range.max;
}

/**
 * The four keys off a parsed `stage.yml`, with every absent, non-numeric or
 * out-of-range value falling back to its default.
 *
 * TOLERANT by design — see the module header. `validateStage` is what tells an
 * operator their `attempts: 40` was refused; this is what keeps a malformed file
 * from becoming a strange spawn.
 */
export function readStageTuning(doc: unknown): StageTuning {
  if (!isRecord(doc)) return STAGE_TUNING_DEFAULTS;
  const out: Record<string, number> = { ...STAGE_TUNING_DEFAULTS };
  for (const field of FIELDS) {
    const range = STAGE_TUNING_RANGES[field];
    const value = doc[range.key];
    if (typeof value === "number" && inTuningRange(range, value)) out[field] = value;
  }
  return out as unknown as StageTuning;
}

/**
 * The refusal half. Appends one issue per key that is present and is not a number
 * in range — named, with the bounds, so the operator does not have to find them.
 */
export function validateStageTuning(doc: Record<string, unknown>, issues: ValidationIssue[]): void {
  for (const field of FIELDS) {
    const range = STAGE_TUNING_RANGES[field];
    const value = doc[range.key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !inTuningRange(range, value)) {
      issues.push({
        path: range.key,
        message: `expected ${range.integer ? "an integer" : "a number"} `
          + `between ${String(range.min)} and ${String(range.max)}`,
      });
    }
  }
}
