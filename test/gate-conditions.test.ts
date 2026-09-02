/**
 * gh #109 + #110 (which absorbs #105) — the two auto-gate conditions that were
 * measured wrong in live unattended runs, 2026-09-02.
 *
 * **#109 — silence is not the same as an unreadable file.** `questionsCondition`
 * refused the gate whenever a stage that DECLARES `questions.md` produced zero
 * parsed blocks. Zero blocks has two causes and they are opposite: a file the
 * §2.7 parser cannot read (the 2026-08-29 failure, four questions swallowed) and
 * a stage that had nothing to ask (the GOOD case). Conflating them penalised
 * every clean stage. The file being MISSING is a third thing again, and stays a
 * refusal — a declared output nobody wrote is not an answer.
 *
 * **#110 — one `absent:` semantic, shared by both checkers.** Two live failures
 * in the same week, in opposite directions, from the SAME resolution:
 *
 *   too lax   — `claim-sources` passed `- Unknowns: none [src: absent:04-build/log]`
 *               over a directory holding seven files (#105);
 *   too strict — the auto gate refused `absent:.tldrx/memory/facts.yml`
 *               ("I searched, there is no recorded fact"), which is §2.8's own
 *               documented spelling of an empty section.
 *
 * Both come from `unverified`, which one checker reads as "fine" and the other as
 * "stop". The semantic below is the one both share.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAutoGate } from "../src/core/run/autoGate.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { runCheck } from "../src/core/run/checks.ts";
import { classifySrc, clearSrcCaches, resolveSrc, type SrcContext, type SrcRef } from "../src/core/text/srcToken.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import type { PlannedCheck } from "../src/core/run/workflowPreset.ts";
import {
  cannedHandoff, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const ws of open) ws.dispose();
  open = [];
  clearSrcCaches();
});

/** A stage that DECLARES questions.md as an output — the shape #109 is about. */
const ASKER: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    { path: "01-what/questions.md" },
  ],
  checks: "[claim-sources]",
};

function workspace(stages: readonly StageOptions[]): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10, gates: { alpha: "auto" } });
  open.push(made);
  process.env.PATH = made.binDir;
  return made;
}

function inputs(ws: FacilitatorWorkspace): never {
  const store = RunStore.open(ws.runDir);
  return {
    root: ws.root,
    runDir: ws.runDir,
    phaseId: "01-what",
    stage: store.run.phases[0]?.stages[0],
    planned: loadWorkflowPreset(ws.root, store.run.scope).stages[0],
    budget: store.budget,
    checks: [{ id: "claim-sources", status: "passed", detail: "1 handoff(s) sourced" }],
  } as never;
}

/** The prose shape of 2026-08-29 — headings the §2.7 parser cannot see. */
const PROSE_QUESTIONS = [
  "# Open questions",
  "",
  "### Q1 — Where does leaderboard state live?",
  "",
  "**Answer:**",
  "",
].join("\n");

// --- #109 --------------------------------------------------------------------

describe("#109 · a stage with nothing to ask can still close an auto gate", () => {
  test("a DECLARED questions.md that is present and raises nothing satisfies the condition", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(
      join(ws.runDir, "01-what", "questions.md"),
      "# Questions — 01-what\n\nNone: nothing in this stage needed a decision.\n",
      "utf8",
    );
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.why).toBe("");
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain("questions=0 open");
  });

  test("an EMPTY file is the same answer — an empty questions.md is still an answer", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), "", "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(true);
  });

  test("but a DECLARED questions.md that was never written still refuses it", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    rmSync(join(ws.runDir, "01-what", "questions.md"), { force: true });
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("questions.md");
    expect(verdict.why).toContain("never written");
  });

  test("and a file the parser cannot read still refuses it, by id", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("no parseable question");
    expect(verdict.why).toContain("Q1");
  });
});

// --- #110 / #105 · the one `absent:` semantic ---------------------------------

interface AbsentProbe {
  readonly root: string;
  readonly runDir: string;
  readonly ctx: SrcContext;
}

function absentProbe(): AbsentProbe {
  const ws = workspace([ASKER]);
  const runDir = ws.runDir;
  // A directory that holds seven files — #105's `04-build/log`, verbatim in shape.
  mkdirSync(join(runDir, "01-what", "log"), { recursive: true });
  for (let i = 1; i <= 7; i++) {
    writeFileSync(join(runDir, "01-what", "log", `S${String(i)}.log`), `story ${String(i)} built\n`, "utf8");
  }
  mkdirSync(join(ws.root, "empty-dir"), { recursive: true });
  writeFileSync(join(ws.root, "empty-file.md"), "", "utf8");
  writeFileSync(join(ws.root, "docs-retention.md"), "# Retention\n\nRows are kept for 30 days.\n", "utf8");
  clearSrcCaches();
  return { root: ws.root, runDir, ctx: toSrcContext(loadWorkspace(ws.root), runDir) };
}

function resolve(probe: AbsentProbe, src: string, section = "Unknowns", claim = "none"): unknown {
  const ref = classifySrc(src) as SrcRef;
  return resolveSrc(ref, probe.ctx, section, claim);
}

