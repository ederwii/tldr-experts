/**
 * Gate policy, auto gates, and the headless loop (spec §2.2 `gates_policy`,
 * §2.4 `gates:`, §5 auto-gate conditions, §3 `run auto`).
 *
 * Same rule as `facilitator.test.ts`: the algorithm is real, the run is real, the
 * files are real, and the only thing faked is the sub-agent — a `claude` script
 * first on PATH that writes canned outputs for $0.00. Nothing here can reach the
 * real binary.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { createRun, NewRunError } from "../src/core/run/newRun.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { evaluateAutoGate, AUTO_GATE_ACTOR } from "../src/core/run/autoGate.ts";
import {
  GatePolicyError, gatePolicyFor, parseGatesFlag, parseWorkflowGates, resolveGatesPolicy,
  type GatesPolicy,
} from "../src/core/run/gatePolicy.ts";
import { validateRunFile } from "../src/core/run/RunFile.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR"] as const;

let open: FacilitatorWorkspace[] = [];
let plain: TempRunWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const workspace of open) workspace.dispose();
  for (const workspace of plain) workspace.dispose();
  open = [];
  plain = [];
});

function workspace(
  stages: readonly StageOptions[],
  extra: Partial<Parameters<typeof makeFacilitatorWorkspace>[0]> = {},
): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10, ...extra });
  open.push(made);
  // The fake `claude` is the ONLY one on PATH from the moment the workspace
  // exists, in every test in this file — including the ones that assert nothing
  // spawns. A test that forgot to arm it would otherwise reach the real binary
  // and bill for it (see test/fixtures/noSpawnPath.ts for the incident).
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  return made;
}

function fakeClaude(ws: FacilitatorWorkspace, env: Readonly<Record<string, string>> = {}): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function next(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

function auto(ws: FacilitatorWorkspace, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({
    root: ws.root, yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

const HANDOFF_ONLY: readonly { readonly path: string; readonly sections?: readonly string[] }[] = [
  { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
];

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
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});
const BOTH_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
  "02-how/handoff.md": cannedHandoff(),
});

// --- G1: the policy is data -------------------------------------------------

describe("gate policy per shipped scope", () => {
  const expected: Readonly<Record<string, GatesPolicy>> = {
    feature: { what: "human", how: "auto", plan: "human", build: "auto", watch: "human" },
    bugfix: { what: "human", how: "auto", plan: "human", build: "auto", watch: "human" },
    integration: { what: "human", how: "auto", plan: "human", build: "auto", watch: "human" },
    refactor: { what: "human", how: "auto", plan: "human", build: "auto", watch: "human" },
    performance: { what: "human", how: "auto", build: "auto", watch: "human" },
    docs: { what: "auto", build: "human" },
    spike: { what: "auto", how: "human" },
    prototype: { what: "auto", how: "auto", build: "human" },
    upgrade: { what: "auto", plan: "auto", build: "auto", watch: "human" },
    hotfix: { what: "auto", build: "human", watch: "human" },
    "security-patch": { what: "auto", how: "auto", build: "human", watch: "human" },
    migration: { what: "auto", how: "auto", plan: "auto", build: "human", watch: "human" },
  };

  for (const [scope, gates] of Object.entries(expected)) {
    test(`${scope}: ${Object.entries(gates).map(([k, v]) => `${k}=${v}`).join(" ")}`, () => {
      const preset = loadWorkflowPreset(FRAMEWORK_ROOT, scope);
      expect(preset.gates).toEqual(gates);
      // Every stage the workflow runs has a policy: no stage falls through to the
      // default by accident in a file we ship.
      expect(Object.keys(preset.gates).sort()).toEqual(preset.stages.map((s) => s.id).sort());
    });
  }

  test("every shipped scope keeps at least one human gate", () => {
    for (const scope of Object.keys(expected)) {
      const preset = loadWorkflowPreset(FRAMEWORK_ROOT, scope);
      expect(Object.values(preset.gates)).toContain("human");
    }
  });

  test("a workflow with no `gates:` at all leaves every stage human", () => {
    const ws = workspace([{ ...ALPHA, gate: "approve" }]);
    const store = RunStore.open(ws.runDir);
    expect(store.run.gates_policy).toEqual({ alpha: "human" });
  });

  test("`collapse:` is reserved, not read as a stage id", () => {
    expect(parseWorkflowGates({ collapse: false, what: "auto" }, ["what"], "f.yml")).toEqual({ what: "auto" });
  });

  test("a gates key naming no stage is refused, not ignored", () => {
    expect(() => parseWorkflowGates({ wat: "auto" }, ["what"], "f.yml")).toThrow(GatePolicyError);
  });

  test("a gates value that is not human|auto is refused", () => {
    expect(() => parseWorkflowGates({ what: "maybe" }, ["what"], "f.yml")).toThrow(GatePolicyError);
  });
});

describe("--gates parsing", () => {
  const stages = ["what", "how", "plan", "build", "watch"];

  test("`all` is every stage human", () => {
    expect(parseGatesFlag("all", stages)).toEqual({
      what: "human", how: "human", plan: "human", build: "human", watch: "human",
    });
  });

  test("`none` is every stage auto", () => {
    expect(parseGatesFlag("none", stages)).toEqual({
      what: "auto", how: "auto", plan: "auto", build: "auto", watch: "auto",
    });
  });

  test("a list names the HUMAN gates; everything else becomes auto", () => {
    expect(parseGatesFlag("what,build", stages)).toEqual({
      what: "human", how: "auto", plan: "auto", build: "human", watch: "auto",
    });
  });

  test("whitespace around a list entry is not a different stage", () => {
    expect(parseGatesFlag(" what , build ", stages).what).toBe("human");
  });

  test("an unknown stage is a usage error naming the stages that exist", () => {
    expect(() => parseGatesFlag("what,wat", stages)).toThrow(/wat is not a stage/);
  });

  test("an empty value is refused rather than read as `none`", () => {
    expect(() => parseGatesFlag("", stages)).toThrow(GatePolicyError);
  });

  test("--gates overrides the workflow's own gates wholesale", () => {
    expect(resolveGatesPolicy(["a", "b"], { a: "auto", b: "auto" }, { a: "human", b: "auto" }))
      .toEqual({ a: "human", b: "auto" });
  });

  test("without an override, a stage the workflow does not name is human", () => {
    expect(resolveGatesPolicy(["a", "b"], { a: "auto" }, null)).toEqual({ a: "auto", b: "human" });
  });
});

describe("gates_policy in run.yml", () => {
  test("run new persists the resolved policy, and it survives a save", () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" } });
    const store = RunStore.open(ws.runDir);
    expect(store.run.gates_policy).toEqual({ alpha: "auto", beta: "human" });
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8"))
      .toContain("gates_policy: {alpha: auto, beta: human}");

    store.save();
    expect(RunStore.open(ws.runDir).run.gates_policy).toEqual({ alpha: "auto", beta: "human" });
  });

  test("`run new --gates` beats the workflow file", () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" }, gatesFlag: "beta" });
    expect(RunStore.open(ws.runDir).run.gates_policy).toEqual({ alpha: "auto", beta: "human" });
  });

  test("`run new --gates` with an unknown stage refuses to create the run", () => {
    const made = makeRunWorkspace();
    plain.push(made);
    expect(() => createRun({
      root: made.root, slug: "nope", scope: "feature", gates: "what,nosuch",
      actor: "alan", now: new Date("2026-08-29T09:00:00Z"),
    })).toThrow(NewRunError);
  });

  test("a run.yml with no gates_policy validates, and reads as human everywhere", () => {
    const ws = workspace([ALPHA]);
    const raw = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    const stripped = raw.split("\n").filter((line) => !line.startsWith("gates_policy:")).join("\n");
    writeFileSync(join(ws.runDir, "run.yml"), stripped, "utf8");

    expect(validateRunFile(parseYaml(stripped)).ok).toBe(true);
    const store = RunStore.open(ws.runDir);
    expect(store.run.gates_policy).toBeUndefined();
    expect(gatePolicyFor(store.run.gates_policy, "alpha")).toBe("human");
  });

  test("a run with no policy emits no gates_policy line at all", () => {
    const ws = workspace([ALPHA]);
    const store = RunStore.open(ws.runDir);
    const without = { ...store.run, gates_policy: undefined };
    expect(emitRunYaml(without)).not.toContain("gates_policy");
  });

  test("a gates_policy value that is not human|auto fails validation", () => {
    const ws = workspace([ALPHA]);
    const raw = readFileSync(join(ws.runDir, "run.yml"), "utf8")
      .replace("gates_policy: {alpha: human}", "gates_policy: {alpha: sometimes}");
    const validation = validateRunFile(parseYaml(raw));
    expect(validation.ok).toBe(false);
    expect(validation.issues[0]?.path).toBe("gates_policy.alpha");
  });
});

// --- G2: the auto gate ------------------------------------------------------

describe("an auto gate that holds", () => {
  test("closes itself through the approve path, records by: auto, and advances", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });

    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    // `next` prefixes its outcome with one line per loaded expert (§2.3 visibility),
    // so the done line is not at index 0. What this test is about is that the line
    // is there and the auto-gate note sits directly under it — find it, don't index it.
    const done = outcome.lines.findIndex((line) => line.includes("· auto-approved"));
    expect(done).toBeGreaterThanOrEqual(0);
    expect(outcome.lines[done + 1]).toContain("auto-gate: checks=claim-sources:passed");

    const store = RunStore.open(ws.runDir);
    const alpha = store.run.phases[0]?.stages[0];
    expect(alpha?.status).toBe("done");
    expect(alpha?.gate.status).toBe("approved");
    expect(alpha?.gate.by).toBe(AUTO_GATE_ACTOR);
    expect(alpha?.gate.at).not.toBeNull();
    expect(alpha?.gate.note).toContain("questions=0 open");
    expect(alpha?.gate.note).toContain("budget=$0.42 of $6.00 stage");
    expect(alpha?.gate.note).toContain("status=awaiting_gate");
    expect(alpha?.gate.note).toContain("claim-sources=passed");
    expect(store.run.cursor).toMatchObject({ phase: "02-how", stage: "beta" });
  });

  test("the gate is still REQUESTED — an auto gate is a gate, not a skipped one", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });
    await next(ws);

    const types = events(ws).map((e) => e.type);
    expect(types).toContain("gate.requested");
    expect(types).toContain("gate.approved");
    expect(types).toContain("stage.done");
    // and no new event type was invented for it
    const approved = events(ws).find((e) => e.type === "gate.approved");
    expect(approved?.actor).toBe(AUTO_GATE_ACTOR);
    expect(approved?.payload).toMatchObject({ by: AUTO_GATE_ACTOR, phase: "01-what" });
  });

  test("a human-policy stage still stops at exit 4, exactly as before", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "human", beta: "human" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines).toContain("gate pending: tldrx approve");
    expect(outcome.lines.join("\n")).not.toContain("auto-approved");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("awaiting_gate");
  });

  test("it does NOT start the next stage — one stage per next, still", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS });
    await next(ws);

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[1]?.stages[0]?.status).toBe("ready");
    expect(store.run.phases[1]?.stages[0]?.tasks).toHaveLength(0);
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toHaveLength(1);
  });
});

describe("the six auto-gate conditions, one at a time", () => {
  /** The pieces `evaluateAutoGate` needs, from a real run, with one knob turned. */
  function inputs(ws: FacilitatorWorkspace, overrides: Record<string, unknown> = {}): never {
    const store = RunStore.open(ws.runDir);
    const stage = store.run.phases[0]?.stages[0];
    const planned = loadWorkflowPreset(ws.root, store.run.scope).stages[0];
    return {
      root: ws.root,
      runDir: ws.runDir,
      phaseId: "01-what",
      stage,
      planned,
      budget: store.budget,
      checks: [{ id: "claim-sources", status: "passed", detail: "1 handoff(s) sourced" }],
      ...overrides,
    } as never;
  }

  test("1 · a failed check refuses the auto gate", async () => {
    const ws = workspace([ALPHA], { gates: { alpha: "auto" } });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    const verdict = await evaluateAutoGate(inputs(ws, {
      checks: [{ id: "cmd", status: "failed", detail: "`test` in api exited 1" }],
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("checks=cmd:failed");
    // and the other five still measured, in the note
    expect(verdict.conditions).toHaveLength(6);
    expect(verdict.note).toContain("questions=0 open");
  });

  test("2 · an open question refuses the auto gate", async () => {
    const ws = workspace([ALPHA], { gates: { alpha: "auto" } });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), openQuestion(), "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("questions=1 open (Q1)");
  });

  test("3 · spend over the stage ceiling refuses the auto gate", async () => {
    const ws = workspace([ALPHA], { gates: { alpha: "auto" } });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    const store = RunStore.open(ws.runDir);
    const stage = store.run.phases[0]?.stages[0];
    const verdict = await evaluateAutoGate(inputs(ws, {
      stage: { ...stage, budget_usd: 1, tasks: [{ ...TASK, cost_usd: 2.5 }] },
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("budget=$2.50 of $1.00 stage");
  });

  test("4 · a stage that ended `failed` refuses the auto gate", async () => {
    const ws = workspace([ALPHA], { gates: { alpha: "auto" } });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    const stage = RunStore.open(ws.runDir).run.phases[0]?.stages[0];
    const verdict = await evaluateAutoGate(inputs(ws, { stage: { ...stage, status: "failed" } }));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("status=failed");
  });

  test("5 · an unsourced handoff refuses the auto gate even when the stage never declared the check", async () => {
    const ws = workspace([ALPHA], { gates: { alpha: "auto" } });
    writeFileSync(
      join(ws.runDir, "01-what", "handoff.md"),
      "# Handoff\n\n## Findings\n- something nobody can check\n\n## Decisions\n- go\n\n"
        + "## Unknowns\n- none\n\n## Evidence ledger\n- none\n",
      "utf8",
    );
    const verdict = await evaluateAutoGate(inputs(ws, { checks: [] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("claim-sources=failed");
    // the CHECKS condition passed — the stage declared none. This is the case the
    // explicit claim-sources run exists for.
    expect(verdict.conditions[0]).toMatchObject({ id: "checks", ok: true, detail: "none declared" });
  });

  test("all six holding is the only way through", async () => {
    const ws = workspace([ALPHA], { gates: { alpha: "auto" } });
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    const verdict = await evaluateAutoGate(inputs(ws));
    expect(verdict.ok).toBe(true);
    expect(verdict.why).toBe("");
    expect(verdict.conditions.map((c) => c.id))
      .toEqual(["checks", "questions", "budget", "status", "claim-sources", "stories"]);
    // `stories` is a Build condition; every other phase measures it as n/a rather
    // than skipping it, so the note always says all six.
    expect(verdict.note).toContain("stories=n/a (not a build stage)");
  });
});

describe("a refused auto gate falls back to the human one", () => {
  test("an open question written by the stage: exit 4, and it says which", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" } });
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({
        "01-what/intent.md": cannedIntent(),
        "01-what/handoff.md": cannedHandoff(),
        "01-what/questions.md": openQuestion(),
      }),
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("auto gate not taken — questions=1 open (Q1)");
    expect(outcome.lines).toContain("gate pending: tldrx approve");

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.status).toBe("awaiting_gate");
    expect(store.run.phases[0]?.stages[0]?.gate.status).toBe("pending");
    expect(events(ws).some((e) => e.type === "gate.approved")).toBe(false);
  });

  test("an overspend: exit 4, naming the two numbers", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" }, budgetUsd: 10 });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_COST: "9.99" });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("auto gate not taken — budget=$9.99 of $6.00 stage");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate.status).toBe("pending");
  });

  test("an unsourced handoff on a stage with no claim-sources check: exit 4", async () => {
    const ws = workspace(
      [{ ...ALPHA, checks: "[]", outputs: HANDOFF_ONLY }, BETA],
      { gates: { alpha: "auto", beta: "human" } },
    );
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({
        "01-what/handoff.md":
          "# Handoff\n\n## Findings\n- unsourced\n\n## Decisions\n- go\n\n## Unknowns\n- none\n\n"
          + "## Evidence ledger\n- none\n",
      }),
    });

    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("auto gate not taken — claim-sources=failed");
  });

  test("after a refusal a human can still approve it by hand", async () => {
    const ws = workspace([{ ...ALPHA, outputs: HANDOFF_ONLY }, BETA], { gates: { alpha: "auto", beta: "human" } });
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({
        "01-what/handoff.md": cannedHandoff(),
        "01-what/questions.md": openQuestion(),
      }),
    });
    expect((await next(ws)).code).toBe(4);

    const { approve } = await import("../src/core/run/gates.ts");
    const outcome = await approve(RunStore.open(ws.runDir), {
      root: ws.root, actor: "alan", at: "2026-08-29T10:00:00Z", note: "read it, fine",
    });
    expect(outcome.ok).toBe(true);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate.by).toBe("alan");
  });
});

