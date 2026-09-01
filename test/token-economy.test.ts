/**
 * Wave N — the token economy.
 *
 * Everything here is about what a prompt COSTS: the order its pieces are in (a
 * cache read is 0.1x an input token, a cache write 1.25x), how many bytes each
 * piece is allowed, which experts earn knowledge, and the refusal that stops a
 * prompt nobody can afford before it is spawned rather than after.
 *
 * The sizes in `docs/audits/2026-08-29/token-economy-legacy.md` are the fixture:
 * a 5,863-byte ADR that a 64 KB seed budget dropped whole while 70,923 bytes of
 * unrequested expert knowledge went in untouched.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPrompt, cutSection, renderParts, type PromptParts,
} from "../src/core/facilitator/prompt.ts";

const VALUES = {
  run: "260830-demo",
  repos: "api",
  inputs: "- a.md",
  facts: "_none_",
  conventions: "_none_",
  budget_usd: "4.00",
} as const;

function parts(overrides: Partial<PromptParts> = {}): PromptParts {
  return {
    stageMd: "# Stage\n\n## Role\n\nYou are the product expert.\n",
    values: VALUES,
    experts: [{ name: "product", body: "# product\n\nBody.", knowledge: "### Trained knowledge\n\n- a finding" }],
    inputs: [{ path: "a.md", content: "alpha" }],
    ...overrides,
  };
}

describe("prompt order (N1)", () => {
  test("stable first, volatile last: stage, experts, inputs, previous attempt", () => {
    const kinds = renderParts(parts({ previousAttempt: "it failed" })).map((p) => p.kind);
    expect(kinds).toEqual([
      "stage", "expert-body", "expert-knowledge", "inputs", "previous-attempt",
    ]);
  });

  test("the expert block precedes `## Inputs` in the assembled text", () => {
    const prompt = buildPrompt(parts());
    expect(prompt.indexOf("<!-- expert: product -->")).toBeGreaterThan(-1);
    expect(prompt.indexOf("<!-- expert: product -->")).toBeLessThan(prompt.indexOf("## Inputs"));
  });

  test("no `## Previous attempt` section at all on a first attempt", () => {
    expect(buildPrompt(parts())).not.toContain("## Previous attempt");
  });

  test("a stage.md with `## Inputs` in the middle yields exactly one, at the tail", () => {
    const stageMd = [
      "# Stage", "", "## Role", "", "prose", "",
      "## Inputs", "", "the author's own words", "",
      "## Stop", "", "stop here", "",
    ].join("\n");
    const prompt = buildPrompt(parts({ stageMd }));
    expect(prompt.split("## Inputs").length - 1).toBe(1);
    expect(prompt).not.toContain("the author's own words");
    expect(prompt.indexOf("## Stop")).toBeLessThan(prompt.indexOf("## Inputs"));
  });

  test("the prefix through the experts is byte-identical when only the inputs change", () => {
    const a = buildPrompt(parts({ inputs: [{ path: "a.md", content: "alpha" }] }));
    const b = buildPrompt(parts({ inputs: [{ path: "b.md", content: "beta beta beta" }] }));
    const prefix = (text: string): string => text.slice(0, text.indexOf("## Inputs"));
    expect(prefix(a)).toBe(prefix(b));
    expect(prefix(a).length).toBeGreaterThan(0);
  });

  test("the prefix through the inputs is byte-identical across attempts", () => {
    const one = buildPrompt(parts());
    const two = buildPrompt(parts({ previousAttempt: "the last one failed: no handoff" }));
    expect(two.startsWith(one.replace(/\n$/, ""))).toBe(true);
  });
});

describe("cutSection", () => {
  test("removes the heading and its body, keeping what follows", () => {
    const text = "## A\n\nalpha\n\n## B\n\nbeta\n";
    expect(cutSection(text, "A")).toBe("## B\n\nbeta\n");
  });

  test("is a no-op when the heading is absent", () => {
    expect(cutSection("## B\n\nbeta\n", "A")).toBe("## B\n\nbeta\n");
  });
});

// --- the shared budget and the context ledger, end to end ------------------

import { afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import type { PendingStage } from "../src/core/facilitator/pending.ts";
import {
  makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

let open: FacilitatorWorkspace[] = [];
afterEach(() => {
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * The aparece seed, to scale.
 *
 * Thirteen documents totalling 72,787 B, the last of them a 5,863-byte ADR — the
 * exact shape that the old 64 KB seed budget dropped whole on 2026-08-29 while
 * 70,923 B of expert knowledge went in untouched. Sizes are the measured ones.
 */
const SEED_SIZES: readonly (readonly [string, number])[] = [
  ["seed/DECISIONS-NEEDED.md", 15_484],
  ["seed/DOMAIN-IMPLEMENTATION-RULES.md", 2_853],
  ["seed/README.md", 1_726],
  ["seed/SEED-README.md", 7_795],
  ["seed/01-DOMAIN-CHARTER.md", 984],
  ["seed/02-CONTEXT-MAP.md", 4_338],
  ["seed/13-OPEN-DECISIONS.md", 2_609],
  ["seed/ADR-D008.md", 6_748],
  ["seed/ADR-D009.md", 6_231],
  ["seed/ADR-D010.md", 5_691],
  ["seed/ADR-D011.md", 6_360],
  ["seed/ADR-D012.md", 6_105],
  ["seed/ADR-D013-DELIVERY-ZONE-GEOMETRY.md", 5_863],
];

const ADR_D013 = "seed/ADR-D013-DELIVERY-ZONE-GEOMETRY.md";
const ADR_D013_MARKER = "ZONE-GEOMETRY-LAST-LINE";

/** A document of exactly `bytes` bytes whose last line is findable. */
function document(name: string, bytes: number, marker = ""): string {
  const head = `# ${name}\n\n`;
  const tail = marker === "" ? "\n" : `\n${marker}\n`;
  const filler = Math.max(0, bytes - head.length - tail.length);
  return `${head}${"x".repeat(filler)}${tail}`;
}

function seedFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, bytes] of SEED_SIZES) {
    files[path] = document(path, bytes, path === ADR_D013 ? ADR_D013_MARKER : "");
  }
  return files;
}

/**
 * A trained knowledge file big enough to eat a budget that is not shared.
 *
 * Many small H2 sections rather than one huge one, because truncation cuts at an
 * H2 boundary (§5) and a single-section file can only be inlined whole or not at
 * all — which would test the budget's edge case instead of the budget.
 */
