/**
 * The front page's headline: BOTH economies, how stale the run is, and what to
 * do about it.
 *
 * Issue #103 was filed off a cold adversarial audit of a real host-attended run
 * (`260830-ordering-inventory`, aparece-v2, 2026-09-02). Every ledger surface in
 * that run reconciles to a perfect 0.00 delta at **$14.60** — `events.jsonl`
 * sum, `run.yml` `spent_usd`, the stage sums, the task sums, the `budget.yml`
 * phase sums — while the run's own watch gate note says the real figure was
 * "about 81 dollars across 34 sub-agent turns". The mechanism is measured, not
 * inferred: of the run's 34 turns, **4 carried money** and **30 produced no
 * dollars at all** — 14 recorded `cost_usd: null, metered: false` and 16
 * recorded a flat `cost_usd: 0.00`. The dashboard read the $14.60 and said
 * nothing about the other 30 turns.
 *
 * So the fixture below IS that run's shape, turn for turn, and the first block
 * demands the page stop printing $14.60 alone.
 *
 * Two more model additions ride with it, both of which the redesigned hero card
 * needs and neither of which is a policy: how long since anything happened
 * (`lastEventAt` + `ageSeconds`), and who is waited on right now
 * (`nextAction`, promoted out of `waiting.ts` rather than re-derived).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel, type DashboardModel, type RunModel } from "../src/core/dashboard/model.ts";
import { dashEconomies, dashRunView } from "../src/core/dashboard/render.ts";
import { WAITING_KINDS } from "../src/core/run/waiting.ts";

const RUN_ID = "260902-ordering-inventory";
const READ_AT = "2026-09-02T15:00:00Z";
const NOW = new Date("2026-09-02T15:00:00Z");
const NOW_MS = NOW.getTime();

/** Tags stripped: these tests are about the WORDS, not the markup around them. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/**
 * One `run.yml` task, in the two spellings the facilitator actually writes.
 *
 * `cost === null` is the host turn nobody costed: `cost_usd: null` plus
 * `metered: false` (`runNext.commitStage`). A number is what the executor
 * recorded — including a flat `0.00`, which is the spelling 16 of this run's
 * turns wear and which the model must not read as thrift.
 */
function task(id: string, cost: number | null, tokens?: number): string {
  const money = cost === null ? "cost_usd: null, metered: false" : `cost_usd: ${cost.toFixed(2)}`;
  const tok = tokens === undefined ? "" : `, tokens: ${tokens}`;
  return `{id: ${id}, status: done, expert: developer, model: sonnet, ${money}${tok}, error: null}`;
}

function stage(phase: string, id: string, status: string, gate: string, tasks: readonly string[]): string {
  return `  - id: ${phase}
    status: ${status === "awaiting_gate" ? "awaiting_gate" : "done"}
    stages:
      - {id: ${id}, status: ${status}, expert: developer, model: sonnet, budget_usd: 30.0, cost_usd: 0.0,
         started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: ${gate}, by: null, at: null, note: ""},
         tasks: [${tasks.join(",\n                 ")}]}`;
}

/**
 * The build stage of the real run: 30 turns, 29 of which produced no dollars.
 *
 * The interleave is the shipped one — a developer turn recorded `cost_usd: 0.00`
 * and a reviewer turn recorded `cost_usd: null, metered: false`, alternating,
 * because the host session drove both and only the second spelling admits it.
 */
function buildTurns(): readonly string[] {
  const turns: string[] = [];
  for (let index = 1; index <= 29; index++) {
    turns.push(task(`t${index}`, index % 2 === 0 ? null : 0));
  }
  turns.push(task("t30", 1.3, 138586));
  return turns;
}

