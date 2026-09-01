import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseQuestions, serializeQuestions, renderQuestionBlock, recordAnswer, replaceBlock,
  detectAnswered, openBlocks, validateQuestions,
} from "../src/core/text/questions.ts";
import {
  parseHandoff, validateHandoff, isHandoff, missingSections, noneBullet, HANDOFF_SECTIONS,
} from "../src/core/text/handoff.ts";
import {
  classifySrc, parseSrcToken, emptySrcContext, resolveSrc, type SrcContext,
} from "../src/core/text/srcToken.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { isLive, isRetired, isSuperseded, type Fact } from "../src/core/facts/Fact.ts";
import { findDuplicate, jaccard, tokenize } from "../src/core/facts/findDuplicate.ts";
import { emitFactsYaml } from "../src/core/facts/emitFactsYaml.ts";
import { validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent, serializeEvent, EVENT_KEYS, type TldrxEvent } from "../src/core/events/Event.ts";
import { loadBudget } from "../src/core/budget/loadBudget.ts";
import { remaining, wouldExceed, totalSpent } from "../src/core/budget/wouldExceed.ts";
import { validateRunBudget } from "../src/core/budget/RunBudget.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { makeWorkspace, FIXTURE_WORKSPACE, FIXTURE_RUN } from "./fixtures/tempWorkspace.ts";
import { fastestOf, perfBudgetMs } from "./fixtures/machineLoad.ts";

const RUN_DIR = join(FIXTURE_WORKSPACE, "tldrx-work", FIXTURE_RUN);
const HANDOFF = readFileSync(join(RUN_DIR, "02-how", "handoff.md"), "utf8");
const QUESTIONS = readFileSync(join(RUN_DIR, "02-how", "questions.md"), "utf8");
const CTX = toSrcContext(loadWorkspace(FIXTURE_WORKSPACE));

describe("questions.md (spec §2.7)", () => {
  test("round-trips byte for byte", () => {
    expect(serializeQuestions(parseQuestions(QUESTIONS))).toBe(QUESTIONS);
  });

  test("parses every element of a block", () => {
    const [q4, q5] = parseQuestions(QUESTIONS).blocks;
    expect(q4?.id).toBe("Q4");
    expect(q4?.title).toBe("Where does leaderboard state live?");
    expect(q4?.metadata?.status).toBe("open");
    expect(q4?.metadata?.area).toBe("data-model");
    expect(q4?.metadata?.asked_by).toBe("architect");
    expect(q4?.whyAsked).toStartWith("no ranking store exists");
    expect(q4?.whySrc?.refs[0]).toMatchObject({ kind: "absent" });
    expect(q4?.options.map((o) => o.letter)).toEqual(["A", "B", "C"]);
    expect(q4?.answer).toBe("");
    expect(q4?.footer).toBeNull();
    expect(q5?.metadata?.status).toBe("answered");
    expect(q5?.answer).toBe("B — rankings are global, same as Places");
    expect(q5?.footer).toEqual({
      answered_by: "alan", answered_at: "2026-08-28T15:10:03Z", fact: "F021",
    });
  });

  test("the canonical rendering re-parses to the same block", () => {
    const q5 = parseQuestions(QUESTIONS).blocks[1];
    expect(q5).toBeDefined();
    const rendered = renderQuestionBlock(q5 as NonNullable<typeof q5>);
    const reparsed = parseQuestions(rendered).blocks[0];
    expect(reparsed?.id).toBe("Q5");
    expect(reparsed?.answer).toBe(q5?.answer);
    expect(reparsed?.footer).toEqual(q5?.footer ?? null);
    expect(reparsed?.options).toEqual(q5?.options ?? []);
  });

  test("detectAnswered needs status:open AND a non-empty [Answer]:", () => {
    expect(detectAnswered(parseQuestions(QUESTIONS).blocks)).toEqual([]);
    const answered = QUESTIONS.replace("[Answer]:\n", "[Answer]: B) Redis sorted set\n");
    const hits = detectAnswered(parseQuestions(answered).blocks);
    expect(hits.map((b) => b.id)).toEqual(["Q4"]);
    expect(hits[0]?.answer).toBe("B) Redis sorted set");
  });

  test("a blank [Answer]: with trailing spaces is still unanswered", () => {
    const doc = parseQuestions(QUESTIONS.replace("[Answer]:\n", "[Answer]:   \n"));
    expect(detectAnswered(doc.blocks)).toEqual([]);
    expect(openBlocks(doc.blocks).map((b) => b.id)).toEqual(["Q4"]);
  });

  test("recordAnswer flips the status, appends the footer and touches nothing else", () => {
    const doc = parseQuestions(QUESTIONS.replace("[Answer]:\n", "[Answer]: B) Redis sorted set\n"));
    const block = detectAnswered(doc.blocks)[0];
    expect(block).toBeDefined();
    const updated = recordAnswer(block as NonNullable<typeof block>, {
      answered_by: "alan", answered_at: "2026-08-29T09:00:00Z", fact: "F020",
    });
    const text = serializeQuestions(replaceBlock(doc, updated));
    expect(text).toContain("<!-- id: Q4 | status: answered | area: data-model");
    expect(text).toContain("<!-- answered_by: alan | answered_at: 2026-08-29T09:00:00Z | fact: F020 -->");
    // Q5 is untouched.
    expect(text).toContain("<!-- answered_by: alan | answered_at: 2026-08-28T15:10:03Z | fact: F021 -->");
    expect(parseQuestions(text).blocks).toHaveLength(2);
  });

  test("validation catches ids out of order, a missing source and bad options", () => {
    const broken = [
      "## Q9 · First",
      "<!-- id: Q9 | status: open | area: a | asked_by: x | asked_at: 2026-08-28T00:00:00Z -->",
      "Why asked: because",
      "",
      "- A) one",
      "",
      "[Answer]:",
      "",
      "## Q2 · Second",
      "<!-- id: Q2 | status: nope | area: a | asked_by: x | asked_at: 2026-08-28T00:00:00Z -->",
      "",
      "- A) one",
      "- B) two",
      "",
      "[Answer]:",
      "",
    ].join("\n");
    const messages = validateQuestions(parseQuestions(broken)).map((i) => i.message);
    expect(messages).toContain("`Why asked:` must end with a [src: …] token");
    expect(messages).toContain("expected 2–5 options, lettered A–E in order");
    expect(messages).toContain("question ids must ascend (Q2 follows Q9)");
    expect(messages).toContain("status must be one of open | answered | withdrawn");
    expect(messages).toContain("missing the `Why asked:` line");
  });
});

