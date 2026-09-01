/**
 * The claim-sources cluster: issues #33, #34, #23 and #16.
 *
 * All four are the same code path — the §2.8 evidence grammar, who runs it, over
 * which files, and against which tree — so they are measured together here.
 *
 *   #33  a gate re-check reports EVERY problem it found, not the first one.
 *   #34  every declared `.md` output that carries the grammar is checked, not
 *        only `handoff.md`.
 *   #23  the execution-claim patterns read the verb, not just the noun.
 *   #16  a `file` src resolves against this run's epic worktree as well as the
 *        working tree, so a Watch stage can cite the epic's unmerged code.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "../src/core/run/checks.ts";
import type { PlannedCheck, PlannedStage } from "../src/core/run/workflowPreset.ts";
import { executionClaim } from "../src/core/training/claimCheck.ts";
import { validateHandoff } from "../src/core/text/handoff.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { clearSrcCaches } from "../src/core/text/index.ts";
import { makeWorkspace, FIXTURE_RUN, type TempWorkspace } from "./fixtures/tempWorkspace.ts";

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

const CHECK: PlannedCheck = { id: "claim-sources", on: "gate", repo: null, command: null, expect_exit: 0 };

function stage(outputs: readonly string[]): PlannedStage {
  return {
    id: "contracts",
    title: "Contracts",
    phase: "02-how",
    model: null,
    effort: null,
    experts: [],
    budget_usd: 1,
    timeout_s: 60,
    inputs: [],
    outputs,
    sections: new Map(),
    gateType: "approve",
    checks: [CHECK],
    preconditions: [],
    questionsPath: null,
    source: "test",
  };
}

async function check(outputs: readonly string[]): Promise<{ status: string; detail: string }> {
  const w = workspace();
  const outcome = await runCheck(CHECK, { root: w.root, runDir: w.runDir, stage: stage(outputs) });
  return { status: outcome.status, detail: outcome.detail };
}

function write(rel: string, lines: readonly string[]): void {
  const path = join(workspace().runDir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** A handoff with the four sections, each holding whatever the caller passes. */
function handoff(sections: Readonly<Record<string, readonly string[]>>): readonly string[] {
  const out: string[] = ["# Handoff — 02-how / contracts", ""];
  for (const name of ["Findings", "Decisions", "Unknowns", "Evidence ledger"]) {
    out.push(`## ${name}`, "", ...(sections[name] ?? ["- fine [src: api:src/Hunt.cs:1]"]), "");
  }
  return out;
}

