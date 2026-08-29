import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { parseYaml } from "../src/core/yaml.ts";
import { validate } from "../src/core/schemas/index.ts";
import { SpawnCommandRunner } from "../src/core/detect/index.ts";
import { endsWithToken, isBullet } from "../src/core/map/index.ts";
import {
  competencyLevel, planExperts, planQuestions, renderQuestions, runInit, upsertBlock,
  validateProcessDocument, validateWorkspaceDocument, buildWorkspaceDocument,
  GITIGNORE_MARKERS, type InitOptions, type InitReport,
} from "../src/core/init/index.ts";
import { describeStageLoads, stageIds, stagesLoadingExperts } from "../src/core/experts/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { emptyFixture, multiRepoFixture, singleRepoFixture, type Fixture } from "./init-fixture.ts";

const runner = new SpawnCommandRunner();
const NOW = new Date("2026-08-28T12:00:00Z");

function options(root: string, overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    root, out: root, interview: true, methodology: null, mcp: false, stack: [], provider: "static", ...overrides,
  };
}

async function init(root: string, overrides: Partial<InitOptions> = {}): Promise<InitReport> {
  return runInit(options(root, overrides), { runner, cliVersion: "0.0.1", now: NOW });
}

async function readYaml(path: string): Promise<Record<string, unknown>> {
  const parsed = parseYaml(await Bun.file(path).text());
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path} is not a mapping`);
  return parsed as Record<string, unknown>;
}

describe("tldrx init — multi-repo workspace", () => {
  let fixture: Fixture;
  let report: InitReport;

  beforeAll(async () => {
    fixture = await multiRepoFixture();
    report = await init(fixture.root);
  });
  afterAll(async () => { await fixture.cleanup(); });

  test("workspace.yml carries the spec §2.1 fields for every repo", async () => {
    const document = await readYaml(join(fixture.root, ".tldrx/workspace.yml"));
    expect(document.version).toBe(1);
    expect(document.mode).toBe("multi-repo");
    expect(document.root_is_repo).toBe(true);
    expect(document.detected_by).toBe("tldrx 0.0.1");
    expect(document.detected_at).toBe("2026-08-28T12:00:00Z");
    expect(document.provider).toBe("static");

    const repos = document.repos as Record<string, unknown>[];
    expect(repos.map((repo) => repo.name)).toEqual(["api-service", "lab"]);

    const lab = repos.find((repo) => repo.name === "lab");
    expect(lab?.path).toBe("lab");
    expect(lab?.default_branch).toBe("main");
    expect(lab?.stack).toEqual(["typescript", "react", "vite"]);
    expect(lab?.package_manager).toBe("npm");
    expect(lab?.confidence).toBe("high");
    expect(lab?.ci).toEqual([".github/workflows/ci.yml"]);
    expect(lab?.commands).toEqual({
      build: "npm run build", test: "npm run test", lint: "npm run lint",
      typecheck: "npm run typecheck", run: "npm run dev",
    });

    const api = repos.find((repo) => repo.name === "api-service");
    expect(api?.stack).toEqual(["dotnet"]);
    expect((api?.commands as Record<string, unknown>).typecheck).toBeNull();
  });

  test("the emitted workspace document passes the shipped validator", () => {
    const document = buildWorkspaceDocument({
      workspace: report.workspace, root: ".", detectedAt: "2026-08-28T12:00:00Z",
      cliVersion: "0.0.1", provider: "static", mcpServers: [],
    });
    expect(validateWorkspaceDocument(document).issues).toEqual([]);
    expect(validate("workspace", {
      schema_version: 1, mode: "multi", root: ".", repos: document.repos,
    }).ok).toBe(true);
  });

  test("every map document exists and every bullet in it ends with a [src: …] token", async () => {
    for (const repo of ["lab", "api-service"]) {
      for (const doc of ["architecture", "domains", "conventions", "commands", "hotspots", "gotchas"]) {
        const path = join(fixture.root, ".tldrx/map", repo, `${doc}.md`);
        const text = await Bun.file(path).text();
        const bullets = text.split("\n").filter(isBullet);
        expect(bullets.length).toBeGreaterThan(0);
        for (const bullet of bullets) expect(endsWithToken(bullet)).toBe(true);
      }
    }
    expect(await Bun.file(join(fixture.root, ".tldrx/map/workspace.md")).exists()).toBe(true);
  });

  test("the handoff has the four sections in order, all sourced", async () => {
    const text = await Bun.file(join(fixture.root, ".tldrx/init-handoff.md")).text();
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## Findings", "## Decisions", "## Unknowns", "## Evidence ledger"]);
    for (const bullet of text.split("\n").filter(isBullet)) expect(endsWithToken(bullet)).toBe(true);
  });

  test("init-questions.md parses as §2.7 blocks and asks only about real gaps", async () => {
    const text = await Bun.file(join(fixture.root, ".tldrx/init-questions.md")).text();
    const headings = [...text.matchAll(/^## (Q\d+) · (.+)$/gm)];
    expect(headings.length).toBe(report.questions.length);
    expect(headings.map((match) => match[1])).toEqual(report.questions.map((question) => question.id));

    for (const meta of text.matchAll(/^<!-- (.+) -->$/gm)) {
      const keys = (meta[1] ?? "").split(" | ").map((pair) => pair.split(": ")[0]);
      expect(keys).toEqual(["id", "status", "area", "asked_by", "asked_at"]);
      expect(meta[1]).toContain("status: open");
    }
    for (const why of text.split("\n").filter((line) => line.startsWith("Why asked:"))) {
      expect(endsWithToken(why)).toBe(true);
    }
    expect(text.match(/^\[Answer\]:$/gm)?.length).toBe(report.questions.length);
    for (const block of text.split("\n## ").slice(1)) {
      const letters = [...block.matchAll(/^- ([A-E])\) /gm)].map((match) => match[1]);
      expect(letters.length).toBeGreaterThanOrEqual(2);
      expect(letters).toEqual(["A", "B", "C", "D", "E"].slice(0, letters.length));
    }
  });

  test("seeds the five role experts, one per language and one per domain folder, all at level 0", async () => {
    expect(report.experts.map((expert) => expert.name).sort())
      .toEqual([
        "api", "architect", "delivery", "developer", "dotnet-stack", "features",
        "operations", "product", "typescript-stack",
      ]);
    expect(report.experts.slice(0, 5).map((expert) => expert.name))
      .toEqual(["product", "architect", "delivery", "developer", "operations"]);
    expect(report.experts[0]?.kind).toBe("role");

    const document = await readYaml(join(fixture.root, ".tldrx/experts/typescript-stack/competencies.yml"));
    expect(document.version).toBe(1);
    expect(document.status).toBe("created");
    expect(document.last_trained).toBeNull();

    const areas = document.areas as Record<string, unknown>[];
    expect(areas.map((area) => area.id)).toEqual(["typescript", "react", "vite"]);
    for (const area of areas) {
      expect(area.level).toBe(0);
      expect(area.evidence).toEqual([]);
      expect(area.train_prompt).toContain("tldrx expert train typescript-stack --area");
    }
    expect(await Bun.file(join(fixture.root, ".tldrx/experts/typescript-stack/expert.md")).exists()).toBe(true);
  });

  test("writes shared and per-repo conventions, and a valid process.yml", async () => {
    expect(await Bun.file(join(fixture.root, ".tldrx/conventions/shared.md")).text())
      .toContain("One class, record, interface or enum per file");
    const repoConventions = await Bun.file(join(fixture.root, ".tldrx/conventions/lab.md")).text();
    expect(repoConventions).toContain("ESLint enforces lint rules");
    for (const bullet of repoConventions.split("\n").filter(isBullet)) expect(endsWithToken(bullet)).toBe(true);

    const process = await readYaml(join(fixture.root, ".tldrx/process.yml"));
    expect(process.methodology).toBe("none");
    expect((process.ticket_tool as Record<string, unknown>).kind).toBe("none");
    expect((process.source as Record<string, unknown>).run).toBe("init");
    expect((process.source as Record<string, unknown>).q).toBe("Q1");
    expect(process.approvers).not.toEqual([]);
  });

  test("appends one marked block to .gitignore and CLAUDE.md", async () => {
    const gitignore = await Bun.file(join(fixture.root, ".gitignore")).text();
    expect(gitignore).toContain(GITIGNORE_MARKERS.begin);
    expect(gitignore).toContain(".tldrx/graphify-out/");
    expect(gitignore).toContain("tldrx-work/*/.lock");
    expect(await Bun.file(join(fixture.root, "CLAUDE.md")).text()).toContain(".tldrx/workspace.yml");
  });

  test("re-running keeps everything a human may have touched", async () => {
    const before = await Bun.file(join(fixture.root, ".tldrx/process.yml")).text();
    await Bun.write(join(fixture.root, ".tldrx/process.yml"), `${before}# hand edited\n`);
    const gitignoreBefore = await Bun.file(join(fixture.root, ".gitignore")).text();

    const second = await init(fixture.root);

    expect(second.kept).toContain(".tldrx/process.yml");
    expect(second.kept).toContain(".tldrx/memory/facts.yml");
    expect(second.kept).toContain(".tldrx/init-questions.md");
    expect(second.kept).toContain(".tldrx/conventions/shared.md");
    expect(second.kept).toContain(".tldrx/experts/typescript-stack/expert.md");
    expect(second.created).toEqual([]);

    expect(await Bun.file(join(fixture.root, ".tldrx/process.yml")).text()).toContain("# hand edited");
    // The marked blocks are idempotent: a second run must not append a second copy.
    expect(await Bun.file(join(fixture.root, ".gitignore")).text()).toBe(gitignoreBefore);
    expect(second.written).toContain(".tldrx/workspace.yml");
  });
});

