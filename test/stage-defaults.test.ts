/**
 * The shipped defaults a stage runs on, and the four keys that override them.
 *
 * Every number pinned here was changed on 2026-09-09 against a week of real
 * unattended runs on three workspaces, and each one had cost a turn:
 *
 *  - `timeout_s` 900 killed a `how` turn (gh #207) and two Build developer turns
 *    in one day; Opus turns on real repositories run 15-50 minutes.
 *  - `prompt_max_bytes` 163,840 refused a 202 KB `how` prompt — while its own
 *    message called that prompt "29% of a 200k window".
 *  - `inputs_max_bytes` 98,304 silently sliced a 169 KB `facts.yml`.
 *  - a phase was sized for exactly ONE attempt, so the first retry of a failed
 *    stage was refused by arithmetic rather than by policy (gh #170).
 *
 * The tests are written to FAIL if a number moves without a decision: each
 * default is asserted once, at its exported constant, and the behaviour that
 * depends on it is asserted separately against behaviour rather than against the
 * constant that produced it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { STAGES_DIR, WORKFLOWS_DIR } from "../src/core/paths.ts";
import { DEFAULT_TIMEOUT_S, loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { PRECONDITION_TIMEOUT_S, validateStage } from "../src/core/schemas/stage.ts";
import {
  STAGE_TUNING_DEFAULTS, STAGE_TUNING_RANGES, readStageTuning,
} from "../src/core/schemas/stageTuning.ts";
import { DEFAULT_PROMPT_MAX_BYTES, buildLedger, renderLedger } from "../src/core/facilitator/contextLedger.ts";
import { DEFAULT_INPUTS_MAX_BYTES } from "../src/core/facilitator/seedInputs.ts";
import { DEFAULT_KNOWLEDGE_MAX_BYTES } from "../src/core/experts/expertKnowledge.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { planBudget } from "../src/core/run/newRun.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_IS_ERROR",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const workspace of open) workspace.dispose();
  open = [];
});

const TWO_STAGE: readonly StageOptions[] = [
  {
    id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
    outputs: [
      { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
      { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    ],
  },
  { id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto", outputs: [{ path: "02-how/handoff.md" }] },
];

const ALPHA_OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
});

function workspace(stages: readonly StageOptions[] = TWO_STAGE): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages, budgetUsd: 10 });
  open.push(made);
  return made;
}

function fakeClaude(ws: FacilitatorWorkspace, env: Readonly<Record<string, string>> = {}): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function next(
  ws: FacilitatorWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, runId: ws.runId, dryRun: false, mode: "headless",
    yolo: true, actor: "alan", at: "2026-09-09T10:00:00Z", ...overrides,
  });
}

function events(ws: FacilitatorWorkspace): readonly { type: string; payload: Record<string, unknown> }[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

// ---------------------------------------------------------------------------

describe("the shipped defaults", () => {
  /**
   * One assertion per constant, and nothing else asserts the numbers — so a
   * deliberate change is a one-line edit here with a CHANGELOG bullet behind it,
   * and an accidental one is a red gate.
   */
  test("are the 2026-09-09 figures, each named once", () => {
    expect(DEFAULT_TIMEOUT_S).toBe(7200);
    expect(DEFAULT_PROMPT_MAX_BYTES).toBe(409_600);
    expect(DEFAULT_INPUTS_MAX_BYTES).toBe(262_144);
    // Unchanged, deliberately: trained knowledge is the section nobody asked for,
    // and the one the refusal message tells an operator to cut first.
    expect(DEFAULT_KNOWLEDGE_MAX_BYTES).toBe(49_152);
    // Also unchanged: a precondition is a liveness question, not work.
    expect(PRECONDITION_TIMEOUT_S).toBe(60);
    expect(STAGE_TUNING_DEFAULTS).toEqual({
      attempts: 2, fixlistRounds: 1, reviewerShare: 0.25, gateSignerShare: 0.25,
    });
  });

  /**
   * The framework's own stage files, read off disk rather than off the constant:
   * `build` shipped 1800 and `watch` shipped 900, and both were per-TURN bounds
   * that real turns crossed.
   */
  test("every shipped stage that sets `timeout_s` sets it to the same two hours", () => {
    for (const id of ["what", "how", "plan", "build", "watch"]) {
      const path = join(STAGES_DIR, id, "stage.yml");
      const doc = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
      const declared = doc.timeout_s;
      if (declared === undefined) continue;
      expect([id, declared]).toEqual([id, DEFAULT_TIMEOUT_S]);
    }
  });

  /**
   * A stage that declares nothing gets the constants — the property every
   * workspace on disk today depends on.
   */
  test("a stage file that declares none of the four keys gets the defaults", () => {
    const ws = workspace();
    const spec = loadStageSpec(ws.root, "demo", "alpha");
    expect(spec.tuning).toEqual(STAGE_TUNING_DEFAULTS);
    expect(spec.promptMaxBytes).toBe(DEFAULT_PROMPT_MAX_BYTES);
    expect(spec.inputsMaxBytes).toBe(DEFAULT_INPUTS_MAX_BYTES);
    expect(spec.planned.timeout_s).toBe(60);   // this fixture pins its own
  });
});

