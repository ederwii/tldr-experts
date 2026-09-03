/**
 * gh #140 — a `file` src whose path lives ONLY on this run's unmerged epic branch.
 *
 * Live shape, run `260830-money-and-payments` (aparece-v2, closed 2026-09-03):
 * `retro.md` on `main` carried 96 `[src: src/Modules/Payments/…:28]` citations to
 * files that exist on `epic/money-and-payments` and nowhere else. The driver's
 * words: "cuatro de mis citas apuntaban a archivos que solo existen en el epic.
 * Nadie me las señaló."
 *
 * #16 made those resolve against the epic WORKTREE — a directory that is deleted
 * when the run's worktrees are cleaned up, and that never existed for a reader who
 * clones `main`. So the same citation has two silent answers depending on a temp
 * directory. The fix resolves against the recorded REF (`run.yml`'s
 * `build.epic_branch`) with a git blob read at check time, and NAMES the ref it
 * resolved on so a reader of `main` knows where to look.
 *
 * The `git` in these tests is real: a stubbed one would let the blob read be wrong
 * in the same direction as the code under test.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "../src/core/run/checks.ts";
import type { PlannedCheck, PlannedStage } from "../src/core/run/workflowPreset.ts";
import { validateHandoff } from "../src/core/text/handoff.ts";
import { loadWorkspace, toSrcContext } from "../src/hooks/lib/workspace.ts";
import { clearSrcCaches } from "../src/core/text/index.ts";
import { makeWorkspace, FIXTURE_RUN, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { evaluateAutoGate } from "../src/core/run/autoGate.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { fastestOf, perfBudgetMs, spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test here `git init`s a repo and the code under test spawns `git cat-file`,
// so the budget is the load-aware one: a fixed number would measure the box (#43).
setDefaultTimeout(spawnTestTimeout());

/** The branch the live run cut, spelled exactly as `run.yml` recorded it. */
const EPIC = "epic/money-and-payments";
/** A path that exists on that branch and on no merged ref. */
const EPIC_ONLY = "src/Modules/Payments/CreateChargeHandler.cs";

let ws: TempWorkspace | null = null;
afterEach(() => {
  ws?.dispose();
  ws = null;
  clearSrcCaches();
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=tldrx", "-c", "user.email=tldrx@example.com", ...args], {
    cwd, stdio: "ignore",
  });
}

