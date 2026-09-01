/**
 * The eval harness: run ONE real stage, against the stand-in agent, in a
 * synthetic workspace — and hand back everything an assertion could want.
 *
 * Issue #26 asks for a suite that regression-tests the framework's own prompts
 * and stages "rather than judged by eye". The machinery that makes that cheap
 * already exists and is already proven: `tldrx learn` (#30) runs the REAL
 * commands against a scripted stand-in `claude` (`src/core/learn/agentScript.ts`,
 * `learnAgent.ts`) inside a throwaway toy repo (`sandbox.ts`). An eval is that
 * same rig pointed at one stage instead of at a chapter.
 *
 * ## The one idea that makes a stage addressable on its own
 *
 * Stages are a chain: Plan cannot run until How's gate is signed. Playing the
 * chain to reach stage N would make every eval depend on the four before it — a
 * broken What would turn all five red and none of them would say why.
 *
 * So each eval gets its OWN run, opened on a workflow preset that contains
 * exactly ONE stage. `workflowPath` (`run/workflowPreset.ts:112`) reads
 * `.tldrx/workflows/<scope>.yml` BEFORE the shipped `workflows/`, so a preset
 * written into the synthetic workspace is all it takes; and `normalisePhase`
 * (same file, :288) takes the phase folder from the stage's own `phase:` number,
 * not from its position, so a lone `stages: [plan]` still writes `03-plan/`.
 * Everything upstream that the stage genuinely READS — a plan for Build, a done
 * story for Watch — is seeded onto the disk as part of the scenario.
 *
 * ## What an eval is allowed to assert
 *
 * These are CONTRACT evals, not snapshot diffs. The stand-in writes what the
 * scenario tells it to, so asserting the bytes of an artifact would only assert
 * the fixture. What is really under test is everything the FRAMEWORK does with
 * it, and there are four kinds of it — see `test/evals/README.md`:
 *
 *   1. the stage still declares the outputs it declares, and `validateOutputs`
 *      re-reads them off disk (a stage that loses an output fails here);
 *   2. the stage's `checks:` run and PASS on a well-formed artifact, and their
 *      `detail` is the framework's own computed sentence (`checkPlan`'s branch
 *      model line, for instance) rather than anything the model wrote;
 *   3. the artifacts parse under the framework's OWN parsers — `validateQuestions`,
 *      `validateHandoff`, `parseWatcherCard` — imported here, never re-implemented,
 *      so a grammar that tightens moves the eval with it;
 *   4. the side effects a stage exists for: a branch cut, a DoD re-run, a merge,
 *      a story's measured evidence, a card's COMPUTED status, an event trail.
 *
 * And one that is easy to miss: a turn is selected by what the PROMPT says
 * (`agentScript.ts:selectTurn`). Every scenario below matches on a stage
 * template's H1 — `# What — handoff`, `# Plan — handoff`. Delete or reword that
 * heading and no turn matches, the stand-in fails closed, and the eval goes red.
 * That is the prompt half of #26, and it costs nothing extra.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtime } from "../../src/core/runtime/index.ts";
import { PROJECT_WORK_DIR } from "../../src/core/paths.ts";
import { sandboxEnv, writeScript, type Sandbox } from "../../src/core/learn/sandbox.ts";
import type { AgentTurn } from "../../src/core/learn/agentScript.ts";

/** One eval: a stage, a synthetic scenario, and what the stand-in will say. */
export interface StageEval {
  /** The stage id — a folder under `stages/`. Also names the run and the preset. */
  readonly stage: string;
  /** `01-what` … `05-watch`. The folder the stage's outputs land in. */
  readonly phase: string;
  /** Run title, for the record. */
  readonly title: string;
  /**
   * Files written into the RUN DIRECTORY before the stage runs — the upstream
   * artifacts this stage genuinely reads. `{run}` and `{runDir}` expand.
   * Everything a stage does NOT read is deliberately absent.
   */
  readonly seed?: Readonly<Record<string, string>>;
  /** Files written into the WORKSPACE (not the run) before the stage runs. */
  readonly seedWorkspace?: Readonly<Record<string, string>>;
  /** The scripted turns. `{run}`/`{runDir}` expand in both paths and contents. */
  readonly turns: readonly AgentTurn[];
  /**
   * Who closes this stage's gate in the eval's preset. `human` is the default
   * and the useful one: the stage runs to completion, `validateOutputs` and every
   * `check:` have already happened, and `next` stops at exit 4 with the whole
   * record on disk. `auto` is for an eval that wants the gate itself judged.
   */
  readonly gate?: "human" | "auto";
  /** Exit codes that mean the stage ran as intended. Default `[4]` — awaiting a human. */
  readonly expectExit?: readonly number[];
}

/** Everything the stage left behind, plus how it exited. */
export interface EvalRun {
  readonly runId: string;
  /** Absolute path to `<workspace>/tldrx-work/<runId>`. */
  readonly runDir: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout + stderr, for an assertion message that can be read. */
  readonly said: string;
  /** Read a file under the run directory. Throws if it is not there. */
  readonly read: (rel: string) => string;
  /** Read a file under the workspace. Throws if it is not there. */
  readonly readWorkspace: (rel: string) => string;
  /** Every event the run recorded, parsed, in order. */
  readonly events: readonly EventRecord[];
}

export interface EventRecord {
  readonly type: string;
  readonly stage?: string;
  readonly actor?: string;
  readonly cost_usd?: number | null;
  readonly payload?: Record<string, unknown>;
}

/**
 * Open a one-stage run and drive it, exactly as a person would.
 *
 * `run new` and `next` are spawned as REAL `tldrx` subprocesses in the synthetic
 * workspace, under `sandboxEnv` — which is what makes the real `claude`
 * unreachable: `TLDRX_CLAUDE_BIN` names the stand-in and the sandbox's `bin/` is
 * first on `PATH` (`learn/sandbox.ts`). Nothing here special-cases the framework.
 */
