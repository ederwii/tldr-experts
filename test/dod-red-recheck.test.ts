/**
 * #163, sub-fix 1 — a story-owned red DoD is MEASURED TWICE before it pins a
 * story `blocked`.
 *
 * Measured on a .NET workspace, 2026-09-05 (transcript A, L526): the framework
 * blocked story S1 because its DoD gate returned `dotnet test → exit 2`. The
 * operator then ran the identical suite twice — in the story worktree and on the
 * epic branch — and got exit 0, 2860 tests, 0 failing. The red was contention
 * over a container runtime, and it had consumed the story's last attempt. The
 * record could not tell that flake from a defect: one exit code, no second
 * reading, and `blocked` is terminal in-run.
 *
 * Owner decision (Slack q_mu2lhfin2d03c3c5, authority owner-decision): "A —
 * re-run the red DoD command once and record both exit codes." Nothing about
 * terminality changes here: a red that does not reproduce still blocks, it is
 * only no longer indistinguishable from one that does.
 *
 * Every test below runs the real `runStoryDod` against a real script.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStoryDod } from "../src/core/build/dodRunner.ts";
import {
  dodFailure, dodFailureReason, dodGreen, dodRecheckReproduced,
  RECHECK_ABSENT_MARK, RECHECK_NOT_REPRODUCED_MARK, RECHECK_REPRODUCED_MARK,
  type DodResult,
} from "../src/core/build/outcome.ts";
import { readReviewLedger } from "../src/core/facilitator/executors/build.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

/** Red every time it is asked — a genuine defect. */
const STABLE_RED = `#!/bin/sh
echo "FAIL test_x — AssertionError: expected 3, got 4"
exit 2
`;

/**
 * The field case, reproduced: red on the FIRST run and green on every run after
 * it, because what failed was contention and not the code. The marker file is
 * the container runtime somebody else was holding.
 */
const FLAKY_RED = `#!/bin/sh
if [ -f "$(dirname "$0")/.taken" ]; then
  echo "2860 tests, 0 failing"
  exit 0
fi
touch "$(dirname "$0")/.taken"
echo "FAIL test_x — the container runtime was busy"
exit 2
`;

/** Exit 127: the binary was never in this tree — an environment absence (#209). */
const ABSENT_BINARY = `#!/bin/sh
exec tldrx-definitely-not-a-binary-xyz
`;

const GREEN = `#!/bin/sh
echo "2860 tests, 0 failing"
exit 0
`;

interface Ran {
  readonly dir: string;
  readonly results: readonly DodResult[];
  readonly events: readonly { type: string; payload: Record<string, unknown> }[];
}

/** One real script through the real `runStoryDod`, in a private dir per invocation. */
async function runScript(body: string, opts: { allow?: boolean } = {}): Promise<Ran> {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-recheck-"));
  const script = join(dir, "gate.sh");
  writeFileSync(script, body, "utf8");
  chmodSync(script, 0o755);
  const command = "./gate.sh";
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const results = await runStoryDod({
    storyId: "S1",
    repo: "app",
    worktree: dir,
    repoDir: dir,
    installDeclared: false,
    commands: [command],
    // A command the workspace does NOT declare is REFUSED — nothing runs, and
    // there is nothing to re-run.
    workspaceCommands: new Set(opts.allow === false ? [] : [command]),
    timeoutMs: 30_000,
    phaseId: "04-build",
    runDir: dir,
    emit: (type, payload) => { events.push({ type, payload }); },
    baseResult: async () => null,
  });
  return { dir, results, events };
}

