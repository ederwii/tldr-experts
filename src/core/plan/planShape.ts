/**
 * The Plan's SHAPE — how many waves it runs, which wave each story sits in, and
 * which commands sibling stories re-run (#316, #317, #318, #319). ONE source
 * (AGENTS.md §7): the `plan` gate enforces the mechanical rules from here, the
 * Plan prompt's `## Output schemas` renders `PLAN_SHAPE_RULES` from here
 * (`schemaContract.ts`), `tldrx seed check` prints its size advisories off the
 * constants and sentences here, and the planning skill cites the rendered
 * section by `tldrx plan schema` instead of typing a number of its own.
 *
 * Measured by a planning audit of 9 runs, 37 multi-story stories and 54
 * build-gate rejections (relayed as that audit's measurement, #316–#319): 25/54
 * rejections were dependency reopens; every multi-story plan checked in one
 * workspace was a strict one-story-per-wave chain; a 4-wave plan left 2 stories
 * never attempted after 3 build gates; a layer-split story was refused as
 * unreachable; 16/37 stories widened `touches:` at Build; and an e2e story that
 * depended on everything else was never reached.
 *
 * What is enforced and what is only said, and why:
 *
 *   - **wave cap** — refused (the gate family, `approve` exit 2) unless `waves.yml`
 *     records `wave_cap_reason`. A cap with a recorded escape, not a law: the
 *     number is the framework's CURRENT carry (patch for #286/#244/#280).
 *   - **a story held later than its `depends_on` needs** — refused. The fix is a
 *     one-line move, and the one legitimate reason to wait (two stories editing
 *     one file, #286) is already written as a `depends_on` edge by the boundary
 *     rule, so a story with nothing making it wait has no reason the file could
 *     hold that the edge would not hold better.
 *   - **uneven dod inside one epic and repo** — an ADVISORY in the passed
 *     detail. Which stories are "of the same shape" is not machine-readable (a
 *     schema-only story rightly skips an e2e command), and the issue's evidence
 *     is one epic, relayed: a refusal on that would refuse honest plans.
 *   - **vertical slices** and **inventory files in `touches`** — prompt only. A
 *     route or registration file has no stack-independent name, so a heuristic
 *     over `touches:` would refuse backend stories whose endpoint lives in an
 *     ordinary module; and no file set exists at Plan time to compare `touches`
 *     against — the Build side already names every widening after the fact
 *     (`story.touches_widened`, #185).
 *
 * `waves.yml` stays `version: 1`: `wave_cap_reason` is an ADDITIVE, optional root
 * key that nothing before this file read, and every plan written before it is
 * still a file the Build loader accepts — the shape check is the gate's own, not
 * a pass inside `validatePlan`, which the Build loader refuses on (the same split
 * as `validatePlanBudget`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../yaml.ts";
import { isRecord } from "../schemas/validation.ts";
import { MAX_ITEM_CHARS } from "../schemas/planCommon.ts";
import { validateStoryFile } from "../schemas/story.ts";
import { asWavesFile, scheduleOf, validateWaves } from "../schemas/waves.ts";
import { STORIES_DIR, WAVES_FILE, type PlanIssue } from "./validatePlan.ts";

/**
 * The size the framework carries per run today — a PATCH, not a craft rule.
 * Raise both when #286 (conflict resolution), #244/#289 (budgets) and #280
 * (dependency in review) close; every sentence below names them so the number
 * is never read as a design preference.
 */
export const MAX_STORIES_PER_RUN = 4;
export const MAX_WAVES_PER_RUN = 2;
export const RUN_SIZE_ISSUES = "#286/#244/#280";

/** The optional root key of `waves.yml` that lets a plan past the wave cap. */
export const WAVE_CAP_REASON_KEY = "wave_cap_reason";

/** The H3 the Plan prompt renders the rules under, and the skill and stage.md cite. */
export const PLAN_SHAPE_HEADING = "Plan shape";

export interface PlanShapeRule {
  /** The issue that measured it — a citation, not a patch marker (only the wave cap is a patch). */
  readonly issue: string;
  /** One markdown bullet body, rendered verbatim into the Plan prompt. */
  readonly text: string;
}