function bigKnowledge(area: string, bytes: number): string {
  const perSection = 8;
  const sections: string[] = [];
  for (let i = 0; sections.join("\n").length < bytes; i++) {
    sections.push(`## Area ${String(i)}`, "");
    for (let j = 0; j < perSection; j++) {
      sections.push(`- finding ${String(i)}.${String(j)} padded to about sixty-odd bytes [src: api:src/A.cs:1]`);
    }
    sections.push("");
  }
  return [
    "---", "expert: product", `area: ${area}`, "mode: light",
    "trained_at: 2026-08-29T00:00:00Z", "---", "",
    ...sections,
  ].join("\n");
}

function seededWorkspace(stage: Partial<StageOptions> = {}): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
      outputs: [{ path: "01-what/handoff.md" }],
      optional: SEED_SIZES.map(([path]) => path),
      ...stage,
    }],
    files: {
      ...seedFiles(),
      ".tldrx/experts/product/knowledge/loyalty.md": bigKnowledge("loyalty", 70_923),
    },
  });
  open.push(made);
  return made;
}

async function prepare(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}) {
  return await runNext({
    root: ws.root, dryRun: false, mode: "prepare", yolo: false,
    actor: "alan", at: "2026-08-28T09:00:00Z", ...overrides,
  });
}

function bundle(ws: FacilitatorWorkspace): { prompt: string; pending: PendingStage } {
  const dir = join(ws.runDir, ".agent", "alpha");
  return {
    prompt: readFileSync(join(dir, "prompt.md"), "utf8"),
    pending: JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as PendingStage,
  };
}

describe("one shared budget, inputs first (N3)", () => {
  test("ADR-D013 is inlined WHOLE — the regression the audit measured", async () => {
    const ws = seededWorkspace();
    expect((await prepare(ws)).code).toBe(0);
    const { prompt, pending } = bundle(ws);

    expect(prompt).toContain(ADR_D013);
    // Whole, not a labelled prefix and not a "listed but not inlined" marker.
    expect(prompt).toContain(ADR_D013_MARKER);
    expect(prompt).not.toContain("past this stage's inline budget");
    expect(pending.context?.truncated_inputs).toEqual([]);
  });

  test("the experts share one knowledge budget, they do not each get one", async () => {
    const ws = seededWorkspace();
    await prepare(ws);
    const { pending } = bundle(ws);
    // 70,923 B of knowledge exists on disk; the stage's total ceiling is 48 KB.
    // `experts[].knowledge_bytes` counts FILE bytes, which is what the budget
    // caps; the ledger's group also carries the star chart and the framing prose,
    // so it is a few hundred bytes larger by design (spec §5).
    const inlined = (pending.experts ?? []).reduce((sum, e) => sum + e.knowledge_bytes, 0);
    expect(inlined).toBeLessThanOrEqual(48 * 1024);
    expect(inlined).toBeGreaterThan(0);
    expect(pending.context?.expert_knowledge_bytes).toBeGreaterThanOrEqual(inlined);
  });

  test("the preamble counts what it inlined; it never claims a file the budget dropped", async () => {
    // The contradiction this guards, measured on a real Build prompt 2026-08-30:
    // 9 of 15 declared inputs inlined, 6 marked "It exists on disk", and the
    // preamble above them still read "there is nothing to open and nothing else
    // to find" — including for the two documents the run existed to edit.
    const ws = seededWorkspace({ inputsMaxBytes: 40_000 });
    expect((await prepare(ws)).code).toBe(0);
    const { prompt } = bundle(ws);

    expect(prompt).not.toContain("so there is nothing to open and nothing else to find");
    expect(prompt).toContain("Inlined below: 8 of 13 declared inputs.");
    expect(prompt).toContain(
      "The rest exist on disk — READ them at the listed paths before relying on them; do not",
    );

    // The list names exactly the ones with NO content in the prompt.
    const at = prompt.indexOf("guess: ");
    const listed = prompt.slice(at, prompt.indexOf("\n", at));
    expect(listed).toContain(ADR_D013);
    expect(listed).toContain("seed/ADR-D009.md");
    expect(listed).toContain("seed/ADR-D010.md");
    // Inlined whole, or inlined as a labelled prefix: neither is "go and read it".
    expect(listed).not.toContain("seed/README.md");
    expect(listed).not.toContain("seed/ADR-D008.md");
  });

  test("with every input inlined the preamble is the flat sentence it always was", async () => {
    const ws = seededWorkspace();
    expect((await prepare(ws)).code).toBe(0);
    const { prompt } = bundle(ws);
    expect(prompt).toContain("These files are the ONLY ones you may read. Their full content is inlined below,");
    expect(prompt).toContain("so there is nothing to open and nothing else to find.");
    expect(prompt).not.toContain("Inlined below:");
  });

  test("a declared input that still does not fit is named on stdout and on the page", async () => {
    const ws = seededWorkspace({ inputsMaxBytes: 40_000 });
    const outcome = await prepare(ws);
    expect(outcome.code).toBe(0);
    const stdout = outcome.lines.join("\n");
    expect(stdout).toContain("truncated input:");
    expect(stdout).toContain("raise inputs_max_bytes");
    expect(bundle(ws).prompt).toContain("truncated inputs:");
    expect(bundle(ws).pending.context?.truncated_inputs.length).toBeGreaterThan(0);
  });
});

