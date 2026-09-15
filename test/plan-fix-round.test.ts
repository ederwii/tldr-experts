/**
 * The Plan phase's one bounded fix round (gh #288).
 *
 * Measured on a live unattended run (0.18.3, `run auto --until-done`): the
 * planner wrote `acceptance: [ … ], test_plan: [ … ]` on ONE line in three of
 * three stories — a flow-mapping comma inside a block mapping — the `plan` check
 * refused it naming file, line and column, and the stage FAILED. The only
 * recovery was a fresh Plan turn ($2.19) plus one of five `--until-done`
 * relaunches, for a two-character slip the checker had already localised.
 *
 * Every test here runs the REAL facilitator against a real run on disk, with the
 * recorded fake agent first on PATH (AGENTS.md §8). The fake writes the broken
 * front matter on its first turn and the corrected file when the prompt it is
 * handed is the fix round's — the same `FAKE_CLAUDE_ALT_MATCH` discriminator the
 * gate-signer tests already use, so there is still exactly one emitter.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { PLAN_FIX_MARKER, PLAN_FIX_ROLE } from "../src/core/plan/planFixRound.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR",
  "FAKE_CLAUDE_SESSION", "FAKE_CLAUDE_ALT_MATCH", "FAKE_CLAUDE_ALT_OUTPUTS",
  "FAKE_CLAUDE_PROMPT_OUT",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * A story the `plan` check accepts. `repo: api` and the `true` dod command are
 * both declared by the fixture workspace, so the only thing under test is the
 * front matter.
 */
const GOOD_STORY = `---
version: 1
id: S1
epic: E1
title: "Materialise the leaderboard read model"
repo: api
status: todo
depends_on: []
touches: ["src/features/leaderboard/"]
acceptance: ["Top-50 ranks render from the view"]
test_plan: ["Unit: rank ordering with ties"]
evidence: []
---

# S1

\`\`\`dod
true
\`\`\`
`;

/** The field defect, verbatim in shape: two keys on one line, joined by a comma. */
const COMMA_JOINED_STORY = GOOD_STORY.replace(
  'acceptance: ["Top-50 ranks render from the view"]\ntest_plan: ["Unit: rank ordering with ties"]',
  'acceptance: ["Top-50 ranks render from the view"], test_plan: ["Unit: rank ordering with ties"]',
);

const EPIC = `---
version: 1
id: E1
title: "Player leaderboard"
repos: [api]
stories: [S1]
branch: epic/leaderboard
status: todo
---

# E1

What this epic is for.
`;

const WAVES = `version: 1
waves:
  - {id: W1, stories: [S1]}
`;

const PLAN_STAGE: StageOptions = {
  id: "plan",
  phase: "03-plan",
  budgetUsd: 6,
  gate: "auto",
  // `stories/S1.md` is deliberately NOT a declared output: `validateOutputs` runs
  // before the checks, so declaring it would make the missing-story case die on a
  // missing output and never reach `checkPlan` at all — the guard below would then
  // be measuring the wrong thing. `checkPlan` reads the whole `03-plan/` directory.
  outputs: [
    { path: "03-plan/waves.yml" },
    { path: "03-plan/epics/E1.md" },
  ],
  checks: "[{id: plan, on: post-write}]",
};

function workspace(budgetUsd = 12): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: [PLAN_STAGE], budgetUsd });
  open.push(made);
  return made;
}

/** The canned file set, keyed run-relative exactly as the fake writes them. */
function outputs(story: string): string {
  return JSON.stringify({
    "03-plan/waves.yml": WAVES,
    "03-plan/epics/E1.md": EPIC,
    "03-plan/stories/S1.md": story,
  });
}

/**
 * The fake agent, ONLY on PATH: a fake that failed to resolve with the real
 * binary still on PATH would spawn a real session and bill for it.
 */
function fakeClaude(ws: FacilitatorWorkspace, env: Readonly<Record<string, string>>): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_COST = "0.42";
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function next(ws: FacilitatorWorkspace, overrides: Partial<NextOptions> = {}) {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-28T09:00:00Z",
    ...overrides,
  });
}

function events(ws: FacilitatorWorkspace): readonly TldrxEvent[] {
  return EventLog.forRun(ws.runDir).read();
}

function planStage(ws: FacilitatorWorkspace) {
  const store = RunStore.open(ws.runDir);
  const stage = store.run.phases.flatMap((p) => p.stages).find((s) => s.id === "plan");
  expect(stage).toBeDefined();
  return stage as NonNullable<typeof stage>;
}