describe("the four calibration keys", () => {
  test("a value in range is read; the same key out of range is REFUSED by name", () => {
    for (const [field, range] of Object.entries(STAGE_TUNING_RANGES)) {
      const inRange = range.integer ? range.max : range.max;
      expect([range.key, readStageTuning({ [range.key]: inRange })[field as "attempts"]])
        .toEqual([range.key, inRange]);

      const outOfRange = range.max + 1;
      // The READER is tolerant: junk becomes the default, never a strange spawn.
      expect([range.key, readStageTuning({ [range.key]: outOfRange })[field as "attempts"]])
        .toEqual([range.key, STAGE_TUNING_DEFAULTS[field as "attempts"]]);
      // The VALIDATOR is the one that says so, and it names the key.
      const issues = validateStage(stageDoc({ [range.key]: outOfRange })).issues;
      expect([range.key, issues.map((i) => i.path)]).toEqual([range.key, [range.key]]);
    }
  });

  test("a fractional `attempts` is refused rather than truncated", () => {
    const issues = validateStage(stageDoc({ attempts: 2.5 })).issues;
    expect(issues.map((i) => i.path)).toEqual(["attempts"]);
    expect(issues[0]?.message).toContain("integer");
  });

  test("a stage file that declares them is read through `loadStageSpec`", () => {
    const ws = workspace();
    const path = join(ws.root, ".tldrx", "stages", "alpha", "stage.yml");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}attempts: 3\nfixlist_rounds: 0\nreviewer_share: 0.5\ngate_signer_share: 0.1\n`,
      "utf8",
    );
    const spec = loadStageSpec(ws.root, "demo", "alpha");
    expect(spec.tuning).toEqual({
      attempts: 3, fixlistRounds: 0, reviewerShare: 0.5, gateSignerShare: 0.1,
    });
    // `attempts` reaches the money split through `PlannedStage`, which is the one
    // place that turns the key into a value.
    expect(spec.planned.attempts).toBe(3);
  });
});

describe("a phase holds every attempt its stages may take (gh #170)", () => {
  test("the phase ceiling is `attempts` x the stage share, and the stage share is one attempt", () => {
    const ws = workspace();
    const preset = loadWorkflowPreset(ws.root, "demo");
    const plan = planBudget(preset, 10);
    // alpha 6 + beta 4 declared, two attempts each ⇒ 20 claimed shares of $10.
    expect(plan.perStage.get("alpha")).toBe(3);
    expect(plan.perStage.get("beta")).toBe(2);
    expect(plan.perPhase.get("01-what")).toBe(6);
    expect(plan.perPhase.get("02-how")).toBe(4);
    // Still inside the run ceiling, which is what §2.11 validates.
    expect([...plan.perPhase.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10);
  });

  /**
   * The refusal this fixes, reproduced end to end.
   *
   * On `main` before this change the same sequence printed
   * `budget: refusing to start stage "alpha" — phase 01-what has $5.58 left and
   * the stage estimate is $6.00` and exited 2: the phase was sized for one
   * attempt, the first attempt had spent $0.42 of it, and the estimate the retry
   * was checked against was still the whole stage.
   */
  test("a stage that failed once is retried without a budget refusal", async () => {
    const ws = workspace();
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: "{}", FAKE_CLAUDE_IS_ERROR: "1", FAKE_CLAUDE_COST: "0.42" });
    const failed = await next(ws);
    expect(failed.code).toBe(5);
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0.42);

    // The retry. It must not be refused for money the phase still has.
    fakeClaude(ws, { FAKE_CLAUDE_OUTPUTS: ALPHA_OUTPUTS, FAKE_CLAUDE_IS_ERROR: "", FAKE_CLAUDE_COST: "0.30" });
    delete process.env.FAKE_CLAUDE_IS_ERROR;
    const retried = await next(ws, { at: "2026-09-09T10:30:00Z" });

    expect(retried.lines.join("\n")).not.toContain("refusing to start stage");
    expect(retried.code).not.toBe(2);
    expect(events(ws).map((e) => e.type)).not.toContain("budget.blocked");
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("done");
  }, 60_000);
});

describe("the context line never quotes a window it cannot source", () => {
  const parts = [{ kind: "stage" as const, name: "stage.md", text: "x".repeat(4000) }];

  test("a model the price table knows gets its window and a percentage", () => {
    const ledger = buildLedger({
      parts, inputBytes: [], truncatedInputs: [], limitBytes: DEFAULT_PROMPT_MAX_BYTES, model: "sonnet[1m]",
    });
    expect(ledger.contextTokens).toBe(1_000_000);
    expect(renderLedger(ledger)[0]).toContain("of sonnet[1m]'s ~1000.0k window");
  });

  /**
   * The bug: `contextTokensFor` fell back to a DOCUMENTED 200 000 for a model it
   * had never heard of, and the ledger printed that as if it were the model's
   * own window — "29% of a ~200.0k window", on a refusal, for a model whose real
   * window is 1M. Absent-with-reason: no window, no percentage, and the token
   * estimate — which was always the honest half — still prints.
   */
  test("a model it does not know gets NO window and NO percentage", () => {
    const ledger = buildLedger({
      parts, inputBytes: [], truncatedInputs: [], limitBytes: DEFAULT_PROMPT_MAX_BYTES, model: "some-new-model",
    });
    expect(ledger.contextTokens).toBeNull();
    expect(ledger.contextPct).toBeNull();
    expect(ledger.contextWarns).toBe(false);
    const line = renderLedger(ledger)[0] ?? "";
    expect(line).toContain("tok");
    expect(line).not.toContain("window");
    expect(line).not.toContain("%");
  });
});

describe("the shipped workflows fund their stages' attempts", () => {
  test("every shipped scope's `default_budget_usd` opens a run without a refusal", () => {
    const scopes = readdirScopes();
    expect(scopes.length).toBeGreaterThan(0);
    let checked = 0;
    for (const scope of scopes) {
      // `retro.yml` lists no stages at all and `loadWorkflowPreset` refuses it —
      // it is not a run shape. Counted below so this loop cannot silently check
      // nothing.
      let preset;
      try {
        preset = loadWorkflowPreset(process.cwd(), scope);
      } catch {
        continue;
      }
      checked++;
      const plan = planBudget(preset, undefined);
      const summed = [...plan.perPhase.values()].reduce((a, b) => a + b, 0);
      expect([scope, summed <= plan.ceiling + 1e-9]).toEqual([scope, true]);
      // Every phase holds at least two attempts of its stages.
      for (const stage of preset.stages) {
        const share = plan.perStage.get(stage.id) ?? 0;
        const phase = plan.perPhase.get(stage.phase) ?? 0;
        expect([scope, stage.id, phase >= share * stage.attempts - 1e-9])
          .toEqual([scope, stage.id, true]);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(scopes.length - 1);
  });
});

function readdirScopes(): readonly string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => f.slice(0, -4))
    .filter((scope) => existsSync(join(WORKFLOWS_DIR, `${scope}.yml`)));
}

/** A minimal VALID stage document, plus whatever key the caller is testing. */
function stageDoc(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "alpha", title: "Alpha", phase: 1,
    inputs: [], outputs: [], experts: [],
    model: "sonnet", budget_usd: 1, gate: { type: "human-approval" },
    ...extra,
  };
}
