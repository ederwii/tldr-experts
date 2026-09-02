/**
 * Issue #122 — the ACTOR that executed a gate is not the AUTHORITY it acted
 * under, and a gate record that carries only `by:` cannot tell them apart.
 *
 * The record that started this, measured 2026-09-02 on run
 * `260902-discovery-pipeline-map`:
 *
 *   {"type":"gate.approved","actor":"alanmartinez",
 *    "payload":{"by":"alanmartinez","note":"agent-gate: evidence=sign by alanmartinez, …"}}
 *
 * Nobody named `alanmartinez` looked at that stage. An AGENT evaluated and signed
 * it, under authority the owner delegated once, at `run new --gates what:agent`.
 * The delegation lived only in the prose of `note:`, which nothing parses and any
 * hand-typed `--note "agent-gate: …"` can forge.
 *
 * Four questions an audit has to answer and could not: who authorized the
 * decision authority, which entity actually evaluated THIS gate, whether that
 * entity was a human / an agent / the facilitator, and under which policy. Two
 * additive blocks answer all four — `executed_by` and `authority` — and NOTHING
 * here is guessed: the policy comes from the run's frozen `gates_policy`, the
 * authorizer from `run.created` or from the `gate.policy_changed` that moved it,
 * and where the record does not say, `authorized_by` is null and `source` says
 * `unrecorded`.
 *
 * The other half of the file is the promise that old records did not change: a
 * five-key gate still validates, still loads, still emits byte-for-byte, and
 * still renders exactly the string it rendered before.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { approve, revoke } from "../src/core/run/gates.ts";
import { setGatePolicy } from "../src/core/run/setGatePolicy.ts";
import { AUTO_GATE_ACTOR } from "../src/core/run/autoGate.ts";
import { describeGateSignature } from "../src/core/run/gateAuthority.ts";
import { validateRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { renderStatus, buildStatus } from "../src/core/run/runStatus.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { evidencePath } from "../src/core/facilitator/paths.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import { renderReplay } from "../src/core/replay/renderReplay.ts";
import { loadRun } from "../src/core/replay/loadRun.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST"] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
  clearSrcCaches();
});

/** The owner in the measured record. The run creator AND the note's `by:`. */
const OWNER = "alanmartinez";

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

const GATE = "01-what/alpha";

function workspace(
  gates: Readonly<Record<string, string>> = { alpha: "agent", beta: "human" },
  actor: string = OWNER,
): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates, actor });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = ALPHA_OUTPUTS;
  process.env.FAKE_CLAUDE_COST = "0.42";
  return made;
}

function next(ws: { root: string }, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: OWNER, at: "2026-09-02T09:00:00Z", ...overrides,
  });
}

/**
 * The note exactly as the measured run's agent wrote it: `role: agent`, and a
 * `by:` carrying the OPERATOR's name, because that is the account the agent was
 * running as. That collision is the whole bug — and the fix must not require the
 * note to change, because the note is the agent's own claim about itself.
 */
function note(by: string = OWNER): string {
  return [
    "---",
    "version: 1",
    `gate: ${GATE}`,
    "role: agent",
    `by: ${by}`,
    "at: 2026-09-02T08:14:03Z",
    "verdict: sign",
    'read: ["01-what/handoff.md", "01-what/intent.md"]',
    "citations: {sampled: 2, of: 4, resolved: 2, refuted: 0}",
    "touches: {audited: 3, outside_surface: 0, new_areas: []}",
    "diff_vs_stories: n-a",
    "caveats: []",
    "recommend: []",
    "---",
    "",
    `# Gate evidence — ${GATE}`,
    "",
    "## Read",
    "- the handoff, every bullet of it [src: 01-what/handoff.md:1]",
    "",
    "## Citations checked",
    "- 2 of 4 spot-checked, both resolved [src: 01-what/handoff.md:4]",
    "",
    "## Touches audited",
    "- 3 touched paths, all inside the declared surface [src: .tldrx/workspace.yml:1]",
    "",
    "## Verdict",
    "- SIGN — every declared output is on disk [src: .tldrx/workspace.yml:1]",
    "",
  ].join("\n");
}

