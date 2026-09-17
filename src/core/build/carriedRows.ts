/**
 * The carried findings of a run that no story's declared surface covers, read
 * off disk once (#171).
 *
 * `unownedFindings.ts` holds the JUDGEMENT and takes only data. This file holds
 * the WALK — which fix lists a run has, and which surfaces its plan declared —
 * because four readers need the same answer and they run in different processes:
 * the Build handoff's `## Unknowns` (`build/handoff.ts`), `tldrx ship`'s PR body
 * (`run/shipBody.ts`), the boundary decision card when some other trigger was
 * already going to print one (`run/decisionCards.ts`), and `ship`'s own story
 * list (`run/ship.ts` `runStories`, which is `scanStories` plus `status`). Each
 * of them RENDERS what this returns; not one applies a predicate of its own.
 *
 * Two derivations are called and neither is copied: `carriedFindings`
 * (`build/fixlist.ts` — `defer-with-log`, and no resolution the file can point a
 * commit at) says what is carried, and `unownedFindings` says what is unowned.
 *
 * ## Which sources this reads, precisely
 *
 * Two — and, since gh #189, exactly the same two `run/boundary.ts`'s own
 * `storyTouches` reads, through the shared `scanStories`/`phaseDirsOf` leaf
 * (`storyScan.ts`, extracted from this file so `run/boundary.ts` can depend on
 * the walk without depending on this file, which imports `implicitStorySurface`
 * FROM `run/boundary.ts` — the two must not import each other):
 *
 * - `<phase>/stories/*.md` for every phase in `phaseDirsOf(runDir)`, parsed with
 *   `validateStoryFile`. A story file that parses as front matter but fails the
 *   schema is reported as unreadable-with-reason, never half-read.
 * - `04-build/implicit-plan.yml` when the walk above yields nothing — a scope
 *   that skips Plan writes no story file at all. This half genuinely IS one
 *   reader: `boundary.ts`'s own `implicitStorySurface` is CALLED, not re-parsed.
 *   Real plan wins over the implicit one, exactly as `deriveSurface` and
 *   `buildProgress` resolve the same pair. Without it every Plan-skipped run
 *   reports false `unowned` rows, including for a path its implicit plan
 *   declared by name.
 *
 * ## Nothing vanishes
 *
 * A story file that cannot be read is a `UnreadableStory` row, not a skip: its
 * fix list is still on disk and still carries defects, so dropping the story
 * silently would drop those with it. The row names the file and why, and every
 * surface renders it — absent-with-reason, the same rule the findings obey.
 */
import { carriedFindings, latestFixlist } from "./fixlist.ts";
import { unownedFindings, type DeclaredSurface, type UnownedRow } from "./unownedFindings.ts";
import { implicitStorySurface } from "../run/boundary.ts";
import {
  phaseDirsOf, scanStories,
  type PlannedSurface, type StoryScan, type UnreadableStory,
} from "./storyScan.ts";

// Re-exported: every existing caller of this file imports these from HERE, and
// the walk itself moved to `storyScan.ts` only so `run/boundary.ts` could reach
// it without a cycle (gh #189) — not to relocate anyone's import.
export { phaseDirsOf, scanStories };
export type { PlannedSurface, StoryScan, UnreadableStory };

/** One carried finding no story's declared surface covers, with the fix list it is in. */
export interface CarriedRow {
  /** Run-relative path of the fix list — the same spelling every other bullet cites. */
  readonly rel: string;
  readonly row: UnownedRow;
}

export interface CarriedReport {
  readonly rows: readonly CarriedRow[];
  readonly unreadable: readonly UnreadableStory[];
}

/**
 * What the run's plan declared it would write, one row per story — the real plan
 * when there is one, the implicit plan when the scope skipped Plan.
 *
 * An EMPTY list means nothing declared a surface at all, and the caller must know
 * what that means: every carried finding then reads `unowned`. That is the honest
 * answer, and it is why the implicit fallback is not optional.
 */
export function declaredSurfaces(runDir: string): readonly DeclaredSurface[] {
  return surfacesOf(runDir, scanStories(runDir).stories);
}

/** The real-plan-wins resolution, in one place — both entry points call it. */
function surfacesOf(
  runDir: string,
  scanned: readonly DeclaredSurface[],
): readonly DeclaredSurface[] {
  if (scanned.length > 0) return scanned;
  const implicit = implicitStorySurface(runDir);
  return implicit === null ? [] : [implicit];
}

/**
 * Every carried finding of this run that no declared surface covers, and every
 * story file the walk could not read.
 *
 * The LATEST round only, which is what every other reader of a fix list does
 * (`executors/build.ts` `fixlistFor`, `ship.ts` `openFixFindings`): an earlier
 * round is superseded by the one written after it, and `MAX_FIXLIST_ROUNDS` is 1,
 * so "latest only" is COMPLETE rather than merely conventional.
 *
 * One story is reported ONCE, first phase directory wins.
 */
export function carriedReportFor(runDir: string, repoNames: ReadonlySet<string>): CarriedReport {
  const scan = scanStories(runDir);
  const declared = surfacesOf(runDir, scan.stories);
  const rows: CarriedRow[] = [];
  const seen = new Set<string>();
  for (const phase of phaseDirsOf(runDir)) {
    for (const surface of declared) {
      if (seen.has(surface.story)) continue;
      const latest = latestFixlist(runDir, phase, surface.story);
      if (latest === null) continue;
      seen.add(surface.story);
      for (const row of unownedFindings(carriedFindings(latest.findings), declared, repoNames)) {
        rows.push({ rel: latest.rel, row });
      }
    }
  }
  return { rows, unreadable: scan.unreadable };
}

/**
 * One carried row as a decision card's detail line (#171).
 *
 * Here rather than in `decisionCards.ts` because the card is one of three
 * renderers of this row and the only one that gets a single line to say it in;
 * putting the sentence beside the data keeps the card scraping nothing.
 */
export function carriedCardLine(row: CarriedRow): string {
  return `carried, unowned: ${String(row.row.finding.n)} · ${row.row.finding.finding} `
    + `[${row.row.finding.severity}] — ${row.row.reason} — \`${row.rel}\``;
}

/** One unreadable story file as a decision card's detail line — same rule. */
export function unreadableCardLine(row: UnreadableStory): string {
  return `story file not read: \`${row.rel}\` — ${row.reason}`;
}

/**
 * A whole report as decision-card detail lines, carried findings first.
 *
 * The card's caller passes THIS rather than assembling the list itself: a second
 * assembly is a second chance to leave one of the two lists out, and the one that
 * would be left out is the one that says something was not checked.
 */
export function carriedDetailLines(report: CarriedReport): readonly string[] {
  return [...report.rows.map(carriedCardLine), ...report.unreadable.map(unreadableCardLine)];
}
