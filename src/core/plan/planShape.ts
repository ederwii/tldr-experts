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
      + `\`${WAVES_FILE}\` records \`${WAVE_CAP_REASON_KEY}: "<why these stories cannot share a wave>"\` — one sentence `
      + `on one line, at most ${String(MAX_ITEM_CHARS)} characters (#328).`,
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
  {
    issue: "#365",
    text: "**A story that adds an invariant over EXISTING data lands in the same story as, or in a wave after, the "
      + "story that makes existing rows and fixtures satisfy it.** A check constraint, a `NOT NULL`, a required "
      + "field or a validation rule written ahead of the story that populates what it enforces makes that earlier "
      + "story's own dod structurally red — every fixture the enforcing story's own tests run against still lacks "
      + "the value, and two stories in the SAME wave run in separate worktrees that never see each other's writes, "
      + "so 'later wave' is the only way one story's data can satisfy another's rule. If the invariant must land "
      + "first, write it NON-ENFORCING — nullable, consistency-only, no constraint — and let the later story "
      + "tighten it once the data exists. The `plan` check refuses a story whose acceptance or test plan names an "
      + "enforcement over a field a later story's acceptance or test plan names populating.",
  },
];

/**
 * The gate's refusal for a plan over the wave cap. `written`: the root key's value
 * as parsed, `undefined` when the plan wrote none. A string over the cap is told
 * its length and the cap (#328), the way an over-cap list item is.
 */
export function waveCapMessage(waves: number, written?: unknown): string {
  return `${String(waves)} waves — the framework carries ${String(MAX_WAVES_PER_RUN)} per run today `
    + `(patch for ${RUN_SIZE_ISSUES}; a later wave waits on every earlier merge, #316): run independent stories `
    + `in parallel, split the run, or record why at the root of ${WAVES_FILE} as \`${WAVE_CAP_REASON_KEY}: "<why>"\``
    + invalidReason(written);
}

function invalidReason(written: unknown): string {
  if (written === undefined) return "";
  const key = `\`${WAVE_CAP_REASON_KEY}\``;
  if (typeof written === "string" && written.length > MAX_ITEM_CHARS) {
    return ` — the ${key} written is ${String(written.length)} characters (cap ${String(MAX_ITEM_CHARS)}): one sentence, on one line`;
  }
  return ` — the ${key} written is not a non-empty line of at most ${String(MAX_ITEM_CHARS)} characters`;
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

/**
 * Sequencing over an invariant (#365): the SHORT, EXPLICIT keyword set the
 * mechanical check scans a story's `acceptance`/`test_plan` sentences for.
 * Deliberately narrow — a wider net would flag honest prose ("this validates
 * the happy path") as an enforcement claim, and the cost of a false positive
 * here is a refused plan, not a warning. Exported so `test/plan-shape.test.ts`
 * holds the list to the source, the way every other rule in this file does.
 */
export const ENFORCEMENT_KEYWORDS = [
  "check constraint", "not null", "required", "must be present", "validation rule", "rejects", "refuses",
] as const;

/** The populate-verb half of the same pair (#365). Same shape, same reason it is short. */
export const POPULATE_VERBS = ["sets", "populates", "writes", "stores", "fills", "assigns"] as const;

/** The first phrase from `phrases` that appears in `text` as a whole word/phrase, case-insensitive; else `null`. */
function firstMatch(text: string, phrases: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(lower)) return phrase;
  }
  return null;
}

/**
 * Case and separators carry no identity for a field/column name — `delivery_address_text`,
 * `DeliveryAddressText`, `deliveryAddressText` and `delivery-address-text` are one field spelled
 * four ways. The incident this validator exists for was exactly a verbatim-token miss of this
 * shape: the enforcing story's constraint named the field `snake_case`, the populating story's
 * sentence named it `PascalCase`, and a plain string match saw two different fields (review
 * finding on #365). Everything downstream compares on this normalized form; the ORIGINAL
 * spelling — what `fieldsIn` actually captured — is kept separately for the refusal message,
 * which must quote each story's own wording, findable verbatim in its file.
 */
function normalizeField(token: string): string {
  return token.toLowerCase().replace(/[_-]/g, "");
}

/**
 * The field/column names a sentence mentions, keyed by their NORMALIZED form so differently
 * spelled mentions of the same field collide, valued by the spelling as it actually appears.
 * Three candidate shapes, none of which plain English prose accidentally produces: a
 * backtick-quoted identifier (any case, `_` or `-` allowed inside); a bare `snake_case` token;
 * and a bare `camelCase`/`PascalCase` token (an inner capital following a lowercase run — a
 * single Capitalized word, e.g. a sentence-initial one, has no SECOND capitalized segment and so
 * does not match). Heuristic, not a parser: it costs nothing to miss a field named some other
 * way, because the validator only ever REFUSES on a match — it never claims a plan is clean.
 */
