/**
 * Issue #123 — a `pending` gate that still records what its (former) signature
 * rested on.
 *
 * `revoke` resets an approved gate to `pending` and nulls `by` and `at`. #122
 * added `executed_by` and `authority` and cleared THOSE on the same move, for the
 * same reason: `by: null` beside an executor would be two contradicting claims
 * about one fact. `gate.evidence` was spread straight through, so the mapping said
 * both "nobody has signed this gate" and "here is what the signature rested on".
 *
 * The disposition chosen, and the reason it is not a deletion:
 *
 *   `run.yml` is STATE — the resume point. `events.jsonl` is HISTORY — append
 *   only. The contradiction is a state contradiction, so the pointer leaves the
 *   gate mapping; and because an audit framework does not delete history, the
 *   withdrawn signature's evidence goes onto the `gate.revoked` event, beside the
 *   `signed_by`/`signed_at` it already carried and the envelope's own actor and
 *   timestamp — who took it back, and when. The committed note itself never moves
 *   from `<phase>/gate-evidence/<stage>.md`.
 *
 * A `revoked:` block kept on the gate was the alternative. It was refused because
 * it grows: a gate may be approved, revoked, re-approved and revoked again, so
 * the state file would accumulate a list of withdrawn signatures — which is what
 * the append-only log is for — and every reader would have to learn a "withdrawn"
 * mode for a block whose only truthful reading in `run.yml` is "current".
 *
 * The move is only honest if a reader can still see it: `gate.revoked` was in the
 * event set and in no narrative — `replay`'s `bullet()` had no case for it and
 * returned null — so the evidence would have moved somewhere nobody looks. That
 * line is part of this fix.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { revoke } from "../src/core/run/gates.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { validateRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { evidencePath, gateEvidencePath } from "../src/core/facilitator/paths.ts";
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

/** The owner in the measured #122 record — the run creator AND the note's `by:`. */
const OWNER = "alanmartinez";
const GATE = "01-what/alpha";
const REVOKER = "will";

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

function workspace(gates: Readonly<Record<string, string>> = { alpha: "agent", beta: "human" }): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates, actor: OWNER,
  });
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

/** The evidence note exactly as #122's fixture writes it: `role: agent`, `by:` an operator. */
function note(): string {
  return [
    "---", "version: 1", `gate: ${GATE}`, "role: agent", `by: ${OWNER}`,
    "at: 2026-09-02T08:14:03Z", "verdict: sign",
    'read: ["01-what/handoff.md", "01-what/intent.md"]',
    "citations: {sampled: 2, of: 4, resolved: 2, refuted: 0}",
    "touches: {audited: 3, outside_surface: 0, new_areas: []}",
    "diff_vs_stories: n-a", "caveats: []", "recommend: []", "---", "",
    `# Gate evidence — ${GATE}`, "",
    "## Read", "- the handoff, every bullet of it [src: 01-what/handoff.md:1]", "",
    "## Citations checked", "- 2 of 4 spot-checked, both resolved [src: 01-what/handoff.md:4]", "",
    "## Touches audited",
    "- 3 touched paths, all inside the declared surface [src: .tldrx/workspace.yml:1]", "",
    "## Verdict", "- SIGN — every declared output is on disk [src: .tldrx/workspace.yml:1]", "",
  ].join("\n");
}

function writeNote(runDir: string): void {
  const path = evidencePath(runDir, "alpha");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, note(), "utf8");
}

function stageOf(runDir: string) {
  return RunStore.open(runDir).run.phases[0]?.stages[0];
}

function gateLine(runDir: string): string {
  const raw = readFileSync(join(runDir, "run.yml"), "utf8");
  return raw.split("\n").find((line) => line.trimStart().startsWith("gate: {")) ?? "";
}

function takeBack(ws: FacilitatorWorkspace, why = "the sample was too small"): void {
  revoke(RunStore.open(ws.runDir), { root: ws.root, actor: REVOKER, at: "2026-09-02T11:00:00Z", note: why }, GATE);
}

