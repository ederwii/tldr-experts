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