describe("the context ledger and prompt_max_bytes (N2)", () => {
  test("--prepare prints the total, the groups and the biggest sections", async () => {
    const ws = seededWorkspace();
    const text = (await prepare(ws)).lines.join("\n");
    expect(text).toMatch(/context [\d.]+ KB of [\d.]+ KB \(~[\d.]+k tok, \d+% of sonnet's/);
    expect(text).toMatch(/stage [\d.]+ (B|KB).* · inputs [\d.]+ KB · experts [\d.]+ KB/);
    expect(text).toContain("input seed/DECISIONS-NEEDED.md");
  });

  test("pending.json carries the same ledger, and the numbers add up", async () => {
    const ws = seededWorkspace();
    await prepare(ws);
    const context = bundle(ws).pending.context;
    expect(context).toBeDefined();
    const sum = (context?.stage_bytes ?? 0) + (context?.inputs_bytes ?? 0)
      + (context?.expert_body_bytes ?? 0) + (context?.expert_knowledge_bytes ?? 0)
      + (context?.previous_attempt_bytes ?? 0);
    expect(sum).toBe(context?.total_bytes ?? -1);
    // The ledger measures the file that was actually written, to the byte.
    expect(context?.total_bytes).toBe(Buffer.byteLength(bundle(ws).prompt, "utf8"));
  });

  test("over prompt_max_bytes the stage is REFUSED (exit 2), before anything spawns", async () => {
    const ws = seededWorkspace({ promptMaxBytes: 20_000 });
    const outcome = await prepare(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain('refusing to start stage "alpha"');
    expect(text).toContain("prompt_max_bytes");
    expect(text).toContain("`inputs_max_bytes`");
    expect(text).toContain("--prompt-max-bytes");
  });

  test("--prompt-max-bytes overrides the stage file, both ways", async () => {
    const ws = seededWorkspace({ promptMaxBytes: 20_000 });
    expect((await prepare(ws, { promptMaxBytes: 1_000_000 })).code).toBe(0);

    const other = seededWorkspace();
    expect((await prepare(other, { promptMaxBytes: 20_000 })).code).toBe(2);
  });
});

// --- relevance, not "same repo" (N4) ---------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import {
  countMatches, DIRECT_WEIGHT, GRAPH_HOPS, selectExperts,
} from "../src/core/experts/selectExperts.ts";
import { readExpertDomain } from "../src/core/experts/expertDomain.ts";
import { nearbyPathsFor, graphPath } from "../src/core/experts/domainRank.ts";
import { neighbourhoodPaths } from "../src/core/map/graphJson.ts";
import { pathsIntersect } from "../src/core/experts/expertDomain.ts";
import { knowledgeShares } from "../src/core/experts/expertBundle.ts";

/** A `kind: domain` expert.md with a real `## Domain` section. */
function domainExpertMd(name: string, repos: readonly string[], paths: readonly string[]): string {
  return [
    "---", `name: ${name}`, "kind: domain", "status: in-use",
    `repos: [${repos.join(", ")}]`, "---", "", `# ${name}`, "", "## Domain", "",
    ...paths.map((path) => `- \`${path}\``), "",
  ].join("\n");
}

function withDomainExperts(
  experts: Readonly<Record<string, readonly string[]>>,
): FacilitatorWorkspace {
  const files: Record<string, string> = {};
  for (const [name, paths] of Object.entries(experts)) {
    files[`.tldrx/experts/${name}/expert.md`] = domainExpertMd(name, ["api"], paths);
  }
  const made = makeFacilitatorWorkspace({
    scope: "demo", budgetUsd: 10,
    stages: [{
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
      outputs: [{ path: "01-what/handoff.md" }],
      optional: ["api/src/Checkout/Cart.cs"],
    }],
    files: { ...files, "api/src/Checkout/Cart.cs": "// cart\n" },
  });
  open.push(made);
  return made;
}

describe("expert relevance (N4)", () => {
  test("a single-repo workspace never loads a domain expert by repo alone", () => {
    const ws = withDomainExperts({ far: ["src/Billing"], near: ["src/Checkout"] });
    const single = selectExperts({
      root: ws.root, staged: [], repos: ["api"], stackExperts: false, stackNames: [],
      citedPaths: ["api/src/Checkout/Cart.cs"], workspaceRepoCount: 1,
    });
    expect(single.experts.map((e) => e.name)).toEqual(["near"]);

    // Two repos: `repos:` is evidence again, and `far` loads — body only.
    const multi = selectExperts({
      root: ws.root, staged: [], repos: ["api"], stackExperts: false, stackNames: [],
      citedPaths: ["api/src/Checkout/Cart.cs"], workspaceRepoCount: 2,
    });
    expect(multi.experts.map((e) => e.name)).toEqual(["near", "far"]);
    expect(multi.experts.find((e) => e.name === "far")?.relevant).toBe(false);
    expect(multi.experts.find((e) => e.name === "near")?.relevant).toBe(true);
  });

  test("an omitted workspaceRepoCount keeps the old behaviour", () => {
    const ws = withDomainExperts({ far: ["src/Billing"] });
    const selection = selectExperts({
      root: ws.root, staged: [], repos: ["api"], stackExperts: false, stackNames: [],
      citedPaths: ["api/src/Checkout/Cart.cs"],
    });
    expect(selection.experts.map((e) => e.name)).toEqual(["far"]);
  });

  test("more cited paths inside a domain means a higher rank", () => {
    const ws = withDomainExperts({ one: ["src/Checkout"], two: ["src/Checkout", "src/Cart"] });
    const selection = selectExperts({
      root: ws.root, staged: [], repos: ["api"], stackExperts: false, stackNames: [],
      citedPaths: ["api/src/Checkout/Cart.cs", "api/src/Cart/Line.cs"],
      workspaceRepoCount: 1,
    });
    expect(selection.experts.map((e) => e.name)).toEqual(["two", "one"]);
  });

  test("countMatches counts cited paths, not bullets", () => {
    const ws = withDomainExperts({ two: ["src/Checkout", "src/Cart"] });
    const declared = readExpertDomain(ws.root, "two");
    expect(countMatches(declared, ["api/src/Checkout/a.cs", "api/src/Cart/b.cs"])).toBe(2);
    expect(countMatches(declared, ["api/src/Billing/c.cs"])).toBe(0);
    expect(DIRECT_WEIGHT).toBeGreaterThan(1);
  });

  test("a graph neighbour ranks below a direct match but above nothing", () => {
    const ws = withDomainExperts({ direct: ["src/Checkout"], neighbour: ["src/Payments"] });
    const selection = selectExperts({
      root: ws.root, staged: [], repos: ["api"], stackExperts: false, stackNames: [],
      citedPaths: ["api/src/Checkout/Cart.cs"],
      nearbyPaths: new Set(["api/src/Payments/Charge.cs"]),
      workspaceRepoCount: 1,
    });
    expect(selection.experts.map((e) => e.name)).toEqual(["direct", "neighbour"]);
    expect(selection.experts[1]?.match).toContain(`within ${String(GRAPH_HOPS)} hops`);
  });
});

describe("the k-hop neighbourhood (N4)", () => {
  const GRAPH = {
    nodes: [
      { id: "a", source_file: "src/Checkout/Cart.cs" },
      { id: "b", source_file: "src/Payments/Charge.cs" },
      { id: "c", source_file: "src/Ledger/Entry.cs" },
      { id: "d", source_file: "src/Faraway/Thing.cs" },
    ],
    links: [
      { source: "a", target: "b", relation: "imports" },
      { source: "b", target: "c", relation: "imports" },
      { source: "c", target: "d", relation: "imports" },
    ],
  };

  test("two hops reaches the neighbour's neighbour and stops", () => {
    const near = neighbourhoodPaths(GRAPH, ["src/Checkout/Cart.cs"], 2, pathsIntersect);
    expect([...near].sort()).toEqual([
      "src/Checkout/Cart.cs", "src/Ledger/Entry.cs", "src/Payments/Charge.cs",
    ]);
  });

  test("it is undirected — a target reaches its source", () => {
    const near = neighbourhoodPaths(GRAPH, ["src/Ledger/Entry.cs"], 1, pathsIntersect);
    expect(near.has("src/Payments/Charge.cs")).toBe(true);
  });

  test("no seed, no graph, or a broken graph is an empty set, never a throw", () => {
    expect(neighbourhoodPaths(GRAPH, [], 2, pathsIntersect).size).toBe(0);
    expect(neighbourhoodPaths(null, ["a"], 2, pathsIntersect).size).toBe(0);
    expect(neighbourhoodPaths({ nodes: "nope" }, ["a"], 2, pathsIntersect).size).toBe(0);
  });

  test("nearbyPathsFor reads .tldrx/graphify-out/<repo>/graph.json, or gives up quietly", () => {
    const ws = withDomainExperts({ near: ["src/Checkout"] });
    expect(nearbyPathsFor(ws.root, ["api"], ["src/Checkout/Cart.cs"]).size).toBe(0);

    const path = graphPath(ws.root, "api");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(GRAPH), "utf8");
    const near = nearbyPathsFor(ws.root, ["api"], ["src/Checkout/Cart.cs"]);
    expect(near.has("src/Payments/Charge.cs")).toBe(true);

    writeFileSync(path, "{ not json", "utf8");
    expect(nearbyPathsFor(ws.root, ["api"], ["src/Checkout/Cart.cs"]).size).toBe(0);
  });
});

describe("the shared knowledge budget is split by rank (N4)", () => {
  test("the top expert gets the most and an irrelevant one gets nothing", () => {
    const shares = knowledgeShares([true, true, true, false], 48_000);
    expect(shares[3]).toBe(0);
    expect(shares[0]).toBeGreaterThan(shares[1] ?? 0);
    expect(shares[1]).toBeGreaterThan(shares[2] ?? 0);
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(48_000);
  });

  test("nothing eligible, or nothing to give, is all zeroes", () => {
    expect(knowledgeShares([false, false], 48_000)).toEqual([0, 0]);
    expect(knowledgeShares([true, true], 0)).toEqual([0, 0]);
  });
});

// --- the read cap (N5) -----------------------------------------------------

import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import {
  defaultMaxReads, isReadTool, readsLabel, STOPPED_BY_MAX_READS,
} from "../src/core/facilitator/readCap.ts";
import { UiState } from "../src/core/ui/state.ts";
import { footer } from "../src/core/ui/scene.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_READS", "FAKE_CLAUDE_HANG_MS",
  "FAKE_CLAUDE_READS_BURST",
] as const;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
});

