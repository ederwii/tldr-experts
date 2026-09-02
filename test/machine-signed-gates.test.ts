/**
 * Issue #124 — `tldrx status` never reported an AGENT-signed gate as
 * machine-signed.
 *
 * `machineSignedDetails` in `core/status/runItems.ts` is the report whose whole
 * job is naming the gates a machine closed, so a person can take one back. It
 * selected on `gate.by === "auto"`. That catches every facilitator-closed gate
 * and no agent-closed one: an `agent` gate records the evidence note's `by:`,
 * which is the OPERATOR account the agent was running as — a person's name.
 * Measured on run `260902-discovery-pipeline-map` (the record in #122) the gate
 * reads `by: alanmartinez`, so the report counted it as human-signed and never
 * offered the revoke — the inverse of what the report is for, on the one kind of
 * closure where the recorded name is not the entity that did the checking.
 *
 * #122 made the selector direct: `executed_by.type` ∈ {agent, auto}. The old
 * `by === "auto"` heuristic stays as the UNION member for records written before
 * that field existed, where it is the only signal there is.
 *
 * The wording changed with it, deliberately. "signed `by: auto`, not by a person"
 * is false of an agent gate — there the record does carry a person's name, and
 * the point is that the person did not do the checking. The line now names the
 * executor's kind per stage, through the same `describeGateSignature` `run
 * status`, `replay` and the dashboard use, so a fourth reading of one fact cannot
 * drift from the other three.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { approve } from "../src/core/run/gates.ts";
import { runItems } from "../src/core/status/runItems.ts";
import { evidencePath } from "../src/core/facilitator/paths.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import type { RunFile } from "../src/core/run/RunFile.ts";
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

const OWNER = "alanmartinez";
const GATE = "01-what/alpha";

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

function workspace(gates: Readonly<Record<string, string>>): FacilitatorWorkspace {
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

function details(root: string): string {
  return runItems(root).flatMap((item) => item.details).join("\n");
}

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

// ---------------------------------------------------------------------------
// A. The gate the report was blind to
// ---------------------------------------------------------------------------

describe("an agent-signed gate is a machine-signed gate", () => {
  test("the report names it, and hands over the command that takes it back", async () => {
    const ws = workspace({ alpha: "agent", beta: "human" });
    writeNote(ws.runDir);
    expect((await next(ws)).code).toBe(0);
    // the record the old selector read as a human's: a person's name in `by`
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate.by).toBe(OWNER);

    const said = details(ws.root);
    expect(said).toContain("1 gate(s) closed by a machine, not by a person");
    expect(said).toContain(GATE);
    expect(said).toContain(`--stage ${GATE}`);
    expect(said).toContain("tldrx reject");
  });

  test("it renders the executor's kind through the ONE shared renderer", async () => {
    const ws = workspace({ alpha: "agent", beta: "human" });
    writeNote(ws.runDir);
    await next(ws);

    expect(details(ws.root)).toContain(
      `${GATE} signed by agent ${OWNER} (delegated by ${OWNER}, policy: agent)`,
    );
  });

  test("it says out loud why the name on that gate is not who did the checking", async () => {
    const ws = workspace({ alpha: "agent", beta: "human" });
    writeNote(ws.runDir);
    await next(ws);

    expect(details(ws.root)).toContain(
      "an `agent` gate is signed under the operator account the agent ran as, so the name on it "
      + "is not the entity that did the checking",
    );
  });

  test("that caveat is absent when no agent gate is in the run", async () => {
    const ws = workspace({ alpha: "auto", beta: "human" });
    expect((await next(ws)).code).toBe(0);

    const said = details(ws.root);
    expect(said).toContain("1 gate(s) closed by a machine, not by a person");
    expect(said).not.toContain("the operator account the agent ran as");
  });
});

// ---------------------------------------------------------------------------
// B. What it must still NOT report — the executor's kind, never the policy
// ---------------------------------------------------------------------------

describe("a gate a person actually closed", () => {
  test("a human signing a human gate is not reported", async () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    expect((await next(ws)).code).toBe(4);
    const store = RunStore.open(ws.runDir);
    expect((await approve(store, { root: ws.root, actor: "will", at: "2026-09-02T10:00:00Z", note: "read it" })).ok).toBe(true);

    expect(details(ws.root)).not.toContain("closed by a machine");
  });

  test("a person OVERRIDING an agent-gated stage is not reported either", async () => {
    // no evidence note ⇒ the agent gate falls to a person, who signs with no flag
    const ws = workspace({ alpha: "agent", beta: "human" });
    expect((await next(ws)).code).toBe(4);
    const store = RunStore.open(ws.runDir);
    expect((await approve(store, { root: ws.root, actor: "will", at: "2026-09-02T10:00:00Z", note: "shipping over it" })).ok).toBe(true);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate.executed_by).toEqual({ type: "human", id: "will" });

    // the POLICY is `agent`; the executor is a person, and this report is about executors
    expect(details(ws.root)).not.toContain("closed by a machine");
  });

  test("a gate nobody has signed yet is not reported", async () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    expect((await next(ws)).code).toBe(4);
    expect(details(ws.root)).not.toContain("closed by a machine");
  });
});

// ---------------------------------------------------------------------------
// C. Old records — the union, not the replacement
// ---------------------------------------------------------------------------

describe("a gate signed before `executed_by` existed", () => {
  test("`by: auto` with no executed_by is still reported — the heuristic is the fallback", () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withGate(run, {
      type: "approve", status: "approved", by: "auto", at: "2026-09-01T10:00:00Z", note: "",
    }));
    store.save();

    const said = details(ws.root);
    expect(said).toContain("1 gate(s) closed by a machine, not by a person");
    // `describeGateSignature` falls back to the bare `by` — exactly what it printed before
    expect(said).toContain(`${GATE} signed by auto.`);
  });

  test("a legacy human gate is still not reported", () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withGate(run, {
      type: "approve", status: "approved", by: "alan", at: "2026-09-01T10:00:00Z", note: "",
    }));
    store.save();

    expect(details(ws.root)).not.toContain("closed by a machine");
  });
});
