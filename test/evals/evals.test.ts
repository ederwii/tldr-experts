/**
 * Evals v1 (#26) — one golden-transcript eval per stage of the loop.
 *
 * Read `README.md` in this directory first: it says what an eval is allowed to
 * assert, why, and how to add a sixth. `harness.ts` says how one stage is made
 * addressable on its own.
 *
 * The short version: each test opens a run on a one-stage workflow preset in a
 * synthetic workspace, hands the stand-in `claude` a fixed script, runs the REAL
 * stage through the REAL facilitator, and asserts the stage's output CONTRACT —
 * the artifacts exist, they validate under the framework's own parsers, the
 * stage's `checks:` passed with the detail the framework computed, and the side
 * effects the stage exists for actually happened.
 *
 * Contract, not snapshot. Nothing here compares bytes: a prompt reworded or a
 * sentence rephrased must not turn this file red, and a grammar tightened or a
 * check dropped must.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../src/core/paths.ts";
import { runtime } from "../../src/core/runtime/index.ts";
import { makeSandbox, sandboxEnv, type Sandbox } from "../../src/core/learn/sandbox.ts";
import { parseQuestions, validateQuestions } from "../../src/core/text/questions.ts";
import { HANDOFF_SECTIONS } from "../../src/core/text/handoff.ts";
import { describeWatcherIssues, parseWatcherCard } from "../../src/core/watch/watcherFile.ts";
import { loadWorkspace, toSrcContext } from "../../src/hooks/lib/workspace.ts";
import { WRITE_TIME_ONLY } from "../../src/core/run/checks.ts";
import { spawnTestTimeout } from "../fixtures/machineLoad.ts";
import { checkOutcome, eventsOfType, runStageEval, type EvalRun } from "./harness.ts";
import { integrationBranchFor } from "../../src/core/plan/branchModel.ts";
import { BUILD_EVAL, EVALS, HOW_EVAL, PLAN_EVAL, WATCH_EVAL, WHAT_EVAL } from "./scenarios.ts";

// Every eval spawns real `tldrx` subprocesses, which spawn the stand-in in turn.
// Process cost is a property of the machine, not of the code (#43).
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const SELF: readonly [string, string] = [process.execPath, BIN];

let sandbox: Sandbox;
let scratch = "";

/**
 * ONE synthetic workspace for all five evals, detected once.
 *
 * `tldrx init` is offline (`--provider static`) and deterministic, and the runs
 * are independent of each other — each opens its own run on its own one-stage
 * preset — so paying for detection five times would buy nothing. What the evals
 * DO share is the toy repo's git history, and Build is the only stage that
 * touches it: it works in a worktree and merges into an epic branch, never into
 * `main` (`stages/build/stage.md:65`).
 */
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "tldrx-evals-"));
  sandbox = await makeSandbox({ root: scratch, reset: true, selfCommand: SELF });

  const init = await runtime.spawn(SELF[0], [SELF[1], "init", "--provider", "static", "--no-interview"], {
    cwd: sandbox.workspace,
    env: sandboxEnv(sandbox),
  });
  if (init.exitCode !== 0) {
    throw new Error(`the eval workspace could not be initialised (exit ${String(init.exitCode)}):\n${init.stdout}\n${init.stderr}`);
  }
  // What `init` wrote is committed before any eval runs: Build cuts a worktree
  // off this repo, and a tree with untracked framework state in it is not the
  // tree the story is supposed to change.
  await commitAll(sandbox.workspace, "the workspace, as `tldrx init` left it");
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

async function commitAll(dir: string, message: string): Promise<void> {
  await runtime.spawn("git", ["add", "-A"], { cwd: dir });
  await runtime.spawn("git", [
    "-c", "user.email=evals@tldrx.invalid", "-c", "user.name=tldrx evals",
    "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message,
  ], { cwd: dir });
}

/** The source-resolution context the framework itself would use for this run. */
function srcContextFor(runDir: string) {
  return toSrcContext(loadWorkspace(sandbox.workspace), runDir);
}

