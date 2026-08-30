import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  EFFORT_LEVELS, FILE_KINDS, LEGACY_VERSION_NOTE, isEffortLevel, validate, type FileKind,
} from "../src/core/schemas/index.ts";
import { validateRunFile } from "../src/core/run/RunFile.ts";
import { validateRunBudget } from "../src/core/budget/RunBudget.ts";
import { validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
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

/** The minimum a stage.yml must carry — every optional key deliberately absent. */
const STAGE_DOC = {
  name: "what", title: "What", phase: 1, inputs: [], outputs: [], experts: [],
  model: "sonnet", budget_usd: 1, gate: { type: "human-approval" },
} as const;

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

  /**
   * `gate.requires:` was five stage files' worth of acceptance criteria that
   * nothing read (2026-08-29): `normaliseGate` takes `.type`, `validateStage`
   * checks `gate.type`, and the prompt ships `stage.md`, not `stage.yml`. It is
   * deleted. Removed from the TYPE, not from the validator — a user's own stage
   * library that still declares it keeps working, silently ignored, which is what
   * the next test pins.
   */
  test("no shipped stage.yml still declares the dead `gate.requires`", async () => {
    for (const file of stageFiles) {
      const doc = (await readYamlFile(join(STAGES_DIR, file))) as { gate: Record<string, unknown> };
      expect(Object.keys(doc.gate), file).toEqual(["type"]);
    }
  });

  test("a stage.yml that still carries `gate.requires` validates anyway", () => {
    const legacy = {
      name: "x", title: "X", phase: 1, inputs: [], outputs: [], experts: [],
      model: "sonnet", budget_usd: 1,
      gate: { type: "human-approval", requires: ["something a human used to read"] },
    };
    expect(issueText("stage", legacy)).toBe("");
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

  test("stage effort outside the five --effort levels", () => {
    const doc = {
      ...STAGE_DOC, effort: "turbo",
    };
    const check = validate("stage", doc);
    expect(check.ok).toBe(false);
    expect(check.issues.some((i) => i.path === "effort")).toBe(true);
  });

  test("competency level outside 0-5", () => {
    const doc = { schema_version: 0, expert: "e", areas: [{ area: "a", level: 9, evidence: [] }] };
    const check = validate("competencies", doc);
    expect(check.ok).toBe(false);
    expect(check.issues.some((i) => i.path === "areas[0].level")).toBe(true);
  });
});

describe("stage effort is optional and enum-checked", () => {
  test("a stage with no effort at all is valid — the flag is simply not passed", () => {
    expect(issueText("stage", STAGE_DOC)).toBe("");
  });

  for (const level of EFFORT_LEVELS) {
    test(`effort: ${level} is accepted`, () => {
      expect(issueText("stage", { ...STAGE_DOC, effort: level })).toBe("");
    });
  }

  test("the accepted set is exactly what `claude --help` prints for --effort", () => {
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("every shipped stage declares an effort, and it is a legal level", async () => {
    for (const file of [...new Bun.Glob("*/stage.yml").scanSync(STAGES_DIR)].sort()) {
      const doc = (await readYamlFile(join(STAGES_DIR, file))) as { effort?: unknown };
      expect({ file, effort: doc.effort }).toEqual({ file, effort: expect.any(String) });
      expect({ file, legal: isEffortLevel(doc.effort) }).toEqual({ file, legal: true });
    }
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

/**
 * The version key, settled 2026-08-29.
 *
 * Spec §0 has always said `version: 1`. Seven skeleton validators asked for
 * `schema_version` and seven templates printed `schema_version: 0`, while
 * `tldrx init` had been writing `version: 1` the whole time — so the validators
 * accepted only a spelling nothing on disk used, and rejected the tool's own
 * output (measured against a real workspace: every workspace.yml, process.yml,
 * competencies.yml, run.yml and budget.yml said `version: 1`). The spec wins;
 * `schema_version` is tolerated for one release and reported.
 */
describe("version: 1, with schema_version tolerated for one release", () => {
  /** Kind -> a document that is valid except for the version key. */
  const BODIES: ReadonlyArray<readonly [FileKind, Record<string, unknown>]> = [
    ["workspace", { mode: "single", root: ".", repos: [] }],
    ["run", { run_id: "r", scope: "feature", workflow: "feature", status: "pending", budget_usd: 1, phases: [] }],
    ["budget", { run: "r", ceiling_usd: 1, spent_usd: 0, per_phase_usd: {} }],
    ["facts", { facts: [] }],
    ["competencies", { expert: "e", areas: [] }],
    ["env", { tools: [] }],
    ["process", {
      methodology: "none", ticket_tool: "none", story_granularity: "days",
      approvers: ["a"], definition_of_done: [],
    }],
  ];

  for (const [kind, body] of BODIES) {
    test(`${kind}: version: 1 is accepted and raises nothing`, () => {
      const outcome = validate(kind, { version: 1, ...body });
      expect(issueText(kind, { version: 1, ...body })).toBe("");
      expect(outcome.deprecations ?? []).toEqual([]);
    });

    test(`${kind}: schema_version still loads, and says so`, () => {
      const outcome = validate(kind, { schema_version: 0, ...body });
      expect(outcome.ok, issueText(kind, { schema_version: 0, ...body })).toBe(true);
      expect(outcome.deprecations).toEqual([LEGACY_VERSION_NOTE]);
    });

    test(`${kind}: neither key is a missing-\`version\` error`, () => {
      expect(issueText(kind, body)).toContain("version: missing required key `version`");
    });

    test(`${kind}: an unknown version is refused (spec §0)`, () => {
      expect(issueText(kind, { version: 2, ...body })).toContain("version: unknown schema version 2");
    });
  }

  test("the exact note is the one the audit asked for", () => {
    expect(LEGACY_VERSION_NOTE).toBe("schema_version is deprecated — say version: 1");
  });

  /**
   * The three validators a real workspace actually goes through. They never
   * accepted `schema_version` at all, so a file copied from the old
   * `templates/run.yml` did not load; that is what the tolerance is for.
   */
  test("the live run/budget/facts validators tolerate it too", () => {
    const run = validateRunFile({
      schema_version: 0, run: "260830-x", title: "t", scope: "feature", workflow: "feature",
      repos: [], created_at: "2026-08-30T00:00:00Z", updated_at: "2026-08-30T00:00:00Z",
      status: "pending", cursor: { phase: "01-what", stage: "what", task: null },
      budget: { ceiling_usd: 1, spent_usd: 0 }, phases: [],
    });
    expect(run.deprecations).toEqual([LEGACY_VERSION_NOTE]);

    const budget = validateRunBudget({
      schema_version: 0, run: "260830-x", ceiling_usd: 1, per_agent_max_usd: 1,
      on_exceed: "block", phases: [],
    });
    expect(budget.ok, budget.issues.map((i) => `${i.path}: ${i.message}`).join("; ")).toBe(true);
    expect(budget.deprecations).toEqual([LEGACY_VERSION_NOTE]);

    const facts = validateFactsFile({ schema_version: 0, facts: [] });
    expect(facts.ok).toBe(true);
    expect(facts.deprecations).toEqual([LEGACY_VERSION_NOTE]);
  });

  test("every shipped template and the framework env.yml open with `version: 1`", async () => {
    for (const [file] of TEMPLATE_KINDS) {
      const doc = (await readYamlFile(join(TEMPLATES_DIR, file))) as Record<string, unknown>;
      expect(Object.keys(doc)[0], file).toBe("version");
      expect(doc.version, file).toBe(1);
    }
    const env = (await readYamlFile(join(FRAMEWORK_ROOT, "env.yml"))) as Record<string, unknown>;
    expect(Object.keys(env)[0]).toBe("version");
    expect(env.version).toBe(1);
  });
});
