/**
 * gh #305 — run.yml LOST UPDATE.
 *
 * `tldrx run auto` holds ONE `RunStore` in memory for the whole of a stage
 * (`runNext.ts`: `advance(store, …)` covers the Build fan-out too), and every
 * `save()` on that store used to write `run.yml` whole from that in-memory copy.
 * An external command that wrote `run.yml` in between — `budget raise --stage`
 * is the one measured in the field — printed its confirmation, exited 0, and was
 * silently reverted by the loop's next save. `budget.yml`'s ceilings were already
 * protected against exactly this (`ceilingsToWrite`); `run.yml` was not.
 *
 * The rule now (spec §2.2, "Ownership"): a save carries back to disk ONLY the
 * fields this store changed, over a fresh read of the file. A store never writes
 * a value it merely loaded. So the loop's store, which never touches a stage's
 * `budget_usd`, cannot revert a raise — and the raise's store, which never touches
 * task rows, cannot revert the loop's ledger either.
 *
 * All three writers named on the issue are probed through their REAL code paths:
 * the `budget` command's own `run()`, `gates.ts`'s `reject()`, `rescue.ts`'s
 * `cancelRun()`. No process is spawned.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunStore, RunStoreError } from "../src/core/run/RunStore.ts";
import { backupPathFor } from "../src/core/fs/writeAtomic.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { reject } from "../src/core/run/gates.ts";
import { cancelRun } from "../src/core/run/rescue.ts";
import { budgetCommand } from "../src/cli/commands/budget.ts";
import { parseYaml } from "../src/core/yaml.ts";
import type { RunFile, RunStage } from "../src/core/run/RunFile.ts";
import { makeRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

const AT = "2026-09-14T06:35:00Z";

function openRun(): { root: string; runId: string; runDir: string; phaseId: string; stageId: string; dispose: () => void } {
  const ws = makeRunWorkspace();
  const runId = createRun({
    root: ws.root, slug: "lost-update", scope: "feature", actor: "alan",
    now: new Date("2026-09-14T06:00:00Z"),
  }).runId;
  const store = RunStore.find(ws.root, runId)!;
  const phase = store.run.phases[0]!;
  const stage = phase.stages[0]!;
  return { root: ws.root, runId, runDir: store.runDir, phaseId: phase.id, stageId: stage.id, dispose: ws.dispose };
}

function stageOf(run: RunFile, phaseId: string, stageId: string): RunStage {
  return run.phases.find((p) => p.id === phaseId)!.stages.find((s) => s.id === stageId)!;
}

function withStage(run: RunFile, phaseId: string, stageId: string, fn: (stage: RunStage) => RunStage): RunFile {
  return {
    ...run,
    phases: run.phases.map((phase) => phase.id !== phaseId ? phase : {
      ...phase,
      stages: phase.stages.map((stage) => stage.id !== stageId ? stage : fn(stage)),
    }),
  };
}

/** What the loop does mid-stage: the cursor stage goes `running`, a task row lands. */
function loopProgress(run: RunFile, phaseId: string, stageId: string): RunFile {
  return withStage(run, phaseId, stageId, (stage) => ({
    ...stage,
    status: "running",
    started_at: AT,
    tasks: [...stage.tasks, {
      id: "t1", status: "running", expert: stage.expert, model: stage.model,
      cost_usd: 0.42, error: null, session_id: "s-1", started_at: AT, ended_at: null, outputs: [],
    }],
  }));
}

function onDiskStageBudget(runDir: string, phaseId: string, stageId: string): number {
  const doc = parseYaml(readFileSync(join(runDir, "run.yml"), "utf8")) as RunFile;
  return stageOf(doc, phaseId, stageId).budget_usd;
}

