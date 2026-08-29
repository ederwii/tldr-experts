import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readYamlFile } from "../src/core/yaml.ts";
import { TEMPLATES_DIR } from "../src/core/paths.ts";
import { readFileSync } from "node:fs";
import { validate } from "../src/core/schemas/index.ts";
import {
  parseDodBlock, validateStory, validateStoryDod, validateStoryFile,
} from "../src/core/schemas/story.ts";
import { validateEpic, validateEpicFile } from "../src/core/schemas/epic.ts";
import { asWavesFile, validateWaveOrder, validateWaves } from "../src/core/schemas/waves.ts";
import { splitFrontMatter } from "../src/core/schemas/frontMatter.ts";
import { validatePlan } from "../src/core/plan/validatePlan.ts";
import { runCheck } from "../src/core/run/checks.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

function messages(issues: readonly { path: string; message: string }[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join(" | ");
}

const STORY = `---
version: 1
id: S1
epic: E1
title: "Materialise the leaderboard read model"
repo: lab
status: todo
depends_on: []
touches: ["src/features/leaderboard/"]
acceptance: ["Top-50 ranks render from the view"]
test_plan: ["Unit: rank ordering with ties"]
evidence: []
---

# S1

\`\`\`dod
npm run test
\`\`\`
`;

const EPIC = `---
version: 1
id: E1
title: "Player leaderboard"
repos: [lab]
stories: [S1]
branch: epic/leaderboard
status: todo
---

# E1
`;

const WAVES = `version: 1
waves:
  - {id: W1, stories: [S1]}
`;

function storyDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, id: "S1", epic: "E1", title: "t", repo: "lab", status: "todo",
    depends_on: [], touches: ["src/"], acceptance: ["a"], test_plan: ["t"], evidence: [],
    ...overrides,
  };
}

describe("front matter (spec §2.13)", () => {
  test("splits a closed `---` block from the body", () => {
    const fm = splitFrontMatter("---\nid: S1\n---\n\n# body\n");
    expect(fm.present).toBe(true);
    expect(fm.raw).toBe("id: S1");
    expect(fm.body.trim()).toBe("# body");
  });

  test("a file that does not open with `---` has no front matter", () => {
    expect(splitFrontMatter("# S1\n---\n").present).toBe(false);
  });

  test("an unclosed block is not front matter, and says so", () => {
    const report = validateStoryFile("---\nid: S1\n");
    expect(report.validation.ok).toBe(false);
    expect(messages(report.validation.issues)).toContain("must open with `---`");
  });
});

describe("story schema (spec §2.13)", () => {
  test("the shipped template validates", () => {
    const text = readFileSync(join(TEMPLATES_DIR, "story.md"), "utf8");
    const report = validateStoryFile(text);
    expect(messages(report.validation.issues)).toBe("");
    expect(report.story?.id).toBe("S1");
    expect(report.dod.commands).toEqual(["npm run test", "npm run lint"]);
  });

  test("a complete story validates", () => {
    expect(validateStory(storyDoc()).issues).toEqual([]);
  });

  test("a missing required key is named", () => {
    const doc = storyDoc();
    delete doc.test_plan;
    const report = validateStory(doc);
    expect(report.ok).toBe(false);
    expect(messages(report.issues)).toContain("missing required key `test_plan`");
  });

  test("ids, repo names and the status enum are checked", () => {
    const report = validateStory(storyDoc({ id: "story-1", epic: "1", repo: "Lab UI", status: "wip" }));
    const text = messages(report.issues);
    expect(text).toContain("id: expected a story id like `S3`");
    expect(text).toContain("epic: expected an epic id like `E1`");
    expect(text).toContain("repo: expected a workspace.yml repo name");
    expect(text).toContain("status: expected one of todo | in_progress | review | done | blocked");
  });

  test("acceptance, test_plan and touches must not be empty", () => {
    const report = validateStory(storyDoc({ acceptance: [], test_plan: [], touches: [] }));
    const text = messages(report.issues);
    expect(text).toContain("acceptance: must not be empty");
    expect(text).toContain("test_plan: must not be empty");
    expect(text).toContain("touches: must not be empty");
  });

  test("a story cannot depend on itself", () => {
    expect(messages(validateStory(storyDoc({ depends_on: ["S1"] })).issues))
      .toContain("`S1` cannot depend on itself");
  });

  test("`status: done` with no evidence is refused — done means proven", () => {
    const report = validateStory(storyDoc({ status: "done", evidence: [] }));
    expect(report.ok).toBe(false);
    expect(messages(report.issues)).toContain("done means proven, not asserted");
  });

  test("the registry accepts a story through `validate('story', …)`", () => {
    expect(validate("story", storyDoc()).ok).toBe(true);
  });
});

