/**
 * The dashboard and the CLI, told to agree.
 *
 * `test/fixtures/chain/workspace` holds seven runs that between them cover every
 * waiting kind — a fresh one nobody has touched, one parked at a gate, one
 * holding open questions, one that failed, one that finished, and two that were
 * proposed to follow a sibling — wired into two dependency chains. Both screens
 * read the same folder, so any disagreement is a bug in one of them.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildModel } from "../src/core/dashboard/index.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { whatIsWaiting } from "../src/core/run/runStatus.ts";
import { listRunDirs } from "../src/hooks/lib/workspace.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

export const CHAIN_FIXTURE = join(FRAMEWORK_ROOT, "test", "fixtures", "chain", "workspace");
const GENERATED_AT = "2026-09-03T12:00:00Z";
const NOW = new Date("2026-09-03T12:00:00Z");

const model = buildModel(CHAIN_FIXTURE, GENERATED_AT, { now: NOW });

/** `tldrx run status`'s own answer, run by run, straight off the same files. */
function cliWaiting(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const dir of listRunDirs(CHAIN_FIXTURE)) {
    const store = RunStore.open(dir);
    out.set(store.run.run, whatIsWaiting(store.run, store.runDir).kind);
  }
  return out;
}

describe("the dashboard never disagrees with `tldrx run status`", () => {
  test("the fixture covers every waiting kind, so parity means something", () => {
    expect([...new Set(model.runs.map((run) => run.waiting.kind))].sort())
      .toEqual(["answer", "done", "failed", "gate", "ready"]);
    expect(model.runs).toHaveLength(7);
  });

  test("`waiting.kind` matches the CLI for every run, including a fresh one", () => {
    const cli = cliWaiting();
    const dashboard = new Map(model.runs.map((run) => [run.id, run.waiting.kind]));
    expect(Object.fromEntries(dashboard)).toEqual(Object.fromEntries(cli));
  });

  test("`waiting.message` is the CLI's message, not a second wording", () => {
    for (const dir of listRunDirs(CHAIN_FIXTURE)) {
      const store = RunStore.open(dir);
      const run = model.runs.find((candidate) => candidate.id === store.run.run);
      expect(run?.waiting.message).toBe(whatIsWaiting(store.run, store.runDir).message);
    }
  });

  /**
   * The bug this wave exists for. A run created a minute ago has `gate.status:
   * pending` on every stage, because that is the value the field is born with.
   * The old model read the first of those as "the gate this run is waiting on"
   * and drew a red card; the CLI said `ready`.
   */
  test("a run nobody has started is ready, not waiting at a gate", () => {
    const fresh = model.runs.find((run) => run.id === "260903-alpha");
    expect(fresh?.waiting.kind).toBe("ready");
    expect(fresh?.waiting.message).toContain("next up: 01-what/what (pending)");
    expect(fresh?.pendingGate).toBeNull();
    expect(fresh?.pendingQuestion).toBeNull();
    // Every one of its gates still reads `pending` on disk — that is the point.
    expect(fresh?.path.every((stage) => stage.gate === "approve: pending")).toBe(true);
  });

  test("the run holding open questions names them; the one at a gate names the stage", () => {
    const asked = model.runs.find((run) => run.id === "260903-delta");
    expect(asked?.waiting.kind).toBe("answer");
    expect(asked?.waiting.questions).toEqual(["Q1", "Q2"]);
    expect(asked?.pendingQuestion).toBe("Q1 · How far back does the retention window reach?");
    expect(asked?.pendingGate).toBeNull();

    const gated = model.runs.find((run) => run.id === "260903-charlie");
    expect(gated?.waiting.kind).toBe("gate");
    expect(gated?.pendingGate).toBe("what");
    expect(gated?.pendingQuestion).toBeNull();
  });

  test("a failed run says so, with the reason the task recorded", () => {
    const failed = model.runs.find((run) => run.id === "260903-echo");
    expect(failed?.waiting.kind).toBe("failed");
    expect(failed?.waiting.message).toContain("checks: npm test exited 1");
  });
});
