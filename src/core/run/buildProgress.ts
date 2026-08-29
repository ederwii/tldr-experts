/**
 * The Build phase in one line of `run status`:
 *
 *   04-build  W1 [S1 done, S2 review] W2 [S3 todo]   S1 $1.20 · S2 $0.90
 *
 * A Build stage's `cost_usd` and its `[▓▓░░░] 0/1 stages` bar are both true and
 * both useless: the phase is one stage holding a dozen sub-agents, so the bar
 * never moves until the whole thing is over and the total cannot say which story
 * ate the money. This reads the state where it actually lives — the story files
 * for status, `events.jsonl` for per-story cost — and neither can be inflated by
 * an agent's opinion of its own work.
 *
 * Read-only and total: a run with no `03-plan/` simply has no Build view.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { asWavesFile, validateWaves } from "../schemas/waves.ts";
import type { TldrxEvent } from "../events/Event.ts";

export const PLAN_DIR = "03-plan";
export const BUILD_PHASE = "04-build";

export interface StoryProgress {
  readonly id: string;
  readonly status: string;
  readonly cost_usd: number;
}

export interface WaveProgress {
  readonly id: string;
  readonly stories: readonly StoryProgress[];
}

export interface BuildProgress {
  readonly waves: readonly WaveProgress[];
  readonly done: number;
  readonly total: number;
  readonly cost_usd: number;
}

const STATUS_RE = /^status\s*:\s*(\w+)\s*$/m;

/** Null when the run has no plan to build — every phase but Build, and Build before Plan. */
export function buildProgress(runDir: string): BuildProgress | null {
  const wavesPath = join(runDir, PLAN_DIR, "waves.yml");
  if (!existsSync(wavesPath)) return null;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(wavesPath, "utf8"));
  } catch {
    return null;
  }
  if (!validateWaves(doc).ok) return null;

  const costs = costByStory(runDir);
  const waves: WaveProgress[] = [];
  let done = 0;
  let total = 0;
  let cost = 0;

  for (const wave of asWavesFile(doc).waves) {
    const stories: StoryProgress[] = [];
    for (const id of wave.stories) {
      const status = statusOf(runDir, id);
      const spent = costs.get(id) ?? 0;
      stories.push({ id, status, cost_usd: spent });
      total += 1;
      cost += spent;
      if (status === "done") done += 1;
    }
    waves.push({ id: wave.id, stories });
  }
  return { waves, done, total, cost_usd: round(cost) };
}

/** `W1 [S1 done, S2 review] W2 [S3 todo]` — the shape the spec's example asks for. */
export function renderBuildProgress(progress: BuildProgress): string {
  return progress.waves
    .map((wave) => `${wave.id} [${wave.stories.map((s) => `${s.id} ${s.status}`).join(", ")}]`)
    .join(" ");
}

/** `S1 $1.20 · S2 $0.90`, or null when no story has cost anything yet. */
export function renderStoryCosts(progress: BuildProgress): string | null {
  const spent = progress.waves
    .flatMap((wave) => wave.stories)
    .filter((story) => story.cost_usd > 0);
  if (spent.length === 0) return null;
  return spent.map((story) => `${story.id} $${story.cost_usd.toFixed(2)}`).join(" · ");
}

function statusOf(runDir: string, id: string): string {
  const path = join(runDir, PLAN_DIR, "stories", `${id}.md`);
  if (!existsSync(path)) return "missing";
  try {
    return STATUS_RE.exec(readFileSync(path, "utf8"))?.[1] ?? "todo";
  } catch {
    return "todo";
  }
}

/**
 * Every `agent.result` tagged with a story, summed per story.
 *
 * `runNext` emits one per sub-agent an executor ran, keyed by `payload.key` — the
 * story id, for Build. `payload.story` is accepted too, so an executor that names
 * the story directly is read the same way.
 */
function costByStory(runDir: string): ReadonlyMap<string, number> {
  const costs = new Map<string, number>();
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return costs;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return costs;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: TldrxEvent;
    try {
      event = JSON.parse(line) as TldrxEvent;
    } catch {
      continue;
    }
    if (event.type !== "agent.result") continue;
    const payload = event.payload as { story?: unknown; key?: unknown };
    const story = typeof payload.story === "string" ? payload.story : payload.key;
    if (typeof story !== "string" || story === "") continue;
    costs.set(story, round((costs.get(story) ?? 0) + (typeof event.cost_usd === "number" ? event.cost_usd : 0)));
  }
  return costs;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
