/**
 * Wave Q — what survives a kill, and what a stuck run looks like from outside.
 *
 * The 2026-08-29 audit (`docs/audits/2026-08-29/state-resumability.md`) scored the
 * framework 6/10 on this: the FILES resume fine, but the process and the money did
 * not, and nothing guarded the two files several runs share. Every test here pins
 * one of those holes shut. Nothing spawns a real `claude`: the only sub-agent is
 * the fake fixture, and the signal tests send a real signal to a real `tldrx`
 * child process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { createRun } from "../src/core/run/newRun.ts";
import { makeRunWorkspace } from "./fixtures/tempRunWorkspace.ts";
import { noSpawnEnv } from "./fixtures/noSpawnPath.ts";
import { cannedIntent, makeFacilitatorWorkspace, type FacilitatorWorkspace } from "./fixtures/facilitator/workspace.ts";
import { isMovable, waitingFor } from "../src/core/run/waiting.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { openRunRows } from "../src/core/run/openRuns.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import type { RunFile } from "../src/core/run/RunFile.ts";
import {
  holdsWorkspaceLock, readWorkspaceLock, withWorkspaceLock, workspaceLockPath, WorkspaceLockError,
} from "../src/core/lock/workspaceLock.ts";
import { cpSync, mkdtempSync } from "node:fs";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { VIEWS_FIXTURE, VIEWS_RUN } from "./fixtures/views/tempViews.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, skippedNote } from "../src/core/events/EventLog.ts";
import { EVENT_TYPES, validateEvent } from "../src/core/events/Event.ts";
import { cancelRun, unlockRun } from "../src/core/run/rescue.ts";
import type { TldrxEvent } from "../src/core/events/Event.ts";

let temps: string[] = [];

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-resume-"));
  temps.push(dir);
  return dir;
}

function anEvent(type: TldrxEvent["type"], stage: string | null = null): TldrxEvent {
  return { ts: "2026-08-29T09:00:00Z", run: "260829-demo", stage, type, actor: "alan", cost_usd: 0, payload: {} };
}

// --- Q6: a torn line must not take the history with it ----------------------

describe("EventLog.read tolerates a torn line", () => {
  test("a half-written last line is skipped, not thrown, and the rest survives", () => {
    const dir = tempDir();
    const log = new EventLog(join(dir, "events.jsonl"));
    log.append(anEvent("run.created"));
    log.append(anEvent("stage.started", "alpha"));
    // The kill lands between the `{` and the `\n`.
    appendFileSync(log.path, '{"ts":"2026-08-29T09:00:01Z","run":"260829-demo","sta', "utf8");

    const result = log.readAll();
    expect(result.events.map((e) => e.type)).toEqual(["run.created", "stage.started"]);
    expect(result.skipped).toBe(1);
    // Line numbers still point at the real lines, so replay's `L<n>` is honest.
    expect(result.lines).toEqual([1, 2]);
  });

  test("read() never throws on a partial line and warns once per path", () => {
    const dir = tempDir();
    const log = new EventLog(join(dir, "events.jsonl"));
    log.append(anEvent("run.created"));
    appendFileSync(log.path, "{not json at all", "utf8");

    const said: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      said.push(s);
      return true;
    };
    try {
      expect(log.read().map((e) => e.type)).toEqual(["run.created"]);
      // Second and third reads say nothing: the warning is once per path.
      log.read();
      new EventLog(log.path).read();
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(said.length).toBe(1);
    expect(said[0]).toContain("1 line skipped");
  });

  test("a torn line in the MIDDLE is skipped too — the reader never gives up early", () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(anEvent("run.created"))}\n` +
        "{ torn\n" +
        `${JSON.stringify(anEvent("stage.done", "alpha"))}\n`,
      "utf8",
    );
    const result = new EventLog(path).readAll();
    expect(result.events.map((e) => e.type)).toEqual(["run.created", "stage.done"]);
    expect(result.skipped).toBe(1);
    expect(result.lines).toEqual([1, 3]);
  });

  test("skippedNote is the one phrasing both the warning and replay use", () => {
    expect(skippedNote(1)).toBe("1 line skipped");
    expect(skippedNote(3)).toBe("3 lines skipped");
  });

  test("replay renders the note instead of losing the whole history", () => {
    const dir = tempDir();
    cpSync(VIEWS_FIXTURE, dir, { recursive: true });
    appendFileSync(join(dir, "tldrx-work", VIEWS_RUN, "events.jsonl"), '{"ts":"2026-09-01T12:00:00Z","run":"', "utf8");

    const loaded = loadRun(dir, VIEWS_RUN);
    expect(loaded).not.toBeNull();
    expect(loaded!.eventsError).toBeNull();
    expect(loaded!.eventsSkipped).toBe(1);
    expect(loaded!.events.length).toBeGreaterThan(0);
    const narrative = renderReplay(loaded!);
    expect(narrative).toContain("1 line skipped");
    expect(narrative).toContain("### what");
  });

  test("a missing file is still no events and no skips", () => {
    expect(new EventLog(join(tempDir(), "nope.jsonl")).readAll()).toEqual({ events: [], lines: [], skipped: 0 });
  });
});

// --- Q4: the workspace lock over the files several runs share ---------------

describe(".tldrx/.lock", () => {
  test("is re-entrant in one process and released only by the outermost exit", () => {
    const root = tempDir();
    const path = workspaceLockPath(root);
    withWorkspaceLock(root, () => {
      expect(existsSync(path)).toBe(true);
      withWorkspaceLock(root, () => {
        expect(existsSync(path)).toBe(true);
      });
      // The inner exit must NOT have released it.
      expect(existsSync(path)).toBe(true);
      expect(holdsWorkspaceLock(root)).toBe(true);
    });
    expect(existsSync(path)).toBe(false);
    expect(holdsWorkspaceLock(root)).toBe(false);
  });

  test("a throw inside still releases it", () => {
    const root = tempDir();
    expect(() => withWorkspaceLock(root, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(workspaceLockPath(root))).toBe(false);
  });

  test("a lock left by a dead pid is taken over, not waited on", () => {
    const root = tempDir();
    const path = workspaceLockPath(root);
    mkdirSync(join(root, ".tldrx"), { recursive: true });
    // pid 2^22 is above every Linux/macOS default pid_max, so it is not alive.
    writeFileSync(path, JSON.stringify({ pid: 4194304, at: "2026-08-29T09:00:00Z" }), "utf8");
    expect(readWorkspaceLock(root)?.pid).toBe(4194304);
    let ran = false;
    withWorkspaceLock(root, () => { ran = true; }, 200);
    expect(ran).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("a LIVE holder is refused after the timeout, and named", () => {
    const root = tempDir();
    const path = workspaceLockPath(root);
    mkdirSync(join(root, ".tldrx"), { recursive: true });
    // Our own pid is unquestionably alive, and is not this process's lock depth.
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: "2026-08-29T09:00:00Z" }), "utf8");
    expect(() => withWorkspaceLock(root, () => undefined, 120)).toThrow(WorkspaceLockError);
    // The refusal must not have removed someone else's lock.
    expect(existsSync(path)).toBe(true);
    rmSync(path, { force: true });
  });

  test("an unparseable lock is treated as stale — a workspace is never wedged by garbage", () => {
    const root = tempDir();
    const path = workspaceLockPath(root);
    mkdirSync(join(root, ".tldrx"), { recursive: true });
    writeFileSync(path, "not json", "utf8");
    let ran = false;
    withWorkspaceLock(root, () => { ran = true; }, 200);
    expect(ran).toBe(true);
  });
});

describe("facts.yml under two writers", () => {
  test("FactsStore.update mints distinct ids from two real processes", async () => {
    const ws = makeRunWorkspace();
    try {
      // The child HOLDS the lock for `holdMs` between load and save, so the two
      // processes provably overlap. Without the lock the second child would read
      // facts.yml while the first was still inside its update, compute the same
      // `F001`, and its save would erase the first fact — which is exactly the
      // failure measured on 2026-08-29.
      const script = join(ws.root, "append.ts");
      writeFileSync(script, `
import { FactsStore } from ${JSON.stringify(join(FRAMEWORK_ROOT, "src/core/facts/FactsStore.ts"))};
const [path, who, holdMs] = process.argv.slice(2) as [string, string, string];
const id = FactsStore.update(path, (store) => {
  const fact = store.append({
    fact: "fact from " + who,
    area: "demo",
    repos: [],
    kind: "answer",
    confidence: "stated",
    source: { who, when: "2026-08-29T09:00:00Z", run: "260829-demo", q: "Q1" },
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  return fact.id;
});
process.stdout.write(id);
`, "utf8");
      const facts = join(ws.root, ".tldrx", "memory", "facts.yml");
      const spawn = async (who: string, holdMs: number): Promise<{ id: string; code: number; err: string }> => {
        const proc = Bun.spawn(["bun", script, facts, who, String(holdMs)], { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        return { id: out.trim(), code: await proc.exited, err };
      };

      const first = spawn("a", 500);
      await new Promise((r) => setTimeout(r, 120));
      const second = spawn("b", 0);
      const both = await Promise.all([first, second]);

      expect(both.map((r) => r.code)).toEqual([0, 0]);
      expect(both.map((r) => r.err).join("")).toBe("");
      // Two writers, two ids, and BOTH facts on disk.
      expect(both.map((r) => r.id).sort()).toEqual(["F001", "F002"]);
      const store = FactsStore.load(facts);
      expect(store.facts.map((f) => f.id)).toEqual(["F001", "F002"]);
      expect(store.facts.map((f) => f.fact).sort()).toEqual(["fact from a", "fact from b"]);
    } finally {
      ws.dispose();
    }
  }, 30_000);

  test("a save leaves no temp file beside facts.yml", () => {
    const ws = makeRunWorkspace();
    try {
      const facts = join(ws.root, ".tldrx", "memory", "facts.yml");
      FactsStore.update(facts, (store) => store.append({
        fact: "one", area: "demo", repos: [], kind: "answer", confidence: "stated",
        source: { who: "alan", when: "2026-08-29T09:00:00Z", run: "260829-demo", q: "Q1" },
      }));
      expect(readdirSync(join(ws.root, ".tldrx", "memory"))).toEqual(["facts.yml"]);
    } finally {
      ws.dispose();
    }
  });
});

describe("budget.yml ceilings survive a concurrent raise", () => {
  test("a save that did not touch ceilings re-reads them from disk", () => {
    const ws = makeRunWorkspace();
    try {
      const runId = createRun({
        root: ws.root, slug: "ceilings", scope: "feature", actor: "alan",
        now: new Date("2026-08-29T09:00:00Z"),
      }).runId;

      // A `next` opens the run and holds budget.yml as it was.
      const inFlight = RunStore.find(ws.root, runId)!;
      const before = inFlight.budget.ceiling_usd;

      // Meanwhile `tldrx budget raise` lands, through its own store.
      const raiser = RunStore.find(ws.root, runId)!;
      raiser.mutateBudget((b) => ({ ...b, ceiling_usd: before + 40 }));
      raiser.save();
      expect(RunStore.find(ws.root, runId)!.budget.ceiling_usd).toBe(before + 40);

      // The in-flight store now lands. It must NOT write its stale ceiling back.
      inFlight.mutate((run) => run);
      inFlight.save();
      expect(RunStore.find(ws.root, runId)!.budget.ceiling_usd).toBe(before + 40);
      expect(inFlight.budget.ceiling_usd).toBe(before + 40);
    } finally {
      ws.dispose();
    }
  });

  test("a store that DID raise the ceiling still wins", () => {
    const ws = makeRunWorkspace();
    try {
      const runId = createRun({
        root: ws.root, slug: "raise", scope: "feature", actor: "alan",
        now: new Date("2026-08-29T09:00:00Z"),
      }).runId;
      const store = RunStore.find(ws.root, runId)!;
      store.mutateBudget((b) => ({ ...b, ceiling_usd: 99 }));
      store.save();
      expect(RunStore.find(ws.root, runId)!.budget.ceiling_usd).toBe(99);
    } finally {
      ws.dispose();
    }
  });

  test("a save leaves no temp file in the run dir", () => {
    const ws = makeRunWorkspace();
    try {
      const runId = createRun({
        root: ws.root, slug: "tidy", scope: "feature", actor: "alan",
        now: new Date("2026-08-29T09:00:00Z"),
      }).runId;
      const store = RunStore.find(ws.root, runId)!;
      store.mutate((run) => run);
      store.save();
      const litter = readdirSync(store.runDir).filter((name) => name.includes(".tmp-"));
      expect(litter).toEqual([]);
    } finally {
      ws.dispose();
    }
  });
});

// --- Q2: `running` without a lock is a state, not a synonym for `ready` -----

/** One tiny stage, one run, through the real fixture. */
function oneStage(): FacilitatorWorkspace {
  const ws = makeFacilitatorWorkspace({
    scope: "demo",
    budgetUsd: 10,
    stages: [{
      id: "alpha", phase: "01-what", budgetUsd: 6, gate: "auto",
      outputs: [{ path: "01-what/intent.md", sections: ["Intent", "Scope"] }],
    }],
  });
  facilitatorWorkspaces.push(ws);
  return ws;
}

