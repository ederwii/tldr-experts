/**
 * gh #77 — a `[src: …]` rejection states the RULE it enforced, and the grammar is
 * documented where the writers read.
 *
 * Run `260830-ordering-inventory` lost three story attempts to one message. The
 * check said "no `[src: …]`" — the SYMPTOM — and the host guessed the grammar
 * twice before reading `dist/tldrx.js` to extract three rules nothing had ever
 * written down: the token must END its line, a `]` inside it truncates the match,
 * and a `cmd` src needs the real `→` and not `->`.
 *
 * Two guarantees are measured here, and they are the two the issue asks for:
 *
 *   1. every rejection on this path NAMES the rule it enforced, QUOTES the
 *      offending line, and shows a line that would pass;
 *   2. the documented grammar is GENERATED from the same patterns the reader
 *      runs — the #35 precedent. The trap is behavioural, not textual: every
 *      example in the doc is pushed back through the live parser, so loosening a
 *      regex without updating the rule turns this file red rather than shipping a
 *      doc that lies.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  diagnoseSrcToken, describeSrcFailure, parseSrcToken, srcRule,
  SRC_PATTERNS, SRC_RULE_IDS, SRC_RULES, SRC_SEPARATOR, readableSource,
} from "../src/core/text/srcToken.ts";
import {
  BULLET_CAP_RULE, BULLET_RULE, EMPTY_SECTION_RULE, HANDOFF_SECTIONS, MAX_BULLETS,
} from "../src/core/text/handoff.ts";
import {
  SRC_GRAMMAR_HEADING, renderSrcGrammarContract,
} from "../src/core/text/srcGrammarContract.ts";
import { checkContractsFor } from "../src/core/facilitator/checkContracts.ts";
import {
  claimSourcesDeny, claimSourcesEmptySectionDeny, claimSourcesMalformedDeny,
  claimSourcesUnresolvedDeny,
} from "../src/hooks/lib/messages.ts";
import { parseFixFindings } from "../src/core/build/fixlist.ts";
import { buildReviewerPrompt } from "../src/core/build/prompts.ts";
import { runCheck } from "../src/core/run/checks.ts";
import type { PlannedCheck, PlannedStage } from "../src/core/run/workflowPreset.ts";
import type { PlannedStory } from "../src/core/build/plan.ts";
import { clearSrcCaches } from "../src/core/text/index.ts";
import { makeWorkspace, type TempWorkspace } from "./fixtures/tempWorkspace.ts";

let ws: TempWorkspace | null = null;
function workspace(): TempWorkspace {
  ws ??= makeWorkspace();
  return ws;
}
afterEach(() => {
  ws?.dispose();
  ws = null;
  clearSrcCaches();
});

// --- 1. the registry is the grammar, and the examples are run, not asserted ---

describe("the rule registry cannot drift from the reader", () => {
  test("every declared id has exactly one rule, and every rule a declared id", () => {
    const ids = SRC_RULES.map((rule) => rule.id);
    expect([...ids].sort()).toEqual([...SRC_RULE_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("each rule's `bad` example is diagnosed as THAT rule, by the live reader", () => {
    for (const rule of SRC_RULES) {
      const failure = diagnoseSrcToken(rule.bad);
      expect(failure, `no failure diagnosed for ${rule.id}: ${rule.bad}`).not.toBeNull();
      expect(failure?.rule.id, `wrong rule for ${rule.id}: ${rule.bad}`).toBe(rule.id);
    }
  });

  test("each rule's `good` example parses clean, so the fix it offers is a real one", () => {
    for (const rule of SRC_RULES) {
      expect(diagnoseSrcToken(rule.good), `${rule.id} good still fails`).toBeNull();
      const token = parseSrcToken(rule.good);
      expect(token, `${rule.id} good has no token`).not.toBeNull();
      expect(token?.errors ?? [], `${rule.id} good has parse errors`).toEqual([]);
      expect((token?.refs ?? []).length, `${rule.id} good cites nothing`).toBeGreaterThan(0);
    }
  });

  test("a line that carries no citation at all is not a grammar failure", () => {
    expect(diagnoseSrcToken("- the selector drops low-quality places")).toBeNull();
  });

  test("the three rules #77 paid to discover are named rules", () => {
    // Trailing position: the token must END the line (`citesSomething` and the
    // handoff parser both read whole lines).
    const mid = diagnoseSrcToken("- it drops places [src: api:src/Sel.ts:2] before ranking");
    expect(mid?.rule.id).toBe("trailing-position");

    // `[^\]]*`: a nested `]` truncates the match. The live case quoted a pid list.
    const nested = diagnoseSrcToken("- four pids skipped [src: api:src/Sweep.ts:88 (pids: [119,120])]");
    expect(nested?.rule.id).toBe("no-bracket-inside");

    // The arrow is U+2192, never ASCII `->`.
    const ascii = diagnoseSrcToken("- the suite is green [src: $ bun test -> exit 0]");
    expect(ascii?.rule.id).toBe("cmd-arrow");
  });
});

// --- 2. the generated doc ------------------------------------------------------

describe("the documented grammar is generated from the reader's own patterns", () => {
  const doc = renderSrcGrammarContract();

  test("it carries the live patterns, verbatim — edit a regex and the doc moves", () => {
    expect(doc).toContain(readableSource(SRC_PATTERNS.trailingToken));
    expect(doc).toContain(readableSource(SRC_PATTERNS.cmd));
    expect(doc).toContain(readableSource(SRC_PATTERNS.fact));
    expect(doc).toContain(readableSource(SRC_PATTERNS.answer));
    expect(doc).toContain(`\`${SRC_SEPARATOR}\``);
  });

  test("every rule appears with its id, its refusal and its correction", () => {
    for (const rule of SRC_RULES) {
      expect(doc, `${rule.id} missing from the contract`).toContain(rule.id);
      expect(doc, `${rule.id} bad example missing`).toContain(rule.bad);
      expect(doc, `${rule.id} good example missing`).toContain(rule.good);
      for (const pattern of rule.enforcedBy) {
        expect(doc, `${rule.id} enforcedBy ${pattern} missing`).toContain(pattern);
      }
    }
  });

  test("the section rules come from the same constants the check reads", () => {
    for (const name of HANDOFF_SECTIONS) expect(doc).toContain(name);
    expect(doc).toContain(String(MAX_BULLETS));
    expect(doc).toContain(BULLET_RULE);
    expect(doc).toContain(EMPTY_SECTION_RULE);
    expect(doc).toContain(BULLET_CAP_RULE);
  });

  test("the arrow the doc prints is the arrow the regex demands", () => {
    expect(readableSource(SRC_PATTERNS.cmd)).toContain("→");
    expect(doc).toContain("→");
    expect(doc).toContain("->");
  });
});

// --- 3. every rejection names the rule, quotes the line, shows the fix ---------

describe("a rejection states the rule it enforced", () => {
  const BAD_TRAILING = "- it drops places [src: api:src/Sel.ts:2] before ranking";
  const text = ["# Handoff", "", "## Findings", "", BAD_TRAILING, ""].join("\n");

  test("malformed: the rule, the line as written, and a line that would pass", () => {
    const message = claimSourcesMalformedDeny(
      "tldrx-work/r/02-how/handoff.md",
      [{ line: 5, message: "malformed citation", rule: "trailing-position" }],
      text,
    );
    expect(message).toContain("trailing-position");
    expect(message).toContain(srcRule("trailing-position").rule);
    expect(message).toContain(BAD_TRAILING);
    expect(message).toContain(srcRule("trailing-position").good);
    // The symptom alone is exactly what #77 was filed for.
    expect(message).not.toBe("[tldrx] claim-sources: no [src: …]");
  });

  test("a nested `]` is refused by name, not as 'the token must be last'", () => {
    const nested = "- four pids skipped [src: api:src/Sweep.ts:88 (pids: [119,120])]";
    const body = ["# Handoff", "", "## Findings", "", nested, ""].join("\n");
    const message = claimSourcesMalformedDeny(
      "tldrx-work/r/02-how/handoff.md",
      [{ line: 5, message: "malformed citation", rule: "no-bracket-inside" }],
      body,
    );
    expect(message).toContain("no-bracket-inside");
    expect(message).toContain(nested);
    expect(message).toContain(srcRule("no-bracket-inside").good);
  });

  test("unresolvable: an ASCII arrow is named `cmd-arrow`, with the → correction", () => {
    const ascii = "- the suite is green [src: $ bun test -> exit 0]";
    const body = ["# Handoff", "", "## Evidence ledger", "", ascii, ""].join("\n");
    const message = claimSourcesUnresolvedDeny(
      "tldrx-work/r/02-how/handoff.md",
      [{ line: 5, message: "[src: $ bun test -> exit 0] — bad", rule: "cmd-arrow" }],
      body,
    );
    expect(message).toContain("cmd-arrow");
    expect(message).toContain(ascii);
    expect(message).toContain(srcRule("cmd-arrow").good);
  });

  test("unsourced: the bullet rule is named and the bullet is quoted back", () => {
    const bare = "- the selector drops low-quality places";
    const body = ["# Handoff", "", "## Findings", "", bare, ""].join("\n");
    const message = claimSourcesDeny("tldrx-work/r/02-how/handoff.md", [5], body);
    expect(message).toContain(BULLET_RULE);
    expect(message).toContain(bare);
    expect(message).toContain("[src:");
  });

  test("an empty section names the rule it broke", () => {
    const message = claimSourcesEmptySectionDeny("tldrx-work/r/02-how/handoff.md", [
      { name: "Unknowns", line: 12 },
    ]);
    expect(message).toContain(EMPTY_SECTION_RULE);
    expect(message).toContain("Unknowns");
    expect(message).toContain("- none [src: absent:");
  });
});

// --- 4. the gate-time check says it too ---------------------------------------

describe("the gate re-check names the rule that fired", () => {
  const CHECK: PlannedCheck = { id: "claim-sources", on: "gate", repo: null, command: null, expect_exit: 0 };

  function stage(outputs: readonly string[]): PlannedStage {
    return {
      id: "contracts", title: "Contracts", phase: "02-how", model: null, effort: null,
      experts: [], budget_usd: 1, timeout_s: 60, inputs: [], outputs,
      sections: new Map(), gateType: "approve", checks: [CHECK], preconditions: [],
      questionsPath: null, source: "test",
    };
  }

  test("a mid-sentence token is reported as `trailing-position`, with the line", async () => {
    const w = workspace();
    const path = join(w.runDir, "02-how/handoff.md");
    mkdirSync(join(path, ".."), { recursive: true });
    const bad = "- it drops places [src: api:src/Hunt.cs:1] before ranking";
    writeFileSync(path, [
      "# Handoff", "",
      "## Findings", "", bad, "",
      "## Decisions", "", "- fine [src: api:src/Hunt.cs:1]", "",
      "## Unknowns", "", "- fine [src: api:src/Hunt.cs:1]", "",
      "## Evidence ledger", "", "- fine [src: api:src/Hunt.cs:1]", "",
    ].join("\n"));
    const outcome = await runCheck(CHECK, { root: w.root, runDir: w.runDir, stage: stage(["02-how/handoff.md"]) });
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("trailing-position");
  });
});

// --- 5. the reviewer's own verdict is a claim ---------------------------------

describe("a refuted finding with no readable citation is told which rule broke", () => {
  test("the arrow case names `cmd-arrow` and quotes what the reviewer wrote", () => {
    const parsed = parseFixFindings([{
      finding: "the retry cap is off by one",
      disposition: "refuted",
      where: "src/Retry.ts",
      detail: "the suite covers it [src: $ bun test -> exit 0]",
    }]);
    expect(parsed.findings).toEqual([]);
    const problem = parsed.problems.join("\n");
    expect(problem).toContain("cmd-arrow");
    expect(problem).toContain("[src: $ bun test -> exit 0]");
    expect(problem).toContain(srcRule("cmd-arrow").good);
  });

  test("a refutation that cited nothing at all still gets the grammar, not the symptom", () => {
    const parsed = parseFixFindings([{
      finding: "the retry cap is off by one",
      disposition: "refuted",
      where: "src/Retry.ts",
      detail: "I read it and it is fine",
    }]);
    expect(parsed.findings).toEqual([]);
    const problem = parsed.problems.join("\n");
    expect(problem).toContain("must END with a `[src: …]` token that parses");
    expect(problem).toContain(srcRule("file-shape").good);
    // And it points at the section the reviewer was actually handed.
    expect(problem).toContain(SRC_GRAMMAR_HEADING);
  });
});

// --- 6. the grammar reaches the writers ---------------------------------------

describe("the contract is spliced into what the writers actually receive", () => {
  test("a stage declaring claim-sources over .md outputs publishes the grammar", () => {
    const contracts = checkContractsFor({ checks: ["claim-sources"], outputs: ["handoff.md"] });
    const grammar = contracts.find((c) => c.check === "claim-sources");
    expect(grammar).toBeDefined();
    expect(grammar?.heading).toBe(SRC_GRAMMAR_HEADING);
    expect(grammar?.body).toContain("trailing-position");
  });

  test("a stage with no markdown output pays nothing for it", () => {
    const contracts = checkContractsFor({ checks: ["claim-sources"], outputs: ["waves.yml"] });
    expect(contracts.find((c) => c.check === "claim-sources")).toBeUndefined();
  });

  test("the reviewer prompt carries the grammar its `refuted` verdict is held to", () => {
    const story: PlannedStory = {
      story: {
        version: 1, id: "S5", epic: "E1", title: "OTP confirm", repo: "app", status: "todo",
        depends_on: [], touches: [], acceptance: ["it confirms"], test_plan: ["unit"], evidence: [],
      },
      dod: { present: true, commands: ["npm test"] },
      text: "# S5\n", path: "/nowhere/S5.md", rel: "03-plan/stories/S5.md", wave: "W1", goal: [],
    };
    const prompt = buildReviewerPrompt({
      runId: "260830-ordering-inventory",
      story, repoName: "app",
      branch: "story/260830/S5", epicBranch: "epic/leaderboard", worktree: "/nowhere",
      conventions: "_none_", dodResults: [], fixlistAvailable: true,
    });
    expect(prompt).toContain("trailing-position");
    expect(prompt).toContain(srcRule("cmd-arrow").good);
  });
});

// --- 7. the rendered failure is readable ---------------------------------------

describe("describeSrcFailure", () => {
  test("names the rule, quotes the line, and offers a corrected one", () => {
    const failure = diagnoseSrcToken("- it drops places [src: api:src/Sel.ts:2] before ranking");
    expect(failure).not.toBeNull();
    const rendered = describeSrcFailure(failure as NonNullable<typeof failure>);
    expect(rendered).toContain("trailing-position");
    expect(rendered).toContain("- it drops places [src: api:src/Sel.ts:2] before ranking");
    expect(rendered).toContain(srcRule("trailing-position").good);
  });
});
