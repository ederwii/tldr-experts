/**
 * Greenfield: a workspace with no code, and the document that stands in for it.
 *
 * Measured gap, 2026-08-29, on a temp repo holding only `requirements.md`:
 * `tldrx init --no-interview` seeded ZERO experts, and `run new` had no way to be
 * handed the document — `--from` takes an AI-DLC intent folder, and the What
 * stage's `## Inputs` inlined only `facts.yml`, so the stage would have ideated
 * from nothing. Everything below is that gap, closed and pinned.
 *
 * Every test runs the real commands against a real git repo in a temp dir. The
 * facilitator is only ever driven in `--prepare` mode, which spawns nothing and
 * costs nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInit, type InitOptions, type InitReport } from "../src/core/init/index.ts";
import { parseStackFlag, normaliseStack } from "../src/core/init/stackChoices.ts";
import { isGreenfield, workspaceMode, countCodeFiles, SpawnCommandRunner } from "../src/core/detect/index.ts";
import { createRun, NewRunError } from "../src/core/run/newRun.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { collectSeed, SeedError, MAX_SEED_BYTES } from "../src/core/seed/collectSeed.ts";
import { seedClaims, allSeedHeadings } from "../src/core/seed/seedClaims.ts";
import { uncoveredSections } from "../src/core/seed/seedCoverage.ts";
import { inlineInputs } from "../src/core/facilitator/seedInputs.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { greenfieldFixture, REQUIREMENTS_MD, type Fixture } from "./init-fixture.ts";

const runner = new SpawnCommandRunner();
const NOW = new Date("2026-08-29T12:00:00Z");

let open: Fixture[] = [];

afterEach(async () => {
  for (const fixture of open) await fixture.cleanup();
  open = [];
});

async function greenfield(files?: Readonly<Record<string, string>>): Promise<Fixture> {
  const fixture = await greenfieldFixture(files);
  open.push(fixture);
  return fixture;
}

function options(root: string, overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    root, out: root, interview: true, methodology: null, mcp: false, stack: [], provider: "static", ...overrides,
  };
}

async function init(root: string, overrides: Partial<InitOptions> = {}): Promise<InitReport> {
  return runInit(options(root, overrides), { runner, cliVersion: "0.1.0", now: NOW });
}

function readYaml(path: string): Record<string, unknown> {
  const parsed = parseYaml(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path} is not a mapping`);
  return parsed as Record<string, unknown>;
}

function seedRun(root: string, seed: string, slug = "loyalty") {
  return createRun({ root, slug, scope: "feature", budgetUsd: 5, seed, actor: "alan", now: NOW });
}

describe("tldrx init — greenfield workspace", () => {
  test("records mode: greenfield and says so in the map instead of pretending", async () => {
    const fixture = await greenfield();
    const report = await init(fixture.root);

    expect(report.greenfield).toBe(true);
    expect(await countCodeFiles(fixture.root)).toBe(0);
    expect(isGreenfield(report.workspace)).toBe(true);
    expect(workspaceMode(report.workspace)).toBe("greenfield");

    const document = readYaml(join(fixture.root, ".tldrx/workspace.yml"));
    expect(document.mode).toBe("greenfield");
    expect(document.root_is_repo).toBe(true);

    const repo = report.workspace.repos[0]?.name ?? "";
    const architecture = readFileSync(join(fixture.root, ".tldrx/map", repo, "architecture.md"), "utf8");
    expect(architecture).toContain("Greenfield: no code file of any known extension exists");
    expect(architecture).toContain("[src: absent:.]");
  });

  test("a repo with one source file is NOT greenfield", async () => {
    const fixture = await greenfield({ "requirements.md": REQUIREMENTS_MD, "src/index.ts": "export const x = 1;\n" });
    const report = await init(fixture.root);

    expect(report.greenfield).toBe(false);
    expect(readYaml(join(fixture.root, ".tldrx/workspace.yml")).mode).toBe("single-repo");
  });

  test("seeds a product expert even with nothing to detect, and stack experts from --stack", async () => {
    const fixture = await greenfield();
    const report = await init(fixture.root, { stack: ["typescript", "dotnet"] });

    expect(report.experts.map((expert) => expert.name)).toEqual(["product", "typescript-stack", "dotnet-stack"]);
    expect(report.experts[0]?.kind).toBe("product");

    const product = readFileSync(join(fixture.root, ".tldrx/experts/product/expert.md"), "utf8");
    expect(product).toContain("kind: product");
    expect(product).toContain("the product itself");

    const competencies = readYaml(join(fixture.root, ".tldrx/experts/typescript-stack/competencies.yml"));
    expect((competencies.areas as { id: string; level: number }[])[0]).toMatchObject({ id: "typescript", level: 0 });
  });

  test("without --stack the product expert is still seeded, alone", async () => {
    const fixture = await greenfield();
    const report = await init(fixture.root);
    expect(report.experts.map((expert) => expert.name)).toEqual(["product"]);
  });

  test("the interview asks for the stack and the requirements document", async () => {
    const fixture = await greenfield();
    const report = await init(fixture.root);
    const asked = report.questions.map((question) => question.question);

    expect(asked).toContain("Which stack will this project use?");
    expect(asked).toContain("Which single document is the source of requirements?");

    const text = readFileSync(join(fixture.root, ".tldrx/init-questions.md"), "utf8");
    expect(text).toContain("## Q1 · Which stack will this project use?");
    expect(text).toContain("- A) TypeScript / Node");
    expect(text).toContain("- E) other — write it below");
    expect(text).toContain("tldrx run new <slug> --seed <path>");
    // Every question's `Why asked:` line proves the gap (spec §2.7).
    for (const question of report.questions) expect(question.whySrc).not.toBe("");
  });

  test("--stack answers the stack question, so it is not asked", async () => {
    const fixture = await greenfield();
    const report = await init(fixture.root, { stack: ["go"] });
    expect(report.questions.map((question) => question.question))
      .not.toContain("Which stack will this project use?");
    expect(report.experts.map((expert) => expert.name)).toEqual(["product", "go-stack"]);
  });

  test("a repo WITH code asks neither greenfield question", async () => {
    const fixture = await greenfield({ "src/main.go": "package main\n" });
    const report = await init(fixture.root);
    const asked = report.questions.map((question) => question.question);
    expect(asked).not.toContain("Which stack will this project use?");
    expect(asked).not.toContain("Which single document is the source of requirements?");
  });
});

describe("--stack parsing", () => {
  test("normalises the spellings people type", () => {
    expect(parseStackFlag("ts,dotnet,python,go,rust")).toEqual(["typescript", "dotnet", "python", "go", "rust"]);
    expect(parseStackFlag("TS, C#, py")).toEqual(["typescript", "dotnet", "python"]);
    expect(parseStackFlag("ts,ts,typescript")).toEqual(["typescript"]);
    expect(parseStackFlag(",, ,")).toEqual([]);
  });

  test("an unknown language is kept, not rejected — the fixed list is what we OFFER", () => {
    expect(normaliseStack("elixir")).toBe("elixir");
    expect(normaliseStack(".NET")).toBe("dotnet");
  });
});

describe("tldrx run new --seed <file>", () => {
  test("distils the document into Findings that cite it by line", async () => {
    const fixture = await greenfield();
    await init(fixture.root);
    const outcome = seedRun(fixture.root, "requirements.md");

    expect(outcome.seed?.documents.map((document) => document.rel)).toEqual(["requirements.md"]);
    expect(outcome.files).toContain("01-what/seed-index.md");
    expect(outcome.files).toContain("01-what/handoff.md");

    const handoff = readFileSync(join(outcome.runDir, "01-what/handoff.md"), "utf8");
    expect(handoff).toContain("- Points are awarded when a hunt is completed. [src: requirements.md:7]");
    expect(handoff).toContain("- Players should earn points for completing hunts and see where they rank. [src: requirements.md:4]");
    // Every Findings bullet cites the seed by path:line.
    const findings = handoff.split("## Decisions")[0] ?? "";
    for (const line of findings.split("\n").filter((entry) => entry.startsWith("- "))) {
      expect(line).toMatch(/\[src: requirements\.md:\d+\]$/);
    }

    // Unknowns are the What outputs no seed heading covers — deterministic.
    expect(handoff).toContain("[src: absent:01-what/success-metrics.md]");
    expect(handoff).toContain("[src: absent:01-what/open-questions.md]");
    expect(handoff).not.toContain("absent:01-what/intent.md");

    const index = readFileSync(join(outcome.runDir, "01-what/seed-index.md"), "utf8");
    expect(index).toContain("| 1 | `requirements.md` |");
    expect(index).toContain("The documents are NOT copied");
    // The original stays where it was.
    expect(readFileSync(join(fixture.root, "requirements.md"), "utf8")).toBe(REQUIREMENTS_MD);
  });

  test("the seed lands in the What stage's declared inputs in run.yml", async () => {
    const fixture = await greenfield();
    await init(fixture.root);
    const outcome = seedRun(fixture.root, "requirements.md");

    const stage = RunStore.open(outcome.runDir).run.phases[0]?.stages[0];
    expect(stage?.id).toBe("what");
    expect(stage?.inputs).toContain("01-what/seed-index.md");
    expect(stage?.inputs).toContain("requirements.md");
    expect(stage?.inputs).toContain(".tldrx/memory/facts.yml");
  });

  test("`next --prepare` inlines the requirements text into the prompt (no spawn, no spend)", async () => {
    const fixture = await greenfield();
    await init(fixture.root);
    const outcome = seedRun(fixture.root, "requirements.md");

    const prepared = await runNext({
      root: fixture.root,
      dryRun: false,
      mode: "prepare",
      yolo: false,
      actor: "alan",
      at: "2026-08-29T12:00:00Z",
    });
    expect(prepared.code).toBe(0);

    const prompt = readFileSync(join(outcome.runDir, ".agent/what/prompt.md"), "utf8");
    const inputs = prompt.split("## Inputs")[1] ?? "";
    expect(inputs).toContain("### `requirements.md`");
    expect(inputs).toContain("A leaderboard shows the top 50 players for the current month.");
    expect(inputs).toContain("### `01-what/seed-index.md`");
    // The product expert exists now, so the stage is not handed an empty role.
    expect(prompt).toContain("<!-- expert: product -->");
  });

  test("refuses a PDF, and refuses --from and --seed together", async () => {
    const fixture = await greenfield({ "requirements.md": REQUIREMENTS_MD, "brief.pdf": "%PDF-1.4\n" });
    await init(fixture.root);

    expect(() => seedRun(fixture.root, "brief.pdf")).toThrow(SeedError);
    try {
      seedRun(fixture.root, "brief.pdf");
    } catch (error) {
      expect((error as Error).message).toContain("PDFs and Word documents are out of scope");
    }
    expect(() => createRun({
      root: fixture.root, slug: "both", scope: "feature", budgetUsd: 5,
      seed: "requirements.md", from: fixture.root, actor: "alan", now: NOW,
    })).toThrow(NewRunError);
  });
});

describe("tldrx run new --seed <dir>", () => {
  test("reads every .md/.txt in the directory, sorted, and cites each by its own path", async () => {
    const fixture = await greenfield({
      "docs/01-vision.md": "# Vision\n\nOne place to see who is winning.\n",
      "docs/02-constraints.txt": "# Constraints\n\nNo new database.\n",
      "docs/logo.png": "not a document",
    });
    await init(fixture.root);
    const outcome = seedRun(fixture.root, "docs");

    expect(outcome.seed?.documents.map((document) => document.rel))
      .toEqual(["docs/01-vision.md", "docs/02-constraints.txt"]);

    const handoff = readFileSync(join(outcome.runDir, "01-what/handoff.md"), "utf8");
    expect(handoff).toContain("[src: docs/01-vision.md:3]");
    expect(handoff).toContain("[src: docs/02-constraints.txt:3]");

    const stage = RunStore.open(outcome.runDir).run.phases[0]?.stages[0];
    expect(stage?.inputs).toContain("docs/01-vision.md");
    expect(stage?.inputs).toContain("docs/02-constraints.txt");
  });

  test("an oversize document is skipped with a warning, not silently dropped", async () => {
    const fixture = await greenfield({ "docs/small.md": "# Small\n\nA sentence.\n" });
    const big = join(fixture.root, "docs", "huge.md");
    mkdirSync(join(fixture.root, "docs"), { recursive: true });
    writeFileSync(big, `# Huge\n\n${"x".repeat(MAX_SEED_BYTES + 1)}\n`, "utf8");
    await init(fixture.root);

    const seed = collectSeed(fixture.root, "docs");
    expect(seed.documents.map((document) => document.rel)).toEqual(["docs/small.md"]);
    expect(seed.skipped.map((entry) => entry.rel)).toEqual(["docs/huge.md"]);
    expect(seed.warnings.join("\n")).toContain("skipped docs/huge.md");
    expect(seed.warnings.join("\n")).toContain(`larger than ${MAX_SEED_BYTES} bytes`);

    const outcome = seedRun(fixture.root, "docs");
    const index = readFileSync(join(outcome.runDir, "01-what/seed-index.md"), "utf8");
    expect(index).toContain("## Skipped");
    expect(index).toContain("docs/huge.md");
    const handoff = readFileSync(join(outcome.runDir, "01-what/handoff.md"), "utf8");
    expect(handoff).toContain("- Skipped `docs/huge.md`");
  });

  test("a directory with no readable document is an error that names why", async () => {
    const fixture = await greenfield({ "docs/logo.png": "x", "docs/brief.pdf": "%PDF" });
    await init(fixture.root);
    try {
      collectSeed(fixture.root, "docs");
      throw new Error("expected a SeedError");
    } catch (error) {
      expect(error).toBeInstanceOf(SeedError);
      expect((error as Error).message).toContain("holds no .md or .txt document");
      expect((error as Error).message).toContain("out of scope");
    }
  });
});

describe("seed distillation rules", () => {
  const doc = (rel: string, text: string) => ({
    rel, abs: `/tmp/${rel}`, bytes: text.length, lines: text.split("\n").length, text,
  });

  test("prose before the first heading is kept, attributed to the file", () => {
    const claims = seedClaims([doc("brief.txt", "We need a leaderboard.\n\n## Scope\n- Top 50 only.\n")]);
    expect(claims.map((claim) => claim.src)).toEqual(["brief.txt:1", "brief.txt:4"]);
    expect(claims[0]?.heading).toBe("brief.txt");
  });

  test("an empty section is reported; a title above another heading is not", () => {
    const claims = seedClaims([doc("r.md", "# Title\n\n## Open questions\n\n## Scope\n- One.\n")]);
    const texts = claims.map((claim) => claim.text);
    expect(texts).toContain('Section "Open questions" is declared in the seed with no content under it');
    expect(texts.some((text) => text.includes('"Title"'))).toBe(false);
  });

  test("uncovered sections are decided by heading, not by prose", () => {
    const headings = allSeedHeadings([doc("r.md", "# R\n\n## Purpose\ntext\n\n## Out of scope\ntext\n")]);
    expect(uncoveredSections(headings).map((section) => section.output))
      .toEqual(["success-metrics.md", "open-questions.md"]);

    const complete = allSeedHeadings([doc("r.md",
      "# R\n\n## Purpose\na\n\n## Scope\nb\n\n## Success metrics\nc\n\n## Open questions\nd\n")]);
    expect(uncoveredSections(complete)).toEqual([]);
  });
});

describe("the seed inline budget", () => {
  const ctx = { root: "/nowhere", runDir: "/nowhere/run" };

  test("under budget, nothing is marked", () => {
    const result = inlineInputs([], { ctx, seed: new Set() });
    expect(result.inputs).toEqual([]);
    expect(result.note).toBeNull();
  });

  test("over budget, the prompt says what was cut instead of pretending it is whole", async () => {
    const fixture = await greenfield({
      "a.md": `# A\n\n${"a".repeat(6000)}\n`,
      "b.md": `# B\n\n${"b".repeat(6000)}\n`,
    });
    const result = inlineInputs(["a.md", "b.md"], {
      ctx: { root: fixture.root, runDir: join(fixture.root, "tldrx-work", "x") },
      seed: new Set(["a.md", "b.md"]),
      budgetBytes: 9000,
    });
    // `# A\n\n` + 6000 + `\n` = 6006 bytes: the first document fits whole…
    expect(result.inputs[0]?.content.length).toBe(6006);
    expect(result.inputs[0]?.totalBytes).toBeUndefined();
    // …and the second gets the 2994 bytes that were left, labelled as a prefix.
    expect(result.inputs[1]?.inlinedBytes).toBe(2994);
    expect(result.inputs[1]?.totalBytes).toBe(6006);
    expect(result.note).toContain("larger than the 9000-byte inline budget");
    expect(result.note).toContain("inlined only as far as the budget reached");
  });
});
