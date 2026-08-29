import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { classifySrc, parseSrcToken } from "../src/core/text/srcToken.ts";
import { parseHandoff, validateHandoff, emptySrcContext } from "../src/core/text/handoff.ts";
import { parseQuestions, validateQuestions } from "../src/core/text/questions.ts";
import { validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
import { collectReadFiles } from "../src/core/distill/readList.ts";
import { extractProseClaims } from "../src/core/distill/markdownClaims.ts";
import { parseAidlcQuestions } from "../src/core/distill/aidlcQuestions.ts";
import { distill } from "../src/core/distill/distill.ts";
import { EXIT_OK } from "../src/cli/exitCodes.ts";
import { FIXTURE_AIDLC_INTENT, makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

/**
 * Measured against the fixture, which is three real files copied out of the pilot
 * AI-DLC intent folder. If a parser change moves these numbers, that is the point
 * of the test — look at the diff before updating them.
 */
const FIXTURE_FILES = 3;
const FIXTURE_CLAIMS = 37;
const FIXTURE_ANSWERS = 6;

async function tldrx(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

let workspace: TempRunWorkspace | null = null;
afterEach(() => {
  workspace?.dispose();
  workspace = null;
});

function fresh(options?: Parameters<typeof makeRunWorkspace>[0]): TempRunWorkspace {
  workspace = makeRunWorkspace(options);
  return workspace;
}

function onlyRunDir(root: string): string {
  const work = join(root, "tldrx-work");
  const entries = readdirSync(work).filter((name) => !name.startsWith("."));
  return join(work, entries[0] as string);
}

const NO_FACTS = { run: "260828-t", actor: "test", at: "2026-08-28T00:00:00Z", facts: [] };

describe("the §6 read list", () => {
  test("reads only the listed files and ignores the ceremony", () => {
    const files = collectReadFiles(FIXTURE_AIDLC_INTENT).map((f) => f.rel);
    expect(files).toEqual([
      "ideation/feasibility/constraint-register.md",
      "ideation/feasibility/feasibility-questions.md",
      "ideation/scope-definition/scope-document.md",
    ]);
    expect(files.join(" ")).not.toContain("memory.md");
    expect(files.join(" ")).not.toContain("aidlc-state.md");
    expect(files.join(" ")).not.toContain("team-formation");
  });
});

describe("prose extraction", () => {
  test("a bullet and a paragraph under a heading each become one claim", () => {
    const claims = extractProseClaims(["# Title", "", "## Section", "", "- a bullet claim", "", "a paragraph", "claim wrapped over two lines", ""].join("\n"));
    expect(claims.map((c) => c.text)).toEqual(["a bullet claim", "a paragraph claim wrapped over two lines"]);
    expect(claims[0]?.line).toBe(5);
    expect(claims[0]?.heading).toBe("Section");
  });

  test("content before the first heading is not a claim", () => {
    expect(extractProseClaims("orphan text\n\n## Section\n\n- kept\n")).toHaveLength(1);
  });

  test("fenced code and table rows are layout, not claims", () => {
    const text = ["## S", "", "```", "- not a claim", "```", "", "| a | b |", "", "- a claim"].join("\n");
    expect(extractProseClaims(text).map((c) => c.text)).toEqual(["a claim"]);
  });

  test("AI-DLC grounding tags are stripped from the imported text", () => {
    expect(extractProseClaims("## S\n\n- it holds [Q3] [desc]\n")[0]?.text).toBe("it holds");
  });
});

describe("the AI-DLC question format", () => {
  test("`## Q<n>. text` with a non-empty [Answer] is answered; an empty slot is not", () => {
    const parsed = parseAidlcQuestions("## Q1. First?\n\n[Answer]: D\n\n## Q2. Second?\n\n[Answer]:\n");
    expect(parsed.map((q) => [q.id, q.answer])).toEqual([["Q1", "D"], ["Q2", ""]]);
  });
});

describe("the aidlc: src production", () => {
  test("both forms parse", () => {
    expect(classifySrc("aidlc:ideation/x/intent-statement.md:12")).toMatchObject({
      kind: "aidlc", path: "ideation/x/intent-statement.md", line: 12, q: null,
    });
    expect(classifySrc("aidlc:ideation/x/intent-capture-questions.md#Q4")).toMatchObject({
      kind: "aidlc", path: "ideation/x/intent-capture-questions.md", q: "Q4", line: null,
    });
  });

  test("a bare `aidlc:` path with neither a line nor a question is rejected", () => {
    expect(classifySrc("aidlc:some/file.md")).toMatchObject({ message: expect.any(String) });
    expect(classifySrc("aidlc:../escape.md:3")).toMatchObject({ message: expect.any(String) });
  });
});

describe("distill(fixture)", () => {
  test("imports every claim and one fact per answered question", () => {
    const result = distill(FIXTURE_AIDLC_INTENT, NO_FACTS);
    expect(result.filesRead).toHaveLength(FIXTURE_FILES);
    expect(result.claims).toHaveLength(FIXTURE_CLAIMS);
    expect(result.facts).toHaveLength(FIXTURE_ANSWERS);
    expect(result.conflicts).toHaveLength(0);
    expect(result.droppedUnanswered).toBe(0);
    expect(result.droppedConflicting).toBe(0);
    for (const fact of result.facts) {
      expect(fact.kind).toBe("answer");
      expect(fact.confidence).toBe("stated");
      expect(fact.source.run).toBe("260828-t");
      expect(fact.source.q).toMatch(/^Q\d+$/);
    }
  });

  test("an answered question is tagged with #Q<n> and prose with :<line>", () => {
    const result = distill(FIXTURE_AIDLC_INTENT, NO_FACTS);
    const answer = result.claims.find((c) => c.q !== null);
    const prose = result.claims.find((c) => c.q === null);
    expect(answer?.src).toMatch(/^aidlc:.+#Q\d+$/);
    expect(prose?.src).toMatch(/^aidlc:.+:\d+$/);
  });

  test("a claim contradicting a non-retired fact is dropped and raised as a conflict", () => {
    const facts = [{
      id: "F001",
      fact: "Confirm the technical approach: build into the existing backend? — B, a separate service",
      area: "feasibility",
      repos: [],
      kind: "answer" as const,
      confidence: "stated" as const,
      source: { who: "alan", when: "2026-08-01T00:00:00Z", run: "260801-x", q: "Q2" },
      supersedes: null,
      superseded_by: null,
      retired: null,
    }];
    const result = distill(FIXTURE_AIDLC_INTENT, { ...NO_FACTS, facts });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.factId).toBe("F001");
    expect(result.conflicts[0]?.score).toBeGreaterThanOrEqual(0.6);
    expect(result.droppedConflicting).toBe(1);
    expect(result.claims).toHaveLength(FIXTURE_CLAIMS - 1);
    expect(result.facts).toHaveLength(FIXTURE_ANSWERS - 1);
  });

  test("a retired fact does not block an import", () => {
    const facts = [{
      id: "F001",
      fact: "Confirm the technical approach: build into the existing backend? — B, a separate service",
      area: "feasibility",
      repos: [],
      kind: "answer" as const,
      confidence: "stated" as const,
      source: { who: "alan", when: "2026-08-01T00:00:00Z", run: "260801-x", q: "Q2" },
      supersedes: null,
      superseded_by: null,
      retired: { at: "2026-08-20T00:00:00Z", by: "alan", reason: "changed our mind" },
    }];
    expect(distill(FIXTURE_AIDLC_INTENT, { ...NO_FACTS, facts }).conflicts).toHaveLength(0);
  });
});

describe("tldrx run new --from", () => {
  test("writes intent.md, scope.md and a valid handoff, and appends the facts", async () => {
    const ws = fresh();
    const run = await tldrx(ws.root, "run", "new", "leaderboard", "--from", FIXTURE_AIDLC_INTENT);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain(`distilled ${FIXTURE_FILES} file(s)`);
    expect(run.stdout).toContain(`${FIXTURE_CLAIMS} finding(s)`);
    expect(run.stdout).toContain(`${FIXTURE_ANSWERS} fact(s)`);

    const runDir = onlyRunDir(ws.root);
    for (const name of ["intent.md", "scope.md", "handoff.md"]) {
      expect(existsSync(join(runDir, "01-what", name))).toBe(true);
    }
    // No conflicts against an empty facts.yml, so no questions file is invented.
    expect(existsSync(join(runDir, "01-what", "questions.md"))).toBe(false);

    const handoff = readFileSync(join(runDir, "01-what", "handoff.md"), "utf8");
    const validation = validateHandoff(handoff, emptySrcContext(ws.root));
    expect(validation.missingSections).toEqual([]);
    expect(validation.unsourced).toEqual([]);
    expect(validation.unresolved).toEqual([]);

    const facts = parseYaml(readFileSync(join(ws.root, ".tldrx", "memory", "facts.yml"), "utf8")) as {
      facts: { source: { run: string } }[];
    };
    expect(validateFactsFile(facts).issues).toEqual([]);
    expect(facts.facts).toHaveLength(FIXTURE_ANSWERS);
  });

  test("every bullet in every distilled file ends with a valid src token", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--from", FIXTURE_AIDLC_INTENT);
    const runDir = onlyRunDir(ws.root);

    for (const name of ["intent.md", "scope.md", "handoff.md"]) {
      const text = readFileSync(join(runDir, "01-what", name), "utf8");
      const bullets = text.split("\n").filter((line) => line.startsWith("- "));
      expect(bullets.length).toBeGreaterThan(0);
      for (const line of bullets) {
        const token = parseSrcToken(line);
        expect(token, `no [src: …] on: ${line}`).not.toBeNull();
        expect(token?.errors, `bad token on: ${line}`).toEqual([]);
      }
    }
    // Findings + Unknowns + Evidence ledger all carry claims; Decisions is prose.
    const handoff = parseHandoff(readFileSync(join(runDir, "01-what", "handoff.md"), "utf8"));
    expect(handoff.headings).toEqual(["Findings", "Decisions", "Unknowns", "Evidence ledger"]);
    const findings = handoff.sections.find((s) => s.name === "Findings");
    expect(findings?.bullets).toHaveLength(FIXTURE_CLAIMS);
  });

  test("declared What outputs with no imported content become Unknowns", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--from", FIXTURE_AIDLC_INTENT);
    const handoff = readFileSync(join(onlyRunDir(ws.root), "01-what", "handoff.md"), "utf8");
    expect(handoff).toContain("[src: absent:01-what/success-metrics.md]");
    expect(handoff).toContain("[src: absent:01-what/open-questions.md]");
    // handoff.md and questions.md are process artefacts, not content gaps.
    expect(handoff).not.toContain("absent:01-what/handoff.md");
  });

  test("a conflict becomes a §2.7-valid question rather than a silent drop", async () => {
    const ws = fresh({
      facts: `version: 1
facts:
  - id: F001
    fact: "Confirm the technical approach: build into the existing backend? — B, a separate service"
    area: feasibility
    repos: []
    kind: answer
    confidence: stated
    source: {who: alan, when: "2026-08-01T00:00:00Z", run: 260801-x, q: Q2}
    supersedes: null
    superseded_by: null
    retired: null
`,
    });
    const run = await tldrx(ws.root, "run", "new", "leaderboard", "--from", FIXTURE_AIDLC_INTENT);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("1 question(s)");
    expect(run.stdout).toContain("1 conflicting");

    const path = join(onlyRunDir(ws.root), "01-what", "questions.md");
    expect(existsSync(path)).toBe(true);
    const doc = parseQuestions(readFileSync(path, "utf8"));
    expect(validateQuestions(doc)).toEqual([]);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.metadata?.status).toBe("open");
    expect(doc.blocks[0]?.whySrc?.errors).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("F001");
  });

  test("the distill is deterministic — the same folder twice gives the same bytes", async () => {
    const a = fresh();
    await tldrx(a.root, "run", "new", "one", "--from", FIXTURE_AIDLC_INTENT);
    const first = readFileSync(join(onlyRunDir(a.root), "01-what", "intent.md"), "utf8");
    a.dispose();

    const b = fresh();
    await tldrx(b.root, "run", "new", "one", "--from", FIXTURE_AIDLC_INTENT);
    const second = readFileSync(join(onlyRunDir(b.root), "01-what", "intent.md"), "utf8");
    expect(second).toBe(first);
  });
});
