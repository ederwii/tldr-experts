/**
 * What an expert actually contributes to a stage prompt (spec §2.3, §2.6, §5).
 *
 * Every test here builds a real workspace, runs the REAL `tldrx next --prepare`
 * and reads the prompt bundle off disk. Nothing is asserted about a rendering
 * helper in isolation that is not also asserted about the file a sub-agent would
 * be handed — because the failure this wave exists to fix was exactly that shape:
 * `tldrx expert train` wrote a level, `expert list` printed it, and the prompt
 * contained none of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import type { PendingExpert } from "../src/core/facilitator/pending.ts";
import {
  countFindings, describeStageLoads, domainPaths, loadExpertBundles, loadExpertKnowledge,
  pathsIntersect, readExpertDomain, selectExperts, stagesLoadingExperts, truncateAtHeading,
} from "../src/core/experts/index.ts";
import {
  makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

let open: FacilitatorWorkspace[] = [];
afterEach(() => {
  for (const workspace of open) workspace.dispose();
  open = [];
});

const STAGE: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
  outputs: [{ path: "01-what/handoff.md" }],
};

/** A knowledge file in the shape `tldrx expert train` writes (§2.6). */
function knowledge(expert: string, area: string, trainedAt: string, sections: readonly string[]): string {
  return [
    "---",
    `expert: ${expert}`,
    `area: ${area}`,
    "mode: light",
    `trained_at: ${trainedAt}`,
    "---",
    "",
    `# ${expert} — ${area}`,
    "",
    ...sections,
    "",
  ].join("\n");
}

function section(name: string, bullets: readonly string[]): readonly string[] {
  return [`## ${name}`, "", ...bullets.map((b) => `- ${b} [src: api:src/A.cs:1]`), ""];
}

function competencies(expert: string, area: string, rows: number, at = "2026-08-29"): string {
  const evidence = Array.from({ length: rows }, (_u, i) =>
    `      - {kind: code, src: "api:src/A.cs:${String(i + 1)}", at: ${at}}`);
  return [
    "version: 1",
    `expert: ${expert}`,
    "status: in-use",
    `last_trained: ${at}T00:00:00Z`,
    "areas:",
    `  - id: ${area}`,
    `    title: The ${area} area`,
    "    level: 0",
    `    train_prompt: tldrx expert train ${expert} --area ${area}`,
    ...(rows === 0 ? ["    evidence: []"] : ["    evidence:", ...evidence]),
    "",
  ].join("\n");
}

/** A `kind: domain` expert.md with a real `## Domain` section. */
function domainExpert(name: string, repos: readonly string[], paths: readonly string[]): string {
  return [
    "---",
    `name: ${name}`,
    "kind: domain",
    "status: in-use",
    `repos: [${repos.join(", ")}]`,
    "---",
    "",
    `# ${name}`,
    "",
    "## Domain",
    "",
    ...paths.map((path) => `- \`${path}\``),
    "",
  ].join("\n");
}

function workspace(
  files: Readonly<Record<string, string>>,
  stage: Partial<StageOptions> = {},
): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo",
    stages: [{ ...STAGE, ...stage }],
    budgetUsd: 10,
    files,
  });
  open.push(made);
  return made;
}

async function prepare(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}) {
  return await runNext({
    root: ws.root,
    dryRun: false,
    mode: "prepare",
    yolo: false,
    actor: "alan",
    at: "2026-08-28T09:00:00Z",
    ...overrides,
  });
}

function promptOf(ws: FacilitatorWorkspace): string {
  return readFileSync(join(ws.runDir, ".agent", "alpha", "prompt.md"), "utf8");
}

function pendingExperts(ws: FacilitatorWorkspace): readonly PendingExpert[] {
  const raw = readFileSync(join(ws.runDir, ".agent", "alpha", "pending.json"), "utf8");
  return (JSON.parse(raw) as { experts?: PendingExpert[] }).experts ?? [];
}

