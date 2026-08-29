import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { competencyLevel, type CompetencyEvidence, type EvidenceKind } from "../src/core/init/competencyLevel.ts";
import {
  createExpert, driftWarnings, evidenceNote, loadExpert, loadExperts, readExpertDocument,
  renderExpertList, renderTrainPrompt, stars, starChartLine,
} from "../src/core/experts/index.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_FAILED, EXIT_NOT_IMPLEMENTED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeViewsWorkspace, VIEWS_FIXTURE, VIEWS_NOW } from "./fixtures/views/tempViews.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const NOW = new Date("2026-09-01T00:00:00Z");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd: FRAMEWORK_ROOT });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function evidence(kind: EvidenceKind, count: number, days: number, sameSrc = false): CompetencyEvidence[] {
  return Array.from({ length: count }, (_unused, i) => ({
    kind,
    src: sameSrc ? "api:src/A.cs:1" : `api:src/A.cs:${i + 1}`,
    at: daysAgo(days),
  }));
}

describe("the §2.6 level formula", () => {
  test("no evidence is level 0 — an untrained expert says so", () => {
    expect(competencyLevel([], NOW)).toBe(0);
  });

  // W thresholds: 0 if W<0.5 · 1 if <1.5 · 2 if <3 · 3 if <6 · 4 if <12 · else 5.
  const table: readonly { readonly why: string; readonly items: CompetencyEvidence[]; readonly level: number }[] = [
    { why: "one fresh doc, W=0.5", items: evidence("doc", 1, 0), level: 1 },
    { why: "one fresh code, W=1.0", items: evidence("code", 1, 0), level: 1 },
    { why: "two fresh code, W=2.0", items: evidence("code", 2, 0), level: 2 },
    { why: "four fresh code, W=4.0", items: evidence("code", 4, 0), level: 3 },
    { why: "six fresh code, W=6.0", items: evidence("code", 6, 0), level: 4 },
    { why: "twelve fresh code, W=12.0", items: evidence("code", 12, 0), level: 5 },
    { why: "recency band 31-90d halves and more (0.6)", items: evidence("code", 2, 31), level: 1 },
    { why: "recency band 91-365d (0.3): W=0.3 is below the first threshold", items: evidence("code", 1, 91), level: 0 },
    { why: "answer weight 0.8: two fresh answers, W=1.6", items: evidence("answer", 2, 0), level: 2 },
  ];

  for (const row of table) {
    test(`${row.why} -> level ${row.level}`, () => {
      expect(competencyLevel(row.items, NOW)).toBe(row.level);
    });
  }

  test("staleness cap: newest evidence older than 180d caps the level at 2", () => {
    // 40 code items would be W=4.0 at 0.1 recency -> level 3 without the cap.
    expect(competencyLevel(evidence("code", 40, 400), NOW)).toBe(2);
    // And a W big enough for level 5 is still capped.
    expect(competencyLevel(evidence("code", 200, 400), NOW)).toBe(2);
    // 180 days exactly is NOT stale.
    expect(competencyLevel(evidence("code", 40, 180), NOW)).toBe(5);
  });

  test("distinct-source cap: ten citations of one line are worth one source", () => {
    expect(competencyLevel(evidence("code", 10, 0, true), NOW)).toBe(1);
    expect(competencyLevel(evidence("code", 10, 0, false), NOW)).toBe(4);
  });
});

describe("expert list", () => {
  test("levels are recomputed, never taken from the file", () => {
    const experts = loadExperts(VIEWS_FIXTURE, VIEWS_NOW);
    expect(experts.map((expert) => expert.name)).toEqual(["dotnet-stack", "lab-ui"]);

    const dotnet = experts[0]!;
    const efCore = dotnet.areas.find((area) => area.id === "ef-core")!;
    expect(efCore.storedLevel).toBe(2);
    expect(efCore.level).toBe(2);

    const soap = dotnet.areas.find((area) => area.id === "legacy-soap")!;
    expect(soap.evidence).toHaveLength(4);
    expect(soap.level).toBe(0);
    expect(soap.newestEvidence).toBe("2024-03-10");
  });

  test("warns when the stored level disagrees with the evidence", () => {
    const labUi = loadExpert(VIEWS_FIXTURE, "lab-ui", VIEWS_NOW);
    expect(labUi.areas[0]!.storedLevel).toBe(5);
    expect(labUi.areas[0]!.level).toBe(1);

    const warnings = driftWarnings(labUi);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("lab-ui/scoreboard-ui");
    expect(warnings[0]).toContain("stores level 5");
    expect(warnings[0]).toContain("evidence computes 1");
  });

  test("the star chart line carries the level, the count and the newest date", () => {
    const efCore = loadExpert(VIEWS_FIXTURE, "dotnet-stack", VIEWS_NOW).areas[0]!;
    expect(starChartLine(efCore, 11)).toBe("ef-core      ★★☆☆☆ 2  (4 evidence, newest 2026-08-20)");
    expect(stars(0)).toBe("☆☆☆☆☆");
    expect(stars(5)).toBe("★★★★★");
    expect(evidenceNote({ ...efCore, evidence: [], newestEvidence: null })).toBe("(no evidence)");
  });

  test("renders a table, a chart per expert, and the warnings", () => {
    const text = renderExpertList(loadExperts(VIEWS_FIXTURE, VIEWS_NOW));
    expect(text).toContain("expert");
    expect(text).toContain("last_trained");
    expect(text).toContain("dotnet-stack");
    expect(text).toContain("lab-ui");
    expect(text).toContain("★");
    expect(text).toContain("warning:");
  });

  test("`tldrx expert list --json` exits 0 and reports the drift as data", async () => {
    const run = await tldrx("expert", "list", "--root", VIEWS_FIXTURE, "--json");
    expect(run.code).toBe(EXIT_OK);
    const parsed = JSON.parse(run.stdout) as {
      name: string;
      areas: { id: string; level: number; stored_level: number; level_matches_evidence: boolean }[];
    }[];
    const labUi = parsed.find((expert) => expert.name === "lab-ui")!;
    expect(labUi.areas[0]!.stored_level).toBe(5);
    expect(labUi.areas[0]!.level_matches_evidence).toBe(false);
  });

  test("an empty workspace says so instead of printing an empty table", () => {
    expect(renderExpertList([])).toContain("No experts yet");
  });
});

