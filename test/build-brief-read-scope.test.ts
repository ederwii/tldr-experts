/**
 * gh #364 — the developer brief's "ONLY ones you may read" is a READ ceiling,
 * not a write one, and a real headless developer read it exactly that literally.
 *
 * Measured live, 2026-09-16, `tldrx 0.31.1`, `run auto --wait-gates --questions
 * none`: story S5's `touches` had 2 files, both inlined. `## Inputs` opened
 * with `preamble()`'s all-inlined sentence (`facilitator/prompt.ts`) — "These
 * files are the ONLY ones you may read" — and `## Investigate` step 1
 * (`build/prompts.ts`) added "They are the whole brief." The developer named a
 * port interface, a command's fields and sibling test conventions it needed
 * and could not open under that reading, asked whether to break the rule
 * instead of guessing, and produced NO diff: $0.50, and the story sat
 * `blocked` until an operator ran `story reopen` + `reject --and-continue`.
 *
 * Two rules were missing from the brief, and this file pins both:
 *
 *   (a) `touches` / the declared inputs are a WRITE allowlist. A developer in
 *       a full repo checkout with `Read`/`Grep`/`Glob` may read anything else.
 *   (b) in an unattended run (`questions_policy` resolves to anything but
 *       `human`), nobody answers a question — the brief must say so, so a
 *       developer decides and states the assumption instead of stalling.
 *
 * `preamble()`'s OTHER callers (Watch, the `What` stage's `## Inputs`, every
 * `renderInputs` caller that does not pass `role: "developer"`) are UNCHANGED:
 * for them the declared inputs really are the whole of what that sub-agent was
 * ever handed, so "the only ones you may read" was never false. One function,
 * role-aware, rather than a second `preamble` a developer prompt could drift
 * from — the default (`role` omitted) is byte-identical to before this file.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDeveloperPrompt, UNATTENDED_RULE, type DeveloperPromptParts,
} from "../src/core/build/prompts.ts";
import { preamble, renderInputs, type PromptInput } from "../src/core/facilitator/prompt.ts";
import type { PlannedEpic, PlannedStory } from "../src/core/build/plan.ts";

// ---------------------------------------------------------------------------
// (a) `preamble()` / `renderInputs()` — role-aware, one implementation
// ---------------------------------------------------------------------------

const ONE_INPUT: readonly PromptInput[] = [{ path: "src/handler.ts", content: "export const handler = 1;\n" }];

describe("preamble() is role-aware (#364)", () => {
  test("default role (every caller before #364): the all-inlined case still says ONLY — byte-identical", () => {
    const lines = preamble(ONE_INPUT).join("\n");
    expect(lines).toContain("These files are the ONLY ones you may read.");
  });

  test("role: developer, all inlined: no ONLY-may-read sentence, and the write/read split is stated", () => {
    const lines = preamble(ONE_INPUT, "developer").join("\n");
    expect(lines).not.toContain("ONLY ones you may read");
    expect(lines).toContain("WRITE allowlist, not a read allowlist");
    expect(lines).toContain("Read any other file in");
  });

  test("role: developer, some NOT inlined: still names them, AND still states the write/read split", () => {
    const bigInputs: readonly PromptInput[] = [
      { path: "src/small.ts", content: "x", totalBytes: 1, inlinedBytes: 1 },
      { path: "src/huge.ts", content: "", totalBytes: 999_999, inlinedBytes: 0 },
    ];
    const lines = renderInputs(bigInputs, undefined, undefined, "developer");
    expect(lines).toContain("src/huge.ts");
    expect(lines).toContain("WRITE allowlist, not a read allowlist");
    expect(lines).not.toContain("ONLY ones you may read");
  });

  test("renderInputs() with no role argument is unchanged (every caller before #364)", () => {
    expect(renderInputs(ONE_INPUT)).toBe(renderInputs(ONE_INPUT, undefined, undefined, "reader"));
    expect(renderInputs(ONE_INPUT)).toContain("ONLY ones you may read");
  });
});

// ---------------------------------------------------------------------------
// (a)/(b) — the real developer prompt, end to end
// ---------------------------------------------------------------------------

const EPIC: PlannedEpic = {
  epic: {
    version: 1, id: "E1", title: "One epic", repos: ["app"],
    stories: ["S1"], branch: "epic/one", status: "todo",
  },
  text: "# E1\n",
  path: "/nowhere/E1.md",
  rel: "03-plan/epics/E1.md",
};

const STORY: PlannedStory = {
  story: {
    version: 1, id: "S1", epic: "E1", title: "One story",
    repo: "app", status: "todo", depends_on: [], touches: ["src/handler.ts"],
    acceptance: ["it works"], test_plan: ["$ npm run test -> exit 0"], evidence: [],
  },
  dod: { present: true, commands: ["npm run test"] },
  text: "# S1\n",
  path: "/nowhere/S1.md",
  rel: "03-plan/stories/S1.md",
  wave: "W1",
  goal: [],
};

function devPrompt(extra: Partial<DeveloperPromptParts> = {}): string {
  return buildDeveloperPrompt({
    runId: "260916-read-scope",
    story: STORY,
    epic: EPIC,
    repoName: "app",
    branch: "story/260916-read-scope/S1",
    epicBranch: "epic/one",
    worktree: "/nowhere",
    commands: ["npm run test"],
    conventions: "_none_",
    facts: "_none_",
    experts: [],
    budgetUsd: 4,
    ...extra,
  });
}

describe("the real developer brief no longer reads as a read allowlist (#364)", () => {
  test("the ONLY-may-read sentence is gone from a real prompt whose touches are fully inlined", () => {
    const text = devPrompt();
    expect(text).not.toContain("ONLY ones you may read");
    expect(text).not.toContain("They are the whole brief.");
  });

  test("the prompt states the write/change vs read distinction, in ## Inputs and in ## Investigate", () => {
    const text = devPrompt();
    expect(text).toContain("WRITE allowlist, not a read allowlist");
    expect(text).toContain("nothing here limits what you may READ");
    expect(text).toContain("`touches` list names — that list is a WRITE allowlist");
  });
});

describe("the unattended rule (gh #364, part b)", () => {
  test("questions_policy !== human ⇒ the rule is in the prompt", () => {
    const text = devPrompt({ unattended: true });
    expect(text).toContain(UNATTENDED_RULE.join("\n   "));
    expect(text).toContain("nobody answers questions");
  });

  test("questions_policy === human (the default; `unattended` omitted) ⇒ the rule is absent, prompt unchanged", () => {
    const withFlagFalse = devPrompt({ unattended: false });
    const withFlagOmitted = devPrompt();
    expect(withFlagFalse).toBe(withFlagOmitted);
    for (const line of UNATTENDED_RULE) expect(withFlagOmitted).not.toContain(line);
    expect(withFlagOmitted).not.toContain("nobody answers questions");
  });
});
