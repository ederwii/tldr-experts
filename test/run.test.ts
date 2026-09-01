import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { parseYaml } from "../src/core/yaml.ts";
import { validateRunFile, type RunFile } from "../src/core/run/RunFile.ts";
import { validateRunBudget } from "../src/core/budget/RunBudget.ts";
import { validateFactsFile } from "../src/core/facts/validateFactsFile.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { validateEvent } from "../src/core/events/Event.ts";
import { EXIT_GATE_REFUSED, EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { gatedScope, makeRunWorkspace, type TempRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { loadWorkflowPreset } from "../src/core/run/workflowPreset.ts";
import { runCheck } from "../src/core/run/checks.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// Every test in this file spawns a REAL process — git, `bun`, the CLI. Process cost is a
// property of the machine, not of the code, so bun's fixed 5000 ms default measures the box:
// on an untouched tree, tests here timed out while the same files passed alone (#43). The
// budget scales with measured load; the assertions are untouched, and a hang is still caught.
setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function tldrx(cwd: string, ...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

let workspace: TempRunWorkspace | null = null;

afterEach(() => {
  workspace?.dispose();
  workspace = null;
});

function fresh(options?: Parameters<typeof makeRunWorkspace>[0]): TempRunWorkspace {
  workspace = makeRunWorkspace(options);
  return workspace;
}

function onlyRunDir(root: string): string {
  const work = join(root, "tldrx-work");
  const entries = readdirSync(work).filter((name) => !name.startsWith("."));
  expect(entries.length).toBe(1);
  return join(work, entries[0] as string);
}

function loadRun(runDir: string): RunFile {
  const doc = parseYaml(readFileSync(join(runDir, "run.yml"), "utf8"));
  expect(validateRunFile(doc).issues).toEqual([]);
  return doc as RunFile;
}

function events(runDir: string): Record<string, unknown>[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("tldrx run new", () => {
  test("the feature preset writes a valid run.yml, budget.yml and events.jsonl", async () => {
    const ws = fresh();
    const run = await tldrx(ws.root, "run", "new", "leaderboard", "--title", "Player leaderboard");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);

    const runDir = onlyRunDir(ws.root);
    const doc = loadRun(runDir);
    expect(doc.run).toMatch(/^\d{6}-leaderboard$/);
    expect(doc.title).toBe("Player leaderboard");
    expect(doc.scope).toBe("feature");
    expect(doc.repos).toEqual(["api", "lab"]);
    expect(doc.phases.map((p) => p.id)).toEqual(["01-what", "02-how", "03-plan", "04-build", "05-watch"]);
    expect(doc.cursor).toEqual({ phase: "01-what", stage: "what", task: null });

    const budget = parseYaml(readFileSync(join(runDir, "budget.yml"), "utf8"));
    expect(validateRunBudget(budget).issues).toEqual([]);

    for (const event of events(runDir)) expect(validateEvent(event).issues).toEqual([]);
    expect(events(runDir)[0]?.type).toBe("run.created");
  });

  test("every stage starts `pending` and every phase folder exists", async () => {
    const ws = fresh();
    expect((await tldrx(ws.root, "run", "new", "leaderboard")).code).toBe(EXIT_OK);
    const runDir = onlyRunDir(ws.root);
    const doc = loadRun(runDir);
    for (const phase of doc.phases) {
      expect(existsSync(join(runDir, phase.id))).toBe(true);
      expect(phase.status).toBe("pending");
      for (const stage of phase.stages) {
        expect(stage.status).toBe("pending");
        expect(stage.cost_usd).toBe(0);
        expect(stage.tasks).toEqual([]);
      }
    }
    expect(doc.status).toBe("pending");
    expect(doc.budget.spent_usd).toBe(0);
  });

  test("the bugfix preset uses its own ceiling and splits it across the phases", async () => {
    const ws = fresh();
    expect((await tldrx(ws.root, "run", "new", "npe-on-save", "--scope", "bugfix")).code).toBe(EXIT_OK);
    const runDir = onlyRunDir(ws.root);
    const doc = loadRun(runDir);
    expect(doc.scope).toBe("bugfix");
    expect(doc.budget.ceiling_usd).toBe(10);

    const budget = parseYaml(readFileSync(join(runDir, "budget.yml"), "utf8")) as {
      ceiling_usd: number;
      phases: { id: string; ceiling_usd: number }[];
    };
    const sum = budget.phases.reduce((n, p) => n + p.ceiling_usd, 0);
    expect(sum).toBeLessThanOrEqual(budget.ceiling_usd + 1e-9);
    // Proportional to the stages' declared budgets: what=4 of 25 -> 40% of $10.
    expect(budget.phases.find((p) => p.id === "01-what")?.ceiling_usd).toBeCloseTo(1.6, 2);
    expect(budget.phases.find((p) => p.id === "04-build")?.ceiling_usd).toBeCloseTo(3.6, 2);
  });

  test("--budget rescales the phase ceilings", async () => {
    const ws = fresh();
    expect((await tldrx(ws.root, "run", "new", "big", "--budget", "50")).code).toBe(EXIT_OK);
    const doc = loadRun(onlyRunDir(ws.root));
    expect(doc.budget.ceiling_usd).toBe(50);
    expect(doc.phases[0]?.stages[0]?.budget_usd).toBeCloseTo(8, 2);
  });

  test("--repos must name repos workspace.yml knows", async () => {
    const ws = fresh();
    const run = await tldrx(ws.root, "run", "new", "x", "--repos", "api,ghost");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("ghost");
    expect(existsSync(join(ws.root, "tldrx-work"))).toBe(false);
  });

  test("a bad slug is refused and nothing is written", async () => {
    const ws = fresh();
    const run = await tldrx(ws.root, "run", "new", "Not A Slug");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(existsSync(join(ws.root, "tldrx-work"))).toBe(false);
  });

  test("creating the same run twice is refused", async () => {
    const ws = fresh();
    expect((await tldrx(ws.root, "run", "new", "dupe")).code).toBe(EXIT_OK);
    const again = await tldrx(ws.root, "run", "new", "dupe");
    expect(again.code).toBe(EXIT_USAGE);
    expect(again.stderr).toContain("already exists");
  });

  test("a failing --from leaves no run and no temp directory behind", async () => {
    const ws = fresh();
    const run = await tldrx(ws.root, "run", "new", "ghost", "--from", join(ws.root, "nope"));
    expect(run.code).toBe(EXIT_USAGE);
    const work = join(ws.root, "tldrx-work");
    if (existsSync(work)) expect(readdirSync(work)).toEqual([]);
  });

  test("an unknown scope names the scope rather than guessing one", async () => {
    const ws = fresh();
    const run = await tldrx(ws.root, "run", "new", "x", "--scope", "not-a-scope");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("not-a-scope");
  });
});

describe("tldrx run status", () => {
  test("renders the run, the cursor, a bar per phase and the budget", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard", "--title", "Player leaderboard");
    const status = await tldrx(ws.root, "run", "status");
    expect(status.code).toBe(EXIT_OK);
    expect(status.stdout).toContain("Player leaderboard");
    expect(status.stdout).toContain("scope feature");
    expect(status.stdout).toContain("cursor 01-what / what");
    expect(status.stdout).toContain("[░░░░░] 0/1 stages");
    expect(status.stdout).toContain("$0.00 spent of $25.00 ceiling");
    expect(status.stdout).toContain("tldrx next");
  });

  test("--json emits the same view as data", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const status = await tldrx(ws.root, "run", "status", "--json");
    expect(status.code).toBe(EXIT_OK);
    const view = JSON.parse(status.stdout) as {
      run: string;
      phases: { id: string; done: number; total: number; bar: string }[];
      budget: { ceiling_usd: number; spent_usd: number; remaining_usd: number };
      waiting: { kind: string; questions: string[] };
    };
    expect(view.run).toMatch(/-leaderboard$/);
    expect(view.phases).toHaveLength(5);
    expect(view.phases[0]).toMatchObject({ id: "01-what", done: 0, total: 1, bar: "░░░░░" });
    expect(view.budget).toEqual({ ceiling_usd: 25, spent_usd: 0, remaining_usd: 25 });
    expect(view.waiting.kind).toBe("ready");
  });

  test("an unknown run exits 3", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const status = await tldrx(ws.root, "run", "status", "260101-nope");
    expect(status.code).toBe(EXIT_NOT_FOUND);
    expect(status.stdout).toBe("");
  });

  test("with no runs at all it exits 3 rather than inventing one", async () => {
    const ws = fresh();
    const status = await tldrx(ws.root, "run", "status");
    expect(status.code).toBe(EXIT_NOT_FOUND);
  });
});

