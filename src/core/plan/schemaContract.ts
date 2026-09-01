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
 * copy of a schema is a second source of truth, and the one already in this repo
 * — `templates/story.md`, correct and read by nothing — is the reason this one
 * is computed instead.
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

const STORY_FIELDS: Readonly<Record<StoryKey, Field>> = {
  version: { value: "1", rule: "always `1` — the schema version, not the story's" },
  id: { value: "S1", rule: "`S<n>` (1–4 digits) and it MUST equal the file name" },
  epic: { value: "E1", rule: "`E<n>`; that epic's `stories:` must list this story back" },
  title: { value: '"Materialise the leaderboard read model"', rule: `one line, at most ${String(MAX_ITEM_CHARS)} characters` },
  repo: { value: "example", rule: "one `.tldrx/workspace.yml` repo name — lowercase, digits and `-`" },
  status: { value: "todo", rule: `one of ${STATUS_CELL}; \`done\` also demands a non-empty \`evidence\`` },
  depends_on: { value: "[]", rule: "story ids, unique, never its own — and each must run in an EARLIER wave" },
  touches: { value: '["src/features/leaderboard/"]', rule: `non-empty · at most ${String(MAX_TOUCHES)} paths · no \`..\`` },
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
  branch: { value: "epic/leaderboard", rule: "`epic/<slug>`, lowercase — the branch every story branch is cut from" },
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
    `### \`${EPICS_DIR}/<id>.md\``,
    "",
    "The same front matter rules. Exactly these keys, all required, in this order:",
    "",
    ...ruleTable(EPIC_KEYS, EPIC_FIELDS),
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

/** A fence longer than any fence inside `text`, so an example nests safely. */
function fenceFor(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/^\s*(`{3,})/gm)) {
    longest = Math.max(longest, (match[1] ?? "").length);
  }
  return "`".repeat(longest + 1);
}
