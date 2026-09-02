/**
 * The two files the dashboard model may now read: `budget.yml` and `events.jsonl`.
 *
 * Issue #85 was filed by the dashboard auditor and its five open questions share
 * one root: `buildModel()` read `run.yml`, the phase artefacts, the Plan artefacts
 * and the expert files, and nothing else. Everything that lives ONLY in the ledger
 * — operator notes, free review retries, attempt counts, `budget.blocked`, story
 * reopens — was therefore absent from the page, and everything that lives only in
 * `budget.yml` — the host-token ceiling, `on_host_tokens_exceed`, the per-phase
 * economy — was absent too. The owner's decision (2026-09-02) is that the model
 * may read both, read-only and additive.
 *
 * These tests are written the way `dashboard-vocabulary.test.ts` is: build a
 * workspace carrying the thing, render it, and demand the page say it. The last
 * block is the other half of the promise — a workspace with NEITHER file must
 * render exactly as it did before, because most workspaces on disk are that one.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel, type RunModel, type DashboardModel } from "../src/core/dashboard/model.ts";
import {
  dashBudgetMeter, dashBudgetSection, dashEconomies, dashNotesSection, dashPlanSection,
  dashRunRow, dashRunView, dashSpendText, dashStoryArcs,
} from "../src/core/dashboard/render.ts";
import { MAX_ATTEMPTS } from "../src/core/budget/remainingWork.ts";
import { raiseCommand, shortBy } from "../src/core/budget/budgetView.ts";
import { DEFAULT_ECONOMY, DEFAULT_ON_HOST_TOKENS_EXCEED } from "../src/core/budget/RunBudget.ts";

const READ_AT = "2026-09-03T08:00:00Z";
const NOW_MS = Date.parse("2026-09-03T09:00:00Z");
const RUN_ID = "260903-ledger";

/** Tags stripped: these tests are about the WORDS, not the markup around them. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

const RUN_YML = `version: 1
run: ${RUN_ID}
title: "The ledger has more than run.yml"
scope: feature
workflow: feature
repos: [lab]
created_at: 2026-09-03T09:00:00Z
updated_at: 2026-09-03T14:20:00Z
status: running
attended_by: host
cursor: {phase: 04-build, stage: build, task: null}
budget: {ceiling_usd: 25.0, spent_usd: 0.0, per_agent_max_usd: 3.0}
phases:
  - id: 03-plan
    status: done
    stages:
      - {id: plan, status: done, expert: architect, model: sonnet, budget_usd: 4.0, cost_usd: 0.0,
         started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: approved, by: alan, at: null, note: ""},
         tasks: []}
  - id: 04-build
    status: running
    stages:
      - {id: build, status: running, expert: developer, model: sonnet, budget_usd: 12.0, cost_usd: 0.0,
         started_at: null, ended_at: null, inputs: [], outputs: [],
         gate: {type: approve, status: pending, by: null, at: null, note: ""},
         tasks: [{id: t1, status: running, expert: developer, model: sonnet,
                  cost_usd: null, metered: false, tokens: 12000, error: null}]}
`;

/** A budget.yml priced in HOST TOKENS — the shape the dollar meter cannot describe. */
const HOST_TOKEN_BUDGET = `version: 1
run: ${RUN_ID}
ceiling_usd: 25.0
per_agent_max_usd: 3.0
warn_at_pct: 80
on_exceed: block
economy: host-tokens
on_host_tokens_exceed: block
ceiling_host_tokens: 200000
phases: [{id: 03-plan, ceiling_usd: 4.0, spent_usd: 0.0},
         {id: 04-build, ceiling_usd: 12.0, spent_usd: 0.0,
          economy: host-tokens, ceiling_host_tokens: 150000}]
`;

/** Dollars, but with a token allowance declared: an ordinary run that burned some. */
const MIXED_BUDGET = `version: 1
run: ${RUN_ID}
ceiling_usd: 25.0
per_agent_max_usd: 3.0
warn_at_pct: 80
on_exceed: block
ceiling_host_tokens: 200000
phases: [{id: 03-plan, ceiling_usd: 4.0, spent_usd: 1.5},
         {id: 04-build, ceiling_usd: 12.0, spent_usd: 3.25}]
`;