// --- gates -----------------------------------------------------------------

/** The smallest §2.8-valid handoff — one sourced bullet, four sections, in order. */
const MINIMAL_HANDOFF = `# Handoff — 01-what / what — run X

## Findings
- No ranking store exists yet [src: absent:.tldrx/map/domains.md]

## Decisions
- none [src: absent:.tldrx/memory/facts.yml]

## Unknowns
- none [src: absent:.tldrx/memory/facts.yml]

## Evidence ledger
- none [src: absent:.tldrx/memory/facts.yml]
`;

const ROOT_QUESTION = `# Questions — 01-what — run X

## Q1 · Where does leaderboard state live?
<!-- id: Q1 | status: open | area: data-model | asked_by: product | asked_at: 2026-08-28T14:02:11Z -->
Why asked: no ranking store exists in the map [src: absent:.tldrx/map/domains.md]

[Answer]:
`;

/** Put the cursor stage into the one state a gate is allowed to act on. */
function parkAtGate(runDir: string): void {
  parkAt(runDir, "awaiting_gate");
}

function parkAt(runDir: string, status: "awaiting_gate" | "failed"): void {
  const store = RunStore.open(runDir);
  store.mutate((run) => ({
    ...run,
    phases: run.phases.map((phase) =>
      phase.id !== run.cursor.phase
        ? phase
        : {
            ...phase,
            stages: phase.stages.map((stage) =>
              stage.id === run.cursor.stage
                ? { ...stage, status, started_at: "2026-08-28T09:00:00Z" }
                : stage,
            ),
          },
    ),
  }));
  store.save();
}

