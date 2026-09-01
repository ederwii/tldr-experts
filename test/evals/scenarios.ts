/**
 * The five scenarios — one per stage of the loop.
 *
 * Each is a fixed, hand-written world: what is already on disk when the stage
 * starts, and what the stand-in agent will write when it runs. They are kept
 * HERE, apart from the assertions, because the assertions are the eval and these
 * are only its setup — and because `README.md` in this directory tells the next
 * person to add eval #6 by adding one entry here and one `test` there.
 *
 * Deliberately NOT imported from `src/core/learn/chapters.ts`, even though the
 * shapes rhyme. Those fixtures are tutorial COPY: they are written to be read by
 * a learner and they change when the tutorial's prose changes. An eval whose
 * fixture moves for a reason that has nothing to do with the contract is an eval
 * that will one day be edited to make it pass again.
 *
 * Every source token in every artifact below resolves against the toy repo
 * (`learn/sandbox.ts:TOY_FILES`): `src/pricing.ts` is four lines long, so a
 * citation of line 5 would fail the stage — which is the point.
 */
import type { StageEval } from "./harness.ts";

/** The toy repo's name, as `workspace.yml` records it. Watch and Build spell it. */
const REPO = "inventory";

// ---------------------------------------------------------------------------
// 1 — What
// ---------------------------------------------------------------------------

/**
 * What's contract: six declared outputs, a handoff `claim-sources` accepts, and
 * a `questions.md` the §2.7 parser can read. The question is left OPEN on
 * purpose — What's job is to come back with what it does not know, and a
 * scenario whose only question is pre-answered would never exercise the grammar
 * that an open block has to satisfy.
 */
export const WHAT_EVAL: StageEval = {
  stage: "what",
  phase: "01-what",
  title: "Bulk SKUs should price lower",
  turns: [{
    match: "# What — handoff",
    say: "One thing is genuinely unknown: where a price table would live.",
    costUsd: 0.31,
    writes: {
      "{runDir}/01-what/intent.md": [
        "# Intent",
        "",
        "## Intent",
        "- Bulk SKUs are priced like everything else, and should not be [src: src/pricing.ts:3]",
        "",
      ].join("\n"),
      "{runDir}/01-what/scope.md": [
        "# Scope",
        "",
        "## In",
        "- the price lookup [src: src/pricing.ts:2]",
        "",
        "## Out",
        "- the stock ledger — nothing about quantity changes [src: src/stock.ts:3]",
        "",
      ].join("\n"),
      "{runDir}/01-what/success-metrics.md": [
        "# Success metrics",
        "",
        "- A `BULK-` SKU prices lower than the same SKU without the prefix [src: src/pricing.ts:3]",
        "",
      ].join("\n"),
      "{runDir}/01-what/open-questions.md": [
        "# Open questions",
        "",
        "- No home for a price table is recorded anywhere [src: absent:src/prices.json]",
        "",
      ].join("\n"),
      "{runDir}/01-what/handoff.md": [
        "# What — handoff",
        "",
        "## Findings",
        "- The price lookup is one function with a hard-coded pair of numbers [src: src/pricing.ts:3]",
        "- The workspace has one repo and a test command [src: .tldrx/workspace.yml:1]",
        "",
        "## Decisions",
        "- In scope: the price lookup. Out: the stock ledger [src: src/pricing.ts:2]",
        "",
        "## Unknowns",
        "- Where a price table would live, once there is more than one rule [src: absent:src/prices.json]",
        "",
        "## Evidence ledger",
        "- The bulk branch is a string prefix test, not a table [src: src/pricing.ts:3]",
        "- Nothing in this workspace stores prices as data [src: absent:src/prices.json]",
        "",
      ].join("\n"),
      // `## Q1 · …` with U+00B7, all five metadata keys, a sourced `Why asked:`,
      // options lettered A-E in order, and an `[Answer]:` slot.
      // `core/text/questions.ts:89,114-119` is the parser this must satisfy.
      "{runDir}/01-what/questions.md": [
        "## Q1 · Where should the price table live?",
        "<!-- id: Q1 | status: open | area: data-model | asked_by: product"
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
    },
  }],
};

// ---------------------------------------------------------------------------
// 2 — How
// ---------------------------------------------------------------------------

/**
 * How's contract is What's, one phase along — six outputs and the same
 * `claim-sources` rule — with one difference worth an eval of its own: issue #34
 * widened the check from `handoff.md` to EVERY declared `.md`
 * (`run/checks.ts:80-96`). So `design.md` here carries a citation that resolves,
 * and the sabotage recipe in README.md breaks exactly that one.
 */
export const HOW_EVAL: StageEval = {
  stage: "how",
  phase: "02-how",
  title: "Bulk pricing reads a table",
  seed: {
    // How declares 01-what/* as inputs. They are optional (the bare-array form),
    // but a design stage with nothing upstream is not the scenario under test.
    "01-what/intent.md": [
      "# Intent",
      "",
      "## Intent",
      "- Bulk SKUs should price lower [src: src/pricing.ts:3]",
      "",
    ].join("\n"),
  },
  turns: [{
    match: "# How — handoff",
    say: "One function, one table.",
    costUsd: 0.44,
    writes: {
      "{runDir}/02-how/design.md": [
        "# Design",
        "",
        "## Components",
        "- `priceOf` reads a table instead of branching on a prefix [src: src/pricing.ts:3]",
        "- Nothing stores prices as data today, so the table is a new JSON file [src: absent:src/prices.json]",
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
        "- The table is a JSON file the build reads [src: src/pricing.ts:3]",
        "",
        "## Unknowns",
        "- Nothing this design leaves open [src: src/pricing.ts:2]",
        "",
        "## Evidence ledger",
        "- `priceOf` is the only function in the repo that returns a price [src: src/pricing.ts:2]",
        "",
      ].join("\n"),
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
        "<!-- answered_by: architect | answered_at: 2026-09-01T09:10:00Z -->",
        "",
      ].join("\n"),
    },
  }],
};