describe("the src grammar (spec §2.8)", () => {
  test("classifies every production", () => {
    expect(classifySrc("api:src/Hunt.cs:22")).toMatchObject({ kind: "file", repo: "api", path: "src/Hunt.cs", startLine: 22, endLine: null });
    expect(classifySrc("src/Hunt.cs:22-30")).toMatchObject({ kind: "file", repo: null, startLine: 22, endLine: 30 });
    expect(classifySrc("https://developers.example.com/limits")).toMatchObject({ kind: "doc" });
    expect(classifySrc("Q6")).toMatchObject({ kind: "answer", q: "Q6" });
    expect(classifySrc("F019")).toMatchObject({ kind: "fact", id: "F019" });
    expect(classifySrc("$ dotnet build → exit 0")).toMatchObject({ kind: "cmd", command: "dotnet build", exitCode: 0 });
    expect(classifySrc("graph:api.Hunt.Complete")).toMatchObject({ kind: "graph", node: "api.Hunt.Complete" });
    expect(classifySrc("absent:.tldrx/map/api/domains.md")).toMatchObject({ kind: "absent" });
  });

  test("rejects http, malformed ids and paths with no line", () => {
    expect(classifySrc("http://example.com")).toMatchObject({ message: expect.stringContaining("https://") });
    expect(classifySrc("F1")).toMatchObject({ message: expect.stringContaining("Q<n>") });
    expect(classifySrc("src/Hunt.cs")).toMatchObject({ message: expect.stringContaining("path:line") });
    expect(classifySrc("$ dotnet build")).toMatchObject({ message: expect.stringContaining("→ exit") });
    expect(classifySrc("api:../secrets.txt:1")).toMatchObject({ message: expect.stringContaining("`..`") });
  });

  test("a token must sit at the end of the line, and may carry several sources", () => {
    expect(parseSrcToken("- claim [src: Q4] and then prose")).toBeNull();
    const token = parseSrcToken("- claim [src: Q4; F019; api:src/Hunt.cs:1]");
    expect(token?.refs.map((r) => r.kind)).toEqual(["answer", "fact", "file"]);
    expect(token?.errors).toEqual([]);
  });

  test("file sources resolve against the workspace, and out-of-range lines do not", () => {
    const inRange = classifySrc("api:src/Hunt.cs:8");
    expect(resolveSrc(inRange as never, CTX, "Findings").ok).toBe(true);
    const tooFar = classifySrc("api:src/Hunt.cs:999");
    expect(resolveSrc(tooFar as never, CTX, "Findings")).toMatchObject({ ok: false, message: expect.stringContaining("12 line(s)") });
    const missing = classifySrc("api:src/Nope.cs:1");
    expect(resolveSrc(missing as never, CTX, "Findings")).toMatchObject({ ok: false, message: expect.stringContaining("no such file") });
    const unknownRepo = classifySrc("mobile:src/App.tsx:1");
    expect(resolveSrc(unknownRepo as never, CTX, "Findings")).toMatchObject({ ok: false, message: expect.stringContaining("unknown repo") });
  });

  test("cmd sources are ledger-only and must be a workspace command", () => {
    const cmd = classifySrc("$ dotnet build → exit 0");
    expect(resolveSrc(cmd as never, CTX, "Evidence ledger").ok).toBe(true);
    expect(resolveSrc(cmd as never, CTX, "Findings")).toMatchObject({ ok: false, message: expect.stringContaining("Evidence ledger") });
    const foreign = classifySrc("$ rm -rf / → exit 0");
    expect(resolveSrc(foreign as never, CTX, "Evidence ledger")).toMatchObject({ ok: false, message: expect.stringContaining("workspace.yml") });
  });

  test("with no workspace, a bare path still resolves against the root", () => {
    const ref = classifySrc("api/src/Hunt.cs:3");
    expect(resolveSrc(ref as never, emptySrcContext(FIXTURE_WORKSPACE), "Findings").ok).toBe(true);
  });
});