function writeNote(runDir: string, stage: string, text: string): string {
  const path = evidencePath(runDir, stage);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

function stageOf(runDir: string) {
  return RunStore.open(runDir).run.phases[0]?.stages[0];
}

function statusLines(runDir: string): string {
  const store = RunStore.open(runDir);
  return renderStatus(buildStatus(store.run, store.budget, store.runDir));
}

// ---------------------------------------------------------------------------
// A. The measured shape, reproduced — and the two blocks that answer the audit
// ---------------------------------------------------------------------------

describe("an agent signs under delegated authority (the 260902 record)", () => {
  test("the record separates the entity that EVALUATED from the human who DELEGATED", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());

    expect((await next(ws)).code).toBe(0);

    const gate = stageOf(ws.runDir)?.gate;
    // `by` is untouched. It is what the note said, and the note is the agent's
    // own claim about itself; rewriting it would be inventing a second one.
    expect(gate?.by).toBe(OWNER);
    // What is NEW is that the record no longer stops there.
    expect(gate?.executed_by).toEqual({ type: "agent", id: OWNER });
    expect(gate?.authority).toEqual({
      type: "delegated",
      policy: "agent",
      authorized_by: OWNER,
      source: "run.created",
    });
  });

  test("the four audit questions are answerable off the gate record alone", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);
    const gate = stageOf(ws.runDir)?.gate;

    // 1. who authorized the decision authority
    expect(gate?.authority?.authorized_by).toBe(OWNER);
    // 2. which entity actually evaluated THIS gate
    expect(gate?.executed_by?.id).toBe(OWNER);
    // 3. human / agent / auto
    expect(gate?.executed_by?.type).toBe("agent");
    // 4. under which policy
    expect(gate?.authority?.policy).toBe("agent");
    // and the two are not the same claim: the executor is not a human, while the
    // authorizer is — which is precisely what one `by: alanmartinez` could not say.
    expect(gate?.executed_by?.type).not.toBe("human");
    expect(gate?.authority?.type).toBe("delegated");
  });

  test("the gate.approved event carries both blocks, beside the `by` it always had", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);

    const approved = EventLog.forRun(ws.runDir).read().find((e) => e.type === "gate.approved");
    expect(approved?.actor).toBe(OWNER);
    expect(approved?.payload).toMatchObject({
      by: OWNER,
      executed_by: { type: "agent", id: OWNER },
      authority: { type: "delegated", policy: "agent", authorized_by: OWNER, source: "run.created" },
    });
  });
});

// ---------------------------------------------------------------------------
// B. It must not RENDER as a person either
// ---------------------------------------------------------------------------

describe("a delegated-agent signature never renders as a bare human name", () => {
  test("`run status` names the executor's kind and who delegated to it", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);

    const said = statusLines(ws.runDir);
    expect(said).toContain(`approved by agent ${OWNER} (delegated by ${OWNER}, policy: agent)`);
    // the bare form is what read as "Alan personally reviewed this"
    expect(said).not.toContain(`approved by ${OWNER} `);
  });

  test("`replay` says it too — the narrative is read six months later", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);

    const loaded = loadRun(ws.root, ws.runId);
    if (loaded === null) throw new Error("no run");
    const said = renderReplay(loaded);
    expect(said).toContain(`gate APPROVED by agent ${OWNER} (delegated by ${OWNER}, policy: agent)`);
    expect(said).not.toContain(`gate APPROVED by ${OWNER}`);
  });

  test("the one renderer, used everywhere, on the shape itself", () => {
    expect(describeGateSignature({
      by: OWNER,
      executed_by: { type: "agent", id: OWNER },
      authority: { type: "delegated", policy: "agent", authorized_by: OWNER, source: "run.created" },
    })).toBe(`agent ${OWNER} (delegated by ${OWNER}, policy: agent)`);
  });
});

// ---------------------------------------------------------------------------
// C. Old records — the whole point of "additive"
// ---------------------------------------------------------------------------