// --- G3: the headless loop --------------------------------------------------

describe("tldrx run auto", () => {
  test("runs stage after stage and stops at the first human gate (exit 4)", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines[0]).toBe("01-what/alpha … done $0.42 · auto-approved");
    expect(outcome.lines[1]).toBe("02-how/beta … done $0.42 · awaiting human gate");

    const store = RunStore.open(ws.runDir);
    expect(store.run.phases[0]?.stages[0]?.gate.by).toBe(AUTO_GATE_ACTOR);
    expect(store.run.phases[1]?.stages[0]?.status).toBe("awaiting_gate");
  });

  test("runs to the end when every gate is auto (exit 0)", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });

    const outcome = await auto(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.lines[0]).toBe("01-what/alpha … done $0.42 · auto-approved");
    expect(outcome.lines[1]).toBe("02-how/beta … done $0.42 · auto-approved");
    expect(outcome.lines[2]).toContain("is done — $0.84 spent by this loop");
    expect(RunStore.open(ws.runDir).run.status).toBe("done");
  });

  test("stops on an auto gate the conditions refused (exit 4), and says why", async () => {
    const ws = workspace([{ ...ALPHA, outputs: HANDOFF_ONLY }, BETA], { gates: { alpha: "auto", beta: "auto" } });
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({
        "01-what/handoff.md": cannedHandoff(),
        "01-what/questions.md": openQuestion(),
      }),
    });

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines[0]).toBe("01-what/alpha … done $0.42 · awaiting human gate");
    expect(outcome.lines.join("\n")).toContain("auto gate not taken — questions=1 open (Q1)");
  });

  test("stops on a failed stage (exit 5)", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.11" });

    const outcome = await auto(ws);
    expect(outcome.code).toBe(5);
    expect(outcome.lines[0]).toContain("01-what/alpha … failed:");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("failed");
  });

  test("stops on its own --max-usd ceiling (exit 2)", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });

    const outcome = await auto(ws, { maxUsd: 0.2 });
    expect(outcome.code).toBe(2);
    expect(outcome.lines[0]).toBe("01-what/alpha … done $0.42 · auto-approved");
    expect(outcome.lines[1]).toBe("stopped: this loop has spent $0.42 of its $0.20 --max-usd ceiling");
    // exactly one stage ran: the ceiling is checked BETWEEN stages
    expect(RunStore.open(ws.runDir).run.phases[1]?.stages[0]?.tasks).toHaveLength(0);
  });

  test("stops BEFORE the --until stage (exit 0)", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });

    const outcome = await auto(ws, { until: "beta" });
    expect(outcome.code).toBe(0);
    expect(outcome.lines[0]).toBe("01-what/alpha … done $0.42 · auto-approved");
    expect(outcome.lines[1]).toBe("stopped before 02-how/beta (--until) — $0.42 spent by this loop");
    expect(RunStore.open(ws.runDir).run.phases[1]?.stages[0]?.status).toBe("ready");
  });

  test("--until naming no stage of the run is a usage error before anything spawns", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS });

    const outcome = await auto(ws, { until: "gamma" });
    expect(outcome.code).toBe(1);
    expect(outcome.lines[0]).toContain("--until: 'gamma' is not a stage");
    expect(events(ws).some((e) => e.type === "agent.spawned")).toBe(false);
  });

  test("stops on a run already parked at an open question (exit 4)", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "auto" } });
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), openQuestion(), "utf8");
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage) => ({ ...stage, status: "awaiting_answer" as const })),
      }),
    }));
    store.save();

    const outcome = await auto(ws);
    expect(outcome.code).toBe(4);
    expect(outcome.lines[0]).toContain("01-what/alpha … awaiting answers: 1 open question(s)");
    expect(events(ws).some((e) => e.type === "agent.spawned")).toBe(false);
  });

  test("a run that is already done stops immediately, spending nothing", async () => {
    const ws = workspace([ALPHA], { gates: { alpha: "auto" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });
    expect((await auto(ws)).code).toBe(0);

    // Named explicitly: a finished run is not "open", so the no-id door answers
    // `no non-terminal run` — the same exit 3 `tldrx next` gives.
    expect((await auto(ws)).code).toBe(3);
    const again = await auto(ws, { runId: ws.runId });
    expect(again.code).toBe(0);
    expect(again.lines[0]).toContain("is done — $0.00 spent by this loop");
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toHaveLength(1);
  });

  test("a skipped stage gets its own line", async () => {
    const ws = workspace(
      [{ ...ALPHA, skipIf: "stories<=1" }, BETA],
      { gates: { alpha: "auto", beta: "human" } },
    );
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: BOTH_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });

    const outcome = await auto(ws);
    expect(outcome.lines[0]).toBe("01-what/alpha … skipped (skip_if: stories<=1)");
    expect(outcome.lines[1]).toBe("02-how/beta … done $0.42 · awaiting human gate");
  });

  test("no run at all exits 3 without touching anything", async () => {
    const made = makeRunWorkspace();
    plain.push(made);
    const outcome = await runAuto({
      root: made.root, yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    expect(outcome.code).toBe(3);
    expect(outcome.lines[0]).toBe("no non-terminal run in tldrx-work/");
  });
});

