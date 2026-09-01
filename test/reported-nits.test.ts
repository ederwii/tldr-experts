/**
 * The five wave-5 docs-pass nits (#25) — each one a place where the code said one thing
 * and did another.
 *
 * They are collected here rather than scattered because they are one cluster with one
 * shape: a sentence somebody wrote that nothing was checking. Every test below fails
 * against the code as it was reported.
 *
 *   1. `boundary.ts` promised an exclusion is "never silent" — and dropped state paths
 *      without a word, because `surface.excluded` reached no output.
 *   2. `dispatchNotes.ts` documented `.agent/04-build/build/S5/…`; the path the code
 *      builds is `.agent/build/S5/…` — one phase segment too many.
 *   3. The precondition refusal asserted "the stage is still `ready`" without looking.
 *   4. `gate` and `run new` printed usage strings narrower than their own `--help`.
 *   5. The agent-gate fallthrough rendered `boundary: boundary=…` — the label twice.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateBoundary } from "../src/core/run/boundary.ts";
import { dispatchNotesPath } from "../src/core/facilitator/dispatchNotes.ts";
import { gateCommand } from "../src/cli/commands/gate.ts";
import { runCommand } from "../src/cli/commands/run.ts";
import { helpFor } from "../src/cli/helpText.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
let open: BuildWorkspace[] = [];
let facilitators: FacilitatorWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_BUILD_STATE;
  for (const ws of open) ws.dispose();
  open = [];
  for (const ws of facilitators) ws.dispose();
  facilitators = [];
});

const DECLARED: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "Inside the surface", touches: ["src/in.ts"] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
  gates: "none",
  repoFiles: { "src/in.ts": "export const before = 1;\n" },
};

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

describe("1 — an exclusion is never silent, as `boundary.ts` says it is not", () => {
  test("a state path dropped from the surface is NAMED in the verdict", async () => {
    const ws = workspace({
      ...DECLARED,
      stories: [{ id: "S1", epic: "E1", title: "S1", touches: ["src/in.ts", ".tldrx/workspace.yml"] }],
    });

    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });

    expect(verdict.detail).toContain(".tldrx/workspace.yml");
    expect(verdict.detail).toContain("excluded");
  });

  test("even when the exclusion is ALL there was, so the run looks like it declared nothing", async () => {
    const ws = workspace({
      ...DECLARED,
      stories: [{ id: "S1", epic: "E1", title: "S1", touches: [".tldrx/workspace.yml"] }],
    });

    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });

    // Still `ok` — a run that scoped nothing is not a refusal (that rule is unchanged).
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("declares no surface");
    // …but it no longer looks like nothing happened. This is the whole nit.
    expect(verdict.detail).toContain(".tldrx/workspace.yml");
  });

  test("a run with nothing to exclude says nothing about exclusions", async () => {
    const ws = workspace(DECLARED);
    const verdict = await evaluateBoundary({ root: ws.root, runDir: ws.runDir, phaseId: "04-build" });
    expect(verdict.detail).not.toContain("excluded");
  });
});

describe("2 — the dispatch-notes docstring names the path the code builds", () => {
  test("the example in `DispatchNoteSource.rel` is a path `dispatchNotesPath` produces", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "core", "facilitator", "dispatchNotes.ts"), "utf8");
    const example = /Run-dir relative, e\.g\. `([^`]+)`/.exec(source)?.[1];
    expect(example).toBeTruthy();

    // The key is `<stage>/<story>` (`build.ts` → `bundleKey`), never `<phase>/<stage>/<story>`.
    const built = dispatchNotesPath("/run", "build/S5").slice("/run/".length).split("\\").join("/");
    expect(example).toBe(built);
  });
});

describe("3 — the precondition refusal reports the status it measured", () => {
  /**
   * The message asserted `ready` without looking, and a stage arriving here is not
   * always `ready`: `next` re-runs a `failed` stage (that is the retry), and the
   * refusal then told the operator a state the file did not hold. Nothing else about
   * the refusal changes — exit 2, nothing spent, the stage left exactly where it was.
   * When the stage IS `ready` the sentence is byte-for-byte what it was.
   */
  const facilitator = (preconditions: string): FacilitatorWorkspace => {
    const made = makeFacilitatorWorkspace({
      scope: "demo",
      budgetUsd: 10,
      stages: [
        {
          id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
          outputs: [{ path: "01-what/intent.md", sections: ["Intent", "Scope"] }],
          preconditions,
        },
        { id: "beta", phase: "02-how", budgetUsd: 4, gate: "auto", outputs: [{ path: "02-how/handoff.md" }] },
      ],
    });
    facilitators.push(made);
    return made;
  };

  const refuse = (ws: FacilitatorWorkspace) => runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-28T09:00:00Z",
  });

  /**
   * Found by writing this test: on a FRESH run the stage at the cursor is `pending`,
   * not `ready` — it is promoted only once it is actually dispatched. So the old
   * sentence was wrong in the ordinary case as well as the retry, and #25 undercounted
   * it. What is asserted is therefore the invariant, not a spelling: whatever `run.yml`
   * holds is what the operator is told.
   */
  test("the status reported is the status `run.yml` holds — on a fresh run, `pending`", async () => {
    const ws = facilitator(`[{id: docker, repo: api, command: "false"}]`);
    const onDisk = RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status;
    expect(onDisk).toBe("pending");

    const outcome = await refuse(ws);

    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain(`the stage is still \`${onDisk ?? "?"}\` and nothing was spent`);
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe(onDisk);
  }, 60_000);

  test("a `failed` stage is reported as `failed`, not as `ready`", async () => {
    const ws = facilitator(`[{id: docker, repo: api, command: "false"}]`);
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => ({
      ...run,
      phases: run.phases.map((phase, i) => (i !== 0 ? phase : {
        ...phase,
        stages: phase.stages.map((stage, j) => (j !== 0 ? stage : { ...stage, status: "failed" as const })),
      })),
    }));
    store.save();
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("failed");

    const outcome = await refuse(ws);

    expect(outcome.code).toBe(2);
    const said = outcome.lines.join("\n");
    expect(said).toContain("the stage is still `failed` and nothing was spent");
    expect(said).not.toContain("still `ready`");
    // The other half of the promise: it really was left where it was.
    expect(RunStore.open(ws.runDir).run.phases[0]?.stages[0]?.status).toBe("failed");
  }, 60_000);
});

describe("4 — a usage string is not narrower than the help behind it", () => {
  test("`gate`'s usage admits the positional run id its own help documents", () => {
    const help = helpFor("gate");
    expect(help?.args.map((a) => a.name)).toContain("[<run>]");
    expect(gateCommand.usage).toContain("[<run>]");
  });

  test("`run new`'s usage spells `--gates` the way its own help does", () => {
    const gates = helpFor("run")?.flags.find((f) => f.name === "gates" && f.sub === "new");
    expect(gates?.arg).toBe("<a,b|a:agent|all|none>");
    expect(runCommand.usage).toContain(`--gates ${gates?.arg ?? "MISSING"}`);
  });
});

describe("5 — the agent-gate fallthrough names its trigger once", () => {
  test("no fallthrough detail repeats the label the renderer already prints", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "core", "run", "agentGate.ts"), "utf8");
    // `boundary: boundary=…` came from prefixing EVERY condition detail with its own id,
    // including the two that get a trigger of their own.
    expect(source).not.toContain("fallthroughs.push({ trigger, detail: `${condition.id}=${condition.detail}` });");
  });
});