describe("a gate written before these fields existed", () => {
  test("five keys, no executed_by, no authority — still validates and still loads", () => {
    const ws = workspace();
    const raw = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    expect(raw).toContain('gate: {type: approve, status: pending, by: null, at: null, note: ""}');
    expect(raw).not.toContain("executed_by");
    expect(raw).not.toContain("authority");
    expect(validateRunFile(parseYaml(raw)).ok).toBe(true);
    expect(emitRunYaml(RunStore.open(ws.runDir).run)).toBe(raw);
  });

  test("the renderer falls back to the bare `by`, byte for byte what it printed before", () => {
    expect(describeGateSignature({ by: "alan" })).toBe("alan");
    expect(describeGateSignature({ by: null })).toBe("?");
  });

  test("`run status` on an old approved gate is unchanged", () => {
    const ws = workspace();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withGate(run, {
      ...run.phases[0]!.stages[0]!.gate,
      status: "approved", by: "alan", at: "2026-09-01T10:00:00Z",
    }));
    store.save();
    expect(statusLines(ws.runDir)).toContain("approved by alan");
  });
});

// ---------------------------------------------------------------------------
// D. Deriving it — from what IS recorded, and never from a guess
// ---------------------------------------------------------------------------

describe("who the record says authorized the policy", () => {
  test("`run gates set` names THAT signer, not the run creator", async () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    const outcome = setGatePolicy({
      root: ws.root, entry: "alpha:agent", note: "the reviewer earned it on the last three runs",
      actor: "will", at: "2026-09-02T08:00:00Z",
    });
    expect(outcome.code).toBe(0);
    writeNote(ws.runDir, "alpha", note());
    await next(ws);

    expect(stageOf(ws.runDir)?.gate.authority).toEqual({
      type: "delegated", policy: "agent", authorized_by: "will", source: "gate.policy_changed",
    });
  });

  test("an auto gate is the facilitator: a type, never an identity", async () => {
    const ws = workspace({ alpha: "auto", beta: "human" });
    expect((await next(ws)).code).toBe(0);

    const gate = stageOf(ws.runDir)?.gate;
    expect(gate?.by).toBe(AUTO_GATE_ACTOR);
    expect(gate?.executed_by).toEqual({ type: "auto" });
    expect(gate?.authority).toEqual({
      type: "delegated", policy: "auto", authorized_by: OWNER, source: "run.created",
    });
    expect(statusLines(ws.runDir)).toContain(`approved by auto (delegated by ${OWNER}, policy: auto)`);
  });

  test("a person signing a human gate holds the authority themselves", async () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    expect((await next(ws)).code).toBe(4);
    const store = RunStore.open(ws.runDir);
    const outcome = await approve(store, { root: ws.root, actor: "will", at: "2026-09-02T10:00:00Z", note: "read it" });
    expect(outcome.ok).toBe(true);

    expect(stageOf(ws.runDir)?.gate.executed_by).toEqual({ type: "human", id: "will" });
    expect(stageOf(ws.runDir)?.gate.authority).toEqual({
      type: "direct", policy: "human", authorized_by: "will", source: "self",
    });
    // unchanged on the screen: a person who signed as themselves is a name
    expect(statusLines(ws.runDir)).toContain("approved by will");
  });

  test("a person OVERRIDING an agent gate is a human acting directly, with the policy still named", async () => {
    const ws = workspace();
    // no evidence note ⇒ the agent gate falls to a person, who signs with no flag
    expect((await next(ws)).code).toBe(4);
    const store = RunStore.open(ws.runDir);
    expect((await approve(store, { root: ws.root, actor: "will", at: "2026-09-02T10:00:00Z", note: "shipping over it" })).ok).toBe(true);

    expect(stageOf(ws.runDir)?.gate.executed_by).toEqual({ type: "human", id: "will" });
    expect(stageOf(ws.runDir)?.gate.authority).toEqual({
      type: "direct", policy: "agent", authorized_by: "will", source: "self",
    });
  });

  test("nothing is guessed: an unattributable policy is null, and the source says so", async () => {
    const ws = makeFacilitatorWorkspace({
      scope: "demo", budgetUsd: 10, gatesFlag: "none", actor: OWNER,
      stages: [{ id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve" }],
    });
    open.push(ws);
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage, j) => j !== 0 ? stage : { ...stage, status: "awaiting_gate" as const }),
      }),
    }));
    store.save();
    // the log is gone — a clone that shipped run.yml and nothing else
    rmSync(join(ws.runDir, "events.jsonl"), { force: true });

    const fresh = RunStore.open(ws.runDir);
    expect((await approve(fresh, { root: ws.root, actor: AUTO_GATE_ACTOR, at: "2026-09-02T10:00:00Z", note: "" })).ok).toBe(true);
    expect(stageOf(ws.runDir)?.gate.authority).toEqual({
      type: "delegated", policy: "auto", authorized_by: null, source: "unrecorded",
    });
    expect(statusLines(ws.runDir)).toContain("approved by auto (delegated by unrecorded, policy: auto)");
  });
});

