/**
 * A bounded retry on a failed stage — `tldrx run auto --retry-failed <n>` (gh #233).
 *
 * The measurement behind it: an unattended `run auto` drove itself through what → how →
 * plan, signed three `auto` gates on its own, and still needed a person four times. One of
 * those four was a stage that FAILED a check and passed on the very next attempt — the
 * person typed the same command again and nothing else. That is the only rescue in the set
 * a shell-level table could have made, so it is the only one automated here.
 *
 * What these tests hold:
 *
 *   UNCHANGED BY DEFAULT   no flag ⇒ one attempt, exit 5, byte-identical lines.
 *   BOUNDED                the bound is the number of RETRIES, the stop names the count,
 *                          and the exit code is still the original 5.
 *   CONSECUTIVE ONLY       a stage that succeeds resets the count, so a run with one
 *                          recoverable failure per stage never exhausts a bound of 1.
 *   FIVE ONLY              a money refusal (2) and an awaiting-human park (4) are attempted
 *                          ONCE however large the bound — a person owns both.
 *
 * Hermetic: one `mkdtemp` workspace per case, the fake `claude` is the only thing spawned,
 * and every attempt is counted off that fake's own argv log rather than off a log line.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import { runAuto, MAX_RETRY_FAILED, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { runCommand } from "../src/cli/commands/run.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

setDefaultTimeout(spawnTestTimeout(90_000));

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR",
  "FAKE_CLAUDE_FAIL_SEQ", "FAKE_CLAUDE_FAIL_COUNTER", "FAKE_CLAUDE_ARGV_LOG",
  "FAKE_CLAUDE_SKIP_OUTPUTS_ON_ERROR", "FAKE_CLAUDE_ALT_MATCH", "FAKE_CLAUDE_ALT_OUTPUTS",
] as const;
let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const ALPHA: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
  ],
};
const BETA: StageOptions = {
  id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve",
  outputs: [{ path: "02-how/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
};

interface Made extends FacilitatorWorkspace {
  /** Every spawn of the fake agent, one JSON argv line each — the attempt counter. */
  readonly argvLog: string;
}

/** `failures`: one 0/1 per spawn, in order. Omitted ⇒ every spawn succeeds. */
function workspace(failures: readonly number[] = []): Made {
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates: { alpha: "auto", beta: "auto" },
  });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": cannedHandoff(),
    "02-how/handoff.md": cannedHandoff(),
  });
  process.env.FAKE_CLAUDE_COST = "0.42";
  const argvLog = join(made.root, "spawns.jsonl");
  process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
  if (failures.length > 0) {
    process.env.FAKE_CLAUDE_FAIL_SEQ = failures.join(",");
    process.env.FAKE_CLAUDE_FAIL_COUNTER = join(made.root, "spawn-count");
    // This file tests RETRY COUNTING, not content completeness — a "failing" spawn
    // here must not leave the same complete, valid outputs a passing one would,
    // or gh #353's settle-from-disk (`runNext.ts`) reads them back on the very
    // next attempt and settles at $0 rather than spawning again, which is exactly
    // what these fixtures are simulating did NOT happen.
    process.env.FAKE_CLAUDE_SKIP_OUTPUTS_ON_ERROR = "1";
    // Scoped per stage (rather than the one shared blob above, which every spawn
    // writes ALL of, alpha's turn included): a passing ALPHA spawn used to also
    // write BETA's declared `02-how/handoff.md` early, so when beta's own first
    // attempt later "failed" (and correctly wrote nothing, per the knob above),
    // gh #353's settle-from-disk still found beta's output already on disk from
    // alpha's turn and settled beta's RETRY without spawning it — one real spawn
    // short of what this fixture means to simulate. `FAKE_CLAUDE_ALT_MATCH`
    // switches on beta's own declared-output path, which only ITS OWN prompt's
    // preamble lists (`prompt.ts`'s `outputs:` section) — alpha's prompt never
    // contains it.
    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
      "01-what/intent.md": cannedIntent(),
      "01-what/handoff.md": cannedHandoff(),
    });
    process.env.FAKE_CLAUDE_ALT_MATCH = "02-how/handoff.md";
    process.env.FAKE_CLAUDE_ALT_OUTPUTS = JSON.stringify({ "02-how/handoff.md": cannedHandoff() });
  }
  return { ...made, argvLog };
}

function auto(ws: Made, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-09-10T09:00:00Z", ...overrides });
}

