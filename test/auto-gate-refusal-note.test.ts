/**
 * gh #230 — an `auto` gate that REFUSES writes the verdict down.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { workspaceLockPath, workspaceRootOfRunDir } from "../src/core/lock/workspaceLock.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import {
  AUTO_GATE_REFUSED_PREFIX, evaluateAutoGate, heldByNote, reevaluateAutoGate, refusalNote,
} from "../src/core/run/autoGate.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { waitingFor } from "../src/core/run/waiting.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import {
  cannedHandoff, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

// The concurrency case spawns a REAL second process to hold the lock and sign the
// gate, and process cost is a property of the machine rather than of the code
// (#43). The budget scales with measured load; the assertions are untouched.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const ws of open) ws.dispose();
  open = [];
});

const STAGE: StageOptions = {
  id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve",
  outputs: [
    { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
  ],
  checks: "[claim-sources]",
};

function workspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: [STAGE], budgetUsd: 10, gates: { alpha: "auto" } });
  open.push(made);
  process.env.PATH = made.binDir;
  return made;
}

/** Put the run where the field report found it: the gate pending, the note empty. */
function parkAtGate(ws: FacilitatorWorkspace): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) =>
        stage.id === "alpha"
          ? { ...stage, status: "awaiting_gate", gate: { ...stage.gate, type: "approve", status: "pending" } }
          : stage
      ),
    })),
  } as never));
  store.save();
}

describe("#230 · a refused auto gate says which condition held it", () => {
  test("the re-measure records the seven conditions on the pending gate, and run status names the failing one", async () => {
    const ws = workspace();
    writeFileSync(
      join(ws.runDir, "01-what", "handoff.md"),
      cannedHandoff().replace(".tldrx/workspace.yml:1]", "no-such-file.md:1]"),
      "utf8",
    );
    parkAtGate(ws);
    const before = RunStore.open(ws.runDir);
    const verdict = await reevaluateAutoGate({
      root: ws.root, runDir: ws.runDir, run: before.run, budget: before.budget, stageId: "alpha",
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.why).toContain("claim-sources");

    const after = RunStore.open(ws.runDir);
    const gate = after.run.phases[0]?.stages[0]?.gate;
    expect(gate?.status).toBe("pending");
    // The note the docstring promises: all seven, on the gate that REFUSED.
    expect(gate?.note).toContain("claim-sources");
    expect(gate?.note).toContain("questions=");
    expect(gate?.note).toContain("budget=");

    const waiting = waitingFor(after.run, ws.runDir);
    expect(waiting.kind).toBe("gate");
    expect(waiting.message).toContain("claim-sources");
  });

  test("`run status` names the held condition on the gate row and on the waiting line", async () => {
    const ws = workspace();
    writeFileSync(
      join(ws.runDir, "01-what", "handoff.md"),
      cannedHandoff().replace(".tldrx/workspace.yml:1]", "no-such-file.md:1]"),
      "utf8",
    );
    parkAtGate(ws);
    const before = RunStore.open(ws.runDir);
    await reevaluateAutoGate({
      root: ws.root, runDir: ws.runDir, run: before.run, budget: before.budget, stageId: "alpha",
    });
    const after = RunStore.open(ws.runDir);
    const screen = renderStatus(buildStatus(after.run, after.budget, ws.runDir));
    expect(screen).toContain("approve: pending \u2014 held by checks, claim-sources");
    expect(screen).toContain("waiting gate on 01-what/alpha \u2014 held by checks, claim-sources");
    // A gate nobody closed is not a signed one, however many words it carries.
    expect(screen).not.toContain("signed gate carries a note");
    // The values are all there for the reader who asks for them.
    expect(renderStatus(buildStatus(after.run, after.budget, ws.runDir), true))
      .toContain("budget=");
  });

  test("a gate a person already signed keeps THEIR words — the re-measure writes only a pending one", async () => {
    const ws = workspace();
    writeFileSync(
      join(ws.runDir, "01-what", "handoff.md"),
      cannedHandoff().replace(".tldrx/workspace.yml:1]", "no-such-file.md:1]"),
      "utf8",
    );
    parkAtGate(ws);
    const parked = RunStore.open(ws.runDir);
    parked.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) =>
          stage.id === "alpha"
            ? {
              ...stage,
              gate: { ...stage.gate, status: "rejected", by: "alan", at: "2026-09-10T22:00:00Z", note: "not yet" },
            }
            : stage
        ),
      })),
    } as never));
    parked.save();
    const before = RunStore.open(ws.runDir);
    await reevaluateAutoGate({
      root: ws.root, runDir: ws.runDir, run: before.run, budget: before.budget, stageId: "alpha",
    });
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate.note).toBe("not yet");
  });
});

