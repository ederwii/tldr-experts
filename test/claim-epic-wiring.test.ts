/**
 * #262 — an executor can persist an epic-branch claim WHILE IT IS STILL RUNNING.
 *
 * The defect this half of the wiring exists for: a SIGKILL (or a power cut, or a
 * cancelled session) between the moment Build cuts `epic/<slug>` in the repo and
 * the moment its executor RETURNS leaves the branch on disk with nothing in
 * `run.yml` to say this run cut it. `runNext` merges `ExecutorOutcome.epicBranches`
 * into `build.epic_branch` only after the executor returns, so a kill in that
 * window is unrecoverable by the next invocation: `branchClaims.ts` reads the
 * file, finds the branch in the repo and not in the record, and refuses the run
 * its own epic.
 *
 * `#248` already made the claim DURABLE once it is taken — `claimEpicBranches`
 * mutates and saves in one call — but only `runNext` could call it. This test
 * pins the seam that lets the executor take it: `ctx.claimEpicBranch(branch,
 * model)` must leave `run.yml` ON DISK naming the branch BEFORE control returns
 * to `runNext`. It therefore reads the file from a SECOND `RunStore.open` inside
 * the executor — in-memory state would prove nothing about a process that is
 * about to be killed.
 *
 * The executor is a stub swapped into `EXECUTORS` for the Watch phase, not the
 * real Build executor: the call site in `build.ts` is the peer half of #262, and
 * what is under test here is the CONTEXT `runNext` constructs, which is the same
 * object for every phase.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runNext } from "../src/core/facilitator/runNext.ts";
import {
  EXECUTORS, type ExecutorContext, type ExecutorOutcome, type StageExecutor,
} from "../src/core/facilitator/executors/index.ts";
import { WATCH_PHASE } from "../src/core/watch/index.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const REAL_WATCH = EXECUTORS.get(WATCH_PHASE);

/**
 * The registry is a `ReadonlyMap` to its importers and a plain `Map` at runtime;
 * this file is the only place that writes it, and `afterEach` puts the real
 * executor back so no other test in the process can see the stub.
 */
function swapWatchExecutor(stub: StageExecutor): void {
  (EXECUTORS as Map<string, StageExecutor>).set(WATCH_PHASE, stub);
}

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  if (REAL_WATCH !== undefined) swapWatchExecutor(REAL_WATCH);
  process.env.PATH = ORIGINAL_PATH;
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{ id: "watch", phase: WATCH_PHASE, budgetUsd: 2, gate: "approve" }],
  });
  open.push(made);
  // Nothing here may spawn: the stub executor never reaches a sub-agent. The
  // fake `claude` is first on PATH anyway, so a regression that DID spawn would
  // cost $0.00 rather than reach the real binary.
  process.env.PATH = made.binDir;
  return made;
}

/** An outcome with nothing in it — this stage's only job is to make the call. */
function nothing(): ExecutorOutcome {
  return { ok: true, awaiting: false, tasks: [], costUsd: 0, outputs: [], lines: [], error: null };
}

describe("#262 — `ctx.claimEpicBranch` persists the claim before the executor returns", () => {
  test("run.yml on disk names the branch and its model while the executor is still running", async () => {
    const ws = workspace();
    let seenBranches: readonly string[] = [];
    let seenModel: string | undefined;
    let called = false;

    swapWatchExecutor(async (ctx: ExecutorContext) => {
      ctx.claimEpicBranch("epic/probe", "per-epic");
      called = true;
      // A SECOND reader, off the file: this is what a process starting after the
      // kill would see.
      const onDisk = RunStore.open(ctx.runDir).run;
      seenBranches = onDisk.build?.epic_branch ?? [];
      seenModel = onDisk.build?.branch_model;
      return nothing();
    });

    const outcome = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });

    // Before the wiring this went red HERE: the executor really ran, and died on
    // `ctx.claimEpicBranch is not a function` — `runNext`'s catch turned it into
    // exit 5, which is what the second assertion pins. A stub that never got
    // called would fail the same way, so both are asserted.
    expect(called).toBe(true);
    expect(outcome.code).not.toBe(5);
    expect(seenBranches).toContain("epic/probe");
    expect(seenModel).toBe("per-epic");
  });
});