describe("handoff.md (spec §2.8)", () => {
  test("splits the four sections and finds their bullets", () => {
    const handoff = parseHandoff(HANDOFF);
    expect(handoff.sections.map((s) => s.name)).toEqual([...HANDOFF_SECTIONS]);
    expect(handoff.sections.map((s) => s.bullets.length)).toEqual([2, 2, 2, 2]);
    expect(missingSections(handoff)).toEqual([]);
    expect(isHandoff(HANDOFF)).toBe(true);
  });

  test("the shipped fixture validates clean", () => {
    expect(validateHandoff(HANDOFF, CTX)).toMatchObject({ ok: true, unsourced: [], unresolved: [], bulletCount: 8 });
  });

  test("reports the line number of every unsourced bullet", () => {
    const broken = HANDOFF
      .replace(" [src: F019]", "")
      .replace("- Whether mobile needs paging beyond top-50 [src: Q4]", "- Whether mobile needs paging beyond top-50");
    const report = validateHandoff(broken, CTX);
    expect(report.ok).toBe(false);
    expect(report.unsourced).toEqual([6, 14]);
  });

  test("reports a file source that does not resolve", () => {
    const broken = HANDOFF.replace("api:src/Hunt.cs:8", "api:src/Nope.cs:8");
    const report = validateHandoff(broken, CTX);
    expect(report.unsourced).toEqual([]);
    expect(report.unresolved).toEqual([{
      line: 5,
      message: "[src: api:src/Nope.cs:8] — no such file: src/Nope.cs — tried repo `api` (api)",
    }]);
  });

  test("a `$ cmd` outside the Evidence ledger is an error", () => {
    const broken = HANDOFF.replace("[src: Q4]", "[src: $ dotnet build → exit 0]");
    expect(validateHandoff(broken, CTX).unresolved[0]?.message).toContain("only allowed in the Evidence ledger");
  });

  test("a file missing a section is not a handoff", () => {
    const partial = HANDOFF.slice(0, HANDOFF.indexOf("## Evidence ledger"));
    expect(isHandoff(partial)).toBe(false);
    expect(validateHandoff(partial, CTX).missingSections).toEqual(["Evidence ledger"]);
  });

  test("a checked section with no list items is an error, and is named", () => {
    // The pilot's shape: a section that reads fine and carries nothing checkable.
    const prose = HANDOFF.replace(
      /## Unknowns\n(?:- .*\n)+/,
      "## Unknowns\nNothing surfaced that we could not answer from the map.\n",
    );
    const report = validateHandoff(prose, CTX);
    expect(report.ok).toBe(false);
    expect(report.unsourced).toEqual([]);
    expect(report.emptySections.map((e) => e.name)).toEqual(["Unknowns"]);
    expect(report.emptySections[0]?.line).toBeGreaterThan(0);
  });

  test("`- none [src: absent:…]` is how an empty section is written", () => {
    const filled = HANDOFF.replace(
      /## Unknowns\n(?:- .*\n)+/,
      `## Unknowns\n${noneBullet(".tldrx/memory/facts.yml")}\n`,
    );
    expect(validateHandoff(filled, CTX)).toMatchObject({ ok: true, emptySections: [] });
  });

  test("every one of the four sections is checked for items, not just Unknowns", () => {
    const empty = [
      "# Handoff — 02-how / contracts — run X", "",
      "## Findings", "prose only", "",
      "## Decisions", "prose only", "",
      "## Unknowns", "prose only", "",
      "## Evidence ledger", "prose only", "",
    ].join("\n");
    expect(validateHandoff(empty, CTX).emptySections.map((e) => e.name)).toEqual([...HANDOFF_SECTIONS]);
  });

  test("stays well inside the 50 ms budget on a 256 KB handoff", () => {
    const bullet = "- Hunt completion already emits a HuntCompleted domain event [src: api:src/Hunt.cs:8]\n";
    const body = bullet.repeat(Math.ceil((256 * 1024) / bullet.length));
    const big = `# Handoff\n\n## Findings\n${body}\n## Decisions\n\n## Unknowns\n\n## Evidence ledger\n`;
    expect(big.length).toBeGreaterThan(256 * 1024);
    // One wall-clock sample on a shared box does not measure this function: with the code
    // untouched it read 66.4 ms against this 50 ms budget while two other agents worked
    // (#43). The floor of three runs is the cost when the scheduler leaves it alone, and
    // the budget scales with measured load — on an idle machine this is still `< 50`.
    expect(fastestOf(3, () => validateHandoff(big, CTX))).toBeLessThan(perfBudgetMs(50));
  });
});