const AUDITED_RUN = `version: 1
run: ${RUN_ID}
title: "Check/Order aggregates and idempotent creation"
scope: feature
workflow: feature
repos: [aparece]
created_at: 2026-09-01T00:44:28Z
updated_at: 2026-09-02T14:14:00Z
status: awaiting_gate
attended_by: host
cursor: {phase: 05-watch, stage: watch, task: null}
budget: {ceiling_usd: 62.0, spent_usd: 14.60, per_agent_max_usd: 18.0}
phases:
${stage("01-what", "what", "done", "approved", [task("t1", 2.1)])}
${stage("02-how", "how", "done", "approved", [task("t1", 8, 380416)])}
${stage("03-plan", "plan", "done", "approved", [task("t1", 3.2, 401639)])}
${stage("04-build", "build", "done", "approved", buildTurns())}
${stage("05-watch", "watch", "awaiting_gate", "pending", [task("t1", 0)])}
`;

const AUDITED_BUDGET = `version: 1
run: ${RUN_ID}
ceiling_usd: 62.0
per_agent_max_usd: 18.0
warn_at_pct: 80
on_exceed: block
phases: [{id: "01-what", ceiling_usd: 8.0, spent_usd: 2.10},
         {id: "02-how", ceiling_usd: 12.0, spent_usd: 8.00},
         {id: "03-plan", ceiling_usd: 8.0, spent_usd: 3.20},
         {id: "04-build", ceiling_usd: 30.0, spent_usd: 1.30},
         {id: "05-watch", ceiling_usd: 4.0, spent_usd: 0.00}]
`;

interface Fixture {
  readonly runYaml?: string;
  readonly budget?: string;
  /** Written verbatim; omit for no `events.jsonl` at all. */
  readonly events?: string;
  /** Applied to `events.jsonl` after it is written, for the mtime fallback. */
  readonly eventsMtime?: Date;
}

function workspace(fixture: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-headline-"));
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  const runDir = join(root, "tldrx-work", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.yml"), fixture.runYaml ?? AUDITED_RUN);
  if (fixture.budget !== undefined) writeFileSync(join(runDir, "budget.yml"), fixture.budget);
  if (fixture.events !== undefined) {
    const path = join(runDir, "events.jsonl");
    writeFileSync(path, fixture.events);
    if (fixture.eventsMtime !== undefined) utimesSync(path, fixture.eventsMtime, fixture.eventsMtime);
  }
  return root;
}

function modelOf(fixture: Fixture = {}): { model: DashboardModel; run: RunModel } {
  const model = buildModel(workspace(fixture), READ_AT, { now: NOW });
  const run = model.runs[0];
  if (run === undefined) throw new Error("fixture produced no run");
  return { model, run };
}

function event(type: string, ts: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts, run: RUN_ID, stage: null, type, actor: "facilitator", cost_usd: 0, payload: {}, ...over,
  });
}

// ---------------------------------------------------------------------------
// 1 · #103 — the headline shows BOTH economies, or says why it cannot
// ---------------------------------------------------------------------------

describe("the audited run: $14.60 metered, 30 turns nobody costed", () => {
  test("the metered figure is unchanged, and it is what four turns cost", () => {
    const { run } = modelOf({ budget: AUDITED_BUDGET });
    expect(run.spentUsd).toBe(14.6);
    expect(run.spend.meteredUsd).toBe(14.6);
    expect(run.spend.totalTasks).toBe(34);
  });

  test("it counts the turns the dollars never saw — in BOTH spellings", () => {
    const { run } = modelOf({ budget: AUDITED_BUDGET });
    // The spelling the model already had: `cost_usd: null, metered: false`.
    expect(run.spend.unmeteredTasks).toBe(14);
    expect(run.unmeteredTasks).toBe(14);
    // The spelling it did NOT have, and the one #103 is about: a flat `0.00`
    // recorded by a turn a host session paid for.
    expect(run.spend.zeroCostTasks).toBe(16);
    expect(run.spend.costlessTasks).toBe(30);
  });

  test("nothing declared what those 30 turns cost, so the host side is ABSENT, not zero", () => {
    const { run } = modelOf({ budget: AUDITED_BUDGET });
    expect(run.spend.silentTasks).toBe(30);
    expect(run.spend.costlessTokens).toBe(0);
    expect(run.spend.basis).toBe("absent");
    expect(run.spend.reason).toContain("30 of 34");
  });

  test("the tokens that WERE declared sit on metered turns, and are not the host side", () => {
    const { run } = modelOf({ budget: AUDITED_BUDGET });
    // 380416 + 401639 + 138586. Every one of the three is on a turn that also
    // carried dollars, so none of them describes the 30 turns that did not.
    expect(run.spend.hostTokens).toBe(920641);
    expect(run.hostTokens).toBe(920641);
    expect(run.spend.costlessTokens).toBe(0);
  });

  test("the rendered headline no longer reads $14.60 alone", () => {
    const { model, run } = modelOf({ budget: AUDITED_BUDGET });
    const detail = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(detail).toContain("$14.60");
    // The point of the issue: the number is on the page WITH what it is missing.
    expect(detail).toContain("30 of 34");
    expect(text(dashEconomies(run))).toContain("30 of 34");
  });
});