let facilitatorWorkspaces: FacilitatorWorkspace[] = [];

afterEach(() => {
  for (const ws of facilitatorWorkspaces) ws.dispose();
  facilitatorWorkspaces = [];
});

describe("waitingFor: running and prepared", () => {
  test("a live lock reads as `running`, and names the pid and the way out", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "running"));
    store.save();
    writeFileSync(join(ws.runDir, ".lock"), JSON.stringify({ pid: process.pid, at: "2026-08-29T09:00:00Z" }), "utf8");

    const waiting = waitingFor(RunStore.open(ws.runDir).run, ws.runDir);
    expect(waiting.kind).toBe("running");
    expect(waiting.message).toBe(
      `stage is running (pid ${String(process.pid)}) — wait, or \`tldrx run unlock ${ws.runId}\` if it died`,
    );
    // In flight is not something a human can be handed.
    expect(isMovable(waiting.kind)).toBe(false);
  });

  test("a `--prepare` bundle with no lock reads as `prepared`, and offers --commit or reject", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "running"));
    store.save();
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(join(ws.runDir, ".agent", "alpha", "pending.json"), "{}", "utf8");

    const waiting = waitingFor(RunStore.open(ws.runDir).run, ws.runDir);
    expect(waiting.kind).toBe("prepared");
    expect(waiting.message).toBe(
      "a --prepare bundle is waiting — run the prompt and " +
      `\`tldrx next --commit ${ws.runId}\`, or \`tldrx reject --run ${ws.runId} --note …\` to discard`,
    );
    // It IS actionable, so `tldrx status` marks it as the run to pick up.
    expect(isMovable(waiting.kind)).toBe(true);
  });

  test("running with neither a lock nor a bundle still reads as ready — `next` demotes it", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "running"));
    store.save();
    const waiting = waitingFor(RunStore.open(ws.runDir).run, ws.runDir);
    expect(waiting.kind).toBe("ready");
    expect(waiting.message).toContain("nothing holds it");
  });

  test("`run status` and the dashboard both read the new kinds off the same derivation", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "running"));
    store.save();
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(join(ws.runDir, ".agent", "alpha", "pending.json"), "{}", "utf8");

    const reopened = RunStore.open(ws.runDir);
    const view = buildStatus(reopened.run, reopened.budget, ws.runDir);
    expect(view.waiting.kind).toBe("prepared");
    expect(renderStatus(view)).toContain("a --prepare bundle is waiting");
    // The dashboard model derives from the same function, so it cannot disagree.
    expect(openRunRows(RunStore.findOpen(ws.root)).map((row) => row.waiting)).toContain("prepared");
  });
});

