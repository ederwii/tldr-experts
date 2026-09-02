/**
 * The dashboard's vocabulary against the framework's CURRENT one.
 *
 * The page shipped in 0.2.0 and the framework kept moving: `prepared` and
 * `running` joined the waiting kinds, `agent` joined the gate policies and
 * brought signed evidence with it, `attended_by` split the economy in two,
 * `build.branch_model` chose a branch layout, and a revoked upstream gate
 * started marking stages `stale`. Every one of those is a word `run.yml` or
 * `waiting.ts` says today.
 *
 * A page that drops a word the files use does not look wrong — it looks
 * finished, which is worse. So these tests are written from the FILE's
 * vocabulary inward: build a run.yml carrying the thing, then demand the page
 * say it. They are the audit, kept.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../src/core/dashboard/model.ts";
import {
  dashFaqView, dashPathSection, dashPending, dashPlanSection, dashRunView, dashWaitingCell,
} from "../src/core/dashboard/render.ts";
import type { RunModel } from "../src/core/dashboard/model.ts";

const READ_AT = "2026-09-03T08:00:00Z";
const NOW_MS = Date.parse("2026-09-03T09:00:00Z");

/** One workspace, one run.yml, nothing else — the model reads files, so write files. */
function workspaceWith(id: string, runYaml: string): { root: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tldrx-vocab-"));
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  const runDir = join(root, "tldrx-work", id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.yml"), runYaml);
  return { root, runDir };
}

/**
 * The `--prepare` bundle, exactly where `hasPreparedBundle` looks for it
 * (`src/core/run/prepared.ts`): `.agent/<stage>/pending.json`. Its PRESENCE is
 * the state — nothing reads what is inside it to answer this question.
 */
function prepareBundle(runDir: string, stage: string): void {
  mkdirSync(join(runDir, ".agent", stage), { recursive: true });
  writeFileSync(join(runDir, ".agent", stage, "pending.json"), "{}");
}

function onlyRun(root: string): RunModel {
  const model = buildModel(root, READ_AT);
  const run = model.runs[0];
  if (run === undefined) throw new Error("fixture produced no run");
  return run;
}

/** Tags stripped: these tests are about the WORDS, not the markup around them. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

const PREPARED_RUN = `version: 1
run: 260901-prepared
title: "A bundle is waiting"
scope: feature
workflow: feature
repos: [api]
created_at: 2026-09-01T09:00:00Z
updated_at: 2026-09-01T14:20:00Z
status: running
attended_by: host
cursor: {phase: 02-how, stage: how, task: null}
budget: {ceiling_usd: 25.0, spent_usd: 0.0, per_agent_max_usd: 3.0}
phases:
  - id: 02-how
    status: running
    stages:
      - {id: how, status: running, expert: architect, model: sonnet, budget_usd: 3.0, cost_usd: 0.0,
         started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: pending, by: null, at: null, note: ""},
         tasks: [{id: t1, status: running, expert: architect, model: sonnet,
                  cost_usd: null, metered: false, error: null}]}
`;

describe("the waiting kinds the page has to know", () => {
  test("a --prepare bundle waiting on a host is not `nothing`", () => {
    const { root, runDir } = workspaceWith("260901-prepared", PREPARED_RUN);
    prepareBundle(runDir, "how");
    const run = onlyRun(root);

    // The model already knows. It is the CELL that loses it.
    expect(run.waiting.kind).toBe("prepared");
    const cell = text(dashWaitingCell(run));
    expect(cell).not.toContain("nothing");
    expect(cell).toContain("--commit");
  });

  test("it raises a card, because it is a run waiting on a person", () => {
    const { root, runDir } = workspaceWith("260901-prepared", PREPARED_RUN);
    prepareBundle(runDir, "how");
    const run = onlyRun(root);
    // `isMovable` already counts `prepared`, so this run can wear `← next`. A row
    // that is offered as the next move and alerts on nothing contradicts itself.
    expect(run.runnable).toBe(true);
    const pending = dashPending(run);
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("prepared");
  });

  test("a stage somebody else is running says so, with the message the CLI prints", () => {
    const { root, runDir } = workspaceWith("260901-prepared", PREPARED_RUN);
    // A live lock, held by this very process: `waitingFor` reads `.lock` and
    // `isAlive(pid)`, and our own pid is the one pid guaranteed to be alive.
    writeFileSync(join(runDir, ".lock"), JSON.stringify({ pid: process.pid, host: "test", at: READ_AT }));
    const run = onlyRun(root);
    expect(run.waiting.kind).toBe("running");
    const cell = text(dashWaitingCell(run));
    expect(cell).not.toContain("nothing");
    expect(cell).toContain("running");
  });
});

const AGENT_GATE_RUN = `version: 1
run: 260902-agentgate
title: "Signed by an agent"
scope: feature
workflow: feature
repos: [api]
created_at: 2026-09-01T09:00:00Z
updated_at: 2026-09-02T14:20:00Z
status: awaiting_gate
cursor: {phase: 03-plan, stage: plan, task: null}
budget: {ceiling_usd: 25.0, spent_usd: 5.0, per_agent_max_usd: 3.0}
gates_policy: {what: auto, how: agent, plan: human}
build: {epic_branch: [epic/scoreboard, epic/leaderboard], branch_model: integration}
phases:
  - id: 02-how
    status: done
    stages:
      - {id: what, status: done, expert: product, model: sonnet, budget_usd: 1.0, cost_usd: 1.0,
         started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: auto, status: approved, by: auto, at: null, note: ""}, tasks: []}
      - {id: how, status: done, expert: architect, model: sonnet, budget_usd: 3.0, cost_usd: 2.0,
         started_at: null, ended_at: null, inputs: [], outputs: [], stale: true,
         gate: {type: approve, status: approved, by: reviewer-agent, at: 2026-09-02T10:00:00Z,
                note: "spot-checked",
                evidence: {path: "02-how/gate-evidence/how.md", role: reviewer, verdict: pass,
                           sampled: 6, of: 20, resolved: 5, refuted: 1, outside_surface: 0}},
         tasks: []}
  - id: 03-plan
    status: awaiting_gate
    stages:
      - {id: plan, status: awaiting_gate, expert: architect, model: sonnet, budget_usd: 3.0,
         cost_usd: 3.0, started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: pending, by: null, at: null, note: ""}, tasks: []}
`;

describe("the `agent` gate policy, and what it signs over", () => {
  test("an agent gate is counted as an agent gate, not as a human one", () => {
    const { root } = workspaceWith("260902-agentgate", AGENT_GATE_RUN);
    const run = onlyRun(root);
    // `renderGates` in run/runStatus.ts counts all three. The page counted two,
    // so every `agent` stage inflated the number of gates that stop for a person
    // — the one number this eyebrow exists to give.
    const eyebrow = text(dashPathSection(run));
    expect(eyebrow).toContain("1 human");
    expect(eyebrow).toContain("1 auto");
    expect(eyebrow).toContain("1 agent");
  });

  test("the evidence an agent signed over reaches the page", () => {
    const { root } = workspaceWith("260902-agentgate", AGENT_GATE_RUN);
    const run = onlyRun(root);
    const how = run.path.filter((stage) => stage.id === "how")[0];
    expect(how?.gateEvidence).not.toBeNull();
    expect(how?.gateEvidence?.verdict).toBe("pass");
    expect(how?.gateEvidence?.sampled).toBe(6);

    // A signature nobody can audit from the page is the gap: say the verdict, the
    // sample, and where the committed note is.
    const rendered = text(dashPathSection(run));
    expect(rendered).toContain("pass");
    expect(rendered).toContain("6 of 20");
    expect(rendered).toContain("02-how/gate-evidence/how.md");
  });

  test("a stage left stale by a revoked upstream gate is marked as stale", () => {
    const { root } = workspaceWith("260902-agentgate", AGENT_GATE_RUN);
    const run = onlyRun(root);
    const how = run.path.filter((stage) => stage.id === "how")[0];
    expect(how?.stale).toBe(true);
    // Its outputs are still on disk and still read as current. `run status` says
    // so; the page drew a `done` row and nothing else.
    expect(text(dashPathSection(run))).toContain("stale");
  });
});

describe("the two economies", () => {
  test("a host-attended run says who drives it", () => {
    const { root } = workspaceWith("260901-prepared", PREPARED_RUN);
    const model = buildModel(root, READ_AT);
    const run = model.runs[0];
    if (run === undefined) throw new Error("fixture produced no run");
    expect(run.attendedBy).toBe("host");
    // The exact words `tldrx run status` prints, so the two screens agree.
    expect(text(dashRunView(model, run.id, NOW_MS))).toContain("attended: host");
  });

  test("`$0.00 spent` on a run with unmetered turns is a lower bound, and says so", () => {
    const { root } = workspaceWith("260901-prepared", PREPARED_RUN);
    const model = buildModel(root, READ_AT);
    const run = model.runs[0];
    if (run === undefined) throw new Error("fixture produced no run");
    // One task with `cost_usd: null` — an in-session turn nobody declared.
    expect(run.unmeteredTasks).toBe(1);
    expect(run.spentUsd).toBe(0);
    const rendered = text(dashRunView(model, run.id, NOW_MS));
    expect(rendered).toContain("1 unmetered");
    expect(rendered).toContain("LOWER BOUND");
  });
});

describe("the branch model the Build actually executed", () => {
  test("the epic branches and the branch model appear under Plan & build", () => {
    const { root } = workspaceWith("260902-agentgate", AGENT_GATE_RUN);
    const run = onlyRun(root);
    expect(run.build?.branchModel).toBe("integration");
    expect(run.build?.epicBranches).toEqual(["epic/scoreboard", "epic/leaderboard"]);
    const rendered = text(dashPlanSection(run, 2));
    expect(rendered).toContain("integration");
    expect(rendered).toContain("epic/scoreboard");
  });
});

describe("what the page claims it read", () => {
  /**
   * This test used to demand the OPPOSITE sentence, and was right to: until #85
   * `buildModel` opened neither the ledger nor `budget.yml`, and the page claimed
   * both as sources anyway, so a reader who trusted it could not tell an empty
   * ledger from an unread one. The claim is what is under test, not the answer —
   * #85 changed the code, so the sentence had to move with it.
   */
  test("the files it names are the files it opens", () => {
    const { root } = workspaceWith("260902-agentgate", AGENT_GATE_RUN);
    const model = buildModel(root, READ_AT);
    const rendered = text(dashFaqView(model));
    expect(rendered).toContain("events.jsonl");
    expect(rendered).toContain("budget.yml");
    // And it no longer disclaims the file it now reads.
    expect(rendered).not.toContain("does not read");
    // What it takes FROM the ledger is named, and so is what is still only in
    // `replay` — a page that reads a file is not a page that shows all of it.
    expect(rendered).toContain("operator notes");
    expect(rendered).toContain("tldrx replay");
  });
});