export const PLAN_SHAPE_RULES: readonly PlanShapeRule[] = [
  {
    issue: "#316",
    text: `**At most ${String(MAX_WAVES_PER_RUN)} waves** (patch for ${RUN_SIZE_ISSUES} — the framework's measured `
      + "carry today, not a design preference). A later wave waits on every earlier merge, so each extra wave is "
      + "a stall: a 4-wave plan left 2 stories never attempted. The `plan` check refuses more unless the root of "
      + `\`${WAVES_FILE}\` records \`${WAVE_CAP_REASON_KEY}: "<why these stories cannot share a wave>"\`.`,
  },
  {
    issue: "#316",
    text: "**Every story runs in the EARLIEST wave its `depends_on` allows.** `depends_on: []` runs in W1; a story "
      + "whose dependencies all finish in W1 runs in W2. The `plan` check refuses a story held later with nothing "
      + "making it wait. If something does — two stories editing one file — that is a `depends_on` edge: write it.",
  },
  {
    issue: "#317",
    text: "**Each story is a vertical slice.** When its own dod goes green, what it adds is reachable from a route, "
      + "endpoint, command or job that a user or caller actually hits — not only from its own tests. A component "
      + "no route renders, or a handler nothing registers, is refused at Build review as unreachable: put the wiring "
      + "in the same story, and the wiring's file in its `touches`. No check reads this; the review does.",
  },
  {
    issue: "#318",
    text: "**Inventory files go in `touches` up front.** Grep for the tests, snapshots and generated files that "
      + "ENUMERATE what the story adds — route trees, guard tables, allow-lists, architecture or coverage "
      + "inventories, approved snapshots — and declare them. They change because the story's change forces them "
      + "to, not because anyone meant to edit them, and each one left out is a `touches` widening at Build.",
  },
  {
    issue: "#319",
    text: "**End-to-end coverage is not the last story.** Either a test-harness story runs in W1 and later stories "
      + "depend on it and run against it, or each UI or feature story carries the e2e command in its own dod. A "
      + "final e2e story that depends on everything is the story never reached. The `plan` check names a command "
      + "some stories of one epic and repo carry and a sibling does not — an advisory: say in that story why not.",
  },
];

/** The gate's refusal for a plan over the wave cap. `invalid`: a reason was written and is not one. */
export function waveCapMessage(waves: number, invalid = false): string {
  return `${String(waves)} waves — the framework carries ${String(MAX_WAVES_PER_RUN)} per run today `
    + `(patch for ${RUN_SIZE_ISSUES}; a later wave waits on every earlier merge, #316): run independent stories `
    + `in parallel, split the run, or record why at the root of ${WAVES_FILE} as \`${WAVE_CAP_REASON_KEY}: "<why>"\``
    + (invalid ? ` — the \`${WAVE_CAP_REASON_KEY}\` written is not a non-empty line of at most ${String(MAX_ITEM_CHARS)} characters` : "");
}

/** The gate's refusal for a story scheduled later than its dependencies need. */
export function lateStoryMessage(story: string, wave: string, earliest: string): string {
  return `${story} runs in ${wave} but nothing it depends on makes it wait — it can run in ${earliest}; `
    + "move it there, or, if it must wait (two stories editing one file), write that edge as depends_on (#316)";
}

/** The gate's advisory for one command some siblings carry in their dod and others do not. */
export function unevenDodAdvisory(
  epic: string, repo: string, command: string, carriers: readonly string[], missing: readonly string[],
): string {
  return `${epic} (${repo}): \`${command}\` is in the dod of ${carriers.join(", ")} but not ${missing.join(", ")} — `
    + "end-to-end coverage deferred to one story is the story never reached (#319); carry it where it is needed, "
    + "or say in the story why it is not";
}

/** `tldrx seed check`'s size advisory. */
export function storyCountAdvisory(stories: number): string {
  return `${String(stories)} stories — today the framework carries ${String(MAX_STORIES_PER_RUN)} per run alone `
    + `(patch for ${RUN_SIZE_ISSUES} — the measured limit, not a design preference); split into two seeds or say why not`;
}

