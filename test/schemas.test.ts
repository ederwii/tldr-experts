import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FILE_KINDS, validate, type FileKind } from "../src/core/schemas/index.ts";
import { readYamlFile } from "../src/core/yaml.ts";
import { FRAMEWORK_ROOT, STAGES_DIR, TEMPLATES_DIR, WORKFLOWS_DIR } from "../src/core/paths.ts";

/** template file -> the kind that must accept it */
const TEMPLATE_KINDS: ReadonlyArray<readonly [string, FileKind]> = [
  ["workspace.yml", "workspace"],
  ["run.yml", "run"],
  ["budget.yml", "budget"],
  ["facts.yml", "facts"],
  ["competencies.yml", "competencies"],
  ["process.yml", "process"],
  ["env.yml", "env"],
  ["waves.yml", "waves"],
];

function issueText(kind: FileKind, input: unknown): string {
  return validate(kind, input).issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}

describe("the registry", () => {
  test("covers every declared file kind", () => {
    expect([...FILE_KINDS].sort()).toEqual([
      "budget", "competencies", "env", "epic", "facts", "process", "run", "stage",
      "story", "waves", "workflow", "workspace",
    ]);
  });
});

describe("validators accept the shipped templates", () => {
  for (const [file, kind] of TEMPLATE_KINDS) {
    test(`templates/${file} validates as ${kind}`, async () => {
      const doc = await readYamlFile(join(TEMPLATES_DIR, file));
      const check = validate(kind, doc);
      expect(check.issues).toEqual([]);
      expect(check.ok).toBe(true);
    });
  }

  test("the framework's own env.yml validates", async () => {
    const doc = await readYamlFile(join(FRAMEWORK_ROOT, "env.yml"));
    expect(validate("env", doc).ok).toBe(true);
  });
});

describe("validators accept every shipped stage and workflow", () => {
  const stageFiles = [...new Bun.Glob("*/stage.yml").scanSync(STAGES_DIR)].sort();
  const workflowFiles = [...new Bun.Glob("*.yml").scanSync(WORKFLOWS_DIR)].sort();

  test("all five stages are present", () => {
    expect(stageFiles).toHaveLength(5);
  });

  test("all thirteen scopes are present", () => {
    expect(workflowFiles).toHaveLength(13);
    expect(workflowFiles.map((f) => f.replace(/\.yml$/, ""))).toEqual([
      "bugfix", "docs", "feature", "hotfix", "integration", "migration", "performance",
      "prototype", "refactor", "retro", "security-patch", "spike", "upgrade",
    ]);
  });

  for (const file of stageFiles) {
    test(`stages/${file} validates`, async () => {
      const doc = await readYamlFile(join(STAGES_DIR, file));
      expect(issueText("stage", doc)).toBe("");
    });
  }

  for (const file of workflowFiles) {
    test(`workflows/${file} validates`, async () => {
      const doc = await readYamlFile(join(WORKFLOWS_DIR, file));
      expect(issueText("workflow", doc)).toBe("");
    });
  }

  test("no workflow names a stage that does not exist", async () => {
    const known = new Set(stageFiles.map((f) => f.split("/")[0]));
    for (const file of workflowFiles) {
      const doc = (await readYamlFile(join(WORKFLOWS_DIR, file))) as {
        stages: string[];
        skips: string[];
      };
      for (const stage of [...doc.stages, ...doc.skips]) {
        expect({ file, stage, known: known.has(stage) }).toEqual({ file, stage, known: true });
      }
    }
  });

  test("every stage ships a stage.md template beside its stage.yml", async () => {
    for (const file of stageFiles) {
      const md = join(STAGES_DIR, file.replace("stage.yml", "stage.md"));
      expect(await Bun.file(md).exists()).toBe(true);
    }
  });
});

describe("validators reject a missing required key", () => {
  const cases: ReadonlyArray<readonly [FileKind, string, unknown]> = [
    ["workspace", "repos", { schema_version: 0, mode: "single", root: "." }],
    ["run", "phases", { schema_version: 0, run_id: "r", scope: "feature", workflow: "feature", status: "pending", budget_usd: 1 }],
    ["stage", "gate", { name: "x", title: "X", phase: 1, inputs: [], outputs: [], experts: [], model: "sonnet", budget_usd: 1 }],
    ["workflow", "depth", { name: "x", description: "d", stages: [], skips: [], default_budget_usd: 1 }],
    ["facts", "facts", { schema_version: 0 }],
    ["competencies", "areas", { schema_version: 0, expert: "e" }],
    ["env", "tools", { schema_version: 0 }],
    ["process", "approvers", { schema_version: 0, methodology: "none", ticket_tool: "none", story_granularity: "days", definition_of_done: [] }],
    ["budget", "per_phase_usd", { schema_version: 0, run: "r", ceiling_usd: 1, spent_usd: 0 }],
  ];

  for (const [kind, missing, doc] of cases) {
    test(`${kind} rejects a document with no \`${missing}\``, () => {
      const check = validate(kind, doc);
      expect(check.ok).toBe(false);
      expect(check.issues.some((i) => i.path === missing)).toBe(true);
    });
  }

  test("every kind rejects a non-mapping document root", () => {
    for (const kind of FILE_KINDS) {
      expect(validate(kind, ["not", "a", "mapping"]).ok).toBe(false);
      expect(validate(kind, "a string").ok).toBe(false);
      expect(validate(kind, null).ok).toBe(false);
    }
  });
});

describe("validators reject bad enum values", () => {
  test("workflow depth", () => {
    const doc = { name: "x", description: "d", stages: [], skips: [], depth: "extremely", default_budget_usd: 1 };
    const check = validate("workflow", doc);
    expect(check.ok).toBe(false);
    expect(check.issues[0]?.path).toBe("depth");
  });

  test("process methodology", () => {
    const doc = {
      schema_version: 0, methodology: "waterfall", ticket_tool: "none",
      story_granularity: "days", approvers: [], definition_of_done: [],
    };
    const check = validate("process", doc);
    expect(check.ok).toBe(false);
    expect(check.issues.some((i) => i.path === "methodology")).toBe(true);
  });

  test("competency level outside 0-5", () => {
    const doc = { schema_version: 0, expert: "e", areas: [{ area: "a", level: 9, evidence: [] }] };
    const check = validate("competencies", doc);
    expect(check.ok).toBe(false);
    expect(check.issues.some((i) => i.path === "areas[0].level")).toBe(true);
  });
});

describe("validation is fast enough to run on every write", () => {
  test("the whole registry over the shipped files stays well under 50ms", async () => {
    const docs = await Promise.all(
      TEMPLATE_KINDS.map(async ([file, kind]) => [kind, await readYamlFile(join(TEMPLATES_DIR, file))] as const),
    );
    const start = performance.now();
    for (let i = 0; i < 100; i++) for (const [kind, doc] of docs) validate(kind, doc);
    const perPass = (performance.now() - start) / 100;
    expect(perPass).toBeLessThan(50);
  });
});
