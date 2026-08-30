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