// ---------------------------------------------------------------------------
// 3 — Plan
// ---------------------------------------------------------------------------

/**
 * Plan is the only stage with a check of its own, and the scenario is shaped to
 * make that check say something. Two epics, three stories, two waves, and E2
 * depending on E1 — so `checkPlan` does not merely count files: it runs
 * `validatePlan` (every story in exactly one wave, every `depends_on` in an
 * earlier one, every `dod` command on the workspace allowlist), then derives the
 * BRANCH MODEL from the dependency chain and states it in one sentence
 * (`run/checks.ts:241-247`).
 *
 * A chain means `integration` — one shared branch instead of one per epic. That
 * is the behaviour #57 landed, and this is the eval that keeps it landed.
 */
export const PLAN_EVAL: StageEval = {
  stage: "plan",
  phase: "03-plan",
  title: "Bulk pricing, in two epics",
  seed: {
    "02-how/design.md": [
      "# Design",
      "",
      "## Components",
      "- `priceOf` reads a table instead of branching on a prefix [src: src/pricing.ts:3]",
      "",
    ].join("\n"),
  },
  turns: [{
    match: "# Plan — handoff",
    say: "Two epics, three stories, two waves — and the second epic waits on the first.",
    costUsd: 0.28,
    writes: {
      "{runDir}/03-plan/epics/E1.md": epic("E1", "The price table", ["S1", "S2"], "epic/price-table"),
      "{runDir}/03-plan/epics/E2.md": epic("E2", "The bulk discount", ["S3"], "epic/bulk-discount"),
      "{runDir}/03-plan/stories/S1.md": story({
        id: "S1", epic: "E1", title: "src/prices.json exists", dependsOn: [],
        touches: ["src/prices.json"],
      }),
      "{runDir}/03-plan/stories/S2.md": story({
        id: "S2", epic: "E1", title: "priceOf reads the table", dependsOn: [],
        touches: ["src/pricing.ts"],
      }),
      // The edge that makes the chain, and so the branch model: a story in E2
      // waiting on a story in E1 (`plan/branchModel.ts:detectEpicChain`).
      "{runDir}/03-plan/stories/S3.md": story({
        id: "S3", epic: "E2", title: "BULK- SKUs take the table's discount", dependsOn: ["S1"],
        touches: ["src/pricing.ts"],
      }),
      "{runDir}/03-plan/waves.yml": [
        "version: 1",
        "waves:",
        "  - {id: W1, stories: [S1, S2]}",
        "  - {id: W2, stories: [S3]}",
        "",
      ].join("\n"),
      // Keyed by STORY id — the Plan's budget.yml prices stories, and that is
      // what the Build executor reads as a per-story cap (`build/plan.ts:227`).
      "{runDir}/03-plan/budget.yml": [
        "version: 1",
        "run: \"{run}\"",
        "ceiling_usd: 9.00",
        "spent_usd: 0",
        "per_phase_usd:",
        "  S1: 3.00",
        "  S2: 3.00",
        "  S3: 3.00",
        "",
      ].join("\n"),
      "{runDir}/03-plan/handoff.md": [
        "# Plan — handoff",
        "",
        "## Findings",
        "- The design touches two files, and the discount waits on the table [src: src/pricing.ts:3]",
        "",
        "## Decisions",
        "- Every story's Definition of Done is the test command detection found [src: .tldrx/workspace.yml:1]",
        "",
        "## Unknowns",
        "- Nothing left to decide before Build [src: src/pricing.ts:2]",
        "",
        "## Evidence ledger",
        "- Two epics, three stories, two waves [src: src/pricing.ts:2]",
        "",
      ].join("\n"),
      "{runDir}/03-plan/questions.md": [
        "## Q3 · One epic, or two?",
        "<!-- id: Q3 | status: answered | area: delivery | asked_by: delivery"
        + " | asked_at: 2026-09-01T09:20:00Z -->",
        "Why asked: the table and the discount ship separately [src: src/pricing.ts:2]",
        "",
        "- A) One epic",
        "- B) Two, with the discount depending on the table",
        "- C) other — write it below",
        "",
        "[Answer]: B — two, and the second waits on the first",
        "<!-- answered_by: delivery | answered_at: 2026-09-01T09:20:00Z -->",
        "",
      ].join("\n"),
    },
  }],
};