describe("tldrx approve", () => {
  test("advances the cursor and records who approved when the checks pass", async () => {
    const ws = fresh({ files: gatedScope("true") });
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    writeFileSync(join(runDir, "01-what", "handoff.md"), MINIMAL_HANDOFF, "utf8");
    parkAtGate(runDir);

    const approved = await tldrx(ws.root, "approve", "--note", "looks right");
    expect(approved.stderr).toBe("");
    expect(approved.code).toBe(EXIT_OK);
    expect(approved.stdout).toContain("approved 01-what/what");
    expect(approved.stdout).toContain("cursor → 02-how/how");

    const doc = loadRun(runDir);
    const what = doc.phases[0]?.stages[0];
    expect(what?.status).toBe("done");
    expect(what?.gate.status).toBe("approved");
    expect(what?.gate.by).not.toBeNull();
    expect(what?.gate.at).not.toBeNull();
    expect(what?.gate.note).toBe("looks right");
    expect(doc.cursor).toEqual({ phase: "02-how", stage: "how", task: null });
    expect(doc.phases[1]?.stages[0]?.status).toBe("ready");
    expect(doc.phases[0]?.status).toBe("done");

    const types = events(runDir).map((e) => e.type);
    expect(types).toContain("gate.approved");
    expect(types).toContain("stage.done");
  });

  test("refuses when the stage declared a handoff it never wrote", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    parkAtGate(onlyRunDir(ws.root));
    const run = await tldrx(ws.root, "approve");
    expect(run.code).toBe(EXIT_GATE_REFUSED);
    expect(run.stderr).toContain("claim-sources");
    expect(run.stderr).toContain("never written");
  });

  test("refuses with exit 2 when the cursor stage is not awaiting a gate", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const run = await tldrx(ws.root, "approve");
    expect(run.code).toBe(EXIT_GATE_REFUSED);
    expect(run.stderr).toContain("awaiting_gate");
    expect(run.stdout).toBe("");
  });

  test("a failing `cmd` check refuses the gate, names the check, and changes nothing", async () => {
    const ws = fresh({ files: gatedScope("false") });
    await tldrx(ws.root, "run", "new", "broken", "--scope", "gated");
    const runDir = onlyRunDir(ws.root);
    parkAtGate(runDir);
    const before = readFileSync(join(runDir, "run.yml"), "utf8");

    const run = await tldrx(ws.root, "approve");
    expect(run.code).toBe(EXIT_GATE_REFUSED);
    expect(run.stderr).toContain("cmd");
    expect(run.stderr).toContain("exited 1");
    expect(run.stdout).toBe("");
    expect(readFileSync(join(runDir, "run.yml"), "utf8")).toBe(before);
    expect(events(runDir).map((e) => e.type)).toContain("check.failed");
  });

  test("a passing `cmd` check approves and is recorded as a check.passed event", async () => {
    const ws = fresh({ files: gatedScope("true") });
    await tldrx(ws.root, "run", "new", "ok-run", "--scope", "gated");
    const runDir = onlyRunDir(ws.root);
    parkAtGate(runDir);

    const run = await tldrx(ws.root, "approve");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("cmd:passed");
    // One stage in the scope, so approving it finishes the run.
    expect(loadRun(runDir).status).toBe("done");
    expect(events(runDir).map((e) => e.type)).toContain("run.closed");
  });

  test("a stage may not invent a command workspace.yml does not declare", async () => {
    const ws = fresh({ files: gatedScope("rm -rf /") });
    await tldrx(ws.root, "run", "new", "evil", "--scope", "gated");
    parkAtGate(onlyRunDir(ws.root));
    const run = await tldrx(ws.root, "approve");
    expect(run.code).toBe(EXIT_GATE_REFUSED);
    expect(run.stderr).toContain("not one of .tldrx/workspace.yml's commands");
  });
});