// ---------------------------------------------------------------------------
// E. The file: emitted, round-tripped, validated, and cleared on a revoke
// ---------------------------------------------------------------------------

describe("run.yml carries both blocks", () => {
  function signed(run: RunFile): RunFile {
    return withGate(run, {
      ...run.phases[0]!.stages[0]!.gate,
      status: "approved", by: OWNER, at: "2026-09-02T10:00:00Z",
      executed_by: { type: "agent", id: OWNER },
      authority: { type: "delegated", policy: "agent", authorized_by: OWNER, source: "run.created" },
    });
  }

  test("the emitter writes them — a key held in memory and not emitted would be DROPPED", () => {
    const ws = workspace();
    const emitted = emitRunYaml(signed(RunStore.open(ws.runDir).run));
    expect(emitted).toContain(`executed_by: {type: agent, id: ${OWNER}}`);
    expect(emitted).toContain(
      `authority: {type: delegated, policy: agent, authorized_by: ${OWNER}, source: run.created}`,
    );
  });

  test("it round-trips: emit, parse, emit again, byte for byte", () => {
    const ws = workspace();
    const once = emitRunYaml(signed(RunStore.open(ws.runDir).run));
    const parsed = parseYaml(once);
    expect(validateRunFile(parsed).ok).toBe(true);
    expect(emitRunYaml(parsed as RunFile)).toBe(once);
  });

  test("a half-written authority block is refused rather than half-read", () => {
    const ws = workspace();
    const raw = emitRunYaml(signed(RunStore.open(ws.runDir).run)).replace("policy: agent, ", "");
    const validation = validateRunFile(parseYaml(raw));
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((i) => i.path)).toContain("phases[0].stages[0].gate.authority.policy");
  });

  test("an executor type outside the enum is refused", () => {
    const ws = workspace();
    const raw = emitRunYaml(signed(RunStore.open(ws.runDir).run)).replace("type: agent, id", "type: robot, id");
    const validation = validateRunFile(parseYaml(raw));
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((i) => i.path)).toContain("phases[0].stages[0].gate.executed_by.type");
  });

  test("revoking an approval clears them — a gate nobody has signed has no executor", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);
    expect(stageOf(ws.runDir)?.gate.executed_by).toBeDefined();

    const store = RunStore.open(ws.runDir);
    revoke(store, { root: ws.root, actor: "will", at: "2026-09-02T11:00:00Z", note: "the sample was too small" }, GATE);

    const gate = stageOf(ws.runDir)?.gate;
    expect(gate?.status).toBe("pending");
    expect(gate?.by).toBeNull();
    expect(gate?.executed_by).toBeUndefined();
    expect(gate?.authority).toBeUndefined();
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).not.toContain("executed_by");
  });
});

/** Replace the first stage's gate. */
function withGate(run: RunFile, gate: RunFile["phases"][number]["stages"][number]["gate"]): RunFile {
  return {
    ...run,
    phases: run.phases.map((phase, i) => i !== 0 ? phase : {
      ...phase,
      stages: phase.stages.map((stage, j) => (j !== 0 ? stage : { ...stage, gate })),
    }),
  };
}
