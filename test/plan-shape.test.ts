/**
 * The Plan's SHAPE — how many waves, which wave a story sits in, which commands
 * sibling stories re-run (#316, #317, #318, #319).
 *
 * Measured by a planning audit of 9 runs (relayed, not re-run here): 25/54
 * build-gate rejections were dependency reopens, every multi-story plan checked
 * in one workspace was a strict one-story-per-wave chain, one e2e story that
 * depended on everything was never reached, and 16/37 stories widened their
 * `touches:` at Build time.
 *
 * The rules live in ONE file, `src/core/plan/planShape.ts`: the `plan` gate
 * enforces the mechanical ones, the Plan prompt renders every one of them from
 * the same exports, and `tldrx seed check` prints its size advisories off the
 * same constants. These tests hold each end of that to the source.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePlan } from "../src/core/plan/validatePlan.ts";
import {
  ENFORCEMENT_KEYWORDS, MAX_STORIES_PER_RUN, MAX_WAVES_PER_RUN, PLAN_SHAPE_HEADING, PLAN_SHAPE_RULES,
  POPULATE_VERBS, TOUCH_EDIT_VERBS, TOUCHED_PATH_PATTERN, WAVE_CAP_REASON_KEY,
  invariantSequencingMessage, lateStoryMessage, unevenDodAdvisory, untouchedEditMessage, validatePlanShape,
  waveCapAdvisory, waveCapMessage,
} from "../src/core/plan/planShape.ts";
import { renderPlanSchemaContract } from "../src/core/plan/schemaContract.ts";
import { MAX_STORIES_PER_SEED, MAX_WAVES_PER_SEED } from "../src/core/seed/checkSeed.ts";
import { runCheck } from "../src/core/run/checks.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { FRAMEWORK_ROOT, PLUGIN_DIR } from "../src/core/paths.ts";
import { PLAN_SKILL_RELATIVE } from "../src/core/install/skillFile.ts";
import { MAX_ITEM_CHARS } from "../src/core/schemas/planCommon.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

interface StorySpec {
  readonly id: string;
  readonly epic?: string;
  readonly repo?: string;
  readonly deps?: readonly string[];
  readonly dod?: readonly string[];
  readonly acceptance?: readonly string[];
  readonly testPlan?: readonly string[];
  readonly touches?: readonly string[];
  /** Free-text body lines (steps/prose) between the H1 and the ```dod fence — #376. */
  readonly steps?: readonly string[];
}

function story(spec: StorySpec): string {
  return [
    "---",
    "version: 1",
    `id: ${spec.id}`,
    `epic: ${spec.epic ?? "E1"}`,
    `title: "Story ${spec.id}"`,
    `repo: ${spec.repo ?? "lab"}`,
    "status: todo",
    `depends_on: [${(spec.deps ?? []).join(", ")}]`,
    `touches: ${JSON.stringify(spec.touches ?? [`src/${spec.id.toLowerCase()}/`])}`,
    `acceptance: [${(spec.acceptance ?? ["it works"]).map((s) => JSON.stringify(s)).join(", ")}]`,
    `test_plan: [${(spec.testPlan ?? ["a test"]).map((s) => JSON.stringify(s)).join(", ")}]`,
    "evidence: []",
    "---",
    "",
    `# ${spec.id}`,
    "",
    ...(spec.steps ?? []),
    ...(spec.steps !== undefined ? [""] : []),
    "```dod",
    ...(spec.dod ?? ["true"]),
    "```",
    "",
  ].join("\n");
}

function epic(id: string, stories: readonly string[], repos: readonly string[] = ["lab"]): string {
  return [
    "---", "version: 1", `id: ${id}`, `title: "Epic ${id}"`, `repos: [${repos.join(", ")}]`,
    `stories: [${stories.join(", ")}]`, `branch: epic/${id.toLowerCase()}`, "status: todo", "---", "", `# ${id}`, "",
  ].join("\n");
}

function waves(rows: readonly (readonly string[])[], extra: readonly string[] = []): string {
  return [
    "version: 1",
    ...extra,
    "waves:",
    ...rows.map((ids, i) => `  - {id: W${String(i + 1)}, stories: [${ids.join(", ")}]}`),
    "",
  ].join("\n");
}