export async function runStageEval(
  sandbox: Sandbox,
  selfCommand: readonly [string, string],
  spec: StageEval,
): Promise<EvalRun> {
  const scope = `eval-${spec.stage}`;
  writeWorkspaceFile(sandbox, `.tldrx/workflows/${scope}.yml`, onePreset(scope, spec));

  const created = await tldrx(sandbox, selfCommand, [
    "run", "new", scope, "--title", spec.title, "--scope", scope,
  ]);
  const runId = runIdFrom(created.stdout);
  if (runId === null) {
    throw new Error(`\`tldrx run new ${scope}\` named no run (exit ${String(created.exitCode)}):\n${created.stdout}\n${created.stderr}`);
  }
  const runDir = join(sandbox.workspace, PROJECT_WORK_DIR, runId);

  for (const [rel, content] of Object.entries(spec.seed ?? {})) {
    writeInto(join(runDir, expand(rel, runId)), expand(content, runId));
  }
  for (const [rel, content] of Object.entries(spec.seedWorkspace ?? {})) {
    writeWorkspaceFile(sandbox, expand(rel, runId), expand(content, runId));
  }

  writeScript(sandbox, { version: 1, turns: spec.turns.map((turn) => expandTurn(turn, runId)) });

  const ran = await tldrx(sandbox, selfCommand, ["next", runId]);
  const said = `--- stdout ---\n${ran.stdout}\n--- stderr ---\n${ran.stderr}`;

  return {
    runId,
    runDir,
    exitCode: ran.exitCode,
    stdout: ran.stdout,
    stderr: ran.stderr,
    said,
    read: (rel) => readFileSync(join(runDir, rel), "utf8"),
    readWorkspace: (rel) => readFileSync(join(sandbox.workspace, rel), "utf8"),
    events: readEvents(join(runDir, "events.jsonl")),
  };
}

/**
 * A workflow preset holding exactly this one stage.
 *
 * `skips:` names the other four on purpose: an omission the preset states is a
 * decision on record, which is the same rule every shipped scope follows
 * (`workflows/hotfix.yml`). `default_budget_usd` must be > 0 or the loader
 * refuses the preset (`workflowPreset.ts:171`).
 */
function onePreset(scope: string, spec: StageEval): string {
  const others = ["what", "how", "plan", "build", "watch"].filter((id) => id !== spec.stage);
  return [
    `name: ${scope}`,
    `description: "One stage (${spec.stage}), for the ${spec.stage} eval."`,
    `stages: [${spec.stage}]`,
    `skips: [${others.join(", ")}]`,
    "depth: standard",
    "default_budget_usd: 25",
    `gates: {${spec.stage}: ${spec.gate ?? "human"}}`,
    "",
  ].join("\n");
}

/** `created tldrx-work/260901-eval-what — scope …` → `260901-eval-what`. */
export function runIdFrom(stdout: string): string | null {
  return new RegExp(`${PROJECT_WORK_DIR}/([\\w.-]+)`).exec(stdout)?.[1] ?? null;
}

/** Spawn the REAL `tldrx`, in the synthetic workspace, with the stand-in wired in. */
async function tldrx(
  sandbox: Sandbox,
  selfCommand: readonly [string, string],
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [interpreter, entry] = selfCommand;
  const result = await runtime.spawn(interpreter, [entry, ...args], {
    cwd: sandbox.workspace,
    env: sandboxEnv(sandbox),
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** `{runDir}` → `tldrx-work/<run>`, `{run}` → `<run>`. The learn engine's two placeholders. */
export function expand(text: string, runId: string): string {
  return text.replaceAll("{runDir}", `${PROJECT_WORK_DIR}/${runId}`).replaceAll("{run}", runId);
}

function expandTurn(turn: AgentTurn, runId: string): AgentTurn {
  if (turn.writes === undefined) return turn;
  const writes: Record<string, string> = {};
  for (const [rel, content] of Object.entries(turn.writes)) {
    writes[expand(rel, runId)] = expand(content, runId);
  }
  return { ...turn, writes };
}

export function writeWorkspaceFile(sandbox: Sandbox, rel: string, content: string): void {
  writeInto(join(sandbox.workspace, rel), content);
}

function writeInto(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * `events.jsonl`, parsed. An unreadable line is DROPPED rather than thrown on:
 * the file is append-only and a half-written last line is a real state, and an
 * eval that died parsing the ledger would hide the failure it was reading it for.
 */
export function readEvents(path: string): readonly EventRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: EventRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as EventRecord);
    } catch {
      continue;
    }
  }
  return events;
}

/** Every event of one type, in order. */
export function eventsOfType(events: readonly EventRecord[], type: string): readonly EventRecord[] {
  return events.filter((e) => e.type === type);
}

/**
 * The recorded outcome of one of the stage's `checks:`.
 *
 * Read from `events.jsonl` rather than from stdout: the check's `detail` is a
 * sentence the FRAMEWORK computed (`run/checks.ts`), and the ledger is where it
 * is kept verbatim. Returns null when the check never ran at all — which is a
 * different failure from one that ran and failed, and an assertion should say so.
 */
export function checkOutcome(
  events: readonly EventRecord[],
  id: string,
): { readonly status: string; readonly detail: string } | null {
  for (const e of events) {
    if (e.type !== "check.passed" && e.type !== "check.failed") continue;
    if (e.payload?.check !== id) continue;
    return {
      status: String(e.payload?.status ?? ""),
      detail: String(e.payload?.detail ?? ""),
    };
  }
  return null;
}
