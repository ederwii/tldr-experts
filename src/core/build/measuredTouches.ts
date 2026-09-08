/**
 * The SECOND reading of a story's declared surface — taken off its own diff (#185).
 *
 * `touches` has exactly one writer and it runs before the code exists: the Plan
 * sub-agent writes it into `03-plan/stories/<id>.md`, and
 * `plan/schemaContract.ts` records WHY that list is a forecast — *"No compiler
 * runs at Plan time, so nothing can compute this list."* That reason is correct
 * and is not the thing to fix. What was missing is the reading nobody was taking
 * afterwards, when the diff is on disk and the answer is free.
 *
 * Measured on three real workspaces (#185): one story changed 21 files and 18 of
 * them were outside its declared `touches`; the pattern repeated on the other two
 * stories of the same run, none of them by a mistake anybody could point at — the
 * 18 were Application-layer files the work genuinely required. The consequence is
 * what makes this worth a record: the boundary audit that exists to say "this epic
 * changed something no story claimed" was comparing against a forecast, so its
 * answer carried no information. That is the shape of check that gets switched off.
 *
 * **One event type, two honest bases.** Wave 4 (#171) added
 * `story.touches_widened` for `tldrx story widen` — an operator DECLARING that a
 * story's surface grew. A framework measurement of the same fact is the same
 * fact, so it is the same record with an ADDITIVE `basis: "measured"` and
 * `actor: "framework"`. **An absent `basis` means `declared`**, so every row wave
 * 4 wrote keeps its meaning and no reader had to change to keep working
 * (AGENTS.md §7: `version: 1` formats only grow). A sibling event type was
 * considered and rejected: it would make "the surface grew" two questions, and
 * every reader would have to ask both.
 *
 * **Advisory, always.** This never refuses, never blocks, and never rewrites the
 * story's `touches:` — declaring is the operator's verb (`run/widenStory.ts`) and
 * a framework that back-dated a declaration would make the plan claim it declared
 * a path it did not. What the framework may do is say what it measured.
 *
 * This file takes DATA and returns DATA: no `ctx`, no session, no git. The
 * orchestrator runs the diff (over the SAME range the reviewer is shown —
 * `reviewDiffRange` in `git.ts`, so there is one definition of "the story's
 * diff") and hands the paths here.
 */
import { inSurface, normalisePath } from "../run/boundary.ts";
import { isStatePath } from "./implicitPlan.ts";
import type { TldrxEvent } from "../events/Event.ts";

/** The event both bases are written on. Wave 4's (#171), unchanged. */
export const WIDENED_EVENT = "story.touches_widened";

/**
 * What the note says AFTER the count, so the sentence names its own instrument.
 * Exported because the test that pins the note must assert the marker, not a bare
 * English phrase that innocent prose could satisfy (AGENTS.md §8).
 */
export const MEASURED_NOTE_TAIL =
  " — measured off the story's own diff, the range the reviewer was shown";

/** `declared` is what an absent `basis` means, and what it will always mean. */
export type WideningBasis = "declared" | "measured";

/**
 * The tolerant read, in ONE place (AGENTS.md §7: one implementation per
 * derivation). Anything that is not exactly `"measured"` — absent, null, empty, a
 * value a newer binary writes and this one has never heard of — is `declared`,
 * because `declared` is what the rows written before this field existed are and a
 * reader must never invent a basis it did not find.
 */
export function basisOf(payload: Readonly<Record<string, unknown>>): WideningBasis {
  return payload.basis === "measured" ? "measured" : "declared";
}

/** One widening, as a reader needs it: who said so, what grew, and by how much. */
export interface WideningRow {
  readonly story: string;
  readonly basis: WideningBasis;
  /** The paths this widening ADDED. */
  readonly paths: readonly string[];
  /** Sizes, not lists: a handoff bullet is bounded and the lists are in the log. */
  readonly before: number;
  readonly after: number;
  readonly note: string;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Every widening in a run's event log, oldest first, each labelled with its basis.
 *
 * Total by construction: a row whose payload is missing a field is rendered with
 * what it has rather than dropped, because a widening that happened and cannot be
 * read back is the silence this record exists to break.
 */
export function wideningRows(events: readonly TldrxEvent[]): readonly WideningRow[] {
  const rows: WideningRow[] = [];
  for (const event of events) {
    if (event.type !== WIDENED_EVENT) continue;
    const payload = event.payload;
    rows.push({
      story: typeof payload.story === "string" ? payload.story : "?",
      basis: basisOf(payload),
      paths: stringList(payload.paths),
      before: stringList(payload.before).length,
      after: stringList(payload.after).length,
      note: typeof payload.note === "string" ? payload.note : "",
    });
  }
  return rows;
}

/** What a measured reading found, or null when the work stayed inside the forecast. */
export interface MeasuredWidening {
  /** The changed paths no declared entry covers. */
  readonly paths: readonly string[];
  /** The declared list, normalised — what the plan forecast. */
  readonly before: readonly string[];
  /** The declared list plus what was measured outside it. */
  readonly after: readonly string[];
  /** The sentence, naming the count and the instrument. */
  readonly note: string;
}

/**
 * The comparison. `changed` is the story's own diff; `declared` is its `touches:`
 * (which already includes any operator widening, because `story widen` writes the
 * list back to disk and the plan is re-read).
 *
 * Framework state is dropped from BOTH sides before anything is compared, exactly
 * as `deriveSurface` drops it: `.tldrx/` and `tldrx-work/` are never a surface a
 * story grew into, and reporting them would make every run look under-declared
 * for a reason that has nothing to do with the story's work.
 *
 * Null means "nothing to record" — no change at all, or every change covered.
 * A widening that widened nothing must not reach the log (the same rule
 * `widenStory` refuses on).
 */
export function measuredWidening(
  changed: readonly string[],
  declared: readonly string[],
): MeasuredWidening | null {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of changed) {
    const path = normalisePath(raw);
    if (path === "" || isStatePath(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  if (paths.length === 0) return null;

  const before: string[] = [];
  for (const raw of declared) {
    const entry = normalisePath(raw);
    if (entry === "" || isStatePath(entry) || before.includes(entry)) continue;
    before.push(entry);
  }

  const outside = paths.filter((path) => !inSurface(path, before));
  if (outside.length === 0) return null;

  const files = paths.length === 1 ? "changed file" : "changed files";
  return {
    paths: outside,
    before,
    after: [...before, ...outside],
    note:
      `${String(outside.length)} of ${String(paths.length)} ${files} fell outside the declared `
      + `touches${MEASURED_NOTE_TAIL}`,
  };
}