/** A plan of stories, every one in E1 unless it says otherwise, scheduled as `rows`. */
function planFiles(
  specs: readonly StorySpec[], rows: readonly (readonly string[])[], extra: readonly string[] = [],
): Record<string, string> {
  const files: Record<string, string> = {};
  const byEpic = new Map<string, { stories: string[]; repos: Set<string> }>();
  for (const spec of specs) {
    files[`stories/${spec.id}.md`] = story(spec);
    const e = spec.epic ?? "E1";
    const entry = byEpic.get(e) ?? { stories: [], repos: new Set<string>() };
    entry.stories.push(spec.id);
    entry.repos.add(spec.repo ?? "lab");
    byEpic.set(e, entry);
  }
  for (const [id, entry] of byEpic) files[`epics/${id}.md`] = epic(id, entry.stories, [...entry.repos]);
  files["waves.yml"] = waves(rows, extra);
  return files;
}

const dirs: string[] = [];
let ws: TempRunWorkspace | null = null;
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  ws?.dispose();
  ws = null;
});

function writePlan(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-plan-shape-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return dir;
}

const ALLOWED = new Set(["true", "false"]);

function messagesOf(dir: string): readonly string[] {
  return validatePlanShape(dir).issues.map((i) => `${i.file} ${i.path}: ${i.message}`);
}

const CHAIN_3: readonly StorySpec[] = [
  { id: "S1" }, { id: "S2", deps: ["S1"] }, { id: "S3", deps: ["S2"] },
];

describe(`the wave cap (#316): more than ${String(MAX_WAVES_PER_RUN)} waves is refused unless the plan records why`, () => {
  test("a 3-wave dependency chain is a finding against waves.yml naming the cap and the reason key", () => {
    const dir = writePlan(planFiles(CHAIN_3, [["S1"], ["S2"], ["S3"]]));
    // The Build loader's check is untouched: the plan is legal to EXECUTE.
    expect(validatePlan(dir, ALLOWED).issues).toEqual([]);
    const issues = validatePlanShape(dir).issues;
    expect(issues.map((i) => i.file)).toEqual(["waves.yml"]);
    expect(issues[0]?.message).toBe(waveCapMessage(3));
    expect(issues[0]?.message).toContain(WAVE_CAP_REASON_KEY);
    expect(issues[0]?.message).toContain(String(MAX_WAVES_PER_RUN));
  });

  test(`a recorded \`${WAVE_CAP_REASON_KEY}\` lets the same plan through`, () => {
    const dir = writePlan(planFiles(CHAIN_3, [["S1"], ["S2"], ["S3"]], [
      `${WAVE_CAP_REASON_KEY}: "S3 reads the table S2 migrates, and S2 edits the route file S1 registers"`,
    ]));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("an empty or non-string reason is not a reason", () => {
    for (const bad of ['""', "[]", "42"]) {
      const dir = writePlan(planFiles(CHAIN_3, [["S1"], ["S2"], ["S3"]], [`${WAVE_CAP_REASON_KEY}: ${bad}`]));
      const found = messagesOf(dir);
      expect(found.length, `reason ${bad}`).toBe(1);
      expect(found[0]).toContain(WAVE_CAP_REASON_KEY);
    }
  });

  test(`an over-cap reason is told its length, the cap, and to write one sentence (#328)`, () => {
    const long = `"${"x".repeat(MAX_ITEM_CHARS + 88)}"`;
    const dir = writePlan(planFiles(CHAIN_3, [["S1"], ["S2"], ["S3"]], [`${WAVE_CAP_REASON_KEY}: ${long}`]));
    const found = messagesOf(dir);
    expect(found.length).toBe(1);
    expect(found[0]).toContain(WAVE_CAP_REASON_KEY);
    expect(found[0]).toContain(`${String(MAX_ITEM_CHARS + 88)} characters (cap ${String(MAX_ITEM_CHARS)})`);
    expect(found[0]).toContain("one sentence");
  });

  test(`${String(MAX_WAVES_PER_RUN)} waves need no reason`, () => {
    const dir = writePlan(planFiles(CHAIN_3.slice(0, 2), [["S1"], ["S2"]]));
    expect(messagesOf(dir)).toEqual([]);
  });
});

describe("a story that waits in a later wave with nothing making it wait (#316)", () => {
  test("an independent story alone in W2 is refused, naming the wave it could run in", () => {
    const dir = writePlan(planFiles([{ id: "S1" }, { id: "S2" }], [["S1"], ["S2"]]));
    expect(validatePlan(dir, ALLOWED).issues).toEqual([]);
    const issues = validatePlanShape(dir).issues;
    expect(issues.map((i) => `${i.file} ${i.path}`)).toEqual(["waves.yml waves[1].stories[0]"]);
    expect(issues[0]?.message).toBe(lateStoryMessage("S2", "W2", "W1"));
  });

  test("a story whose dependencies all finished two waves back is refused too — same mechanism", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1" }, { id: "S2", deps: ["S1"] }, { id: "S3", deps: ["S1"] }],
      [["S1"], ["S2"], ["S3"]],
      [`${WAVE_CAP_REASON_KEY}: "a reason, so only the placement rule speaks"`],
    ));
    expect(validatePlanShape(dir).issues.map((i) => i.message)).toEqual([lateStoryMessage("S3", "W3", "W2")]);
  });

  test("the same stories parallelised pass", () => {
    const dir = writePlan(planFiles([{ id: "S1" }, { id: "S2" }, { id: "S3", deps: ["S1"] }], [["S1", "S2"], ["S3"]]));
    expect(messagesOf(dir)).toEqual([]);
  });
});

