/**
 * The carried findings of a run that no story's declared surface covers, read
 * off disk once (#171).
 *
 * `unownedFindings.ts` holds the JUDGEMENT and takes only data. This file holds
 * the WALK — which fix lists a run has, and which surfaces its plan declared —
 * because three surfaces need the same answer and they run in three processes:
 * the Build handoff's `## Unknowns` (`build/handoff.ts`), `tldrx ship`'s PR body
 * (`run/shipBody.ts`), and the boundary decision card when some other trigger was
 * already going to print one (`run/decisionCards.ts`). Each of them RENDERS what
 * this returns; not one of them applies a predicate of its own.
 *
 * Two derivations are called and neither is copied: `carriedFindings`
 * (`build/fixlist.ts` — `defer-with-log`, and no resolution the file can point a
 * commit at) says what is carried, and `unownedFindings` says what is unowned.
 *
 * THE STORY SOURCE IS THE BOUNDARY GATE'S. `stories/*.md` first and, when a scope
 * skipped Plan and wrote none, `04-build/implicit-plan.yml` — the real plan
 * winning over the implicit one, exactly as `deriveSurface` and `buildProgress`
 * resolve the same pair. The implicit half is `boundary.ts`'s own reader, called
 * rather than re-parsed. Without it every Plan-skipped run reports false
 * `unowned` rows, including for a path its implicit plan declared by name.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { carriedFindings, latestFixlist } from "./fixlist.ts";
import { unownedFindings, type DeclaredSurface, type UnownedRow } from "./unownedFindings.ts";
import { BUILD_PHASE, PLAN_PHASE } from "./plan.ts";
import { implicitStorySurface } from "../run/boundary.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { STORIES_DIR } from "../plan/validatePlan.ts";

/** One carried finding no story's declared surface covers, with the fix list it is in. */
export interface CarriedRow {
  /** Run-relative path of the fix list — the same spelling every other bullet cites. */
  readonly rel: string;
  readonly row: UnownedRow;
}

/**
 * Directories to look in for a run's artefacts — the two addressed by name, then
 * whatever else the caller declares.
 *
 * `BUILD_PHASE` is FIRST because the readers below take the first hit per story:
 * a fix list's only writer puts it under `04-build`, so the real home has to win
 * any tie. `PLAN_PHASE` is second and unconditional because a `build-only` run's
 * `run.yml` declares one phase and its plan still sits in `03-plan/stories/`.
 * This is the same list and the same reasoning as `ship.ts`'s `phaseDirs`; the
 * caller adds its run's declared phases when it has them, for a workflow that
 * names its phases differently.
 */
function phaseDirsOf(extra: readonly string[]): readonly string[] {
  return [...new Set([BUILD_PHASE, PLAN_PHASE, ...extra])];
}

/**
 * What the run's plan declared it would write, one row per story.
 *
 * A story file that does not validate is SKIPPED, not guessed at — the same
 * fail-closed direction `ship.ts`'s `runStories` takes over the same files, and
 * through the same `validateStoryFile`. ONE ROW PER STORY ID, first phase
 * directory wins.
 *
 * An unreadable or absent plan returns an EMPTY list, and the caller must know
 * what that means: with no declared surface at all, every carried finding reads
 * `unowned`. That is the honest answer — nothing declared it — and it is why the
 * implicit fallback below is not optional.
 */
export function declaredSurfaces(
  runDir: string,
  extraPhaseDirs: readonly string[] = [],
): readonly DeclaredSurface[] {
  const rows: DeclaredSurface[] = [];
  const seen = new Set<string>();
  for (const phase of phaseDirsOf(extraPhaseDirs)) {
    const dir = join(runDir, phase, STORIES_DIR);
    if (!existsSync(dir)) continue;
    let names: readonly string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      // No workspace commands passed: the dod-allowlist rule is about EXECUTING a
      // story, and this only ever reads its front matter.
      const story = validateStoryFile(text).story;
      if (story === null || seen.has(story.id)) continue;
      seen.add(story.id);
      rows.push({ story: story.id, repo: story.repo, touches: story.touches });
    }
  }
  if (rows.length > 0) return rows;
  const implicit = implicitStorySurface(runDir);
  return implicit === null ? [] : [implicit];
}

/**
 * Every carried finding of this run that no declared surface covers.
 *
 * The LATEST round only, which is what every other reader of a fix list does
 * (`executors/build.ts` `fixlistFor`, `ship.ts` `openFixFindings`): an earlier
 * round is superseded by the one written after it, and `MAX_FIXLIST_ROUNDS` is 1,
 * so "latest only" is COMPLETE rather than merely conventional.
 *
 * One story is reported ONCE, first phase directory wins — without the guard a
 * story with a fix list under two phase directories would have its carried
 * findings listed twice, under two citations, and a reader would be told one
 * defect is owed twice over.
 */
export function carriedRowsFor(
  runDir: string,
  repoNames: ReadonlySet<string>,
  extraPhaseDirs: readonly string[] = [],
): readonly CarriedRow[] {
  const declared = declaredSurfaces(runDir, extraPhaseDirs);
  const rows: CarriedRow[] = [];
  const seen = new Set<string>();
  for (const phase of phaseDirsOf(extraPhaseDirs)) {
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
  return rows;
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