// --- G4: the status screen --------------------------------------------------

describe("run status shows the policy", () => {
  test("--json carries gates_policy and one gate row per stage, with `by`", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });
    await next(ws);

    const store = RunStore.open(ws.runDir);
    const view = buildStatus(store.run, store.budget, store.runDir);
    expect(view.gates_policy).toEqual({ alpha: "auto", beta: "human" });
    expect(view.gates[0]).toMatchObject({
      phase: "01-what", stage: "alpha", policy: "auto", status: "approved", by: AUTO_GATE_ACTOR,
    });
    expect(view.gates[1]).toMatchObject({ stage: "beta", policy: "human", status: "pending", by: null });
  });

  test("an old run.yml with no policy reports every stage as human", () => {
    const ws = workspace([ALPHA, BETA]);
    const store = RunStore.open(ws.runDir);
    const view = buildStatus({ ...store.run, gates_policy: undefined }, store.budget, store.runDir);
    expect(view.gates_policy).toEqual({ alpha: "human", beta: "human" });
  });

  test("the terminal screen prints the policy and who signed", async () => {
    const ws = workspace([ALPHA, BETA], { gates: { alpha: "auto", beta: "human" } });
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_COST: "0.42" });
    await next(ws);

    const store = RunStore.open(ws.runDir);
    const text = renderStatus(buildStatus(store.run, store.budget, store.runDir));
    expect(text).toContain("gates   1 human, 1 auto");
    expect(text).toContain("01-what/alpha  auto   approved by auto");
    expect(text).toContain("02-how/beta    human  approve: pending");
  });
});

const TASK = {
  id: "t1", status: "done" as const, expert: null, model: null, cost_usd: 0,
  error: null, session_id: null, started_at: null, ended_at: null, outputs: [],
};

function openQuestion(): string {
  return [
    "# Questions",
    "",
    "## Q1 · Where does the leaderboard live?",
    "<!-- id: Q1 | status: open | area: domain | asked_by: alpha | asked_at: 2026-08-29T09:00:00Z -->",
    "Why asked: not in facts.yml [src: absent:.tldrx/memory/facts.yml]",
    "",
    "- A) In the API",
    "- B) In the lab",
    "",
    "[Answer]:",
    "",
  ].join("\n");
}
