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
 * Two, and they are NOT the same two the boundary gate reads — the overlap is
 * exact where it matters and the difference is worth naming rather than glossing:
 *
 * - `<phase>/stories/*.md` for every phase in `phaseDirsOf(runDir)`, parsed with
 *   `validateStoryFile`. `run/boundary.ts` `storyTouches` reads `03-plan/` ONLY
 *   and parses with `readFront` (front matter, no schema). So a story file that
 *   parses as front matter but fails the schema counts for the boundary gate and
 *   is reported here as unreadable-with-reason; a story file under a phase other
 *   than `03-plan` counts here and not for the gate. That divergence is
 *   pre-existing and is somebody else's issue; it is written down so nobody
 *   reads "the same source" and believes more than is true.
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { carriedFindings, latestFixlist } from "./fixlist.ts";
import { unownedFindings, type DeclaredSurface, type UnownedRow } from "./unownedFindings.ts";
import { BUILD_PHASE, PLAN_PHASE } from "./plan.ts";
import { implicitStorySurface } from "../run/boundary.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { STORIES_DIR } from "../plan/validatePlan.ts";
import { parseYaml } from "../yaml.ts";
import type { PlanStatus } from "../schemas/planCommon.ts";

/** One carried finding no story's declared surface covers, with the fix list it is in. */
export interface CarriedRow {
  /** Run-relative path of the fix list — the same spelling every other bullet cites. */
  readonly rel: string;
  readonly row: UnownedRow;
}

/**
 * A story file the walk could not turn into a surface, and WHY.
 *
 * Never a silent skip. The story's fix list is still on disk, so an unread story
 * takes its carried findings out of every report with it; naming the file is what
 * turns that from a disappearance into a stated absence.
 */
export interface UnreadableStory {
  /** Run-relative path of the story file. */
  readonly rel: string;
  /** Never blank, never inferred: what was tried and what came back. */
  readonly reason: string;
}

/** One story's declared surface plus the two things only `ship` needs. */
export interface PlannedSurface extends DeclaredSurface {
  readonly status: PlanStatus;
  /** Run-relative path of the file it was read from. */
  readonly rel: string;
}

export interface StoryScan {
  readonly stories: readonly PlannedSurface[];
  readonly unreadable: readonly UnreadableStory[];
}

export interface CarriedReport {
  readonly rows: readonly CarriedRow[];
  readonly unreadable: readonly UnreadableStory[];
}

/**
 * The run's declared phase ids, read tolerantly straight off `run.yml`.
 *
 * NOT `RunStore.open`, deliberately: it validates and, on a repaired parse, WRITES
 * (`RunStore.healOnDisk`). This is called while a handoff is being written and
 * while a decision card is being rendered, and neither is a place to take a side
 * effect on the run's own state. An unreadable or absent `run.yml` contributes
 * nothing rather than throwing — every caller here is on a path where an
 * exception would change an exit code.
 */
function declaredPhases(runDir: string): readonly string[] {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(join(runDir, "run.yml"), "utf8"));
  } catch {
    return [];
  }
  const phases = (doc as { phases?: unknown } | null)?.phases;
  if (!Array.isArray(phases)) return [];
  const ids: string[] = [];
  for (const phase of phases) {
    if (phase === null || typeof phase !== "object") continue;
    const id = (phase as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") ids.push(id);
  }
  return ids;
}

/**
 * Every directory a run's artefacts are looked for in — derived ONCE, from the
 * run dir, so every surface is handed the same list.
 *
 * It used to be a parameter, and a parameter is how the Build handoff and the PR
 * body ended up able to see different sets of stories: `ExecutorContext` carries
 * no phase list, so the executor passed none while `ship` passed the run's. The
 * list is not the caller's business — it is the run's — so it is read from the
 * run.
 *
 * `BUILD_PHASE` is FIRST because the readers below take the first hit per story:
 * a fix list's only writer puts it under `04-build`, so the real home has to win
 * any tie. `PLAN_PHASE` is second and unconditional because a `build-only` run's
 * `run.yml` declares one phase and its plan still sits in `03-plan/stories/`.
 */
export function phaseDirsOf(runDir: string): readonly string[] {
  return [...new Set([BUILD_PHASE, PLAN_PHASE, ...declaredPhases(runDir)])];
}

/**
 * The run's story files, as surfaces, plus every file that could not be read.
 *
 * THE one walk. `run/ship.ts` `runStories` is this function plus a rename of
 * `story` to `id`; there is no second `readdirSync` over `stories/` in `run/`.
 *
 * ONE ROW PER STORY ID, and the FIRST phase directory that holds it wins — the
 * tie-break `ship`'s two readers of the list have always depended on, so a story
 * found in two phase directories cannot be reported twice under two citations.
 * A file that does not validate is REPORTED, not guessed at and not dropped.
 */
export function scanStories(runDir: string): StoryScan {
  const stories: PlannedSurface[] = [];
  const unreadable: UnreadableStory[] = [];
  const seen = new Set<string>();
  for (const phase of phaseDirsOf(runDir)) {
    const dir = join(runDir, phase, STORIES_DIR);
    if (!existsSync(dir)) continue;
    let names: readonly string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    } catch (error) {
      unreadable.push({
        rel: `${phase}/${STORIES_DIR}`,
        reason: `the directory could not be listed — ${String(error)}`,
      });
      continue;
    }
    for (const name of names) {
      const rel = `${phase}/${STORIES_DIR}/${name}`;
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch (error) {
        unreadable.push({ rel, reason: `the file could not be read — ${String(error)}` });
        continue;
      }
      // No workspace commands passed: the dod-allowlist rule is about EXECUTING a
      // story, and this only ever reads its front matter.
      const story = validateStoryFile(text).story;
      if (story === null) {
        unreadable.push({
          rel,
          reason: "the file does not validate as a story, so the surface it declares could not be read",
        });
        continue;
      }
      if (seen.has(story.id)) continue;
      seen.add(story.id);
      stories.push({
        story: story.id, repo: story.repo, touches: story.touches, status: story.status, rel,
      });
    }
  }
  return { stories, unreadable };
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