describe("next refuses to re-spawn over a --prepare bundle", () => {
  test("exit 2, and the message names all three ways out", async () => {
    const ws = oneStage();
    // The real `--prepare`: it marks the stage running and releases the lock.
    const prepared = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    expect(prepared.code).toBe(0);
    expect(RunStore.open(ws.runDir).run.phases[0]!.stages[0]!.status).toBe("running");
    expect(existsSync(join(ws.runDir, ".lock"))).toBe(false);

    // A bare `tldrx next` now. No fake claude on PATH at all: a spawn here would
    // fail loudly rather than pass quietly.
    const again = await runNext({
      root: ws.root, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(again.code).toBe(2);
    const text = again.lines.join("\n");
    expect(text).toContain("has a --prepare bundle waiting");
    expect(text).toContain("--commit");
    expect(text).toContain("tldrx reject");
    expect(text).toContain("--discard-pending");
    // Nothing was spawned and nothing was spent.
    expect(RunStore.open(ws.runDir).run.budget.spent_usd).toBe(0);
  });

  test("--discard-pending bins the bundle and lets the stage run again", async () => {
    const ws = oneStage();
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    expect(existsSync(join(ws.runDir, ".agent", "alpha", "pending.json"))).toBe(true);

    const discarded = await runNext({
      root: ws.root, dryRun: false, mode: "prepare", discardPending: true, yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(discarded.code).toBe(0);
    expect(discarded.lines.join("\n")).toContain("discarded the --prepare bundle");
    // And it re-prepared: the bundle is back.
    expect(existsSync(join(ws.runDir, ".agent", "alpha", "pending.json"))).toBe(true);
  });

  test("--commit is never refused: it is the recovery path, not the mistake", async () => {
    const ws = oneStage();
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, ".agent", "alpha", "result.json"), JSON.stringify({
      outputs: ["01-what/intent.md"], questions_asked: [], notes: "by hand", cost_usd: 0.5, session_id: null,
    }), "utf8");

    const committed = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(committed.code).toBe(0);
    expect(RunStore.open(ws.runDir).run.phases[0]!.stages[0]!.status).toBe("done");
  });
});

function withStageStatus(run: RunFile, stageId: string, status: RunFile["phases"][number]["stages"][number]["status"]): RunFile {
  return {
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      stages: phase.stages.map((stage) => (stage.id === stageId ? { ...stage, status } : stage)),
    })),
  };
}