describe("#230 · the refusal note's grammar has one writer and one reader", () => {
  test("a refused verdict round-trips its held-by ids and keeps all seven values", async () => {
    const ws = workspace();
    writeFileSync(
      join(ws.runDir, "01-what", "handoff.md"),
      cannedHandoff().replace(".tldrx/workspace.yml:1]", "no-such-file.md:1]"),
      "utf8",
    );
    const store = RunStore.open(ws.runDir);
    const verdict = await evaluateAutoGate({
      root: ws.root,
      runDir: ws.runDir,
      phaseId: "01-what",
      stage: store.run.phases[0]?.stages[0],
      planned: loadWorkflowPreset(ws.root, store.run.scope).stages[0],
      budget: store.budget,
      checks: [],
    } as never);
    const note = refusalNote(verdict);
    expect(note.startsWith(AUTO_GATE_REFUSED_PREFIX)).toBe(true);
    expect(heldByNote(note)).toEqual(["claim-sources"]);
    for (const condition of verdict.conditions) expect(note).toContain(`${condition.id}=`);
  });

  test("every other note reads as no refusal at all — never as seven conditions that held nothing", () => {
    expect(heldByNote("")).toEqual([]);
    expect(heldByNote("auto-gate: checks=none declared; questions=0 open")).toEqual([]);
    expect(heldByNote("looks fine to me")).toEqual([]);
  });
});

// --- the gate a person signs WHILE the poll is measuring ----------------------

/**
 * The race the `--wait-gates` poll exists inside, with two REAL processes.
 *
 * The child takes the workspace lock, holds it, and only then writes the person's
 * approval — so the two provably overlap, the same determinism `facts.yml`'s
 * two-writer test buys (`test/resumability.test.ts`). A check-then-act that reads
 * `run.yml` OUTSIDE the lock reads `pending` while the child is still holding,
 * then blocks in `save()`, then writes its snapshot over the signature the child
 * landed in the meantime: `approved` becomes `pending`, `by`/`at` become null and
 * the person's words are gone. A poll that runs every two seconds against a human
 * who is deciding is not a theoretical interleaving — it is the use case.
 */
describe("#230 · a person's signature survives a refusal landing at the same instant", () => {
  test("the approval a concurrent process wrote while the poll was measuring is not overwritten", async () => {
    const ws = workspace();
    writeFileSync(
      join(ws.runDir, "01-what", "handoff.md"),
      cannedHandoff().replace(".tldrx/workspace.yml:1]", "no-such-file.md:1]"),
      "utf8",
    );
    parkAtGate(ws);

    // The person's `approve`, in another process, holding the lock across it.
    // It writes the same bytes `gates.ts` would; the point under test is the
    // WRITE ORDER, not the door the approval came through.
    const script = join(ws.root, "sign.ts");
    writeFileSync(script, `
import { RunStore } from ${JSON.stringify(join(FRAMEWORK_ROOT, "src/core/run/RunStore.ts"))};
import { withWorkspaceLock, workspaceRootOfRunDir } from ${JSON.stringify(join(FRAMEWORK_ROOT, "src/core/lock/workspaceLock.ts"))};
const [runDir, holdMs] = process.argv.slice(2) as [string, string];
withWorkspaceLock(workspaceRootOfRunDir(runDir), () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  const store = RunStore.open(runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) =>
        stage.id === "alpha"
          ? {
            ...stage,
            status: "done",
            gate: {
              ...stage.gate,
              status: "approved",
              by: "alan",
              at: "2026-09-10T23:00:00Z",
              note: "I read the handoff myself",
            },
          }
          : stage
      ),
    })),
  }));
  store.save();
});
`, "utf8");

    const child = Bun.spawn(["bun", script, ws.runDir, "1200"], { stdout: "pipe", stderr: "pipe" });
    // Wait until the child provably HOLDS the lock, so the poll below runs
    // inside the window rather than before or after it.
    const lock = workspaceLockPath(workspaceRootOfRunDir(ws.runDir));
    for (let i = 0; i < 200 && !existsSync(lock); i++) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(lock)).toBe(true);

    const before = RunStore.open(ws.runDir);
    await reevaluateAutoGate({
      root: ws.root, runDir: ws.runDir, run: before.run, budget: before.budget, stageId: "alpha",
    });

    const err = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(err).toBe("");

    const gate = RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate;
    expect(gate?.status).toBe("approved");
    expect(gate?.by).toBe("alan");
    expect(gate?.at).toBe("2026-09-10T23:00:00Z");
    expect(gate?.note).toBe("I read the handoff myself");
    // And the stage the person closed stays closed.
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("done");
  }, 30_000);
});