describe("the ```dod block", () => {
  test("is read verbatim, minus blanks and comments", () => {
    const dod = parseDodBlock("prose\n```dod\n# a comment\nnpm run test\n\nnpm run lint\n```\nmore\n");
    expect(dod.present).toBe(true);
    expect(dod.commands).toEqual(["npm run test", "npm run lint"]);
  });

  test("a dod command that is not in workspace.yml is an error", () => {
    const allowed = new Set(["npm run test", "npm run lint"]);
    const issues = validateStoryDod(parseDodBlock("```dod\nrm -rf /\n```"), allowed);
    expect(messages(issues)).toContain("`rm -rf /` is not one of .tldrx/workspace.yml's commands");
  });

  test("every dod command in workspace.yml passes", () => {
    const allowed = new Set(["npm run test"]);
    expect(validateStoryDod(parseDodBlock("```dod\nnpm run test\n```"), allowed)).toEqual([]);
  });

  test("with no workspace commands to check against, membership is not invented", () => {
    expect(validateStoryDod(parseDodBlock("```dod\nnpm run test\n```"), new Set())).toEqual([]);
  });

  test("a missing block is an error — the gate would have nothing to re-run", () => {
    expect(messages(validateStoryDod(parseDodBlock("no fence here"), new Set())))
      .toContain("no fenced ```dod block");
  });
});

describe("epic schema (spec §2.14)", () => {
  test("the shipped template validates", () => {
    const report = validateEpicFile(readFileSync(join(TEMPLATES_DIR, "epic.md"), "utf8"));
    expect(messages(report.validation.issues)).toBe("");
    expect(report.epic?.branch).toBe("epic/leaderboard");
  });

  test("the branch must be `epic/<slug>`", () => {
    const doc = { version: 1, id: "E1", title: "t", repos: ["lab"], stories: ["S1"], branch: "feature/x", status: "todo" };
    expect(messages(validateEpic(doc).issues)).toContain("expected a branch named `epic/<slug>`");
  });

  test("an epic with no stories is refused", () => {
    const doc = { version: 1, id: "E1", title: "t", repos: ["lab"], stories: [], branch: "epic/x", status: "todo" };
    expect(messages(validateEpic(doc).issues)).toContain("stories: must not be empty");
  });
});

describe("waves.yml (spec §2.15)", () => {
  test("the shipped template validates", async () => {
    const doc = await readYamlFile(join(TEMPLATES_DIR, "waves.yml"));
    expect(validate("waves", doc).issues).toEqual([]);
  });

  test("wave ids ascend, because file order is execution order", () => {
    const doc = { version: 1, waves: [{ id: "W2", stories: ["S1"] }, { id: "W1", stories: ["S2"] }] };
    expect(messages(validateWaves(doc).issues)).toContain("waves are listed in execution order, so ids ascend");
  });

  test("a story runs in exactly one wave", () => {
    const doc = { version: 1, waves: [{ id: "W1", stories: ["S1"] }, { id: "W2", stories: ["S1"] }] };
    expect(messages(validateWaves(doc).issues)).toContain("`S1` is already scheduled in W1");
  });

  test("a dependency in an EARLIER wave is fine", () => {
    const file = asWavesFile({ version: 1, waves: [{ id: "W1", stories: ["S1"] }, { id: "W2", stories: ["S2"] }] });
    expect(validateWaveOrder(file, new Map([["S2", ["S1"]]]))).toEqual([]);
  });

  test("a dependency in a LATER wave is an error", () => {
    const file = asWavesFile({ version: 1, waves: [{ id: "W1", stories: ["S1"] }, { id: "W2", stories: ["S2"] }] });
    const issues = validateWaveOrder(file, new Map([["S1", ["S2"]]]));
    expect(issues).toHaveLength(1);
    expect(messages(issues)).toContain("S1 runs in W1 but depends on S2, which runs later in W2");
  });

  test("a dependency in the SAME wave is an error — the two would run in parallel", () => {
    const file = asWavesFile({ version: 1, waves: [{ id: "W1", stories: ["S1", "S2"] }] });
    expect(messages(validateWaveOrder(file, new Map([["S2", ["S1"]]]))))
      .toContain("which runs in the same wave (W1)");
  });

  test("a dependency no wave runs is an error", () => {
    const file = asWavesFile({ version: 1, waves: [{ id: "W1", stories: ["S1"] }] });
    expect(messages(validateWaveOrder(file, new Map([["S1", ["S9"]]]))))
      .toContain("S1 depends on S9, which no wave runs");
  });
});

