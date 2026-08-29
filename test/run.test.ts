import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
_none yet_

## Unknowns
_none yet_

## Evidence ledger
_none yet_
`;

/** Put the cursor stage into the one state a gate is allowed to act on. */
function parkAtGate(runDir: string): void {
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
                ? { ...stage, status: "awaiting_gate" as const, started_at: "2026-08-28T09:00:00Z" }
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
});