describe("#33 — a claim-sources re-check reports every problem, not the first", () => {
  test("two unresolvable sources are BOTH named", async () => {
    write("02-how/handoff.md", handoff({
      Findings: [
        "- one [src: api:src/NoSuchFile.cs:1]",
        "- two [src: lab:src/AlsoMissing.ts:2]",
      ],
    }));
    const outcome = await check(["02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("NoSuchFile.cs");
    expect(outcome.detail).toContain("AlsoMissing.ts");
  });

  test("the bullet cap is reported even when an unresolvable source comes first", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `- claim ${String(i)} [src: api:src/Hunt.cs:1]`);
    write("02-how/handoff.md", handoff({
      Findings: ["- bad [src: api:src/NoSuchFile.cs:1]", ...many],
    }));
    const outcome = await check(["02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    // Both: the citation that does not resolve AND the cap breach behind it.
    expect(outcome.detail).toContain("NoSuchFile.cs");
    expect(outcome.detail).toContain("cap");
  });

  test("categories do not hide each other: unsourced, empty section and unresolved together", async () => {
    write("02-how/handoff.md", handoff({
      Findings: ["- no citation at all"],
      Decisions: ["- bad [src: api:src/NoSuchFile.cs:1]"],
      Unknowns: ["_prose only, no list item_"],
    }));
    const outcome = await check(["02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("unsourced");
    expect(outcome.detail).toContain("NoSuchFile.cs");
    expect(outcome.detail).toContain("Unknowns");
  });

  test("a second declared handoff is not hidden behind the first one's failure", async () => {
    write("02-how/handoff.md", handoff({ Findings: ["- bad [src: api:src/FirstMissing.cs:1]"] }));
    write("02-how/second-handoff.md", handoff({ Findings: ["- bad [src: api:src/SecondMissing.cs:1]"] }));
    const outcome = await check(["02-how/handoff.md", "02-how/second-handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("FirstMissing.cs");
    expect(outcome.detail).toContain("SecondMissing.cs");
  });
});

describe("#34 — every declared .md output that carries the grammar is checked", () => {
  test("an unresolvable citation in design.md fails the stage", async () => {
    write("02-how/handoff.md", handoff({}));
    write("02-how/design.md", [
      "# Design",
      "",
      "- the view is refreshed on HuntCompleted [src: api:src/NoSuchFile.cs:1]",
    ]);
    const outcome = await check(["02-how/design.md", "02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("design.md");
    expect(outcome.detail).toContain("NoSuchFile.cs");
  });

  test("a malformed token in contracts.md fails the stage", async () => {
    write("02-how/handoff.md", handoff({}));
    write("02-how/contracts.md", [
      "# Contracts",
      "",
      "- the DTO gains a rank field `[src: api:src/Hunt.cs:1]` and is regenerated",
    ]);
    const outcome = await check(["02-how/contracts.md", "02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("contracts.md");
    expect(outcome.detail).toContain("malformed");
  });

  test("`$ … → exit n` outside an Evidence ledger fails the stage", async () => {
    write("02-how/handoff.md", handoff({}));
    write("02-how/risks.md", [
      "# Risks",
      "",
      "- the suite is green today [src: $ dotnet build → exit 0]",
    ]);
    const outcome = await check(["02-how/risks.md", "02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("risks.md");
    expect(outcome.detail).toContain("Evidence ledger");
  });

  test("a declared output that cites nothing is left alone — prose is not a claim here", async () => {
    write("02-how/handoff.md", handoff({}));
    write("02-how/design.md", ["# Design", "", "- a bullet with no citation at all", "", "Some prose."]);
    write("02-how/questions.md", [
      "## Q1 · Where does leaderboard state live?",
      "<!-- id: Q1 | status: open | area: data-model | asked_by: architect | asked_at: 2026-08-28T14:02:11Z -->",
      "Why asked: no ranking store exists [src: absent:.tldrx/memory/facts.yml]",
      "",
      "- A) New Postgres table",
      "- B) Redis sorted set",
      "",
      "[Answer]:",
    ]);
    const outcome = await check(["02-how/design.md", "02-how/questions.md", "02-how/handoff.md"]);
    expect(outcome.status).toBe("passed");
  });

  test("a declared non-handoff output that was never written is not a failure", async () => {
    write("02-how/handoff.md", handoff({}));
    const outcome = await check(["02-how/never-written.md", "02-how/handoff.md"]);
    expect(outcome.status).toBe("passed");
  });

  test("a declared handoff that was never written still fails", async () => {
    const outcome = await check(["02-how/nothing-here/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("never written");
  });
});

describe("#23 — the execution-claim patterns read the verb, not just the noun", () => {
  test("every conjugation the issue names is an execution claim", () => {
    expect(executionClaim("`dotnet build` exit 0")).toBe("exit 0");
    expect(executionClaim("`dotnet build` exits 0")).toBe("exits 0");
    expect(executionClaim("`dotnet build` exited 0")).toBe("exited 0");
    expect(executionClaim("the command is exiting 0 on this branch")).toBe("exiting 0");
    expect(executionClaim("`npm test` exit code 0")).toBe("exit code 0");
    expect(executionClaim("`npm test` exits with code 0")).toBe("exits with code 0");
    expect(executionClaim("`npm test` exited with status 1")).toBe("exited with status 1");
  });

  test("prose that merely contains the letters is still not an execution claim", () => {
    expect(executionClaim("the exchange refuses an empty code")).toBeNull();
    expect(executionClaim("the exit path is documented")).toBeNull();
    expect(executionClaim("there are 3 exits from the flow")).toBeNull();
  });
});

describe("#16 — a file src resolves against this run's epic worktree", () => {
  function epicWorktree(repo: string, epic: string): string {
    const dir = join(workspace().root, ".tldrx", "worktrees", repo, `_epic-${FIXTURE_RUN}-${epic}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("a repo-qualified src pointing at code only on the epic branch resolves", () => {
    const tree = epicWorktree("api", "E1");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "Leaderboard.cs"), "public sealed class Leaderboard { }\n");
    const ctx = toSrcContext(loadWorkspace(workspace().root), workspace().runDir);
    const text = handoff({ Findings: ["- the view exists [src: api:src/Leaderboard.cs:1]"] }).join("\n");
    const report = validateHandoff(text, ctx);
    expect(report.unresolved).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("a bare path only on the epic branch resolves too", () => {
    const tree = epicWorktree("api", "E1");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "Ranking.cs"), "a\nb\nc\n");
    const ctx = toSrcContext(loadWorkspace(workspace().root), workspace().runDir);
    const text = handoff({ Findings: ["- ranking lives here [src: api/src/Ranking.cs:3]"] }).join("\n");
    expect(validateHandoff(text, ctx).unresolved).toEqual([]);
  });

  test("the working tree still resolves when the epic worktree lacks the file", () => {
    epicWorktree("api", "E1");
    const ctx = toSrcContext(loadWorkspace(workspace().root), workspace().runDir);
    const text = handoff({ Findings: ["- still here [src: api:src/Hunt.cs:1]"] }).join("\n");
    expect(validateHandoff(text, ctx).unresolved).toEqual([]);
  });

  test("a line beyond the epic copy still resolves against the working tree", () => {
    const tree = epicWorktree("api", "E1");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "Hunt.cs"), "one line only\n");
    const ctx = toSrcContext(loadWorkspace(workspace().root), workspace().runDir);
    const text = handoff({ Findings: ["- deep line [src: api:src/Hunt.cs:8]"] }).join("\n");
    expect(validateHandoff(text, ctx).unresolved).toEqual([]);
  });

  test("a file in NO tree is still refused, and says what it tried", () => {
    epicWorktree("api", "E1");
    const ctx = toSrcContext(loadWorkspace(workspace().root), workspace().runDir);
    const text = handoff({ Findings: ["- nowhere [src: api:src/Nowhere.cs:1]"] }).join("\n");
    const report = validateHandoff(text, ctx);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.message).toContain("no such file");
  });

  test("another run's epic worktree is NOT a base for this run", () => {
    const other = join(workspace().root, ".tldrx", "worktrees", "api", "_epic-260101-other-E1", "src");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "Foreign.cs"), "x\n");
    const ctx = toSrcContext(loadWorkspace(workspace().root), workspace().runDir);
    const text = handoff({ Findings: ["- foreign [src: api:src/Foreign.cs:1]"] }).join("\n");
    expect(validateHandoff(text, ctx).unresolved).toHaveLength(1);
  });
});