describe("run.yml survives an external write while a loop's RunStore is held (#305)", () => {
  test("`budget raise --stage` through the real command survives the held store's next save", async () => {
    const ws = openRun();
    try {
      // The loop opens the run and holds it for the whole stage.
      const loop = RunStore.find(ws.root, ws.runId)!;
      const before = stageOf(loop.run, ws.phaseId, ws.stageId).budget_usd;

      // Meanwhile the operator raises the stage cap — the real command, the real writer.
      const code = await budgetCommand.run([
        "raise", ws.phaseId, "50", "--stage", ws.stageId, "--run", ws.runId, "--root", ws.root,
      ]);
      expect(code).toBe(0);
      expect(onDiskStageBudget(ws.runDir, ws.phaseId, ws.stageId)).toBe(before + 50);

      // The loop records its own progress and saves. The raise must still be on disk.
      loop.mutate((run) => loopProgress(run, ws.phaseId, ws.stageId));
      loop.save();
      expect(onDiskStageBudget(ws.runDir, ws.phaseId, ws.stageId)).toBe(before + 50);
      // …and the loop's own work landed too: this is not the raise winning, it is both.
      const after = RunStore.find(ws.root, ws.runId)!.run;
      expect(stageOf(after, ws.phaseId, ws.stageId).status).toBe("running");
      expect(stageOf(after, ws.phaseId, ws.stageId).tasks).toHaveLength(1);
      // The held store now sees the raise as well — same contract `ceilingsToWrite` gives budget.yml.
      expect(stageOf(loop.run, ws.phaseId, ws.stageId).budget_usd).toBe(before + 50);
    } finally {
      ws.dispose();
    }
  });

  test("a `reject --and-continue` written beside a held store survives that store's save", () => {
    const ws = openRun();
    try {
      // The stage parked on its gate (what the loop's last save of the stage writes).
      const parker = RunStore.find(ws.root, ws.runId)!;
      parker.mutate((run) => withStage(run, ws.phaseId, ws.stageId, (stage) => ({
        ...stage, status: "awaiting_gate", started_at: AT, ended_at: AT,
      })));
      parker.save();

      // Something else holds the run as it was parked.
      const held = RunStore.find(ws.root, ws.runId)!;

      // The operator rejects it, through the real code path.
      const rejecter = RunStore.find(ws.root, ws.runId)!;
      reject(rejecter, { root: ws.root, actor: "alan", at: AT, note: "redo the API half", andContinue: true });
      const rejected = stageOf(RunStore.find(ws.root, ws.runId)!.run, ws.phaseId, ws.stageId);
      expect(rejected.gate.status).toBe("rejected");
      expect(rejected.gate.and_continue).toBe(true);

      // The held store saves something unrelated to the gate. The decision must survive.
      held.mutate((run) => ({ ...run, title: `${run.title} (renamed)` }));
      held.save();
      const after = stageOf(RunStore.find(ws.root, ws.runId)!.run, ws.phaseId, ws.stageId);
      expect(after.gate.status).toBe("rejected");
      expect(after.gate.note).toBe("redo the API half");
      expect(after.gate.and_continue).toBe(true);
      expect(after.status).toBe("ready");
      expect(RunStore.find(ws.root, ws.runId)!.run.title).toContain("(renamed)");
    } finally {
      ws.dispose();
    }
  });

  test("a `run cancel` written beside a held store survives that store's save", () => {
    const ws = openRun();
    try {
      const held = RunStore.find(ws.root, ws.runId)!;

      // No `.lock` on disk: the holder is a store, not a `next` — `cancelRun`'s own
      // live-pid refusal (pinned in resumability.test.ts) has nothing to refuse.
      const outcome = cancelRun({ root: ws.root, runId: ws.runId, note: "stop", force: false, actor: "alan", at: AT });
      expect(outcome.code).toBe(0);
      expect(RunStore.find(ws.root, ws.runId)!.run.status).toBe("cancelled");

      held.mutate((run) => loopProgress(run, ws.phaseId, ws.stageId));
      held.save();
      const after = RunStore.find(ws.root, ws.runId)!.run;
      expect(after.cancelled).toMatchObject({ by: "alan", note: "stop" });
      expect(after.status).toBe("cancelled");
    } finally {
      ws.dispose();
    }
  });

  test("a store that DID change a stage's budget_usd still writes it — ownership is by change, both ways", () => {
    const ws = openRun();
    try {
      const raiser = RunStore.find(ws.root, ws.runId)!;
      const before = stageOf(raiser.run, ws.phaseId, ws.stageId).budget_usd;
      raiser.mutate((run) => withStage(run, ws.phaseId, ws.stageId, (stage) => ({ ...stage, budget_usd: before + 7 })));
      raiser.save();
      expect(onDiskStageBudget(ws.runDir, ws.phaseId, ws.stageId)).toBe(before + 7);
    } finally {
      ws.dispose();
    }
  });

  /** Swap stderr for a buffer; the fallback line under test writes there and nowhere else. */
  function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
    const original = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: fn(), stderr };
    } finally {
      process.stderr.write = original;
    }
  }

  const UNUSABLE: readonly { readonly why: string; readonly bytes: string }[] = [
    { why: "does not parse", bytes: "version: 1\nrun: [broken" },
    { why: "parses but does not validate", bytes: "version: 1\nrun: not-a-run-id\n" },
  ];
  for (const { why, bytes } of UNUSABLE) {
    test(`run.yml on disk ${why}: the in-memory run is written whole, the broken bytes stay beside it as .bak, and stderr says so — never silently`, () => {
      const ws = openRun();
      try {
        const held = RunStore.find(ws.root, ws.runId)!;
        const path = join(ws.runDir, "run.yml");
        writeFileSync(path, bytes, "utf8");
        held.mutate((run) => loopProgress(run, ws.phaseId, ws.stageId));
        const { stderr } = captureStderr(() => held.save());
        const after = RunStore.find(ws.root, ws.runId)!.run;
        expect(stageOf(after, ws.phaseId, ws.stageId).status).toBe("running");
        // The same convention the repair path uses: the replaced version is one step back.
        expect(existsSync(backupPathFor(path))).toBe(true);
        expect(readFileSync(backupPathFor(path), "utf8")).toBe(bytes);
        expect(stderr).toContain(path);
        expect(stderr).toContain("written whole");
        expect(stderr).toContain(backupPathFor(path));
      } finally {
        ws.dispose();
      }
    });
  }

  test("run.yml on disk records ANOTHER run: the save refuses, names both ids and the path, and writes nothing", () => {
    const ws = openRun();
    try {
      const held = RunStore.find(ws.root, ws.runId)!;
      const path = join(ws.runDir, "run.yml");
      const foreign = readFileSync(path, "utf8").replace(`run: "${ws.runId}"`, 'run: "260101-someone-else"');
      expect(foreign).not.toBe(readFileSync(path, "utf8"));
      writeFileSync(path, foreign, "utf8");
      const budgetBefore = readFileSync(join(ws.runDir, "budget.yml"), "utf8");
      held.mutate((run) => loopProgress(run, ws.phaseId, ws.stageId));
      let thrown: unknown = null;
      try {
        held.save();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RunStoreError);
      const message = (thrown as Error).message;
      expect(message).toContain("260101-someone-else");
      expect(message).toContain(ws.runId);
      expect(message).toContain(path);
      expect(readFileSync(path, "utf8")).toBe(foreign);
      expect(readFileSync(join(ws.runDir, "budget.yml"), "utf8")).toBe(budgetBefore);
      expect(existsSync(backupPathFor(path))).toBe(false);
    } finally {
      ws.dispose();
    }
  });

  test("the reviewer's collision: a forced cancel under a live .lock, then the held store marks that stage running — cancelled wins the file, the task row still lands, and the save says so", () => {
    const ws = openRun();
    try {
      const held = RunStore.find(ws.root, ws.runId)!;
      // A REAL live lock: the loop's `next` holds the run. Without --force the
      // cancel is refused (pinned in resumability.test.ts); --force is the
      // operator overriding that, and it is the one shared field two writers
      // then both change.
      writeFileSync(join(ws.runDir, ".lock"), JSON.stringify({ pid: process.pid, at: AT }), "utf8");
      expect(cancelRun({ root: ws.root, runId: ws.runId, note: "stop", force: false, actor: "alan", at: AT }).code).toBe(2);
      expect(cancelRun({ root: ws.root, runId: ws.runId, note: "stop", force: true, actor: "alan", at: AT }).code).toBe(0);
      expect(stageOf(RunStore.find(ws.root, ws.runId)!.run, ws.phaseId, ws.stageId).status).toBe("cancelled");

      // The loop's store, unaware, marks the SAME stage running and records a turn.
      held.mutate((run) => loopProgress(run, ws.phaseId, ws.stageId));
      const { result, stderr } = captureStderr(() => held.save());

      // Cancelled is terminal and wins: the stage stays `cancelled`, the run stays
      // `cancelled`, and the turn that happened is still in the ledger.
      const after = RunStore.find(ws.root, ws.runId)!.run;
      expect(after.status).toBe("cancelled");
      expect(after.cancelled).toMatchObject({ by: "alan", note: "stop" });
      const stage = stageOf(after, ws.phaseId, ws.stageId);
      expect(stage.status).toBe("cancelled");
      expect(stage.tasks).toHaveLength(1);
      expect(stage.tasks[0]!.id).toBe("t1");
      // And the process is told, both ways: the save's own answer, and stderr.
      expect(result.cancelledUnder).toBe(true);
      expect(held.cancelledUnder).toBe(true);
      expect(held.run.status).toBe("cancelled");
      expect(stderr).toContain(ws.runId);
      expect(stderr).toContain("cancelled");

      // Sticky for the life of the store: a later status change from it is not carried either.
      held.mutate((run) => withStage(run, ws.phaseId, ws.stageId, (s) => ({ ...s, status: "done", ended_at: AT })));
      held.save();
      expect(stageOf(RunStore.find(ws.root, ws.runId)!.run, ws.phaseId, ws.stageId).status).toBe("cancelled");
    } finally {
      ws.dispose();
    }
  });
});