/** An agent gate signed over an evidence note, then taken back. */
async function signedThenRevoked(): Promise<FacilitatorWorkspace> {
  const ws = workspace();
  writeNote(ws.runDir);
  expect((await next(ws)).code).toBe(0);
  expect(stageOf(ws.runDir)?.gate.evidence).toBeDefined();
  takeBack(ws);
  return ws;
}

// ---------------------------------------------------------------------------
// A. The contradiction itself
// ---------------------------------------------------------------------------

describe("a gate nobody has signed rests on nothing", () => {
  test("revoke clears `evidence` beside `by`, `at`, `executed_by` and `authority`", async () => {
    const ws = await signedThenRevoked();

    const gate = stageOf(ws.runDir)?.gate;
    expect(gate?.status).toBe("pending");
    expect(gate?.by).toBeNull();
    expect(gate?.at).toBeNull();
    expect(gate?.executed_by).toBeUndefined();
    expect(gate?.authority).toBeUndefined();
    // the one this issue is about: no `evidence:` under a gate the file says is open
    expect(gate?.evidence).toBeUndefined();
  });

  test("the mapping on disk is back to the five keys a pending gate has ever had", async () => {
    const ws = await signedThenRevoked();
    expect(gateLine(ws.runDir)).toBe(
      '        gate: {type: approve, status: pending, by: null, at: null, note: "the sample was too small"}',
    );
  });
});

// ---------------------------------------------------------------------------
// B. Moved, not destroyed — history goes to the append-only log
// ---------------------------------------------------------------------------

describe("the withdrawn signature's evidence survives the revocation", () => {
  test("`gate.revoked` carries what was withdrawn, who signed it, who took it back and when", async () => {
    const ws = await signedThenRevoked();

    const revoked = EventLog.forRun(ws.runDir).read().find((e) => e.type === "gate.revoked");
    expect(revoked?.actor).toBe(REVOKER);
    expect(revoked?.ts).toBe("2026-09-02T11:00:00Z");
    expect(revoked?.payload).toMatchObject({
      phase: "01-what",
      signed_by: OWNER,
      note: "the sample was too small",
      evidence: {
        path: "01-what/gate-evidence/alpha.md",
        role: "agent",
        verdict: "sign",
        sampled: 2,
        of: 4,
        resolved: 2,
        refuted: 0,
        outside_surface: 0,
      },
    });
    expect(typeof revoked?.payload.signed_at).toBe("string");
  });

  test("the event is still a legal event — the block is inside the depth and byte caps", async () => {
    const ws = await signedThenRevoked();
    const revoked = EventLog.forRun(ws.runDir).read().find((e) => e.type === "gate.revoked");
    expect(validateEvent(JSON.parse(JSON.stringify(revoked))).ok).toBe(true);
  });

  test("the committed note itself is untouched — nothing on disk was deleted", async () => {
    const ws = await signedThenRevoked();
    // The COMMITTED copy (`<phase>/gate-evidence/<stage>.md`), which is the one a
    // reviewer finds in a clone — not the gitignored `.agent/` scratch original.
    const committed = gateEvidencePath(ws.runDir, "01-what", "alpha");
    expect(committed.endsWith("01-what/gate-evidence/alpha.md")).toBe(true);
    expect(readFileSync(committed, "utf8")).toBe(note());
    // and the pointer that was cleared named exactly that file
    const revoked = EventLog.forRun(ws.runDir).read().find((e) => e.type === "gate.revoked");
    expect((revoked?.payload.evidence as { path: string }).path).toBe("01-what/gate-evidence/alpha.md");
  });

  test("a gate that rested on no evidence writes no `evidence` key at all", async () => {
    const ws = workspace({ alpha: "auto", beta: "human" });
    expect((await next(ws)).code).toBe(0);
    expect(stageOf(ws.runDir)?.gate.evidence).toBeUndefined();
    takeBack(ws, "auto signed too fast");

    const revoked = EventLog.forRun(ws.runDir).read().find((e) => e.type === "gate.revoked");
    expect(revoked?.payload.signed_by).toBe("auto");
    expect(Object.keys(revoked?.payload ?? {})).not.toContain("evidence");
  });
});

// ---------------------------------------------------------------------------
// C. A reader can still see it — the move is only honest if it lands in a report
// ---------------------------------------------------------------------------