/** Read-only git in the toy repo, for the assertions only a history can settle. */
async function git(cwd: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runtime.spawn("git", args, { cwd });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The three things EVERY stage owes, whatever it is for.
 *
 * Asserted from one helper so a new eval cannot forget them, and so the failure
 * message names the stage rather than a line number.
 */
function expectStageContract(run: EvalRun, stage: string, phase: string, checks: readonly string[]): void {
  // 4 is `awaiting a human`, and it is the PASS: the stage ran, every declared
  // output was re-read off disk by `validateOutputs`, every check ran, and the
  // decision is a person's. A failed check or a missing output never reaches it.
  expect(run.exitCode, `${stage}: ${run.said}`).toBe(4);

  const requested = eventsOfType(run.events, "gate.requested");
  expect(requested.length, `${stage}: no gate was requested — the stage never finished`).toBe(1);
  expect(String(requested[0]?.payload?.phase), `${stage}: the gate names the wrong phase`).toBe(phase);

  for (const id of checks) {
    const outcome = checkOutcome(run.events, id);
    expect(outcome, `${stage}: the \`${id}\` check never ran — the stage no longer declares it`).not.toBeNull();
    // A gate-time check must PASS. A write-time-only one (`no-reask`,
    // `budget-gate`, `dod`) is legitimately `skipped` here — it already did its
    // work in a PreToolUse hook. What is never acceptable is a check that was
    // skipped for any OTHER reason: `runCheck` falls through to
    // `unknown check id '<x>'` (`run/checks.ts:72`), which is what a renamed or
    // deleted check looks like from here, and it would otherwise read as a pass.
    const expected = WRITE_TIME_ONLY.includes(id) ? "skipped" : "passed";
    expect(outcome?.status, `${stage}: \`${id}\` — ${outcome?.detail ?? ""}`).toBe(expected);
    expect(outcome?.detail, `${stage}: \`${id}\` is no longer a check the framework knows`)
      .not.toContain("unknown check id");
  }
}

/** Every H2 of `HANDOFF_SECTIONS`, in order, with something under it. */
function expectHandoffShape(text: string, where: string): void {
  let at = -1;
  for (const heading of HANDOFF_SECTIONS) {
    const found = text.indexOf(`## ${heading}`);
    expect(found, `${where}: no \`## ${heading}\` section`).toBeGreaterThan(-1);
    expect(found, `${where}: \`## ${heading}\` is out of order`).toBeGreaterThan(at);
    at = found;
  }
}

describe("evals — the What stage's output contract", () => {
  test("six sourced artifacts, a handoff claim-sources accepts, and a question in the grammar", async () => {
    const run = await runStageEval(sandbox, SELF, WHAT_EVAL);

    expectStageContract(run, "what", "01-what", ["claim-sources", "no-reask", "budget-gate"]);

    // 1. every declared output is on disk. Read through `gate.requested`, which
    //    carries the list `validateOutputs` just re-read, so a stage that quietly
    //    stopped declaring one fails here rather than passing with less.
    const declared = (eventsOfType(run.events, "gate.requested")[0]?.payload?.outputs ?? []) as string[];
    expect([...declared].sort()).toEqual([
      "01-what/handoff.md", "01-what/intent.md", "01-what/open-questions.md",
      "01-what/questions.md", "01-what/scope.md", "01-what/success-metrics.md",
    ]);

    // 2. the handoff's four sections, in order — the shape `claim-sources` reads.
    expectHandoffShape(run.read("01-what/handoff.md"), "01-what/handoff.md");

    // 3. the question parses AND validates under the framework's own grammar
    //    (`core/text/questions.ts`), not under a copy of it kept here. One open
    //    question, id Q1, with the `·` heading, five metadata keys and A-E options.
    const doc = parseQuestions(run.read("01-what/questions.md"));
    // The block count first, and it is load-bearing: `validateQuestions` over a
    // doc the parser found NOTHING in returns no issues at all, so an empty
    // result on its own would be a vacuous pass — which is exactly the failure
    // measured 2026-08-29 (`questions.ts:96`), four questions written and zero
    // parsed, and the gate auto-closing on the silence.
    expect(doc.blocks.length, "the What questions.md parsed to nothing at all").toBe(1);
    expect(validateQuestions(doc), "the What question does not satisfy the §2.7 grammar").toEqual([]);
    expect(doc.blocks[0]?.id).toBe("Q1");
    expect(doc.blocks[0]?.metadata?.status).toBe("open");
    // What's job is to come back with what it does NOT know: an open question
    // with an empty `[Answer]:` slot is that job done, and it is the shape
    // `tldrx answer` turns into a fact.
    expect(doc.blocks[0]?.answer, "the What question arrived pre-answered").toBe("");

    // 4. the money was metered, whoever spent it. A stage that stopped recording
    //    cost would still write every file above.
    const spent = Number(eventsOfType(run.events, "gate.requested")[0]?.payload?.cost_usd ?? 0);
    expect(spent, "the What stage recorded no cost at all").toBeGreaterThan(0);
  });
});

describe("evals — the How stage's output contract", () => {
  test("claim-sources reads EVERY declared markdown, not only the handoff (#34)", async () => {
    const run = await runStageEval(sandbox, SELF, HOW_EVAL);

    expectStageContract(run, "how", "02-how", ["claim-sources", "no-reask", "budget-gate"]);

    const declared = (eventsOfType(run.events, "gate.requested")[0]?.payload?.outputs ?? []) as string[];
    expect([...declared].sort()).toEqual([
      "02-how/contracts.md", "02-how/design.md", "02-how/handoff.md",
      "02-how/questions.md", "02-how/risks.md", "02-how/test-strategy.md",
    ]);

    expectHandoffShape(run.read("02-how/handoff.md"), "02-how/handoff.md");

    // The #34 half, stated so it cannot silently regress: the check's own detail
    // counts the sourced documents it read, and there are more of them than the
    // one handoff. A check that narrowed back to `handoff.md` alone would still
    // pass — but it would not still say this.
    const claims = checkOutcome(run.events, "claim-sources");
    expect(claims?.detail, `claim-sources said: ${claims?.detail ?? "(nothing)"}`).toMatch(/\d+ handoff\(s\) sourced/);

    // An answered question carries no re-ask: `no-reask` is the check that says so.
    const doc = parseQuestions(run.read("02-how/questions.md"));
    expect(doc.blocks.length, "the How questions.md parsed to nothing at all").toBe(1);
    expect(validateQuestions(doc), "the How question does not satisfy the §2.7 grammar").toEqual([]);
    expect(doc.blocks[0]?.metadata?.status).toBe("answered");
  });
});

describe("evals — the Plan stage's output contract", () => {
  test("checkPlan validates the plan and states the branch model it derived", async () => {
    const run = await runStageEval(sandbox, SELF, PLAN_EVAL);

    expectStageContract(run, "plan", "03-plan", ["claim-sources", "plan", "budget-gate"]);

    expectHandoffShape(run.read("03-plan/handoff.md"), "03-plan/handoff.md");

    // The whole reason this stage has a check of its own. `checkPlan` ran
    // `validatePlan` over the artifacts — every story in exactly one wave, every
    // `depends_on` in an earlier one, every `dod` command on the allowlist — and
    // then said what it found. The counts are the framework's, not the fixture's.
    const plan = checkOutcome(run.events, "plan");
    expect(plan?.detail, `checkPlan said: ${plan?.detail ?? "(nothing)"}`)
      .toContain("2 epic(s), 3 story(ies), 2 wave(s)");

    // And the branch-model line. S3 (in E2) depends on S1 (in E1), so the epics
    // form a chain and the model is `integration`: ONE branch for the run rather
    // than one per epic. The branch name is derived from the run id — computed
    // here with the framework's own function, so a change to the derivation
    // moves the eval with it instead of breaking it.
    expect(plan?.detail).toContain("epics form a chain");
    expect(plan?.detail).toContain(integrationBranchFor(run.runId));
  });
});

describe("evals — the Build stage's output contract", () => {
  test("a story is branched, proven, committed, merged to its epic and reviewed", async () => {
    const run = await runStageEval(sandbox, SELF, BUILD_EVAL);

    // Build's gate is forced to `approve` by the executor whatever the stage file
    // says (`executors/index.ts:206`), so this is exit 4 like the rest.
    expectStageContract(run, "build", "04-build", ["claim-sources"]);

    // --- 1. the DoD was RE-RUN by the framework, and its exit code is the record.
    // Not "the developer said it passed": `runDod` executes the story's own
    // ```dod block and the event carries the command and the code it measured.
    const dod = run.events.filter((e) => e.payload?.check === "dod");
    // Exactly once. Zero means the framework took the developer's word for it;
    // more than one means the story was RETRIED, which a clean story never is —
    // a refused review is the usual cause, and it is a different bug from a DoD
    // that did not run at all.
    expect(dod.length, `the DoD ran ${String(dod.length)} time(s), not once: ${run.said}`).toBe(1);
    expect(dod[0]?.type).toBe("check.passed");
    expect(dod[0]?.payload?.command).toBe("npm run test");
    expect(dod[0]?.payload?.exit_code).toBe(0);

    // --- 2. both sub-agents were spawned, and in their roles.
    const roles = run.events
      .filter((e) => e.type === "agent.spawned")
      .map((e) => String(e.payload?.role));
    expect(roles, `Build spawned ${roles.join(", ") || "nothing"}`).toEqual(["developer", "reviewer"]);

    // --- 3. the review is a recorded verdict, not a mood.
    const review = run.events.find((e) => e.payload?.check === "review");
    expect(review?.type, "no review check was recorded").toBe("check.passed");
    expect(review?.payload?.verdict).toBe("approve");

    // --- 4. the story closed, and its EVIDENCE is measured rather than written.
    // `evidenceFor` (`build/storyFile.ts:91`) composes exactly three things: the
    // DoD command with the exit code the framework watched, the commit sha it
    // made, and the review log it wrote. None of the three exists in the fixture.
    const done = run.events.find((e) => e.type === "task.done");
    expect(done?.payload?.status, `task.done said: ${JSON.stringify(done?.payload)}`).toBe("done");
    const story = run.read("03-plan/stories/S1.md");
    expect(story).toContain("status: done");
    expect(story).toContain("$ npm run test → exit 0");
    expect(story, "the story's evidence carries no commit sha").toMatch(/commit [0-9a-f]{7}/);
    expect(story).toContain("04-build/log/S1.md");

    // --- 5. the reviewer's log, and the handoff the executor writes itself.
    expect(run.read("04-build/log/S1.md")).toContain("approve");
    expectHandoffShape(run.read("04-build/handoff.md"), "04-build/handoff.md");

    // --- 6. the merge landed on the EPIC branch, and `main` was left alone.
    // This is the assertion the stage exists for, and the one nothing scripted
    // can fake: the toy repo's own git history is the evidence.
    const epicLog = await git(sandbox.workspace, ["log", "--oneline", "epic/build-eval"]);
    expect(epicLog.exitCode, `epic/build-eval was never cut: ${epicLog.stderr}`).toBe(0);
    expect(epicLog.stdout, "the story was never merged into its epic branch").toContain("merge(S1)");
    expect(epicLog.stdout).toContain("feat(S1)");

    const onEpic = await git(sandbox.workspace, ["show", "epic/build-eval:src/prices.json"]);
    expect(onEpic.exitCode, "the developer's file is not on the epic branch").toBe(0);

    const onMain = await git(sandbox.workspace, ["show", "main:src/prices.json"]);
    expect(onMain.exitCode, "the framework wrote to `main` — it must never do that").not.toBe(0);
  });
});

describe("evals — the Watch stage's output contract", () => {
  test("the card validates, and its status is COMPUTED from its sources", async () => {
    const run = await runStageEval(sandbox, SELF, WATCH_EVAL);

    expectStageContract(run, "watch", "05-watch", ["claim-sources", "budget-gate"]);

    // The card is deliberately NOT a declared output — it has no name until the
    // pre-pass has grouped the done stories by epic (`stages/watch/stage.yml:10`).
    // Its name comes from the epic's branch: `epic/watch-eval` → `watch-eval.md`.
    const cardRel = "05-watch/watchers/watch-eval.md";
    const text = run.read(cardRel);

    // 1. it passes the SAME parser `claim-sources` uses — six sections in order,
    //    every item in a checked section carrying a source that resolves, and a
    //    fenced block under `## Query`. Imported, never re-implemented here.
    const card = parseWatcherCard(text, srcContextFor(run.runDir), "watch-eval");
    expect(describeWatcherIssues(card.issues, 5).join("\n"), `${cardRel} does not validate`).toBe("");
    expect(card.ok).toBe(true);

    // 2. and the assertion this whole eval exists for. The scenario's front
    //    matter says `status: draft`. Nothing under `## Signal` cites `absent:`,
    //    so the framework OVERWRITES it with `verified` — a value that appears
    //    nowhere in `scenarios.ts`. The executor never lets the model decide
    //    whether it succeeded (`watch/watcherFile.ts:141`), and this is that rule
    //    stated as a test.
    expect(text, `${cardRel} kept the status the model claimed`).toContain("status: verified");
    // `decidedStatus` is the status the card DESERVES, recomputed here from the
    // bytes on disk; `absentSignals` is the only thing that could have made it
    // `draft`. Asserting both says WHY it is verified, not merely that it is.
    expect(card.absentSignals, "a Signal item cites an absence").toEqual([]);
    expect(card.decidedStatus).toBe("verified");

    // 3. the handoff Watch writes itself, from the cards rather than from a model.
    expectHandoffShape(run.read("05-watch/handoff.md"), "05-watch/handoff.md");
    expect(run.read("05-watch/handoff.md")).toContain("watch-eval");
  });
});

/**
 * The guard that makes "add eval #6" a gate rather than a suggestion.
 *
 * `EVALS` is the list `scenarios.ts` exports and `README.md` tells the next
 * person to add to. Without something reading it, that instruction is inert and
 * the suite would silently stop covering the loop the day a sixth stage ships.
 */
describe("evals — coverage", () => {
  test("every stage this build ships has an eval", () => {
    const shipped = readdirSync(join(FRAMEWORK_ROOT, "stages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const covered = EVALS.map((evaluation) => evaluation.stage).sort();
    expect(covered, `stages/ ships ${shipped.join(", ")} — write an eval for the missing one (test/evals/README.md)`)
      .toEqual(shipped);
  });
});