function writeFile(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/**
 * The fixture workspace with `api/` turned into a real git repo that has an
 * UNMERGED epic branch and NO worktree on disk — the state `main` is in after the
 * run's worktrees are cleaned up, and the state a fresh clone is always in.
 */
function withEpicBranch(options: { readonly recorded?: readonly string[]; readonly merged?: boolean } = {}): TempWorkspace {
  const w = makeWorkspace();
  ws = w;
  const repo = join(w.root, "api");
  git(repo, ["init", "-b", "main", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "main: Hunt.cs"]);
  git(repo, ["checkout", "-q", "-b", EPIC]);
  writeFile(repo, EPIC_ONLY, `${Array.from({ length: 30 }, (_, i) => `// line ${String(i + 1)}`).join("\n")}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "epic: payments"]);
  git(repo, ["checkout", "-q", "main"]);
  if (options.merged === true) git(repo, ["merge", "-q", "--no-ff", "-m", "merge epic", EPIC]);
  const recorded = options.recorded ?? [EPIC];
  appendFileSync(
    join(w.runDir, "run.yml"),
    `build: {epic_branch: [${recorded.map((b) => `"${b}"`).join(", ")}], branch_model: integration}\n`,
    "utf8",
  );
  return w;
}

const CHECK: PlannedCheck = { id: "claim-sources", on: "gate", repo: null, command: null, expect_exit: 0 };

function stage(outputs: readonly string[]): PlannedStage {
  return {
    id: "contracts", title: "Contracts", phase: "02-how", model: null, effort: null, experts: [],
    budget_usd: 1, timeout_s: 60, inputs: [], outputs, sections: new Map(), gateType: "approve",
    checks: [CHECK], preconditions: [], questionsPath: null, source: "test",
  };
}

async function check(w: TempWorkspace, outputs: readonly string[]): Promise<{ status: string; detail: string }> {
  const outcome = await runCheck(CHECK, { root: w.root, runDir: w.runDir, stage: stage(outputs) });
  return { status: outcome.status, detail: outcome.detail };
}

function handoff(sections: Readonly<Record<string, readonly string[]>>): string {
  const out: string[] = ["# Handoff — 02-how / contracts", ""];
  for (const name of ["Findings", "Decisions", "Unknowns", "Evidence ledger"]) {
    out.push(`## ${name}`, "", ...(sections[name] ?? ["- fine [src: api:src/Hunt.cs:1]"]), "");
  }
  return `${out.join("\n")}\n`;
}

function write(w: TempWorkspace, rel: string, text: string): void {
  writeFile(w.runDir, rel, text);
}

describe("#140 — a citation that resolves only on the run's unmerged epic ref", () => {
  test("it resolves, and the check's detail NAMES the ref it resolved on", async () => {
    const w = withEpicBranch();
    write(w, "02-how/handoff.md", handoff({
      Findings: [`- the charge handler validates the amount [src: api:${EPIC_ONLY}:28]`],
    }));
    const outcome = await check(w, ["02-how/handoff.md"]);
    expect(outcome.status).toBe("passed");
    expect(outcome.detail).toContain(EPIC);
    expect(outcome.detail).toContain("unmerged");
  });

  test("a bare path (no repo prefix) resolves on the epic ref too", async () => {
    const w = withEpicBranch();
    write(w, "02-how/handoff.md", handoff({
      Findings: [`- the handler is here [src: api/${EPIC_ONLY}:1]`],
    }));
    const outcome = await check(w, ["02-how/handoff.md"]);
    expect(outcome.status).toBe("passed");
    expect(outcome.detail).toContain(EPIC);
  });

  test("a citation that resolves NOWHERE stays broken", async () => {
    const w = withEpicBranch();
    write(w, "02-how/handoff.md", handoff({
      Findings: ["- invented [src: api:src/Modules/Payments/NoSuchThing.cs:1]"],
    }));
    const outcome = await check(w, ["02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("no such file");
  });

  test("a line past the end of the epic blob is refused, and the refusal names the ref", async () => {
    const w = withEpicBranch();
    write(w, "02-how/handoff.md", handoff({
      Findings: [`- line 999 says so [src: api:${EPIC_ONLY}:999]`],
    }));
    const outcome = await check(w, ["02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain(EPIC);
    expect(outcome.detail).toContain("30 line(s)");
  });

  test("a path on a MERGED ref resolves normally, with no annotation", async () => {
    const w = withEpicBranch({ merged: true });
    write(w, "02-how/handoff.md", handoff({
      Findings: [`- merged and on disk [src: api:${EPIC_ONLY}:28]`],
    }));
    const outcome = await check(w, ["02-how/handoff.md"]);
    expect(outcome.status).toBe("passed");
    expect(outcome.detail).not.toContain("unmerged");
    expect(outcome.detail).not.toContain(EPIC);
  });

  test("a branch the run did NOT record is not a base — only `build.epic_branch` is", async () => {
    const w = withEpicBranch({ recorded: [] });
    write(w, "02-how/handoff.md", handoff({
      Findings: [`- unrecorded [src: api:${EPIC_ONLY}:1]`],
    }));
    const outcome = await check(w, ["02-how/handoff.md"]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("no such file");
  });

  /**
   * The OTHER half of #140's silence, and the reason a worktree is not the answer.
   * While the run's epic checkout is still on disk, #16's base resolves the very
   * same citation — and said NOTHING about the fact that the path is on no merged
   * ref. That is the state the live retro was written in; the directory was then
   * cleaned up and the document on `main` was left pointing at nothing.
   */
  test("while the epic WORKTREE is still on disk the same citation is also named as unmerged", async () => {
    const w = withEpicBranch();
    const tree = join(w.root, ".tldrx", "worktrees", "api", `_epic-${FIXTURE_RUN}-integration`);
    writeFile(tree, EPIC_ONLY, `${Array.from({ length: 30 }, (_, i) => `// line ${String(i + 1)}`).join("\n")}\n`);
    write(w, "02-how/handoff.md", handoff({
      Findings: [`- the charge handler validates the amount [src: api:${EPIC_ONLY}:28]`],
    }));
    const outcome = await check(w, ["02-how/handoff.md"]);
    expect(outcome.status).toBe("passed");
    expect(outcome.detail).toContain("unmerged");
  });

  /**
   * The objection that made design (b) look expensive, measured rather than assumed.
   *
   * A blob read is a `spawnSync`, and `hooks/claim-sources.ts` runs this validator on
   * EVERY PreToolUse Write/Edit inside a 50 ms budget (spec §0). The guard is not a
   * cap, it is reachability: the hook's spelling of the context leaves `epicRefs`
   * empty, so no amount of epic-only citations can reach a subprocess from a write.
   * 200 of them are validated here — the live #140 document had 96 — and the budget
   * is the same one `test/text.test.ts` holds a 256 KB handoff to.
   */
  test("200 epic-only citations stay inside the 50 ms write-time budget on the hook path", () => {
    const w = withEpicBranch();
    const hookCtx = toSrcContext(loadWorkspace(w.root), w.runDir);
    const bullet = `- the handler validates [src: api:${EPIC_ONLY}:28]\n`;
    const text = `# Handoff\n\n## Findings\n${bullet.repeat(200)}\n`
      + "## Decisions\n\n## Unknowns\n\n## Evidence ledger\n";
    expect(fastestOf(3, () => validateHandoff(text, hookCtx))).toBeLessThan(perfBudgetMs(50));
  });

  test("the PreToolUse hook spelling of the context carries NO epic refs, so it spawns no git", () => {
    const w = withEpicBranch();
    // `toSrcContext(workspace, runDir)` is exactly what `hooks/claim-sources.ts`
    // calls. The blob fallback is opt-IN precisely so the 50 ms write-time budget
    // (spec §0) cannot be spent on a subprocess by accident.
    const hookCtx = toSrcContext(loadWorkspace(w.root), w.runDir);
    expect(hookCtx.epicRefs ?? []).toEqual([]);
    const text = handoff({ Findings: [`- epic only [src: api:${EPIC_ONLY}:28]`] });
    const report = validateHandoff(text, hookCtx);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.message).toContain("no such file");

    // The gate spelling opts in, and the same citation resolves there.
    const gateCtx = toSrcContext(loadWorkspace(w.root), w.runDir, { epicRefs: true });
    expect((gateCtx.epicRefs ?? []).map((r) => r.ref)).toContain(EPIC);
    const gated = validateHandoff(text, gateCtx);
    expect(gated.unresolved).toEqual([]);
    expect(gated.epicOnly.map((i) => i.message).join(" ")).toContain(EPIC);
  });
});

/**
 * The loose end the first pass left: `claim-sources` names the ref, and the AUTO
 * GATE'S NOTE — the thing a person actually reads when a stage signs itself —
 * dropped it.
 *
 * `claimSourcesCondition` carried `outcome.detail` into its note only when the
 * unchecked-absence count was non-zero (`absences === 0 ? "passed" : …`), which is
 * #110's fix reading exactly one of the two things that detail now carries. So a
 * stage whose handoff cites nothing but the epic and has no absences at all
 * auto-signed with a note that said, in full, `passed`.
 */
describe("#140 — the auto gate's note carries the ref too", () => {
  function autoGateWorkspace(): FacilitatorWorkspace {
    const made = makeFacilitatorWorkspace({
      scope: "demo",
      stages: [{
        id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
        outputs: [{ path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
        checks: "[claim-sources]",
      }],
      budgetUsd: 10,
      gates: { alpha: "auto" },
    });
    // Deliberately NOT `process.env.PATH = made.binDir`: only `claude` is shimmed
    // there, and both this fixture's setup and the blob read under test need a real
    // `git`. Nothing here spawns an agent, so the money guard has nothing to guard.
    const repo = join(made.root, "api");
    mkdirSync(repo, { recursive: true });
    writeFile(repo, "README.md", "# api\n");
    git(repo, ["init", "-b", "main", "-q"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "main"]);
    git(repo, ["checkout", "-q", "-b", EPIC]);
    writeFile(repo, EPIC_ONLY, `${Array.from({ length: 30 }, (_, i) => `// line ${String(i + 1)}`).join("\n")}\n`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "epic"]);
    git(repo, ["checkout", "-q", "main"]);
    appendFileSync(
      join(made.runDir, "run.yml"),
      `build: {epic_branch: ["${EPIC}"], branch_model: integration}\n`,
      "utf8",
    );
    // Epic-only citations and NOT ONE absence: the exact shape whose note read `passed`.
    writeFile(made.runDir, "01-what/handoff.md", [
      "# Handoff",
      "",
      "## Findings",
      `- the charge handler validates the amount [src: api:${EPIC_ONLY}:28]`,
      "",
      "## Decisions",
      `- keep the guard where it is [src: api:${EPIC_ONLY}:12]`,
      "",
      "## Unknowns",
      `- the refund path is not covered [src: api:${EPIC_ONLY}:30]`,
      "",
      "## Evidence ledger",
      `- the file is on the epic branch [src: api:${EPIC_ONLY}:1]`,
      "",
    ].join("\n"));
    return made;
  }

  test("a stage that cites nothing but the epic does not auto-sign with a note that just says `passed`", async () => {
    const made = autoGateWorkspace();
    try {
      const store = RunStore.open(made.runDir);
      const verdict = await evaluateAutoGate({
        root: made.root,
        runDir: made.runDir,
        phaseId: "01-what",
        stage: store.run.phases[0]?.stages[0],
        planned: loadWorkflowPreset(made.root, store.run.scope).stages[0],
        budget: store.budget,
        checks: [{ id: "claim-sources", status: "passed", detail: "1 handoff(s) sourced" }],
      } as never);
      expect(verdict.ok).toBe(true);
      expect(verdict.note).toContain(EPIC);
      expect(verdict.note).toContain("unmerged");
    } finally {
      made.dispose();
    }
  });
});