function readingWorkspace(maxReads: number): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo", budgetUsd: 10,
    stages: [{
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
      outputs: [{ path: "01-what/handoff.md" }],
      maxReads, timeoutS: 30,
    }],
  });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({ "01-what/handoff.md": "# h\n" });
  return made;
}

describe("max_reads (N5)", () => {
  test("only Read, Glob and Grep count", () => {
    expect(["Read", "Glob", "Grep"].every(isReadTool)).toBe(true);
    expect(["Write", "Edit", "Bash", "StructuredOutput"].some(isReadTool)).toBe(false);
  });

  test("the shipped defaults are per stage kind", () => {
    expect(defaultMaxReads("what")).toBe(120);
    expect(defaultMaxReads("how")).toBe(120);
    expect(defaultMaxReads("plan")).toBe(120);
    expect(defaultMaxReads("build")).toBe(200);
    expect(defaultMaxReads("watch")).toBe(60);
  });

  test("the cap stops a live sub-agent and the stage fails with the reason", async () => {
    const ws = readingWorkspace(3);
    // The fake emits 20 reads and then sleeps 30 s. If the cap did not kill it,
    // this test would take 30 s and the stage would succeed.
    process.env.FAKE_CLAUDE_READS = "20";
    process.env.FAKE_CLAUDE_HANG_MS = "30000";

    const started = Date.now();
    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-28T09:00:00Z",
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(outcome.code).toBe(5);
    expect(outcome.lines.join("\n")).toContain("max_reads is 3");

    const store = RunStore.open(ws.runDir);
    const task = store.run.phases[0]?.stages[0]?.tasks[0];
    expect(task?.status).toBe("failed");
    expect(task?.stopped_by).toBe(STOPPED_BY_MAX_READS);

    const result = EventLog.forRun(ws.runDir).read().find((e) => e.type === "agent.result");
    expect(result?.payload.stopped_by).toBe(STOPPED_BY_MAX_READS);
    expect(result?.payload.max_reads).toBe(3);
    expect(result?.payload.reads).toBe(3);
  }, 40_000);

  test("under the cap, nothing changes and stopped_by stays null", async () => {
    const ws = readingWorkspace(50);
    process.env.FAKE_CLAUDE_READS = "2";
    process.env.FAKE_CLAUDE_HANG_MS = "0";

    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-28T09:00:00Z",
    });
    expect(outcome.code).toBe(0);
    const store = RunStore.open(ws.runDir);
    const task = store.run.phases[0]?.stages[0]?.tasks[0];
    expect(task?.status).toBe("done");
    expect(task?.stopped_by ?? null).toBeNull();
    const result = EventLog.forRun(ws.runDir).read().find((e) => e.type === "agent.result");
    expect(result?.payload.reads).toBe(2);
  }, 30_000);

  test("--max-reads overrides the stage file", async () => {
    const ws = readingWorkspace(500);
    process.env.FAKE_CLAUDE_READS = "20";
    process.env.FAKE_CLAUDE_HANG_MS = "30000";
    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false, maxReads: 2,
      actor: "alan", at: "2026-08-28T09:00:00Z",
    });
    expect(outcome.code).toBe(5);
    expect(outcome.lines.join("\n")).toContain("max_reads is 2");
  }, 40_000);

  /**
   * Issue #24 — the flake, and what it actually was.
   *
   * A chunk boundary is not a read boundary. `LineSplitter` hands EVERY complete
   * line in one chunk to `onStdoutLine` synchronously, so when the OS coalesced
   * the sub-agent's writes — which is what a loaded CI box does — the counter ran
   * past the cap inside a single callback, long before the SIGKILL it had just
   * ordered could land. `reads` was therefore a function of scheduling: 3 on an
   * idle laptop, 4 or 7 or 20 under load, and `payload.reads` was asserted to be
   * the cap. Twice in one night that cost a retry.
   *
   * The fix is to stop counting the moment the cap fires, so the number recorded
   * is what the cap ALLOWED rather than what happened to arrive before the kill.
   * This test pins it by making the coalescing deterministic: every read pair in
   * one write.
   */
  test("a burst of reads in ONE chunk still stops at the cap — the count is not a race", async () => {
    const ws = readingWorkspace(3);
    process.env.FAKE_CLAUDE_READS = "20";
    process.env.FAKE_CLAUDE_READS_BURST = "1";
    process.env.FAKE_CLAUDE_HANG_MS = "30000";

    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-28T09:00:00Z",
    });
    expect(outcome.code).toBe(5);
    expect(outcome.lines.join("\n")).toContain("stopped after 3 reads");

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.tasks[0]?.stopped_by).toBe(STOPPED_BY_MAX_READS);
    const result = EventLog.forRun(ws.runDir).read().find((e) => e.type === "agent.result");
    expect(result?.payload.reads).toBe(3);
    expect(result?.payload.max_reads).toBe(3);
  }, 40_000);

  test("the UI footer counts reads against the cap", () => {
    const state = new UiState({ root: "/w", startedAt: 0, ceilingUsd: 6 });
    state.setReadCap(120);
    state.apply({ kind: "reads", count: 37, cap: 120 }, 0);
    expect(footer(state.snapshot(0))).toContain("reads 37/120");
    expect(readsLabel(37, 120)).toBe("reads 37/120");
    expect(readsLabel(37, 0)).toBe("reads 37");
  });
});