// --- Q5: a way out of a stuck run ------------------------------------------

const DEAD_PID = 4194304;

function lockWith(runDir: string, pid: number): void {
  writeFileSync(join(runDir, ".lock"), JSON.stringify({ pid, at: "2026-08-29T09:00:00Z" }), "utf8");
}

function rescue(ws: FacilitatorWorkspace, extra: Partial<Parameters<typeof unlockRun>[0]> = {}) {
  return { root: ws.root, force: false, actor: "alan", at: "2026-08-29T10:00:00Z", ...extra };
}

describe("tldrx run unlock", () => {
  test("removes a lock whose pid is dead, demotes running to ready and emits run.unlocked", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "running"));
    store.save();
    lockWith(ws.runDir, DEAD_PID);

    const outcome = unlockRun(rescue(ws));
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("demoted 01-what/alpha from running to ready");
    expect(existsSync(join(ws.runDir, ".lock"))).toBe(false);
    expect(RunStore.open(ws.runDir).run.phases[0]!.stages[0]!.status).toBe("ready");

    const unlocked = EventLog.forRun(ws.runDir).read().filter((e) => e.type === "run.unlocked");
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0]!.payload).toMatchObject({ pid: DEAD_PID, was_alive: false, forced: false });
    expect(unlocked[0]!.stage).toBeNull();
  });

  test("refuses a LIVE holder without --force, and names the force command", () => {
    const ws = oneStage();
    lockWith(ws.runDir, process.pid);
    const outcome = unlockRun(rescue(ws));
    expect(outcome.code).toBe(2);
    expect(outcome.lines.join("\n")).toContain(`held by live pid ${String(process.pid)}`);
    expect(outcome.lines.join("\n")).toContain(`tldrx run unlock ${ws.runId} --force`);
    // A refusal removes nothing.
    expect(existsSync(join(ws.runDir, ".lock"))).toBe(true);
  });

  test("--force removes a live holder's lock and says that is what it did", () => {
    const ws = oneStage();
    lockWith(ws.runDir, process.pid);
    const outcome = unlockRun(rescue(ws, { force: true }));
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("forced: it is still alive");
    expect(existsSync(join(ws.runDir, ".lock"))).toBe(false);
  });

  test("no lock at all is a no-op that points at the real problem", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "running"));
    store.save();
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(join(ws.runDir, ".agent", "alpha", "pending.json"), "{}", "utf8");

    const outcome = unlockRun(rescue(ws));
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("nothing to unlock");
    expect(outcome.lines.join("\n")).toContain("--prepare bundle, not on a lock");
    // The stage is NOT demoted: that would bin the bundle behind the operator's back.
    expect(RunStore.open(ws.runDir).run.phases[0]!.stages[0]!.status).toBe("running");
  });
});