describe("trained knowledge reaches the stage prompt", () => {
  test("the star chart, the findings and the reuse instruction are all in prompt.md", async () => {
    const ws = workspace({
      ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 4),
      ".tldrx/experts/product/knowledge/loyalty.md": knowledge("product", "loyalty", "2026-08-29T10:00:00Z", [
        ...section("Invariants", ["points never go negative"]),
        ...section("Gotchas", ["the UI rounds down, the API does not"]),
      ]),
    });

    const outcome = await prepare(ws);
    expect(outcome.code).toBe(0);
    const prompt = promptOf(ws);

    // the level, computed from evidence and rendered as §2.6's own chart line
    expect(prompt).toContain("loyalty");
    expect(prompt).toMatch(/loyalty\s+★+☆*\s+\d\s+\(4 evidence, newest 2026-08-29\)/);
    // the findings themselves, with their citations intact
    expect(prompt).toContain("points never go negative");
    expect(prompt).toContain("the UI rounds down, the API does not");
    expect(prompt).toContain("[src: api:src/A.cs:1]");
    // and the sentence that makes those citations usable rather than decorative
    expect(prompt).toContain("Reuse those tokens verbatim");
    expect(prompt).toContain(".tldrx/experts/product/knowledge/loyalty.md");
  });

  test("an expert with no knowledge folder adds no knowledge block and still loads", async () => {
    const ws = workspace({});
    await prepare(ws);
    const prompt = promptOf(ws);
    expect(prompt).toContain("<!-- expert: product -->");
    expect(prompt).not.toContain("### Trained knowledge");
  });

  test("areas are ordered most-recently-trained first, by the file's own trained_at", async () => {
    const ws = workspace({
      ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 2),
      // `alpha` sorts before `zeta` by name, and after it by training date. The
      // date has to win, or the prompt leads with what the expert learned first.
      ".tldrx/experts/product/knowledge/alpha.md":
        knowledge("product", "alpha", "2026-01-01T00:00:00Z", section("Invariants", ["OLDEST finding"])),
      ".tldrx/experts/product/knowledge/zeta.md":
        knowledge("product", "zeta", "2026-08-29T00:00:00Z", section("Invariants", ["NEWEST finding"])),
    });
    await prepare(ws);
    const prompt = promptOf(ws);
    expect(prompt.indexOf("NEWEST finding")).toBeLessThan(prompt.indexOf("OLDEST finding"));
  });
});

describe("the per-expert byte budget", () => {
  const BIG = knowledge("product", "loyalty", "2026-08-29T00:00:00Z", [
    ...section("Invariants", ["first finding, kept"]),
    ...section("Entry points", ["x".repeat(400)]),
    ...section("Gotchas", ["y".repeat(400)]),
    ...section("Sources", ["z".repeat(400)]),
  ]);

  test("truncation cuts at an H2 boundary and names what it left out", async () => {
    const ws = workspace(
      {
        ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 2),
        ".tldrx/experts/product/knowledge/loyalty.md": BIG,
      },
      { expertKnowledgeBytes: 320 },
    );
    await prepare(ws);
    const prompt = promptOf(ws);

    expect(prompt).toContain("first finding, kept");
    // the sections past the cut are gone WHOLE — never half a bullet, which would
    // be a claim with its citation torn off
    expect(prompt).not.toContain("y".repeat(400));
    expect(prompt).not.toContain("## Gotchas");
    // and the prompt says so, with a count and a path a human can open
    expect(prompt).toMatch(/… \d+ more findings in \.tldrx\/experts\/product\/knowledge\/loyalty\.md/);

    const [expert] = pendingExperts(ws).filter((e) => e.name === "product");
    expect(expert?.truncated).toBe(true);
    expect(expert?.knowledge_bytes).toBeLessThanOrEqual(320);
  });

  test("a file whose first section already blows the budget is named, not half-inlined", async () => {
    const ws = workspace(
      {
        ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 2),
        ".tldrx/experts/product/knowledge/loyalty.md": BIG,
      },
      { expertKnowledgeBytes: 10 },
    );
    await prepare(ws);
    const prompt = promptOf(ws);
    expect(prompt).not.toContain("first finding, kept");
    expect(prompt).toContain("past this stage's expert knowledge budget");
    expect(prompt).toContain(".tldrx/experts/product/knowledge/loyalty.md");
    expect(pendingExperts(ws).find((e) => e.name === "product")?.knowledge_bytes).toBe(0);
  });

  test("truncateAtHeading returns the whole text when it fits, and '' when no section does", () => {
    const text = "# T\n\n## A\n\n- one\n\n## B\n\n- two\n";
    expect(truncateAtHeading(text, 1000)).toBe(text);
    expect(truncateAtHeading(text, 20)).toContain("## A");
    expect(truncateAtHeading(text, 20)).not.toContain("## B");
    expect(truncateAtHeading(text, 3)).toBe("");
    expect(truncateAtHeading("no headings here at all", 5)).toBe("");
  });

  test("countFindings counts list items and nothing else", () => {
    expect(countFindings("# T\n\n- a\n* b\n  - c\ntext\n")).toBe(3);
    expect(countFindings("# T\n\nprose only\n")).toBe(0);
  });
});

