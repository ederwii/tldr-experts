/**
 * The Plan phase's output schemas, rendered for the agent that has to write them
 * (gh #35, gh #38).
 *
 * Everything the `plan` check enforces was already written down — in
 * `schemas/story.ts`, `schemas/epic.ts`, `schemas/waves.ts` and
 * `schemas/planCommon.ts`. None of it reached the sub-agent. `stage.md` listed
 * the output FILENAMES and left the shape to be discovered by failing: on
 * `260831-hardening-d1` the plan agent wrote seven stories as plain markdown and
 * the commit check refused every one of them for having no front matter, and on
 * `260829-scoring-leaderboard` it wrote a 1,009-character acceptance item
 * against a 512-character cap that is named nowhere it could read. Both cost a
 * paid attempt to learn something this repo already knew.
 *
 * So this file states the contract — and states it by GENERATING it. The key
 * lists come from `STORY_KEYS` / `EPIC_KEYS`, the enum from `PLAN_STATUSES`, the
 * numbers from the `MAX_*` constants, and the worked examples are validated
 * against `validatePlan` itself in `test/plan-schema-contract.test.ts`. A prose
 * copy of a schema is a second source of truth, and the one this repo used to
 * ship — `templates/story.md` and `templates/epic.md`, correct and read by
 * nothing (gh #48) — is the reason this one is computed instead. Those two files
 * are DELETED as of 0.5.0 (owner decision, option (a)): `planContractExamples()`
 * is now the only story and the only epic anyone copies, and
 * `test/plan-schema-contract.test.ts` fails if either comes back.
 *
 * `Record<StoryKey, Field>` is load-bearing: add a key to `STORY_KEYS` and this
 * file stops compiling until the new key has a value and a rule here.
 */
import {
  MAX_ITEM_CHARS, MAX_LIST_ITEMS, MAX_PLAN_STORIES, MAX_STORIES_PER_WAVE,
  MAX_TOUCHES, MAX_WAVES, PLAN_STATUSES,
} from "../schemas/planCommon.ts";
import { STORY_KEYS } from "../schemas/story.ts";
import { EPIC_KEYS } from "../schemas/epic.ts";
import { FENCE } from "../schemas/frontMatter.ts";
import { EPICS_DIR, STORIES_DIR, WAVES_FILE } from "./validatePlan.ts";

/** The H2 the facilitator splices this under, in `stage.md`. */
export const PLAN_CONTRACT_HEADING = "Output schemas";

type StoryKey = (typeof STORY_KEYS)[number];
type EpicKey = (typeof EPIC_KEYS)[number];

interface Field {
  /** The value the worked example writes for this key, verbatim. */
  readonly value: string;
  /** What the validator enforces, in one clause. */
  readonly rule: string;
}

/** The enum as the schema spells it. Safe outside a table cell, not inside one. */
const STATUS_ENUM = PLAN_STATUSES.join(" | ");
/** The same list for a table cell, where a `|` would open a new column. */
const STATUS_CELL = PLAN_STATUSES.map((status) => `\`${status}\``).join(", ");
const ITEM_RULE = `non-empty · at most ${String(MAX_LIST_ITEMS)} items · at most ${String(MAX_ITEM_CHARS)} characters per item`;

/** The H3 the `touches` rule points at, and the checklist writes. */
const TOUCHES_CHECKLIST_HEADING = "Completing `touches`";

/**
 * The one Plan rule that is prose on purpose (gh #132).
 *
 * Everything else in this file is GENERATED from a validator, because a validator
 * refuses what breaks it and says why. Under-declaring `touches` breaks nothing:
 * `["src/thing.ts"]` is a well-formed list, `validateStory` passes it, and the
 * cost lands a stage later — the developer prompt says "Change only what the
 * story's `touches` list names. A change outside it is a plan deviation"
 * (`build/prompts.ts`), and auto-gate condition 7 `boundary` names every changed
 * path the plan never declared (`run/boundary.ts`). No compiler runs at Plan
 * time, so nothing can compute this list; the three sweeps below are what a
 * driver had to supply by hand.
 *
 * Measured, one live run, 5 stories: 3 needed the surface extended after the
 * fact. S2 could not write the failing test its own test plan promised (the test
 * file was outside `touches`). S4 added two enum members and left out the switch
 * sites, so the branch did not compile. S8's security criterion read a file the
 * story never declared, so the criterion would have passed on nothing. One rule
 * each, in the order they were hit.
 */
const TOUCHES_CHECKLIST: readonly (readonly string[])[] = [[
  "**Its tests.** For every source file the story changes, the file its tests live in — that",
  "file when it exists, its directory when the story creates it. A test plan that promises a",
  "failing test first cannot be satisfied from outside the surface.",
], [
  "**Every site that has to learn a new name.** For every enum member, variant, type or handler",
  "the story ADDS, every switch, registration, factory, DI container or barrel that has to handle",
  "it. These are what stop the branch compiling, and they live in files the definition never",
  "names — grep for the thing being EXTENDED, not for the member being added.",
], [
  "**Every file a gate reads.** For every acceptance criterion something verifies by reading a",
  "file, that file. A criterion whose file is not in the surface passes vacuously: the gate finds",
  "nothing to check and reports nothing wrong, which is worse than a criterion that fails.",
]];