// ---------------------------------------------------------------------------
// 4 — Build
// ---------------------------------------------------------------------------

/**
 * Build is not a document stage, so its contract is not a document.
 *
 * One story, so the eval stays cheap; everything it asserts is a side effect the
 * executor produced and nothing scripted could fake: a branch cut, a worktree, a
 * developer turn, the story's OWN `dod` block re-run by the framework, a commit,
 * a `--no-ff` merge into the epic branch, a read-only reviewer, and the story's
 * `evidence:` written back from measured exit codes.
 *
 * The plan is SEEDED rather than produced by the Plan stage above: this eval is
 * about Build, and a Build that failed because Plan had regressed would point at
 * the wrong stage. `epic/build-eval` is this eval's own branch and no other
 * eval's, so the toy repo's history stays readable when all five have run.
 */
export const BUILD_EVAL: StageEval = {
  stage: "build",
  phase: "04-build",
  title: "priceOf reads a table",
  seed: {
    "03-plan/epics/E1.md": epic("E1", "The price table", ["S1"], "epic/build-eval"),
    "03-plan/stories/S1.md": story({
      id: "S1", epic: "E1", title: "priceOf reads src/prices.json", dependsOn: [],
      touches: ["src/pricing.ts", "src/prices.json"],
    }),
    "03-plan/waves.yml": ["version: 1", "waves:", "  - {id: W1, stories: [S1]}", ""].join("\n"),
    "03-plan/budget.yml": [
      "version: 1", "run: \"{run}\"", "ceiling_usd: 9.00", "spent_usd: 0",
      "per_phase_usd:", "  S1: 6.00", "",
    ].join("\n"),
  },
  turns: [
    {
      // The developer's cwd is the STORY WORKTREE, not the workspace root — so
      // these are plain repo paths with no `{runDir}` prefix.
      match: "# Build — story S1",
      say: "priceOf reads the table now.",
      costUsd: 0.63,
      writes: {
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
      },
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
};

// ---------------------------------------------------------------------------
// 5 — Watch
// ---------------------------------------------------------------------------

/**
 * Watch's contract has a half no other stage has: the card's `status:` is
 * COMPUTED, never taken from the model. `verified` only when nothing under
 * `## Signal` cites `absent:` (`watch/watcherFile.ts:141`).
 *
 * So the scenario writes a card whose front matter says `status: draft` and
 * whose Signal cites a real line. If the framework is doing its job the card on
 * disk afterwards says `verified` — a value that appears nowhere in this file.
 * That single assertion is worth more than every byte comparison in this suite.
 *
 * The epic branch (`epic/watch-eval`) deliberately does not exist. `epicDiff`
 * degrades a missing ref to a stated ABSENCE rather than a failure
 * (`watch/epicDiff.ts:59`), which is what keeps this eval independent of Build's.
 */
export const WATCH_EVAL: StageEval = {
  stage: "watch",
  phase: "05-watch",
  title: "Watch the bulk price",
  seed: {
    "03-plan/epics/E1.md": epic("E1", "The price table", ["S1"], "epic/watch-eval"),
    // `collectFeatures` groups DONE stories by epic (`watch/features.ts:56`), so
    // the story arrives done — with the measured evidence a done story owes
    // (`schemas/story.ts:76-81` refuses `status: done` with an empty `evidence:`).
    "03-plan/stories/S1.md": story({
      id: "S1", epic: "E1", title: "priceOf reads src/prices.json", dependsOn: [],
      touches: ["src/pricing.ts"], status: "done",
      evidence: ["$ npm run test → exit 0", "commit 0123abc", "04-build/log/S1.md"],
    }),
    "03-plan/waves.yml": ["version: 1", "waves:", "  - {id: W1, stories: [S1]}", ""].join("\n"),
  },
  turns: [{
    match: "# Watch —",
    say: "One feature shipped; the price path is the thing to watch.",
    costUsd: 0.11,
    writes: {
      "{runDir}/05-watch/watchers/watch-eval.md": [
        "---",
        "version: 1",
        "id: watch-eval",
        "epic: E1",
        "title: \"The price table\"",
        "stories: [S1]",
        `repos: [${REPO}]`,
        // What the model claims. The framework overwrites it.
        "status: draft",
        "---",
        "",
        "# watch-eval · The price table",
        "",
        "## Signal",
        "",
        "- Every price a caller sees comes back from `priceOf`, so one function carries the",
        "  whole signal [src: src/pricing.ts:3]",
        "",
        "## Where",
        "",
        "- The unit test is the only place this workspace exercises the price path",
        "  [src: .tldrx/workspace.yml:1]",
        "",
        "## Healthy baseline",
        "",
        "- A `BULK-` SKU prices at 500 and everything else at 1200 [src: src/pricing.ts:3]",
        "",
        "## Looks broken when",
        "",
        "- A bulk SKU is charged the plain price [src: src/pricing.ts:3]",
        "",
        "## Query",
        "",
        "```sh",
        "npm run test",
        "```",
        "",
        "## Sources",
        "",
        "- `src/pricing.ts:3` is the whole price rule.",
        "",
      ].join("\n"),
    },
  }],
};

// ---------------------------------------------------------------------------
// the shapes the scenarios above are built from
// ---------------------------------------------------------------------------

/** An epic file that `schemas/epic.ts` accepts. `branch` must match `epic/<slug>`. */
function epic(id: string, title: string, stories: readonly string[], branch: string): string {
  return [
    "---",
    "version: 1",
    `id: ${id}`,
    `title: "${title}"`,
    `repos: [${REPO}]`,
    `stories: [${stories.join(", ")}]`,
    `branch: ${branch}`,
    "status: todo",
    "---",
    "",
    `# ${id} · ${title}`,
    "",
  ].join("\n");
}

interface StorySpec {
  readonly id: string;
  readonly epic: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly touches: readonly string[];
  readonly status?: string;
  readonly evidence?: readonly string[];
}

/**
 * A story file that `schemas/story.ts` accepts.
 *
 * The ```dod block names `npm run test` — which detection really found for this
 * repo, and which `validateStoryDod` refuses unless it matches a `workspace.yml`
 * command BYTE FOR BYTE (`schemas/commandAllowlist.ts`). The toy repo's script
 * is `exit 0`, so it is green by construction and the eval measures the
 * framework's DoD machinery rather than a toy's test suite.
 */
function story(spec: StorySpec): string {
  const evidence = spec.evidence ?? [];
  return [
    "---",
    "version: 1",
    `id: ${spec.id}`,
    `epic: ${spec.epic}`,
    `title: "${spec.title}"`,
    `repo: ${REPO}`,
    `status: ${spec.status ?? "todo"}`,
    `depends_on: [${spec.dependsOn.join(", ")}]`,
    `touches: [${spec.touches.map((t) => `"${t}"`).join(", ")}]`,
    "acceptance:",
    `  - "${spec.title}"`,
    "test_plan:",
    "  - \"Unit: priceOf returns the table's value for a BULK- SKU\"",
    evidence.length === 0 ? "evidence: []" : "evidence:",
    ...evidence.map((line) => `  - "${line}"`),
    "---",
    "",
    `# ${spec.id} · ${spec.title}`,
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
  ].join("\n");
}

/** Every eval, in loop order. `README.md` says how to add a sixth. */
export const EVALS: readonly StageEval[] = [WHAT_EVAL, HOW_EVAL, PLAN_EVAL, BUILD_EVAL, WATCH_EVAL];
export { REPO };
