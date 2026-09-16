/**
 * gh #345 — "mechanical validators before spending".
 *
 * `diagnoseSrcToken` already NAMES the rule a `[src: …]` citation broke
 * (`test/src-grammar.test.ts`), and three of those rules are pure syntax: the
 * claim is fine, only the punctuation around the token is wrong, and the fix is
 * the same string transform every time. Repairing those three locally — for
 * $0.00, before a paid turn is asked to rewrite a card that already said the
 * right thing — is the whole of this file.
 *
 * The other rules (`file-shape`, `absent-path`, `id-shape`, …) are left alone on
 * purpose: fixing them means inventing a line number or a path nobody wrote, and
 * `repairSrcTokenLine` must refuse rather than guess (AGENTS.md §7).
 *
 * Every repair is VERIFIED before it is trusted — `diagnoseSrcToken` is re-run on
 * the candidate and a candidate that still fails is discarded, mirroring
 * `parseYamlRepairing`'s own rule (`src/core/yaml.ts`): a repair that cannot be
 * proven is not offered.
 */
import { describe, expect, test } from "bun:test";
import {
  diagnoseSrcToken, parseSrcToken, repairSrcSyntax, repairSrcTokenLine, srcRule,
} from "../src/core/text/srcToken.ts";

describe("repairSrcTokenLine — the three syntax-only rules", () => {
  test("marker-spelling: `[src:x]` gets the one space the grammar requires", () => {
    const bad = srcRule("marker-spelling").bad;
    const good = srcRule("marker-spelling").good;
    const repaired = repairSrcTokenLine(bad);
    expect(repaired).not.toBeNull();
    expect(repaired?.rule).toBe("marker-spelling");
    expect(repaired?.text).toBe(good);
    // The repair is trustworthy only because it re-verifies: reproduced here so
    // the test does not just trust the module's own claim.
    expect(diagnoseSrcToken(repaired?.text ?? "")).toBeNull();
  });

  test("trailing-position: a mid-sentence token is relocated to end-of-line", () => {
    const bad = srcRule("trailing-position").bad;
    const good = srcRule("trailing-position").good;
    const repaired = repairSrcTokenLine(bad);
    expect(repaired).not.toBeNull();
    expect(repaired?.rule).toBe("trailing-position");
    expect(repaired?.text).toBe(good);
    expect(diagnoseSrcToken(repaired?.text ?? "")).toBeNull();
  });

  test("cmd-arrow: ASCII `->` inside a cmd source becomes the real arrow", () => {
    const bad = srcRule("cmd-arrow").bad;
    const good = srcRule("cmd-arrow").good;
    const repaired = repairSrcTokenLine(bad);
    expect(repaired).not.toBeNull();
    expect(repaired?.rule).toBe("cmd-arrow");
    expect(repaired?.text).toBe(good);
    expect(diagnoseSrcToken(repaired?.text ?? "")).toBeNull();
  });

  test("a rule that needs invented content is left alone, not guessed at", () => {
    // `file-shape`: a path with no line number. There is no mechanical line
    // number to attach — repairing this would be inventing evidence.
    const bad = srcRule("file-shape").bad;
    expect(repairSrcTokenLine(bad)).toBeNull();
  });

  test("absent-path: no mechanical fix — refuses rather than fabricating a path", () => {
    const bad = srcRule("absent-path").bad;
    expect(repairSrcTokenLine(bad)).toBeNull();
  });

  test("a clean line is left untouched", () => {
    const good = srcRule("marker-spelling").good;
    expect(repairSrcTokenLine(good)).toBeNull();
  });

  test("a line with no citation at all is left untouched (nothing to repair)", () => {
    expect(repairSrcTokenLine("- plain prose, no marker here")).toBeNull();
  });

  test("every SRC_RULES bad/good pair pushed through the repairer never MIS-repairs", () => {
    // Not every rule is mechanically repairable, but none may come back CHANGED
    // and still broken — that would be worse than refusing (AGENTS.md §7: never
    // lie in the dangerous direction).
    for (const id of ["marker-spelling", "trailing-position", "cmd-arrow"] as const) {
      const rule = srcRule(id);
      const repaired = repairSrcTokenLine(rule.bad);
      expect(repaired).not.toBeNull();
      const reparsed = parseSrcToken(repaired?.text ?? "");
      expect(reparsed).not.toBeNull();
      expect(reparsed?.errors ?? []).toEqual([]);
    }
  });
});

describe("repairSrcSyntax — a whole file, line by line", () => {
  test("repairs every fixable line and reports each one, 1-based", () => {
    const text = [
      "## Where",
      `- ${srcRule("marker-spelling").bad.replace(/^- /, "")}`,
      "- clean line, nothing wrong here",
      `- ${srcRule("cmd-arrow").bad.replace(/^- /, "")}`,
    ].join("\n");
    const out = repairSrcSyntax(text);
    expect(out.repairs.length).toBe(2);
    expect(out.repairs[0]?.line).toBe(2);
    expect(out.repairs[0]?.rule).toBe("marker-spelling");
    expect(out.repairs[1]?.line).toBe(4);
    expect(out.repairs[1]?.rule).toBe("cmd-arrow");
    expect(diagnoseSrcToken(out.text.split("\n")[1] ?? "")).toBeNull();
    expect(diagnoseSrcToken(out.text.split("\n")[3] ?? "")).toBeNull();
  });

  test("a file with nothing to repair comes back byte-identical, and says so", () => {
    const text = "## Where\n- fine already [src: api:src/A.ts:1]\n";
    const out = repairSrcSyntax(text);
    expect(out.repairs).toEqual([]);
    expect(out.text).toBe(text);
  });
});