describe("a bare `path:line` resolves against three bases (spec §2.8)", () => {
  /** The run dir the handoff lives in — base (b). */
  const RUN_CTX = toSrcContext(loadWorkspace(FIXTURE_WORKSPACE), RUN_DIR);

  function ref(src: string) {
    const parsed = classifySrc(src);
    expect(parsed).toMatchObject({ kind: "file" });
    return parsed as never;
  }

  test("(a) the workspace root — a `.tldrx/…` path still resolves", () => {
    expect(resolveSrc(ref(".tldrx/memory/facts.yml:1"), RUN_CTX, "Findings")).toMatchObject({ ok: true });
  });

  test("(b) the run dir — a sub-agent may cite its own outputs run-relatively", () => {
    // The measured pilot failure: the resolver only ever tried the workspace root.
    expect(resolveSrc(ref("01-what/intent.md:1"), CTX, "Findings").ok).toBe(false);
    const resolution = resolveSrc(ref("01-what/intent.md:1"), RUN_CTX, "Findings");
    expect(resolution.ok).toBe(true);
    expect(resolution.resolved).toBe(join(RUN_DIR, "01-what", "intent.md"));
  });

  test("(c) a known repo name + `/` — the `repo:path` form spelled with a slash", () => {
    // `hunt` lives at `api/`, so this only resolves if the repo name is stripped.
    const nested: SrcContext = {
      root: FIXTURE_WORKSPACE,
      repos: new Map([["hunt", "api"]]),
      commands: new Set(),
      runDir: RUN_DIR,
    };
    const resolution = resolveSrc(ref("hunt/src/Hunt.cs:8"), nested, "Findings");
    expect(resolution.ok).toBe(true);
    expect(resolution.resolved).toBe(join(FIXTURE_WORKSPACE, "api", "src", "Hunt.cs"));
  });

  test("first existing base wins, and the line must be in range of THAT file", () => {
    const resolution = resolveSrc(ref("01-what/intent.md:999"), RUN_CTX, "Findings");
    expect(resolution.ok).toBe(false);
    expect(resolution.message).toContain("cited line 999");
  });

  test("the failure names every base it tried", () => {
    const resolution = resolveSrc(ref("api/src/Nope.cs:1"), RUN_CTX, "Findings");
    expect(resolution.ok).toBe(false);
    expect(resolution.message).toContain("no such file: api/src/Nope.cs");
    expect(resolution.message).toContain("workspace root");
    expect(resolution.message).toContain(`run dir tldrx-work/${FIXTURE_RUN}`);
    expect(resolution.message).toContain("repo `api` (api)");
  });

  test("a handoff citing its own run's output validates against a run-aware context", () => {
    const handoff = [
      "# Handoff — 01-what / what — run 260828-leaderboard",
      "",
      "## Findings",
      "- The intent names the leaderboard [src: 01-what/intent.md:1]",
      "",
      "## Decisions",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Unknowns",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Evidence ledger",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
    ].join("\n");
    expect(validateHandoff(handoff, RUN_CTX)).toMatchObject({ ok: true, unresolved: [] });
    // …and without the run dir it is exactly the pilot's failure.
    const blind = validateHandoff(handoff, CTX);
    expect(blind.ok).toBe(false);
    expect(blind.unresolved[0]?.message).toContain("no such file: 01-what/intent.md");
  });
});

