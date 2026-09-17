/**
 * THE story walk — every `<phase>/stories/*.md` a run has, read off disk once
 * and validated against the real schema (gh #189).
 *
 * Extracted from `carriedRows.ts` (#171) so a second file could use the same
 * walk without importing `carriedRows.ts` itself, which pulls in
 * `fixlist.ts`/`unownedFindings.ts` — machinery `run/boundary.ts` has no
 * business depending on. This file depends on NEITHER `carriedRows.ts` nor
 * `run/boundary.ts`, on purpose: `carriedRows.ts` already imports
 * `implicitStorySurface` FROM `run/boundary.ts`, so a boundary gate that needs
 * this walk must reach it through a leaf that does not import boundary.ts back
 * — otherwise the two files would import each other.
 *
 * Before this file existed, `run/boundary.ts`'s own `storyTouches` was a THIRD,
 * independent reader of the same fact (gh #189): `03-plan/` only, front matter
 * only (`readFront`, no schema), and a file that failed to parse was silently
 * dropped rather than reported. `scanStories` here is the one the boundary gate
 * now calls too — see `run/boundary.ts`'s own `storyTouches`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateStoryFile } from "../schemas/story.ts";
import { STORIES_DIR } from "../plan/validatePlan.ts";
import { BUILD_PHASE, PLAN_PHASE } from "./plan.ts";
import { parseYaml } from "../yaml.ts";
import type { DeclaredSurface } from "./unownedFindings.ts";
import type { PlanStatus } from "../schemas/planCommon.ts";

/** One story's declared surface plus the two things only `ship` needs. */
export interface PlannedSurface extends DeclaredSurface {
  readonly status: PlanStatus;
  /** Run-relative path of the file it was read from. */
  readonly rel: string;
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

export interface StoryScan {
  readonly stories: readonly PlannedSurface[];
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
 * `story` to `id`; `run/boundary.ts` `storyTouches` is this function, filtered to
 * `touches`; there is no second `readdirSync` over `stories/` anywhere in the
 * run/build layer (gh #189).
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
