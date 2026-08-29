/**
 * Several runs open at once.
 *
 * The bug this pins: `RunStore.find(root)` used to return the newest UNFINISHED
 * run when no id was given, so with two runs open, touching run B made it the
 * silent default for every later `next`, `answer`, `approve` and `budget raise`.
 * `run new` allows several open runs on purpose (each has its own budget.yml,
 * events.jsonl and epic branch), so the fix is to stop guessing, not to forbid it.
 *
 * The CLI half runs the real binary as a subprocess with `claude` neutralised
 * (`noSpawnEnv`), because the point of the exit-2 refusal is that it happens
 * BEFORE anything is spawned — and a test that could reach a real model to prove
 * that is a test that already failed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { makeWorkspace, FIXTURE_RUN, type TempWorkspace } from "./fixtures/tempWorkspace.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

let workspace: TempRunWorkspace | null = null;
let fixture: TempWorkspace | null = null;

afterEach(() => {
  workspace?.dispose();
  workspace = null;
  fixture?.dispose();
  fixture = null;
});

/** A workspace with `slugs.length` runs, all open, created oldest first. */
function withRuns(...slugs: readonly string[]): { root: string; ids: readonly string[] } {
  workspace = makeRunWorkspace();
  const root = workspace.root;
  const ids = slugs.map((slug, i) =>
    createRun({
      root,
      slug,
      scope: "feature",
      actor: "alan",
      // Distinct days keep the run ids distinct AND the `updated_at` order
      // deterministic — `nowRfc3339` is second-precision, so same-second
      // creations would otherwise tie.
      now: new Date(`2026-08-${String(20 + i).padStart(2, "0")}T09:00:00Z`),
    }).runId,
  );
  return { root, ids };
}

/** Drive every stage of `runId` to `status`, which `deriveRunStatus` rolls up. */
function setEveryStage(root: string, runId: string, status: "done" | "failed"): void {
  const store = RunStore.find(root, runId);
  if (store === null) throw new Error(`no run ${runId}`);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) => ({ ...stage, status })),
    })),
  }));
  store.save();
}

// --- B1: the resolver -------------------------------------------------------

describe("RunStore.findOpen / resolve", () => {
  test("two open runs resolve to `ambiguous`, newest first, instead of a silent pick", () => {
    const { root, ids } = withRuns("alpha", "beta");
    const resolution = RunStore.resolve(root);
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") throw new Error("unreachable");
    expect(resolution.open.map((s) => s.runId)).toEqual([ids[1] as string, ids[0] as string]);
  });

  test("one open run resolves to `one` — today's behaviour, unchanged", () => {
    const { root, ids } = withRuns("alpha");
    const resolution = RunStore.resolve(root);
    expect(resolution.kind).toBe("one");
    if (resolution.kind !== "one") throw new Error("unreachable");
    expect(resolution.store.runId).toBe(ids[0] as string);
  });

  test("no run at all resolves to `none`", () => {
    workspace = makeRunWorkspace();
    expect(RunStore.resolve(workspace.root).kind).toBe("none");
  });

  test("an explicit id still wins, and an unknown one is `none`", () => {
    const { root, ids } = withRuns("alpha", "beta");
    const named = RunStore.resolve(root, ids[0] as string);
    expect(named.kind).toBe("one");
    if (named.kind !== "one") throw new Error("unreachable");
    expect(named.store.runId).toBe(ids[0] as string);
    expect(RunStore.resolve(root, "260101-nope").kind).toBe("none");
    expect(RunStore.find(root, "260101-nope")).toBeNull();
  });

  test("a finished run is not open; a FAILED one still is", () => {
    const { root, ids } = withRuns("alpha", "beta");
    setEveryStage(root, ids[0] as string, "done");
    expect(RunStore.find(root, ids[0] as string)?.run.status).toBe("done");
    expect(RunStore.findOpen(root).map((s) => s.runId)).toEqual([ids[1] as string]);

    setEveryStage(root, ids[1] as string, "failed");
    expect(RunStore.find(root, ids[1] as string)?.run.status).toBe("failed");
    // A failed run is exactly the one about to be retried or rejected.
    expect(RunStore.findOpen(root).map((s) => s.runId)).toEqual([ids[1] as string]);
    expect(RunStore.resolve(root).kind).toBe("one");
  });
});

// --- B2: the CLI refusal ----------------------------------------------------