/**
 * The measured pilot failure (2026-08-29): the `what` sub-agent cited its own
 * outputs run-relatively (`[src: 01-what/intent.md:1]`) and the post-stage check
 * rejected them, because the resolver only ever tried the workspace root.
 *
 * The three places that validate a handoff — the facilitator's post-stage check
 * (`runNext.finishStage` → `runChecks`), `tldrx approve`'s re-check (`gates.approve`
 * → `runChecks`), and the PreToolUse hook — must agree on the same bytes, or a
 * write that the hook allows fails the gate that follows it.
 */
describe("run-relative `[src: …]` — next, approve and the hook agree", () => {
  function handoffCiting(src: string, marker = "-"): string {
    return [
      "# Handoff — 01-what / what — run X",
      "",
      "## Findings",
      `${marker} The intent names the leaderboard [src: ${src}]`,
      "",
      "## Decisions",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Unknowns",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
      "## Evidence ledger",
      "- none [src: absent:.tldrx/memory/facts.yml]",
      "",
    ].join("\n");
  }

  async function hookVerdict(filePath: string, content: string): Promise<boolean> {
    const proc = Bun.spawn(["bun", join(FRAMEWORK_ROOT, "src", "hooks", "claim-sources.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath, content },
      })),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, USER: "alan" },
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return !stdout.includes('"permissionDecision":"deny"');
  }

  /** Exactly the call `runNext.finishStage` makes for the cursor stage. */
  async function facilitatorVerdict(root: string, runDir: string): Promise<boolean> {
    const stage = loadWorkflowPreset(root, "feature").stages[0];
    expect(stage).toBeDefined();
    const outcome = await runCheck({ id: "claim-sources", on: "post-write", repo: null, command: null, expect_exit: 0 }, {
      root,
      runDir,
      stage: stage as NonNullable<typeof stage>,
    });
    return outcome.status === "passed";
  }

  async function verdictsOf(
    content: string,
  ): Promise<{ hook: boolean; facilitator: boolean; approve: boolean }> {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    writeFileSync(join(runDir, "01-what", "intent.md"), "# Intent\n\nA leaderboard.\n", "utf8");
    const handoffFile = join(runDir, "01-what", "handoff.md");

    const hook = await hookVerdict(handoffFile, content);
    writeFileSync(handoffFile, content, "utf8");
    const facilitator = await facilitatorVerdict(ws.root, runDir);
    parkAtGate(runDir);
    const approved = await tldrx(ws.root, "approve", "--note", "ok");
    return { hook, facilitator, approve: approved.code === EXIT_OK };
  }

  async function verdicts(
    src: string,
    marker?: string,
  ): Promise<{ hook: boolean; facilitator: boolean; approve: boolean }> {
    return await verdictsOf(handoffCiting(src, marker));
  }

  test("all three refuse a checked section that holds only prose (spec §2.8)", async () => {
    const prosey = handoffCiting("01-what/intent.md:1")
      .replace("- none [src: absent:.tldrx/memory/facts.yml]\n\n## Unknowns", "- none [src: absent:.tldrx/memory/facts.yml]\n\n## Unknowns")
      .replace(/## Unknowns\n- none \[src: absent:[^\]]*\]/, "## Unknowns\nNothing we could not answer from the map.");
    expect(prosey).toContain("Nothing we could not answer");
    expect(await verdictsOf(prosey)).toEqual({ hook: false, facilitator: false, approve: false });
  });

  test("all three accept a bullet citing the run's own output", async () => {
    expect(await verdicts("01-what/intent.md:1")).toEqual({ hook: true, facilitator: true, approve: true });
  });

  test("all three accept a workspace-relative path", async () => {
    expect(await verdicts(".tldrx/memory/facts.yml:1")).toEqual({ hook: true, facilitator: true, approve: true });
  });

  test("all three reject an out-of-range line on a file that does resolve", async () => {
    expect(await verdicts("01-what/intent.md:999")).toEqual({ hook: false, facilitator: false, approve: false });
  });

  test("all three reject a path that exists under no base", async () => {
    expect(await verdicts("01-what/nope.md:1")).toEqual({ hook: false, facilitator: false, approve: false });
  });

  test("all three hold a numbered item to the same rule as a bullet", async () => {
    expect(await verdicts("01-what/intent.md:1", "1.")).toEqual({ hook: true, facilitator: true, approve: true });
    expect(await verdicts("01-what/nope.md:1", "1.")).toEqual({ hook: false, facilitator: false, approve: false });
  });
});

