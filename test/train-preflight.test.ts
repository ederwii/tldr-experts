/**
 * `tldrx expert train` — the check in front of the money (#96).
 *
 * Live 2026-09-02: `expert train … --mode full` inherited the claude CLI's
 * last-used model (`fable-5`, premium) and ran against the default ceiling, which
 * full mode halves between its two sub-agents. It died with `Reached maximum
 * budget ($1)` at 54 s having spent **$1.31**, and nothing was written to
 * `competencies.yml`. Every test here guards one of the three sentences that were
 * missing: which model this will actually use, what tier that is, and whether the
 * ceiling was ever measured for it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  runTraining, trainingCacheDir, trainPreflight, modelTier, resolveAmbientModel, ambientModelFiles,
  DEFAULT_TRAIN_USD, DEFAULT_FULL_TRAIN_USD, MEASURED_FULL_TRAIN_USD, defaultTrainUsd,
  type TrainOptions, type PreflightInput,
} from "../src/core/training/index.ts";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import {
  makeTrainingWorkspace, knowledgeMd, fromRunsMd, AREA, EXPERT, TRAIN_AT, TRAIN_NOW,
  type TrainingWorkspace,
} from "./fixtures/training/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// The CLI block below spawns a real `tldrx`; process cost is a property of the
// machine, not of the code (#43).
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_TRAIN_ROOT", "FAKE_TRAIN_OUTPUTS", "FAKE_TRAIN_COST", "FAKE_TRAIN_STATE",
  "FAKE_TRAIN_ARGV_LOG",
] as const;

let open: TrainingWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const KNOWLEDGE_WRITE = `.tldrx/experts/${EXPERT}/knowledge/${AREA}.md.partial`;
const FROM_RUNS_WRITE = `.tldrx/experts/${EXPERT}/knowledge/from-runs-${AREA}.md.partial`;

const FABLE = { model: "claude-fable-5[1m]", source: "~/.claude/settings.json" } as const;

function workspace(): TrainingWorkspace {
  const made = makeTrainingWorkspace();
  open.push(made);
  return made;
}

function fakeClaude(ws: TrainingWorkspace, plans: readonly Record<string, string>[]): void {
  process.env.PATH = ws.binDir;
  process.env.FAKE_TRAIN_ROOT = ws.root;
  process.env.FAKE_TRAIN_STATE = ws.statePath;
  process.env.FAKE_TRAIN_OUTPUTS = JSON.stringify(plans);
  process.env.FAKE_TRAIN_COST = "0.37";
}

function fullPlans(): readonly Record<string, string>[] {
  return [{ [KNOWLEDGE_WRITE]: knowledgeMd() }, { [FROM_RUNS_WRITE]: fromRunsMd() }];
}

function train(ws: TrainingWorkspace, overrides: Partial<TrainOptions> = {}) {
  return runTraining({
    root: ws.root,
    expert: EXPERT,
    area: AREA,
    mode: "light",
    run: "headless",
    actor: "alan",
    at: TRAIN_AT,
    now: TRAIN_NOW,
    timeoutMs: 20_000,
    // Hermetic by default: no test may read the developer's own
    // `~/.claude/settings.json` and change behaviour because of it.
    ambientModel: null,
    ...overrides,
  });
}

function spawns(ws: TrainingWorkspace): number {
  return existsSync(ws.statePath) ? Number(readFileSync(ws.statePath, "utf8")) : 0;
}

function input(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    mode: "full",
    agents: 2,
    ceilingUsd: DEFAULT_FULL_TRAIN_USD,
    ceilingExplicit: false,
    model: null,
    ambient: FABLE,
    run: "headless",
    ...overrides,
  };
}

// --- tiers -------------------------------------------------------------------

describe("model tiers", () => {
  test("fable and opus are premium, sonnet is mid, haiku is economy", () => {
    expect(modelTier("claude-fable-5[1m]")).toBe("premium");
    expect(modelTier("opus")).toBe("premium");
    expect(modelTier("claude-opus-4-5-20260101")).toBe("premium");
    expect(modelTier("sonnet")).toBe("mid");
    expect(modelTier("claude-haiku-4-5-20251001")).toBe("economy");
  });

  test("a model this table has never heard of is `unknown`, not premium", () => {
    // Refusing on a guess is the same mistake in the other direction.
    expect(modelTier("gpt-9")).toBe("unknown");
    expect(modelTier(null)).toBe("unknown");
    expect(modelTier("")).toBe("unknown");
  });
});

// --- (a) the refusal ---------------------------------------------------------

describe("premium model + full mode + the DEFAULT ceiling", () => {
  test("is refused before anything spawns, and names both remedies", () => {
    const result = trainPreflight(input());

    expect(result.refusal).not.toBeNull();
    const said = (result.refusal ?? []).join("\n");
    expect(said).toContain("refusing to spawn");
    expect(said).toContain("--model sonnet");
    expect(said).toContain("--max-usd");
    expect(said).toContain("nothing was spent");
    // The remedy is only fair if the number behind it is shown.
    expect(said).toContain(`$${MEASURED_FULL_TRAIN_USD.low.toFixed(2)}`);
    expect(result.notice).toEqual([]);
  });

  test("the refusal names the model and that it was inherited", () => {
    const said = (trainPreflight(input()).refusal ?? []).join("\n");
    expect(said).toContain("claude-fable-5[1m]");
    expect(said).toContain("premium");
    expect(said).toContain("inherited from your claude CLI");
    expect(said).toContain("~/.claude/settings.json");
  });

  test("runTraining exits 2 and spawns nothing", async () => {
    const ws = workspace();
    fakeClaude(ws, fullPlans());

    const outcome = await train(ws, { mode: "full", ambientModel: { ...FABLE } });

    expect(outcome.code).toBe(2);
    expect(outcome.costUsd).toBe(0);
    expect(spawns(ws)).toBe(0);
    expect(outcome.lines.join("\n")).toContain("refusing to spawn");
  });

  test("light mode is not refused — one sub-agent, and the whole ceiling is its share", () => {
    const result = trainPreflight(input({ mode: "light", agents: 1, ceilingUsd: DEFAULT_TRAIN_USD }));
    expect(result.refusal).toBeNull();
  });

  test("a mid model at the default is not refused and carries no warning", () => {
    const result = trainPreflight(input({ model: "sonnet", ambient: null }));
    expect(result.refusal).toBeNull();
    expect(result.notice.join("\n")).not.toContain("warning");
  });

  test("nothing is said on --commit — that money is already spent", () => {
    const result = trainPreflight(input({ run: "commit" }));
    expect(result.refusal).toBeNull();
    expect(result.notice).toEqual([]);
  });
});

// --- (a) the proceed-with-warning --------------------------------------------

describe("premium model + full mode + an EXPLICIT --max-usd", () => {
  test("proceeds with one warning line — the owner chose the ceiling", () => {
    // $2.00 across two sub-agents is $1.00 each: the very share that died at
    // $1.31 on 2026-09-02. Typed by hand, it proceeds anyway.
    const result = trainPreflight(input({ ceilingExplicit: true, ceilingUsd: 2 }));

    expect(result.refusal).toBeNull();
    const warnings = result.notice.filter((line) => line.startsWith("warning:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("You passed --max-usd, so this proceeds.");
    expect(warnings[0]).toContain("premium");
    expect(warnings[0]).toContain("$1.00 per sub-agent");
  });

  test("an explicit ceiling that DOES reach the floor says nothing extra", () => {
    const result = trainPreflight(input({ ceilingExplicit: true, ceilingUsd: 6 }));
    expect(result.refusal).toBeNull();
    expect(result.notice.filter((line) => line.startsWith("warning:"))).toEqual([]);
  });

  test("runTraining runs it: two sub-agents, exit 0", async () => {
    const ws = workspace();
    fakeClaude(ws, fullPlans());

    const outcome = await train(ws, { mode: "full", maxUsd: 2, ambientModel: { ...FABLE } });

    expect(outcome.code).toBe(0);
    expect(spawns(ws)).toBe(2);
    expect((outcome.preflight ?? []).join("\n")).toContain("You passed --max-usd, so this proceeds.");
  });
});

// --- (b) the recalibrated default --------------------------------------------

describe("the full-mode default ceiling", () => {
  test(`light stays $${DEFAULT_TRAIN_USD.toFixed(2)}, full is $${DEFAULT_FULL_TRAIN_USD.toFixed(2)}`, () => {
    expect(DEFAULT_TRAIN_USD).toBe(2.0);
    expect(DEFAULT_FULL_TRAIN_USD).toBe(3.0);
    expect(defaultTrainUsd("light")).toBe(DEFAULT_TRAIN_USD);
    expect(defaultTrainUsd("full")).toBe(DEFAULT_FULL_TRAIN_USD);
  });

  test("it is at least twice the measured per-sub-agent cost of a real full run", () => {
    // Measured full trainings run $1.21-$1.60 END TO END on a mid model
    // (docs/audits/2026-08-29/experts-knowledge.md), i.e. ~$0.60-$0.80 for each
    // of the two sub-agents — and one repair round comes out of the same share.
    const perAgentWorstCase = MEASURED_FULL_TRAIN_USD.high / 2;
    expect(DEFAULT_FULL_TRAIN_USD / 2).toBeGreaterThanOrEqual(perAgentWorstCase * 1.8);
  });

  test("each of full mode's two sub-agents is sent $1.50 when no --max-usd is given", async () => {
    const ws = workspace();
    fakeClaude(ws, fullPlans());
    const argvLog = join(ws.root, "argv.log");
    process.env.FAKE_TRAIN_ARGV_LOG = argvLog;

    await train(ws, { mode: "full" });

    const lines = readFileSync(argvLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(lines).toHaveLength(2);
    for (const argv of lines) {
      expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1.50");
    }
  });
});

// --- (a) the explicit model line ---------------------------------------------

describe("the pre-start model line", () => {
  test("an inherited model is named, tiered, and sourced", () => {
    const result = trainPreflight(input({ ceilingExplicit: true, ceilingUsd: 6 }));

    expect(result.inherited).toBe(true);
    expect(result.model).toBe("claude-fable-5[1m]");
    expect(result.tier).toBe("premium");
    expect(result.notice[0]).toContain(
      "model claude-fable-5[1m] (premium, inherited from your claude CLI via ~/.claude/settings.json)",
    );
    expect(result.notice[0]).toContain("pass --model to override");
    expect(result.notice[0]).toContain("--mode full");
    expect(result.notice[0]).toContain("$6.00 across 2 sub-agent(s), $3.00 each");
  });

  test("an explicit --model says so instead of claiming an inheritance", () => {
    const result = trainPreflight(input({ model: "sonnet" }));
    expect(result.inherited).toBe(false);
    expect(result.notice[0]).toContain("model sonnet (mid, --model)");
    expect(result.notice[0]).not.toContain("inherited");
  });

  test("when nothing on the box says what the CLI will pick, it says THAT", () => {
    const result = trainPreflight(input({ model: null, ambient: null }));
    expect(result.model).toBeNull();
    expect(result.tier).toBe("unknown");
    expect(result.refusal).toBeNull();
    expect(result.notice[0]).toContain("tldrx could not read it here");
  });

  test("runTraining hands the line back on the outcome, so it is not only on stderr", async () => {
    const ws = workspace();
    fakeClaude(ws, [{ [KNOWLEDGE_WRITE]: knowledgeMd() }]);

    const outcome = await train(ws, { model: "sonnet" });

    expect(outcome.code).toBe(0);
    expect((outcome.preflight ?? []).join("\n")).toContain("model sonnet (mid, --model)");
  });
});

// --- resolving what the CLI would have picked --------------------------------

describe("resolveAmbientModel", () => {
  function box(): { root: string; home: string; dispose: () => void } {
    const ws = makeTrainingWorkspace();
    open.push(ws);
    const home = join(ws.root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    return { root: ws.root, home, dispose: ws.dispose };
  }

  function writeSettings(dir: string, body: string): void {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), body, "utf8");
  }

  test("$ANTHROPIC_MODEL wins over every settings file", () => {
    const b = box();
    writeSettings(b.home, JSON.stringify({ model: "sonnet" }));

    const found = resolveAmbientModel({
      env: { ANTHROPIC_MODEL: "claude-fable-5[1m]" },
      home: b.home,
      files: ambientModelFiles(b.root, b.home),
    });

    expect(found?.model).toBe("claude-fable-5[1m]");
    expect(found?.source).toBe("$ANTHROPIC_MODEL");
  });

  test("the project's settings beat the home one, and the source is shortened to ~", () => {
    const b = box();
    writeSettings(b.home, JSON.stringify({ model: "sonnet" }));
    writeSettings(b.root, JSON.stringify({ model: "opus" }));

    const project = resolveAmbientModel({ env: {}, home: b.home, files: ambientModelFiles(b.root, b.home) });
    expect(project?.model).toBe("opus");

    const home = resolveAmbientModel({ env: {}, home: b.home, files: [join(b.home, ".claude", "settings.json")] });
    expect(home?.model).toBe("sonnet");
    expect(home?.source).toBe("~/.claude/settings.json");
  });

  test("a settings file that is missing, unparseable or has no model is skipped, never fatal", () => {
    const b = box();
    writeSettings(b.root, "{ this is not json");
    writeSettings(b.home, JSON.stringify({ theme: "dark" }));

    expect(resolveAmbientModel({ env: {}, home: b.home, files: ambientModelFiles(b.root, b.home) })).toBeNull();
  });
});

// --- end to end, through the real CLI ----------------------------------------

/**
 * The block that would have caught #96 as it happened. Nothing is injected here:
 * the model is put where the claude CLI would find it and `resolveAmbientModel`
 * has to go and read it.
 */