describe("expert create", () => {
  test("writes both files, with zero areas by default", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const created = await createExpert({
        root: workspace.root, name: "payments", createdAt: "2026-09-02T10:00:00Z",
      });
      expect(created.areas).toEqual([]);
      const doc = parseYaml(readFileSync(join(created.dir, "competencies.yml"), "utf8")) as {
        version: number; expert: string; status: string; areas: unknown[];
      };
      expect(doc.version).toBe(1);
      expect(doc.expert).toBe("payments");
      expect(doc.status).toBe("created");
      expect(doc.areas).toEqual([]);

      const markdown = readFileSync(join(created.dir, "expert.md"), "utf8");
      expect(markdown).toContain("name: payments");
      expect(markdown).toContain("# payments");
      expect(markdown).toContain('created_by: "tldrx expert create"');
    } finally {
      workspace.dispose();
    }
  });

  test("--domain and --stack each add one area, at level 0 with no evidence", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const created = await createExpert({
        root: workspace.root, name: "checkout", domain: "billing", stack: "typescript",
        createdAt: "2026-09-02T10:00:00Z",
      });
      expect(created.areas).toEqual(["typescript", "billing"]);
      const expert = loadExpert(workspace.root, "checkout", VIEWS_NOW);
      expect(expert.areas.map((area) => area.level)).toEqual([0, 0]);
      expect(expert.areas.map((area) => area.evidence.length)).toEqual([0, 0]);
      expect(expert.areas[0]!.trainPrompt).toBe("tldrx expert train checkout --area typescript --mode light");
    } finally {
      workspace.dispose();
    }
  });

  test("refuses to overwrite an existing expert (exit 1), leaving it untouched", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const path = join(workspace.root, ".tldrx", "experts", "lab-ui", "competencies.yml");
      const before = readFileSync(path, "utf8");

      const run = await tldrx("expert", "create", "lab-ui", "--root", workspace.root);
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.stderr).toContain("already exists");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      workspace.dispose();
    }
  });

  test("rejects a name that is not a slug", async () => {
    const workspace = makeViewsWorkspace();
    try {
      const run = await tldrx("expert", "create", "Not A Slug", "--root", workspace.root);
      expect(run.code).toBe(EXIT_FAILED);
      expect(existsSync(join(workspace.root, ".tldrx", "experts", "Not A Slug"))).toBe(false);
    } finally {
      workspace.dispose();
    }
  });
});

describe("expert train --print-prompt", () => {
  test("the prompt is deterministic and names the expert, area, mode and repos", () => {
    const expert = loadExpert(VIEWS_FIXTURE, "dotnet-stack", VIEWS_NOW);
    const input = {
      expert,
      document: readExpertDocument(VIEWS_FIXTURE, "dotnet-stack"),
      area: expert.areas[0]!,
      mode: "light" as const,
      repos: [{ name: "api", path: "api" }, { name: "lab", path: "lab" }],
    };
    const prompt = renderTrainPrompt(input);

    expect(prompt).toBe(renderTrainPrompt(input));
    expect(prompt).toContain("# Train `dotnet-stack` — area `ef-core` (light mode)");
    expect(prompt).toContain("Level now: ★★☆☆☆ 2/5 (4 evidence, newest 2026-08-20)");
    expect(prompt).toContain("- `api` at `api`");
    expect(prompt).toContain("- `lab` at `lab`");
    expect(prompt).toContain(".tldrx/experts/dotnet-stack/knowledge/ef-core.md");
    expect(prompt).toContain("Speaks for the dotnet stack across api.");
    expect(prompt).not.toContain("Mine past runs");
  });

  test("full mode adds the run-mining steps", () => {
    const expert = loadExpert(VIEWS_FIXTURE, "dotnet-stack", VIEWS_NOW);
    const prompt = renderTrainPrompt({
      expert,
      document: readExpertDocument(VIEWS_FIXTURE, "dotnet-stack"),
      area: expert.areas[1]!,
      mode: "full",
      repos: [],
    });
    expect(prompt).toContain("Mine past runs");
    expect(prompt).toContain("none declared in `.tldrx/workspace.yml`");
  });

  test("the CLI prints it and exits 0", async () => {
    const run = await tldrx(
      "expert", "train", "dotnet-stack", "--area", "ef-core", "--mode", "light",
      "--print-prompt", "--root", VIEWS_FIXTURE,
    );
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("# Train `dotnet-stack` — area `ef-core` (light mode)");
  });

  test("without --print-prompt it stays a stub and says v1.1", async () => {
    const run = await tldrx("expert", "train", "dotnet-stack", "--area", "ef-core", "--root", VIEWS_FIXTURE);
    expect(run.code).toBe(EXIT_NOT_IMPLEMENTED);
    expect(run.stderr).toContain("v1.1");
    expect(run.stdout).toBe("");
  });

  test("an unknown area is an error that lists the known ones", async () => {
    const run = await tldrx(
      "expert", "train", "dotnet-stack", "--area", "nope", "--print-prompt", "--root", VIEWS_FIXTURE,
    );
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.stderr).toContain("ef-core");
  });
});