describe("tldrx reject", () => {
  test("sends the stage back to ready and stores the note", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    parkAtGate(runDir);

    const run = await tldrx(ws.root, "reject", "--note", "the scope section is empty");
    expect(run.code).toBe(EXIT_OK);
    const doc = loadRun(runDir);
    const what = doc.phases[0]?.stages[0];
    expect(what?.status).toBe("ready");
    expect(what?.gate.status).toBe("rejected");
    expect(what?.gate.note).toBe("the scope section is empty");
    expect(doc.cursor).toEqual({ phase: "01-what", stage: "what", task: null });
    expect(events(runDir).map((e) => e.type)).toContain("gate.rejected");
  });

  test("refuses without a note", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    parkAtGate(onlyRunDir(ws.root));
    const run = await tldrx(ws.root, "reject");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("--note");
  });

  test("refuses with exit 2 when no gate is pending", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const run = await tldrx(ws.root, "reject", "--note", "nope");
    expect(run.code).toBe(EXIT_GATE_REFUSED);
    expect(run.stderr).toContain("`awaiting_gate` or `failed`");
  });

  // Spec §5 failure path: after `stage.failed` the operator may retry with `next`
  // OR reject with a note. Rejecting used to be refused, leaving retry as the
  // only move out of a failure.
  test("a failed stage may be rejected, and goes back to ready with the note", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    parkAt(runDir, "failed");

    const run = await tldrx(ws.root, "reject", "--note", "the handoff cites nothing");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain("(it had failed)");
    expect(run.stdout).toContain("the note goes into the next prompt");

    const what = loadRun(runDir).phases[0]?.stages[0];
    expect(what?.status).toBe("ready");
    expect(what?.gate.note).toBe("the handoff cites nothing");
  });
});

