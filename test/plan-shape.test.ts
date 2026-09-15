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
  MAX_STORIES_PER_RUN, MAX_WAVES_PER_RUN, PLAN_SHAPE_HEADING, PLAN_SHAPE_RULES, WAVE_CAP_REASON_KEY,
  lateStoryMessage, unevenDodAdvisory, validatePlanShape, waveCapAdvisory, waveCapMessage,
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
    `touches: ["src/${spec.id.toLowerCase()}/"]`,
    'acceptance: ["it works"]',
    'test_plan: ["a test"]',
    "evidence: []",
    "---",
    "",
    `# ${spec.id}`,
    "",
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
    for (const issue of ["#316", "#317", "#318", "#319"]) {
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
