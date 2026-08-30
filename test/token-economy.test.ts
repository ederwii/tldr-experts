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
