/**
 * `tldrx answer --decided-by / --repo` — provenance the answer path can state (#169).
 *
 * Until this landed, `captureAnswers.ts:105` wrote `repos: []` and a `source`
 * with no `decided_by`, so a driver's answer and the owner's were byte-identical
 * in provenance and no answered decision ever said what it bound to. The flags
 * are OPTIONAL because the `answer-capture` hook cannot honestly say which of
 * the two wrote the file (`hooks/answer-capture.ts:22-26` fires on an agent's
 * Write AND on a human's FileChanged), so absence stays the common case and is
 * documented as "not stated", never "owner".
 *
 * In process, like `test/facts-add.test.ts`: `answerCommand.run` spawns nothing,
 * so this file is not a machine-load spawner and needs no `spawnTestTimeout`.
 * The helpers below start no process either — `makeRunWorkspace` writes files,
 * and `createRun` writes files under a workspace lock.
 *
 * Every `FactsStore.loadOrEmpty(factsPath(...))` below is a ROUND-TRIP read: the
 * command wrote through `FactsStore.append` → `emitFactsYaml` → disk, and these
 * assertions parse those bytes back and validate them. A field that did not
 * survive the emitter would read as absent here, not as a type error.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { answerCommand } from "../src/cli/commands/answer.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { factsPath } from "../src/hooks/lib/workspace.ts";
import { renderFacts } from "../src/core/facilitator/prompt.ts";
import { reposFromAffects } from "../src/core/answers/reposFromAffects.ts";
import type { Fact } from "../src/core/facts/Fact.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { gatedScope, makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

let workspaces: TempRunWorkspace[] = [];
afterEach(() => {
  for (const ws of workspaces) ws.dispose();
  workspaces = [];
});

interface AnswerWorkspace {
  readonly root: string;
  readonly runDir: string;
}

/** One workspace (repos `api` and `lab`), one real open run with an `01-what` phase. */
function runWorkspace(): AnswerWorkspace {
  const made = makeRunWorkspace({ files: gatedScope("true") });
  workspaces.push(made);
  const created = createRun({
    root: made.root, slug: "answers", title: "answers", scope: "gated", budgetUsd: 5,
    actor: "alan", now: new Date("2026-09-07T09:00:00Z"),
  });
  return { root: made.root, runDir: created.runDir };
}

function writeQuestions(ws: AnswerWorkspace, phase: string, body: string): void {
  const dir = join(ws.runDir, phase);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "questions.md"), `# Questions — ${phase} — run answers\n\n${body}`, "utf8");
}

/** The §2.7 block shape `test/run.test.ts:537-546` uses, with an empty `[Answer]:`. */
function block(id: string, title: string, area: string): string {
  return `## ${id} · ${title}
<!-- id: ${id} | status: open | area: ${area} | asked_by: product | asked_at: 2026-09-07T09:00:00Z -->
Why asked: nothing in the map answers it [src: absent:.tldrx/map/domains.md]

- A) One way
- B) The other

[Answer]:
`;
}

/** The same block with the optional `affects:` metadata key (`stampSuperseded.ts:66`). */
function blockWithAffects(id: string, title: string, area: string, affects: string): string {
  return `## ${id} · ${title}
<!-- id: ${id} | status: open | area: ${area} | asked_by: product | asked_at: 2026-09-07T09:00:00Z | affects: ${affects} -->
Why asked: nothing in the map answers it [src: absent:.tldrx/map/domains.md]

- A) One way
- B) The other

[Answer]:
`;
}

/** Still `status: open`, but its slot is already filled — what the sweep captures. */
function answeredByHand(id: string, title: string, area: string, answer: string): string {
  return block(id, title, area).replace("[Answer]:\n", `[Answer]: ${answer}\n`);
}

/** A minimal, valid `Fact` for `renderFacts` — the shape `test/facts-add.test.ts` uses. */
function bareFact(): Fact {
  return {
    id: "F000",
    fact: "The outbox lives in the billing repo.",
    area: "billing",
    repos: [],
    kind: "observed",
    confidence: "measured",
    source: { who: "alan", when: "2026-09-07T09:00:00Z", run: null, q: null },
    supersedes: null,
    superseded_by: null,
    retired: null,
  };
}