describe("wrapped bullets (spec §2.8)", () => {
  function handoff(...findings: string[]): string {
    return [
      "# Handoff — 02-how / contracts — run 260828-leaderboard",
      "",
      "## Findings",
      ...findings,
      "",
      "## Decisions",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Unknowns",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Evidence ledger",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
    ].join("\n");
  }

  test("a `[src: …]` on an indented continuation line still sources the bullet", () => {
    const report = validateHandoff(handoff(
      "- A claim long enough that its citation soft-wrapped onto the next line",
      "  [src: api:src/Hunt.cs:8]",
    ), CTX);
    expect(report).toMatchObject({ ok: true, unsourced: [], unresolved: [], bulletCount: 4 });
  });

  test("the continuation is joined, so a mid-bullet wrap still parses", () => {
    const parsed = parseHandoff(handoff(
      "- A claim that wraps",
      "  across three",
      "  lines [src: F019]",
    ));
    expect(parsed.sections[0]?.bullets).toHaveLength(1);
    expect(parsed.sections[0]?.bullets[0]?.text).toBe("A claim that wraps across three lines [src: F019]");
  });

  test("a wrapped bullet with no token anywhere is reported on its FIRST line", () => {
    const report = validateHandoff(handoff(
      "- A claim that wraps",
      "  and never cites anything",
    ), CTX);
    expect(report.unsourced).toEqual([4]);
  });

  test("a bullet ends at the next line that starts at column 0", () => {
    const report = validateHandoff(handoff(
      "- A claim with no citation",
      "Loose prose that happens to end in a token [src: F019]",
    ), CTX);
    expect(report.unsourced).toEqual([4]);
  });

  test("a nested bullet is still its own bullet, not a continuation", () => {
    const parsed = parseHandoff(handoff(
      "- Outer claim [src: F019]",
      "  - Inner claim [src: Q4]",
    ));
    expect(parsed.sections[0]?.bullets.map((b) => b.line)).toEqual([4, 5]);
  });
});

describe("ordered list items are checked like bullets (spec §2.8)", () => {
  function handoff(...findings: string[]): string {
    return [
      "# Handoff — 02-how / contracts — run 260828-leaderboard",
      "",
      "## Findings",
      ...findings,
      "",
      "## Decisions",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Unknowns",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Evidence ledger",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
    ].join("\n");
  }

  test("a numbered item with a valid token passes, for both `1.` and `1)`", () => {
    const report = validateHandoff(handoff(
      "1. Hunt completion emits a domain event [src: api:src/Hunt.cs:8]",
      "2) The lab SDK is generated [src: F019]",
    ), CTX);
    expect(report).toMatchObject({ ok: true, unsourced: [], unresolved: [], bulletCount: 5 });
  });

  test("a numbered item with no token is unsourced, and its line is named", () => {
    const report = validateHandoff(handoff(
      "1. Hunt completion emits a domain event [src: api:src/Hunt.cs:8]",
      "2. Ranking ties are broken by completion time",
    ), CTX);
    expect(report.ok).toBe(false);
    expect(report.unsourced).toEqual([5]);
  });

  test("a numbered item's source must resolve, exactly like a bullet's", () => {
    const report = validateHandoff(handoff("1. A claim [src: api:src/Nope.cs:1]"), CTX);
    expect(report.unresolved[0]?.message).toContain("no such file: src/Nope.cs");
  });

  test("a mixed list counts every item, whichever marker it uses", () => {
    const parsed = parseHandoff(handoff(
      "- A dashed claim [src: F019]",
      "1. A numbered claim [src: Q4]",
      "- Another dashed claim [src: F019]",
      "2) A paren-numbered claim [src: Q6]",
    ));
    expect(parsed.sections[0]?.bullets.map((b) => b.line)).toEqual([4, 5, 6, 7]);
    expect(validateHandoff(handoff(
      "- A dashed claim [src: F019]",
      "1. A numbered claim with no source",
      "- Another dashed claim [src: F019]",
    ), CTX).unsourced).toEqual([5]);
  });

  test("a wrapped numbered item is joined before the token is looked for", () => {
    // The pilot's shape: every Decisions item wraps, citation on the last line.
    const report = validateHandoff(handoff(
      "1. **Phase 1 boundary (measured).** In scope: the scoring engine, score-event",
      "   persistence, and the Score board.",
      "   [src: F019; api:src/Hunt.cs:8]",
    ), CTX);
    expect(report).toMatchObject({ ok: true, bulletCount: 4 });
  });

  test("an indented digit run is a wrapped line, not a new item", () => {
    // An ordered marker only counts at column 0 — otherwise "…since\n  2019. That…"
    // would be denied as an unsourced item, punishing line width.
    const parsed = parseHandoff(handoff(
      "- Ranking has been global since",
      "  2019. That has not changed [src: F019]",
    ));
    expect(parsed.sections[0]?.bullets).toHaveLength(1);
    expect(validateHandoff(handoff(
      "- Ranking has been global since",
      "  2019. That has not changed [src: F019]",
    ), CTX).unsourced).toEqual([]);
  });

  test("a column-0 numbered item after a wrapped one is its own item", () => {
    const parsed = parseHandoff(handoff(
      "1. A claim that wraps",
      "   onto a second line [src: F019]",
      "2. The next claim [src: Q4]",
    ));
    expect(parsed.sections[0]?.bullets.map((b) => b.line)).toEqual([4, 6]);
  });
});

