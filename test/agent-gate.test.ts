/**
 * Wave 2C — `gates_policy: agent` (design §A).
 *
 * The third answer to "who closes a gate", and the tests are about the one
 * property that makes it worth having: an agent gate is **strictly stronger**
 * than an auto gate, never a cheaper one. All seven auto conditions still have to
 * hold, no budget decision may have landed in the stage's window, AND a
 * structured evidence note has to sign. Take any one of those away and the gate
 * falls to a person with the reason named.
 *
 * The four automatic fallthroughs design §A.2 lists are each tested in ISOLATION,
 * because "which of these stopped it" is the first question anybody asks and a
 * test that fired three at once would not answer it.
 *
 * Everything real is real: a real run, real files, a real `git diff` for the
 * boundary case. Only the sub-agent is faked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { approve } from "../src/core/run/gates.ts";
import { approveCommand } from "../src/cli/commands/approve.ts";
import { evaluateAgentGate, budgetEventsInWindow } from "../src/core/run/agentGate.ts";
import {
  GatePolicyError, gatePolicyFor, parseGatesFlag, parseWorkflowGates, GATE_POLICIES,
} from "../src/core/run/gatePolicy.ts";
import { validateRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { emitRunYaml } from "../src/core/run/emitRunYaml.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { renderStatus, buildStatus } from "../src/core/run/runStatus.ts";
import { loadRun } from "../src/core/replay/loadRun.ts";
import { renderReplay } from "../src/core/replay/renderReplay.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import { evidencePath } from "../src/core/facilitator/paths.ts";
import { toSrcContext, loadWorkspace } from "../src/hooks/lib/workspace.ts";
import { clearSrcCaches } from "../src/core/text/srcToken.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST",
  "FAKE_BUILD_WRITE", "FAKE_BUILD_STATE",
] as const;

let open: FacilitatorWorkspace[] = [];
let builds: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  for (const ws of builds) ws.dispose();
  open = [];
  builds = [];
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
const ALPHA_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});

const GATE = "01-what/alpha";

function workspace(
  gates: Readonly<Record<string, string>> = { alpha: "agent", beta: "human" },
): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10, gates });
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
    actor: "alan", at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

// --- the note ---------------------------------------------------------------

interface NoteOverrides {
  readonly verdict?: string;
  readonly gate?: string;
  readonly by?: string;
  /** Replace the `Verdict` section's bullets — the easy way to break one. */
  readonly verdictBullets?: readonly string[];
}