function fieldsIn(text: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const pattern = /`([a-zA-Z_][\w-]*)`|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b|\b([A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    if (raw === "") continue;
    const key = normalizeField(raw);
    if (key !== "" && !found.has(key)) found.set(key, raw);
  }
  return found;
}

/**
 * The gate's refusal for an invariant enforced at or before the story that populates it (#365).
 * `enforceField`/`populateField` are each story's OWN spelling — equal when both stories wrote
 * the field the same way, and named separately when they did not (review finding: a snake_case
 * enforcement and a PascalCase populate are the same field and must both be readable in the
 * message, never silently collapsed to one spelling).
 */
export function invariantSequencingMessage(
  enforceId: string, populateId: string, enforceField: string, populateField: string,
  enforceSentence: string, populateSentence: string,
): string {
  const spelling = enforceField === populateField ? "" : " — the same field, spelled differently in each story";
  return `${enforceId} enforces \`${enforceField}\` ("${enforceSentence}") no later than ${populateId}, which `
    + `populates \`${populateField}\` ("${populateSentence}")${spelling} — a story that adds an invariant over `
    + `existing data lands in the same story as, or in a wave after, the story that makes existing rows satisfy `
    + `it (#365); move ${enforceId} to a later wave, merge the two stories, or write ${enforceId}'s check `
    + `non-enforcing (nullable/consistency-only) until ${populateId} lands`;
}

interface StoryText { readonly id: string; readonly sentences: readonly { readonly text: string; readonly field: string }[] }

/** Every acceptance/test_plan sentence of a story, tagged with which list it came from. */
function sentencesOf(story: { readonly acceptance: readonly string[]; readonly testPlan: readonly string[] }): StoryText["sentences"] {
  return [
    ...story.acceptance.map((text) => ({ text, field: "acceptance" })),
    ...story.testPlan.map((text) => ({ text, field: "test_plan" })),
  ];
}

/**
 * The mechanical half of #365: a story enforcing a field no later than the
 * story that populates it. `at` is the wave index each story id resolves to
 * (`scheduleOf`) — the only order this reads, because a valid plan's
 * `depends_on` graph already has to agree with it (`validateWaveOrder`
 * refuses otherwise), so wave index and dependency order are the same
 * question here. Two different stories sharing one wave still violates the
 * rule: wave siblings run as parallel sub-agents in separate worktrees and
 * never see each other's writes, so only "same story" or "a later wave"
 * actually satisfies the invariant.
 */
function invariantSequencingIssues(
  stories: ReadonlyMap<string, { readonly id: string; readonly acceptance: readonly string[]; readonly testPlan: readonly string[] }>,
  at: ReadonlyMap<string, number>,
): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];
  const reported = new Set<string>();
  for (const enforcer of stories.values()) {
    const enforcerAt = at.get(enforcer.id);
    if (enforcerAt === undefined) continue;
    for (const enforceSentence of sentencesOf(enforcer)) {
      if (firstMatch(enforceSentence.text, ENFORCEMENT_KEYWORDS) === null) continue;
      const enforceFields = fieldsIn(enforceSentence.text);
      if (enforceFields.size === 0) continue;
      for (const populator of stories.values()) {
        if (populator.id === enforcer.id) continue;
        const populatorAt = at.get(populator.id);
        if (populatorAt === undefined || enforcerAt > populatorAt) continue; // genuinely after: fine
        for (const populateSentence of sentencesOf(populator)) {
          if (firstMatch(populateSentence.text, POPULATE_VERBS) === null) continue;
          const populateFields = fieldsIn(populateSentence.text);
          const sharedKey = [...enforceFields.keys()].find((k) => populateFields.has(k));
          if (sharedKey === undefined) continue;
          const key = `${enforcer.id}>${populator.id}>${sharedKey}`;
          if (reported.has(key)) continue;
          reported.add(key);
          issues.push({
            file: `${STORIES_DIR}/${enforcer.id}.md`,
            path: enforceSentence.field,
            message: invariantSequencingMessage(
              enforcer.id, populator.id, enforceFields.get(sharedKey) ?? sharedKey, populateFields.get(sharedKey) ?? sharedKey,
              enforceSentence.text, populateSentence.text,
            ),
          });
        }
      }
    }
  }
  return issues;
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

  interface Read {
    readonly id: string; readonly epic: string; readonly repo: string; readonly deps: readonly string[];
    readonly dod: readonly string[]; readonly acceptance: readonly string[]; readonly testPlan: readonly string[];
  }
  const stories = new Map<string, Read>();
  const dir = join(planDir, STORIES_DIR);
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")).sort() : [];
  for (const name of names) {
    const parsed = validateStoryFile(readFileSync(join(dir, name), "utf8"));
    const story = parsed.story;
    if (story === null || stories.has(story.id)) continue;
    stories.set(story.id, {
      id: story.id, epic: story.epic, repo: story.repo, deps: story.depends_on, dod: parsed.dod.commands,
      acceptance: story.acceptance, testPlan: story.test_plan,
    });
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
      if (!valid) issues.push({ file: WAVES_FILE, path: WAVE_CAP_REASON_KEY, message: waveCapMessage(count, reason) });
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

    issues.push(...invariantSequencingIssues(stories, at));
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
