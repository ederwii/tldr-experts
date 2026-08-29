/**
 * Spec §2.8, applied to the handoffs the framework writes ITSELF.
 *
 * The rule — each of the four checked sections holds at least one list item —
 * binds every producer, not just the sub-agent. Both deterministic renderers
 * (`--from` distill, `--seed` import) have branches that used to emit an italic
 * paragraph when a section had nothing in it, which is exactly the shape the rule
 * now refuses. The empty branch is the one nothing else exercises, so it is the
 * one tested here: a `run new` that produced an invalid handoff would abort the
 * run it was creating.
 */
import { describe, expect, test } from "bun:test";
import { emptySrcContext, validateHandoff, HANDOFF_SECTIONS } from "../src/core/text/handoff.ts";
import { renderHandoff } from "../src/core/distill/renderDistill.ts";
import { renderSeedHandoff } from "../src/core/seed/renderSeed.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

const CTX = emptySrcContext(FRAMEWORK_ROOT);

describe("every generated handoff satisfies §2.8, even with nothing to say", () => {
  test("the `--from` distill handoff, with no claims, no gaps and no files read", () => {
    const text = renderHandoff({
      runId: "260830-x",
      stageId: "what",
      phase: "01-what",
      at: "2026-08-30T00:00:00Z",
      result: {
        intentDir: "/tmp/intent",
        filesRead: [],
        claims: [],
        facts: [],
        conflicts: [],
        droppedUnanswered: 0,
        droppedConflicting: 0,
        perFile: new Map(),
      },
      declaredOutputs: [],
      writtenOutputs: [],
    });
    const report = validateHandoff(text, CTX);
    expect(report.emptySections).toEqual([]);
    expect(report.unsourced).toEqual([]);
    expect(report.ok).toBe(true);
    for (const section of HANDOFF_SECTIONS) expect(text).toContain(`## ${section}`);
  });

  test("the `--seed` handoff, with no documents and no claims", () => {
    const text = renderSeedHandoff({
      runId: "260830-x",
      stageId: "what",
      phase: "01-what",
      at: "2026-08-30T00:00:00Z",
      seed: { source: "requirements.md", isDirectory: false, documents: [], skipped: [], warnings: [] },
      claims: [],
      headings: [],
    });
    const report = validateHandoff(text, CTX);
    expect(report.emptySections).toEqual([]);
    expect(report.unsourced).toEqual([]);
    expect(report.missingSections).toEqual([]);
    // `ok` is deliberately not asserted here: the Decisions bullet cites
    // `01-what/seed-index.md`, which a real run writes beside the handoff but
    // this unit test does not. The §2.8 section rule is what is under test.
    for (const section of HANDOFF_SECTIONS) expect(text).toContain(`## ${section}`);
  });
});
