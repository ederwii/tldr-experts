/**
 * `tldrx run status` — a stage's duration, and the words on its gate (#120).
 *
 * `run.yml` has recorded `started_at`, `ended_at` and `gate.note` on every stage
 * since `run new` wrote the first one. #118 put all three on the dashboard's
 * `StageRowModel` and drew them on the page; `runStatus.ts` built its own record
 * from the same file and was not touched, so the page and the CLI disagreed about
 * what is knowable from one file.
 *
 * The rules under test are #118's, kept verbatim because they are the reason this
 * is not a two-line change:
 *
 *   - **A duration is a subtraction, and it exists only when both ends do.** No
 *     `0m` is ever synthesised, and the four absence cases are told apart rather
 *     than collapsed into a blank.
 *   - **`note: ""` is not a signature.** It is what `run new` writes on an
 *     unsigned gate; it reads as null and is never quoted.
 *
 * The run is real: a real workspace, a real `run.yml` written by `createRun` and
 * re-read from disk through `RunStore`. Only the timestamps are placed by hand,
 * because the clock is the thing under test.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { EXIT_OK } from "../src/cli/exitCodes.ts";
import { declaredFlags } from "../src/cli/helpText.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import type { RunFile, RunStage } from "../src/core/run/RunFile.ts";
import {
  makeFacilitatorWorkspace, type FacilitatorWorkspace, type StageOptions,
} from "./fixtures/facilitator/workspace.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// The CLI half of this file spawns the REAL binary, so the budget scales with
// measured machine load rather than trusting bun's fixed 5000 ms (#43).
setDefaultTimeout(spawnTestTimeout());

const ALPHA: StageOptions = { id: "alpha", phase: "01-what", budgetUsd: 6, gate: "approve" };
const BETA: StageOptions = { id: "beta", phase: "02-how", budgetUsd: 4, gate: "approve" };

let open: FacilitatorWorkspace[] = [];

afterEach(() => {
  for (const workspace of open) workspace.dispose();
  open = [];
});

function workspace(): FacilitatorWorkspace {
  const made = makeFacilitatorWorkspace({ scope: "demo", stages: [ALPHA, BETA], budgetUsd: 10 });
  open.push(made);
  return made;
}

/** Patch the two stages of the fixture run, then read the file back off disk. */
function withStages(patch: Readonly<Record<string, Partial<RunStage>>>): RunStore {
  const ws = workspace();
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) => ({ ...stage, ...(patch[stage.id] ?? {}) })),
    })),
  }));
  store.save();
  return RunStore.open(ws.runDir);
}

function screen(store: RunStore, verbose = false): string {
  return renderStatus(buildStatus(store.run, store.budget, store.runDir), verbose);
}

const SIGNED = {
  type: "approve", status: "approved", by: "alan", at: "2026-09-01T11:38:00Z",
  note: "the dod blocks were resynced by hand",
} as const;

// --- the measurement -------------------------------------------------------

describe("a stage line carries its duration", () => {
  test("both ends recorded: the stage line prints the subtraction", () => {
    const store = withStages({
      alpha: { started_at: "2026-09-01T09:02:00Z", ended_at: "2026-09-01T11:40:00Z" },
    });
    expect(screen(store)).toContain("2h 38m");
  });

  test("under an hour reads in minutes, and under a minute in seconds", () => {
    const store = withStages({
      alpha: { started_at: "2026-09-01T09:02:00Z", ended_at: "2026-09-01T09:20:00Z" },
      beta: { started_at: "2026-09-01T09:02:00Z", ended_at: "2026-09-01T09:02:40Z" },
    });
    const text = screen(store);
    expect(text).toContain("18m");
    expect(text).toContain("40s");
  });

  test("a started stage with no end says so, and never prints a zero", () => {
    const store = withStages({ alpha: { started_at: "2026-09-01T09:02:00Z", ended_at: null } });
    const text = screen(store);
    expect(text).toContain("not ended");
    // The whole point: a blank reads as "it took no time" and `0m` is a
    // measurement of zero. Neither is what run.yml says.
    expect(text).not.toMatch(/\b0[hms]\b/);
    expect(screen(store, true))
      .toContain("not recorded — this stage has a started_at and no ended_at yet");
  });

  test("a stage with neither end claims nothing on the line, and names the absence when asked", () => {
    const store = withStages({});
    const text = screen(store);
    // A run nobody has started has nothing to time. Eight rows of "not timed" is
    // noise, not honesty — and the status column already says `todo`.
    expect(text).not.toContain("not ended");
    expect(text).not.toMatch(/\b0[hms]\b/);
    expect(screen(store, true))
      .toContain("not recorded — run.yml carries neither started_at nor ended_at");
  });

  test("an ended_at before its started_at is not a duration", () => {
    // Built in memory on purpose: `RunStore.save()` REFUSES to write this file
    // (`ended_at is before started_at`), so the only way a reader meets it is an
    // older or hand-edited run.yml — which is exactly who this wording is for.
    const store = withStages({});
    const run: RunFile = {
      ...store.run,
      phases: store.run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) => stage.id !== "alpha" ? stage : {
          ...stage, started_at: "2026-09-01T11:40:00Z", ended_at: "2026-09-01T09:02:00Z",
        }),
      })),
    };
    const text = renderStatus(buildStatus(run, store.budget, store.runDir), true);
    expect(text).toContain("not recorded — run.yml's two timestamps do not yield one");
    expect(text).not.toMatch(/\b0[hms]\b/);
  });
});