describe("replay narrates the revocation", () => {
  test("the withdrawal is a line in the narrative, naming both parties", async () => {
    const ws = await signedThenRevoked();
    const loaded = loadRun(ws.root, ws.runId);
    if (loaded === null) throw new Error("no run");

    const said = renderReplay(loaded);
    expect(said).toContain(`gate REVOKED by ${REVOKER}`);
    expect(said).toContain(`signed by ${OWNER}`);
    expect(said).toContain("the sample was too small");
  });

  test("it says what the withdrawn signature had rested on, and that the note is still there", async () => {
    const ws = await signedThenRevoked();
    const loaded = loadRun(ws.root, ws.runId);
    if (loaded === null) throw new Error("no run");

    const said = renderReplay(loaded);
    expect(said).toContain("01-what/gate-evidence/alpha.md");
    expect(said).toContain("sign");
  });

  test("the evidence block no longer renders UNDER a gate the file says is open", async () => {
    const ws = await signedThenRevoked();
    const loaded = loadRun(ws.root, ws.runId);
    if (loaded === null) throw new Error("no run");

    // `gateEvidenceLines` reads run.yml, and the counts of a withdrawn signature
    // drawn under a `pending` gate is exactly what #123 reported. Measured before
    // the fix, in the same render whose closing section says the gate is open:
    //   - 01-what/alpha SIGN by ? (agent) — read 2 files, spot-checked 2 of 4 …
    const said = renderReplay(loaded);
    expect(said).not.toContain(`${GATE} SIGN`);
    expect(said).not.toContain("spot-checked 2 of 4 citations");
    // and it is not that the render is empty — the run still says the gate is open
    expect(said).toContain("Pending gate: `alpha` is waiting for `tldrx approve`");
  });
});

// ---------------------------------------------------------------------------
// D. Old records — the tolerance the schema promised
// ---------------------------------------------------------------------------

describe("a record written before any of this", () => {
  test("an approved gate carrying `evidence` and NO #122 blocks validates, loads and emits byte-for-byte", () => {
    const ws = workspace();
    const legacy = emitRunYaml(withGate(RunStore.open(ws.runDir).run, {
      ...RunStore.open(ws.runDir).run.phases[0]!.stages[0]!.gate,
      status: "approved", by: OWNER, at: "2026-09-01T10:00:00Z",
      evidence: {
        path: "01-what/gate-evidence/alpha.md", role: "agent", verdict: "sign",
        sampled: 2, of: 4, resolved: 2, refuted: 0, outside_surface: 0,
      },
    }));
    expect(legacy).toContain('evidence: {path: "01-what/gate-evidence/alpha.md"');
    expect(legacy).not.toContain("executed_by");
    const parsed = parseYaml(legacy);
    expect(validateRunFile(parsed).ok).toBe(true);
    expect(emitRunYaml(parsed as RunFile)).toBe(legacy);
  });

  test("revoking one clears its evidence too — one rule, whatever wrote the record", async () => {
    const ws = workspace();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withGate(run, {
      ...run.phases[0]!.stages[0]!.gate,
      status: "approved", by: OWNER, at: "2026-09-01T10:00:00Z",
      evidence: {
        path: "01-what/gate-evidence/alpha.md", role: "agent", verdict: "sign",
        sampled: 2, of: 4, resolved: 2, refuted: 0, outside_surface: 0,
      },
    }));
    store.save();

    takeBack(ws, "no executor recorded, and the counts do not add up");
    expect(stageOf(ws.runDir)?.gate.evidence).toBeUndefined();
    const revoked = EventLog.forRun(ws.runDir).read().find((e) => e.type === "gate.revoked");
    expect(revoked?.payload).toMatchObject({ evidence: { verdict: "sign", sampled: 2 } });
  });

  test("`gate.revoked` events written before the block render exactly as they did", async () => {
    const ws = workspace({ alpha: "auto", beta: "human" });
    expect((await next(ws)).code).toBe(0);
    takeBack(ws, "auto signed too fast");
    const loaded = loadRun(ws.root, ws.runId);
    if (loaded === null) throw new Error("no run");
    const said = renderReplay(loaded);
    expect(said).toContain(`gate REVOKED by ${REVOKER}`);
    expect(said).not.toContain("gate-evidence");
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
