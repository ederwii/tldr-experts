/**
 * Who owns the shape of the reviewer's envelope — gh #133.
 *
 * `REVIEW_SCHEMA` is the authority. It is handed to `claude --json-schema` on the
 * spawned path (`executors/build.ts:2022`) and written verbatim into the reviewer
 * bundle as `pending.json` -> `result_schema` (`executors/build.ts:3316`), so both
 * halves of the handshake answer the same question. The PROMPT then described the
 * same envelope again, in prose, key by key — a second copy of a schema that
 * already existed, sitting in the one document a model reads most carefully. Two
 * live reviews lost cycles to it, one because the host dictated the shape from
 * memory, which is exactly what a prose paraphrase invites.
 *
 * And a bound the schema cannot express went unsaid: the verdict's summary is
 * copied into a `check.passed`/`check.failed` payload (`executors/build.ts:2331`,
 * `detail: review.summary`), and `validateEvent` refuses any payload over
 * `MAX_PAYLOAD_BYTES` = 4096 (`src/core/events/Event.ts:121,157-160`), with
 * `EventLog.append` throwing rather than writing it.
 *
 * So the prompt must REFERENCE and must not RESTATE, and the assertion for that
 * is derived from `REVIEW_SCHEMA` itself rather than hand-listed: every FIELD
 * name in the schema is a name the prompt has no business spelling. Verdict
 * WORDS are exempt — which verdict to return is a judgement, and judgement is the
 * one thing this prompt is for.
 */
import { describe, expect, test } from "bun:test";
import { buildReviewerPrompt, REVIEW_SCHEMA } from "../src/core/build/prompts.ts";
import { MAX_PAYLOAD_BYTES } from "../src/core/events/Event.ts";
import type { PlannedStory } from "../src/core/build/plan.ts";

const STORY: PlannedStory = {
  story: {
    version: 1, id: "S5", epic: "E1", title: "OTP confirm", repo: "app", status: "todo",
    depends_on: [], touches: [], acceptance: ["it confirms"], test_plan: ["unit"], evidence: [],
  },
  dod: { present: true, commands: ["npm test"] },
  text: "# S5\n", path: "/nowhere/S5.md", rel: "03-plan/stories/S5.md", wave: "W1", goal: [],
};

function reviewerPrompt(fixlistAvailable = true): string {
  return buildReviewerPrompt({
    runId: "260902-ordering-inventory",
    story: STORY,
    repoName: "app",
    branch: "story/260902/S5",
    epicBranch: "epic/leaderboard",
    worktree: "/nowhere",
    conventions: "_none_",
    dodResults: [{ command: "npm test", exitCode: 0 }],
    fixlistAvailable,
  });
}

/** The verdict words. Naming one is judgement, not shape. */
const VERDICT_WORDS: readonly string[] = REVIEW_SCHEMA.properties.verdict.enum;

/** Every field name the schema defines, top level and inside a `fixlist` row. */
const SCHEMA_FIELDS: readonly string[] = [
  ...Object.keys(REVIEW_SCHEMA.properties),
  ...Object.keys(REVIEW_SCHEMA.properties.fixlist.items.properties),
];

/** The names that are ONLY shape — the ones a prompt restating the schema spells. */
const SHAPE_ONLY_FIELDS: readonly string[] = SCHEMA_FIELDS.filter((f) => !VERDICT_WORDS.includes(f));

describe("gh #133 · the reviewer prompt points at the schema instead of paraphrasing it", () => {
  test("it names `pending.json` -> `result_schema` as the authority", () => {
    const prompt = reviewerPrompt();
    expect(prompt).toContain("result_schema");
    expect(prompt).toContain("pending.json");
    // And the spawned half, so the pointer is true in both modes of the handshake.
    expect(prompt).toContain("--json-schema");
  });

  test("it names the 4096-byte payload cap the summary has to survive", () => {
    const prompt = reviewerPrompt();
    expect(MAX_PAYLOAD_BYTES).toBe(4096);
    expect(prompt).toContain(String(MAX_PAYLOAD_BYTES));
    expect(prompt).toContain("events.jsonl");
  });

  test("it restates NO field of the schema — the drift risk, asserted off the schema", () => {
    const prompt = reviewerPrompt();
    expect(SHAPE_ONLY_FIELDS).toEqual(
      ["verdict", "summary", "findings", "n", "severity", "finding", "where", "disposition", "detail", "do_not"],
    );
    for (const field of SHAPE_ONLY_FIELDS) {
      expect(prompt).not.toContain(`\`${field}\``);
    }
  });

  test("the same holds when the third verdict is off the table", () => {
    const prompt = reviewerPrompt(false);
    expect(prompt).toContain("result_schema");
    expect(prompt).toContain(String(MAX_PAYLOAD_BYTES));
    for (const field of SHAPE_ONLY_FIELDS) {
      expect(prompt).not.toContain(`\`${field}\``);
    }
  });

  test("the judgement it IS for survives: every verdict word is still offered", () => {
    const prompt = reviewerPrompt();
    for (const word of VERDICT_WORDS) expect(prompt).toContain(`\`${word}\``);
    // #77's contract is judgement, not shape, and stays: a refuted finding is a
    // claim and carries a citation.
    expect(prompt).toContain("refuted");
    expect(prompt).toContain("[src:");
  });

  test("a withdrawn third verdict is still said out loud, not silently dropped", () => {
    const prompt = reviewerPrompt(false);
    expect(prompt).toContain("fixlist");
    expect(prompt).toContain("NOT available");
  });
});
