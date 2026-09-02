/**
 * The contract the `plan` check enforces, stated in the material the plan agent
 * actually reads (gh #35, #38).
 *
 * Both issues are the same failure seen twice: **the contract the checker
 * enforces is not the contract the prompt states.** A live run
 * (`260831-hardening-d1`) wrote 7 stories as plain markdown because nothing in
 * the bundle said they were schema'd YAML front matter; a second run
 * (`260829-scoring-leaderboard`) wrote a 1,009-character acceptance item because
 * nothing in the bundle named the 512-character cap. Each cost one paid attempt
 * to learn something the framework already knew.
 *
 * So the test is not "the prompt mentions front matter". It is: the prompt
 * carries a `## Output schemas` section, that section is GENERATED from the same
 * constants `validateStory` / `validateEpic` / `validateWaves` read, and it
 * reaches the agent through the real `tldrx next --prepare` bundle.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGES_DIR } from "../src/core/paths.ts";
import { MAX_ITEM_CHARS, MAX_LIST_ITEMS, PLAN_STATUSES } from "../src/core/schemas/planCommon.ts";
import { STORY_KEYS, validateStory } from "../src/core/schemas/story.ts";
import { EPIC_KEYS } from "../src/core/schemas/epic.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import {
  makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// `runNext` spawns real processes even in prepare mode. Same reason as #43: the
// fixed 5000 ms default measures the box, not the code.
setDefaultTimeout(spawnTestTimeout());

/** The H2 the framework owns. Spelled out here on purpose: the test pins it. */
const CONTRACT_HEADING = "## Output schemas";

const PLAN_STAGE_MD = readFileSync(join(STAGES_DIR, "plan", "stage.md"), "utf8");

let workspaces: FacilitatorWorkspace[] = [];

afterEach(() => {
  for (const ws of workspaces) ws.dispose();
  workspaces = [];
});

/** A stage shaped like the shipped Plan stage: writes waves.yml, declares `plan`. */
const PLAN_STAGE: readonly StageOptions[] = [{
  id: "plan",
  phase: "03-plan",
  budgetUsd: 4,
  outputs: [{ path: "waves.yml" }],
  checks: "[plan]",
  stageMd: PLAN_STAGE_MD,
}];

/** A stage that neither writes plan artefacts nor declares the check. */
const WHAT_STAGE: readonly StageOptions[] = [{
  id: "what",
  phase: "01-what",
  budgetUsd: 4,
  outputs: [{ path: "01-what/handoff.md" }],
}];

async function preparedPrompt(stages: readonly StageOptions[], stageId: string): Promise<string> {
  const ws = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10 });
  workspaces.push(ws);
  const result = await runNext({
    root: ws.root,
    dryRun: false,
    mode: "prepare",
    yolo: false,
    actor: "alan",
    at: "2026-08-31T09:00:00Z",
  });
  expect(result.code).toBe(0);
  return readFileSync(join(ws.runDir, ".agent", stageId, "prompt.md"), "utf8");
}