describe("tldrx answer", () => {
  const QUESTIONS = `# Questions — 01-what — run X

## Q1 · Where does leaderboard state live?
<!-- id: Q1 | status: open | area: data-model | asked_by: product | asked_at: 2026-08-28T14:02:11Z -->
Why asked: no ranking store exists in the map [src: absent:.tldrx/map/domains.md]

- A) New Postgres table
- B) Redis sorted set

[Answer]:
`;

  test("records the answer, the fact and the event, and prints the fact id", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    writeFileSync(join(runDir, "01-what", "questions.md"), QUESTIONS, "utf8");

    const run = await tldrx(ws.root, "answer", "Q1", "A", "—", "a new Postgres table");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toMatch(/Q1 answered → F\d{3,6}/);

    const written = readFileSync(join(runDir, "01-what", "questions.md"), "utf8");
    expect(written).toContain("status: answered");
    expect(written).toContain("[Answer]: A — a new Postgres table");
    expect(written).toContain("answered_by:");

    const facts = parseYaml(readFileSync(join(ws.root, ".tldrx", "memory", "facts.yml"), "utf8")) as {
      facts: { fact: string; kind: string; confidence: string; area: string; source: { q: string; run: string } }[];
    };
    expect(validateFactsFile(facts).issues).toEqual([]);
    expect(facts.facts).toHaveLength(1);
    expect(facts.facts[0]).toMatchObject({ kind: "answer", confidence: "stated", area: "data-model" });
    expect(facts.facts[0]?.source.q).toBe("Q1");
    expect(facts.facts[0]?.fact).toContain("a new Postgres table");

    const types = events(runDir).map((e) => e.type);
    expect(types).toContain("question.answered");
    expect(types).toContain("fact.added");
  });

  test("answering the same question twice is refused", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    writeFileSync(join(runDir, "01-what", "questions.md"), QUESTIONS, "utf8");
    expect((await tldrx(ws.root, "answer", "Q1", "A")).code).toBe(EXIT_OK);
    const again = await tldrx(ws.root, "answer", "Q1", "B");
    expect(again.code).toBe(EXIT_NOT_FOUND);
  });

  test("an unknown question id exits 3", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const run = await tldrx(ws.root, "answer", "Q9", "anything");
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stdout).toBe("");
  });

  test("an answer with no text is a usage error", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const run = await tldrx(ws.root, "answer", "Q1");
    expect(run.code).toBe(EXIT_USAGE);
  });

  test("answering an answered question names the way through", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    writeFileSync(join(runDir, "01-what", "questions.md"), QUESTIONS, "utf8");
    await tldrx(ws.root, "answer", "Q1", "A");
    const again = await tldrx(ws.root, "answer", "Q1", "B");
    expect(again.code).toBe(EXIT_NOT_FOUND);
    expect(again.stderr).toContain("--supersede");
  });
});

/**
 * `tldrx answer <Qn> "…" --supersede` — an owner REVERSING a recorded decision.
 *
 * The gap, measured 2026-08-31 on a live run: the risk behind an answered
 * decision was refuted, the owner reversed the call, and `tldrx answer` refused
 * because the question was no longer open. `superseded_by` had been in the §2.5
 * schema from the first draft and NO command wrote it, so the only route was a
 * hand edit — and a hand edit that left `superseded_by: null` left the reversed
 * decision inside `FactsStore.active`, which every stage reads as never-re-ask
 * truth. The verb writes both halves of the link so that cannot happen.
 */