function note(o: NoteOverrides = {}): string {
  return [
    "---",
    "version: 1",
    `gate: ${o.gate ?? GATE}`,
    "role: agent",
    `by: ${o.by ?? "fable"}`,
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
    `# Gate evidence — ${o.gate ?? GATE}`,
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

function writeNote(runDir: string, stage: string, text: string): string {
  const path = evidencePath(runDir, stage);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

function capture(): () => { out: string; err: string } {
  const outOriginal = process.stdout.write.bind(process.stdout);
  const errOriginal = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  return () => {
    process.stdout.write = outOriginal;
    process.stderr.write = errOriginal;
    return { out, err };
  };
}

function stageOf(runDir: string) {
  return RunStore.open(runDir).run.phases[0]?.stages[0];
}

// ---------------------------------------------------------------------------
// A. `agent` is a third policy value, and an absent one still means `human`
// ---------------------------------------------------------------------------

describe("agent as a gates_policy value", () => {
  test("the enum is exactly the three, in this order", () => {
    expect([...GATE_POLICIES]).toEqual(["human", "auto", "agent"]);
  });

  test("a workflow file may name it", () => {
    expect(parseWorkflowGates({ plan: "agent" }, ["plan"], "f.yml")).toEqual({ plan: "agent" });
  });

  test("a workflow value outside the three is still refused", () => {
    expect(() => parseWorkflowGates({ plan: "sometimes" }, ["plan"], "f.yml")).toThrow(GatePolicyError);
  });

  test("`--gates plan:agent` — the qualified form", () => {
    expect(parseGatesFlag("plan:agent", ["what", "plan", "build"]))
      .toEqual({ what: "auto", plan: "agent", build: "auto" });
  });

  test("a bare entry still means human, so every existing invocation is unchanged", () => {
    expect(parseGatesFlag("what,build", ["what", "plan", "build"]))
      .toEqual({ what: "human", plan: "auto", build: "human" });
  });

  test("bare and qualified entries mix", () => {
    expect(parseGatesFlag("what,plan:agent", ["what", "plan", "build"]))
      .toEqual({ what: "human", plan: "agent", build: "auto" });
  });

  test("`plan:human` is legal and means what a bare `plan` means", () => {
    expect(parseGatesFlag("plan:human", ["what", "plan"])).toEqual(parseGatesFlag("plan", ["what", "plan"]));
  });

  test("an unknown POLICY is a usage error naming the three", () => {
    expect(() => parseGatesFlag("plan:sometimes", ["plan"]))
      .toThrow(/not one of human \| auto \| agent/);
  });

  test("an unknown STAGE is still a usage error, qualified or not", () => {
    expect(() => parseGatesFlag("nosuch:agent", ["plan"])).toThrow(/nosuch is not a stage/);
  });

  test("`all` and `none` are untouched", () => {
    expect(parseGatesFlag("all", ["a", "b"])).toEqual({ a: "human", b: "human" });
    expect(parseGatesFlag("none", ["a", "b"])).toEqual({ a: "auto", b: "auto" });
  });

  test("an absent policy still reads as human — adding a third value changed no default", () => {
    expect(gatePolicyFor(undefined, "anything")).toBe("human");
    expect(gatePolicyFor({ other: "agent" }, "anything")).toBe("human");
  });

  test("no shipped scope uses it — `agent` arrives by choice, never by default", () => {
    for (const scope of ["feature", "bugfix", "docs", "hotfix", "migration"]) {
      expect(Object.values(loadWorkflowPreset(join(import.meta.dir, ".."), scope).gates)).not.toContain("agent");
    }
  });

  test("it persists into run.yml and survives a save", () => {
    const ws = workspace();
    expect(RunStore.open(ws.runDir).run.gates_policy).toEqual({ alpha: "agent", beta: "human" });
    expect(readFileSync(join(ws.runDir, "run.yml"), "utf8")).toContain("gates_policy: {alpha: agent, beta: human}");
    const store = RunStore.open(ws.runDir);
    store.save();
    expect(RunStore.open(ws.runDir).run.gates_policy).toEqual({ alpha: "agent", beta: "human" });
  });

  test("`run status` counts agent gates apart from human ones", () => {
    const ws = workspace();
    const store = RunStore.open(ws.runDir);
    const lines = renderStatus(buildStatus(store.run, store.budget, store.runDir));
    expect(lines).toContain("1 human, 0 auto, 1 agent");
  });
});

// ---------------------------------------------------------------------------
// B. run.yml's `gate.evidence` — additive, and it round-trips
// ---------------------------------------------------------------------------

describe("gate.evidence in run.yml", () => {
  const EVIDENCE = {
    path: "01-what/gate-evidence/alpha.md",
    role: "agent",
    verdict: "sign",
    sampled: 7, of: 34, resolved: 7, refuted: 0, outside_surface: 0,
  } as const;

  function withEvidence(run: RunFile): RunFile {
    return {
      ...run,
      phases: run.phases.map((phase, i) => i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage, j) => j !== 0 ? stage : {
          ...stage,
          gate: { ...stage.gate, status: "approved" as const, by: "fable", at: "2026-08-28T10:00:00Z", evidence: EVIDENCE },
        }),
      }),
    };
  }

  test("the emitter writes it — a sixth key held in memory and not emitted would be DROPPED", () => {
    const ws = workspace();
    const emitted = emitRunYaml(withEvidence(RunStore.open(ws.runDir).run));
    expect(emitted).toContain(
      'evidence: {path: "01-what/gate-evidence/alpha.md", role: agent, verdict: sign, '
      + "sampled: 7, of: 34, resolved: 7, refuted: 0, outside_surface: 0}",
    );
  });

  test("it round-trips: emit, parse, emit again, byte for byte", () => {
    const ws = workspace();
    const once = emitRunYaml(withEvidence(RunStore.open(ws.runDir).run));
    const parsed = parseYaml(once);
    expect(validateRunFile(parsed).ok).toBe(true);
    expect(emitRunYaml(parsed as RunFile)).toBe(once);
  });

  test("a gate WITHOUT evidence emits no key at all — every existing run.yml is unchanged", () => {
    const ws = workspace();
    const emitted = emitRunYaml(RunStore.open(ws.runDir).run);
    expect(emitted).not.toContain("evidence");
    expect(emitted).toBe(readFileSync(join(ws.runDir, "run.yml"), "utf8"));
  });

  test("an old-shaped gate (five keys, no evidence) still validates and still loads", () => {
    const ws = workspace();
    const raw = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    expect(raw).toContain('gate: {type: approve, status: pending, by: null, at: null, note: ""}');
    expect(validateRunFile(parseYaml(raw)).ok).toBe(true);
  });

  test("a half-written evidence block fails validation rather than being half-read", () => {
    const ws = workspace();
    const raw = emitRunYaml(withEvidence(RunStore.open(ws.runDir).run))
      .replace("role: agent, ", "");
    const validation = validateRunFile(parseYaml(raw));
    expect(validation.ok).toBe(false);
    expect(validation.issues[0]?.message).toContain("missing required key `role`");
  });

  test("a role or verdict outside the evidence enums is refused", () => {
    const ws = workspace();
    const raw = emitRunYaml(withEvidence(RunStore.open(ws.runDir).run)).replace("role: agent", "role: human");
    const validation = validateRunFile(parseYaml(raw));
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((i) => i.path)).toContain("phases[0].stages[0].gate.evidence.role");
  });
});