describe("tldrx run cancel", () => {
  test("closes a failed run, emits run.cancelled, and takes it out of every open-run view", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "failed"));
    store.save();
    expect(RunStore.open(ws.runDir).run.status).toBe("failed");
    expect(RunStore.findOpen(ws.root).map((s) => s.runId)).toContain(ws.runId);

    const outcome = cancelRun({ ...rescue(ws), note: "superseded by 260830-v2" });
    expect(RunStore.open(ws.runDir).run.cancelled).toMatchObject({ by: "alan", note: "superseded by 260830-v2" });
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("superseded by 260830-v2");

    const after = RunStore.open(ws.runDir);
    expect(after.run.status).toBe("cancelled");
    // `tldrx status` and every id-less command list open runs; a cancelled run is
    // finished, so it appears in none of them.
    expect(RunStore.findOpen(ws.root)).toHaveLength(0);
    expect(openRunRows(RunStore.findOpen(ws.root))).toHaveLength(0);

    const cancelled = EventLog.forRun(ws.runDir).read().filter((e) => e.type === "run.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.payload).toMatchObject({ note: "superseded by 260830-v2", forced: false });
  });

  test("refuses while a live lock holds the run, unless --force", () => {
    const ws = oneStage();
    lockWith(ws.runDir, process.pid);
    const refused = cancelRun({ ...rescue(ws), note: "stop" });
    expect(refused.code).toBe(2);
    expect(refused.lines.join("\n")).toContain("still working");
    expect(RunStore.open(ws.runDir).run.status).not.toBe("cancelled");

    const forced = cancelRun({ ...rescue(ws, { force: true }), note: "stop" });
    expect(forced.code).toBe(0);
    expect(RunStore.open(ws.runDir).run.status).toBe("cancelled");
    expect(existsSync(join(ws.runDir, ".lock"))).toBe(false);
  });

  test("needs a note", () => {
    const ws = oneStage();
    const outcome = cancelRun({ ...rescue(ws), note: "  " });
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("--note");
  });

  test("a run whose stages are all terminal says so instead of pretending to act", () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "done"));
    store.save();
    const outcome = cancelRun({ ...rescue(ws, { runId: ws.runId }), note: "late" });
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("nothing to cancel");
    expect(RunStore.open(ws.runDir).run.status).toBe("done");
  });

  test("next on a cancelled run advances nothing", async () => {
    const ws = oneStage();
    cancelRun({ ...rescue(ws), note: "done with it" });
    const outcome = await runNext({
      root: ws.root, runId: ws.runId, dryRun: false, mode: "headless", yolo: false,
      actor: "alan", at: "2026-08-29T11:00:00Z",
    });
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("is cancelled — nothing to advance");
  });
});