describe("tldrx init — options", () => {
  test("--no-interview writes no questions file and the handoff says so", async () => {
    const fixture = await singleRepoFixture();
    try {
      const report = await init(fixture.root, { interview: false });
      expect(report.questions).toEqual([]);
      expect(await Bun.file(join(fixture.root, ".tldrx/init-questions.md")).exists()).toBe(false);
      expect(await Bun.file(join(fixture.root, ".tldrx/init-handoff.md")).text())
        .toContain("No interview was written");
    } finally {
      await fixture.cleanup();
    }
  });

  test("--process records the methodology as measured, and stops asking about it", async () => {
    const fixture = await singleRepoFixture();
    try {
      const report = await init(fixture.root, { methodology: "kanban" });
      const document = await readYaml(join(fixture.root, ".tldrx/process.yml"));
      expect(document.methodology).toBe("kanban");
      expect((document.cadence as Record<string, unknown>).wip_limit).toBe(3);
      expect(report.questions.some((question) => question.area === "process")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("single-repo mode maps `self` as `.` and writes no workspace.md", async () => {
    const fixture = await singleRepoFixture();
    try {
      const report = await init(fixture.root);
      const document = await readYaml(join(fixture.root, ".tldrx/workspace.yml"));
      expect(document.mode).toBe("single-repo");
      expect((document.repos as Record<string, unknown>[])[0]?.path).toBe(".");
      expect(report.map.files.some((file) => file.endsWith("workspace.md"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a root with no git repo fails loudly instead of writing a workspace", async () => {
    const fixture = await emptyFixture();
    try {
      await expect(init(fixture.root)).rejects.toThrow(/no git repo/);
      expect(await Bun.file(join(fixture.root, ".tldrx/workspace.yml")).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("interview planning", () => {
  const repo = (name: string, confidence: "high" | "low", codeFiles = 3) => ({
    name, path: name, absPath: `/tmp/${name}`, defaultBranch: "main", stack: [], languages: [],
    packageManager: null, manifests: [], codeFiles,
    commands: { build: null, test: null, lint: null, typecheck: null, run: null },
    ci: [], confidence, evidence: [],
  });

  test("a low-confidence repo gets a commands question; a high-confidence one does not", () => {
    const questions = planQuestions({
      workspace: {
        mode: "multi-repo", rootIsRepo: true, root: "/tmp",
        repos: [repo("solid", "high"), repo("murky", "low")], evidence: [],
      },
      processGiven: true,
      mcpServers: [],
    });
    const commandQuestions = questions.filter((question) => question.area === "commands");
    expect(commandQuestions).toHaveLength(1);
    expect(commandQuestions[0]?.question).toContain("murky");
    expect(questions.some((question) => question.area === "process")).toBe(false);
  });

  test("a connected MCP server is offered as an option, never as a decision", () => {
    const questions = planQuestions({
      workspace: { mode: "single-repo", rootIsRepo: true, root: "/tmp", repos: [repo("solo", "high")], evidence: [] },
      processGiven: false,
      mcpServers: [{ name: "atlassian", transport: "http", status: "connected" }],
    });
    const ticket = questions.find((question) => question.question.includes("ticket tool"));
    expect(ticket?.options.some((option) => option.includes("MCP server connected"))).toBe(true);
    expect(renderQuestions(questions, "2026-08-28T12:00:00Z")).toContain("Why asked: an MCP server for jira");
  });
});

describe("expert planning", () => {
  const facts = (repo: string, domains: readonly string[]) => ({
    repo, provider: "static", domains,
    docs: { architecture: [], domains: [], conventions: [], commands: [], hotspots: [], gotchas: [] },
  });
  const workspace = {
    mode: "multi-repo" as const, rootIsRepo: true, root: "/tmp", evidence: [],
    repos: [] as never[],
  };

  test("the domain-expert cap is shared round-robin: one big repo cannot eat it", () => {
    const plans = planExperts(workspace, [
      facts("big", ["src/a", "src/b", "src/c", "src/d", "src/e", "src/f", "src/g", "src/h", "src/i"]),
      facts("small", ["src/z"]),
    ]);
    const names = plans.filter((plan) => plan.kind === "domain").map((plan) => plan.name);
    expect(names).toHaveLength(8);
    expect(names).toContain("z");
    expect(plans.filter((plan) => plan.repos[0] === "small")).toHaveLength(1);
  });
});

describe("competency levels (spec §2.6)", () => {
  const now = new Date("2026-08-28T00:00:00Z");
  const at = (daysAgo: number): string =>
    new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

  test("no evidence is level 0 — a seeded expert claims nothing", () => {
    expect(competencyLevel([], now)).toBe(0);
  });

  test("the distinct-source cap beats the weight sum", () => {
    const same = Array.from({ length: 6 }, () => ({ kind: "code" as const, src: "a:x.ts:1", at: at(1) }));
    expect(competencyLevel(same, now)).toBe(1);
  });

  test("weight and recency drive the level", () => {
    const fresh = [
      { kind: "code" as const, src: "a:x.ts:1", at: at(1) },
      { kind: "run" as const, src: "tldrx-work/260801-x/04-build/log/S1.md:4", at: at(1) },
      { kind: "answer" as const, src: "F001", at: at(1) },
    ];
    expect(competencyLevel(fresh, now)).toBe(2);
  });

  test("stale evidence is capped at 2 however much of it there is", () => {
    const stale = Array.from({ length: 20 }, (_, index) => ({
      kind: "code" as const, src: `a:x${index}.ts:1`, at: at(400),
    }));
    expect(competencyLevel(stale, now)).toBe(2);
  });
});

describe("marked blocks", () => {
  test("upsert replaces in place rather than appending a second block", () => {
    const first = upsertBlock("", "line-1", GITIGNORE_MARKERS);
    const second = upsertBlock(first, "line-2", GITIGNORE_MARKERS);
    expect(second.match(new RegExp(GITIGNORE_MARKERS.begin, "g"))).toHaveLength(1);
    expect(second).toContain("line-2");
    expect(second).not.toContain("line-1");
  });

  test("content outside the block is preserved", () => {
    const existing = "node_modules/\n";
    const updated = upsertBlock(existing, "x", GITIGNORE_MARKERS);
    expect(updated.startsWith("node_modules/\n")).toBe(true);
    expect(upsertBlock(updated, "x", GITIGNORE_MARKERS)).toBe(updated);
  });
});

describe("process.yml validation", () => {
  test("scrum without a sprint length is rejected", () => {
    const result = validateProcessDocument({
      version: 1, methodology: "scrum",
      cadence: { sprint_length_days: null, wip_limit: null, review_day: null },
      ticket_tool: { kind: "none", project: null, board: null, sync: "mirror-out" },
      story_granularity: "days", approvers: ["alan"], dod: { add: [], remove: [] },
      source: { who: "alan", when: "2026-08-28T12:00:00Z", run: "init", q: null },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toBe("cadence.sprint_length_days");
  });

  test("a ticket tool without a project key is rejected", () => {
    const result = validateProcessDocument({
      version: 1, methodology: "none",
      cadence: { sprint_length_days: null, wip_limit: null, review_day: null },
      ticket_tool: { kind: "jira", project: null, board: null, sync: "mirror-out" },
      story_granularity: "days", approvers: ["alan"], dod: { add: [], remove: [] },
      source: { who: "alan", when: "2026-08-28T12:00:00Z", run: "init", q: null },
    });
    expect(result.issues.map((issue) => issue.path)).toContain("ticket_tool.project");
  });
});

describe("the CLI end to end", () => {
  let fixture: Fixture;

  beforeAll(async () => { fixture = await multiRepoFixture(); });
  afterAll(async () => { await fixture.cleanup(); });

  async function tldrx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "bin", "tldrx.ts"), ...args], {
      cwd: FRAMEWORK_ROOT, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test("init exits 0, then map --check confirms every citation resolves", async () => {
    const initRun = await tldrx("init", "--root", fixture.root, "--no-interview", "--provider", "static");
    expect(initRun.code).toBe(0);
    expect(initRun.stdout).toContain("multi-repo, 2 repo(s)");

    const check = await tldrx("map", "--check", "--root", fixture.root);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("all resolve");
  });

  test("map --check exits 1 and names the dead citation once a cited file is gone", async () => {
    await rm(join(fixture.root, "lab", "src", "index.ts"));
    const check = await tldrx("map", "--check", "--root", fixture.root);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain("do not resolve");
    expect(check.stderr).toContain("lab:src/index.ts");
  });

  test("map --refresh rewrites the documents and reports the provider", async () => {
    const refresh = await tldrx("map", "--refresh", "--root", fixture.root, "--provider", "static");
    expect(refresh.code).toBe(0);
    expect(refresh.stdout).toContain("documents via static");
  });

  test("map without a mode, and init with an unknown flag, are usage errors", async () => {
    expect((await tldrx("map")).code).toBe(1);
    expect((await tldrx("init", "--nope")).code).toBe(1);
  });
});

// --- role experts ------------------------------------------------------------

/**
 * The gap wave I closed: the shipped stage files have always named `product`,
 * `architect`, `delivery`, `developer` and `operations`, and `init` seeded only
 * the first. Measured 2026-08-29 on `~/aparece-v2`, whose `.tldrx/experts/` held
 * `product`, `dotnet-stack` and seven domain experts: four of the five stage
 * names resolved to nothing on every run.
 */
describe("init seeds the role experts the stage files name", () => {
  let fixture: Fixture;

  beforeAll(async () => { fixture = await singleRepoFixture(); });
  afterAll(async () => { await fixture.cleanup(); });

  test("every name in a shipped stage's `experts:` has a folder after init", async () => {
    await init(fixture.root);
    const named = new Set<string>();
    for (const stage of stageIds(fixture.root)) {
      const path = join(FRAMEWORK_ROOT, "stages", stage, "stage.yml");
      const doc = parseYaml(readFileSync(path, "utf8")) as { experts?: unknown };
      for (const name of (doc.experts as string[] | undefined) ?? []) named.add(name);
    }
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect(existsSync(join(fixture.root, ".tldrx/experts", name, "expert.md"))).toBe(true);
    }
  });

  test("`expert list` says which stage loads each role, by name", async () => {
    await init(fixture.root);
    const loads = stagesLoadingExperts(fixture.root);
    expect(describeStageLoads(loads.get("product"))).toBe("loaded by: what (named)");
    expect(describeStageLoads(loads.get("architect"))).toBe("loaded by: how (named), plan (named)");
    expect(describeStageLoads(loads.get("delivery"))).toBe("loaded by: plan (named)");
    expect(describeStageLoads(loads.get("developer"))).toBe("loaded by: build (named)");
    expect(describeStageLoads(loads.get("operations"))).toBe("loaded by: watch (named)");
  });

  test("a role expert is `kind: role`, has one area at level 0, and an empty knowledge/", async () => {
    await init(fixture.root);
    const dir = join(fixture.root, ".tldrx/experts/architect");
    const body = readFileSync(join(dir, "expert.md"), "utf8");
    expect(body).toContain("kind: role");
    expect(body).toContain("# architect");
    // The body is the SHIPPED prose, not a generated stub — it is what a team edits.
    expect(body).toContain("templates/experts/architect.md");
    expect(body).toContain("## Role");

    const competencies = await readYaml(join(dir, "competencies.yml"));
    const areas = competencies.areas as Record<string, unknown>[];
    expect(areas.map((area) => area.id)).toEqual(["architect"]);
    expect(areas[0]?.level).toBe(0);
    expect(areas[0]?.evidence).toEqual([]);
    // `--mode full`, because light mode is refused for a role expert: a
    // copy-pasteable command that exits 1 is worse than no command.
    expect(areas[0]?.train_prompt).toBe("tldrx expert train architect --area architect --mode full");
    expect(existsSync(join(dir, "knowledge"))).toBe(true);
  });

  test("re-running init adds a missing role and never overwrites an existing expert", async () => {
    await init(fixture.root);
    const dir = join(fixture.root, ".tldrx/experts");
    // A workspace seeded before wave I: only `product`, and a team has edited it.
    await rm(join(dir, "architect"), { recursive: true, force: true });
    await rm(join(dir, "delivery"), { recursive: true, force: true });
    const productPath = join(dir, "product", "expert.md");
    const edited = `${readFileSync(productPath, "utf8")}\n## Our own section\n\n- hand written\n`;
    writeFileSync(productPath, edited, "utf8");

    const report = await init(fixture.root);
    expect(existsSync(join(dir, "architect", "expert.md"))).toBe(true);
    expect(existsSync(join(dir, "delivery", "expert.md"))).toBe(true);
    expect(readFileSync(productPath, "utf8")).toBe(edited);
    expect(report.created).toContain(".tldrx/experts/architect/expert.md");
    expect(report.kept).toContain(".tldrx/experts/product/expert.md");
  });
});