/** The `## Output schemas` body, or `""` when the prompt has no such section. */
function contractSection(prompt: string): string {
  const at = prompt.indexOf(`${CONTRACT_HEADING}\n`);
  if (at === -1) return "";
  const rest = prompt.slice(at + CONTRACT_HEADING.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the plan bundle states the schema the `plan` check enforces (#35)", () => {
  test("the prepared prompt carries an `## Output schemas` section", async () => {
    const prompt = await preparedPrompt(PLAN_STAGE, "plan");
    expect(prompt).toContain(CONTRACT_HEADING);
  });

  test("it names every story front-matter key the validator requires", async () => {
    const section = contractSection(await preparedPrompt(PLAN_STAGE, "plan"));
    for (const key of STORY_KEYS) expect(section).toContain(`${key}:`);
  });

  test("it names every epic front-matter key the validator requires", async () => {
    const section = contractSection(await preparedPrompt(PLAN_STAGE, "plan"));
    for (const key of EPIC_KEYS) expect(section).toContain(`${key}:`);
  });

  test("it states that the block is YAML front matter opened and closed with `---`", async () => {
    const section = contractSection(await preparedPrompt(PLAN_STAGE, "plan"));
    expect(section).toContain("front matter");
    expect(section).toContain("---");
  });

  test("it states the status enum, in full", async () => {
    const section = contractSection(await preparedPrompt(PLAN_STAGE, "plan"));
    for (const status of PLAN_STATUSES) expect(section).toContain(status);
  });

  test("a stage that writes no plan artefacts pays no bytes for it", async () => {
    const prompt = await preparedPrompt(WHAT_STAGE, "what");
    expect(prompt).not.toContain(CONTRACT_HEADING);
  });
});

describe("the plan bundle states the caps the validator enforces (#38)", () => {
  test("MAX_ITEM_CHARS reaches the agent, as its current value", async () => {
    const section = contractSection(await preparedPrompt(PLAN_STAGE, "plan"));
    expect(section).toContain(String(MAX_ITEM_CHARS));
  });

  test("MAX_LIST_ITEMS reaches the agent, as its current value", async () => {
    const section = contractSection(await preparedPrompt(PLAN_STAGE, "plan"));
    expect(section).toContain(String(MAX_LIST_ITEMS));
  });
});

describe("the violation message names the cap it broke (#38)", () => {
  test("an over-long list ITEM is told the per-item character cap", () => {
    const issues = validateStory({
      version: 1, id: "S1", epic: "E1", title: "t", repo: "lab", status: "todo",
      depends_on: [], touches: ["src/"], acceptance: ["x".repeat(MAX_ITEM_CHARS + 1)],
      test_plan: ["unit"], evidence: [],
    }).issues;
    const message = issues.find((i) => i.path === "acceptance[0]")?.message ?? "";
    expect(message).toContain(`${String(MAX_ITEM_CHARS)}-character cap`);
    expect(message).toContain(String(MAX_ITEM_CHARS + 1));
  });

  test("an over-long LIST is told the item-count cap", () => {
    const issues = validateStory({
      version: 1, id: "S1", epic: "E1", title: "t", repo: "lab", status: "todo",
      depends_on: [], touches: ["src/"],
      acceptance: Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `criterion ${String(i)}`),
      test_plan: ["unit"], evidence: [],
    }).issues;
    const message = issues.find((i) => i.path === "acceptance")?.message ?? "";
    expect(message).toContain(`${String(MAX_LIST_ITEMS)}-item cap`);
    expect(message).toContain(String(MAX_LIST_ITEMS + 1));
  });
});

/**
 * The checklist reaches the agent through the REAL bundle (gh #132).
 *
 * `plan-schema-contract.test.ts` pins the three rules against
 * `renderPlanSchemaContract()`. This one asks the question that issue is about:
 * does a plan agent, handed the prompt `tldrx next --prepare` actually writes,
 * read them? A contract that renders correctly and is spliced into no prompt is
 * the `templates/story.md` failure again (#48).
 */
describe("the plan bundle tells the agent how to COMPLETE `touches` (#132)", () => {
  test("the prepared prompt carries all three rules and what omitting one costs", async () => {
    const section = contractSection(await preparedPrompt(PLAN_STAGE, "plan"))
      .toLowerCase().replaceAll(/\s+/g, " ");
    // S2: the red gate needed a test file the story never declared.
    expect(section).toContain("for every source file the story changes, the file its tests live in");
    // S4: two new enum members, and the switch sites that would not compile.
    expect(section).toContain("every switch, registration, factory, di container or barrel that has to handle it");
    // S8: a security criterion whose file was outside the surface passed on nothing.
    expect(section).toContain("a criterion whose file is not in the surface passes vacuously");
    // Why any of it matters, in the prompt rather than in an issue.
    expect(section).toContain("the story comes back for another paid round");
  });
});
