/**
 * The gate signer — gh #198.
 *
 * `gates_policy: agent` said who MAY sign a gate and nothing produced the note it
 * signs over, so an engine-driven `run auto` over an all-`agent` run stopped at
 * every gate with exit 4 (measured on tldrx 0.13.1, issue #198). These tests are
 * about the join: the engine spawns ONE bounded signer turn, the signer writes
 * `.agent/<stage>/evidence.md`, and the note goes through the UNCHANGED
 * `evaluateAgentGate` → `approve` path — the same door a person walks through.
 *
 * The property under test in every case is that the signer can only make the gate
 * CLOSE when the existing validator already would have. A `hold`, a broken note
 * and a dead signer are one outcome — the gate falls to a person with the reason
 * named — and a `human` gate never sees a signer at all.
 *
 * Everything real is real: a real run, a real loop, real files, the real
 * validator. Only the sub-agent is faked, and the fake writes its note from a
 * fixture through the shared transcript emitter.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAuto, type AutoOptions } from "../src/core/facilitator/runAuto.ts";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import { evidencePath } from "../src/core/facilitator/paths.ts";
import {
  GATE_SIGNER_MARKER, GATE_SIGNER_ROLE, GATE_SIGNER_SHARE, GATE_SIGNER_TOOLS,
  renderGateSignerPrompt,
} from "../src/core/facilitator/gateSigner.ts";
import { buildRunCost } from "../src/core/budget/costView.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace,
  type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { WORKSPACE_YML } from "./fixtures/tempRunWorkspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST",
  "FAKE_CLAUDE_ALT_MATCH", "FAKE_CLAUDE_ALT_OUTPUTS", "FAKE_CLAUDE_IS_ERROR",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
  clearSrcCaches();
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

const GATE = "01-what/alpha";

/** The note the FAKE signer writes — the same shape `test/agent-gate.test.ts` pins. */
function note(o: { verdict?: string; verdictBullets?: readonly string[] } = {}): string {
  return [
    "---",
    "version: 1",
    `gate: ${GATE}`,
    "role: agent",
    "by: fable",
    "at: 2026-08-28T22:14:03Z",
    `verdict: ${o.verdict ?? "sign"}`,
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
    ...(o.verdictBullets ?? ["- SIGN — every declared output is on disk [src: .tldrx/workspace.yml:1]"]),
    "",
  ].join("\n");
}

interface Made extends FacilitatorWorkspace {
  readonly outbox: string;
}

/** A notifier that appends every payload it is handed to one JSONL file. */
function writeNotifier(root: string): string {
  const impl = join(root, "notifier.js");
  writeFileSync(
    impl,
    [
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  require('node:fs').appendFileSync(process.argv[2], Buffer.concat(chunks).toString('utf8') + '\\n');",
      "  process.exit(0);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const path = join(root, "notifier.sh");
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(impl)} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * A run whose alpha gate carries `policy`, with the fake told to write `signerNote`
 * only on a prompt that is the signer's.
 */
function workspace(options: {
  policy: string;
  signerNote?: string | null;
  notify?: boolean;
}): Made {
  const outbox = "notified.jsonl";
  const made = makeFacilitatorWorkspace({
    scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10,
    gates: { alpha: options.policy, beta: "human" },
  });
  open.push(made);
  if (options.notify === true) {
    const script = writeNotifier(made.root);
    writeFileSync(
      join(made.root, ".tldrx", "workspace.yml"),
      `${WORKSPACE_YML}notify:\n  command: "${script} ${join(made.root, outbox)}"\n`,
      "utf8",
    );
  }
  process.env.PATH = made.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = made.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
    "01-what/intent.md": cannedIntent(),
    "01-what/handoff.md": cannedHandoff(),
    "02-how/handoff.md": cannedHandoff(),
  });
  process.env.FAKE_CLAUDE_COST = "0.42";
  // The signer turn is told apart from the stage turn by its own prompt marker.
  process.env.FAKE_CLAUDE_ALT_MATCH = GATE_SIGNER_MARKER;
  process.env.FAKE_CLAUDE_ALT_OUTPUTS = JSON.stringify(
    options.signerNote === null || options.signerNote === undefined
      ? {}
      : { ".agent/alpha/evidence.md": options.signerNote },
  );
  return { ...made, outbox: join(made.root, outbox) };
}

