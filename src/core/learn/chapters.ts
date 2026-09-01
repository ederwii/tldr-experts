/**
 * The chapters, as data. All eight of issue #30 live here.
 *
 * Read `Chapter.ts` first — it is the contract, and it carries the note on what
 * a new chapter needs (data, an `agentTurns:` list if it spawns, and one
 * `assert()` over files). Nothing in `engine.ts` should have to change for one.
 *
 *   1. init                 what the framework knows before you tell it anything
 *   2. run new + What       a question becomes a fact
 *   3. the gate             an approval is a record
 *   4. build one story      branch → agent → DoD → commit → merge → review
 *   5. when things go wrong a red DoD, and the way back from it
 *   6. attend vs auto       who is allowed to spawn
 *   7. unattended           an agent gate, closed over an evidence note
 *   8. money                the ledger, the estimate, and the brake
 *
 * ## Five things that will bite the next person who edits this file
 *
 * **`{runDir}` / `{run}`** in a turn's file paths and contents — and in a step's
 * `command` — expand at the moment the step runs (`engine.ts`). A sub-agent's cwd
 * is the WORKSPACE ROOT for a stage turn (`facilitator/runNext.ts:559`), so a
 * stage output needs the `{runDir}/` prefix; a BUILD turn's cwd is the story's
 * worktree, so its paths are plain repo paths with no prefix at all.
 *
 * **A turn's `match:` is a SUBSTRING of the whole prompt, and the prompt carries
 * every expert.md.** Every expert file has a `## How to reason` heading, which
 * contains `# How` — so `match: "# How"` fires on every prompt in the framework.
 * Match on the stage template's first heading in full (`"# How — handoff"`), or a
 * chapter will silently play the wrong turn and fail three lines later on a
 * missing output.
 *
 * **Every declared output is re-read off the disk** (`facilitator/validateOutputs.ts`).
 * A turn that writes five of six fails the stage. `handoff.md` additionally has to
 * pass `claim-sources` — four H2 sections, every bullet ending in a `[src: …]`
 * token that RESOLVES, line numbers included: `src/pricing.ts` is four lines long
 * and a citation of line 5 fails the stage.
 *
 * **An `auto` gate needs a questions.md the §2.7 parser can read, with nothing
 * open** (`run/autoGate.ts:questionsCondition`). A stage that declares
 * `questions.md` as an output and writes a file with no `## Qn · …` block does not
 * get "0 open" — it gets "no parseable question", and the gate falls to a person.
 * That is why the How and What turns here write a block already `answered`,
 * carrying the fact that answered it.
 *
 * **A stage's budget is spent once.** The brake compares what the phase has LEFT
 * against the stage's whole estimate, so any second attempt at any stage is
 * refused until `tldrx budget raise` gives it room (measured; it is why chapter 5
 * has seven steps and chapter 8 has a brake to show at all).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtime } from "../runtime/index.ts";
import { PROJECT_WORK_DIR } from "../paths.ts";
import { newestRunId, sandboxHas } from "./engine.ts";
import type { Chapter } from "./Chapter.ts";
import type { Sandbox } from "./sandbox.ts";

/** The run chapter 2 creates, and every later chapter carries on with. */
export const LEARN_RUN_SLUG = "bulk-pricing";

const QUESTION_ID = "Q1";

/**
 * The six files the What sub-agent writes.
 *
 * Real documents, not lorem: the learner is about to be told to open two of
 * them, and a tutorial whose artefacts are placeholders teaches that the
 * artefacts do not matter.
 */
const WHAT_OUTPUTS: Readonly<Record<string, string>> = {
  "{runDir}/01-what/intent.md": [
    "# Intent",
    "",
    "## Intent",
    "Bulk SKUs are priced like everything else. They should not be.",
    "",
    "## Scope",
    "In: the price lookup. Out: the stock ledger, the README.",
    "",
  ].join("\n"),
  "{runDir}/01-what/scope.md": [
    "# Scope",
    "",
    "## In",
    "- the price lookup in `src/pricing.ts`",
    "",
    "## Out",
    "- the stock ledger — nothing about quantity changes",
    "",
  ].join("\n"),
  "{runDir}/01-what/success-metrics.md": [
    "# Success metrics",
    "",
    "- A `BULK-` SKU prices lower than the same SKU without the prefix.",
    "- No other SKU's price moves.",
    "",
  ].join("\n"),
  "{runDir}/01-what/open-questions.md": [
    "# Open questions",
    "",
    "- Where the price table should live once there is more than one rule.",
    "",
  ].join("\n"),
  // Four H2 sections, every bullet ending in a source token: this is what
  // `claim-sources` enforces, and a handoff that skips it fails the stage.
  "{runDir}/01-what/handoff.md": [
    "# What — handoff",
    "",
    "## Findings",
    "- The price lookup is one function with a hard-coded pair of numbers [src: src/pricing.ts:2]",
    "- The workspace has one repo and a test command [src: .tldrx/workspace.yml:1]",
    "",
    "## Decisions",
    "- In scope: the price lookup. Out: the stock ledger [src: src/pricing.ts:2]",
    "",
    "## Unknowns",
    "- Where a price table would live, once there is more than one rule [src: absent:src/prices.json]",
    "",
    "## Evidence ledger",
    "- The bulk branch is a string prefix test, not a table [src: src/pricing.ts:2]",
    "- Nothing in this workspace stores prices as data [src: absent:src/prices.json]",
    "",
  ].join("\n"),
  // The grammar here is a PARSER's, not a style — `## Q1 · …` with U+00B7, all
  // five metadata keys, options lettered A-E, one empty `[Answer]:` slot.
  // `core/text/questions.ts:89,114-119` is what reads it.
  "{runDir}/01-what/questions.md": [
    `## ${QUESTION_ID} · Where should the price table live?`,
    `<!-- id: ${QUESTION_ID} | status: open | area: data-model | asked_by: product`
    + " | asked_at: 2026-09-01T09:00:00Z -->",
    "Why asked: nothing in this workspace stores prices as data [src: absent:src/prices.json]",
    "",
    "- A) Keep it in `src/pricing.ts`, as a constant",
    "- B) A JSON file the build reads",
    "- C) other — write it below",
    "",
    "[Answer]:",
    "",
  ].join("\n"),
};