describe("tldrx answer records who decided, and only for the question it names", () => {
  test("--decided-by lands on the fact the invocation named", async () => {
    const ws = runWorkspace();                       // one run, one open Q1
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));

    expect(await answerCommand.run(["Q1", "Redis", "--decided-by", "owner", "--root", ws.root])).toBe(0);

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.source.decided_by).toBe("owner");
  });

  test("the answer text is the answer, not the flag's value", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));

    await answerCommand.run(["Q1", "Redis", "--decided-by", "driver", "--root", ws.root]);

    // parseArgs's value-flag list is the whole of this: without it, `driver`
    // becomes a positional and `words.join(" ")` records "Redis driver".
    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.fact)
      .toBe("Where does state live? — Redis");
  });

  test("a second answered block in the same file is recorded with NO decider and NO repos", async () => {
    const ws = runWorkspace();
    // Q2 is filled in by hand BEFORE the command runs — the sweep will capture it.
    writeQuestions(ws, "01-what", [
      block("Q1", "Where does state live?", "data-model"),
      answeredByHand("Q2", "Which currency?", "billing", "EUR"),
    ].join("\n"));

    await answerCommand.run(["Q1", "Redis", "--decided-by", "owner", "--repo", "api", "--root", ws.root]);

    const facts = FactsStore.loadOrEmpty(factsPath(ws.root)).facts;
    const named = facts.find((f) => f.source.q === "Q1");
    const swept = facts.find((f) => f.source.q === "Q2");
    expect(named?.source.decided_by).toBe("owner");
    expect(named?.repos).toEqual(["api"]);
    // The operator named Q1. Stamping Q2 with it would be the same lie the flag exists to stop.
    expect(swept?.source.decided_by).toBeUndefined();
    expect(swept?.repos).toEqual([]);
  });

  test("--decided-by outside the closed set is a usage refusal, and nothing is written", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));
    const before = readFileSync(factsPath(ws.root), "utf8");

    expect(await answerCommand.run(["Q1", "Redis", "--decided-by", "banana", "--root", ws.root])).toBe(1);
    expect(readFileSync(factsPath(ws.root), "utf8")).toBe(before);
  });

  /**
   * GUARD, not a proof: this refusal pre-dates #169 (`answer.ts`'s QUESTION_ID_RE
   * check), and it was green before this change for a DIFFERENT reason — with
   * `decided-by` absent from parseArgs's value-flag list, `owner` became the
   * positional and failed the id regex. It is pinned here because the flags now
   * depend on it: they are carried on a per-question `overrides` map keyed by the
   * id in the invocation, so an invocation that names NO question has nothing to
   * key them to, and must never fall through to the sweep and stamp whatever it
   * finds.
   */
  test("GUARD: the flags with no question id named is a refusal, and nothing is written", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", answeredByHand("Q2", "Which currency?", "billing", "EUR"));
    const before = readFileSync(factsPath(ws.root), "utf8");

    expect(await answerCommand.run(["--decided-by", "owner", "--repo", "api", "--root", ws.root])).toBe(1);
    // The sweep did not run: Q2 sat there answered-but-uncaptured and stayed that way.
    expect(readFileSync(factsPath(ws.root), "utf8")).toBe(before);
  });

  test("--repo naming no workspace repo is a usage refusal, and nothing is written", async () => {
    const ws = runWorkspace();                        // its workspace.yml declares `api`
    writeQuestions(ws, "01-what", block("Q1", "Where does state live?", "data-model"));
    const before = readFileSync(factsPath(ws.root), "utf8");

    expect(await answerCommand.run(["Q1", "Redis", "--repo", "ghost", "--root", ws.root])).toBe(1);
    expect(readFileSync(factsPath(ws.root), "utf8")).toBe(before);
  });
});

describe("what a decision binds to, and what it does not", () => {
  test("repos precedence: an explicit --repo beats the question's affects:", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", blockWithAffects("Q1", "Where?", "data-model", "lab:src/a.ts"));

    await answerCommand.run(["Q1", "Redis", "--repo", "api", "--root", ws.root]);

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.repos).toEqual(["api"]);
  });

  test("with no --repo, an affects: entry that names a repo scopes the fact", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", blockWithAffects("Q1", "Where?", "data-model", "api:src/db.ts"));

    await answerCommand.run(["Q1", "Redis", "--root", ws.root]);

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.repos).toEqual(["api"]);
  });

  test("with neither, repos stays [] — today's behaviour, and it hides nothing", async () => {
    const ws = runWorkspace();
    writeQuestions(ws, "01-what", blockWithAffects("Q1", "Where?", "data-model", "01-what/notes.md"));

    await answerCommand.run(["Q1", "Redis", "--root", ws.root]);

    expect(FactsStore.loadOrEmpty(factsPath(ws.root)).facts[0]?.repos).toEqual([]);
  });

  test("a scoped fact reaches a run that has the repo and is ABSENT from one that does not", () => {
    const scoped = { ...bareFact(), id: "F001", repos: ["api"] };
    expect(renderFacts([scoped], ["api"])).toContain("F001");
    expect(renderFacts([scoped], ["lab"])).toBe("_No recorded facts match this run's repos._");
  });
});

describe("reposFromAffects — what it keeps, and what it refuses to guess", () => {
  const repos = new Set(["api", "lab"]);

  test("a bare repo name and a repo:path prefix both resolve; nothing else does", () => {
    expect(reposFromAffects(["api", "lab:src/db.ts"], repos).repos).toEqual(["api", "lab"]);
  });

  test("an unqualified path contributes nothing, and is not reported as an error", () => {
    // `src/core/build/implicitPlan.ts:1350-1352`: a citation with no repo prefix is skipped
    // rather than guessed at — the run may have several repos.
    const out = reposFromAffects(["01-what/notes.md", "src/db.ts"], repos);
    expect(out.repos).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  test("a repo:path whose prefix names no repo is NAMED, so [] never reads as 'no repo was named'", () => {
    const out = reposFromAffects(["ghost:src/db.ts"], repos);
    expect(out.repos).toEqual([]);
    expect(out.unresolved).toEqual(["ghost:src/db.ts"]);
  });
});
