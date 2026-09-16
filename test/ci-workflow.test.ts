/**
 * #373 — every #237 data point so far ("the lock cannot wedge the repo > an interrupted
 * merge hands the lock back on its way out", SIGTERM 143 expected, 0 observed after ~92s)
 * has hit the same second wall on top of the first: `gh issue view 237 --comments` records
 * "No merge.log is available from the CI sandbox" / "merge.log for this run is not retained
 * beyond the runner" on every red. Mechanism (measured): `test/merge-wave.test.ts:104`
 * plants each sandbox via `mkdtempSync(join(tmpdir(), "tldrx-mergewave-"))`, and
 * `.github/workflows/ci.yml` never pointed that at a path CI could name, nor uploaded it.
 *
 * This is an INSTRUMENT test for an instrument change: it does not touch
 * `scripts/merge-wave.sh`, `scripts/merge-guard.sh`, or `test/merge-wave.test.ts`, and it
 * asserts nothing about #237's mechanism — only that the next red run leaves a `merge.log`
 * an agent can actually read, by (a) giving the merge-wave sandboxes a nameable home under
 * `runner.temp`, and (b) uploading that directory as a build artifact when the job fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

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

  test("an actions/upload-artifact step runs only on failure() and uploads that same directory", () => {
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
    expect(withBlock?.path).toBe(testEnv?.TMPDIR);
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