// --- attempt reuse (N6) ----------------------------------------------------

import {
  describePreviousAttempt, MAX_PREVIOUS_ATTEMPT_BYTES,
} from "../src/core/facilitator/runNext.ts";
import type { RunStage } from "../src/core/run/RunFile.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function rejectedStage(note: string): RunStage {
  return {
    id: "alpha", status: "ready", expert: null, model: null,
    budget_usd: 1, cost_usd: 0, started_at: null, ended_at: null,
    inputs: [], outputs: ["01-what/handoff.md", "01-what/intent.md"],
    gate: { type: "approve", status: "rejected", by: "alan", at: null, note },
    tasks: [],
  } as unknown as RunStage;
}

describe("attempt reuse (N6)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function scratch(files: Readonly<Record<string, string>>): { root: string; runDir: string } {
    const root = mkdtempSync(join(tmpdir(), "tldrx-prev-"));
    dirs.push(root);
    const runDir = join(root, "tldrx-work", "260830-x");
    for (const [rel, content] of Object.entries(files)) {
      const path = join(runDir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    return { root, runDir };
  }

  test("the refused outputs are inlined under an edit-do-not-restart instruction", () => {
    const { root, runDir } = scratch({
      "01-what/handoff.md": "# Handoff\n\n## Findings\n- a thing [src: F001]\n",
      "01-what/intent.md": "# Intent\n\nShip the thing.\n",
    });
    const text = describePreviousAttempt(rejectedStage("scope.md lists nothing OUT"), {
      outputs: ["01-what/handoff.md", "01-what/intent.md"],
      ctx: { root, runDir },
    });
    expect(text).toContain("A human rejected the previous attempt");
    expect(text).toContain("### Previous attempt — edit, do not restart");
    expect(text).toContain("#### `01-what/handoff.md`");
    expect(text).toContain("- a thing [src: F001]");
    expect(text).toContain("Ship the thing.");
  });

  test("nothing is inlined on a first attempt — the section is not emitted at all", () => {
    const { root, runDir } = scratch({ "01-what/handoff.md": "# Handoff\n" });
    const first = { ...rejectedStage(""), gate: { type: "approve", status: "pending", by: null, at: null, note: "" } };
    expect(describePreviousAttempt(first as unknown as RunStage, {
      outputs: ["01-what/handoff.md"], ctx: { root, runDir },
    })).toBe("");
  });

  test("a file past the budget is NAMED, never silently dropped", () => {
    const { root, runDir } = scratch({
      "01-what/handoff.md": `# Handoff\n\n${"x".repeat(200)}\n`,
      "01-what/intent.md": `# Intent\n\n${"y".repeat(5000)}\n`,
    });
    const text = describePreviousAttempt(rejectedStage("try again"), {
      outputs: ["01-what/handoff.md", "01-what/intent.md"],
      ctx: { root, runDir },
      maxBytes: 500,
    });
    expect(text).toContain("#### `01-what/handoff.md`");
    expect(text).not.toContain("#### `01-what/intent.md`");
    expect(text).toContain("Not inlined (past the 500-byte previous-attempt budget): 01-what/intent.md (5,011 B)");
  });

  test("missing and empty outputs are simply absent", () => {
    const { root, runDir } = scratch({ "01-what/intent.md": "   \n" });
    const text = describePreviousAttempt(rejectedStage("try again"), {
      outputs: ["01-what/handoff.md", "01-what/intent.md"],
      ctx: { root, runDir },
    });
    expect(text).not.toContain("### Previous attempt — edit, do not restart");
    expect(MAX_PREVIOUS_ATTEMPT_BYTES).toBe(32 * 1024);
  });
});

// --- tldrx cost and run estimate (N7) --------------------------------------

import {
  attemptTokensForStage, buildProgramCost, buildRunCost, median, outputTokensForStage,
  renderRunCost, toAttempt,
} from "../src/core/budget/costView.ts";
import { estimateNextStage, renderEstimate } from "../src/core/budget/estimateView.ts";
import {
  priceFor, contextTokensFor, estimateTokensFromBytes,
  CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER,
} from "../src/core/budget/modelPrices.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";

function agentResult(
  stage: string,
  overrides: Partial<TldrxEvent> & { payload?: Record<string, unknown> } = {},
): TldrxEvent {
  return {
    ts: "2026-08-29T00:00:00Z", run: "260830-x", stage, type: "agent.result",
    actor: "alan", cost_usd: 0.42,
    payload: {
      phase: "01-what", task: "t1", model: "sonnet", outputs: [],
      usage: {
        input_tokens: 1000, output_tokens: 200,
        cache_creation_input_tokens: 50, cache_read_input_tokens: 900,
      },
    },
    ...overrides,
  } as TldrxEvent;
}