/** Why the checklist is worth the bytes, in the prompt rather than in an issue. */
const TOUCHES_COST: readonly string[] = [
  "`touches` is the story's WRITE SURFACE, not a summary of it. The Build agent is told to change",
  "nothing outside it, and the Build gate names every changed path the plan never declared — so a",
  "path left out here is a path nobody writes, and **the story comes back for another paid round**.",
  "Over-declaring costs nothing by comparison. Three sweeps before you write the list:",
];

const STORY_FIELDS: Readonly<Record<StoryKey, Field>> = {
  version: { value: "1", rule: "always `1` — the schema version, not the story's" },
  id: { value: "S1", rule: "`S<n>` (1–4 digits) and it MUST equal the file name" },
  epic: { value: "E1", rule: "`E<n>`; that epic's `stories:` must list this story back" },
  title: { value: '"Materialise the leaderboard read model"', rule: `one line, at most ${String(MAX_ITEM_CHARS)} characters` },
  repo: { value: "example", rule: "one `.tldrx/workspace.yml` repo name — lowercase, digits and `-`" },
  status: { value: "todo", rule: `one of ${STATUS_CELL}; \`done\` also demands a non-empty \`evidence\`` },
  depends_on: { value: "[]", rule: "story ids, unique, never its own — and each must run in an EARLIER wave" },
  touches: {
    value: '["src/features/leaderboard/"]',
    rule: `non-empty · at most ${String(MAX_TOUCHES)} paths · no \`..\` — and COMPLETE: `
      + `see **${TOUCHES_CHECKLIST_HEADING}** below, the one rule here no validator can catch`,
  },
  acceptance: { value: '["Top-50 ranks render from the materialised view, newest hunt first"]', rule: ITEM_RULE },
  test_plan: { value: '["Unit: rank ordering with ties, empty table, single player"]', rule: ITEM_RULE },
  evidence: { value: "[]", rule: "Build fills it; leave it empty here" },
};

const EPIC_FIELDS: Readonly<Record<EpicKey, Field>> = {
  version: { value: "1", rule: "always `1`" },
  id: { value: "E1", rule: "`E<n>` (1–4 digits) and it MUST equal the file name" },
  title: { value: '"Player leaderboard"', rule: `one line, at most ${String(MAX_ITEM_CHARS)} characters` },
  repos: { value: "[example]", rule: "non-empty, unique `.tldrx/workspace.yml` repo names" },
  stories: { value: "[S1]", rule: "non-empty, unique story ids, every one of which has a file" },
  branch: {
    value: "epic/leaderboard",
    rule: "`epic/<slug>`, lowercase — the branch every story branch is cut from. If any story "
      + "`depends_on` a story in ANOTHER epic, the run cuts one integration branch for the whole "
      + "run instead and this value is not used (issue #57)",
  },
  status: { value: "todo", rule: `one of ${STATUS_CELL}` },
};

/** The dod command the worked story uses. Named so a validator can allow it. */
const EXAMPLE_DOD_COMMAND = "npm run test";

export interface PlanContractExamples {
  /** A `stories/S1.md` the `plan` check accepts as it stands. */
  readonly story: string;
  /** An `epics/E1.md` the `plan` check accepts as it stands. */
  readonly epic: string;
  /** A `waves.yml` the `plan` check accepts as it stands. */
  readonly waves: string;
  /**
   * The commands the story example's ```dod block runs. A caller validating the
   * example must allow them: `validateStoryDod` refuses every command under an
   * EMPTY allowlist, so an example checked without this looks broken.
   */
  readonly dodCommands: readonly string[];
}

function frontMatter(keys: readonly string[], fields: Readonly<Record<string, Field>>): readonly string[] {
  return [FENCE, ...keys.map((key) => `${key}: ${fields[key]?.value ?? ""}`), FENCE];
}

function ruleTable(keys: readonly string[], fields: Readonly<Record<string, Field>>): readonly string[] {
  return [
    "| key | what the check enforces |",
    "| --- | --- |",
    ...keys.map((key) => `| \`${key}\` | ${cell(fields[key]?.rule ?? "")} |`),
  ];
}