describe("#163 · a red DoD command is re-run once, and both exit codes are recorded", () => {
  test("(a) a stable red records BOTH exit codes and says it reproduced", async () => {
    const ran = await runScript(STABLE_RED);
    const row = ran.results[0] as DodResult;

    expect(row.exitCode).toBe(2);
    expect(row.recheck?.exitCode).toBe(2);
    expect(dodRecheckReproduced(row)).toBe(true);
    const reason = dodFailureReason(row, "app");
    expect(reason).toContain("exited 2");
    expect(reason).toContain(RECHECK_REPRODUCED_MARK);
    // And it still blocks: nothing about terminality changed.
    expect(dodGreen({ dod: ran.results })).toBe(false);
    expect(dodFailure(ran.results)).toBeDefined();
  });

  test("(b) a red that does NOT reproduce is recorded as such — and still blocks", async () => {
    const ran = await runScript(FLAKY_RED);
    const row = ran.results[0] as DodResult;

    // The first reading is the one the framework acted on; the second is the one
    // the operator had to take by hand on the .NET workspace.
    expect(row.exitCode).toBe(2);
    expect(row.recheck?.exitCode).toBe(0);
    expect(dodRecheckReproduced(row)).toBe(false);
    const reason = dodFailureReason(row, "app");
    expect(reason).toContain(RECHECK_NOT_REPRODUCED_MARK);
    // NOT silently passed — a green second run is evidence, not a verdict.
    expect(dodGreen({ dod: ran.results })).toBe(false);
    expect(dodFailure(ran.results)).toBeDefined();
    // The re-run really was a second SPAWN of the same command, not a re-reading
    // of the first: the script's own marker file is the witness.
    expect(readFileSync(join(ran.dir, ".taken"), "utf8")).toBe("");
  });

  test("(c) the check.failed event carries both readings, and the ledger reads them back", async () => {
    const ran = await runScript(FLAKY_RED);
    const failed = ran.events.find((e) => e.type === "check.failed");
    expect(failed?.payload.exit_code).toBe(2);
    expect(failed?.payload.recheck_exit_code).toBe(0);

    // Round trip: the event ledger is what a resumed invocation rebuilds the
    // rows from, so a reading that does not survive it is not recorded at all.
    const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-recheck-ledger-"));
    const line = JSON.stringify({ type: "check.failed", payload: failed?.payload });
    writeFileSync(join(dir, "events.jsonl"), `${line}\n`, "utf8");
    const ledger = readReviewLedger(dir, "S1");
    expect(ledger.dod[0]?.recheck?.exitCode).toBe(0);
    expect(dodRecheckReproduced(ledger.dod[0] as DodResult)).toBe(false);
  });

  test("(d) a green command is never re-run — there is nothing to reproduce", async () => {
    const ran = await runScript(GREEN);
    const row = ran.results[0] as DodResult;
    expect(row.exitCode).toBe(0);
    expect(row.recheck).toBeUndefined();
  });

  test("(e) a REFUSED command has no second reading, because it had no first", async () => {
    const ran = await runScript(STABLE_RED, { allow: false });
    const row = ran.results[0] as DodResult;
    expect(row.status).toBe("refused");
    expect(row.exitCode).toBeUndefined();
    expect(row.recheck).toBeUndefined();
    expect(dodRecheckReproduced(row)).toBeNull();
  });

  test("(f) an absent binary records WHY no second reading was taken, never a second number", async () => {
    const ran = await runScript(ABSENT_BINARY);
    const row = ran.results[0] as DodResult;

    expect(row.exitCode).toBe(127);
    expect(row.recheck?.exitCode).toBeUndefined();
    expect(row.recheck?.absentBecause ?? "").not.toBe("");
    expect(dodRecheckReproduced(row)).toBeNull();
    const reason = dodFailureReason(row, "app");
    expect(reason).toContain(RECHECK_ABSENT_MARK);
  });

  test("(g) a pre-#163 record — no second reading anywhere — still reads, and says nothing it did not measure", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-recheck-old-"));
    const line = JSON.stringify({
      type: "check.failed",
      payload: { check: "dod", story: "S1", command: "npm run test", exit_code: 1, detail: "FAIL test_x" },
    });
    writeFileSync(join(dir, "events.jsonl"), `${line}\n`, "utf8");

    const ledger = readReviewLedger(dir, "S1");
    const row = ledger.dod[0] as DodResult;
    expect(row.recheck).toBeUndefined();
    expect(dodRecheckReproduced(row)).toBeNull();
    const reason = dodFailureReason(row, "app");
    expect(reason).not.toContain(RECHECK_REPRODUCED_MARK);
    expect(reason).not.toContain(RECHECK_NOT_REPRODUCED_MARK);
    expect(reason).not.toContain(RECHECK_ABSENT_MARK);
  });
});
