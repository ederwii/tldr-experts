/**
 * #373 — every #237 data point so far ("the lock cannot wedge the repo > an interrupted
 * merge hands the lock back on its way out", SIGTERM 143 expected, 0 observed after ~92s)
 * has hit the same second wall on top of the first: `gh issue view 237 --comments` records
 * "No merge.log is available from the CI sandbox" / "merge.log for this run is not retained
 * beyond the runner" on every red. Mechanism (measured): `test/merge-wave.test.ts` plants
 * each sandbox via `mkdtempSync(join(tmpdir(), SANDBOX_PREFIX))`, and
 * `.github/workflows/ci.yml` never pointed that at a path CI could name, nor uploaded it.
 *
 * Review found a second, blocking wall in the first cut of this fix (2026-09-16): that
 * file's `afterEach` `rmSync`s every sandbox unconditionally, pass or fail, INSIDE the bun
 * process — before ci.yml's upload step ever runs. Uploading on failure without also
 * gating that cleanup would upload an empty directory on the exact run it exists for. The
 * fix is `MERGE_WAVE_KEEP_SANDBOX`: ci.yml sets it, `keepSandbox`/`cleanupSandbox`
 * (`test/fixtures/mergeWaveSandbox.ts`) is the one place that reads it and decides.
 *
 * This is an INSTRUMENT test for an instrument change: it does not touch
 * `scripts/merge-wave.sh` or `scripts/merge-guard.sh`, and it asserts nothing about
 * #237's mechanism — only that the next red run leaves a `merge.log` an agent can
 * actually read, by (a) giving the merge-wave sandboxes a nameable home under
 * `runner.temp`, (b) keeping them past the process on that one run, and (c) uploading
 * exactly those directories, scoped by prefix, as a build artifact when the job fails.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { cleanupSandbox, keepSandbox, MERGE_WAVE_KEEP_SANDBOX_ENV, SANDBOX_PREFIX } from "./fixtures/mergeWaveSandbox.ts";

type Step = Record<string, unknown>;

function loadCiWorkflow(): { jobs: { test: { steps: Step[] } } } {
  const raw = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
  return parse(raw);
}

describe("ci.yml uploads the merge-wave sandbox on failure (#373, see #237)", () => {
  test("the step running `bun test` gives the merge-wave sandbox a nameable TMPDIR under runner.temp", () => {
    const workflow = loadCiWorkflow();
    const steps = workflow.jobs.test.steps;
    const testStep = steps.find((s) => s.run === "bun test");
    expect(testStep).toBeDefined();

    const env = testStep?.env as Record<string, string> | undefined;
    expect(env?.TMPDIR).toBeDefined();
    expect(String(env?.TMPDIR)).toContain("runner.temp");
  });

  // Review, 2026-09-16: an unconditional `afterEach` inside the bun process deletes every
  // sandbox before this upload step gets a turn — an instrument that cannot observe the
  // thing. Without this env var set on the same step, the artifact would be empty on the
  // one run it is for.
  test("the step running `bun test` sets MERGE_WAVE_KEEP_SANDBOX so its afterEach does not delete the evidence first", () => {
    const workflow = loadCiWorkflow();
    const steps = workflow.jobs.test.steps;
    const testStep = steps.find((s) => s.run === "bun test");
    expect(testStep).toBeDefined();

    const env = testStep?.env as Record<string, string> | undefined;
    expect(env?.[MERGE_WAVE_KEEP_SANDBOX_ENV]).toBeDefined();
    // The literal value has to be one `keepSandbox` actually reads as "keep" — asserted
    // against the real function, not a copy of its logic.
    expect(keepSandbox({ [MERGE_WAVE_KEEP_SANDBOX_ENV]: String(env?.[MERGE_WAVE_KEEP_SANDBOX_ENV]) })).toBe(true);
  });

  test("an actions/upload-artifact step runs only on failure() and is scoped to the sandbox prefix", () => {
    const workflow = loadCiWorkflow();
    const steps = workflow.jobs.test.steps;
    const uploadStep = steps.find(
      (s) => typeof s.uses === "string" && (s.uses as string).startsWith("actions/upload-artifact@"),
    );
    expect(uploadStep).toBeDefined();
    expect(uploadStep?.if).toBe("failure()");

    const testStep = steps.find((s) => s.run === "bun test");
    const testEnv = testStep?.env as Record<string, string> | undefined;
    const withBlock = uploadStep?.with as Record<string, unknown> | undefined;
    const path = String(withBlock?.path ?? "");
    // Scoped, not the whole shared TMPDIR: ~85 other test files also mkdtemp-and-self-clean
    // under the same directory, so an unscoped upload would mostly hold their (usually
    // absent, since they DID clean up) leftovers rather than this file's sandbox.
    expect(path.startsWith(String(testEnv?.TMPDIR))).toBe(true);
    expect(path).toContain(SANDBOX_PREFIX);
    expect(path).not.toBe(testEnv?.TMPDIR);
    // Retained long enough for someone to notice a #237 red and go diagnose it, not just
    // survive to the end of the run.
    expect(Number(withBlock?.["retention-days"])).toBeGreaterThanOrEqual(14);
  });

  test("the upload step comes after the bun test step it is meant to rescue", () => {
    const workflow = loadCiWorkflow();
    const steps = workflow.jobs.test.steps;
    const testIdx = steps.findIndex((s) => s.run === "bun test");
    const uploadIdx = steps.findIndex(
      (s) => typeof s.uses === "string" && (s.uses as string).startsWith("actions/upload-artifact@"),
    );
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(uploadIdx).toBeGreaterThan(testIdx);
  });
});

describe("keepSandbox / cleanupSandbox — the afterEach guard itself (#373)", () => {
  test("keepSandbox: unset is false, empty is false, \"1\" is true", () => {
    expect(keepSandbox({})).toBe(false);
    expect(keepSandbox({ [MERGE_WAVE_KEEP_SANDBOX_ENV]: "" })).toBe(false);
    expect(keepSandbox({ [MERGE_WAVE_KEEP_SANDBOX_ENV]: "1" })).toBe(true);
  });

  test("cleanupSandbox deletes the directory when unset, and keeps it when MERGE_WAVE_KEEP_SANDBOX is set", () => {
    // A private per-invocation temp dir (§8) standing in for one of merge-wave.test.ts's
    // real sandboxes — no git needed, since cleanupSandbox only ever looks at the env var
    // and the path.
    const kept = mkdtempSync(join(tmpdir(), `${SANDBOX_PREFIX}unit-`));
    writeFileSync(join(kept, "merge.log"), "evidence\n");
    cleanupSandbox(kept, { [MERGE_WAVE_KEEP_SANDBOX_ENV]: "1" });
    expect(existsSync(kept)).toBe(true);

    // Cleaning up this test's own fixture: the real gate, called with the env unset.
    cleanupSandbox(kept, {});
    expect(existsSync(kept)).toBe(false);
  });
});