describe("the four bases, because a host figure is rarely all-or-nothing", () => {
  /** Every costless turn declared its tokens: complete, in the other currency. */
  test("`declared` when every costless turn said what it burned", () => {
    const runYaml = `version: 1
run: ${RUN_ID}
title: "A host run that declared its tokens"
scope: feature
workflow: feature
repos: [aparece]
status: awaiting_gate
attended_by: host
cursor: {phase: 01-what, stage: what, task: null}
budget: {ceiling_usd: 25.0, spent_usd: 2.40, per_agent_max_usd: 3.0}
phases:
${stage("01-what", "what", "awaiting_gate", "pending", [
      task("t1", 2.4), task("t2", null, 9000), task("t3", 0, 4000),
    ])}
`;
    const { run } = modelOf({ runYaml });
    expect(run.spend.costlessTasks).toBe(2);
    expect(run.spend.silentTasks).toBe(0);
    expect(run.spend.costlessTokens).toBe(13000);
    expect(run.spend.basis).toBe("declared");
  });

  test("`partial` when some declared and some did not", () => {
    const runYaml = AUDITED_RUN.replace(task("t2", null), task("t2", null, 50000));
    const { run } = modelOf({ runYaml });
    expect(run.spend.costlessTokens).toBe(50000);
    expect(run.spend.silentTasks).toBe(29);
    expect(run.spend.basis).toBe("partial");
    expect(run.spend.reason).toContain("LOWER BOUND");
  });

  test("`measured` when every turn carried a dollar figure — and the page stays silent", () => {
    const runYaml = `version: 1
run: ${RUN_ID}
title: "An ordinary metered run"
scope: feature
workflow: feature
repos: [aparece]
status: awaiting_gate
cursor: {phase: 01-what, stage: what, task: null}
budget: {ceiling_usd: 25.0, spent_usd: 2.40, per_agent_max_usd: 3.0}
phases:
${stage("01-what", "what", "awaiting_gate", "pending", [task("t1", 2.4)])}
`;
    const { run } = modelOf({ runYaml });
    expect(run.spend.costlessTasks).toBe(0);
    expect(run.spend.basis).toBe("measured");
    // The promise #85 made and this keeps: a run that reads correctly today
    // gains no line.
    expect(dashEconomies(run)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2 · Staleness — when did anything last happen, and how long ago
// ---------------------------------------------------------------------------

describe("how long since anything happened", () => {
  test("the last line of the ledger, and the age against `now`", () => {
    const { run } = modelOf({
      events: [
        event("run.created", "2026-09-01T00:44:28Z"),
        event("stage.done", "2026-09-02T14:00:00Z"),
      ].join("\n") + "\n",
    });
    expect(run.lastEventAt).toBe("2026-09-02T14:00:00Z");
    expect(run.lastEventFrom).toBe("event");
    expect(run.ageSeconds).toBe(3600);
  });

  test("an events.jsonl with nothing readable falls back to its MTIME, and says so", () => {
    const mtime = new Date("2026-09-02T13:00:00Z");
    const { run } = modelOf({ events: "not json at all\n", eventsMtime: mtime });
    expect(run.lastEventFrom).toBe("mtime");
    expect(run.lastEventAt).toBe("2026-09-02T13:00:00Z");
    expect(run.ageSeconds).toBe(7200);
  });

  test("no ledger at all is `none` and null — never a guess from run.yml", () => {
    const { run } = modelOf({});
    expect(run.lastEventFrom).toBe("none");
    expect(run.lastEventAt).toBeNull();
    expect(run.ageSeconds).toBeNull();
    // `updatedAt` is run.yml's own claim and stays exactly what it was.
    expect(run.updatedAt).toBe("2026-09-02T14:14:00Z");
  });

  test("the age is not clamped: a ledger written after `now` reports a negative age", () => {
    const { run } = modelOf({ events: `${event("stage.done", "2026-09-02T16:00:00Z")}\n` });
    expect(run.ageSeconds).toBe(-3600);
  });
});

// ---------------------------------------------------------------------------
// 3 · Next action — promoted out of `waiting.ts`, not re-derived
// ---------------------------------------------------------------------------

describe("who is waited on now, where, and what closes it", () => {
  test("a gate names the person, the stage and the command", () => {
    const { run } = modelOf({});
    expect(run.nextAction.kind).toBe("gate");
    expect(run.nextAction.waitingOn).toBe("person");
    expect(run.nextAction.phase).toBe("05-watch");
    expect(run.nextAction.stage).toBe("watch");
    expect(run.nextAction.command).toBe("tldrx approve");
    expect(run.nextAction.alternatives).toEqual(['tldrx reject --note "…"']);
  });

  test("the sentence is `waiting.message` VERBATIM — never a second wording", () => {
    const { run } = modelOf({});
    expect(run.nextAction.message).toBe(run.waiting.message);
    expect(run.nextAction.kind).toBe(run.waiting.kind);
  });

  test("a finished run waits on nobody, at nowhere, with no command", () => {
    const runYaml = AUDITED_RUN
      .replace("status: awaiting_gate\nattended_by: host", "status: done\nattended_by: host")
      .replace(
        stage("05-watch", "watch", "awaiting_gate", "pending", [task("t1", 0)]),
        stage("05-watch", "watch", "done", "approved", [task("t1", 0)]),
      );
    const { run } = modelOf({ runYaml });
    expect(run.nextAction.kind).toBe("done");
    expect(run.nextAction.waitingOn).toBe("nobody");
    expect(run.nextAction.phase).toBeNull();
    expect(run.nextAction.stage).toBeNull();
    expect(run.nextAction.command).toBeNull();
    expect(run.nextAction.alternatives).toEqual([]);
  });

  test("a run.yml with no cursor is `unknown`, because nothing can say who fixes it", () => {
    const runYaml = `version: 1
run: ${RUN_ID}
title: "No cursor"
scope: feature
workflow: feature
repos: [aparece]
status: running
budget: {ceiling_usd: 25.0, spent_usd: 0.0, per_agent_max_usd: 3.0}
phases: []
`;
    const { run } = modelOf({ runYaml });
    expect(run.nextAction.kind).toBe("blocked");
    expect(run.nextAction.waitingOn).toBe("unknown");
    expect(run.nextAction.command).toBeNull();
  });

  test("every waiting kind maps to a `waitingOn` the renderer can enumerate", () => {
    // The list is asserted against WAITING_KINDS so a TENTH kind fails here
    // rather than falling through to a blank hero card.
    expect([...WAITING_KINDS].sort()).toEqual([
      "answer", "blocked", "cancelled", "done", "failed", "gate", "prepared", "ready", "running",
    ]);
  });
});
