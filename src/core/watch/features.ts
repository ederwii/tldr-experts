/**
 * The deterministic pre-pass: which features shipped, and what proves it.
 *
 * "One feature per epic" is not an aesthetic choice — it is the only grouping the
 * files already contain. An epic is a branch (spec §2.14), a story is one repo on
 * that branch (§2.13), and `status: done` on a story is the only assertion in the
 * whole workspace that something actually landed. So: done stories, grouped by
 * their epic, one card each. Nothing here asks a model anything; a run whose Plan
 * produced no done stories produces no cards, and says so.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStoryFile, type Story } from "../schemas/story.ts";
import { validateEpicFile, type Epic } from "../schemas/epic.ts";
import { EPICS_DIR, STORIES_DIR } from "../plan/validatePlan.ts";
import { FEATURE_ID_RE } from "./Watcher.ts";

/** Where the Plan artefacts live inside a run. */
export const PLAN_PHASE = "03-plan";

export interface DoneStory {
  readonly story: Story;
  /** Path relative to the run dir, for a `[src: …]` token. */
  readonly path: string;
  readonly text: string;
}

export interface Feature {
  /** `<feature>` — the card's file name stem and its front-matter `id`. */
  readonly id: string;
  readonly epicId: string;
  readonly title: string;
  /** Null when the epic has no file — the stories still shipped. */
  readonly epic: Epic | null;
  readonly stories: readonly DoneStory[];
  readonly repos: readonly string[];
}

/**
 * Every epic with at least one done story, in epic-id order.
 *
 * A done story whose epic has no file is NOT dropped: something shipped, and the
 * card is the record of it. It gets a feature keyed on the epic id instead of the
 * branch slug, and the missing epic shows up as a `absent:` source downstream.
 */
export function collectFeatures(runDir: string): readonly Feature[] {
  const planDir = join(runDir, PLAN_PHASE);
  const epics = readEpics(planDir);
  const byEpic = new Map<string, DoneStory[]>();

  for (const name of markdownIn(join(planDir, STORIES_DIR))) {
    const rel = `${PLAN_PHASE}/${STORIES_DIR}/${name}`;
    const text = readFileSync(join(planDir, STORIES_DIR, name), "utf8");
    const parsed = validateStoryFile(text);
    const story = parsed.story;
    if (story === null || story.status !== "done") continue;
    const list = byEpic.get(story.epic) ?? [];
    list.push({ story, path: rel, text });
    byEpic.set(story.epic, list);
  }

  const features: Feature[] = [];
  for (const epicId of [...byEpic.keys()].sort(byEpicNumber)) {
    const stories = (byEpic.get(epicId) ?? []).slice().sort((a, b) => a.story.id.localeCompare(b.story.id));
    const epic = epics.get(epicId) ?? null;
    features.push({
      id: featureId(epicId, epic, features),
      epicId,
      title: epic?.title ?? stories[0]?.story.title ?? epicId,
      epic,
      stories,
      repos: uniqueRepos(stories, epic),
    });
  }
  return features;
}

/**
 * `epic/leaderboard` -> `leaderboard`. The branch slug is the name the team
 * already uses for the feature, so the card is filed under it rather than under
 * `e1.md`. Falls back to the lowercased epic id when there is no branch, and
 * disambiguates a collision rather than letting one card overwrite another.
 *
 * `[assumption]` — the brief says one feature per epic and names the file
 * `<feature>.md`, but not what `<feature>` is. The branch slug is the only
 * human-chosen name an epic carries (§2.14), so it is the one used.
 */
export function featureId(epicId: string, epic: Epic | null, taken: readonly Feature[]): string {
  const branch = epic?.branch ?? "";
  const slug = branch.startsWith("epic/") ? branch.slice("epic/".length) : "";
  const base = FEATURE_ID_RE.test(slug) ? slug : epicId.toLowerCase();
  const used = new Set(taken.map((f) => f.id));
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${epicId.toLowerCase()}`;
}

function readEpics(planDir: string): ReadonlyMap<string, Epic> {
  const epics = new Map<string, Epic>();
  for (const name of markdownIn(join(planDir, EPICS_DIR))) {
    const parsed = validateEpicFile(readFileSync(join(planDir, EPICS_DIR, name), "utf8"));
    if (parsed.epic !== null) epics.set(parsed.epic.id, parsed.epic);
  }
  return epics;
}

function uniqueRepos(stories: readonly DoneStory[], epic: Epic | null): readonly string[] {
  const repos: string[] = [];
  for (const repo of [...stories.map((s) => s.story.repo), ...(epic?.repos ?? [])]) {
    if (repo !== "" && !repos.includes(repo)) repos.push(repo);
  }
  return repos;
}

function byEpicNumber(a: string, b: string): number {
  const na = Number.parseInt(a.slice(1), 10);
  const nb = Number.parseInt(b.slice(1), 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

function markdownIn(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
}