/** `tldrx seed check`'s waves advisory. */
export function waveCapAdvisory(waves: number): string {
  return `${String(waves)} waves of dependencies — today the framework carries ${String(MAX_WAVES_PER_RUN)} per run alone `
    + `(patch for ${RUN_SIZE_ISSUES}); a later wave waits on every earlier merge, and the Plan gate refuses more `
    + `unless ${WAVES_FILE} records \`${WAVE_CAP_REASON_KEY}\``;
}

export interface PlanShapeReport {
  /** Refusals — the `plan` gate fails on any. */
  readonly issues: readonly PlanIssue[];
  /** Said in the gate's passed detail; never fails it. */
  readonly advisories: readonly string[];
}

/**
 * The shape rules over a `03-plan/` folder. Files that do not parse or validate
 * are `validatePlan`'s to report, so they are skipped here, never re-reported.
 */
export function validatePlanShape(planDir: string): PlanShapeReport {
  const issues: PlanIssue[] = [];
  const advisories: string[] = [];

  interface Read { readonly id: string; readonly epic: string; readonly repo: string; readonly deps: readonly string[]; readonly dod: readonly string[] }
  const stories = new Map<string, Read>();
  const dir = join(planDir, STORIES_DIR);
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")).sort() : [];
  for (const name of names) {
    const parsed = validateStoryFile(readFileSync(join(dir, name), "utf8"));
    const story = parsed.story;
    if (story === null || stories.has(story.id)) continue;
    stories.set(story.id, { id: story.id, epic: story.epic, repo: story.repo, deps: story.depends_on, dod: parsed.dod.commands });
  }

  const wavesPath = join(planDir, WAVES_FILE);
  let doc: unknown = null;
  try {
    doc = existsSync(wavesPath) ? parseYaml(readFileSync(wavesPath, "utf8")) : null;
  } catch {
    doc = null;
  }
  if (doc !== null && validateWaves(doc).ok) {
    const waves = asWavesFile(doc);
    const count = waves.waves.length;
    if (count > MAX_WAVES_PER_RUN) {
      const reason = isRecord(doc) ? doc[WAVE_CAP_REASON_KEY] : undefined;
      const valid = typeof reason === "string" && reason.trim() !== "" && reason.length <= MAX_ITEM_CHARS && !reason.includes("\n");
      if (!valid) issues.push({ file: WAVES_FILE, path: WAVE_CAP_REASON_KEY, message: waveCapMessage(count, reason !== undefined) });
    }

    const at = scheduleOf(waves);
    waves.waves.forEach((wave, index) => {
      wave.stories.forEach((id, i) => {
        const story = stories.get(id);
        if (story === undefined) return;
        let earliest = 0;
        for (const dep of story.deps) {
          const depAt = at.get(dep);
          if (depAt === undefined) return; // validateWaveOrder names it
          earliest = Math.max(earliest, depAt + 1);
        }
        if (index > earliest) {
          const target = waves.waves[earliest]?.id ?? `W${String(earliest + 1)}`;
          issues.push({ file: WAVES_FILE, path: `waves[${String(index)}].stories[${String(i)}]`, message: lateStoryMessage(id, wave.id, target) });
        }
      });
    });
  }

  const groups = new Map<string, Read[]>();
  for (const story of stories.values()) {
    const key = `${story.epic}/${story.repo}`;
    groups.set(key, [...(groups.get(key) ?? []), story]);
  }
  for (const group of [...groups.values()].sort((a, b) => groupKey(a).localeCompare(groupKey(b)))) {
    if (group.length < 2) continue;
    const commands: string[] = [];
    for (const story of group) for (const command of story.dod) if (!commands.includes(command)) commands.push(command);
    for (const command of commands) {
      const carriers = group.filter((s) => s.dod.includes(command)).map((s) => s.id).sort(byStoryId);
      if (carriers.length === group.length) continue;
      const missing = group.filter((s) => !s.dod.includes(command)).map((s) => s.id).sort(byStoryId);
      const first = group[0];
      if (first === undefined) continue;
      advisories.push(unevenDodAdvisory(first.epic, first.repo, command, carriers, missing));
    }
  }
  return { issues, advisories };
}

function groupKey(group: readonly { readonly epic: string; readonly repo: string }[]): string {
  return `${group[0]?.epic ?? ""}/${group[0]?.repo ?? ""}`;
}

function byStoryId(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1));
}