// --- the signature ---------------------------------------------------------

describe("a signed gate says it carries a note", () => {
  test("the line is marked and the header counts it; the words are one flag away", () => {
    const store = withStages({
      alpha: { gate: SIGNED, started_at: "2026-09-01T09:02:00Z", ended_at: "2026-09-01T11:40:00Z" },
    });
    const text = screen(store);
    expect(text).toContain("✎");
    expect(text).toContain("1 signed gate carries a note");
    // Default output stays a screen: the note is POINTED AT, not quoted.
    expect(text).not.toContain("the dod blocks were resynced by hand");
    expect(screen(store, true)).toContain("note: the dod blocks were resynced by hand");
  });

  test("`note: \"\"` is not a signature — nothing is marked and nothing is quoted", () => {
    // What `run new` writes on every unsigned gate, which is every gate here.
    const store = withStages({});
    expect(store.run.phases[0]?.stages[0]?.gate.note).toBe("");
    const text = screen(store);
    expect(text).not.toContain("✎");
    expect(text).not.toContain("carries a note");
    expect(screen(store, true)).not.toContain("note:");
  });
});

// --- the documented output shape -------------------------------------------

describe("run status --json", () => {
  test("each gate row carries the stage's two ends and its note", () => {
    const store = withStages({
      alpha: { gate: SIGNED, started_at: "2026-09-01T09:02:00Z", ended_at: "2026-09-01T11:40:00Z" },
    });
    const view = buildStatus(store.run, store.budget, store.runDir);
    expect(view.gates[0]).toMatchObject({
      stage: "alpha",
      started_at: "2026-09-01T09:02:00Z",
      ended_at: "2026-09-01T11:40:00Z",
      note: "the dod blocks were resynced by hand",
    });
    // Null, not `""` — the same mapping `gateNote` makes on the dashboard, so the
    // two surfaces cannot disagree about whether a gate was signed.
    expect(view.gates[1]).toMatchObject({ stage: "beta", started_at: null, ended_at: null, note: null });
  });

  /**
   * The row's keys in order. Appended, never inserted — the same promise
   * `SINGLE_RUN_KEYS` makes for the top level in `multi-run.test.ts`, and the
   * reason a consumer reading `gates[i].by` is untouched by #120.
   */
  test("the keys a gate row has always had keep their positions", () => {
    // On a run.yml that carries neither of #122's OPTIONAL blocks, which is what
    // `run new` writes: `executed_by` and `authority` are spread in only when the
    // file has them, and they sit ahead of these three when it does.
    const store = withStages({});
    const view = buildStatus(store.run, store.budget, store.runDir);
    expect(Object.keys(view.gates[0] ?? {})).toEqual([
      "phase", "stage", "policy", "type", "status", "by", "at",
      // #120, appended:
      "started_at", "ended_at", "note",
    ]);
  });

  test("no duration is stored — the subtraction happens where it is drawn", () => {
    const store = withStages({
      alpha: { started_at: "2026-09-01T09:02:00Z", ended_at: "2026-09-01T11:40:00Z" },
    });
    const json = JSON.stringify(buildStatus(store.run, store.budget, store.runDir));
    expect(json).not.toContain("duration");
    expect(json).not.toContain("9480");
  });
});

// --- the flag reaches the command ------------------------------------------

describe("run status --verbose, through the real binary", () => {
  const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

  async function tldrx(root: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(["bun", BIN, "run", "status", "--root", root, ...args], {
      stdout: "pipe", stderr: "pipe", cwd: root, env: noSpawnEnv(),
    });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  }

  /**
   * An UNDECLARED flag is refused before the command sees it, so declaring
   * `--verbose` in the help registry is what makes it reachable at all — not
   * paperwork. `cli.test.ts` checks the registry statically; this checks that a
   * person typing it gets the screen.
   */
  test("the flag is declared, accepted, and adds the lines it promises", async () => {
    expect(declaredFlags("run").has("verbose")).toBe(true);
    const ws = workspace();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase) => ({
        ...phase,
        stages: phase.stages.map((stage) => stage.id !== "alpha" ? stage : {
          ...stage, gate: SIGNED,
          started_at: "2026-09-01T09:02:00Z", ended_at: "2026-09-01T11:40:00Z",
        }),
      })),
    }));
    store.save();

    const plain = await tldrx(ws.root);
    expect(plain.code).toBe(EXIT_OK);
    expect(plain.stdout).toContain("2h 38m");
    expect(plain.stdout).not.toContain("the dod blocks were resynced by hand");

    const loud = await tldrx(ws.root, "--verbose");
    expect(loud.code).toBe(EXIT_OK);
    expect(loud.stdout).toContain("note: the dod blocks were resynced by hand");
    expect(loud.stdout).toContain("2026-09-01T09:02:00Z \u2192 2026-09-01T11:40:00Z");
  });

  test("an undeclared flag is still refused — the declaration is load-bearing", async () => {
    const ws = workspace();
    const refused = await tldrx(ws.root, "--nonsense");
    expect(refused.code).not.toBe(EXIT_OK);
  });
});