// ---------------------------------------------------------------------------
// C. the gate itself, end to end through `tldrx next`
// ---------------------------------------------------------------------------

describe("an agent gate that closes", () => {
  test("all seven conditions + a note that signs ⇒ approved, recorded as the AGENT", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());

    const outcome = await next(ws);

    expect(outcome.code).toBe(0);
    const said = outcome.lines.join("\n");
    expect(said).toContain("· agent-approved by fable");
    expect(said).toContain("agent-gate: checks=claim-sources:passed");
    expect(said).toContain("evidence=sign by fable, read 2 file(s), sampled 2 of 4 citation(s)");

    const stage = stageOf(ws.runDir);
    expect(stage?.status).toBe("done");
    expect(stage?.gate.status).toBe("approved");
    expect(stage?.gate.by).toBe("fable");
    expect(stage?.gate.evidence).toEqual({
      path: "01-what/gate-evidence/alpha.md",
      role: "agent", verdict: "sign",
      sampled: 2, of: 4, resolved: 2, refuted: 0, outside_surface: 0,
    });
    // and the cursor moved, exactly as it does for a human or an auto gate
    expect(RunStore.open(ws.runDir).run.cursor).toMatchObject({ phase: "02-how", stage: "beta" });
  });

  test("the note is COPIED into the run tree, where a clone can audit it", async () => {
    const ws = workspace();
    const scratch = writeNote(ws.runDir, "alpha", note());
    await next(ws);

    const committed = join(ws.runDir, "01-what", "gate-evidence", "alpha.md");
    expect(existsSync(committed)).toBe(true);
    expect(readFileSync(committed, "utf8")).toBe(note());
    // a copy, not a move: the scratch original is still where the agent left it
    expect(existsSync(scratch)).toBe(true);
  });

  test("it goes through the SAME door — gate.requested, gate.approved, stage.done", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);

    const events = EventLog.forRun(ws.runDir).read();
    const approved = events.find((e) => e.type === "gate.approved");
    expect(events.map((e) => e.type)).toContain("gate.requested");
    expect(approved?.actor).toBe("fable");
    expect(approved?.payload).toMatchObject({ by: "fable", role: "agent", evidence: "01-what/gate-evidence/alpha.md" });
  });
});