describe("facts.yml (spec §2.5)", () => {
  test("loads the fixture and exposes non-retired rows", () => {
    const store = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml"));
    expect(store.facts.map((f) => f.id)).toEqual(["F007", "F019"]);
    expect(store.nextId()).toBe("F020");
    expect(store.get("F019")?.supersedes).toBe("F007");
  });

  test("append assigns the next id and keeps the file valid", () => {
    const ws = makeWorkspace();
    try {
      const path = join(ws.root, ".tldrx", "memory", "facts.yml");
      const store = FactsStore.load(path);
      const fact = store.append({
        fact: "Rankings are global, same as Places.",
        area: "multi-tenancy", repos: ["api"], kind: "answer", confidence: "stated",
        source: { who: "alan", when: "2026-08-29T09:00:00Z", run: FIXTURE_RUN, q: "Q5" },
      });
      expect(fact.id).toBe("F020");
      store.save();
      const reloaded = FactsStore.load(path);
      expect(reloaded.facts.map((f) => f.id)).toEqual(["F007", "F019", "F020"]);
      expect(reloaded.get("F020")?.source.q).toBe("Q5");
    } finally {
      ws.dispose();
    }
  });

  test("supersede writes both halves of the link", () => {
    const store = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml"));
    const replacement = store.supersede("F019", {
      fact: "Backend deploys are fully automatic on merge.",
      area: "deploy", repos: ["api"], kind: "answer", confidence: "measured",
      source: { who: "alan", when: "2026-08-29T09:00:00Z", run: FIXTURE_RUN, q: null },
    });
    expect(replacement.supersedes).toBe("F019");
    expect(store.get("F019")?.superseded_by).toBe(replacement.id);
    expect(validateFactsFile(parseYaml(store.toYaml())).ok).toBe(true);
    expect(() => store.supersede("F019", { ...replacement, repos: [] })).toThrow(/already superseded/);
  });

  test("a one-sided supersede link is a validation error", () => {
    const doc = parseYaml(emitFactsYaml({
      version: 1,
      facts: [
        {
          id: "F001", fact: "a", area: "x", repos: [], kind: "answer", confidence: "stated",
          source: { who: "a", when: "2026-01-01T00:00:00Z", run: null, q: null },
          supersedes: null, superseded_by: "F002", retired: null,
        },
        {
          id: "F002", fact: "b", area: "x", repos: [], kind: "answer", confidence: "stated",
          source: { who: "a", when: "2026-01-01T00:00:00Z", run: null, q: null },
          supersedes: null, superseded_by: null, retired: null,
        },
      ],
    }));
    const issues = validateFactsFile(doc).issues.map((i) => i.message);
    expect(issues).toContain("F002.supersedes must be F001 (links are reciprocal)");
  });

  test("retire hides a fact from no-re-ask but keeps it on disk", () => {
    const store = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml"));
    store.retire("F019", { at: "2026-08-29T09:00:00Z", by: "alan", reason: "no longer true" });
    expect(store.facts).toHaveLength(2);
    // This line used to read `.toEqual(["F007"])` — "a superseded-but-not-retired
    // row stays visible" — and that was the bug, not the rule. F007 is superseded
    // BY F019: it is what the workspace used to believe. Retiring F019 does not
    // promote F007 back to current, it leaves the workspace with nothing live to
    // say about deploys, which is the honest answer. `active` is now
    // neither-retired-nor-superseded (`isLive`).
    expect(store.active.map((f) => f.id)).toEqual([]);
    expect(() => store.retire("F007", { at: "x", by: "y", reason: "z" })).toThrow(/superseded/);
  });

  test("emitted YAML is block style and round-trips", () => {
    const store = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml"));
    const text = store.toYaml();
    expect(text.split("\n").length).toBeGreaterThan(10);
    expect(validateFactsFile(parseYaml(text)).ok).toBe(true);
    expect((parseYaml(text) as { facts: { fact: string }[] }).facts[0]?.fact).toBe(store.facts[0]?.fact);
  });
});

