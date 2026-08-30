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
import {
  holdsWorkspaceLock, readWorkspaceLock, withWorkspaceLock, workspaceLockPath, WorkspaceLockError,
} from "../src/core/lock/workspaceLock.ts";
import { cpSync, mkdtempSync } from "node:fs";
import { loadRun, renderReplay } from "../src/core/replay/index.ts";
import { VIEWS_FIXTURE, VIEWS_RUN } from "./fixtures/views/tempViews.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, skippedNote } from "../src/core/events/EventLog.ts";
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