describe("tldrx answer --supersede", () => {
  const QUESTIONS = `# Questions — 01-what — run X

## Q1 · Where does leaderboard state live?
<!-- id: Q1 | status: open | area: data-model | asked_by: product | asked_at: 2026-08-28T14:02:11Z -->
Why asked: no ranking store exists in the map [src: absent:.tldrx/map/domains.md]

- A) New Postgres table
- B) Redis sorted set

[Answer]:
`;

  interface FactRow {
    readonly id: string;
    readonly fact: string;
    readonly area: string;
    readonly supersedes: string | null;
    readonly superseded_by: string | null;
    readonly source: { q: string; run: string; who: string };
  }

  function facts(root: string): readonly FactRow[] {
    const doc = parseYaml(readFileSync(join(root, ".tldrx", "memory", "facts.yml"), "utf8"));
    expect(validateFactsFile(doc).issues).toEqual([]);
    return (doc as { facts: FactRow[] }).facts;
  }

  async function answered(): Promise<{ root: string; runDir: string; questions: string }> {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    const questions = join(runDir, "01-what", "questions.md");
    writeFileSync(questions, QUESTIONS, "utf8");
    const first = await tldrx(ws.root, "answer", "Q1", "A", "—", "a new Postgres table");
    expect(first.code).toBe(EXIT_OK);
    return { root: ws.root, runDir, questions };
  }

  test("writes a new fact, links the old one, and leaves the old text alone", async () => {
    const ws = await answered();
    const run = await tldrx(ws.root, "answer", "Q1", "B — Redis, the contention risk was refuted", "--supersede");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toMatch(/Q1 superseded → F\d{3,6} replaces F\d{3,6} \(area data-model\)/);

    const rows = facts(ws.root);
    expect(rows).toHaveLength(2);
    const [old, fresh_] = rows as [FactRow, FactRow];
    // The old row keeps every byte of its text — history is appended to, not edited.
    expect(old.fact).toContain("a new Postgres table");
    expect(old.superseded_by).toBe(fresh_.id);
    expect(old.supersedes).toBeNull();
    // The new row carries the WHOLE new answer, the same area, and normal provenance.
    expect(fresh_.fact).toContain("B — Redis, the contention risk was refuted");
    expect(fresh_.area).toBe("data-model");
    expect(fresh_.supersedes).toBe(old.id);
    expect(fresh_.superseded_by).toBeNull();
    expect(fresh_.source.q).toBe("Q1");
    expect(fresh_.source.run).toMatch(/leaderboard$/);

    // The block gains a footer; the original [Answer]: line and its footer stand.
    const written = readFileSync(ws.questions, "utf8");
    expect(written).toContain("[Answer]: A — a new Postgres table");
    expect(written).toContain(`fact: ${old.id} -->`);
    expect(written).toContain(`[Answer superseding ${old.id}]: B — Redis, the contention risk was refuted`);
    expect(written).toContain(`reanswered_by:`);
    expect(written).toContain(`| fact: ${fresh_.id} | supersedes: ${old.id} -->`);
    expect(written).toContain("status: answered");

    // `fact.added` for the new row keeps "every row has one" true; `fact.superseded`
    // is the reversal itself.
    const log = events(ws.runDir);
    expect(log.filter((e) => e.type === "fact.added")).toHaveLength(2);
    const reversal = log.filter((e) => e.type === "fact.superseded");
    expect(reversal).toHaveLength(1);
    expect(reversal[0]?.payload).toMatchObject({ q: "Q1", fact: fresh_.id, supersedes: old.id });
  });

  test("a second reversal supersedes the SECOND fact, not the first", async () => {
    const ws = await answered();
    await tldrx(ws.root, "answer", "Q1", "B — Redis", "--supersede");
    const again = await tldrx(ws.root, "answer", "Q1", "A after all — Redis eviction loses the board", "--supersede");
    expect(again.code).toBe(EXIT_OK);

    const rows = facts(ws.root);
    expect(rows.map((r) => r.superseded_by)).toEqual([rows[1]?.id ?? "", rows[2]?.id ?? "", null]);
    expect(rows.map((r) => r.supersedes)).toEqual([null, rows[0]?.id ?? "", rows[1]?.id ?? ""]);
  });

  test("--supersede on an OPEN question is refused — there is nothing to supersede", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    writeFileSync(join(runDir, "01-what", "questions.md"), QUESTIONS, "utf8");

    const run = await tldrx(ws.root, "answer", "Q1", "B", "--supersede");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Q1 is open — nothing to supersede");
    // Nothing was written: no fact, and the slot is still empty.
    expect(facts(ws.root)).toHaveLength(0);
    expect(readFileSync(join(runDir, "01-what", "questions.md"), "utf8")).toContain("[Answer]:\n");
  });

  test("an unknown question id exits 3", async () => {
    const ws = await answered();
    const run = await tldrx(ws.root, "answer", "Q9", "anything", "--supersede");
    expect(run.code).toBe(EXIT_NOT_FOUND);
    expect(run.stdout).toBe("");
  });

  test("a supersession with no text is a usage error", async () => {
    const ws = await answered();
    const run = await tldrx(ws.root, "answer", "Q1", "--supersede");
    expect(run.code).toBe(EXIT_USAGE);
    expect(facts(ws.root)).toHaveLength(1);
  });

  /**
   * The emitter that broke `run.yml` on 2026-08-31 is the one that writes fact
   * text, so a multi-paragraph reversal is exactly the input that used to write
   * literal newlines into a double-quoted flow scalar. It must survive the round
   * trip through both parsers behind the runtime seam, which `validateFactsFile`
   * on a re-read of the file proves.
   */
  test("a multi-paragraph answer round-trips through the emitter", async () => {
    const ws = await answered();
    const prose = "Redis sorted set.\n\nThe load test refuted the write-contention risk: 12k writes/s\n"
      + "at p99 4ms, with a \"hot key\" fanned across 16 shards.";
    const run = await tldrx(ws.root, "answer", "Q1", prose, "--supersede");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);

    // Re-read from disk, through the real validator: the file still parses.
    const rows = facts(ws.root);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.fact).toContain(prose);
    // And the run is still usable — a broken facts.yml would take the next command down.
    expect((await tldrx(ws.root, "status")).code).toBe(EXIT_OK);
  });

  test("tldrx replay narrates the reversal", async () => {
    const ws = await answered();
    await tldrx(ws.root, "answer", "Q1", "B — Redis, the contention risk was refuted", "--supersede");
    const replay = await tldrx(ws.root, "replay");
    expect(replay.code).toBe(EXIT_OK);
    expect(replay.stdout).toMatch(/fact F\d{3,6} SUPERSEDED by F\d{3,6} \(Q1\)/);
    expect(replay.stdout).toContain("the contention risk was refuted");
  });
});

