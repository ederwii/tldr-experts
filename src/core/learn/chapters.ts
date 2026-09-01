/**
 * The chapters, as data. This is the file phase 2 adds 3-8 to.
 *
 * Read `Chapter.ts` first — it is the contract, and it carries the note on what
 * a new chapter needs (data, an `agentTurns:` list if it spawns, and one
 * `assert()` over files). Nothing in `engine.ts` should have to change.
 *
 * The eight chapters of issue #30, in order:
 *
 *   1. init                   ← here
 *   2. run new + What         ← here
 *   3. the gate               phase 2
 *   4. build one story        phase 2
 *   5. when things go wrong   phase 2
 *   6. attend vs auto         phase 2
 *   7. unattended (tour)      phase 2
 *   8. money                  phase 2
 *
 * Two conventions the later chapters will need:
 *
 * **`{runDir}`** in a turn's file paths expands to `tldrx-work/<run>` at the
 * moment the step runs (`engine.ts:expandTurns`). A sub-agent's cwd is the
 * WORKSPACE ROOT, not the run directory (`facilitator/runNext.ts:559`), so every
 * stage output a turn writes has to carry that prefix.
 *
 * **The What stage declares six outputs and `validateOutputs` reads all six off
 * the disk** (`stages/what/stage.yml:33-39`, `facilitator/validateOutputs.ts:25`).
 * A turn that writes five fails the stage. `handoff.md` additionally has to pass
 * `claim-sources` — four H2 sections, every bullet ending in a `[src: …]` token
 * (`run/checks.ts:97`), which is why chapter 2's handoff looks the way it does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Every chapter, in `n` order. `--chapter <n>` indexes into this. */
export const CHAPTERS: readonly Chapter[] = [CHAPTER_1, CHAPTER_2];

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