describe("the four fallthroughs, one at a time", () => {
  test("1 — an open question: the gate falls to a person, named as `questions`", async () => {
    const ws = makeFacilitatorWorkspace({
      scope: "demo", budgetUsd: 10, gates: { alpha: "agent", beta: "human" },
      stages: [
        {
          ...ALPHA,
          outputs: [
            ...(ALPHA.outputs ?? []),
            { path: "01-what/questions.md" },
          ],
        },
        BETA,
      ],
    });
    open.push(ws);
    process.env.PATH = ws.binDir;
    process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
    process.env.FAKE_CLAUDE_OUTPUTS = JSON.stringify({
      "01-what/intent.md": cannedIntent(),
      "01-what/handoff.md": cannedHandoff(),
      "01-what/questions.md": [
        "# Questions",
        "",
        "## Q1 · Which tenant model?",
        "<!-- id: Q1 | status: open | area: domain | asked_by: alpha | asked_at: 2026-08-29T09:00:00Z -->",
        "Why asked: no tenant column [src: absent:.tldrx/memory/notes.md]",
        "",
        "- A) one per customer",
        "- B) one shared",
        "",
        "[Answer]:",
        "",
      ].join("\n"),
    });
    writeNote(ws.runDir, "alpha", note());

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("agent gate not taken");
    expect(said).toContain("questions: questions=1 open (Q1)");
    expect(stageOf(ws.runDir)?.gate.status).toBe("pending");
    expect(stageOf(ws.runDir)?.gate.evidence).toBeUndefined();
  });

  test("2 — a budget event in the window, even with spend under the ceiling", async () => {
    const ws = workspace();
    // No note yet, so the first pass stops and leaves the gate open to re-judge.
    expect((await next(ws)).code).toBe(4);
    writeNote(ws.runDir, "alpha", note());

    const store = RunStore.open(ws.runDir);
    const stage = store.run.phases[0]?.stages[0];
    if (stage === undefined) throw new Error("no stage");
    const planned = loadWorkflowPreset(ws.root, store.run.scope).stages.find((s) => s.id === "alpha");
    if (planned === undefined) throw new Error("no planned stage");
    const input = {
      root: ws.root, runDir: store.runDir, phaseId: "01-what",
      stage, planned, budget: store.budget, checks: [],
      gate: GATE, evidencePath: evidencePath(store.runDir, "alpha"),
      srcCtx: toSrcContext(loadWorkspace(ws.root), store.runDir),
    };
    const real = EventLog.forRun(ws.runDir).read();

    // Without the event it closes: spend IS under the ceiling.
    const clean = await evaluateAgentGate({ ...input, events: real });
    expect(clean.ok).toBe(true);

    const raised: TldrxEvent = {
      ts: "2026-08-29T09:30:00Z", run: store.runId, stage: null, type: "budget.raised",
      actor: "alan", cost_usd: 0, payload: { phase: "01-what", amount_usd: 2 },
    };
    const withRaise = await evaluateAgentGate({ ...input, events: [...real, raised] });

    expect(withRaise.ok).toBe(false);
    expect(withRaise.fallthroughs.map((f) => f.trigger)).toEqual(["budget-event"]);
    expect(withRaise.why).toContain("budget.raised at 2026-08-29T09:30:00Z");
    // the reason, not just the fact
    expect(withRaise.why).toContain("is not a ceiling the machine that was blocked may then sign off against");
  });

  test("3 — a boundary: work nobody scoped, against a real epic branch", async () => {
    const made = makeBuildWorkspace({
      stories: [{ id: "S1", epic: "E1", title: "Inside the surface", touches: ["src/in.ts"] }],
      epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
      waves: [["S1"]],
      gates: "build:agent",
      repoFiles: { "src/in.ts": "export const before = 1;\n" },
    } satisfies BuildWorkspaceOptions);
    builds.push(made);
    process.env.PATH = made.binDir;
    process.env.FAKE_BUILD_STATE = made.statePath;
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      S1: { "src/in.ts": "export const after = 2;\n", "platform/Auth.cs": "// nobody scoped this\n" },
    });
    writeNote(made.runDir, "build", [
      "---",
      "version: 1",
      "gate: 04-build/build",
      "role: agent",
      "by: fable",
      "at: 2026-08-29T09:00:00Z",
      "verdict: sign",
      'read: ["03-plan/stories/S1.md"]',
      "citations: {sampled: 1, of: 1, resolved: 1, refuted: 0}",
      "touches: {audited: 1, outside_surface: 0, new_areas: []}",
      "diff_vs_stories: matches",
      "caveats: []",
      "recommend: []",
      "---",
      "",
      "# Gate evidence — 04-build/build",
      "",
      "## Read",
      "- the one story [src: .tldrx/workspace.yml:1]",
      "",
      "## Citations checked",
      "- 1 of 1, resolved [src: .tldrx/workspace.yml:1]",
      "",
      "## Touches audited",
      "- one path, declared [src: .tldrx/workspace.yml:1]",
      "",
      "## Verdict",
      "- SIGN [src: .tldrx/workspace.yml:1]",
      "",
    ].join("\n"));

    const outcome = await next(made);

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("agent gate not taken");
    // named as its OWN trigger, with the offending path spelled out
    expect(said).toContain("boundary: boundary=");
    expect(said).toContain("1 outside the surface: app:platform/Auth.cs");
    expect(RunStore.open(made.runDir).run.phases.flatMap((p) => p.stages)[0]?.gate.status).toBe("pending");
  }, 60_000);

  test("4 — the note refuses: `verdict: refuse` is the agent doing its job", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note({ verdict: "refuse" }));

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("refusal: verdict is `refuse`, not `sign` — this gate falls to a human, by design");
    expect(said).not.toContain("evidence: the evidence note has");
    expect(stageOf(ws.runDir)?.gate.status).toBe("pending");
  });

  test("4b — `sign-with-fixlist` falls to a person too, for the same reason", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note({ verdict: "sign-with-fixlist" }));

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("refusal: verdict is `sign-with-fixlist`");
  });
});