const AMBIGUOUS_COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ["tldrx next", ["next", "--dry-run"]],
  ["tldrx answer", ["answer", "Q1", "an answer"]],
  ["tldrx approve", ["approve"]],
  ["tldrx reject", ["reject", "--note", "change it"]],
  ["tldrx budget", ["budget", "show"]],
  ["tldrx budget", ["budget", "raise", "01-what", "1"]],
  ["tldrx tickets", ["tickets", "status"]],
  ["tldrx tickets", ["tickets", "sync", "--dry-run", "--provider", "github"]],
  ["tldrx watch", ["watch", "list"]],
  ["tldrx interview", ["interview"]],
  ["tldrx retro", ["retro"]],
  ["tldrx replay", ["replay"]],
];

describe("every command that resolves a run refuses when several are open", () => {
  for (const [label, argv] of AMBIGUOUS_COMMANDS) {
    test(`${argv.join(" ")} exits 2 and names both runs`, async () => {
      const { root, ids } = withRuns("alpha", "beta");
      const result = await tldrx(root, ...argv);
      expect(result.code).toBe(EXIT_GATE_REFUSED);
      expect(result.stderr).toContain(`${label}: 2 runs are open — pass one:`);
      for (const id of ids) expect(result.stderr).toContain(id);
      // The refusal is the whole answer: no stage ran, no gate moved.
      expect(result.stderr).toContain("01-what/what");
    });
  }

  test("the refusal line is `  <id>  <status>  <cursor>  <waiting>`, two-space indented", async () => {
    const { root, ids } = withRuns("alpha", "beta");
    const result = await tldrx(root, "approve");
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("tldrx approve: 2 runs are open — pass one:");
    expect(lines).toHaveLength(3);
    // beta is newer, so it is listed first; the id column is padded to the widest.
    const width = Math.max(...ids.map((id) => id.length));
    expect(lines[1]).toBe(`  ${(ids[1] as string).padEnd(width)}  pending  01-what/what  ready`);
    expect(lines[2]).toBe(`  ${(ids[0] as string).padEnd(width)}  pending  01-what/what  ready`);
  });

  test("`tldrx next` refuses BEFORE it spawns anything", async () => {
    const { root } = withRuns("alpha", "beta");
    const result = await tldrx(root, "next");
    expect(result.code).toBe(EXIT_GATE_REFUSED);
    expect(result.stdout).toBe("");
    // No run was started: neither run.yml moved off `pending`.
    for (const store of RunStore.findOpen(root)) expect(store.run.status).toBe("pending");
  });

  test("an explicit id is never ambiguous — the same commands work", async () => {
    const { root, ids } = withRuns("alpha", "beta");
    const older = ids[0] as string;
    const status = await tldrx(root, "run", "status", older);
    expect(status.code).toBe(EXIT_OK);
    expect(status.stdout).toContain(older);

    const budget = await tldrx(root, "budget", "show", "--run", older);
    expect(budget.code).toBe(EXIT_OK);
    expect(budget.stderr).toBe("");
  });

  test("one open run keeps today's behaviour and exit codes", async () => {
    const { root } = withRuns("alpha");
    const budget = await tldrx(root, "budget", "show");
    expect(budget.code).toBe(EXIT_OK);
    expect(budget.stderr).toBe("");
  });

  test("no run at all still exits 3 with today's wording", async () => {
    workspace = makeRunWorkspace();
    const result = await tldrx(workspace.root, "approve");
    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(result.stderr).toBe("tldrx approve: no non-terminal run in tldrx-work/\n");
  });
});

// --- B3: `run status` with several open -------------------------------------

/** Exactly the keys `run status --json` has returned for one run all along. */
const SINGLE_RUN_KEYS = [
  "run", "title", "scope", "workflow", "repos", "status",
  "cursor", "phases", "budget", "attempts", "build", "waiting",
  // Added deliberately in 0.3.0 (wave G, gate policy). Everything above keeps its
  // position, so a consumer reading `run` or `waiting.kind` is untouched.
  "gates_policy", "gates",
];