/** A table cell: a raw `|` would open a column, so it is escaped. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

export function planContractExamples(): PlanContractExamples {
  const story = [
    ...frontMatter(STORY_KEYS, STORY_FIELDS),
    "",
    "# S1 · Materialise the leaderboard read model",
    "",
    "The briefing a Build agent gets cold. Every claim ends in a `[src: …]` token.",
    "",
    "**Definition of done** — re-run by the gate, so every line is a workspace command:",
    "",
    "```dod",
    EXAMPLE_DOD_COMMAND,
    "```",
    "",
  ].join("\n");

  const epic = [
    ...frontMatter(EPIC_KEYS, EPIC_FIELDS),
    "",
    "# E1 · Player leaderboard",
    "",
    "What this epic is for, sourced — and the integration test that must be green",
    "across its stories before this branch merges.",
    "",
  ].join("\n");

  const waves = [
    "version: 1",
    "waves:",
    "  - {id: W1, stories: [S1]}",
    "",
  ].join("\n");

  return { story, epic, waves, dodCommands: [EXAMPLE_DOD_COMMAND] };
}

/** Every cap the Plan schemas enforce, with the constant that sets it. */
const CAPS: readonly { readonly value: number; readonly what: string }[] = [
  { value: MAX_ITEM_CHARS, what: "characters in ONE list item, and in a `title`" },
  { value: MAX_LIST_ITEMS, what: "items in ONE list (`acceptance`, `test_plan`, `depends_on`, `evidence`, `repos`, `stories`)" },
  { value: MAX_TOUCHES, what: "paths in a story's `touches`" },
  { value: MAX_WAVES, what: `waves in \`${WAVES_FILE}\`` },
  { value: MAX_STORIES_PER_WAVE, what: "stories in ONE wave" },
  { value: MAX_PLAN_STORIES, what: "scheduled stories in the whole plan" },
];

/**
 * The section spliced into the Plan stage's prompt.
 *
 * Long on purpose — roughly 2 KB against a stage budget measured in dollars, and
 * the alternative it replaces is a wasted attempt at ~$4.
 */
export function renderPlanSchemaContract(): string {
  const examples = planContractExamples();
  const outer = fenceFor(examples.story);
  return [
    "`tldrx next --commit` runs the `plan` check over these files before anything advances.",
    "It parses them; it does not read them. What follows is GENERATED from that check's own",
    "validators, so it is the contract itself, not a description of it. A file that does not",
    "fit is refused and the attempt is spent — there is no partial credit and no truncation.",
    "",
    `### \`${STORIES_DIR}/<id>.md\``,
    "",
    `Markdown that OPENS with a block of YAML front matter: line 1 is exactly \`${FENCE}\`, the`,
    `block closes at the next line that is exactly \`${FENCE}\`, and everything after it is prose`,
    "plus one fenced ```dod block. Exactly these keys, all required, in this order:",
    "",
    ...ruleTable(STORY_KEYS, STORY_FIELDS),
    "",
    `\`status\` is exactly one of \`${STATUS_ENUM}\` — nothing else parses.`,
    "",
    "The ```dod block is executed by `dod-gate` before `status: done` may ever be written, so",
    "every line in it must equal a `.tldrx/workspace.yml` command VERBATIM. A story may not",
    "invent a command, and an empty block is refused.",
    "",
    "Copy this — it is a file the check accepts as it stands:",
    "",
    outer,
    examples.story.trimEnd(),
    outer,
    "",
    `### ${TOUCHES_CHECKLIST_HEADING}`,
    "",
    ...TOUCHES_COST,
    "",
    ...renderTouchesChecklist(),
    "",
    "A directory entry covers everything beneath it, so declare the directory when the story",
    "creates files there. If a sweep turns up a path you are not sure about, list it: an",
    "unused entry is not a schema error, and a missing one is a round.",
    "",
    `### \`${EPICS_DIR}/<id>.md\``,
    "",
    "The same front matter rules. Exactly these keys, all required, in this order:",
    "",
    ...ruleTable(EPIC_KEYS, EPIC_FIELDS),
    "",
    "An epic is a branch and a list of stories. Its BODY is prose — what the epic is for, and",
    "the integration test its stories have to pass together. Do NOT restate a story's status,",
    `repo or \`depends_on\` in it: those live in \`${STORIES_DIR}/<id>.md\` and the Build phase`,
    "writes them there, so a second copy in the epic is wrong from the first story that lands.",
    "",
    outer,
    examples.epic.trimEnd(),
    outer,
    "",
    `### \`${WAVES_FILE}\``,
    "",
    "Plain YAML, no front matter. Wave ids ascend (`W1`, `W2`, …) because the file order IS the",
    "execution order; a story is scheduled in exactly ONE wave; every story with a file must be",
    "scheduled; and a story's `depends_on` must all run in an EARLIER wave — the stories inside",
    "one wave are handed to parallel agents in separate worktrees.",
    "",
    outer,
    examples.waves.trimEnd(),
    outer,
    "",
    "### Caps",
    "",
    "Enforced, and stated here at the value the check currently uses:",
    "",
    ...CAPS.map((cap) => `- **${String(cap.value)}** — ${cap.what}`),
    "",
    `An over-cap value is refused, never trimmed. Split a long acceptance criterion into several`,
    `items rather than writing one over ${String(MAX_ITEM_CHARS)} characters.`,
  ].join("\n");
}

/** The checklist as a numbered markdown list, continuation lines indented under it. */
function renderTouchesChecklist(): readonly string[] {
  return TOUCHES_CHECKLIST.flatMap((rule, index) =>
    rule.map((line, at) => (at === 0 ? `${String(index + 1)}. ${line}` : `   ${line}`)));
}

/** A fence longer than any fence inside `text`, so an example nests safely. */
function fenceFor(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/^\s*(`{3,})/gm)) {
    longest = Math.max(longest, (match[1] ?? "").length);
  }
  return "`".repeat(longest + 1);
}