describe("#110 · `absent:` resolves to ok or noted, never to `unverified`", () => {
  test("a path that is not there at all: the absence is literal — ok", () => {
    const probe = absentProbe();
    expect(resolve(probe, "absent:ops/backup.yml")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("an EMPTY file holds nothing to have missed — ok", () => {
    const probe = absentProbe();
    expect(resolve(probe, "absent:empty-file.md")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("an EMPTY directory holds nothing to have missed — ok", () => {
    const probe = absentProbe();
    expect(resolve(probe, "absent:empty-dir")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("a file that EXISTS with content is `noted` — legal, never fatal, never silent", () => {
    const probe = absentProbe();
    expect(resolve(probe, "absent:.tldrx/memory/facts.yml")).toMatchObject({
      ok: true,
      outcome: "noted",
      message: expect.stringContaining("unchecked"),
    });
  });

  test("#105 · a directory of seven files is REACHED and `noted` — it no longer resolves to nothing", () => {
    const probe = absentProbe();
    // The mechanism behind #105: `absent:` resolved against the workspace root
    // ONLY, so a run-relative path never even saw the directory it named and
    // returned a silent `ok`. It resolves against the same bases a `file` src does.
    const resolution = resolve(probe, "absent:01-what/log") as { outcome: string; message?: string };
    expect(resolution.outcome).toBe("noted");
    expect(resolution.message).toContain("7");
  });

  test("a POSITIVE claim sourced by an absence is still REFUSED", () => {
    const probe = absentProbe();
    expect(resolve(probe, "absent:ops/backup.yml", "Findings", "we removed the auth check from /admin"))
      .toMatchObject({ ok: false, outcome: "refused" });
  });
});

describe("#110 · `absent:<path>#<needle>` makes an absence checkable, both ways", () => {
  test("the needle is parsed off the path, not swallowed by it", () => {
    expect(classifySrc("absent:docs-retention.md#rankings")).toMatchObject({
      kind: "absent",
      path: "docs-retention.md",
      needle: "rankings",
    });
  });

  test("a needle that is NOT in the file: the absence is VERIFIED — ok, and not noted", () => {
    const probe = absentProbe();
    expect(resolve(probe, "absent:docs-retention.md#rankings")).toMatchObject({ ok: true, outcome: "ok" });
  });

  test("a needle that IS in the file is REFUSED, and the refusal names the line", () => {
    const probe = absentProbe();
    expect(resolve(probe, "absent:docs-retention.md#30 days")).toMatchObject({
      ok: false,
      outcome: "refused",
      message: expect.stringContaining("docs-retention.md:3"),
    });
  });

  test("an empty needle is a grammar refusal, with its own rule", () => {
    const classified = classifySrc("absent:docs-retention.md#") as { rule?: string };
    expect(classified.rule).toBe("absent-needle");
  });
});

// --- the two checkers agree ---------------------------------------------------

const CLAIM_SOURCES: PlannedCheck = {
  id: "claim-sources", on: "gate", repo: null, command: null, expect_exit: 0,
};

/** A handoff carrying BOTH live citations: the misuse and the honest negative case. */
function bothAbsents(): string {
  return [
    "# Handoff",
    "",
    "## Findings",
    "- The fixture workspace declares its repos [src: .tldrx/workspace.yml:1]",
    "",
    "## Decisions",
    "- Proceed on the declared repos [src: .tldrx/workspace.yml:1]",
    "",
    "## Unknowns",
    "- none [src: absent:01-what/log]",
    "- no rule for abandoned hunts is recorded [src: absent:.tldrx/memory/facts.yml]",
    "",
    "## Evidence ledger",
    "- The fake agent wrote this file [src: .tldrx/workspace.yml:1]",
    "",
  ].join("\n");
}

describe("#110 · claim-sources and the auto gate say the same thing about the same file", () => {
  test("claim-sources PASSES and NAMES the unchecked absences — it never waves them through in silence", async () => {
    const ws = workspace([ASKER]);
    mkdirSync(join(ws.runDir, "01-what", "log"), { recursive: true });
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(ws.runDir, "01-what", "log", `S${String(i)}.log`), "built\n", "utf8");
    }
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), bothAbsents(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), "# Questions\n\nNone.\n", "utf8");
    clearSrcCaches();
    const outcome = await runCheck(CLAIM_SOURCES, {
      root: ws.root,
      runDir: ws.runDir,
      stage: loadWorkflowPreset(ws.root, RunStore.open(ws.runDir).run.scope).stages[0] as never,
    });
    expect(outcome.status).toBe("passed");
    expect(outcome.detail).toContain("unchecked absence: 2");
  });

  test("and the auto gate closes over exactly the same file, naming them too", async () => {
    const ws = workspace([ASKER]);
    mkdirSync(join(ws.runDir, "01-what", "log"), { recursive: true });
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(ws.runDir, "01-what", "log", `S${String(i)}.log`), "built\n", "utf8");
    }
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), bothAbsents(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), "# Questions\n\nNone.\n", "utf8");
    clearSrcCaches();
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.why).toBe("");
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain("unchecked absence: 2");
  });

  test("an absence that is DISPROVED fails both: the check refuses, and so does the gate", async () => {
    const ws = workspace([ASKER]);
    writeFileSync(join(ws.root, "retention.md"), "# Retention\n\nRows are kept for 30 days.\n", "utf8");
    writeFileSync(
      join(ws.runDir, "01-what", "handoff.md"),
      cannedHandoff().replace(
        "- none [src: absent:.tldrx/memory/notes.md]",
        "- no retention rule is written down [src: absent:retention.md#30 days]",
      ),
      "utf8",
    );
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), "# Questions\n\nNone.\n", "utf8");
    clearSrcCaches();
    const outcome = await runCheck(CLAIM_SOURCES, {
      root: ws.root,
      runDir: ws.runDir,
      stage: loadWorkflowPreset(ws.root, RunStore.open(ws.runDir).run.scope).stages[0] as never,
    });
    expect(outcome.status).toBe("failed");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("claim-sources");
  });
});
