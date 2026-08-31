/**
 * `preconditions:` on a stage (design §F.1, wave 3C) — the check that runs before
 * the money does.
 *
 * The grounding is one paragraph of field notes from 2026-08-30, §5: before
 * dispatching a Build story the host checked the Docker daemon and the .NET SDK
 * BY HAND. Not out of caution — out of arithmetic. A story has two attempts, an
 * agent cannot debug its way out of a daemon that is down, and a turn spent
 * discovering that is an attempt gone. The host's check took about a second; the
 * attempt it protected was worth dollars.
 *
 * So a stage may declare that check, and four properties have to hold for the
 * declaration to be worth having:
 *
 *   - **the command is not a command the stage invented.** Byte-equal to a
 *     `.tldrx/workspace.yml` entry, argv-split, never a shell — the SAME rule and
 *     the same function a story's ```dod block and a `cmd` check go through
 *     (`schemas/commandAllowlist.ts`). Refused at LOAD, not at run time.
 *   - **green ⇒ the stage runs**, and each run is on the record: one event, one
 *     operator line, with the exit code and how long it took.
 *   - **red ⇒ exit 2, having spent nothing.** No bundle, no spawn, the stage left
 *     where it was. `--prepare` is covered no less than headless: a bundle written
 *     for a host whose Docker is down is the same wasted attempt.
 *   - **absent ⇒ byte-identical.** A stage that declares none must not gain an
 *     event, a line, or a millisecond.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { loadWorkflowPreset, PresetError } from "../src/core/run/workflowPreset.ts";
import { runPrecondition } from "../src/core/run/checks.ts";
import { loadStageSpec } from "../src/core/facilitator/stageSpec.ts";
import { validateStage, MAX_PRECONDITIONS } from "../src/core/schemas/stage.ts";
import {
  allowlistIssue, noAllowlistMessage, notDeclaredMessage,
} from "../src/core/schemas/commandAllowlist.ts";
import { validateStoryDod, parseDodBlock } from "../src/core/schemas/story.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";
import {
  cannedHandoff, cannedIntent, makeFacilitatorWorkspace,
  type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_CLAUDE_RUNDIR", "FAKE_CLAUDE_OUTPUTS", "FAKE_CLAUDE_COST", "FAKE_CLAUDE_ARGV_LOG",
] as const;

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * The fixture workspace declares `api: {build: "true", test: "false"}`, so the
 * allowlist holds one command that exits 0 and one that exits 1 — a green and a
 * red precondition without inventing anything.
 */
const GREEN = `[{id: docker, repo: api, command: "true"}]`;
const RED = `[{id: docker, repo: api, command: "false"}]`;

const OUTPUTS = JSON.stringify({
  "01-what/intent.md": cannedIntent(),
  "01-what/handoff.md": cannedHandoff(),
  "02-how/handoff.md": cannedHandoff(),
});

function stages(preconditions?: string): readonly StageOptions[] {
  const alpha: StageOptions = {
    id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
    outputs: [
      { path: "01-what/intent.md", sections: ["Intent", "Scope"] },
      { path: "01-what/handoff.md", sections: ["Findings", "Decisions", "Unknowns", "Evidence ledger"] },
    ],
    ...(preconditions === undefined ? {} : { preconditions }),
  };
  const beta: StageOptions = {
    id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto", outputs: [{ path: "02-how/handoff.md" }],
  };
  return [alpha, beta];
}

function workspace(preconditions?: string): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: stages(preconditions), budgetUsd: 10 });
  open.push(made);
  return made;
}

/**
 * The fake `claude`, alone on PATH, with an argv log.
 *
 * The log is the instrument for "nothing was spawned": the fake appends a line the
 * moment it starts, so an ABSENT file proves the binary was never reached — a
 * stronger claim than "no `agent.spawned` event", which only proves the ledger
 * stayed quiet.
 */