/** The ordinary one: dollars, no token ceiling, no economy key at all. */
const USD_BUDGET = `version: 1
run: ${RUN_ID}
ceiling_usd: 25.0
per_agent_max_usd: 3.0
warn_at_pct: 80
on_exceed: block
phases: [{id: 03-plan, ceiling_usd: 4.0, spent_usd: 1.5},
         {id: 04-build, ceiling_usd: 12.0, spent_usd: 3.25}]
`;

function event(type: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: "2026-09-03T12:00:00Z",
    run: RUN_ID,
    stage: null,
    type,
    actor: "facilitator",
    cost_usd: 0,
    payload,
    ...over,
  });
}

function story(id: string, epic = "E1", status = "in_progress"): string {
  return [
    "---", "version: 1", `id: ${id}`, `epic: ${epic}`, `title: "Story ${id}"`,
    "repo: lab", `status: ${status}`, "depends_on: []", 'touches: ["src/"]',
    'acceptance: ["it works"]', 'test_plan: ["unit"]', "evidence: []", "---", "",
    `# ${id}`, "", "```dod", "npm run test", "```", "",
  ].join("\n");
}

function epicFile(id: string, stories: readonly string[]): string {
  return [
    "---", "version: 1", `id: ${id}`, `title: "Epic ${id}"`, "repos: [lab]",
    `stories: [${stories.join(", ")}]`, "branch: epic/ledger", "status: todo", "---", "", `# ${id}`, "",
  ].join("\n");
}

interface Fixture {
  readonly budget?: string;
  readonly events?: readonly string[];
  /** Written verbatim, for the torn-line case. */
  readonly rawEvents?: string;
  readonly plan?: boolean;
}