function auto(ws: Made, overrides: Partial<AutoOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runAuto({ root: ws.root, yolo: false, actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides });
}

function next(ws: Made, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

function events(ws: Made): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

function signerSpawns(ws: Made): readonly TldrxEvent[] {
  return events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === GATE_SIGNER_ROLE);
}

function signerResults(ws: Made): readonly TldrxEvent[] {
  return events(ws).filter((e) => e.type === "agent.result" && e.payload.role === GATE_SIGNER_ROLE);
}

function alphaGate(ws: Made) {
  return RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.gate;
}

function delivered(ws: Made): readonly Record<string, unknown>[] {
  if (!existsSync(ws.outbox)) return [];
  return readFileSync(ws.outbox, "utf8").split("\n").filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// A. the signer closes a gate the validator would have closed
// ---------------------------------------------------------------------------

describe("an `agent` gate under the engine", () => {
  test("the engine spawns a gate-signer, the note lands, and the loop walks on", async () => {
    const ws = workspace({ policy: "agent", signerNote: note() });
    const outcome = await auto(ws);

    // ONE signer turn, recorded like every other spawn.
    expect(signerSpawns(ws)).toHaveLength(1);
    expect(signerSpawns(ws)[0]?.stage).toBe("alpha");
    expect(signerResults(ws)).toHaveLength(1);

    // The note the signer wrote is on disk, and it signs.
    const path = evidencePath(ws.runDir, "alpha");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("verdict: sign");

    // The gate is closed BY THE NOTE'S `by:`, not by the loop's actor.
    expect(alphaGate(ws)?.status).toBe("approved");
    expect(alphaGate(ws)?.by).toBe("fable");
    expect(alphaGate(ws)?.evidence?.verdict).toBe("sign");

    // …and the loop kept going, to beta's HUMAN gate.
    expect(RunStore.open(ws.runDir).run.cursor.stage).toBe("beta");
    expect(outcome.code).toBe(4);
  });

  test("the committed copy is beside the gate, not only in the gitignored scratch dir", async () => {
    const ws = workspace({ policy: "agent", signerNote: note() });
    await auto(ws);
    expect(alphaGate(ws)?.evidence?.path).toBe("01-what/gate-evidence/alpha.md");
    expect(existsSync(join(ws.runDir, "01-what", "gate-evidence", "alpha.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. every way it does NOT close
// ---------------------------------------------------------------------------

describe("a signer that does not sign", () => {
  test("`refuse` holds the gate, exits 4, and the reason reaches the notification", async () => {
    const ws = workspace({
      policy: "agent",
      signerNote: note({
        verdict: "refuse",
        verdictBullets: ["- REFUSE — the Scope section names no boundary [src: 01-what/intent.md:1]"],
      }),
      notify: true,
    });
    const outcome = await auto(ws);

    expect(signerSpawns(ws)).toHaveLength(1);
    expect(alphaGate(ws)?.status).toBe("pending");
    expect(outcome.code).toBe(4);
    expect(events(ws).some((e) => e.type === "gate.approved")).toBe(false);

    const gate = delivered(ws).find((p) => p.kind === "gate.requested");
    expect(gate).toBeDefined();
    expect(String(gate?.summary)).toContain("refuse");
    const detail = gate?.detail as Record<string, unknown>;
    expect(String(JSON.stringify(detail.signer_held))).toContain("refuse");
  });

  test("a note whose Verdict bullet carries no `[src: …]` is refused, never approved", async () => {
    const ws = workspace({
      policy: "agent",
      signerNote: note({ verdictBullets: ["- SIGN — everything looks fine"] }),
    });
    const outcome = await auto(ws);

    expect(signerSpawns(ws)).toHaveLength(1);
    expect(alphaGate(ws)?.status).toBe("pending");
    expect(outcome.code).toBe(4);
    expect(events(ws).some((e) => e.type === "gate.approved")).toBe(false);
    expect(outcome.lines.join("\n")).toContain("evidence:");
  });

  test("a signer that writes nothing at all holds the gate and says the note is missing", async () => {
    const ws = workspace({ policy: "agent", signerNote: null });
    const outcome = await auto(ws);

    expect(signerSpawns(ws)).toHaveLength(1);
    expect(existsSync(evidencePath(ws.runDir, "alpha"))).toBe(false);
    expect(alphaGate(ws)?.status).toBe("pending");
    expect(outcome.code).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// C. what it never touches
// ---------------------------------------------------------------------------

describe("the gates the signer leaves alone", () => {
  test("a `human` gate spawns no signer and stops exactly as it always did", async () => {
    const ws = workspace({ policy: "human", signerNote: note() });
    const outcome = await auto(ws);

    expect(signerSpawns(ws)).toHaveLength(0);
    expect(existsSync(evidencePath(ws.runDir, "alpha"))).toBe(false);
    expect(alphaGate(ws)?.status).toBe("pending");
    expect(outcome.code).toBe(4);
  });

  test("a note already on disk is never overwritten — one signer per note, ever", async () => {
    const ws = workspace({ policy: "agent", signerNote: note() });
    await next(ws);                       // alpha runs, the signer signs
    const first = signerSpawns(ws).length;
    expect(first).toBe(1);
    await next(ws);                       // beta runs; alpha is closed
    expect(signerSpawns(ws)).toHaveLength(first);
  });
});

// ---------------------------------------------------------------------------
// D. the money
// ---------------------------------------------------------------------------

describe("the signer's turn is spend the run can see", () => {
  test("`tldrx cost` carries a row for it, at the signer's own ceiling", async () => {
    const ws = workspace({ policy: "agent", signerNote: note() });
    await auto(ws);

    const spawn = signerSpawns(ws)[0];
    // A quarter of the stage's per-agent ceiling — min(budget_usd, per_agent_max_usd).
    const stage = RunStore.open(ws.runDir).run.phases[0]?.stages[0];
    const perAgent = RunStore.open(ws.runDir).budget.per_agent_max_usd;
    const cap = Math.round(Math.min(stage?.budget_usd ?? 0, perAgent) * GATE_SIGNER_SHARE * 100) / 100;
    expect(spawn?.payload.max_budget_usd).toBe(cap);

    const report = buildRunCost(ws.runDir);
    const rows = report?.stages.flatMap((s) => s.attempts) ?? [];
    const signer = rows.filter((row) => row.usd === 0.42);
    // The stage turn and the signer turn: two attempts, both metered, both counted.
    expect(signer.length).toBeGreaterThanOrEqual(2);
    expect(report?.usd).toBeGreaterThanOrEqual(0.84);
  });
});

// ---------------------------------------------------------------------------
// E. the prompt is data in, one document out
// ---------------------------------------------------------------------------

describe("the signer's prompt", () => {
  const rendered = renderGateSignerPrompt({
    gate: GATE,
    run: "260101-x",
    notePath: ".agent/alpha/evidence.md",
    outputs: ["01-what/intent.md", "01-what/handoff.md"],
    conditions: [{ id: "outputs", ok: true, detail: "2 of 2 on disk" }],
    skeleton: "---\nversion: 1\n---\n",
  });

  test("it opens with the marker, names the gate and the one path it may write", () => {
    expect(rendered.startsWith(GATE_SIGNER_MARKER)).toBe(true);
    expect(rendered).toContain(`gate \`${GATE}\``);
    expect(rendered).toContain("`.agent/alpha/evidence.md`, and write nothing else, anywhere");
  });

  test("it carries the measured conditions, the outputs and the skeleton", () => {
    expect(rendered).toContain("`outputs` — ok: true — 2 of 2 on disk");
    expect(rendered).toContain("- `01-what/handoff.md`");
    expect(rendered).toContain("version: 1");
  });

  test("the tool allowance is read-only plus the one write", () => {
    expect([...GATE_SIGNER_TOOLS]).toEqual(["Read", "Grep", "Glob", "Bash(git diff *)", "Write"]);
    expect(GATE_SIGNER_TOOLS).not.toContain("Edit");
  });
});