describe("the Plan phase's bounded fix round (gh #288)", () => {
  test("a comma-joined front matter is repaired by ONE fix round instead of a fresh plan", async () => {
    const ws = workspace();
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: outputs(COMMA_JOINED_STORY),
      FAKE_CLAUDE_ALT_MATCH: PLAN_FIX_MARKER,
      FAKE_CLAUDE_ALT_OUTPUTS: outputs(GOOD_STORY),
    });

    const outcome = await next(ws);

    const stage = planStage(ws);
    expect(stage.status).not.toBe("failed");
    // TWO turns in ONE invocation: the planner, then the repair — never a third.
    expect(stage.tasks).toHaveLength(2);
    expect(stage.tasks[0]?.role).toBeUndefined();
    expect(stage.tasks[1]?.role).toBe(PLAN_FIX_ROLE);
    // The repair is metered into the stage like any other turn.
    expect(stage.tasks[1]?.cost_usd).toBe(0.42);
    expect(stage.cost_usd).toBe(0.84);

    const fix = events(ws).filter((e) => e.type === "plan.fix_round");
    expect(fix).toHaveLength(1);
    expect(fix[0]?.payload.task).toBe(stage.tasks[1]?.id);
    expect(fix[0]?.payload.files).toEqual(["stories/S1.md"]);
    // The charge lives on the turn's own rows, never twice.
    expect(fix[0]?.cost_usd).toBe(0);

    // The check was refused, then passed — both recorded, in that order.
    const checks = events(ws).filter((e) => e.type === "check.failed" || e.type === "check.passed");
    expect(checks.map((e) => e.type)).toEqual(["check.failed", "check.passed"]);
    expect(String(checks[0]?.payload.detail)).toContain("front matter is not valid YAML");

    expect(outcome.lines.join("\n")).toContain("fix round: one repair turn over stories/S1.md");
  });

  test("the fix round's prompt carries the refusal VERBATIM and points at the file", async () => {
    const ws = workspace();
    const promptOut = join(ws.root, "fix-prompt.txt");
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: outputs(COMMA_JOINED_STORY),
      FAKE_CLAUDE_ALT_MATCH: PLAN_FIX_MARKER,
      FAKE_CLAUDE_ALT_OUTPUTS: outputs(GOOD_STORY),
      FAKE_CLAUDE_PROMPT_OUT: promptOut,
    });

    await next(ws);

    // The LAST prompt the fake was handed is the fix round's.
    const prompt = await Bun.file(promptOut).text();
    expect(prompt).toContain(PLAN_FIX_MARKER);
    const refusal = String(
      events(ws).find((e) => e.type === "check.failed")?.payload.detail ?? "",
    );
    expect(refusal).not.toBe("");
    expect(prompt).toContain(refusal);
    expect(prompt).toContain("`03-plan/stories/S1.md`");
    expect(prompt).toContain("This is a REPAIR, not a re-plan.");
  });

  test("a second refusal fails the stage, in the same family, naming BOTH attempts", async () => {
    const ws = workspace();
    // No alt outputs: the repair turn writes the same broken story back.
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: outputs(COMMA_JOINED_STORY) });

    const outcome = await next(ws);

    // Exit 5 — the agent-failed family a stage death has always used.
    expect(outcome.code).toBe(5);
    const stage = planStage(ws);
    expect(stage.status).toBe("failed");
    // Exactly two turns: the bound holds even when the repair does not work.
    expect(stage.tasks).toHaveLength(2);
    expect(stage.tasks.filter((t) => t.role === PLAN_FIX_ROLE)).toHaveLength(1);

    const failure = events(ws).find((e) => e.type === "stage.failed");
    const reason = String(failure?.payload.reason ?? "");
    expect(reason).toContain("refused again after one fix round");

    // Both refusals, in full, on the output the operator reads — and each one
    // verbatim on its own `check.failed` row, which is the durable record.
    const printed = outcome.lines.join("\n");
    expect(printed).toContain("plan refusal 1 of 2, before the fix round:");
    expect(printed).toContain("plan refusal 2 of 2, after the fix round:");
    const refusals = events(ws).filter((e) => e.type === "check.failed");
    expect(refusals).toHaveLength(2);
    for (const row of refusals) {
      expect(printed).toContain(String(row.payload.detail));
    }
  });

  test("a refusal nothing on disk could repair spends no fix round", async () => {
    const ws = workspace();
    // waves.yml and the epic, and NO story: `validatePlan` marks that issue
    // `absent` — there is no file for a repair turn to edit, so a round here
    // would be a re-plan wearing a fix round's clothes.
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: JSON.stringify({
        "03-plan/waves.yml": WAVES,
        "03-plan/epics/E1.md": EPIC,
      }),
    });

    const outcome = await next(ws);

    expect(outcome.code).not.toBe(0);
    const stage = planStage(ws);
    expect(stage.tasks).toHaveLength(1);
    expect(events(ws).filter((e) => e.type === "plan.fix_round")).toHaveLength(0);
  });

  test("a host-driven `--commit` is told the round it does not get, and nothing spawns", async () => {
    const ws = workspace();
    // An EMPTY directory as the whole PATH, and it is the hermeticity backstop, not
    // decoration (AGENTS.md §8). The assertions below say this cycle spawns nothing;
    // what makes them safe to trust is that nothing here COULD be spawned. Leaving
    // the ambient PATH in place would mean that the day the headless-only bound
    // regresses, this test resolves the developer's own `claude` (measured on this
    // box: `which claude` → ~/.local/bin/claude) and bills a real session instead of
    // failing. `ws.binDir` is not the answer either — that one holds the fake, and a
    // fake that answers is still a spawn.
    const noAgent = join(ws.root, ".no-agent");
    mkdirSync(noAgent, { recursive: true });
    process.env.PATH = noAgent;

    const prepared = await next(ws, { mode: "prepare" });
    expect(prepared.code).toBe(0);

    // The host session does the work — and writes the field defect.
    const plan = join(ws.runDir, "03-plan");
    mkdirSync(join(plan, "stories"), { recursive: true });
    mkdirSync(join(plan, "epics"), { recursive: true });
    writeFileSync(join(plan, "waves.yml"), WAVES, "utf8");
    writeFileSync(join(plan, "epics", "E1.md"), EPIC, "utf8");
    writeFileSync(join(plan, "stories", "S1.md"), COMMA_JOINED_STORY, "utf8");
    writeFileSync(
      join(ws.runDir, ".agent", "plan", "result.json"),
      JSON.stringify({
        outputs: ["03-plan/waves.yml", "03-plan/epics/E1.md", "03-plan/stories/S1.md"],
        questions_asked: [],
        notes: "written by the host session",
        cost_usd: 0.19,
        session_id: "c9f1a2b0-1f2e-4c3d-9a10-6b7c8d9e0f11",
      }),
      "utf8",
    );

    const outcome = await next(ws, { mode: "commit" });

    // The stage fails on the refusal, exactly as it did before #288 existed.
    expect(outcome.code).toBe(5);
    const stage = planStage(ws);
    expect(stage.status).toBe("failed");
    // ONE row — the host's own turn. Nothing here spawned a repair.
    expect(stage.tasks).toHaveLength(1);
    expect(stage.tasks.filter((t) => t.role === PLAN_FIX_ROLE)).toHaveLength(0);
    expect(events(ws).filter((e) => e.type === "plan.fix_round")).toHaveLength(0);
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toHaveLength(0);

    // Said out loud, naming the mode: a host who cannot see the round they did not
    // get cannot tell "bounded by design" from "the feature did not fire".
    const printed = outcome.lines.join("\n");
    expect(printed).toContain(
      "fix round: not taken — this invocation is `--commit` and the framework does not spawn",
    );
    expect(printed).toContain("tldrx next --commit");
  });

  test("a phase that cannot fund the repair turn says so and spends nothing", async () => {
    // The run's ceiling is the stage's own budget, so the planner's turn leaves
    // less than the repair's cap and `on_exceed: block` refuses it — through
    // `wouldExceed`, the same predicate the budget gate decides on.
    const ws = workspace(6);
    fakeClaude(ws, {
      FAKE_CLAUDE_OUTPUTS: outputs(COMMA_JOINED_STORY),
      FAKE_CLAUDE_COST: "5.90",
      FAKE_CLAUDE_ALT_MATCH: PLAN_FIX_MARKER,
      FAKE_CLAUDE_ALT_OUTPUTS: outputs(GOOD_STORY),
    });

    const outcome = await next(ws);

    const stage = planStage(ws);
    expect(stage.tasks).toHaveLength(1);
    expect(events(ws).filter((e) => e.type === "plan.fix_round")).toHaveLength(0);
    expect(outcome.lines.join("\n")).toContain("fix round: not taken");
  });
});