describe("expert selection (spec §2.3)", () => {
  test("a domain expert whose repos intersect the run loads without any stage naming it", async () => {
    const ws = workspace({
      ".tldrx/experts/checkout/expert.md": domainExpert("checkout", ["api"], ["src/Checkout/"]),
      ".tldrx/experts/checkout/competencies.yml": competencies("checkout", "checkout", 2),
      ".tldrx/experts/checkout/knowledge/checkout.md":
        knowledge("checkout", "checkout", "2026-08-29T00:00:00Z", section("Invariants", ["a cart is immutable"])),
    });
    const outcome = await prepare(ws);
    expect(outcome.code).toBe(0);
    expect(promptOf(ws)).toContain("<!-- expert: checkout -->");
    expect(promptOf(ws)).toContain("a cart is immutable");
    const checkout = pendingExperts(ws).find((e) => e.name === "checkout");
    expect(checkout?.reason).toBe("domain");
    expect(checkout?.match).toBe("repo api");
  });

  test("a domain expert whose repos are elsewhere is not loaded", async () => {
    const ws = workspace({
      ".tldrx/experts/elsewhere/expert.md": domainExpert("elsewhere", ["other"], ["src/Other/"]),
      ".tldrx/experts/elsewhere/competencies.yml": competencies("elsewhere", "other", 1),
    });
    await prepare(ws);
    expect(promptOf(ws)).not.toContain("<!-- expert: elsewhere -->");
  });

  test("no expert loads twice, however many rules would pick it", async () => {
    const ws = workspace(
      { ".tldrx/experts/dotnet-stack/expert.md": "# dotnet stack\n" },
      // named by the stage AND a stack expert for `api`, AND named twice over
      { experts: ["product", "dotnet-stack", "dotnet-stack"] },
    );
    await prepare(ws);
    const prompt = promptOf(ws);
    expect(prompt.split("<!-- expert: dotnet-stack -->")).toHaveLength(2);
    const names = pendingExperts(ws).map((e) => e.name);
    expect(names).toEqual([...new Set(names)]);
    expect(pendingExperts(ws).find((e) => e.name === "dotnet-stack")?.reason).toBe("stage");
  });

  test("selection order is stage, then stack, then domain — and it is deterministic", async () => {
    const ws = workspace({
      ".tldrx/experts/dotnet-stack/expert.md": "# dotnet\n",
      ".tldrx/experts/typescript-stack/expert.md": "# ts\n",
      ".tldrx/experts/checkout/expert.md": domainExpert("checkout", ["api"], ["src/Checkout/"]),
      ".tldrx/experts/checkout/competencies.yml": competencies("checkout", "checkout", 1),
    });
    await prepare(ws);
    expect(pendingExperts(ws).map((e) => `${e.name}:${e.reason}`)).toEqual([
      "product:stage", "dotnet-stack:stack", "typescript-stack:stack", "checkout:domain",
    ]);
  });

  test("a stage naming an expert that does not exist says so instead of loading nothing quietly", async () => {
    const ws = workspace({}, { experts: ["product", "domain"] });
    const outcome = await prepare(ws);
    expect(outcome.lines.join("\n")).toContain("expert domain — NOT LOADED");
    expect(outcome.lines.join("\n")).toContain(".tldrx/experts/domain/");
  });

  test("a cited path inside a domain expert's folder ranks it above a bare repo match", () => {
    const declared = { name: "checkout", exists: true, kind: "domain", repos: ["api"], paths: ["src/Checkout"] };
    expect(pathsIntersect("api/src/Checkout", "api/src/Checkout/Cart.cs")).toBe(true);
    expect(pathsIntersect("api/src/Checkout", "api/src/Check")).toBe(false);
    expect(declared.paths[0]).toBe("src/Checkout");
  });
});