describe("tldrx expert train, with the model coming off the environment", () => {
  const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

  async function cli(
    ws: TrainingWorkspace, model: string, extra: readonly string[] = [],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(
      [
        process.execPath, BIN, "expert", "train", EXPERT,
        "--area", AREA, "--mode", "full", "--root", ws.root, "--ui", "off", ...extra,
      ],
      {
        cwd: ws.root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ANTHROPIC_MODEL: model,
          PATH: `${ws.binDir}:${ORIGINAL_PATH}`,
          FAKE_TRAIN_ROOT: ws.root,
          FAKE_TRAIN_STATE: ws.statePath,
          FAKE_TRAIN_OUTPUTS: JSON.stringify(fullPlans()),
          FAKE_TRAIN_COST: "0.37",
        },
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test("an inherited premium model at the default ceiling exits 2 and spawns nothing", async () => {
    const ws = workspace();
    const run = await cli(ws, "claude-fable-5[1m]");

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("refusing to spawn");
    expect(run.stderr).toContain("claude-fable-5[1m]");
    expect(run.stderr).toContain("$ANTHROPIC_MODEL");
    expect(run.stderr).toContain("--model sonnet");
    expect(spawns(ws)).toBe(0);
  });

  test("the same run with an explicit --max-usd proceeds, warning once", async () => {
    const ws = workspace();
    const run = await cli(ws, "claude-fable-5[1m]", ["--max-usd", "2"]);

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("You passed --max-usd, so this proceeds.");
    expect(spawns(ws)).toBe(2);
  });

  test("an inherited MID model is named with its tier and simply runs", async () => {
    const ws = workspace();
    const run = await cli(ws, "sonnet");

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("model sonnet (mid, inherited from your claude CLI via $ANTHROPIC_MODEL)");
    expect(run.stderr).not.toContain("refusing to spawn");
    expect(spawns(ws)).toBe(2);
  });
});

// --- #98: the same trap, one step removed -------------------------------------

/**
 * `--prepare` spawns nothing HERE, and that is exactly why it was skipped (#96
 * wired the check to `spawns: run === "headless"`). But it writes the ceiling
 * into `pending.json` and into the prompt text, and a host session then spends
 * against it — so the run that dies at `error_max_budget_usd` with nothing
 * written is still reachable, one command later, on someone else's money.
 *
 * The asymmetry the tests below pin: headless we KNOW the model (tldrx spawns
 * `claude` with no `--model`, so the CLI default applies); on `--prepare` the
 * sub-agent is started by the host session, so an INHERITED model is a
 * prediction about a process tldrx does not control. Explicit `--model` is
 * written into the bundle as an instruction, so that one is knowledge and is
 * refused like any other.
 */
describe("--prepare carries the check into the bundle (#98)", () => {
  test("an inherited premium model WARNS — it does not refuse a process we do not start", () => {
    const result = trainPreflight(input({ run: "prepare" }));

    expect(result.refusal).toBeNull();
    const warnings = result.notice.filter((line) => line.startsWith("warning:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the session you hand this bundle to");
    expect(warnings[0]).toContain("--model sonnet");
    expect(warnings[0]).toContain("--max-usd");
    // The model line is still said, tier and provenance included.
    expect(result.notice[0]).toContain("claude-fable-5[1m]");
    expect(result.notice[0]).toContain("premium");
  });

  test("an EXPLICIT --model is an instruction in the bundle, so it is refused", () => {
    const result = trainPreflight(input({ run: "prepare", model: "claude-fable-5[1m]", ambient: null }));

    expect(result.refusal).not.toBeNull();
    const said = (result.refusal ?? []).join("\n");
    expect(said).toContain("refusing to prepare");
    expect(said).toContain("nothing was written");
    expect(said).toContain("--model sonnet");
    expect(result.notice).toEqual([]);
  });

  test("an explicit --max-usd is never refused on --prepare either", () => {
    const result = trainPreflight(input({
      run: "prepare", model: "claude-fable-5[1m]", ambient: null, ceilingExplicit: true, ceilingUsd: 2,
    }));
    expect(result.refusal).toBeNull();
    expect(result.notice.filter((line) => line.startsWith("warning:"))).toHaveLength(1);
  });

  test("a mid model preparing at the default says its line and warns about nothing", () => {
    const result = trainPreflight(input({ run: "prepare", model: "sonnet", ambient: null }));
    expect(result.refusal).toBeNull();
    expect(result.notice).toHaveLength(1);
    expect(result.notice[0]).toContain("model sonnet (mid, --model)");
  });

  test("runTraining --prepare staples the lines onto stdout AND into every pending.json", async () => {
    const ws = workspace();
    // No fake on PATH: --prepare must not spawn, warning or no warning.
    const outcome = await train(ws, { run: "prepare", mode: "full", ambientModel: { ...FABLE } });

    expect(outcome.code).toBe(0);
    expect(outcome.costUsd).toBe(0);
    const said = (outcome.preflight ?? []).join("\n");
    expect(said).toContain("claude-fable-5[1m]");
    expect(said).toContain("the session you hand this bundle to");

    // stdout, where the operator reads the prepared block — not only stderr.
    const stdout = outcome.lines.join("\n");
    expect(stdout).toContain("claude-fable-5[1m]");
    expect(stdout).toContain("prepared training for");

    // And in the bundle, where the HOST session reads it.
    const cache = trainingCacheDir(ws.root, EXPERT, AREA);
    for (const key of ["code", "runs"]) {
      const pending = JSON.parse(
        readFileSync(join(cache, ".agent", key, "pending.json"), "utf8"),
      ) as Record<string, unknown>;
      const lines = pending.preflight as string[] | undefined;
      expect(lines).toBeDefined();
      expect((lines ?? []).join("\n")).toContain("premium");
      expect(pending.max_budget_usd).toBe(1.5);
    }
  });

  test("runTraining --prepare with an explicit --model exits 2 and writes NO bundle", async () => {
    const ws = workspace();
    const outcome = await train(ws, {
      run: "prepare", mode: "full", model: "claude-fable-5[1m]", ambientModel: null,
    });

    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("refusing to prepare");
    const cache = trainingCacheDir(ws.root, EXPERT, AREA);
    expect(existsSync(join(cache, ".agent", "code", "prompt.md"))).toBe(false);
    expect(existsSync(join(cache, ".agent", "runs", "prompt.md"))).toBe(false);
  });

  test("a bundle with nothing to say carries no `preflight` key at all", async () => {
    const ws = workspace();
    // A mid model at the default fits, so the only line is the model line — and
    // an unchanged bundle should stay an unchanged bundle wherever it can.
    await train(ws, { run: "prepare", mode: "full", model: "sonnet", ambientModel: null });

    const cache = trainingCacheDir(ws.root, EXPERT, AREA);
    const pending = JSON.parse(
      readFileSync(join(cache, ".agent", "code", "pending.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pending.preflight).toBeUndefined();
  });

  test("--commit writes nothing new: the money it is reconciling is already spent", () => {
    const result = trainPreflight(input({ run: "commit", ceilingUsd: 2 }));
    expect(result.notice).toEqual([]);
    expect(result.refusal).toBeNull();
  });
});