describe("findDuplicate (Jaccard ≥ 0.6 on ≥4-char tokens)", () => {
  const facts = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml")).active;

  test("tokenises to lower-case runs of four characters or more", () => {
    expect([...tokenize("Where does the Hunt-Engine emit v2 events?")].sort())
      .toEqual(["does", "emit", "engine", "events", "hunt", "where"]);
  });

  test("jaccard is intersection over union", () => {
    expect(jaccard(new Set(["aaaa", "bbbb"]), new Set(["aaaa", "bbbb"]))).toBe(1);
    expect(jaccard(new Set(["aaaa", "bbbb"]), new Set(["aaaa", "cccc"]))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set(["aaaa"]))).toBe(0);
  });

  test("hits a fact in the same area above the threshold", () => {
    const hit = findDuplicate(
      "Does the backend deploy via workflow dispatch, and does lab auto deploy on merge?",
      "deploy", facts,
    );
    expect(hit?.fact.id).toBe("F019");
    expect(hit?.score).toBeGreaterThanOrEqual(0.6);
  });

  test("the same words in a different area are a different question", () => {
    expect(findDuplicate(
      "Does the backend deploy via workflow dispatch, and does lab auto deploy on merge?",
      "data-model", facts,
    )).toBeNull();
  });

  test("an unrelated question misses", () => {
    expect(findDuplicate("Where does leaderboard state live?", "deploy", facts)).toBeNull();
  });

  test("retired facts are invisible", () => {
    const store = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml"));
    store.retire("F019", { at: "2026-08-29T00:00:00Z", by: "alan", reason: "stale" });
    expect(findDuplicate(
      "Does the backend deploy via workflow dispatch, and does lab auto deploy on merge?",
      "deploy", store.active,
    )).toBeNull();
  });

  /**
   * The fixture's F007 is superseded BY F019 and says nearly the same thing. It
   * was reachable through `findDuplicate` until 2026-08-31 — the filter was
   * retirement only — which meant a reversed decision could still deny a
   * question. Passing `store.facts` (everything, unfiltered) proves the skip is
   * in `findDuplicate` itself and not only in `active`.
   */
  test("superseded facts are invisible, even when the caller passes every row", () => {
    const store = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml"));
    expect(store.get("F007")?.superseded_by).toBe("F019");
    const hit = findDuplicate(
      "Is backend CD manual, with deploy.yml on workflow dispatch only?",
      "deploy", store.facts,
    );
    expect(hit?.fact.id).not.toBe("F007");
  });
});

/**
 * `isLive` is the predicate every consumer of facts filters on, and the reason it
 * exists: `superseded_by` sat in the §2.5 schema with no writer, so every reader
 * in `src/` filtered on retirement alone. The day `tldrx answer --supersede`
 * started writing the link, a reader that only knew about retirement became a
 * reader that serves reversed decisions.
 */
describe("isLive / isSuperseded (spec §2.5)", () => {
  const store = FactsStore.load(join(FIXTURE_WORKSPACE, ".tldrx", "memory", "facts.yml"));

  test("a superseded fact is not live, and is not in `active`", () => {
    const old = store.get("F007");
    expect(old).toBeDefined();
    expect(isSuperseded(old as Fact)).toBe(true);
    expect(isRetired(old as Fact)).toBe(false);
    expect(isLive(old as Fact)).toBe(false);
    expect(store.active.map((f) => f.id)).not.toContain("F007");
    expect(store.active.map((f) => f.id)).toContain("F019");
  });

  test("`facts` still carries it — history is filtered at the reader, not deleted", () => {
    expect(store.facts.map((f) => f.id)).toContain("F007");
  });

  test("headOf walks the chain to the row nothing has replaced", () => {
    expect(store.headOf("F007")?.id).toBe("F019");
    expect(store.headOf("F019")?.id).toBe("F019");
    expect(store.headOf("F999")).toBeUndefined();
  });
});

