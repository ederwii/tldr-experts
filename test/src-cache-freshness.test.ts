/**
 * The `[src:]` indexes are per CHECK, not per PROCESS (issue #206).
 *
 * `tldrx run auto` is ONE Node process for a whole run (`runAuto.ts`, no re-exec
 * per stage), and `srcToken.ts` memoises the questions/facts indexes at module
 * scope. So the first citation resolved in the process froze the index at what
 * was on disk THEN, and every later stage's `claim-sources` check judged its own
 * documents against that snapshot. Measured live on three real workspaces: a
 * `how` stage that raised Q2–Q4 in its own `02-how/questions.md` was refused with
 * "no such question Q2 … declared: Q1" (the `what` stage's snapshot), and a run
 * whose owner answered three questions between the stages was refused with "it
 * has 145 live fact(s)" while `facts.yml` held 148. Both stages had already been
 * paid for.
 *
 * The sequence below is that bug, in one process: a what-stage check that passes
 * and fills the caches, real writes to `questions.md` and (through `FactsStore`,
 * the real writer) to `facts.yml`, then the how-stage check over the ids those
 * writes created. `clearSrcCaches()` is deliberately NOT called between the two
 * checks — calling it would be the test doing what production must do for itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCheck, type CheckOutcome } from "../src/core/run/checks.ts";
import type { PlannedCheck, PlannedStage } from "../src/core/run/workflowPreset.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { classifySrc, clearSrcCaches, resolveSrc, type SrcRef } from "../src/core/text/srcToken.ts";
import { factsPath, loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

const RUN_ID = "260909-cache-freshness";

const FACTS_YML = `version: 1
facts:
  - id: F001
    fact: "Backend deploys run via deploy.yml."
    area: deploy
    repos: [api]
    kind: answer
    confidence: measured
    source: {who: alan, when: "2026-09-09T10:11:00Z", run: 260909-seed, q: Q1}
    supersedes: null
    superseded_by: null
    retired: null
`;

function questionBlock(id: string, phase: string): string {
  return `# Questions — ${phase} — run ${RUN_ID}

## ${id} · Where does ranking state live?
<!-- id: ${id} | status: open | area: data-model | asked_by: architect | asked_at: 2026-09-09T16:10:00Z -->
Why asked: no ranking store exists yet.

- A) Postgres
- B) Redis

[Answer]:
`;
}

const CLAIM_SOURCES: PlannedCheck = {
  id: "claim-sources", on: "post-write", repo: null, command: null, expect_exit: 0,
};

function stageFor(id: string, phase: string, outputs: readonly string[]): PlannedStage {
  return {
    id,
    title: `stage ${id}`,
    phase,
    model: null,
    effort: null,
    experts: [],
    budget_usd: 5,
    timeout_s: 30,
    inputs: [],
    outputs: [...outputs],
    sections: new Map<string, readonly string[]>(),
    gateType: "approve",
    checks: [CLAIM_SOURCES],
    preconditions: [],
    questionsPath: `${phase}/questions.md`,
    source: "test",
  };
}

let ws: TempRunWorkspace;
let runDir: string;

function write(rel: string, content: string): void {
  const path = join(runDir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

async function check(id: string, phase: string, outputs: readonly string[]): Promise<CheckOutcome> {
  return await runCheck(CLAIM_SOURCES, { root: ws.root, runDir, stage: stageFor(id, phase, outputs) });
}

beforeEach(() => {
  clearSrcCaches();
  ws = makeRunWorkspace({ facts: FACTS_YML });
  runDir = join(ws.root, "tldrx-work", RUN_ID);
  mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  ws.dispose();
  clearSrcCaches();
});

describe("#206 · a later stage's check sees what a later stage wrote", () => {
  test("a question and a fact written AFTER an earlier check in the same process resolve", async () => {
    // Stage one, exactly as it happened live: one question, one citation of it.
    write("01-what/questions.md", questionBlock("Q1", "01-what"));
    write("01-what/design.md", "# Design\n\n- Ranking is undecided [src: Q1]\n- Deploys are known [src: F001]\n");
    const first = await check("what", "01-what", ["01-what/design.md"]);
    expect(first.status).toBe("passed");

    // Between the stages: the owner answers, and the `how` stage raises its own
    // questions. Both go through the real writers, onto the same disk the check reads.
    const added = FactsStore.update(factsPath(ws.root), (store) => store.append({
      fact: "Ranking state lives in Redis.",
      area: "data-model",
      repos: ["api"],
      kind: "answer",
      confidence: "measured",
      source: { who: "alan", when: "2026-09-09T15:29:53Z", run: RUN_ID, q: "Q1" },
    }));
    expect(added.id).toBe("F002");
    write("02-how/questions.md", questionBlock("Q2", "02-how"));
    write("02-how/design.md", `# Design\n\n- Ranking store open [src: Q2]\n- Redis it is [src: ${added.id}]\n`);

    const second = await check("how", "02-how", ["02-how/design.md"]);
    expect(second.detail ?? "").not.toContain("no such question Q2");
    expect(second.detail ?? "").not.toContain("no such fact F002");
    expect(second.status).toBe("passed");
  });
});

describe("#206 · the memoisation the fix must NOT remove", () => {
  test("inside one resolved context the index is read once, not per citation", () => {
    write("01-what/questions.md", questionBlock("Q1", "01-what"));
    const ctx = toSrcContext(loadWorkspace(ws.root), runDir);
    const resolve = (raw: string): ReturnType<typeof resolveSrc> => {
      const ref = classifySrc(raw);
      if ("message" in ref) throw new Error(`fixture bug: ${raw} does not parse`);
      return resolveSrc(ref as SrcRef, ctx, "Findings", "");
    };
    expect(resolve("Q1")).toMatchObject({ ok: true });
    expect(resolve("F001")).toMatchObject({ ok: true });

    // Delete both indexes' files. A context that re-read them per citation would
    // now refuse (or go `unverified`); a memoised one answers from what it read.
    rmSync(join(runDir, "01-what", "questions.md"));
    rmSync(factsPath(ws.root));
    expect(resolve("Q1")).toMatchObject({ ok: true });
    expect(resolve("F001")).toMatchObject({ ok: true, outcome: "ok" });
  });
});