function workspace(fixture: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-sources-"));
  mkdirSync(join(root, ".tldrx"), { recursive: true });
  const runDir = join(root, "tldrx-work", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.yml"), RUN_YML);
  if (fixture.budget !== undefined) writeFileSync(join(runDir, "budget.yml"), fixture.budget);
  if (fixture.rawEvents !== undefined) writeFileSync(join(runDir, "events.jsonl"), fixture.rawEvents);
  else if (fixture.events !== undefined) writeFileSync(join(runDir, "events.jsonl"), `${fixture.events.join("\n")}\n`);
  if (fixture.plan === true) {
    const plan = join(runDir, "03-plan");
    mkdirSync(join(plan, "stories"), { recursive: true });
    mkdirSync(join(plan, "epics"), { recursive: true });
    writeFileSync(join(plan, "stories", "S1.md"), story("S1"));
    // Not `done`: the story schema refuses a done story with no evidence, and a
    // story that does not validate is dropped from the plan entirely.
    writeFileSync(join(plan, "stories", "S2.md"), story("S2", "E1", "blocked"));
    writeFileSync(join(plan, "epics", "E1.md"), epicFile("E1", ["S1", "S2"]));
  }
  return root;
}

function modelOf(fixture: Fixture = {}): { model: DashboardModel; run: RunModel } {
  const model = buildModel(workspace(fixture), READ_AT);
  const run = model.runs[0];
  if (run === undefined) throw new Error("fixture produced no run");
  return { model, run };
}

// ---------------------------------------------------------------------------
// 1 · Operator notes (`tldrx note`, #46)
// ---------------------------------------------------------------------------

describe("operator notes reach the page", () => {
  const NOTES = [
    event("operator_note", { note: "resynced eight dod blocks by hand" },
      { ts: "2026-09-03T10:00:00Z", actor: "alan", stage: null }),
    event("operator_note", { note: "reran the migration on the branch", phase: "04-build" },
      { ts: "2026-09-03T11:30:00Z", actor: "will", stage: "build" }),
  ];

  test("the model carries every note, with who wrote it and where", () => {
    const { run } = modelOf({ events: NOTES });
    expect(run.notes).toHaveLength(2);
    expect(run.notes[0]?.actor).toBe("alan");
    expect(run.notes[0]?.note).toBe("resynced eight dod blocks by hand");
    expect(run.notes[0]?.stage).toBeNull();
    expect(run.notes[0]?.ts).toBe("2026-09-03T10:00:00Z");
    expect(run.notes[1]?.actor).toBe("will");
    expect(run.notes[1]?.stage).toBe("build");
    expect(run.notes[1]?.phase).toBe("04-build");
  });

  test("the run detail prints them — all of them, because the page has room", () => {
    const { model, run } = modelOf({ events: NOTES });
    const rendered = text(dashNotesSection(run));
    expect(rendered).toContain("resynced eight dod blocks by hand");
    expect(rendered).toContain("reran the migration on the branch");
    expect(rendered).toContain("alan");
    expect(rendered).toContain("will");
    expect(text(dashRunView(model, RUN_ID, NOW_MS))).toContain("resynced eight dod blocks by hand");
  });

  test("a run nobody annotated draws no notes section at all", () => {
    const { run } = modelOf({ events: [event("run.created", { scope: "feature" })] });
    expect(run.notes).toEqual([]);
    expect(dashNotesSection(run)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2 · Free review retries (#78/#79) and attempts per story
// ---------------------------------------------------------------------------

describe("a story's attempts and its FREE review retries", () => {
  const ARC = [
    event("task.started", { phase: "04-build", story: "S1", attempt: 1 }, { stage: "build" }),
    event("story.review_retried", {
      phase: "04-build", story: "S1", attempt: 1, retry: 1, max_retries: 2,
      detail: "finding 2: `[src: …]` did not parse",
    }, { stage: "build", actor: "reviewer" }),
    event("story.review_retried", {
      phase: "04-build", story: "S1", attempt: 1, retry: 2, max_retries: 2,
      detail: "finding 1: missing `disposition`",
    }, { stage: "build", actor: "reviewer" }),
    event("task.started", { phase: "04-build", story: "S1", attempt: 2 }, { stage: "build" }),
  ];

  test("the framework's attempt bound reaches the renderer through the model", () => {
    // The render functions are serialised into the page closure-free, so a
    // constant they need has to travel as data — the same reason `maxLevel` does.
    const { model } = modelOf({ events: ARC, plan: true });
    expect(model.maxAttempts).toBe(MAX_ATTEMPTS);
  });

  test("the model counts the attempt the story is on and the retries it did not spend", () => {
    const { run } = modelOf({ events: ARC, plan: true });
    const s1 = run.plan?.stories.find((item) => item.id === "S1");
    expect(s1?.attempt).toBe(2);
    expect(s1?.reviewRetries).toBe(2);
    // A story with no task.started has begun nothing: null, never a coerced 0.
    const s2 = run.plan?.stories.find((item) => item.id === "S2");
    expect(s2?.attempt).toBeNull();
    expect(s2?.reviewRetries).toBe(0);
  });

  test("the plan table shows the attempt against the bound, and the free retries", () => {
    const { model, run } = modelOf({ events: ARC, plan: true });
    const rendered = text(dashPlanSection(run, model.maxAttempts));
    expect(rendered).toContain("2 of 2");
    expect(rendered).toContain("2 free review");
  });
});

// ---------------------------------------------------------------------------
// 3 · `budget.blocked` — the brake, on the record
// ---------------------------------------------------------------------------

describe("`budget.blocked` occurrences are shown", () => {
  const BLOCKS = [
    event("budget.blocked", {
      phase: "04-build", remaining_usd: 1.2, estimate_usd: 4.5,
      estimate_basis: "plan", ceiling_usd: 12.0,
    }, { ts: "2026-09-03T12:10:00Z", stage: "build" }),
    event("budget.blocked", {
      phase: "04-build", economy: "host-tokens", host_tokens: 210000, ceiling_tokens: 150000,
      reason: "declared host tokens are over the phase ceiling",
    }, { ts: "2026-09-03T13:10:00Z", stage: "build" }),
  ];

  test("the model carries each refusal, in both economies", () => {
    const { run } = modelOf({ events: BLOCKS });
    expect(run.budgetBlocks).toHaveLength(2);
    const [dollars, tokens] = run.budgetBlocks;
    expect(dollars?.phase).toBe("04-build");
    expect(dollars?.economy).toBe("metered-usd");
    expect(dollars?.remainingUsd).toBe(1.2);
    expect(dollars?.estimateUsd).toBe(4.5);
    expect(tokens?.economy).toBe("host-tokens");
    expect(tokens?.hostTokens).toBe(210000);
    expect(tokens?.ceilingTokens).toBe(150000);
    expect(tokens?.reason).toContain("over the phase ceiling");
  });

  test("the run detail says the brake fired, and names the phase", () => {
    const { model } = modelOf({ events: BLOCKS });
    const rendered = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(rendered).toContain("budget.blocked");
    expect(rendered).toContain("04-build");
    expect(rendered).toContain("tldrx budget raise");
  });

  /**
   * The renderer is serialised into the page closure-free, so it cannot import
   * `raiseCommand` and builds the string itself. That is a drift seam, and this
   * is the pin: the page's command must be the one the CLI would print, short-by
   * rounding included. A raise a cent under the estimate is refused a second
   * time — the pilot failure `shortBy` exists to end.
   */
  test("the command it offers is the one `raiseCommand` builds, to the cent", () => {
    const { model } = modelOf({ events: BLOCKS });
    const rendered = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(rendered).toContain(raiseCommand(RUN_ID, "04-build", shortBy(4.5, 1.2)));
  });

  test("a host-token refusal offers no dollar raise, because none would help", () => {
    const tokensOnly = [BLOCKS[1] ?? ""];
    const { model } = modelOf({ events: tokensOnly });
    const rendered = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(rendered).not.toContain("tldrx budget raise");
    expect(rendered).toContain("ceiling_host_tokens");
  });

  test("a run the brake never stopped says nothing about it", () => {
    const { run } = modelOf({ events: [event("budget.warned", { phase: "04-build" })] });
    expect(run.budgetBlocks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4 · Host ceilings and economies from budget.yml (#22, #61)
// ---------------------------------------------------------------------------

describe("the ceiling host tokens are judged against", () => {
  test("the model reads the run-level economy, the token ceiling and its policy", () => {
    const { run } = modelOf({ budget: HOST_TOKEN_BUDGET });
    expect(run.budget?.economy).toBe("host-tokens");
    expect(run.budget?.ceilingHostTokens).toBe(200000);
    expect(run.budget?.onHostTokensExceed).toBe("block");
    expect(run.budget?.onExceed).toBe("block");
    expect(run.budget?.warnAtPct).toBe(80);
  });

  test("it reads the PER-PHASE economy and ceiling, which override the run's", () => {
    const { run } = modelOf({ budget: HOST_TOKEN_BUDGET });
    const build = run.budget?.phases.find((phase) => phase.id === "04-build");
    expect(build?.economy).toBe("host-tokens");
    expect(build?.ceilingHostTokens).toBe(150000);
    const plan = run.budget?.phases.find((phase) => phase.id === "03-plan");
    // Null is "inherit", not "metered-usd": nobody wrote a choice on this phase.
    expect(plan?.economy).toBeNull();
    expect(plan?.ceilingHostTokens).toBeNull();
  });

  test("a budget.yml with no economy key means what it always meant", () => {
    const { run } = modelOf({ budget: USD_BUDGET });
    expect(run.budget?.economy).toBe(DEFAULT_ECONOMY);
    expect(run.budget?.onHostTokensExceed).toBe(DEFAULT_ON_HOST_TOKENS_EXCEED);
    expect(run.budget?.ceilingHostTokens).toBeNull();
  });

  test("the budget panel shows the per-phase ceilings the dollar meter never could", () => {
    const { run } = modelOf({ budget: HOST_TOKEN_BUDGET });
    const rendered = text(dashBudgetSection(run));
    expect(rendered).toContain("200000");
    expect(rendered).toContain("150000");
    expect(rendered).toContain("host-tokens");
    expect(rendered).toContain("on_host_tokens_exceed");
  });

  /**
   * The dishonesty issue #85 §4 names, closed. `spent_usd` is 0 on this run
   * because every turn is host-billed; the ceiling is not denominated in dollars
   * at all. Drawing `$0.00 of $25.00` as a progress bar states a fraction of a
   * number that does not govern anything here.
   */
  test("a host-tokens run gets a TOKEN meter, and no dollar progress bar", () => {
    const { run } = modelOf({ budget: HOST_TOKEN_BUDGET });
    const meter = dashBudgetMeter(run, true);
    expect(meter).not.toContain("meter__fill");
    expect(meter).toContain("meter__tok");
    expect(text(meter)).toContain("Not dollars");
  });

  /**
   * Suppressing the BAR alone would leave the words `$0.00 of $25.00` making the
   * same claim the bar was — so the numbers move to the currency in force, on
   * both screens, out of one function.
   */
  test("the spend readout is in tokens, on the run detail AND in the runs list", () => {
    const { model, run } = modelOf({ budget: HOST_TOKEN_BUDGET });
    const readout = text(dashSpendText(run));
    expect(readout).toContain("12000");
    expect(readout).toContain("200000");
    expect(readout).not.toContain("$25.00");
    const row = text(dashRunRow(run, NOW_MS, false));
    expect(row).not.toContain("$25.00");
    expect(row).toContain("200000");
    expect(text(dashRunView(model, RUN_ID, NOW_MS))).not.toContain("$0.00 of $25.00");
  });

  test("an ordinary dollar run keeps exactly the readout and meter it has today", () => {
    const { run } = modelOf({ budget: USD_BUDGET });
    expect(dashBudgetMeter(run, true)).toContain("meter__fill");
    expect(text(dashSpendText(run))).toContain("$25.00");
    expect(text(dashRunRow(run, NOW_MS, false))).toContain("$25.00");
  });

  test("a run with no budget.yml at all keeps the dollar readout", () => {
    const { run } = modelOf();
    expect(text(dashSpendText(run))).toContain("$25.00");
    expect(dashBudgetMeter(run, false)).toContain("meter__fill");
  });

  /**
   * A run priced in dollars can still burn host tokens — a `--commit --tokens`
   * turn on an ordinary run. There the dollar bar is the meter and the tokens
   * are the aside, so this is where the allowance has to appear.
   */
  test("on a DOLLAR run the aside names the allowance, not just the tokens spent", () => {
    const { run } = modelOf({ budget: MIXED_BUDGET });
    const rendered = text(dashEconomies(run));
    expect(rendered).toContain("12000");
    expect(rendered).toContain("200000");
  });

  test("on a host-tokens run the tokens are stated once, not twice", () => {
    const { run } = modelOf({ budget: HOST_TOKEN_BUDGET });
    // `dashSpendText` owns the number there, so the aside carries only the half
    // it does not: the turns whose cost nobody declared.
    const aside = text(dashEconomies(run));
    expect(aside).not.toContain("12000");
    expect(aside).toContain("unmetered");
    // And the readout states the spend exactly once.
    expect(text(dashSpendText(run)).split("12000")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5 · Story fix rounds and reopen reasons (#58)
// ---------------------------------------------------------------------------

describe("story reopens carry their reason to the page", () => {
  const REOPENS = [
    event("story.reopened", {
      phase: "04-build", story: "S1", wave: "W1", from_status: "blocked", to_status: "todo",
      verdicts: 2, reason: "attempts", note: "the reviewer was wrong about the migration",
    }, { ts: "2026-09-03T12:40:00Z", actor: "alan" }),
    event("story.reopened", {
      phase: "04-build", story: "S2", wave: "W1", from_status: "done", to_status: "todo",
      verdicts: 0, reason: "fix", note: "the empty-state copy is still lorem ipsum",
    }, { ts: "2026-09-03T13:40:00Z", actor: "alan" }),
  ];

  test("the model records each reopen against its story, with reason and note", () => {
    const { run } = modelOf({ events: REOPENS, plan: true });
    const s1 = run.plan?.stories.find((item) => item.id === "S1");
    expect(s1?.reopens).toHaveLength(1);
    expect(s1?.reopens[0]?.reason).toBe("attempts");
    expect(s1?.reopens[0]?.actor).toBe("alan");
    expect(s1?.reopens[0]?.verdicts).toBe(2);
    expect(s1?.reopens[0]?.fromStatus).toBe("blocked");
    const s2 = run.plan?.stories.find((item) => item.id === "S2");
    expect(s2?.reopens[0]?.reason).toBe("fix");
    expect(s2?.reopens[0]?.note).toContain("lorem ipsum");
  });

  test("a reopen written before `reason` existed is an `attempts` reopen, not a blank", () => {
    const legacy = [event("story.reopened", {
      phase: "04-build", story: "S1", from_status: "blocked", verdicts: 2, note: "another go",
    }, { actor: "alan" })];
    const { run } = modelOf({ events: legacy, plan: true });
    expect(run.plan?.stories.find((item) => item.id === "S1")?.reopens[0]?.reason).toBe("attempts");
  });

  test("the page shows the fix round and the defect it was opened for", () => {
    const { model, run } = modelOf({ events: REOPENS, plan: true });
    const rendered = text(dashStoryArcs(run, model.maxAttempts));
    expect(rendered).toContain("fix");
    expect(rendered).toContain("lorem ipsum");
    expect(rendered).toContain("the reviewer was wrong about the migration");
  });

  test("a plan nobody reopened draws nothing", () => {
    const { model, run } = modelOf({ plan: true });
    expect(dashStoryArcs(run, model.maxAttempts)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Absence and damage: the promise to every workspace already on disk
// ---------------------------------------------------------------------------

describe("a workspace with neither file renders exactly as it did before", () => {
  test("no budget.yml and no events.jsonl is silence, not an error", () => {
    const { model, run } = modelOf();
    expect(run.budget).toBeNull();
    expect(run.notes).toEqual([]);
    expect(run.budgetBlocks).toEqual([]);
    expect(run.eventsError).toBeNull();
    expect(run.eventsSkipped).toBe(0);
    // And the page still draws, with none of the new sections in it.
    const rendered = text(dashRunView(model, RUN_ID, NOW_MS));
    expect(rendered).toContain("The ledger has more than run.yml");
    expect(dashNotesSection(run)).toBe("");
    expect(dashBudgetSection(run)).toBe("");
  });

  test("a budget.yml that does not parse costs the budget panel and nothing else", () => {
    const { model, run } = modelOf({ budget: ":\n  not: [valid\n" });
    expect(run.budget).toBeNull();
    expect(dashBudgetSection(run)).toBe("");
    expect(text(dashRunView(model, RUN_ID, NOW_MS))).toContain("The ledger has more than run.yml");
  });

  /**
   * Found by `dashboard-server.test.ts` while building this, and worth its own
   * pin. `TldrxEvent.payload` is typed non-optional, so `payload.story` looks
   * safe — and a line with no `payload` key at all parses fine through the
   * tolerant `EventLog.readAll`, threw a TypeError straight out of `buildModel`,
   * and killed the live server for the whole workspace.
   */
  test("an event with no payload at all is skipped, not a crash", () => {
    const bare = JSON.stringify({
      ts: "2026-09-03T10:00:00Z", run: RUN_ID, stage: null,
      type: "stage.started", actor: "facilitator", cost_usd: 0,
    });
    const note = event("operator_note", { note: "after the bare line" }, { actor: "alan" });
    const { model, run } = modelOf({ rawEvents: `${bare}\n${note}\n` });
    expect(run.notes).toHaveLength(1);
    expect(run.notes[0]?.note).toBe("after the bare line");
    expect(text(dashRunView(model, RUN_ID, NOW_MS))).toContain("after the bare line");
  });

  test("a torn last line costs that line, not the notes before it — and is SAID", () => {
    const good = event("operator_note", { note: "this one is whole" }, { actor: "alan" });
    const { model, run } = modelOf({ rawEvents: `${good}\n{"ts":"2026-09-03T14:00:00Z","run` });
    expect(run.notes).toHaveLength(1);
    expect(run.notes[0]?.note).toBe("this one is whole");
    expect(run.eventsSkipped).toBe(1);
    // A dropped line that the page does not mention is a page lying by omission.
    expect(text(dashRunView(model, RUN_ID, NOW_MS))).toContain("1 line");
  });
});

// ---------------------------------------------------------------------------
// The other half of `dashboard.test.ts`'s field-name contract
// ---------------------------------------------------------------------------

describe("the field names a designer targets", () => {
  /** The same walk `dashboard.test.ts` uses — an empty array contributes no path. */
  function fieldPaths(value: unknown, prefix = ""): readonly string[] {
    if (Array.isArray(value)) {
      return [...new Set(value.flatMap((item) => fieldPaths(item, `${prefix}[]`)))];
    }
    if (typeof value !== "object" || value === null) return [prefix];
    const out: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(...fieldPaths(child, prefix === "" ? key : `${prefix}.${key}`));
    }
    return [...new Set(out)];
  }

  test("the ledger-only arrays appear, over a fixture that actually carries them", () => {
    const { model } = modelOf({
      budget: HOST_TOKEN_BUDGET,
      plan: true,
      events: [
        event("operator_note", { note: "n" }, { actor: "alan" }),
        event("budget.blocked", { phase: "04-build", remaining_usd: 1, estimate_usd: 2 }),
        event("story.reopened", { story: "S1", reason: "fix", note: "d" }, { actor: "alan" }),
        event("story.review_retried", { story: "S1", detail: "x" }, { actor: "reviewer" }),
        event("task.started", { story: "S1", attempt: 1 }, { stage: "build" }),
      ],
    });
    const paths = new Set(fieldPaths(model));
    for (const field of [
      "maxAttempts",
      "runs[].notes[].ts", "runs[].notes[].actor", "runs[].notes[].stage",
      "runs[].notes[].phase", "runs[].notes[].note",
      "runs[].budgetBlocks[].ts", "runs[].budgetBlocks[].phase", "runs[].budgetBlocks[].economy",
      "runs[].budgetBlocks[].remainingUsd", "runs[].budgetBlocks[].estimateUsd",
      "runs[].budgetBlocks[].hostTokens", "runs[].budgetBlocks[].ceilingTokens",
      "runs[].budgetBlocks[].reason", "runs[].budgetBlocks[].stage",
      "runs[].budget.economy", "runs[].budget.ceilingHostTokens", "runs[].budget.onHostTokensExceed",
      "runs[].budget.phases[].economy", "runs[].budget.phases[].ceilingHostTokens",
      "runs[].plan.stories[].attempt", "runs[].plan.stories[].reviewRetries",
      "runs[].plan.stories[].reopens[].reason", "runs[].plan.stories[].reopens[].note",
      "runs[].plan.stories[].reopens[].actor", "runs[].plan.stories[].reopens[].ts",
      "runs[].plan.stories[].reopens[].fromStatus", "runs[].plan.stories[].reopens[].verdicts",
      "runs[].eventsError", "runs[].eventsSkipped",
    ]) {
      expect(paths).toContain(field);
    }
  });

  test("it is still one plain JSON document", () => {
    const { model } = modelOf({ budget: HOST_TOKEN_BUDGET, plan: true, events: [
      event("operator_note", { note: "n" }, { actor: "alan" }),
    ] });
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});

// ---------------------------------------------------------------------------
// The ledger is read ONCE per run
// ---------------------------------------------------------------------------

describe("events.jsonl is read once per run, never once per story", () => {
  /**
   * `readReviewLedger` and `operatorNotes` both open `events.jsonl` themselves,
   * and `readReviewLedger` takes a STORY id — calling it from the model would
   * re-read and re-parse the whole ledger once per story. A 40-story plan on a
   * long run is then 40 passes over a file that is already in memory, because
   * `loadRunResult` has read and parsed it before `toRunModel` is ever called.
   *
   * A source-shape assertion rather than a timing one: the regression is a
   * specific import, and a clock is not evidence about which function ran.
   */
  test("the model derives from the events it was handed, not from a second read", async () => {
    const source = await Bun.file(new URL("../src/core/dashboard/model.ts", import.meta.url)).text();
    // Comments stripped: this file NAMES both re-readers in prose, to say why it
    // does not call them. A test that cannot tell an explanation from a call
    // would forbid writing the explanation down.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("readReviewLedger");
    expect(code).not.toContain("operatorNotes");
    expect(code).not.toContain("EVENTS_FILE");
    expect(code).not.toContain("EventLog");
    // The one legitimate source: what `loadRunResult` already parsed.
    expect(code).toContain("loaded.events");
  });
});
