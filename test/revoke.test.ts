/**
 * Wave M · M3 — an approval can be taken back.
 *
 * Measured 2026-08-29: a wholly fabricated handoff met all five auto-gate
 * conditions, `approve()` signed it `by: auto` and advanced the cursor in the same
 * transaction, and the operator's attempt to undo it got
 * `REJECT REFUSED: nothing to reject: 02-how/beta is 'ready'` — because `reject`
 * only ever looked at the cursor. A machine that can sign but cannot be overruled
 * is not a gate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { GateError, revoke } from "../src/core/run/gates.ts";
import { rejectCommand } from "../src/cli/commands/reject.ts";
import { runItems } from "../src/core/status/runItems.ts";
import { renderRunLine } from "../src/core/statusline/renderRunLine.ts";
import { runSnapshot } from "../src/core/statusline/runSnapshot.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  cannedHandoff, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR"] as const;
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
  checks: "[claim-sources]",
};
const BETA: StageOptions = {
  id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve",
  outputs: [{ path: "02-how/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] }],
  checks: "[claim-sources]",
};

const ALPHA_OUTPUTS = JSON.stringify({
  "01-what/intent.md": "# Intent\n\n## Intent\nShip it.\n\n## Scope\nIn: it. Out: the rest.\n",
  "01-what/handoff.md": cannedHandoff(),
});
const BOTH_OUTPUTS = JSON.stringify({
  "01-what/intent.md": "# Intent\n\n## Intent\nShip it.\n\n## Scope\nIn: it. Out: the rest.\n",
  "01-what/handoff.md": cannedHandoff(),
  "02-how/handoff.md": cannedHandoff(),
});

function workspace(stages: readonly StageOptions[], gates?: Record<string, string>): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10, gates });
  open.push(made);
  process.env.PATH = made.binDir;
  return made;
}

function armFake(ws: FacilitatorWorkspace, outputs: string): void {
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = outputs;
}

async function next(ws: FacilitatorWorkspace): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-29T09:00:00Z",
  });
}

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return new EventLog(join(ws.runDir, "events.jsonl")).read();
}

function ctx(note: string): { root: string; actor: string; at: string; note: string } {
  return { root: "", actor: "alan", at: "2026-08-29T10:00:00Z", note };
}

describe("M3 · revoking an auto-signed gate", () => {
  test("the audit's exact sequence: auto-approve, then take it back", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);

    // The gate closed itself and the cursor moved on — the state the audit met.
    let store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.gate).toMatchObject({ status: "approved", by: "auto" });
    expect(store.run.cursor).toMatchObject({ phase: "02-how", stage: "beta" });

    const outcome = revoke(store, { ...ctx("the handoff cites facts that do not exist"), root: ws.root }, "01-what/alpha");
    expect(outcome.signedBy).toBe("auto");

    store = RunStore.open(ws.runDir);
    const alpha = store.run.phases[0]?.stages[0];
    expect(alpha?.status).toBe("ready");
    expect(alpha?.gate.status).toBe("pending");
    expect(alpha?.gate.by).toBeNull();
    expect(alpha?.gate.note).toBe("the handoff cites facts that do not exist");
    expect(store.run.cursor).toMatchObject({ phase: "01-what", stage: "alpha" });
  });

  test("appends one gate.revoked carrying who signed the original", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    revoke(RunStore.open(ws.runDir), { ...ctx("wrong"), root: ws.root }, "01-what/alpha");

    const revoked = events(ws).filter((e) => e.type === "gate.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ stage: "alpha", actor: "alan", cost_usd: 0 });
    expect(revoked[0]?.payload).toMatchObject({ phase: "01-what", signed_by: "auto", note: "wrong" });
  });

  test("later stages that had run are marked stale, and their files stay on disk", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, BOTH_OUTPUTS);
    await next(ws);
    await next(ws);

    const handoff = join(ws.runDir, "02-how", "handoff.md");
    expect(readFileSync(handoff, "utf8")).toContain("## Findings");

    const outcome = revoke(RunStore.open(ws.runDir), { ...ctx("start over"), root: ws.root }, "01-what/alpha");
    expect(outcome.staled).toEqual(["02-how/beta"]);

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[1]?.stages[0]?.stale).toBe(true);
    // Nothing was deleted, and the cost stays on the record.
    expect(readFileSync(handoff, "utf8")).toContain("## Findings");
    expect(store.run.budget.spent_usd).toBeGreaterThanOrEqual(0);
    expect(store.run.phases[1]?.stages[0]?.tasks.length).toBeGreaterThan(0);
  });

  test("`stale: true` survives a round trip through run.yml", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, BOTH_OUTPUTS);
    await next(ws);
    await next(ws);
    revoke(RunStore.open(ws.runDir), { ...ctx("start over"), root: ws.root }, "01-what/alpha");
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toContain("stale: true");
    expect(RunStore.open(ws.runDir).run.phases[1]?.stages[0]?.stale).toBe(true);
  });

  test("re-running the revoked stage clears its own stale flag", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, BOTH_OUTPUTS);
    await next(ws);
    await next(ws);
    revoke(RunStore.open(ws.runDir), { ...ctx("start over"), root: ws.root }, "01-what/alpha");
    await next(ws);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.stale).toBeUndefined();
  });

  test("a human-signed gate can be revoked too — the rule is about the gate, not the signer", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((p) => p.id !== "01-what" ? p : {
        ...p,
        stages: p.stages.map((s) => ({ ...s, gate: { ...s.gate, by: "alan" } })),
      }),
    }));
    store.save();
    const outcome = revoke(RunStore.open(ws.runDir), { ...ctx("I changed my mind"), root: ws.root }, "01-what/alpha");
    expect(outcome.signedBy).toBe("alan");
  });
});

describe("M3 · what revoke refuses", () => {
  test("a stage whose gate was never approved", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "human" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    expect(() => revoke(RunStore.open(ws.runDir), { ...ctx("nope"), root: ws.root }, "01-what/alpha"))
      .toThrow(/its gate is `pending`, not `approved`/);
  });

  test("a stage that is not in the run at all, naming the ones that are", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    expect(() => revoke(RunStore.open(ws.runDir), { ...ctx("nope"), root: ws.root }, "09-nope/ghost"))
      .toThrow(/01-what\/alpha, 02-how\/beta/);
  });

  test("an empty note", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    expect(() => revoke(RunStore.open(ws.runDir), { ...ctx("   "), root: ws.root }, "01-what/alpha"))
      .toThrow(GateError);
  });

  test("a bare stage id works when it is unambiguous", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    expect(revoke(RunStore.open(ws.runDir), { ...ctx("bare"), root: ws.root }, "alpha").stage).toBe("alpha");
  });
});

describe("M3 · tldrx reject --stage", () => {
  test("the CLI revokes and says what went stale", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, BOTH_OUTPUTS);
    await next(ws);
    await next(ws);

    const printed = capture();
    const code = await rejectCommand.run([
      "--root", ws.root, "--stage", "01-what/alpha", "--note", "the citations are invented",
    ]);
    const out = printed();
    expect(code).toBe(0);
    expect(out).toContain("REVOKED 01-what/alpha");
    expect(out).toContain("auto-approved by the facilitator");
    expect(out).toContain("02-how/beta");
    expect(out).toContain("nothing was deleted");
  });

  test("without --stage it is the old command, unchanged", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "human" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    const printed = capture();
    const code = await rejectCommand.run(["--root", ws.root, "--note", "try again"]);
    const out = printed();
    expect(code).toBe(0);
    expect(out).toContain("rejected 01-what/alpha");
    expect(out).toContain("back to `ready`");
  });

  test("a refused revocation exits 2 and writes nothing", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "human" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    const before = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    const code = await rejectCommand.run(["--root", ws.root, "--stage", "01-what/alpha", "--note", "x"]);
    expect(code).toBe(2);
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toBe(before);
  });
});

describe("M3 · a machine-closed gate is visible where people look", () => {
  // The report's WORDS changed with #124, not what it is asserting here. It used
  // to read "N gate(s) signed `by: auto`, not by a person", which was the whole
  // selector as well as the whole sentence — and it was false of the third way a
  // gate closes: an `agent` gate records the operator account the agent ran as, so
  // it carries a person's name and was never listed at all. The line now names the
  // executor's KIND per stage, so this test pins the same auto gate being named,
  // the same revoke command being offered, and — new — the kind it was closed by.
  test("tldrx status names the auto-signed gate and the command that undoes it", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    const details = runItems(ws.root).flatMap((item) => item.details).join("\n");
    expect(details).toContain("closed by a machine, not by a person");
    expect(details).toContain("01-what/alpha signed by auto");
    expect(details).toContain("tldrx reject");
    expect(details).toContain("--stage 01-what/alpha");
  });

  test("tldrx status names the stale stages after a revocation", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, BOTH_OUTPUTS);
    await next(ws);
    await next(ws);
    revoke(RunStore.open(ws.runDir), { ...ctx("redo"), root: ws.root }, "01-what/alpha");
    const details = runItems(ws.root).flatMap((item) => item.details).join("\n");
    expect(details).toContain("marked stale by a revoked approval");
    expect(details).toContain("02-how/beta");
  });

  test("the status line carries auto: and stale:", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "auto", beta: "auto" });
    armFake(ws, BOTH_OUTPUTS);
    await next(ws);
    const host = { modelName: "Sonnet", usedPercentage: 4, totalCostUsd: 0 };

    const withAuto = runSnapshot(ws.root);
    expect(withAuto?.autoGates).toBe(1);
    expect(renderRunLine(host, withAuto as never)).toContain("auto:1");

    await next(ws);
    revoke(RunStore.open(ws.runDir), { ...ctx("redo"), root: ws.root }, "01-what/alpha");
    const withStale = runSnapshot(ws.root);
    expect(withStale?.staleStages).toBe(1);
    expect(renderRunLine(host, withStale as never)).toContain("stale:1");
  });

  test("a run with no auto gate keeps the line byte-identical", async () => {
    const ws = workspace([ALPHA, BETA], { alpha: "human" });
    armFake(ws, ALPHA_OUTPUTS);
    await next(ws);
    const snapshot = runSnapshot(ws.root);
    expect(snapshot?.autoGates).toBe(0);
    const line = renderRunLine({ modelName: "Sonnet", usedPercentage: 4, totalCostUsd: 0 }, snapshot as never);
    expect(line).not.toContain("auto:");
    expect(line).not.toContain("stale:");
  });
});

function capture(): () => string {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
    return buffer;
  };
}

/** Keeps the unused-import checker honest about `writeFileSync` in this file. */
export const _unused = writeFileSync;