describe("tldrx run status with several runs open", () => {
  test("prints a table of every open run and exits 0", async () => {
    const { root, ids } = withRuns("alpha", "beta");
    const result = await tldrx(root, "run", "status");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe("");

    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("2 runs are open — `tldrx run status <id>` for one of them");
    expect(lines[2]).toContain("RUN");
    expect(lines[2]).toContain("STATUS");
    expect(lines[2]).toContain("CURSOR");
    expect(lines[2]).toContain("WAITING");
    expect(lines[2]).toContain("SPENT/CEILING");
    expect(lines[3]).toContain(ids[1] as string);
    expect(lines[3]).toContain("01-what/what");
    expect(lines[3]).toContain("$0.00 / $25.00");
    expect(lines[4]).toContain(ids[0] as string);
  });

  test("--json returns {runs:[…]} holding one full per-run object each", async () => {
    const { root, ids } = withRuns("alpha", "beta");
    const result = await tldrx(root, "run", "status", "--json");
    expect(result.code).toBe(EXIT_OK);

    const parsed = JSON.parse(result.stdout) as { runs: Record<string, unknown>[] };
    expect(Object.keys(parsed)).toEqual(["runs"]);
    expect(parsed.runs.map((r) => r.run)).toEqual([ids[1] as string, ids[0] as string]);
    for (const view of parsed.runs) expect(Object.keys(view)).toEqual(SINGLE_RUN_KEYS);
  });

  test("with exactly ONE open run the JSON shape is unchanged — top-level, same keys", async () => {
    const { root, ids } = withRuns("alpha");
    const result = await tldrx(root, "run", "status", "--json");
    expect(result.code).toBe(EXIT_OK);

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    // The shape brainer's parseRunStatus reads: `run` is a top-level string and
    // `waiting.kind` is one of the six spellings. No `runs` wrapper.
    expect(Object.keys(parsed)).toEqual(SINGLE_RUN_KEYS);
    expect(parsed.run).toBe(ids[0] as string);
    expect(parsed).not.toHaveProperty("runs");
    expect((parsed.waiting as { kind: string }).kind).toBe("ready");
  });

  test("naming one of several open runs still prints that one run's object", async () => {
    const { root, ids } = withRuns("alpha", "beta");
    const result = await tldrx(root, "run", "status", ids[0] as string, "--json");
    expect(result.code).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(SINGLE_RUN_KEYS);
    expect(parsed.run).toBe(ids[0] as string);
  });
});

// --- B4: the `run new` notice -----------------------------------------------

describe("tldrx run new with other runs open", () => {
  test("still creates the run, and says how many others are open", async () => {
    workspace = makeRunWorkspace();
    const root = workspace.root;

    const first = await tldrx(root, "run", "new", "alpha");
    expect(first.code).toBe(EXIT_OK);
    expect(first.stderr).toBe("");

    const second = await tldrx(root, "run", "new", "beta");
    expect(second.code).toBe(EXIT_OK);
    expect(second.stdout).toContain("created");
    expect(second.stderr).toBe(
      "note: 1 other run(s) open — pass a run id to next/answer/approve/… from now on\n",
    );
    expect(RunStore.findOpen(root)).toHaveLength(2);
  });
});

// --- B6: `tickets status` reads process.yml first ---------------------------

describe("tldrx tickets status with no run", () => {
  test("prints the ticket_tool config, then reports no run with exit 3", async () => {
    workspace = makeRunWorkspace({
      files: {
        ".tldrx/process.yml":
          "version: 1\nticket_tool: {kind: linear, project: APP, board: null, sync: mirror-out}\n",
      },
    });
    const result = await tldrx(workspace.root, "tickets", "status");
    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(result.stdout).toContain("ticket_tool linear (APP)");
    expect(result.stdout).toContain("has no adapter");
    expect(result.stderr).toBe("tldrx tickets: no non-terminal run in tldrx-work/\n");
  });

  test("a missing project is reported too, rather than surfacing only at sync time", async () => {
    workspace = makeRunWorkspace({
      files: {
        ".tldrx/process.yml":
          "version: 1\nticket_tool: {kind: github, project: null, board: null, sync: mirror-out}\n",
      },
    });
    const result = await tldrx(workspace.root, "tickets", "status");
    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(result.stdout).toContain("ticket_tool.project is required for the github provider");
  });

  test("no process.yml at all says so and still exits 3", async () => {
    workspace = makeRunWorkspace();
    const result = await tldrx(workspace.root, "tickets", "status");
    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(result.stdout).toContain("no .tldrx/process.yml");
  });
});

// --- B5: the hooks ----------------------------------------------------------

interface HookRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function hook(name: string, payload: unknown): Promise<HookRun> {
  const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", `${name}.ts`)], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...noSpawnEnv(), USER: "alan" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function denial(run: HookRun): string | null {
  if (run.stdout.trim() === "") return null;
  const out = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  if (out.hookSpecificOutput?.permissionDecision !== "deny") return null;
  return out.hookSpecificOutput.permissionDecisionReason ?? "";
}