const CHAPTER_1: Chapter = {
  n: 1,
  id: "init",
  title: "init — what the framework knows before you tell it anything",
  intro: [
    "There is a tiny repo in this sandbox: four files, a package.json, one commit.",
    "`tldrx init` reads it. No model, no network, no API key — filesystem and git only.",
    "Everything it writes afterwards is something it MEASURED, not something you declared.",
  ],
  steps: [
    {
      narrate: [
        "`--provider static` keeps the code map offline (the default would shell out to graphify),",
        "and `--no-interview` skips the setup questions, which chapter 2 covers properly.",
      ],
      command: ["init", "--provider", "static", "--no-interview"],
    },
  ],
  debrief: [
    "That repo table came from detection, not from you. Open `.tldrx/workspace.yml`:",
    "the stack, the default branch, the build/test commands and a `confidence:` for each.",
    "`.tldrx/conventions/` holds what it inferred about how this repo is written.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    if (!sandboxHas(sandbox, ".tldrx/workspace.yml")) {
      failures.push(".tldrx/workspace.yml was not written — `tldrx init` detected nothing.");
    } else {
      const text = read(sandbox, ".tldrx/workspace.yml");
      if (!text.includes("repos:")) failures.push(".tldrx/workspace.yml has no `repos:` table.");
      if (!text.includes("commands:")) failures.push(".tldrx/workspace.yml recorded no commands for the repo.");
    }
    if (!sandboxHas(sandbox, ".tldrx/conventions/shared.md")) {
      failures.push(".tldrx/conventions/shared.md was not written.");
    }
    if (!sandboxHas(sandbox, ".tldrx/memory/facts.yml")) {
      failures.push(".tldrx/memory/facts.yml was not created — chapter 2 needs it.");
    }
    return failures;
  },
};

const CHAPTER_2: Chapter = {
  n: 2,
  id: "what",
  title: "a question becomes a fact",
  requires: [1],
  intro: [
    "A run is a directory. `run new` makes one; `next` runs the stage the cursor is on.",
    "The first stage is What, and What's job is to come back with what it does NOT know.",
    "Its sub-agent here is a stand-in — instant, deterministic, and $0.00. Everything else is real.",
  ],
  steps: [
    {
      narrate: [
        "`run new` is deterministic and offline: it writes a run directory and stops.",
        "Nothing is spawned, nothing is spent.",
      ],
      command: ["run", "new", LEARN_RUN_SLUG, "--title", "Bulk SKUs should price lower"],
    },
    {
      narrate: [
        "`next` runs one stage — the one the cursor is on — and stops at its gate.",
        "It exits 4, which is not a failure: 4 is `awaiting a human`, the framework's",
        "way of saying the work is done and the decision is yours.",
      ],
      command: ["next"],
      // The gate on `what` is `human` in every workflow preset (workflows/feature.yml:20),
      // so the stage ends at exit 4 and that is the pass.
      expectExit: [4],
      agentTurns: [{
        match: "# What",
        say: "Read the pricing function and the workspace table; one thing is genuinely unknown.",
        costUsd: 0.31,
        writes: WHAT_OUTPUTS,
      }],
    },
    {
      narrate: [
        "One question came back. Answering it on the command line is not a formality:",
        "the answer is recorded, dated, attributed, and given an id.",
      ],
      command: ["answer", QUESTION_ID, "B — a JSON file the build reads"],
    },
  ],
  debrief: [
    "Open `.tldrx/memory/facts.yml`: your sentence is now `F001`, with who said it, when,",
    "which run and which question. Open the run's `01-what/questions.md` and Q1 says",
    "`status: answered` with `fact: F001` under it. Nothing will ask you that again.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    const run = newestRunId(sandbox);
    if (run === null) {
      return ["no run was created under tldrx-work/ — `tldrx run new` wrote nothing."];
    }
    const questionsRel = join(PROJECT_WORK_DIR, run, "01-what", "questions.md");
    if (!sandboxHas(sandbox, questionsRel)) {
      failures.push(`${questionsRel} was not written — the What stage produced no questions.`);
    } else {
      const questions = read(sandbox, questionsRel);
      if (!questions.includes("status: answered")) {
        failures.push(`${questionsRel} still says \`status: open\` — the answer was not recorded.`);
      }
      if (!/fact: F\d+/.test(questions)) {
        failures.push(`${questionsRel} carries no \`fact:\` id — the answer did not become a fact.`);
      }
    }
    if (!sandboxHas(sandbox, ".tldrx/memory/facts.yml")) {
      failures.push(".tldrx/memory/facts.yml is missing.");
    } else {
      const facts = read(sandbox, ".tldrx/memory/facts.yml");
      if (!facts.includes(`q: ${QUESTION_ID}`)) {
        failures.push(`.tldrx/memory/facts.yml holds no fact sourced from ${QUESTION_ID}.`);
      }
      if (!facts.includes("kind: answer")) {
        failures.push(".tldrx/memory/facts.yml has no `kind: answer` row.");
      }
    }
    return failures;
  },
};

// ---------------------------------------------------------------------------
// 3 — the gate
// ---------------------------------------------------------------------------