describe("run.unlocked and run.cancelled are in the closed event set", () => {
  test("both validate", () => {
    for (const type of ["run.unlocked", "run.cancelled"] as const) {
      expect(EVENT_TYPES).toContain(type);
      expect(validateEvent(anEvent(type)).ok).toBe(true);
    }
  });
});

describe("the CLI wiring, through the real binary", () => {
  const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");

  async function tldrx(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", cwd, env: noSpawnEnv() });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test("`run unlock` clears a dead lock and `run cancel` closes the run", async () => {
    const ws = oneStage();
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withStageStatus(run, "alpha", "running"));
    store.save();
    lockWith(ws.runDir, DEAD_PID);

    const unlocked = await tldrx(ws.root, "run", "unlock", ws.runId);
    expect(unlocked.code).toBe(0);
    expect(unlocked.stdout).toContain("demoted 01-what/alpha from running to ready");

    const cancelled = await tldrx(ws.root, "run", "cancel", ws.runId, "--note", "not doing this one");
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain("not doing this one");
    expect(RunStore.open(ws.runDir).run.status).toBe("cancelled");

    // A cancelled run is finished, so `tldrx status` lists it nowhere.
    const status = await tldrx(ws.root, "status");
    expect(status.code).toBe(0);
    expect(status.stdout).not.toContain(ws.runId);
    expect(status.stderr).not.toContain(ws.runId);

    // And `run status` with no id no longer has a run to be ambiguous about.
    const runStatus = await tldrx(ws.root, "run", "status");
    expect(runStatus.code).toBe(3);
  }, 30_000);

  test("`run` names the two new subcommands in its usage", async () => {
    const ws = oneStage();
    const help = await tldrx(ws.root, "run", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("tldrx run unlock");
    expect(help.stdout).toContain("tldrx run cancel");
  }, 20_000);
});