/** The hooks fixture, with its one run cloned to a SECOND open run id. */
function twoRunFixture(): { root: string; runDir: string; second: string } {
  fixture = makeWorkspace();
  const second = "260829-second";
  const dir = join(fixture.root, "tldrx-work", second);
  cpSync(fixture.runDir, dir, { recursive: true });
  const runYml = join(dir, "run.yml");
  writeFileSync(
    runYml,
    readFileSync(runYml, "utf8")
      .replace(`run: ${FIXTURE_RUN}`, `run: ${second}`)
      // Newer than the original, so a "newest" fallback would pick THIS one.
      .replace(/updated_at: .*/, "updated_at: 2026-08-29T10:00:00Z"),
    "utf8",
  );
  return { root: fixture.root, runDir: fixture.runDir, second };
}

describe("hooks with several runs open", () => {
  test("statusline shows the newest run and marks the others", async () => {
    const { root, second } = twoRunFixture();
    const result = await hook("statusline", {
      model: { display_name: "Sonnet" },
      context_window: { used_percentage: 16 },
      cost: { total_cost_usd: 3.75 },
      workspace: { project_dir: root },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(`[tldrx] ${second} (+1 open) · `);
    expect(result.stdout).not.toContain("(+0 open)");
  });

  test("statusline shows no marker when only one run is open", async () => {
    fixture = makeWorkspace();
    const result = await hook("statusline", {
      model: { display_name: "Sonnet" },
      context_window: { used_percentage: 16 },
      cost: { total_cost_usd: 3.75 },
      workspace: { project_dir: fixture.root },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(`[tldrx] ${FIXTURE_RUN} · `);
    expect(result.stdout).not.toContain("open)");
  });

  test("session-start lists every open run and still never blocks", async () => {
    const { root, second } = twoRunFixture();
    const result = await hook("session-start", { hook_event_name: "SessionStart", cwd: root });
    expect(result.code).toBe(EXIT_OK);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string };
    };
    const context = out.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("2 runs are open");
    expect(context).toContain(second);
    expect(context).toContain(FIXTURE_RUN);
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  test("claim-sources still judges the file's OWN run, whichever is newest", async () => {
    const { runDir } = twoRunFixture();
    // The older run's handoff, while the newer run is the "newest open" one.
    const path = join(runDir, "02-how", "handoff.md");
    const unsourced = [
      "# Handoff", "", "## Findings", "- A claim with no source",
      "", "## Decisions", "- Ship it [src: F001]",
      "", "## Unknowns", "- none [src: absent:x]",
      "", "## Evidence ledger", "- Ran it [src: F001]", "",
    ].join("\n");
    const result = await hook("claim-sources", {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path, content: unsourced },
    });
    expect(denial(result)).toContain("claim-sources");
    expect(denial(result)).toContain("02-how/handoff.md");
  });

  test("no-re-ask and dod-gate are unreachable from outside a run dir, ambiguity or not", async () => {
    const { root } = twoRunFixture();
    const outside = join(root, "questions.md");
    const reask = await hook("no-reask", {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: outside, content: "## Q9 · Anything?\n" },
    });
    expect(denial(reask)).toBeNull();

    const dod = await hook("dod-gate", {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(root, "stories", "S9.md"), content: "status: done\n" },
    });
    expect(denial(dod)).toBeNull();
  });

  test("budget-gate still denies, and resolves cwd > --run > newest without ambiguity", async () => {
    const { root, runDir, second } = twoRunFixture();
    // Both runs are identical clones: $3.75 spent, a $3.00 estimate and $0.61
    // left in 02-how, so the gate denies whichever one it resolves — and the
    // message names it. That makes "which run did it pick?" observable.
    const inOlder = await hook("budget-gate", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: runDir,
      tool_input: { command: "tldrx next" },
    });
    expect(inOlder.code).toBe(EXIT_OK);
    expect(denial(inOlder)).toContain("budget-gate: refusing to start stage");
    // Standing IN the older run beats the newer "newest open" one.
    expect(denial(inOlder)).toContain(`--run ${FIXTURE_RUN}`);
    expect(denial(inOlder)).not.toContain(second);

    // `--run <id>` in the command wins over the cwd.
    const named = await hook("budget-gate", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: root,
      tool_input: { command: `tldrx next --run ${second}` },
    });
    expect(named.code).toBe(EXIT_OK);
    expect(denial(named)).toContain(`--run ${second}`);

    // Neither: the newest open run, and STILL a deny. A gate that stopped
    // gating because a second run exists would be the worst outcome here.
    const neither = await hook("budget-gate", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: root,
      tool_input: { command: "tldrx next" },
    });
    expect(neither.code).toBe(EXIT_OK);
    expect(denial(neither)).toContain(`--run ${second}`);
    expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);
  });
});