/** How many times the agent was actually spawned — measured, not inferred from stdout. */
function attempts(ws: Made): number {
  if (!existsSync(ws.argvLog)) return 0;
  return readFileSync(ws.argvLog, "utf8").split("\n").filter((line) => line !== "").length;
}

describe("with no flag, a failed stage stops the loop exactly as it always did", () => {
  test("one attempt, exit 5", async () => {
    const ws = workspace([1, 1, 1, 1]);
    const outcome = await auto(ws);
    expect(outcome.code).toBe(5);
    expect(attempts(ws)).toBe(1);
    expect(outcome.lines.some((line) => line.includes("consecutive"))).toBe(false);
  });

  test("`--retry-failed 0` is the same thing said out loud", async () => {
    const ws = workspace([1, 1, 1, 1]);
    const outcome = await auto(ws, { retryFailedStages: 0 });
    expect(outcome.code).toBe(5);
    expect(attempts(ws)).toBe(1);
  });
});

describe("the bound is the number of RETRIES, and the stop says the count", () => {
  test("`--retry-failed 2` over a stage that always fails: 3 attempts, exit 5, count named", async () => {
    const ws = workspace([1, 1, 1, 1, 1]);
    const outcome = await auto(ws, { retryFailedStages: 2 });
    expect(outcome.code).toBe(5);
    expect(attempts(ws)).toBe(3);
    const said = outcome.lines.join("\n");
    expect(said).toContain("3 consecutive stage failures");
    expect(said).toContain("--retry-failed 2");
  });

  test("a retry that succeeds carries the run on rather than stopping it", async () => {
    const ws = workspace([1, 0, 0, 0]);
    const outcome = await auto(ws, { retryFailedStages: 2 });
    expect(outcome.code).toBe(0);
    expect(attempts(ws)).toBe(3);
    expect(outcome.lines.join("\n")).toContain("retrying");
  });
});

describe("only CONSECUTIVE failures count", () => {
  test("one recoverable failure per stage never exhausts a bound of 1", async () => {
    // fail, succeed (alpha) · fail, succeed (beta). Without the reset the second
    // failure would be the second of two against a bound of one, and stop the run.
    const ws = workspace([1, 0, 1, 0]);
    const outcome = await auto(ws, { retryFailedStages: 1 });
    expect(outcome.code).toBe(0);
    expect(attempts(ws)).toBe(4);
  });
});

describe("a bound on exit 5 is never a bound on anything else", () => {
  test("a money refusal (2) is attempted once however large the bound", async () => {
    const ws = workspace();
    const outcome = await auto(ws, { retryFailedStages: 3, promptMaxBytes: 1 });
    expect(outcome.code).toBe(2);
    expect(attempts(ws)).toBe(0);
    expect(outcome.lines.join("\n")).not.toContain("retrying");
  });

  test("an awaiting-human park (4) is attempted once however large the bound", async () => {
    const ws = workspace();
    // A `human` gate on alpha: the stage runs once, parks for a person, and stops.
    const made = makeFacilitatorWorkspace({
      scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates: { alpha: "human", beta: "human" },
    });
    open.push(made);
    process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
    process.env.PATH = made.binDir;
    const argvLog = join(made.root, "spawns.jsonl");
    process.env.FAKE_CLAUDE_ARGV_LOG = argvLog;
    writeFileSync(join(made.root, ".keep"), "", "utf8");
    const outcome = await auto({ ...made, argvLog }, { retryFailedStages: 3 });
    expect(outcome.code).toBe(4);
    expect(attempts({ ...made, argvLog })).toBe(1);
    expect(ws.root).not.toBe(made.root);
  });
});

describe("a bound the loop will not honour is refused by name, not clamped", () => {
  test("one past the cap is a usage error (exit 1) and spawns nothing", async () => {
    const ws = workspace();
    const code = await runCommand.run(
      ["auto", "--retry-failed", String(MAX_RETRY_FAILED + 1), "--root", ws.root, "--ui", "off"],
    );
    expect(code).toBe(1);
    expect(attempts(ws)).toBe(0);
  });

  test("a fraction is refused too — a bound of 1.5 attempts is not a thing", async () => {
    const ws = workspace();
    const code = await runCommand.run(["auto", "--retry-failed", "1.5", "--root", ws.root, "--ui", "off"]);
    expect(code).toBe(1);
    expect(attempts(ws)).toBe(0);
  });
});