const CHAPTER_3: Chapter = {
  n: 3,
  id: "gate",
  title: "the gate — an approval is a record, not a keystroke",
  requires: [2],
  intro: [
    "The What stage stopped at exit 4 and has been sitting there ever since. That is a gate.",
    "Nothing after it runs until somebody signs it — and signing writes down who, when and why.",
    "The stage's checks are RE-RUN as you sign, against what is on disk now, not what passed earlier.",
  ],
  steps: [
    {
      narrate: [
        "`--note` is not a comment. It is the reason the next stage gets to read,",
        "and the reason you get to read in six weeks when you have forgotten all of this.",
      ],
      command: ["approve", "--note", "B it is — a price change should be a data change, not a code change"],
    },
  ],
  debrief: [
    "Open `tldrx-work/<run>/run.yml` and find the `what` stage. Its `gate:` line now reads",
    "`status: approved`, with your username in `by:`, a UTC `at:`, and your note kept verbatim.",
    "The cursor moved on its own: `cursor: {phase: \"02-how\", stage: how}`. That is the whole gate.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    const run = newestRunId(sandbox);
    if (run === null) return ["there is no run under tldrx-work/ — chapter 2 did not leave one."];
    const runYml = read(sandbox, join(PROJECT_WORK_DIR, run, "run.yml"));
    if (!runYml.includes("status: approved")) {
      failures.push("run.yml records no approved gate — `tldrx approve` signed nothing.");
    }
    if (/by: null/.test(runYml) && !/by: \S+/.test(runYml)) {
      failures.push("run.yml's gate has no `by:` — the approval is not attributed to anybody.");
    }
    if (!runYml.includes("a price change should be a data change")) {
      failures.push("run.yml does not carry the approval note — the reason was not recorded.");
    }
    if (!/cursor: \{phase: "02-how"/.test(runYml)) {
      failures.push("the cursor did not advance to 02-how after the gate closed.");
    }
    return failures;
  },
};

// ---------------------------------------------------------------------------
// 4 — build one story
// ---------------------------------------------------------------------------

/** The How stage's six outputs. Its gate is `auto`, so its questions.md must parse. */
const HOW_OUTPUTS: Readonly<Record<string, string>> = {
  "{runDir}/02-how/design.md": [
    "# Design",
    "",
    "## Design",
    "The two literals in `priceOf` become one table the build reads [src: src/pricing.ts:3].",
    "",
    "## Components",
    "- `src/prices.json` — the table, keyed by SKU prefix [src: src/pricing.ts:3]",
    "- `src/pricing.ts` — reads the table instead of branching on a string [src: src/pricing.ts:2]",
    "",
  ].join("\n"),
  "{runDir}/02-how/contracts.md": [
    "# Contracts",
    "",
    "## priceOf",
    "- `priceOf(sku: string): number` keeps its signature, and its cents [src: src/pricing.ts:2]",
    "",
  ].join("\n"),
  "{runDir}/02-how/risks.md": [
    "# Risks",
    "",
    "## Risks",
    "- A SKU the table does not name has no price — it has none today either [src: src/pricing.ts:3]",
    "",
  ].join("\n"),
  "{runDir}/02-how/test-strategy.md": [
    "# Test strategy",
    "",
    "## Unit",
    "- A `BULK-` SKU prices lower than the same SKU without the prefix [src: src/pricing.ts:3]",
    "",
  ].join("\n"),
  "{runDir}/02-how/handoff.md": [
    "# How — handoff",
    "",
    "## Findings",
    "- The whole price rule is one string-prefix test on one line [src: src/pricing.ts:3]",
    "",
    "## Decisions",
    "- The table is a JSON file the build reads — F001 already settled that [src: .tldrx/memory/facts.yml:1]",
    "",
    "## Unknowns",
    "- Nothing this design leaves open [src: src/pricing.ts:2]",
    "",
    "## Evidence ledger",
    "- `priceOf` is the only function in the repo that returns a price [src: src/pricing.ts:2]",
    "- The answer to where the table lives is already a recorded fact [src: .tldrx/memory/facts.yml:1]",
    "",
  ].join("\n"),
  // Already `answered`, and carrying the fact that answered it. That is what
  // `no-reask` means in practice — and it is also what lets the auto gate close,
  // since a stage told to write questions.md must write one the parser can read.
  "{runDir}/02-how/questions.md": [
    "## Q2 · Where should the price table live?",
    "<!-- id: Q2 | status: answered | area: data-model | asked_by: architect"
    + " | asked_at: 2026-09-01T09:10:00Z -->",
    "Why asked: the design needs a home for the table [src: src/pricing.ts:2]",
    "",
    "- A) Keep it in `src/pricing.ts`, as a constant",
    "- B) A JSON file the build reads",
    "- C) other — write it below",
    "",
    "[Answer]: B — a JSON file the build reads",
    "<!-- answered_by: F001 | answered_at: 2026-09-01T09:10:00Z | fact: F001 -->",
    "",
  ].join("\n"),
};

/** The Plan stage's outputs: one epic, one story, one wave, and the paperwork. */
const PLAN_OUTPUTS: Readonly<Record<string, string>> = {
  "{runDir}/03-plan/epics/E1.md": [
    "---",
    "version: 1",
    "id: E1",
    "title: \"Bulk pricing reads a table\"",
    "repos: [inventory]",
    "stories: [S1]",
    // The branch name is also the watcher card's id in chapter 8 — `epic/<slug>`
    // becomes `<slug>.md` (`watch/features.ts:featureId`).
    "branch: epic/bulk-pricing",
    "status: todo",
    "---",
    "",
    "# E1 · Bulk pricing reads a table",
    "",
  ].join("\n"),
  // `dod:` may only name a command `.tldrx/workspace.yml` declares, byte for byte
  // (`schemas/commandAllowlist.ts`). Detection found `npm run test` for this repo,
  // whose script is `exit 0` — which chapter 5 is about.
  "{runDir}/03-plan/stories/S1.md": [
    "---",
    "version: 1",
    "id: S1",
    "epic: E1",
    "title: \"priceOf reads src/prices.json\"",
    "repo: inventory",
    "status: todo",
    "depends_on: []",
    "touches: [\"src/pricing.ts\", \"src/prices.json\"]",
    "acceptance:",
    "  - \"A BULK- SKU prices lower than the same SKU without the prefix\"",
    "test_plan:",
    "  - \"Unit: priceOf returns the table's value for a BULK- SKU\"",
    "evidence: []",
    "---",
    "",
    "# S1 · priceOf reads src/prices.json",
    "",
    "## Context",
    "",
    "The rule is one prefix test today [src: src/pricing.ts:3].",
    "",
    "## Definition of done",
    "",
    "```dod",
    "npm run test",
    "```",
    "",
    "## Evidence",
    "",
    "Filled in by Build.",
    "",
  ].join("\n"),
  "{runDir}/03-plan/waves.yml": ["version: 1", "waves:", "  - {id: W1, stories: [S1]}", ""].join("\n"),
  // The PLAN's budget.yml prices STORIES, not phases: `per_phase_usd` keyed by a
  // story id is what the Build executor reads as a per-story cap
  // (`build/plan.ts:227`). Keyed by phase — the run-root budget.yml's shape — it
  // is legal and prices nothing, and the executor says so and falls back.
  "{runDir}/03-plan/budget.yml": [
    "version: 1",
    "run: \"{run}\"",
    "ceiling_usd: 9.00",
    "spent_usd: 0",
    "per_phase_usd:",
    "  S1: 6.00",
    "",
  ].join("\n"),
  "{runDir}/03-plan/handoff.md": [
    "# Plan — handoff",
    "",
    "## Findings",
    "- The design touches two files in one repo, so one story carries it [src: src/pricing.ts:2]",
    "",
    "## Decisions",
    "- S1's Definition of Done is the test command detection found [src: .tldrx/workspace.yml:1]",
    "",
    "## Unknowns",
    "- Nothing left to decide before Build [src: src/pricing.ts:2]",
    "",
    "## Evidence ledger",
    "- One epic, one story, one wave [src: src/pricing.ts:2]",
    "",
  ].join("\n"),
  "{runDir}/03-plan/questions.md": [
    "## Q3 · One story, or one per file?",
    "<!-- id: Q3 | status: answered | area: delivery | asked_by: delivery"
    + " | asked_at: 2026-09-01T09:20:00Z -->",
    "Why asked: the design names two files in one repo [src: src/pricing.ts:2]",
    "",
    "- A) One story",
    "- B) One story per file",
    "- C) other — write it below",
    "",
    "[Answer]: A — one story; the two files are one change",
    "<!-- answered_by: delivery | answered_at: 2026-09-01T09:20:00Z | fact: F001 -->",
    "",
  ].join("\n"),
};

/** What the developer sub-agent leaves in S1's worktree. Repo paths, not run paths. */
const S1_DEVELOPER_WRITES: Readonly<Record<string, string>> = {
  "src/prices.json": `${JSON.stringify({ "BULK-": 500, default: 1200 }, null, 2)}\n`,
  "src/pricing.ts": [
    "/** Cents, always. A price that is a float is a bug waiting for a rounding. */",
    "import table from \"./prices.json\" with { type: \"json\" };",
    "",
    "export function priceOf(sku: string): number {",
    "  return sku.startsWith(\"BULK-\") ? table[\"BULK-\"] : table.default;",
    "}",
    "",
  ].join("\n"),
};

const CHAPTER_4: Chapter = {
  n: 4,
  id: "build",
  title: "build one story — branch, agent, DoD, commit, merge, review",
  requires: [3],
  intro: [
    "Two stages go by quickly here, because you already know their shape: run it, read it, sign it.",
    "Then Build, which is not like the others. It cuts a branch, opens a worktree, spawns a developer",
    "in it, re-runs the story's own Definition of Done, commits, merges, and spawns a reviewer.",
    "",
    "One thing happened before this chapter's first command: the tutorial committed what `tldrx init`",
    "left untracked. Build refuses to cut a branch from a dirty tree — `refusing to cut an epic branch",
    "from a dirty tree`, with the paths — and you will meet that refusal on your own repo one day.",
  ],
  // Measured: Build lists `?? .gitignore` and `?? CLAUDE.md` as product dirt and
  // exits 2 before touching a branch. `.tldrx/` and `tldrx-work/` are excused as
  // the framework's own state (`build/git.ts:stateDirPrefixes`), these two are not.
  async prepare(sandbox: Sandbox): Promise<void> {
    await gitCommitAll(sandbox.workspace, "chore: commit what `tldrx init` wrote");
  },
  steps: [
    {
      narrate: [
        "How designs against real files. Its gate is `auto` in this workflow — which is not a skip:",
        "the harness signs it only when it can show its work, and it prints all seven conditions.",
      ],
      command: ["next"],
      agentTurns: [{
        match: "# How — handoff",
        say: "One function, one table. F001 already answered the only open question.",
        costUsd: 0.44,
        writes: HOW_OUTPUTS,
      }],
    },
    {
      narrate: [
        "Plan cuts the design into stories. Its gate is `human`, so this one stops at 4 again",
        "and waits for you — the same shape as chapter 3.",
      ],
      command: ["next"],
      expectExit: [4],
      agentTurns: [{
        match: "# Plan — handoff",
        say: "One epic, one story, one wave.",
        costUsd: 0.28,
        writes: PLAN_OUTPUTS,
      }],
    },
    {
      narrate: [
        "The `plan` check runs as you sign: every story names an epic that exists, every story is",
        "scheduled exactly once, and every `dod` command is one workspace.yml actually declares.",
      ],
      command: ["approve", "--note", "One story is right — the two files are one change"],
    },
    {
      narrate: [
        "Now Build. Watch the order in the output: branch, worktree, developer, DoD, commit,",
        "merge into the epic branch, reviewer. A story is `done` only when the DoD exited 0",
        "AND the reviewer approved — either one alone leaves it `blocked`.",
      ],
      command: ["next"],
      agentTurns: [
        {
          match: "# Build — story S1",
          say: "priceOf reads the table now.",
          costUsd: 0.63,
          writes: S1_DEVELOPER_WRITES,
        },
        {
          match: "# Review — story S1",
          say: "The diff is the story, and the DoD is green.",
          costUsd: 0.09,
          structured: {
            verdict: "approve",
            summary: "priceOf reads the table; the DoD exited 0.",
            findings: ["The change is confined to the two files the story declared it would touch."],
          },
        },
      ],
    },
  ],
  debrief: [
    "Open `tldrx-work/<run>/03-plan/stories/S1.md`. Its front matter now says `status: done` and its",
    "`evidence:` is three lines the framework measured, not sentences an agent wrote: the command and",
    "its exit code, the commit sha, and `04-build/log/S1.md` — open that too, for the reviewer's verdict.",
    "",
    "`git branch` in the sandbox shows `epic/bulk-pricing`: the work is merged there, NOT into `main`.",
    "`tldrx ship` is what opens the PR. And look at what that green DoD actually ran — `npm run test`,",
    "whose script in this repo is `exit 0`. Chapter 5 is about what that proves.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    const run = newestRunId(sandbox);
    if (run === null) return ["there is no run under tldrx-work/."];
    const storyRel = join(PROJECT_WORK_DIR, run, "03-plan", "stories", "S1.md");
    if (!sandboxHas(sandbox, storyRel)) {
      failures.push(`${storyRel} was not written — the Plan stage produced no story.`);
    } else {
      const story = read(sandbox, storyRel);
      if (!story.includes("status: done")) {
        failures.push(`${storyRel} is not \`status: done\` — Build did not finish the story.`);
      }
      if (!story.includes("npm run test → exit 0")) {
        failures.push(`${storyRel} carries no DoD result — the Definition of Done did not run.`);
      }
      if (!/commit [0-9a-f]{7}/.test(story)) {
        failures.push(`${storyRel} names no commit — nothing was committed for the story.`);
      }
    }
    const logRel = join(PROJECT_WORK_DIR, run, "04-build", "log", "S1.md");
    if (!sandboxHas(sandbox, logRel)) {
      failures.push(`${logRel} is missing — no reviewer log was written.`);
    } else if (!read(sandbox, logRel).includes("Verdict: **approve**")) {
      failures.push(`${logRel} records no approving verdict.`);
    }
    if (!sandboxHas(sandbox, join(PROJECT_WORK_DIR, run, "04-build", "handoff.md"))) {
      failures.push("04-build/handoff.md was not written.");
    }
    return failures;
  },
};

// ---------------------------------------------------------------------------
// 5 — when things go wrong
// ---------------------------------------------------------------------------

/** The second run: small, on purpose, and the one that is allowed to fail. */
export const LEARN_HOTFIX_SLUG = "price-typo";

/** The `hotfix` scope skips How and Plan, so What is the only stage before Build. */
const HOTFIX_WHAT_OUTPUTS: Readonly<Record<string, string>> = {
  "{runDir}/01-what/intent.md": [
    "# Intent",
    "",
    "## Intent",
    "The bulk discount is too deep. 500 should be 720 — and nothing in this repo would notice either way.",
    "",
    "## Scope",
    "In: the price and a test for it. Out: everything else.",
    "",
  ].join("\n"),
  "{runDir}/01-what/scope.md": [
    "# Scope",
    "",
    "## In",
    "- the bulk price in `src/pricing.ts`",
    "",
    "## Out",
    "- the stock ledger, the README",
    "",
  ].join("\n"),
  "{runDir}/01-what/success-metrics.md": [
    "# Success metrics",
    "",
    "- `npm run test` runs a test that compares the two prices, and it is green.",
    "",
  ].join("\n"),
  "{runDir}/01-what/open-questions.md": [
    "# Open questions",
    "",
    "- None: the number is a business decision and it has been made.",
    "",
  ].join("\n"),
  "{runDir}/01-what/handoff.md": [
    "# What — handoff",
    "",
    "## Findings",
    "- A `BULK-` SKU is priced at 500 and everything else at 1200 [src: src/pricing.ts:3]",
    "- The repo's `test` script is `exit 0`, so no test could have caught a wrong number [src: package.json:7]",
    "",
    "## Decisions",
    "- Change 500 to 720 and write a test that compares the two prices [src: src/pricing.ts:3]",
    "",
    "## Unknowns",
    "- Nothing outstanding [src: src/pricing.ts:2]",
    "",
    "## Evidence ledger",
    "- `priceOf` is the only place a price is decided [src: src/pricing.ts:2]",
    "- The workspace's declared test command is the one the DoD will run [src: .tldrx/workspace.yml:1]",
    "",
  ].join("\n"),
  "{runDir}/01-what/questions.md": [
    "## Q1 · Is 720 the right bulk price?",
    "<!-- id: Q1 | status: answered | area: pricing | asked_by: product"
    + " | asked_at: 2026-09-01T10:00:00Z -->",
    "Why asked: the discount is a business call, not a code one [src: src/pricing.ts:3]",
    "",
    "- A) 720",
    "- B) leave it at 500",
    "- C) other — write it below",
    "",
    "[Answer]: A — 720",
    "<!-- answered_by: product | answered_at: 2026-09-01T10:00:00Z | fact: F001 -->",
    "",
  ].join("\n"),
};

/** A real test, in plain node: no install step, no network, and it can go red. */
const PRICING_TEST_MJS = [
  "import { readFileSync } from \"node:fs\";",
  "",
  "const source = readFileSync(new URL(\"../src/pricing.ts\", import.meta.url), \"utf8\");",
  "const [bulk, plain] = [...source.matchAll(/\\b(\\d+)\\b/g)].map((match) => Number(match[1]));",
  "",
  "if (!(bulk < plain)) {",
  "  console.error(`FAIL: a BULK- SKU costs ${bulk}, which is not lower than ${plain}`);",
  "  process.exit(1);",
  "}",
  "console.log(`ok: a BULK- SKU costs ${bulk}, everything else ${plain}`);",
  "",
].join("\n");

/** The package.json the developer leaves behind: `test` now runs the test. */
const PRICING_TEST_PACKAGE_JSON = `${JSON.stringify({
  name: "toy-inventory",
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: {
    test: "node test/pricing.test.mjs",
    build: "exit 0",
    lint: "exit 0",
    typecheck: "exit 0",
  },
}, null, 2)}\n`;

/** `priceOf` with whatever bulk price the turn means to leave in the tree. */
function pricingWithBulk(bulk: number): string {
  return [
    "/** Cents, always. A price that is a float is a bug waiting for a rounding. */",
    "export function priceOf(sku: string): number {",
    `  return sku.startsWith("BULK-") ? ${String(bulk)} : 1200;`,
    "}",
    "",
  ].join("\n");
}

const CHAPTER_5: Chapter = {
  n: 5,
  id: "red",
  title: "when things go wrong — a red DoD, and the way back from it",
  requires: [4],
  intro: [
    "S1 is `done` and its DoD was green. The DoD was `npm run test`, and this repo's test script",
    "is `exit 0`. Green proved nothing, and the framework cannot tell the difference — you can.",
    "",
    "So: a second, smaller run, with a real test in it. The developer will get the number wrong,",
    "the DoD will catch it, and nothing will be merged. Then you put it right one command at a time —",
    "and you will not have to guess any of them, because each one is named for you by the one before.",
  ],
  steps: [
    {
      narrate: [
        "`--scope hotfix` is a different workflow: What, Build, Watch — no How, no Plan.",
        "A scope is one yml file; the facilitator has no idea which one it is running.",
      ],
      command: [
        "run", "new", LEARN_HOTFIX_SLUG, "--scope", "hotfix",
        "--title", "The bulk discount should be 720, and prove it",
      ],
    },
    {
      narrate: [
        "Two runs are open now, so every command below spells out the one it means. Leave the id",
        "off with two runs open and the framework refuses (exit 2) rather than guessing which.",
        "`hotfix` gives What an `auto` gate, so this one signs itself.",
      ],
      command: ["next", "{run}"],
      agentTurns: [{
        match: "# What — handoff",
        say: "The number is a business call, and nothing tests it.",
        costUsd: 0.21,
        writes: HOTFIX_WHAT_OUTPUTS,
      }],
    },
    {
      narrate: [
        "Plan was skipped, so Build synthesises one story from the What handoff and gives it the",
        "DoD this scope calls for: `npm run build`, then `npm run test`. Watch the DoD line.",
      ],
      command: ["next", "{run}"],
      expectExit: [4],
      agentTurns: [{
        match: "# Build — story S1",
        say: "A test that compares the two prices, and the new number.",
        costUsd: 0.30,
        writes: {
          "test/pricing.test.mjs": PRICING_TEST_MJS,
          "package.json": PRICING_TEST_PACKAGE_JSON,
          // 1720, not 720. The typo the new test is about to catch.
          "src/pricing.ts": pricingWithBulk(1720),
        },
      }],
    },
    {
      narrate: [
        "`blocked`, with the failing command and its output — not `done`, and nothing merged.",
        "Reopening a story is its own verb, and it takes a note: somebody decided this.",
      ],
      command: [
        "story", "reopen", "S1", "--run", "{run}",
        "--note", "The test is right — 1720 is a typo for 720",
      ],
    },
    {
      narrate: [
        "The stage itself is still sitting at its gate. `reject` sends it back to `ready`,",
        "and the note goes into the next prompt, so the retry knows what you knew.",
      ],
      command: ["reject", "--run", "{run}", "--note", "S1 is blocked, not done — run the stage again"],
    },
    {
      narrate: [
        "A stage's budget is spent once. The Build phase has already paid for the attempt that",
        "failed, so a second one does not start until you give it room — run `next` without this",
        "and it refuses, printing this very command. Chapter 8 lets you watch that refusal happen.",
      ],
      command: ["budget", "raise", "04-build", "1", "--run", "{run}"],
    },
    {
      narrate: [
        "Second attempt. Same story, same branch — the developer starts from the commits the",
        "last one made, so the test it wrote is still there to judge the fix.",
      ],
      command: ["next", "{run}"],
      expectExit: [4],
      agentTurns: [
        {
          match: "# Build — story S1",
          say: "720, as the answer said.",
          costUsd: 0.22,
          writes: { "src/pricing.ts": pricingWithBulk(720) },
        },
        {
          match: "# Review — story S1",
          say: "Green, and the test is the reason.",
          costUsd: 0.08,
          structured: {
            verdict: "approve",
            summary: "The bulk price is 720 and a test proves it is lower than the plain price.",
            findings: ["The test reads the same file the code is in, so it cannot pass vacuously."],
          },
        },
      ],
    },
    {
      narrate: [
        "Green, and `done`. Sign the stage — the same verb as chapter 3, and the last thing",
        "standing between this run and its final stage.",
      ],
      command: ["approve", "--run", "{run}", "--note", "Green, and a real test is the reason it is green"],
    },
  ],
  debrief: [
    "Open `tldrx-work/<run>/events.jsonl`. Every step of that is in it, in order and with its cost:",
    "the failing DoD's own words, `story.reopened`, `gate.rejected`, `budget.raised`, then the second",
    "`agent.result`. Nothing was rewritten afterwards to look better than it was.",
    "",
    "`tldrx replay <run>` reads that file back as a narrative. The failure is part of the record.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    const run = runIdBySlug(sandbox, LEARN_HOTFIX_SLUG);
    if (run === null) return [`no \`${LEARN_HOTFIX_SLUG}\` run was created — \`run new\` wrote nothing.`];
    const events = read(sandbox, join(PROJECT_WORK_DIR, run, "events.jsonl"));
    if (!events.includes("which is not lower than")) {
      failures.push("events.jsonl carries no failing-DoD record — the red attempt did not happen.");
    }
    for (const type of ["story.reopened", "gate.rejected", "budget.raised"]) {
      if (!events.includes(type)) failures.push(`events.jsonl records no \`${type}\` event.`);
    }
    const logRel = join(PROJECT_WORK_DIR, run, "04-build", "log", "S1.md");
    if (!sandboxHas(sandbox, logRel)) {
      failures.push(`${logRel} is missing — the second attempt produced no reviewer log.`);
    } else {
      const log = read(sandbox, logRel);
      if (!log.includes("`npm run test` → exit 0")) {
        failures.push(`${logRel} does not record a green \`npm run test\` — the retry did not go green.`);
      }
      if (!log.includes("Story status: `done`")) {
        failures.push(`${logRel} does not record the story as done.`);
      }
    }
    return failures;
  },
};

// ---------------------------------------------------------------------------
// 6 — attend vs auto
// ---------------------------------------------------------------------------

const CHAPTER_6: Chapter = {
  n: 6,
  id: "attend",
  title: "attend vs auto — who is allowed to spawn",
  requires: [5],
  intro: [
    "Everything so far has been the framework spawning sub-agents for you. That is one of two modes.",
    "The other is a host session — a Claude Code window, you in it — doing the work, with the framework",
    "still keeping the record, running the checks and holding the gates. One flag decides which.",
  ],
  steps: [
    {
      narrate: [
        "This hands the run to a host. The framework will not spawn on it again — not `next`,",
        "not `run auto`. Nothing else about the run changes.",
      ],
      command: ["run", "attend", "host", "{run}"],
    },
    {
      narrate: [
        "Now the same `tldrx next` you have been running all tutorial. It refuses — and the refusal",
        "is the lesson: it names the command that IS yours to run, rather than doing something else.",
      ],
      command: ["next", "{run}"],
      expectExit: [4],
    },
    {
      narrate: [
        "And back. `--none` hands the run to the framework again, which is what the last chapter",
        "of this tutorial needs.",
      ],
      command: ["run", "attend", "--none", "{run}"],
    },
  ],
  debrief: [
    "The pair to remember: `tldrx next --prepare` writes the prompt bundle for a host turn, and",
    "`tldrx next --commit` picks the same pipeline up at the DoD — the checks, the commit, the merge",
    "and the reviewer all still run. Attended changes who writes the code, never who keeps the record.",
    "`tldrx run status` prints `attended_by:` on any run that has it set.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    const run = runIdBySlug(sandbox, LEARN_HOTFIX_SLUG);
    if (run === null) return [`the \`${LEARN_HOTFIX_SLUG}\` run chapter 5 opened is gone.`];
    const events = read(sandbox, join(PROJECT_WORK_DIR, run, "events.jsonl"));
    const flips = events.split("run.attended").length - 1;
    if (flips < 2) {
      failures.push(`events.jsonl records ${String(flips)} \`run.attended\` event(s); the chapter flips it twice.`);
    }
    const runYml = read(sandbox, join(PROJECT_WORK_DIR, run, "run.yml"));
    if (/attended_by:\s*host/.test(runYml)) {
      failures.push("run.yml still says `attended_by: host` — `run attend --none` did not hand it back.");
    }
    // The refusal only fires on a stage that is READY. A run sitting at a gate
    // makes `tldrx next` answer "gate pending" instead — exit 4 either way, so
    // the step would pass having taught the opposite of the chapter's point.
    if (/^status:\s*awaiting_gate/m.test(runYml)) {
      failures.push(
        "the run is at a gate, so `tldrx next` answered `gate pending` and the attended refusal "
        + "never fired — chapter 5 must leave this run with a stage that is `ready`.",
      );
    }
    return failures;
  },
};

// ---------------------------------------------------------------------------
// 7 — unattended: an agent gate, closed over an evidence note
// ---------------------------------------------------------------------------

/**
 * The note the stand-in "reviewer" leaves for the Watch gate.
 *
 * Written by `prepare()` rather than by a turn because this run's Watch stage
 * spawns nothing — no story of its reached `03-plan/stories/`, so there is no
 * shipped feature to write a card for, and no sub-agent to hand the job to. What
 * matters to the chapter is the note itself, which is what an agent gate rests on.
 *
 * Every bullet ends in a `[src: …]` token that RESOLVES: an evidence note refuses
 * over a citation nothing could check, unlike a handoff, because an agent gate is
 * strictly stronger than an auto gate and never a cheaper one
 * (`core/text/evidence.ts`).
 */
function evidenceNote(): string {
  return [
    "---",
    "version: 1",
    "gate: 05-watch/watch",
    "role: agent",
    "by: operations",
    "at: 2026-09-01T10:30:00Z",
    "verdict: sign",
    "read: [\"05-watch/handoff.md\", \"src/pricing.ts\", \"package.json\"]",
    "citations: {sampled: 1, of: 1, resolved: 1, refuted: 0}",
    "touches: {audited: 1, outside_surface: 0, new_areas: []}",
    "diff_vs_stories: n-a",
    "caveats: [\"This repo emits no telemetry, so there was no signal to sample.\"]",
    "recommend: []",
    "---",
    "",
    "# Gate evidence — 05-watch/watch",
    "",
    "## Read",
    "",
    "- The Watch handoff, which reports no shipped feature to watch [src: src/pricing.ts:3]",
    "",
    "## Citations checked",
    "",
    "- The handoff's one claim is that no story reached `done` in a stories directory this scope",
    "  never creates, and that is so [src: src/pricing.ts:3]",
    "",
    "## Touches audited",
    "",
    "- `src/pricing.ts` is the only file this run's story touched, and the What declared it [src: src/pricing.ts:3]",
    "",
    "## Verdict",
    "",
    "- SIGN: the stage wrote the one output it declared, and every claim in it resolves [src: package.json:7]",
    "",
  ].join("\n");
}

const CHAPTER_7: Chapter = {
  n: 7,
  id: "unattended",
  title: "unattended — an agent gate, and what a signature has to rest on",
  requires: [6],
  intro: [
    "A gate has three policies, not two. `human` waits for you. `auto` lets the harness sign when it",
    "can show its work. `agent` lets a sub-agent sign — but only over a structured evidence note:",
    "what it read, which citations it re-checked and how they turned out, which touched paths it",
    "audited, and a verdict with a measurement behind it.",
    "",
    "You signed two gates yourself, in chapters 3 and 5. This is the same verb, signed by something",
    "that is not you. `tldrx gate template` writes the skeleton of the note it must sign over, with",
    "every MEASURED field filled and every JUDGEMENT blank — a template that validated out of the box",
    "would be a signature nobody had to earn. One already filled in is waiting for you to read at",
    "`<run>/.agent/watch/evidence.md`.",
  ],
  async prepare(sandbox: Sandbox): Promise<void> {
    const run = newestRunId(sandbox);
    if (run === null) return;
    const path = join(sandbox.workspace, PROJECT_WORK_DIR, run, ".agent", "watch", "evidence.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, evidenceNote(), "utf8");
  },
  steps: [
    {
      narrate: [
        "The last stage of the hotfix run. It finds no shipped feature to watch and says so —",
        "an aspirational watcher is worse than no watcher — then stops at its gate.",
      ],
      command: ["next", "{run}"],
      expectExit: [4],
    },
    {
      narrate: [
        "Change who may close that gate. It is a decision, so it takes a `--note` and is recorded",
        "with your name on it; gates already signed are untouched.",
      ],
      command: [
        "run", "gates", "set", "watch:agent", "--run", "{run}",
        "--note", "The watcher's checks are mechanical — an agent may sign them over evidence",
      ],
    },
    {
      narrate: [
        "Now the signature. The note is validated first — front matter, four sections, every bullet",
        "sourced and every source resolving, the arithmetic, and a verdict of `sign` and nothing else.",
      ],
      command: ["approve", "--as-agent", "--run", "{run}"],
    },
  ],
  debrief: [
    "`.agent/` is scratch and gitignored, so the note a gate rests on was COPIED where it can be read:",
    "`05-watch/gate-evidence/watch.md`, which is the path `run.yml`'s `gate.evidence` now points at.",
    "",
    "Try the other verdicts on your own runs: `sign-with-fixlist` and `refuse` are not the note failing,",
    "they are the note saying a person decides. And a person may always sign an agent gate themselves —",
    "an agent gate is one an agent MAY close, never one you may not.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    const run = runIdBySlug(sandbox, LEARN_HOTFIX_SLUG);
    if (run === null) return [`the \`${LEARN_HOTFIX_SLUG}\` run chapter 5 opened is gone.`];
    const copyRel = join(PROJECT_WORK_DIR, run, "05-watch", "gate-evidence", "watch.md");
    if (!sandboxHas(sandbox, copyRel)) {
      failures.push(`${copyRel} was not written — the gate recorded no committed copy of the note.`);
    }
    const runYml = read(sandbox, join(PROJECT_WORK_DIR, run, "run.yml"));
    if (!runYml.includes("by: operations")) {
      failures.push("run.yml's watch gate is not attributed to the agent that signed it.");
    }
    if (!/policy:\s*agent|watch:\s*agent/.test(runYml)) {
      failures.push("run.yml does not record the watch gate's policy as `agent`.");
    }
    return failures;
  },
};

// ---------------------------------------------------------------------------
// 8 — money
// ---------------------------------------------------------------------------

/** The one watcher card the feature run shipped. `epic/bulk-pricing` names the file. */
const WATCHER_CARD: Readonly<Record<string, string>> = {
  "{runDir}/05-watch/watchers/bulk-pricing.md": [
    "---",
    "version: 1",
    "id: bulk-pricing",
    "epic: E1",
    "title: \"Bulk pricing reads a table\"",
    "stories: [S1]",
    "repos: [inventory]",
    "status: draft",
    "---",
    "",
    "# bulk-pricing · Bulk pricing reads a table",
    "",
    "## Signal",
    "",
    "- Nothing is emitted when a price is looked up — `priceOf` returns and logs nothing,",
    "  so this feature is not watchable yet [src: absent:src/pricing.ts]",
    "",
    "## Where",
    "",
    "- There is no log stream or dashboard in this workspace to read it in [src: absent:.tldrx/workspace.yml]",
    "",
    "## Healthy baseline",
    "",
    "- None measured: with no signal there is no number to take [src: absent:src/pricing.ts]",
    "",
    "## Looks broken when",
    "",
    "- A bulk SKU is charged the plain price, which today only a reader of the code would notice",
    "  [src: inventory:src/pricing.ts:3]",
    "",
    "## Query",
    "",
    "```sh",
    "npm run test",
    "```",
    "",
    "## Sources",
    "",
    "- `src/pricing.ts:3` is the whole price rule, and it emits nothing.",
    "- The workspace declares no observability command, so there is nowhere to query.",
    "",
  ].join("\n"),
};

const CHAPTER_8: Chapter = {
  n: 8,
  id: "money",
  title: "money — the ledger, the estimate, and the brake",
  requires: [7],
  intro: [
    "The hotfix run is finished, so there is one run open again and the commands stop needing an id.",
    "Everything you have run cost $0.00 of real money — the agent was a stand-in — but the framework",
    "does not know that. It metered every turn exactly as it would meter a real one.",
  ],
  steps: [
    {
      narrate: [
        "Before spending: what the stage that has not run yet would cost, and on what basis.",
        "It says which numbers are measured and which are assumptions. It spawns nothing.",
      ],
      command: ["run", "estimate"],
    },
    {
      narrate: [
        "The feature run's last stage. It writes one card per SHIPPED feature — this one has one —",
        "and stamps the card `verified` only when nothing under `## Signal` cites `absent:`.",
      ],
      command: ["next"],
      expectExit: [4],
      agentTurns: [{
        match: "# Watch —",
        say: "There is nothing to watch yet, and that is the finding.",
        costUsd: 0.11,
        writes: WATCHER_CARD,
      }],
    },
    {
      narrate: [
        "Now the ledger. Per attempt, per stage, per run — rolled up from `events.jsonl`,",
        "never typed by anybody. Two runs, ten sub-agent turns, and not one real cent.",
      ],
      command: ["cost", "--all"],
    },
    {
      narrate: [
        "One last thing worth meeting on purpose. Take the Watch gate back —",
        "nothing is deleted and nothing is refunded, which is the whole point of the next command.",
      ],
      command: ["reject", "--note", "The card cites nothing that is actually instrumented"],
    },
    {
      narrate: [
        "And the brake. The phase has already spent its Watch money, so the stage does not start.",
        "A ceiling here is a refusal, not a warning — and it names the command that would fix it.",
      ],
      command: ["next"],
      expectExit: [2],
    },
  ],
  debrief: [
    "`tldrx budget raise 05-watch 1` would let it run again — or `--take-from <phase>` to move the",
    "money instead of adding it. Either way the decision is yours and it is written down.",
    "",
    "That is the loop: detect, ask, decide, design, plan, build, prove, watch — every step a file you",
    "can open, every decision attributed, every dollar counted. Your sandbox is still there; break it.",
  ],
  async assert(sandbox: Sandbox): Promise<readonly string[]> {
    const failures: string[] = [];
    const feature = runIdBySlug(sandbox, LEARN_RUN_SLUG);
    if (feature === null) return ["the feature run is gone — chapter 8 has nothing to account for."];
    const cardRel = join(PROJECT_WORK_DIR, feature, "05-watch", "watchers", "bulk-pricing.md");
    if (!sandboxHas(sandbox, cardRel)) {
      failures.push(`${cardRel} was not written — the Watch stage produced no card.`);
    }
    const events = read(sandbox, join(PROJECT_WORK_DIR, feature, "events.jsonl"));
    if (!events.includes("budget.blocked")) {
      failures.push("events.jsonl records no `budget.blocked` — the brake never fired.");
    }
    if (!events.includes("gate.rejected")) {
      failures.push("events.jsonl records no `gate.rejected` — the gate was never taken back.");
    }
    return failures;
  },
};

/** Every chapter, in `n` order. `--chapter <n>` indexes into this. */
export const CHAPTERS: readonly Chapter[] = [
  CHAPTER_1, CHAPTER_2, CHAPTER_3, CHAPTER_4, CHAPTER_5, CHAPTER_6, CHAPTER_7, CHAPTER_8,
];

export function chapterByNumber(n: number): Chapter | undefined {
  return CHAPTERS.find((chapter) => chapter.n === n);
}

function read(sandbox: Sandbox, rel: string): string {
  try {
    return readFileSync(join(sandbox.workspace, rel), "utf8");
  } catch {
    return "";
  }
}

/**
 * Commit everything in the toy repo, with an identity passed per command.
 *
 * A box with no `user.email` in its global config is a normal box, and a tutorial
 * that fails there fails for the reader who most needed it — the same reason
 * `sandbox.ts:makeToyRepo` does it this way.
 */
async function gitCommitAll(dir: string, message: string): Promise<void> {
  const add = await runtime.spawn("git", ["add", "-A"], { cwd: dir });
  if (add.exitCode !== 0) return;
  await runtime.spawn("git", [
    "-c", "user.email=learn@tldrx.invalid",
    "-c", "user.name=tldrx learn",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", message,
  ], { cwd: dir });
}

/**
 * A run's id from its slug — `<yymmdd>-<slug>`, and the slug is the half a
 * chapter knows.
 *
 * Every assertion from chapter 5 on names the run it is about this way rather
 * than asking for "the newest", because from chapter 5 there are two and which
 * one is newest-and-open changes under the chapters as they finish each other's
 * work. An assertion that had to be read alongside a sort order would not be an
 * assertion.
 */
function runIdBySlug(sandbox: Sandbox, slug: string): string | null {
  const workDir = join(sandbox.workspace, PROJECT_WORK_DIR);
  if (!existsSync(workDir)) return null;
  const hit = readdirSync(workDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${slug}`))
    .map((entry) => entry.name)
    .sort();
  return hit[hit.length - 1] ?? null;
}