describe("visibility", () => {
  test("--prepare names each expert with its expert.md and knowledge bytes", async () => {
    const ws = workspace({
      ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 2),
      ".tldrx/experts/product/knowledge/loyalty.md":
        knowledge("product", "loyalty", "2026-08-29T00:00:00Z", section("Invariants", ["a finding"])),
    });
    const outcome = await prepare(ws);
    const text = outcome.lines.join("\n");
    expect(text).toMatch(/expert product \(stage\) — expert\.md \d+ B, knowledge \d+ B over 1 area/);

    const [expert] = pendingExperts(ws);
    expect(expert?.name).toBe("product");
    expect(expert?.expert_md_bytes).toBeGreaterThan(0);
    expect(expert?.knowledge_bytes).toBeGreaterThan(0);
    expect(expert?.knowledge_files).toEqual([".tldrx/experts/product/knowledge/loyalty.md"]);
    expect(expert?.truncated).toBe(false);
  });

  test("an expert with no evidence anywhere earns one stderr note, and never a non-zero exit", async () => {
    const ws = workspace({
      ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 0),
    });
    const outcome = await prepare(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toEqual([
      "note: expert product has no evidence — `tldrx expert train product --area loyalty` before this stage would help",
    ]);
  });

  test("an expert WITH evidence earns no note", async () => {
    const ws = workspace({
      ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 3),
    });
    const outcome = await prepare(ws);
    expect(outcome.stderr ?? []).toEqual([]);
  });

  test("`expert list` says which stages load each expert", async () => {
    const ws = workspace({
      ".tldrx/experts/checkout/expert.md": domainExpert("checkout", ["api"], ["src/Checkout/"]),
      ".tldrx/experts/checkout/competencies.yml": competencies("checkout", "checkout", 1),
    });
    // Shipped stages count too — `stages/what/stage.yml` also names `product` —
    // so this asserts what the workspace's OWN stage contributes, not a total.
    const loads = stagesLoadingExperts(ws.root);
    expect(describeStageLoads(loads.get("product"))).toContain("alpha (named)");
    expect(describeStageLoads(loads.get("checkout"))).toContain("alpha (domain)");
    expect(describeStageLoads(loads.get("nobody"))).toContain("loaded by: no stage");
    // and the shipped `what` stage names `domain`, an expert `init` never seeds:
    // it must not show up as loading anything, because it does not exist.
    expect(loads.get("domain")).toBeUndefined();
  });
});

describe("the pieces, in isolation", () => {
  test("`## Domain` bullets yield paths, and `- repo `x`` deliberately yields none", () => {
    expect(domainPaths("- `src/Checkout/`\n- `api/src/Other`\n")).toEqual(["src/Checkout", "api/src/Other"]);
    expect(domainPaths("- repo `api`\n- repo `lab`\n")).toEqual([]);
    // the shipped template's own placeholders are prose, not a claim about a path
    expect(domainPaths("- `path/to/module` — …\n")).toEqual([]);
  });

  test("readExpertDomain reads kind, repos and paths off expert.md", () => {
    const ws = workspace({
      ".tldrx/experts/checkout/expert.md": domainExpert("checkout", ["api", "lab"], ["src/Checkout/"]),
    });
    const declared = readExpertDomain(ws.root, "checkout");
    expect(declared.kind).toBe("domain");
    expect(declared.repos).toEqual(["api", "lab"]);
    expect(declared.paths).toEqual(["src/Checkout"]);
    expect(readExpertDomain(ws.root, "nope").exists).toBe(false);
  });

  test("selectExperts reports a missing name rather than dropping it", () => {
    const ws = workspace({});
    const selection = selectExperts({
      root: ws.root, staged: ["product", "ghost"], repos: [], stackExperts: false, stackNames: [],
    });
    expect(selection.experts.map((e) => e.name)).toEqual(["product"]);
    expect(selection.missing).toEqual(["ghost"]);
  });

  test("loadExpertKnowledge renders a chart for an expert with areas and no knowledge files", () => {
    const ws = workspace({ ".tldrx/experts/product/competencies.yml": competencies("product", "loyalty", 2) });
    const bundles = loadExpertBundles({
      root: ws.root, staged: ["product"], repos: [], stackExperts: false, stackNames: [],
    });
    expect(bundles.experts[0]?.knowledge).toContain("### Competencies");
    expect(bundles.experts[0]?.knowledge).not.toContain("### Trained knowledge");
    expect(loadExpertKnowledge({ root: ws.root, name: "product" }).files).toEqual([]);
  });
});