/**
 * `--root <path>` on the run-lifecycle commands (spec §3).
 *
 * Every test here runs from a directory that has no `.tldrx/` anywhere above it,
 * so without `--root` each command would fail with the "run `tldrx init` first"
 * usage error. Reaching the workspace at all is the proof.
 */
describe("--root from a foreign cwd", () => {
  let foreign = "";

  beforeEach(() => {
    foreign = mkdtempSync(join(tmpdir(), "tldrx-foreign-"));
  });

  afterEach(() => {
    if (foreign !== "") rmSync(foreign, { recursive: true, force: true });
    foreign = "";
  });

  test("without --root the same cwd has no workspace at all", async () => {
    const run = await tldrx(foreign, "run", "status");
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stderr).toContain("run `tldrx init` first");
  });

  test("run new writes into the --root workspace", async () => {
    const ws = fresh();
    const run = await tldrx(foreign, "run", "new", "leaderboard", "--root", ws.root);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(existsSync(join(onlyRunDir(ws.root), "run.yml"))).toBe(true);
    expect(readdirSync(foreign)).toEqual([]);
  });

  test("run status reads the --root workspace", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const run = await tldrx(foreign, "run", "status", "--root", ws.root, "--json");
    expect(run.code).toBe(EXIT_OK);
    expect((JSON.parse(run.stdout) as { run: string }).run).toMatch(/-leaderboard$/);
  });

  test("next --prepare targets the --root workspace", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const run = await tldrx(foreign, "next", "--prepare", "--root", ws.root);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(existsSync(join(onlyRunDir(ws.root), ".agent", "what", "prompt.md"))).toBe(true);
  });

  test("answer records against the --root workspace", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    writeFileSync(join(onlyRunDir(ws.root), "01-what", "questions.md"), ROOT_QUESTION, "utf8");

    const run = await tldrx(foreign, "answer", "Q1", "A", "—", "Postgres", "--root", ws.root);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toMatch(/Q1 answered → F\d{3,6}/);
  });

  test("approve acts on the --root workspace", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    writeFileSync(join(runDir, "01-what", "handoff.md"), MINIMAL_HANDOFF, "utf8");
    parkAtGate(runDir);

    const run = await tldrx(foreign, "approve", "--note", "fine", "--root", ws.root);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(EXIT_OK);
    expect(loadRun(runDir).phases[0]?.stages[0]?.gate.status).toBe("approved");
  });

  test("reject acts on the --root workspace", async () => {
    const ws = fresh();
    await tldrx(ws.root, "run", "new", "leaderboard");
    const runDir = onlyRunDir(ws.root);
    parkAtGate(runDir);

    const run = await tldrx(foreign, "reject", "--note", "not yet", "--root", ws.root);
    expect(run.code).toBe(EXIT_OK);
    expect(loadRun(runDir).phases[0]?.stages[0]?.gate.note).toBe("not yet");
  });
});