describe("events.jsonl (spec §2.9)", () => {
  const sample: TldrxEvent = {
    ts: "2026-08-28T15:10:03Z", run: FIXTURE_RUN, stage: "contracts", type: "question.answered",
    actor: "alan", cost_usd: 0, payload: { q: "Q5", answer: "B", fact: "F021" },
  };

  test("the envelope is exactly seven keys, in spec order", () => {
    expect(Object.keys(JSON.parse(serializeEvent(sample)) as object)).toEqual([...EVENT_KEYS]);
    expect(validateEvent(sample).ok).toBe(true);
  });

  test("an unknown type or an extra key is a validation error", () => {
    expect(validateEvent({ ...sample, type: "stage.exploded" }).ok).toBe(false);
    expect(validateEvent({ ...sample, extra: 1 }).issues.map((i) => i.message))
      .toEqual([expect.stringContaining("unexpected key `extra`")]);
    expect(validateEvent({ ...sample, cost_usd: -1 }).ok).toBe(false);
  });

  test("appends and reads back", () => {
    const ws = makeWorkspace();
    try {
      const log = EventLog.forRun(ws.runDir);
      const before = log.read().length;
      log.append(sample);
      const events = log.read();
      expect(events).toHaveLength(before + 1);
      expect(events[events.length - 1]?.type).toBe("question.answered");
    } finally {
      ws.dispose();
    }
  });

  test("refuses a write that would shorten the log", () => {
    const ws = makeWorkspace();
    try {
      const log = EventLog.forRun(ws.runDir);
      log.append(sample);
      const full = readFileSync(log.path, "utf8");
      expect(() => log.replaceAll(full.slice(0, 10))).toThrow(/append-only/);
      expect(readFileSync(log.path, "utf8")).toBe(full);
      log.replaceAll(`${full}${serializeEvent(sample)}\n`);
      expect(log.read()).toHaveLength(3);
    } finally {
      ws.dispose();
    }
  });

  test("refuses an invalid event rather than writing it", () => {
    const ws = makeWorkspace();
    try {
      const log = EventLog.forRun(ws.runDir);
      const size = log.sizeBytes;
      expect(() => log.append({ ...sample, type: "nope" as TldrxEvent["type"] })).toThrow(/invalid event/);
      expect(log.sizeBytes).toBe(size);
      expect(log.tryAppend({ ...sample, type: "nope" as TldrxEvent["type"] })).toContain("invalid event");
      // A payload nested deeper than three levels is rejected too.
      expect(validateEvent({ ...sample, payload: { a: { b: { c: { d: 1 } } } } }).ok).toBe(false);
    } finally {
      ws.dispose();
    }
  });

  test("writes to a run folder that has no log yet", () => {
    const ws = makeWorkspace();
    try {
      const log = new EventLog(join(ws.root, "tldrx-work", "260901-new", "events.jsonl"));
      expect(log.sizeBytes).toBe(0);
      log.append({ ...sample, run: "260901-new", type: "run.created", stage: null });
      expect(log.read()).toHaveLength(1);
    } finally {
      ws.dispose();
    }
  });
});

describe("budget.yml (spec §2.11)", () => {
  const budget = loadBudget(join(RUN_DIR, "budget.yml"));

  test("loads the spec shape", () => {
    expect(budget.run).toBe(FIXTURE_RUN);
    expect(budget.on_exceed).toBe("block");
    expect(budget.warn_at_pct).toBe(80);
    expect(budget.phases).toHaveLength(5);
    expect(totalSpent(budget)).toBeCloseTo(7.53);
  });

  test("remaining is per phase, and per run when the phase is unknown", () => {
    expect(remaining(budget, "02-how")).toBeCloseTo(0.61);
    expect(remaining(budget, "03-plan")).toBeCloseTo(4);
    expect(remaining(budget, "99-nope")).toBeCloseTo(17.47);
    expect(remaining(budget)).toBeCloseTo(17.47);
  });

  test("wouldExceed honours on_exceed", () => {
    const blocked = wouldExceed(budget, "02-how", 3);
    expect(blocked).toMatchObject({ exceeds: true, blocked: true, scope: "phase", ceiling: 7, estimate: 3 });
    expect(blocked.remaining).toBeCloseTo(0.61);
    expect(wouldExceed(budget, "02-how", 0.5)).toMatchObject({ exceeds: false, blocked: false });
    const warnOnly = wouldExceed({ ...budget, on_exceed: "warn" }, "02-how", 3);
    expect(warnOnly).toMatchObject({ exceeds: true, blocked: false });
  });

  test("warns when a spend that fits crosses warn_at_pct", () => {
    expect(wouldExceed(budget, "03-plan", 3.5).warns).toBe(true);
    expect(wouldExceed(budget, "03-plan", 0.1).warns).toBe(false);
  });

  test("phase ceilings may not exceed the run ceiling", () => {
    const doc = parseYaml(readFileSync(join(RUN_DIR, "budget.yml"), "utf8")) as Record<string, unknown>;
    expect(validateRunBudget(doc).ok).toBe(true);
    expect(validateRunBudget({ ...doc, ceiling_usd: 5 }).issues.map((i) => i.message))
      .toEqual([expect.stringContaining("phase ceilings sum to")]);
    expect(validateRunBudget({ ...doc, version: 2 }).ok).toBe(false);
  });

  test("a written budget round-trips through the validator", () => {
    const ws = makeWorkspace();
    try {
      const path = join(ws.runDir, "budget.yml");
      const text = readFileSync(path, "utf8").replace("on_exceed: block", "on_exceed: warn");
      writeFileSync(path, text, "utf8");
      expect(loadBudget(path).on_exceed).toBe("warn");
    } finally {
      ws.dispose();
    }
  });
});