describe("uneven dod across one epic's stories in one repo (#319) — an advisory, never a refusal", () => {
  test("a command some siblings carry and one does not is named, with who carries it", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", dod: ["true", "false"] }, { id: "S2", dod: ["true"] }, { id: "S3", dod: ["true", "false"] }],
      [["S1", "S2", "S3"]],
    ));
    const shape = validatePlanShape(dir);
    expect(shape.issues).toEqual([]);
    expect(shape.advisories).toEqual([unevenDodAdvisory("E1", "lab", "false", ["S1", "S3"], ["S2"])]);
  });

  test("different repos, or different epics, are not siblings", () => {
    const dir = writePlan(planFiles(
      [
        { id: "S1", dod: ["true", "false"] }, { id: "S2", repo: "api", dod: ["true"] },
        { id: "S3", epic: "E2", dod: ["true"] },
      ],
      [["S1", "S2", "S3"]],
    ));
    expect(validatePlanShape(dir).advisories).toEqual([]);
  });
});

describe("an invariant enforced before the story that populates it (#365)", () => {
  test("S1 (wave 1) enforcing a NOT NULL column S4 (wave 2, depends_on S1) populates is refused, naming both stories, the field and the two sentences", () => {
    const s1Acceptance = "Add a check constraint on delivery_address_text NOT NULL when fulfillment mode is Delivery";
    const s4Acceptance = "The order placement handler populates delivery_address_text for every Delivery order";
    const dir = writePlan(planFiles(
      [
        { id: "S1", acceptance: [s1Acceptance] },
        { id: "S4", deps: ["S1"], acceptance: [s4Acceptance] },
      ],
      [["S1"], ["S4"]],
    ));
    // The depends_on graph is VALID (S4 depends on S1, W2 after W1) — only the semantic ordering is wrong (#365).
    expect(validatePlan(dir, ALLOWED).issues).toEqual([]);
    const issues = validatePlanShape(dir).issues;
    expect(issues).toEqual([{
      file: "stories/S1.md",
      path: "acceptance",
      message: invariantSequencingMessage(
        "S1", "S4", "delivery_address_text", "delivery_address_text", s1Acceptance, s4Acceptance,
      ),
    }]);
    expect(issues[0]?.message).toContain("S1");
    expect(issues[0]?.message).toContain("S4");
    expect(issues[0]?.message).toContain("delivery_address_text");
  });

  test("the same plan with S1's constraint worded non-enforcing (nullable/consistency-only) passes", () => {
    const dir = writePlan(planFiles(
      [
        { id: "S1", acceptance: ["Add a nullable delivery_address_text column, consistent when present"] },
        { id: "S4", deps: ["S1"], acceptance: ["The order placement handler populates delivery_address_text for every Delivery order"] },
      ],
      [["S1"], ["S4"]],
    ));
    expect(validatePlan(dir, ALLOWED).issues).toEqual([]);
    expect(messagesOf(dir)).toEqual([]);
  });

  test("the enforcing story landing in the SAME wave as the populating story is still refused — parallel worktrees never see each other's writes", () => {
    const s1 = "This field is required and validated with a check constraint on order_note";
    const s2 = "This story sets order_note when the order is created";
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: [s1] }, { id: "S2", acceptance: [s2] }],
      [["S1", "S2"]],
    ));
    expect(validatePlanShape(dir).issues.map((i) => i.message)).toEqual([
      invariantSequencingMessage("S1", "S2", "order_note", "order_note", s1, s2),
    ]);
  });

  test("the enforcing story landing AFTER the populating story passes", () => {
    const s2 = "This story is required to add a check constraint on order_note"; // enforce
    const s1 = "This story populates order_note when the order is created"; // populate
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: [s1] }, { id: "S2", deps: ["S1"], acceptance: [s2] }],
      [["S1"], ["S2"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("the SAME story both populating and enforcing a field is not a violation", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: ["Populates order_note and adds a required check constraint on order_note"] }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("an enforcement sentence naming no field, or a populate sentence naming a different field, is not flagged", () => {
    const dir = writePlan(planFiles(
      [
        { id: "S1", acceptance: ["This is required and validated"] },
        { id: "S2", acceptance: ["This story populates other_field when the order is created"] },
      ],
      [["S1", "S2"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("the same field spelled snake_case in one story and PascalCase in the other is still caught (review finding on #365, the originating incident's exact shape)", () => {
    const s1 = "Add a check constraint requiring `delivery_address_text` NOT NULL when fulfillment mode is Delivery";
    const s4 = "The placement handler sets `DeliveryAddressText` for every Delivery order";
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: [s1] }, { id: "S4", deps: ["S1"], acceptance: [s4] }],
      [["S1"], ["S4"]],
    ));
    const issues = validatePlanShape(dir).issues;
    expect(issues).toEqual([{
      file: "stories/S1.md",
      path: "acceptance",
      message: invariantSequencingMessage("S1", "S4", "delivery_address_text", "DeliveryAddressText", s1, s4),
    }]);
    // The message quotes each story's OWN spelling verbatim — never a normalized one.
    expect(issues[0]?.message).toContain("`delivery_address_text`");
    expect(issues[0]?.message).toContain("`DeliveryAddressText`");
  });

  test("a BARE (no backticks) snake_case field in one story and a bare one-transition PascalCase spelling in the other still refuses — corroborated by the snake_case sibling elsewhere in the plan (review finding on #370's own fix)", () => {
    const s1 = "Add a check constraint on order_total NOT NULL when the order is finalized";
    const s4 = "The pricing engine sets OrderTotal for every finalized order";
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: [s1] }, { id: "S4", deps: ["S1"], acceptance: [s4] }],
      [["S1"], ["S4"]],
    ));
    const issues = validatePlanShape(dir).issues;
    expect(issues).toEqual([{
      file: "stories/S1.md",
      path: "acceptance",
      message: invariantSequencingMessage("S1", "S4", "order_total", "OrderTotal", s1, s4),
    }]);
  });

  test("a genuinely different field is not flagged even across snake_case/PascalCase spellings", () => {
    const s1 = "Add a check constraint requiring `delivery_zone_id` NOT NULL";
    const s4 = "The placement handler sets `DeliveryAddressText` for every Delivery order";
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: [s1] }, { id: "S4", deps: ["S1"], acceptance: [s4] }],
      [["S1"], ["S4"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("the keyword and verb sets are short, exported and non-empty", () => {
    expect(ENFORCEMENT_KEYWORDS.length).toBeGreaterThan(0);
    expect(ENFORCEMENT_KEYWORDS.length).toBeLessThanOrEqual(10);
    expect(POPULATE_VERBS.length).toBeGreaterThan(0);
    expect(POPULATE_VERBS.length).toBeLessThanOrEqual(10);
  });

  test("two unrelated stories sharing a generic camelCase token with one capital transition (`toString`) do not collide (#370)", () => {
    const s1 = "The response payload is required to have a non-empty toString() representation";
    const s2 = "The debug panel populates the toString output for logging";
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: [s1] }, { id: "S2", acceptance: [s2] }],
      [["S1", "S2"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("two unrelated stories sharing a bare `Id`-bearing token with one capital transition (`getId`) do not collide (#370)", () => {
    const s1 = "Every request must be present with a valid getId check before proceeding";
    const s2 = "This job assigns a fresh getId per batch, unrelated to request validation";
    const dir = writePlan(planFiles(
      [{ id: "S1", acceptance: [s1] }, { id: "S2", acceptance: [s2] }],
      [["S1", "S2"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });
});

describe("a story body step naming an edit of a path its own touches allowlist forbids (#376)", () => {
  const S1_STEP = "5. Add a CHANGELOG bullet under a new `## 0.34.0 — unreleased` heading.";

  test("the issue's own S1 shape: touches without CHANGELOG.md, a step naming the unreleased heading, is refused", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", touches: ["scripts/merge-wave.sh", "test/merge-wave.test.ts", "AGENTS.md"], steps: [S1_STEP] }],
      [["S1"]],
    ));
    const issues = validatePlanShape(dir).issues;
    expect(issues).toEqual([{
      file: "stories/S1.md",
      path: "body",
      message: untouchedEditMessage("S1", "CHANGELOG.md", "Add a CHANGELOG bullet under a new `## 0.34.0 — unreleased` heading"),
    }]);
  });

  test("positive control: the same story with CHANGELOG.md in touches is accepted", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", touches: ["scripts/merge-wave.sh", "test/merge-wave.test.ts", "AGENTS.md", "CHANGELOG.md"], steps: [S1_STEP] }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("false-positive control: steps that only READ or point at a file (no edit verb in the same sentence) are accepted, even though the paths are not in touches", () => {
    const dir = writePlan(planFiles(
      [{
        id: "S1",
        touches: ["src/s1/"],
        steps: [
          "1. Read `src/x.ts` for the shape.",
          "2. See `docs/spec.md` for how the schema is documented.",
        ],
      }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("a genuine edit verb with a backtick path not in touches is refused, independent of the CHANGELOG special case", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", touches: ["test/merge-wave.test.ts"], steps: ["3. Edit `scripts/merge-wave.sh` to add the new guard."] }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([
      `stories/S1.md body: ${untouchedEditMessage("S1", "scripts/merge-wave.sh", "Edit `scripts/merge-wave.sh` to add the new guard")}`,
    ]);
  });

  test("the same step's path IS in touches: accepted", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", touches: ["scripts/merge-wave.sh"], steps: ["3. Edit `scripts/merge-wave.sh` to add the new guard."] }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  // Review finding: every other touches-coverage check in the repo (boundary.ts's `inSurface`,
  // read by foreignWork.ts/reviewRound.ts/measuredTouches.ts/unownedFindings.ts) treats a
  // DIRECTORY entry as covering its whole subtree, `${entry}/` beneath it included. A story
  // whose `touches` names a directory it genuinely owns must not be refused for a step editing
  // a file under that directory — that is exactly what Build's real write allowlist accepts.
  test("a directory entry in touches covers a file beneath it, the same way inSurface does everywhere else", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", touches: ["src/core/"], steps: ["3. Edit `src/core/foo.ts` to add the guard."] }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("a directory entry in touches does NOT cover an unrelated sibling with the same prefix (src/core-x/ is not under src/core/)", () => {
    const step = "3. Edit `src/core-extra/foo.ts` to add the guard.";
    const dir = writePlan(planFiles(
      [{ id: "S1", touches: ["src/core/"], steps: [step] }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([
      `stories/S1.md body: ${untouchedEditMessage("S1", "src/core-extra/foo.ts", "Edit `src/core-extra/foo.ts` to add the guard")}`,
    ]);
  });

  test("an edit verb in one sentence and a read-only path in an EARLIER sentence do not combine — split on a sentence-ending `.`", () => {
    const dir = writePlan(planFiles(
      [{
        id: "S1",
        touches: ["src/s1/"],
        steps: ["1. Read `docs/spec.md` for context. Then edit `AGENTS.md` to add the rule."],
      }],
      [["S1"]],
    ));
    const messages = messagesOf(dir).join(" ");
    expect(messages).not.toContain("docs/spec.md");
    expect(messages).toContain("AGENTS.md");
  });

  test("a `*` glob is never treated as a literal path", () => {
    const dir = writePlan(planFiles(
      [{ id: "S1", touches: ["src/s1/"], steps: ["1. Update `src/*.ts` broadly."] }],
      [["S1"]],
    ));
    expect(messagesOf(dir)).toEqual([]);
  });

  test("TOUCH_EDIT_VERBS and TOUCHED_PATH_PATTERN are exported, short, and the pattern rejects a glob", () => {
    expect(TOUCH_EDIT_VERBS.length).toBeGreaterThan(0);
    expect(TOUCH_EDIT_VERBS.length).toBeLessThanOrEqual(15);
    expect([..."`src/x.ts`".matchAll(TOUCHED_PATH_PATTERN)].length).toBe(1);
    expect([..."`src/*.ts`".matchAll(TOUCHED_PATH_PATTERN)].length).toBe(0);
  });
});

describe("the `plan` gate carries the shape", () => {
  const CHECK = { id: "plan", on: "post-write", repo: null, command: null, expect_exit: 0 } as const;

  function gate(files: Record<string, string>) {
    ws = makeRunWorkspace();
    const runDir = join(ws.root, "tldrx-work", "260914-shape");
    for (const [rel, content] of Object.entries(files)) {
      const path = join(runDir, "03-plan", rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    const stage = loadWorkflowPreset(ws.root, "feature").stages.find((s) => s.id === "plan");
    expect(stage).toBeDefined();
    return runCheck(CHECK, { root: ws.root, runDir, stage: stage as NonNullable<typeof stage> });
  }

  test("fails on a 3-wave chain with no reason — a failed check is `approve`'s exit 2", async () => {
    const outcome = await gate(planFiles(CHAIN_3, [["S1"], ["S2"], ["S3"]]));
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain(waveCapMessage(3));
  });

  test("fails on an independent story held back a wave", async () => {
    const outcome = await gate(planFiles([{ id: "S1" }, { id: "S2" }], [["S1"], ["S2"]]));
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain(lateStoryMessage("S2", "W2", "W1"));
  });

  test("passes uneven dod, and says so in its detail", async () => {
    const outcome = await gate(planFiles([{ id: "S1", dod: ["true", "false"] }, { id: "S2", dod: ["true"] }], [["S1", "S2"]]));
    expect(outcome.status).toBe("passed");
    expect(outcome.detail).toContain(unevenDodAdvisory("E1", "lab", "false", ["S1"], ["S2"]));
  });
});

describe("one rule source: the prompt, the seed check and the skill read the same exports", () => {
  test("the Plan prompt's contract renders the shape heading and every shape rule", () => {
    const contract = renderPlanSchemaContract();
    expect(contract).toContain(`### ${PLAN_SHAPE_HEADING}`);
    expect(PLAN_SHAPE_RULES.length).toBeGreaterThanOrEqual(4);
    for (const rule of PLAN_SHAPE_RULES) expect(contract).toContain(rule.text);
    const all = PLAN_SHAPE_RULES.map((r) => r.text).join("\n");
    expect(all).toContain(WAVE_CAP_REASON_KEY);
    expect(all).toContain(`${String(MAX_WAVES_PER_RUN)} waves`);
    for (const issue of ["#316", "#317", "#318", "#319", "#365", "#376"]) {
      expect(PLAN_SHAPE_RULES.some((r) => r.issue === issue), issue).toBe(true);
    }
  });

  test("the seed check's size numbers ARE the plan's", () => {
    expect(MAX_WAVES_PER_SEED).toBe(MAX_WAVES_PER_RUN);
    expect(MAX_STORIES_PER_SEED).toBe(MAX_STORIES_PER_RUN);
    expect(waveCapAdvisory(3)).toContain(String(MAX_WAVES_PER_RUN));
  });

  test("stage.md sends the Plan agent to the rendered shape rules", () => {
    const stage = readFileSync(join(FRAMEWORK_ROOT, "stages", "plan", "stage.md"), "utf8");
    expect(stage).toContain(PLAN_SHAPE_HEADING);
  });

  test("the skill cites the shape rules and the reason key, and spells no wave number of its own", () => {
    const skill = readFileSync(join(PLUGIN_DIR, ...PLAN_SKILL_RELATIVE.split("/")), "utf8");
    expect(skill).toContain(WAVE_CAP_REASON_KEY);
    for (const issue of ["#317", "#318", "#319"]) expect(skill, issue).toContain(issue);
    expect(/≤\s*\d+\s*waves/.test(skill), "a hand-typed wave cap in the skill").toBe(false);
    expect(/\d[–-]\d stories/.test(skill), "a hand-typed story count in the skill").toBe(false);
  });

  test("the seed guide states the numbers the constants hold", () => {
    // Hard-wrapped prose: one space per run of whitespace, so a wrap is not a mismatch.
    const guide = readFileSync(join(FRAMEWORK_ROOT, "docs", "guide", "05-seeds-and-triage.md"), "utf8").replace(/\s+/g, " ");
    expect(guide).toContain(`at most ${String(MAX_STORIES_PER_RUN)} stories and ${String(MAX_WAVES_PER_RUN)} waves`);
  });
});