function fakeClaude(ws: FacilitatorWorkspace): string {
  const log = join(ws.root, "argv.log");
  process.env.PATH = ws.binDir;
  process.env.FAKE_CLAUDE_RUNDIR = ws.runDir;
  process.env.FAKE_CLAUDE_OUTPUTS = OUTPUTS;
  process.env.FAKE_CLAUDE_ARGV_LOG = log;
  return log;
}

function next(
  ws: FacilitatorWorkspace,
  overrides: Partial<NextOptions> = {},
): Promise<{ code: number; lines: readonly string[] }> {
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

function stageStatus(ws: FacilitatorWorkspace): string | undefined {
  return RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status;
}

/** Rewrite one generated stage.yml's `preconditions:` line, as an operator would. */
function setPreconditions(ws: FacilitatorWorkspace, stageId: string, yaml: string): void {
  const path = join(ws.root, ".tldrx", "stages", stageId, "stage.yml");
  const text = readFileSync(path, "utf8");
  writeFileSync(
    path,
    /^preconditions:/m.test(text)
      ? text.replace(/^preconditions:.*$/m, `preconditions: ${yaml}`)
      : `${text}preconditions: ${yaml}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// The allowlist rule — one rule, one implementation, refused at load
// ---------------------------------------------------------------------------

describe("the allowlist rule is the dod rule, not a second one", () => {
  test("a shell-y command is refused, and the sentence is the story's own", () => {
    const allowed = new Set(["dotnet build"]);
    const shelly = "docker info && rm -rf ~";
    // Same function, same comparison, two subjects. If these ever diverge it is
    // because someone wrote a second rule.
    expect(allowlistIssue(shelly, allowed, "stage"))
      .toBe(notDeclaredMessage(shelly, "stage"));
    const dod = parseDodBlock(["```dod", shelly, "```"].join("\n"));
    expect(validateStoryDod(dod, allowed)[0]?.message)
      .toBe(notDeclaredMessage(shelly, "story"));
  });

  test("an EMPTY allowlist refuses even an innocent command, for both", () => {
    const empty = new Set<string>();
    expect(allowlistIssue("true", empty, "stage")).toBe(noAllowlistMessage("true"));
    const dod = parseDodBlock(["```dod", "true", "```"].join("\n"));
    expect(validateStoryDod(dod, empty)[0]?.message).toBe(noAllowlistMessage("true"));
  });

  /**
   * The workspace is built GREEN and then edited, because `run new` loads the
   * preset too — a stage naming an undeclared command cannot even open a run,
   * which is itself the property under test and is asserted at the end.
   */
  function withPreconditions(yaml: string): FacilitatorWorkspace {
    const ws = workspace(GREEN);
    setPreconditions(ws, "alpha", yaml);
    return ws;
  }

  test("a command workspace.yml does not declare is refused AT LOAD, naming the rule", () => {
    const ws = withPreconditions(`[{id: docker, repo: api, command: "docker info && echo ok"}]`);
    let thrown: unknown = null;
    try {
      loadWorkflowPreset(ws.root, "demo");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PresetError);
    expect((thrown as PresetError).message).toContain("preconditions[0] (docker)");
    expect((thrown as PresetError).message)
      .toContain("is not one of .tldrx/workspace.yml's commands — a stage may not invent one");
  });

  test("`tldrx next` over such a stage exits 1 and never reaches the binary", async () => {
    const ws = withPreconditions(`[{id: docker, repo: api, command: "rm -rf /"}]`);
    const log = fakeClaude(ws);
    const outcome = await next(ws);
    // A stage file that does not load is a usage error, the same as any other
    // PresetError — and it is caught before a stage is even selected.
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("may not invent one");
    expect(existsSync(log)).toBe(false);
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toHaveLength(0);
  });

  test("`run new` cannot open a run over one either — the preset is what it loads", () => {
    // The shape the fixture builder itself refuses: `createRun` loads the preset,
    // so the refusal is at the earliest moment anything reads the stage file.
    expect(() => makeFacilitatorWorkspace({
      scope: "demo",
      stages: stages(`[{id: docker, repo: api, command: "rm -rf /"}]`),
      budgetUsd: 10,
    })).toThrow("may not invent one");
  });

  test("shape refusals: a missing key, a non-list, and the cap", () => {
    const cases: readonly [string, string][] = [
      [`[{repo: api, command: "true"}]`, "has no `id`"],
      [`[{id: docker, command: "true"}]`, "has no `repo`"],
      [`[{id: docker, repo: api}]`, "has no `command`"],
      [`"docker info"`, "must be a list of {id, repo, command} entries"],
      [`[docker]`, "must be a mapping of {id, repo, command}"],
    ];
    for (const [yaml, message] of cases) {
      const ws = withPreconditions(yaml);
      expect(() => loadWorkflowPreset(ws.root, "demo")).toThrow(message);
    }
    const over = Array.from({ length: MAX_PRECONDITIONS + 1 }, (_, i) =>
      `{id: p${String(i)}, repo: api, command: "true"}`).join(", ");
    const ws = withPreconditions(`[${over}]`);
    expect(() => loadWorkflowPreset(ws.root, "demo"))
      .toThrow(`${String(MAX_PRECONDITIONS + 1)} preconditions exceeds the cap of ${String(MAX_PRECONDITIONS)}`);
  });

  test("`validateStage` checks the SHAPE and leaves the allowlist to the loader", () => {
    const base = {
      name: "alpha", title: "Alpha", phase: 1, inputs: [], outputs: [], experts: [],
      model: "sonnet", budget_usd: 1, gate: { type: "none" },
    };
    // A well-shaped precondition passes the schema even though the schema has no
    // workspace to compare the command against — that half is enforced at load.
    expect(validateStage({ ...base, preconditions: [{ id: "d", repo: "api", command: "rm -rf /" }] }).ok).toBe(true);
    expect(validateStage({ ...base, preconditions: [] }).ok).toBe(true);
    expect(validateStage(base).ok).toBe(true);

    const missing = validateStage({ ...base, preconditions: [{ id: "d", repo: "api" }] });
    expect(missing.ok).toBe(false);
    expect(missing.issues.some((i) => i.path === "preconditions[0].command")).toBe(true);

    const notAList = validateStage({ ...base, preconditions: "docker info" });
    expect(notAList.ok).toBe(false);
    expect(notAList.issues.some((i) => i.path === "preconditions")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Green — the stage proceeds, and the run is on the record
// ---------------------------------------------------------------------------

describe("a green precondition lets the stage through, and is recorded", () => {
  test("headless: the stage runs, the event carries the exit code, the line names it", async () => {
    const ws = workspace(GREEN);
    const log = fakeClaude(ws);
    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toHaveLength(1);

    const recorded = events(ws).filter((e) => e.payload.kind === "precondition");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type).toBe("check.passed");
    expect(recorded[0]?.payload.check).toBe("docker");
    expect(recorded[0]?.payload.repo).toBe("api");
    expect(recorded[0]?.payload.command).toBe("true");
    expect(recorded[0]?.payload.exit_code).toBe(0);
    expect(recorded[0]?.payload.status).toBe("passed");
    expect(typeof recorded[0]?.payload.ms).toBe("number");
    // Every precondition run is recorded BEFORE the stage's own events.
    expect(events(ws).findIndex((e) => e.payload.kind === "precondition"))
      .toBeLessThan(events(ws).findIndex((e) => e.type === "stage.started"));

    expect(outcome.lines.some((l) => /^· precondition: true → exit 0 \(\d+\.\ds\)$/.test(l))).toBe(true);
  }, 60_000);

  test("--prepare: the bundle is written and the run is recorded the same way", async () => {
    const ws = workspace(GREEN);
    fakeClaude(ws);
    const outcome = await next(ws, { mode: "prepare" });
    expect(outcome.code).toBe(0);
    expect(existsSync(join(ws.runDir, ".agent", "alpha", "prompt.md"))).toBe(true);
    expect(events(ws).filter((e) => e.payload.kind === "precondition")).toHaveLength(1);
    expect(outcome.lines.some((l) => l.startsWith("· precondition: true → exit 0"))).toBe(true);
  }, 60_000);

  test("every declared precondition runs, in file order", async () => {
    const ws = workspace(`[{id: docker, repo: api, command: "true"}, {id: sdk, repo: lab, command: "true"}]`);
    fakeClaude(ws);
    const outcome = await next(ws, { mode: "prepare" });
    expect(outcome.code).toBe(0);
    expect(events(ws).filter((e) => e.payload.kind === "precondition").map((e) => e.payload.check))
      .toEqual(["docker", "sdk"]);
  }, 60_000);

  test("`expect_exit` is honoured — a command that exits 1 can be the GREEN one", async () => {
    const ws = workspace(`[{id: down, repo: api, command: "false", expect_exit: 1}]`);
    fakeClaude(ws);
    const outcome = await next(ws, { mode: "prepare" });
    expect(outcome.code).toBe(0);
    const recorded = events(ws).find((e) => e.payload.kind === "precondition");
    expect(recorded?.type).toBe("check.passed");
    expect(recorded?.payload.exit_code).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Red — exit 2, and nothing was spent
// ---------------------------------------------------------------------------

describe("a red precondition refuses the stage, having spent nothing", () => {
  test("headless: exit 2, the command and its exit code named, no spawn", async () => {
    const ws = workspace(RED);
    const log = fakeClaude(ws);
    const before = events(ws).length;

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain("refusing to dispatch 01-what/alpha — precondition `docker` is red.");
    expect(text).toContain("`false` in api exited 1 (expected 0)");
    expect(text).toContain("the stage is still `ready` and nothing was spent");

    // Nothing spawned — the binary was never reached, not merely unlogged.
    expect(existsSync(log)).toBe(false);
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toHaveLength(0);
    // Nothing written: no bundle, no `stage.started`, no cost.
    expect(existsSync(join(ws.runDir, ".agent", "alpha"))).toBe(false);
    expect(events(ws).filter((e) => e.type === "stage.started")).toHaveLength(0);
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0);
    // Exactly one new event: the failed precondition itself.
    expect(events(ws).length).toBe(before + 1);
    const failed = events(ws)[before];
    expect(failed?.type).toBe("check.failed");
    expect(failed?.payload.kind).toBe("precondition");
    expect(failed?.payload.exit_code).toBe(1);
  });

  test("the stage is left exactly where it was — `refused`, not `failed`", async () => {
    const ws = workspace(RED);
    fakeClaude(ws);
    const was = stageStatus(ws);
    expect((await next(ws)).code).toBe(2);
    expect(stageStatus(ws)).toBe(was as string);
    expect(events(ws).filter((e) => e.type === "stage.failed")).toHaveLength(0);
  });

  test("--prepare is refused too: a bundle for a dead daemon is the same wasted attempt", async () => {
    const ws = workspace(RED);
    fakeClaude(ws);
    const outcome = await next(ws, { mode: "prepare" });
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("precondition `docker` is red.");
    expect(existsSync(join(ws.runDir, ".agent", "alpha"))).toBe(false);
  });

  test("the run refuses again the same way — nothing was half-done the first time", async () => {
    const ws = workspace(RED);
    fakeClaude(ws);
    expect((await next(ws)).code).toBe(2);
    expect((await next(ws)).code).toBe(2);
    expect(events(ws).filter((e) => e.payload.kind === "precondition")).toHaveLength(2);
    expect(events(ws).filter((e) => e.type === "agent.spawned")).toHaveLength(0);
  });

  test("a red precondition stops the list — the ones after it never run", async () => {
    const ws = workspace(
      `[{id: docker, repo: api, command: "false"}, {id: sdk, repo: api, command: "true"}]`,
    );
    fakeClaude(ws);
    expect((await next(ws)).code).toBe(2);
    expect(events(ws).filter((e) => e.payload.kind === "precondition").map((e) => e.payload.check))
      .toEqual(["docker"]);
  });

  test("an unknown repo is red without spawning anything", async () => {
    const ws = workspace(`[{id: docker, repo: nope, command: "true"}]`);
    const log = fakeClaude(ws);
    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain("unknown repo `nope` (not in workspace.yml)");
    expect(existsSync(log)).toBe(false);
  });

  test("`--commit` does not re-check: it settles a turn that already happened", async () => {
    const ws = workspace(GREEN);
    fakeClaude(ws);
    expect((await next(ws, { mode: "prepare" })).code).toBe(0);

    // The daemon dies between the dispatch and the settle. Re-checking it now
    // could only throw away work the host has already paid for.
    setPreconditions(ws, "alpha", RED);
    const agentDir = join(ws.runDir, ".agent", "alpha");
    writeFileSync(join(ws.runDir, "01-what/intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what/handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(
      join(agentDir, "result.json"),
      JSON.stringify({
        outputs: ["01-what/intent.md", "01-what/handoff.md"],
        questions_asked: [], notes: "host turn", cost_usd: 0.19,
      }),
      "utf8",
    );

    const before = events(ws).filter((e) => e.payload.kind === "precondition").length;
    const committed = await next(ws, { mode: "commit" });
    expect(committed.code).toBe(0);
    expect(events(ws).filter((e) => e.payload.kind === "precondition")).toHaveLength(before);
    expect(committed.lines.some((l) => l.includes("precondition"))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// runPrecondition itself
// ---------------------------------------------------------------------------

describe("runPrecondition", () => {
  test("reports the id it was given, not the `cmd` label the check shares", async () => {
    const ws = workspace(GREEN);
    const store = RunStore.open(ws.runDir);
    const spec = loadStageSpec(ws.root, store.run.scope, "alpha");
    const ran = await runPrecondition(spec.planned.preconditions[0]!, {
      root: ws.root, runDir: ws.runDir, stage: spec.planned,
    });
    expect(ran.id).toBe("docker");
    expect(ran.ok).toBe(true);
    expect(ran.exitCode).toBe(0);
    expect(ran.detail).toBe("`true` in api exited 0");
    expect(ran.ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Absent — the compat bar
// ---------------------------------------------------------------------------

describe("a stage that declares none is what shipped", () => {
  /**
   * The same sequence `attended.test.ts` captured from `main` for this fixture.
   * The gate for this chunk: `preconditions:` is additive, and additive means a
   * stage without it did not gain an event.
   */
  const MAIN_SEQUENCE = [
    "run.created@alan",
    "stage.started", "agent.spawned@product", "agent.result@product", "stage.done",
    "stage.started", "agent.spawned@product", "agent.result@product", "stage.done",
    "run.closed",
  ];

  test("emits main's event sequence, event for event", async () => {
    const ws = workspace();
    fakeClaude(ws);
    const first = await next(ws);
    const second = await next(ws);
    expect([first.code, second.code]).toEqual([0, 0]);
    // The exact mapping `attended.test.ts` uses, so the two chunks are held to
    // one sequence rather than to two similar-looking ones.
    expect(events(ws).map((e) => `${e.type}${e.actor === "facilitator" ? "" : `@${e.actor ?? ""}`}`))
      .toEqual(MAIN_SEQUENCE);
  }, 60_000);

  test("no stage.yml gains the key, and no line mentions a precondition", async () => {
    const ws = workspace();
    fakeClaude(ws);
    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(readFileSync(join(ws.root, ".tldrx/stages/alpha/stage.yml"), "utf8"))
      .not.toContain("preconditions");
    expect(outcome.lines.some((l) => l.includes("precondition"))).toBe(false);
    expect(events(ws).some((e) => e.payload.kind === "precondition")).toBe(false);
  }, 60_000);

  test("`preconditions: []` is the same as absent — no event, no line", async () => {
    const ws = workspace("[]");
    fakeClaude(ws);
    const outcome = await next(ws);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.some((l) => l.includes("precondition"))).toBe(false);
    expect(events(ws).some((e) => e.payload.kind === "precondition")).toBe(false);
  }, 60_000);
});