describe("tldrx cost (N7)", () => {
  test("one agent.result becomes one attempt, with all four token counters", () => {
    const attempt = toAttempt(agentResult("what"));
    expect(attempt).toMatchObject({
      phase: "01-what", stage: "what", task: "t1", model: "sonnet", usd: 0.42,
      tokens: { input: 1000, output: 200, cacheCreation: 50, cacheRead: 900 },
    });
  });

  test("an unmetered attempt is null, never zero — both markers", () => {
    expect(toAttempt(agentResult("what", { payload: { metered: false } }))?.usd).toBeNull();
    expect(toAttempt(agentResult("what", { payload: { cost_usd: null } }))?.usd).toBeNull();
    expect(toAttempt(agentResult("what"))?.usd).toBe(0.42);
  });

  test("any other event type is not an attempt", () => {
    expect(toAttempt(agentResult("what", { type: "stage.done" }))).toBeNull();
  });

  test("attempts are not merged: a stage that failed twice shows both", () => {
    const ws = readingWorkspace(50);
    const log = EventLog.forRun(ws.runDir);
    log.append(agentResult("alpha", { run: ws.runId }));
    log.append(agentResult("alpha", {
      run: ws.runId, cost_usd: 1.1, payload: { phase: "01-what", task: "t2", model: "sonnet" },
    }));

    const cost = buildRunCost(ws.runDir);
    expect(cost?.stages[0]?.attempts.length).toBe(2);
    expect(cost?.usd).toBeCloseTo(1.52, 2);
    expect(cost?.tokens.cacheRead).toBe(900);
    expect(renderRunCost(cost!)).toContain("2 attempts");
  });

  test("every attempt prints its own cache write / cache read columns", () => {
    const ws = readingWorkspace(50);
    EventLog.forRun(ws.runDir).append(agentResult("alpha", { run: ws.runId }));
    const text = renderRunCost(buildRunCost(ws.runDir)!);
    // A stage that ran ONCE still shows where its money went — cache read is
    // the column the estimate was blind to, so `cost` must not hide it either.
    expect(text).toContain("50 cache write");
    expect(text).toContain("900 cache read");
    expect(text.split("\n").filter((l) => l.includes("cache read")).length).toBeGreaterThan(1);
  });

  test("the program view adds every run in the workspace", () => {
    const ws = readingWorkspace(50);
    EventLog.forRun(ws.runDir).append(agentResult("alpha", { run: ws.runId }));
    const program = buildProgramCost(ws.root);
    expect(program.runs.length).toBeGreaterThanOrEqual(1);
    expect(program.usd).toBeCloseTo(0.42, 2);
  });

  /**
   * Declared tokens, since 2026-08-30.
   *
   * `tldrx next --commit --tokens 342527` writes that number onto the task row
   * AND the `agent.result` payload — and `tldrx cost` printed
   * `0 in · 0 out · 0 cache write · 0 cache read` beside it. Four zeroes are not
   * "unmeasured", they are "nothing happened", and they were the wrong claim
   * about a turn that burned 342.5k tokens in the host's own session.
   */
  test("a host-declared --tokens figure is carried onto the attempt", () => {
    const attempt = toAttempt(agentResult("plan", {
      cost_usd: 0,
      payload: { phase: "03-plan", task: "t1", model: "sonnet", metered: false, tokens: 342527 },
    }));
    expect(attempt?.usd).toBeNull();
    expect(attempt?.declaredTokens).toBe(342527);
    // It is NOT folded into the four measured counters: nobody measured those.
    expect(attempt?.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    // And an ordinary metered attempt declares nothing.
    expect(toAttempt(agentResult("what"))?.declaredTokens).toBeNull();
  });

  test("`tldrx cost` renders declared tokens instead of a row of zeroes", () => {
    const ws = readingWorkspace(50);
    EventLog.forRun(ws.runDir).append(agentResult("alpha", {
      run: ws.runId,
      cost_usd: 0,
      payload: { phase: "01-what", task: "t1", model: "sonnet", metered: false, tokens: 342527 },
    }));

    const cost = buildRunCost(ws.runDir);
    expect(cost?.declaredTokens).toBe(342527);
    const text = renderRunCost(cost!);
    expect(text).toContain("~342.5k declared (host session)");
    expect(text).not.toContain("0 in · 0 out · 0 cache write · 0 cache read");
  });

  test("a measured attempt still prints its four counters, declared or not", () => {
    const ws = readingWorkspace(50);
    EventLog.forRun(ws.runDir).append(agentResult("alpha", { run: ws.runId }));
    const text = renderRunCost(buildRunCost(ws.runDir)!);
    expect(text).toContain("1.0k in · 200 out · 50 cache write · 900 cache read");
    expect(text).not.toContain("declared (host session)");
  });

  test("unmetered attempts are counted apart and never summed into the total", () => {
    const ws = readingWorkspace(50);
    const log = EventLog.forRun(ws.runDir);
    log.append(agentResult("alpha", { run: ws.runId, cost_usd: 2, payload: { phase: "01-what", task: "t1", metered: false } }));
    const cost = buildRunCost(ws.runDir);
    expect(cost?.usd).toBe(0);
    expect(cost?.unmeteredAttempts).toBe(1);
    expect(renderRunCost(cost!)).toContain("UNMETERED");
  });
});

describe("tldrx run estimate (N7)", () => {
  test("the prompt half is measured off the same assembly next would build", () => {
    const ws = seededWorkspace();
    const estimate = estimateNextStage(ws.root, ws.runId);
    expect(estimate.stage).toBe("alpha");
    expect(estimate.promptBytes).toBe(estimate.ledger.totalBytes);
    expect(estimate.promptTokens).toBe(estimateTokensFromBytes(estimate.promptBytes));
  });

  test("with no history there is no output estimate, and it says so", () => {
    const ws = seededWorkspace();
    const estimate = estimateNextStage(ws.root, ws.runId);
    expect(estimate.medianOutputTokens).toBeNull();
    expect(estimate.medianCacheWriteTokens).toBeNull();
    expect(estimate.medianCacheReadTokens).toBeNull();
    expect(estimate.historyBasis).toBe("none");
    expect(estimate.usd).toBeNull();
    const text = renderEstimate(estimate);
    expect(text).toContain("no past attempt at a stage with this id");
    // The input half stays measured, and the cache half says it has no data
    // rather than quietly pricing a zero.
    expect(text).toContain("cache traffic not modelled — first attempt of this kind");
    expect(text).not.toContain("cache write ~");
  });

  test("with history it prices the median, and calls itself an estimate", () => {
    const ws = seededWorkspace();
    const log = EventLog.forRun(ws.runDir);
    for (const out of [100, 300, 200]) {
      log.append(agentResult("alpha", {
        run: ws.runId,
        payload: {
          phase: "01-what", task: "t1", model: "sonnet",
          usage: { input_tokens: 1, output_tokens: out },
        },
      }));
    }
    expect(outputTokensForStage(ws.root, "alpha")).toEqual([100, 200, 300]);

    const estimate = estimateNextStage(ws.root, ws.runId);
    expect(estimate.medianOutputTokens).toBe(200);
    expect(estimate.sampleSize).toBe(3);
    expect(estimate.usd).toBeGreaterThan(0);
    const text = renderEstimate(estimate);
    expect(text).toContain("ESTIMATE: $");
    expect(text).toContain("[assumption] dated 2026-08-29");
  });

  /**
   * The 2026-08-30 bug, as a fixture. A real What stage was estimated at $0.33
   * and cost $1.70 — 5x — because the formula priced input + output only. These
   * are that attempt's four counters, and the point of the test is that the
   * money is in the two columns the old formula could not see.
   */
  const REAL_LEDGER = {
    input_tokens: 56, output_tokens: 29_000,
    cache_creation_input_tokens: 166_300, cache_read_input_tokens: 3_747_100,
  };

  function withHistory(stage = "alpha", usage: Record<string, number> = REAL_LEDGER) {
    const ws = seededWorkspace();
    EventLog.forRun(ws.runDir).append(agentResult(stage, {
      run: ws.runId,
      payload: { phase: "01-what", task: "t1", model: "sonnet", usage },
    }));
    return ws;
  }

  test("cache write and cache read are priced, and are most of the bill", () => {
    const ws = withHistory();
    const estimate = estimateNextStage(ws.root, ws.runId);

    expect(estimate.historyBasis).toBe("stage");
    expect(estimate.medianCacheWriteTokens).toBe(166_300);
    expect(estimate.medianCacheReadTokens).toBe(3_747_100);
    expect(estimate.medianOutputTokens).toBe(29_000);

    const price = priceFor(estimate.model);
    expect(price).not.toBeNull();
    const perM = (t: number, rate: number) => (t / 1_000_000) * rate;
    const input = perM(estimate.promptTokens, price!.inputUsdPerMTok);
    const write = perM(166_300, price!.inputUsdPerMTok * CACHE_WRITE_MULTIPLIER);
    const read = perM(3_747_100, price!.inputUsdPerMTok * CACHE_READ_MULTIPLIER);
    const out = perM(29_000, price!.outputUsdPerMTok);

    expect(estimate.cacheWriteUsd).toBeCloseTo(write, 2);
    expect(estimate.cacheReadUsd).toBeCloseTo(read, 2);
    expect(estimate.usd).toBeCloseTo(input + write + read + out, 2);
    // Cache traffic is the majority of the estimate, not a rounding term.
    expect((write + read) / (estimate.usd ?? 1)).toBeGreaterThan(0.5);
  });

  test("the OLD input+output formula is pinned as WRONG — it under-counts several-fold", () => {
    const ws = withHistory();
    const estimate = estimateNextStage(ws.root, ws.runId);
    const price = priceFor(estimate.model)!;

    // Exactly what estimateView computed before this fix: input + output, no cache.
    const oldFormula = (estimate.promptTokens / 1_000_000) * price.inputUsdPerMTok
      + (29_000 / 1_000_000) * price.outputUsdPerMTok;

    expect(estimate.usd).not.toBeCloseTo(oldFormula, 2);
    expect(estimate.usd!).toBeGreaterThan(oldFormula * 3);
  });

  test("the breakdown names all four terms in tokens and ends in the total", () => {
    const ws = withHistory();
    const text = renderEstimate(estimateNextStage(ws.root, ws.runId));
    expect(text).toContain("cache write ~166k");
    expect(text).toContain("cache read ~3,747k");
    expect(text).toContain("output ~29k");
    expect(text).toMatch(/input ~\d[\d,]*k? · cache write ~166k · cache read ~3,747k · output ~29k → ~\$/);
    expect(text).toContain("ESTIMATE: $");
    expect(text).toContain("cache write");
    expect(text).toContain("[assumption] dated 2026-08-29");
  });

  test("with no attempt at this stage it falls back to any stage, and says which", () => {
    const ws = withHistory("beta");
    const estimate = estimateNextStage(ws.root, ws.runId);
    expect(estimate.historyBasis).toBe("workspace");
    expect(estimate.medianCacheReadTokens).toBe(3_747_100);
    const text = renderEstimate(estimate);
    expect(text).toContain("no past attempt at `alpha`");
    expect(text).toContain("at ANY stage here");
    expect(text).toContain("a weaker basis, stated as one");
  });

  test("the same-stage sample wins over the workspace-wide one", () => {
    const ws = seededWorkspace();
    const log = EventLog.forRun(ws.runDir);
    log.append(agentResult("alpha", {
      run: ws.runId,
      payload: { phase: "01-what", task: "t1", model: "sonnet", usage: REAL_LEDGER },
    }));
    log.append(agentResult("beta", {
      run: ws.runId,
      payload: {
        phase: "01-what", task: "t1", model: "sonnet",
        usage: { input_tokens: 1, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 9 },
      },
    }));
    const estimate = estimateNextStage(ws.root, ws.runId);
    expect(estimate.historyBasis).toBe("stage");
    expect(estimate.sampleSize).toBe(1);
    expect(estimate.medianCacheReadTokens).toBe(3_747_100);
  });

  test("attemptTokensForStage carries all four counters, and null means any stage", () => {
    const ws = withHistory();
    expect(attemptTokensForStage(ws.root, "alpha")).toEqual([
      { input: 56, output: 29_000, cacheCreation: 166_300, cacheRead: 3_747_100 },
    ]);
    expect(attemptTokensForStage(ws.root, "nothing-by-this-name")).toEqual([]);
    expect(attemptTokensForStage(ws.root, null).length).toBe(1);
  });

  test("median handles both parities and an empty sample", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("the price/context table (N7)", () => {
  test("family names resolve, longest first, and unknown models return null", () => {
    expect(priceFor("sonnet")?.id).toBe("sonnet");
    expect(priceFor("claude-haiku-4-5-20251001")?.id).toBe("haiku");
    expect(priceFor("opus[1m]")?.id).toBe("opus[1m]");
    expect(priceFor("gpt-nothing")).toBeNull();
    expect(priceFor(null)).toBeNull();
  });

  test("the 1m variants carry their own window and everything else the default", () => {
    // Measured: `modelUsage["claude-haiku-4-5-20251001"].contextWindow` was
    // 200000 on the real 2026-08-29 call (test/fixtures/agent/stream-json.jsonl).
    expect(contextTokensFor("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextTokensFor("sonnet[1m]")).toBe(1_000_000);
    expect(contextTokensFor("something-unknown")).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------

import {
  buildDeveloperPrompt, orderTouches, MAX_TOUCHED_BYTES, VALIDATE_CRITERION_RULE,
} from "../src/core/build/prompts.ts";
import { NOT_IN_WORKTREE } from "../src/core/facilitator/prompt.ts";
import type { PlannedEpic, PlannedStory } from "../src/core/build/plan.ts";

let worktrees: string[] = [];
afterEach(() => {
  for (const dir of worktrees) rmSync(dir, { recursive: true, force: true });
  worktrees = [];
});

/** A throwaway directory standing in for a story's worktree. */
function worktree(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-touches-"));
  worktrees.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}

const EPIC: PlannedEpic = {
  epic: {
    version: 1, id: "E1", title: "The decisions run", repos: ["app"],
    stories: ["S1"], branch: "epic/260830-decisions", status: "todo",
  },
  text: "# E1\n",
  path: "/nowhere/E1.md",
  rel: "04-build/implicit-plan.yml",
};

function planned(touches: readonly string[], goal: readonly string[] = []): PlannedStory {
  return {
    story: {
      version: 1, id: "S1", epic: "E1", title: "Settle what the owner answered",
      repo: "app", status: "todo", depends_on: [], touches,
      acceptance: ["no touched decision still reads Status: proposed"],
      test_plan: ["$ npm run lint -> exit 0"],
      evidence: [],
    },
    dod: { present: true, commands: ["npm run lint"] },
    text: "# S1\n",
    path: "/nowhere/S1.md",
    rel: "04-build/implicit-plan.yml",
    wave: "W1",
    goal,
  };
}

function developerPrompt(
  story: PlannedStory,
  dir: string,
  notInWorktree?: ReadonlySet<string>,
): string {
  return buildDeveloperPrompt({
    runId: "260830-decisions",
    story,
    epic: EPIC,
    repoName: "app",
    branch: "story/260830-decisions/S1",
    epicBranch: "epic/260830-decisions",
    worktree: dir,
    commands: ["npm run lint"],
    conventions: "_none_",
    facts: "_none_",
    experts: [],
    budgetUsd: 4,
    notInWorktree,
  });
}

/** `bytes` bytes whose last line is findable. */
function sized(name: string, bytes: number): string {
  return document(name, bytes, `${name}-LAST-LINE`);
}

describe("the developer prompt tells the truth about its inputs (N7)", () => {
  test("an input the worktree cannot read is flagged, not passed off as a new file", () => {
    const dir = worktree({ "docs/guide.md": "# Guide\n" });
    const text = developerPrompt(
      planned(["docs/guide.md", "tldrx-work/260830-decisions/run.yml"]),
      dir,
      new Set(["tldrx-work/260830-decisions/run.yml"]),
    );
    expect(text).toContain(NOT_IN_WORKTREE);
    expect(text).not.toContain("does not exist yet — this story creates it");
    expect(text).toContain("Inlined below: 3 of 4 declared inputs.");
    expect(text).toContain("tldrx-work/260830-decisions/run.yml (NOT in this worktree)");
  });

  test("a path that exists nowhere is still `this story creates it`", () => {
    const dir = worktree({ "docs/guide.md": "# Guide\n" });
    const text = developerPrompt(planned(["docs/guide.md", "docs/new.md"]), dir);
    expect(text).toContain("does not exist yet — this story creates it");
    expect(text).not.toContain(NOT_IN_WORKTREE);
  });

  test("touched docs the goal NAMES win the inline budget over an incidental citation", () => {
    // The measured shape: `AGENTS.md` was cited once in passing and inlined; the
    // two documents the goal named were in the tail and were not.
    const dir = worktree({
      "AGENTS.md": sized("AGENTS.md", 50_000),
      "docs/10-domain.md": sized("docs/10-domain.md", 20_000),
      "docs/12-delivery.md": sized("docs/12-delivery.md", 20_000),
    });
    const touches = ["AGENTS.md", "docs/10-domain.md", "docs/12-delivery.md"];
    expect(50_000 + 20_000).toBeGreaterThan(MAX_TOUCHED_BYTES);

    const goal = ["Apply F010 to `docs/10-domain.md` and `docs/12-delivery.md`"];
    const named = developerPrompt(planned(touches, goal), dir);
    expect(named).toContain("docs/10-domain.md-LAST-LINE");
    expect(named).toContain("docs/12-delivery.md-LAST-LINE");
    expect(named).not.toContain("AGENTS.md-LAST-LINE");
    expect(named).toContain("guess: AGENTS.md");
    expect(named).toContain("_Not inlined: 50000 bytes, past this stage's inline budget.");

    // Same three files, a goal that names none of them: declaration order wins
    // and the two documents are the ones that fall off.
    const incidental = developerPrompt(planned(touches), dir);
    expect(incidental).toContain("AGENTS.md-LAST-LINE");
    expect(incidental).not.toContain("docs/10-domain.md-LAST-LINE");
    expect(incidental).not.toContain("docs/12-delivery.md-LAST-LINE");
  });

  test("the developer is told to run an embedded criterion before it edits anything", () => {
    // A real criterion on 2026-08-30 embedded a literal grep whose markers had
    // been written three ways: it scored 0 against two files that still held five
    // real markers, and only a hand count caught it.
    const text = developerPrompt(planned(["docs/guide.md"]), worktree({ "docs/guide.md": "# Guide\n" }));
    expect(text).toContain(VALIDATE_CRITERION_RULE.join("\n   "));
    expect(text).toContain("must be validated BEFORE");
    expect(text).toContain("the criterion is broken — measure the real inventory");
    expect(text).toContain("(the criterion text itself is");
    // It sits in Investigate, before the step that writes anything.
    expect(text.indexOf("must be validated BEFORE"))
      .toBeLessThan(text.indexOf("Write the tests the test plan promised"));
  });

  test("orderTouches is stable and matches on the path or its file name", () => {
    const touches = ["AGENTS.md", "docs/10-domain.md", "docs/12-delivery.md"];
    expect(orderTouches(touches, [])).toEqual(touches);
    expect(orderTouches(touches, ["nothing here names a file"])).toEqual(touches);
    expect(orderTouches(touches, ["settle docs/12-delivery.md"]))
      .toEqual(["docs/12-delivery.md", "AGENTS.md", "docs/10-domain.md"]);
    // The bare file name is how a bullet usually cites a document.
    expect(orderTouches(touches, ["settle 10-domain.md and 12-delivery.md"]))
      .toEqual(["docs/10-domain.md", "docs/12-delivery.md", "AGENTS.md"]);
  });
});