describe("validatePlan — the three artefacts read together", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function plan(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), "tldrx-plan-"));
    for (const [rel, content] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    return dir;
  }

  const HAPPY = {
    "stories/S1.md": STORY,
    "epics/E1.md": EPIC,
    "waves.yml": WAVES,
  };

  test("a consistent plan passes", () => {
    const report = validatePlan(plan(HAPPY), new Set(["npm run test"]));
    expect(messages(report.issues)).toBe("");
    expect(report).toMatchObject({ ok: true, storyCount: 1, epicCount: 1, waveCount: 1 });
  });

  test("a dod command workspace.yml does not declare fails the plan", () => {
    const report = validatePlan(plan(HAPPY), new Set(["npm run build"]));
    expect(report.ok).toBe(false);
    expect(messages(report.issues)).toContain("not one of .tldrx/workspace.yml's commands");
  });

  test("a dependency in a later wave fails the plan", () => {
    const s2 = STORY.replace("id: S1", "id: S2").replace("depends_on: []", "depends_on: [S1]");
    const report = validatePlan(plan({
      "stories/S1.md": STORY.replace("depends_on: []", "depends_on: [S2]"),
      "stories/S2.md": s2,
      "epics/E1.md": EPIC.replace("stories: [S1]", "stories: [S1, S2]"),
      "waves.yml": "version: 1\nwaves:\n  - {id: W1, stories: [S1]}\n  - {id: W2, stories: [S2]}\n",
    }), new Set(["npm run test"]));
    expect(report.ok).toBe(false);
    expect(messages(report.issues)).toContain("S1 runs in W1 but depends on S2, which runs later in W2");
  });

  test("a story in no wave fails the plan", () => {
    const report = validatePlan(plan({
      ...HAPPY,
      "stories/S2.md": STORY.replace("id: S1", "id: S2"),
      "epics/E1.md": EPIC.replace("stories: [S1]", "stories: [S1, S2]"),
    }), new Set(["npm run test"]));
    expect(messages(report.issues)).toContain("S2 is in no wave");
  });

  test("a story whose epic does not list it fails the plan", () => {
    const report = validatePlan(plan({
      ...HAPPY,
      "stories/S1.md": STORY.replace("epic: E1", "epic: E2"),
      "epics/E2.md": EPIC.replace("id: E1", "id: E2").replace("stories: [S1]", "stories: [S1]"),
    }), new Set(["npm run test"]));
    // E1 still claims S1 while the story now names E2 — the two must agree.
    expect(report.ok).toBe(false);
    expect(messages(report.issues)).toContain("S1");
  });

  test("a missing waves.yml is named, not guessed around", () => {
    const report = validatePlan(plan({ "stories/S1.md": STORY, "epics/E1.md": EPIC }), new Set());
    expect(report.ok).toBe(false);
    expect(messages(report.issues)).toContain("without it nothing knows what may run in parallel");
  });
});

describe("the `plan` gate check (spec §2.15)", () => {
  let ws: TempRunWorkspace | null = null;
  afterEach(() => {
    ws?.dispose();
    ws = null;
  });

  /** A run dir holding just `03-plan/`, plus the shipped `plan`/`what` stage specs. */
  function setUp(files: Record<string, string>): { root: string; runDir: string } {
    ws = makeRunWorkspace();
    const runDir = join(ws.root, "tldrx-work", "260830-leaderboard");
    for (const [rel, content] of Object.entries(files)) {
      const path = join(runDir, "03-plan", rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    return { root: ws.root, runDir };
  }

  function stageSpec(root: string, id: string) {
    const stage = loadWorkflowPreset(root, "feature").stages.find((s) => s.id === id);
    expect(stage).toBeDefined();
    return stage as NonNullable<typeof stage>;
  }

  const CHECK = { id: "plan", on: "post-write", repo: null, command: null, expect_exit: 0 } as const;

  test("passes on a consistent plan", async () => {
    // The temp workspace declares `true`/`false` as its repo commands (see the
    // fixture), so the story's dod block cites one of those, verbatim.
    const { root, runDir } = setUp({
      "stories/S1.md": STORY.replace("repo: lab", "repo: api").replace("npm run test", "true"),
      "epics/E1.md": EPIC.replace("repos: [lab]", "repos: [api]"),
      "waves.yml": WAVES,
    });
    const outcome = await runCheck(CHECK, { root, runDir, stage: stageSpec(root, "plan") });
    expect(outcome).toMatchObject({ id: "plan", status: "passed" });
    expect(outcome.detail).toContain("1 wave(s)");
  });

  test("fails, naming the file, when a dod command is not in workspace.yml", async () => {
    const { root, runDir } = setUp({
      "stories/S1.md": STORY.replace("repo: lab", "repo: api"),
      "epics/E1.md": EPIC.replace("repos: [lab]", "repos: [api]"),
      "waves.yml": WAVES,
    });
    const outcome = await runCheck(CHECK, { root, runDir, stage: stageSpec(root, "plan") });
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("stories/S1.md");
    expect(outcome.detail).toContain("not one of .tldrx/workspace.yml's commands");
  });

  test("is skipped for a stage that writes no waves.yml", async () => {
    const { root, runDir } = setUp({ "waves.yml": WAVES });
    const outcome = await runCheck(CHECK, { root, runDir, stage: stageSpec(root, "what") });
    expect(outcome).toMatchObject({ id: "plan", status: "skipped" });
  });
});