describe("a note that is missing or broken", () => {
  test("no note at all ⇒ exit 4, and the command that writes the form is named", async () => {
    const ws = workspace();
    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("evidence: no evidence note at");
    expect(said).toContain("tldrx gate template");
    expect(stageOf(ws.runDir)?.gate.status).toBe("pending");
  });

  test("an unsourced bullet ⇒ exit 4 named as `evidence`, not as a refusal", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note({ verdictBullets: ["- SIGN, trust me"] }));

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    const said = outcome.lines.join("\n");
    expect(said).toContain("evidence: the evidence note has 1 problem(s)");
    expect(said).toContain("no `[src: …]` token");
    expect(said).not.toContain("refusal:");
  });

  test("a note pasted from another gate is caught", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note({ gate: "03-plan/plan" }));

    const outcome = await next(ws);

    expect(outcome.code).toBe(4);
    expect(outcome.lines.join("\n")).toContain("is not the stage at the cursor (01-what/alpha)");
  });
});

// ---------------------------------------------------------------------------
// D. `approve --as-agent`
// ---------------------------------------------------------------------------

describe("approve --as-agent", () => {
  /** A run parked at an open agent gate, with the note the test wants on disk. */
  async function parked(text: string | null): Promise<FacilitatorWorkspace> {
    const ws = workspace();
    const outcome = await next(ws);
    expect(outcome.code).toBe(4);
    if (text !== null) writeNote(ws.runDir, "alpha", text);
    return ws;
  }

  test("it signs, records the agent as the actor, and copies the note", async () => {
    const ws = await parked(note());
    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root, "--as-agent"]);
    const said = printed();

    expect(exit).toBe(0);
    expect(said.out).toContain("signed by fable (agent) — evidence → 01-what/gate-evidence/alpha.md");
    const stage = stageOf(ws.runDir);
    expect(stage?.gate.by).toBe("fable");
    expect(stage?.gate.evidence?.verdict).toBe("sign");
    expect(readFileSync(join(ws.runDir, "01-what", "gate-evidence", "alpha.md"), "utf8")).toBe(note());
    // the cursor moved: it is the same door, not a special case beside it
    expect(RunStore.open(ws.runDir).run.cursor).toMatchObject({ phase: "02-how", stage: "beta" });
  });

  test("a plain `approve` on the same run is still recorded as the PERSON who ran it", async () => {
    const ws = await parked(note());
    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root]);
    printed();

    expect(exit).toBe(0);
    expect(stageOf(ws.runDir)?.gate.by).not.toBe("fable");
    expect(stageOf(ws.runDir)?.gate.evidence).toBeUndefined();
  });

  test("a broken note is exit 2, and NOTHING is signed", async () => {
    const ws = await parked(note({ verdictBullets: ["- SIGN, trust me"] }));
    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root, "--as-agent"]);
    const said = printed();

    expect(exit).toBe(2);
    expect(said.err).toContain("is not a valid evidence note");
    expect(said.err).toContain("Nothing was signed.");
    expect(stageOf(ws.runDir)?.gate.status).toBe("pending");
  });

  test("a refusing note is exit 4 — a different thing from a broken one", async () => {
    const ws = await parked(note({ verdict: "refuse" }));
    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root, "--as-agent"]);
    const said = printed();

    expect(exit).toBe(4);
    expect(said.err).toContain("falls to a person — the evidence note does not sign");
    expect(said.err).toContain("`tldrx approve` as yourself");
    expect(stageOf(ws.runDir)?.gate.status).toBe("pending");
  });

  test("a missing note is refused rather than treated as consent", async () => {
    const ws = await parked(null);
    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root, "--as-agent"]);
    const said = printed();

    expect(exit).toBe(2);
    expect(said.err).toContain("no evidence note at");
    expect(stageOf(ws.runDir)?.gate.status).toBe("pending");
  });

  test("--as-agent on a non-agent gate is exit 1: a frozen policy is not decorative", async () => {
    const ws = workspace({ alpha: "human", beta: "human" });
    expect((await next(ws)).code).toBe(4);
    writeNote(ws.runDir, "alpha", note());

    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root, "--as-agent"]);
    const said = printed();

    expect(exit).toBe(1);
    expect(said.err).toContain("is a `human` gate, not an `agent` one");
    expect(said.err).toContain("--gates alpha:agent");
    expect(stageOf(ws.runDir)?.gate.status).toBe("pending");
  });

  test("--evidence reads the note from somewhere else", async () => {
    const ws = await parked(null);
    const elsewhere = join(ws.runDir, "elsewhere.md");
    writeFileSync(elsewhere, note(), "utf8");

    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root, "--as-agent", "--evidence", elsewhere]);
    printed();

    expect(exit).toBe(0);
    expect(stageOf(ws.runDir)?.gate.by).toBe("fable");
  });

  test("--evidence without --as-agent is a usage error", async () => {
    const ws = await parked(note());
    const printed = capture();
    const exit = await approveCommand.run(["--root", ws.root, "--evidence", "somewhere.md"]);
    const said = printed();

    expect(exit).toBe(1);
    expect(said.err).toContain("--evidence only means something with --as-agent");
  });

  test("a PERSON may still approve an agent gate — it is an override, recorded as a person", async () => {
    const ws = await parked(note({ verdict: "refuse" }));
    const signed = await approve(RunStore.open(ws.runDir), {
      root: ws.root, actor: "alan", at: "2026-08-29T10:05:00Z",
      note: "shipping over the fix list on purpose",
    });

    expect(signed.ok).toBe(true);
    const stage = stageOf(ws.runDir);
    expect(stage?.gate.status).toBe("approved");
    expect(stage?.gate.by).toBe("alan");
    // no evidence key: a person signed, and the run.yml says so with an absence
    expect(stage?.gate.evidence).toBeUndefined();
    expect(signed.evidencePath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E. what `replay` shows
// ---------------------------------------------------------------------------

describe("replay renders who checked what", () => {
  test("one block per agent-signed gate, from the front matter and run.yml", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);

    const loaded = loadRun(ws.root, ws.runId);
    if (loaded === null) throw new Error("no run");
    const rendered = renderReplay(loaded);

    expect(rendered).toContain(
      "- 01-what/alpha SIGN by fable (agent) — read 2 files, spot-checked 2 of 4 citations (2 resolved),",
    );
    expect(rendered).toContain(
      "  audited 3 touched paths (0 outside the surface), diff vs stories: n-a",
    );
    expect(rendered).toContain("  → 01-what/gate-evidence/alpha.md");
  });

  test("a gate with no evidence adds nothing at all", async () => {
    const ws = workspace({ alpha: "auto", beta: "human" });
    await next(ws);

    const loaded = loadRun(ws.root, ws.runId);
    if (loaded === null) throw new Error("no run");
    expect(renderReplay(loaded)).not.toContain("(agent)");
  });

  test("a note that has gone missing is SAID to be missing, not invented", async () => {
    const ws = workspace();
    writeNote(ws.runDir, "alpha", note());
    await next(ws);
    // somebody deleted the committed copy
    writeFileSync(join(ws.runDir, "01-what", "gate-evidence", "alpha.md"), "", "utf8");
    const emptied = loadRun(ws.root, ws.runId);
    if (emptied === null) throw new Error("no run");
    const rendered = renderReplay(emptied);

    expect(rendered).toContain("the note it was signed over is missing");
    // and the counts run.yml recorded still stand
    expect(rendered).toContain("spot-checked 2 of 4 citations (2 resolved)");
  });
});

// ---------------------------------------------------------------------------
// F. the budget window, measured
// ---------------------------------------------------------------------------

describe("budgetEventsInWindow", () => {
  const at = (ts: string, type: TldrxEvent["type"]): TldrxEvent =>
    ({ ts, run: "260830-x", stage: null, type, actor: "alan", cost_usd: 0, payload: {} });

  test("it takes both kinds — a raise is run-level, a block is stage-level", () => {
    const events = [at("2026-08-30T10:00:00Z", "budget.raised"), at("2026-08-30T11:00:00Z", "budget.blocked")];
    expect(budgetEventsInWindow(events, "2026-08-30T09:00:00Z")).toHaveLength(2);
  });

  test("an event BEFORE the stage started is not this stage's decision", () => {
    const events = [at("2026-08-30T08:00:00Z", "budget.raised")];
    expect(budgetEventsInWindow(events, "2026-08-30T09:00:00Z")).toHaveLength(0);
  });

  test("`budget.warned` is not a decision anybody made", () => {
    const events = [at("2026-08-30T10:00:00Z", "budget.warned")];
    expect(budgetEventsInWindow(events, "2026-08-30T09:00:00Z")).toHaveLength(0);
  });

  test("a stage with no started_at reads the WHOLE run — it may only refuse more often", () => {
    const events = [at("2026-08-30T08:00:00Z", "budget.raised")];
    expect(budgetEventsInWindow(events, null)).toHaveLength(1);
  });
});
