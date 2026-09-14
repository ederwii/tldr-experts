/**
 * gh #313 — a developer whose Definition of Done goes RED gets the story's next
 * attempt, the way a reviewer's `changes` verdict already buys one.
 *
 * Measured across 12 run folders: 17 human reopens were a red DoD the
 * developer's own attempt could not turn green, and every one needed a person to
 * read the kept output and type `tldrx story reopen`. The mechanism: `settleHalf`
 * blocked on ANY half-A failure, while `reviewAndSettle` requeued `changes` while
 * `story.attempt < attempts`. A red DoD now takes the same bound — and ONLY a
 * plain red: a refused developer, a developer killed on its cap, a refused DoD
 * command and a story with no DoD commands still block on the first attempt,
 * because a second attempt would buy the same refusal.
 *
 * Every test runs the REAL executor against a REAL git repo, with the fake
 * `claude` first on PATH (AGENTS.md §8).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dodOutputRel } from "../src/core/build/dodOutput.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_WORK",
  "FAKE_BUILD_DENIED", "FAKE_BUILD_DENIED_WORK",
] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * GREEN on the base tree (neither file), RED once a developer writes
 * `broken.txt`, GREEN again once one writes `fixed.txt` beside it. That is the
 * whole shape of the 17 reopens: the first attempt leaves a red suite, and the
 * cure is more work in the same tree.
 */
const RED_UNTIL_FIXED =
  'node -e "var fs=require(\'fs\');console.log(\'FAIL snapshot drift — approved contract not regenerated\');'
  + 'process.exit(fs.existsSync(\'broken.txt\')&&!fs.existsSync(\'fixed.txt\')?1:0)"';

/**
 * RED the first time it finds `broken.txt` in a worktree, GREEN every time after
 * — the marker lives in the worktree's OWN git dir, so it is neither work in the
 * tree nor shared with a sibling story's worktree. Independent of which attempt
 * the fake developer thinks it is on, which is what the fan-out test needs.
 */
const RED_ON_FIRST_SIGHT =
  'node -e "var fs=require(\'fs\'),p=require(\'path\');'
  + 'var g=require(\'child_process\').execSync(\'git rev-parse --absolute-git-dir\').toString().trim();'
  + 'var m=p.join(g,\'dod-saw-broken\');'
  + 'if(fs.existsSync(\'broken.txt\')&&!fs.existsSync(m)){fs.writeFileSync(m,\'1\');console.log(\'FAIL first sight\');process.exit(1)}"';

/** RED once any `.txt` exists — every attempt the fake developer makes is red. */
const RED_ONLY_AFTER_DEVELOPER =
  'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(function (f) { return f.endsWith(\'.txt\'); }) ? 1 : 0)"';

function one(extra: Partial<BuildWorkspaceOptions> = {}): BuildWorkspaceOptions {
  return {
    stories: [{ id: "S1", epic: "E1", title: "First story" }],
    epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
    waves: [["S1"]],
    ...extra,
  };
}

function workspace(options: BuildWorkspaceOptions): BuildWorkspace {
  const made = makeBuildWorkspace(options);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  // The stage's brake prices the remaining work; a free fake keeps these tests
  // about the requeue rather than the budget.
  process.env.FAKE_BUILD_COST = "0";
  return made;
}

async function next(ws: BuildWorkspace, parallel?: number): Promise<number> {
  const outcome = await runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-09-14T09:00:00Z",
    ...(parallel === undefined ? {} : { parallel }),
  });
  return outcome.code;
}

function story(ws: BuildWorkspace, id: string): string {
  return readFileSync(join(ws.planDir, "stories", `${id}.md`), "utf8");
}

type Ev = { type: string; payload: Record<string, unknown> };
function events(ws: BuildWorkspace): readonly Ev[] {
  return EventLog.forRun(ws.runDir).read() as never;
}

function startedAttempts(ws: BuildWorkspace, id: string): readonly unknown[] {
  return events(ws).filter((e) => e.type === "task.started" && e.payload.story === id).map((e) => e.payload.attempt);
}

function developerSpawns(ws: BuildWorkspace, id: string): number {
  return events(ws).filter((e) => e.type === "agent.spawned" && e.payload.role === "developer" && e.payload.story === id)
    .length;
}

function lastDone(ws: BuildWorkspace, id: string): Ev | undefined {
  return events(ws).filter((e) => e.type === "task.done" && e.payload.story === id).at(-1);
}

describe("#313 · a red DoD requeues the story while attempts remain", () => {
  test("attempt 1 red, attempt 2 green: the story is DONE with no human reopen, and attempt 2's prompt cites the red output", async () => {
    const ws = workspace(one({ testScript: RED_UNTIL_FIXED }));
    const promptDir = join(ws.root, "prompts");
    process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
    process.env.FAKE_BUILD_WRITE = JSON.stringify({
      "S1#1": { "broken.txt": "half done\n" },
      "S1#2": { "fixed.txt": "regenerated\n" },
    });

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1, 2]);
    expect(developerSpawns(ws, "S1")).toBe(2);
    expect(story(ws, "S1")).toContain("status: done");
    expect(events(ws).some((e) => e.type === "story.reopened")).toBe(false);
    // Attempt 1 settled on the record, with no new event type and no new field.
    const settled = events(ws).filter((e) => e.type === "task.done" && e.payload.story === "S1");
    expect(settled.map((e) => [e.payload.attempt, e.payload.status])).toEqual([[1, "blocked"], [2, "done"]]);

    const second = readFileSync(join(promptDir, "developer-S1-2.md"), "utf8");
    const firstPrompt = readFileSync(join(promptDir, "developer-S1-1.md"), "utf8");
    expect(firstPrompt).not.toContain("## Previous attempt");
    expect(second).toContain("## Previous attempt");
    expect(second).toContain("Your last attempt blocked on its Definition of Done");
    expect(second).not.toContain("A reviewer read your last attempt");
    const rel = dodOutputRel("S1", 0);
    expect(existsSync(join(ws.runDir, rel))).toBe(true);
    expect(second).toContain(rel);
    expect(second).toContain("FAIL snapshot drift");
  });

  test("red on EVERY attempt: the last one blocks, and the reason says the DoD stayed red across the attempts", async () => {
    const ws = workspace(one({ testScript: RED_ONLY_AFTER_DEVELOPER }));

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1, 2]);
    expect(developerSpawns(ws, "S1")).toBe(2);
    expect(story(ws, "S1")).toContain("status: blocked");
    const done = lastDone(ws, "S1");
    expect(done?.payload.status).toBe("blocked");
    expect(done?.payload.attempt).toBe(2);
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("the DoD stayed red on 2 of 2 attempts");
  });

  test("`attempts: 1` still blocks on the first red, with today's reason", async () => {
    const ws = workspace(one({ testScript: RED_ONLY_AFTER_DEVELOPER, attempts: 1 }));

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1]);
    expect(story(ws, "S1")).toContain("status: blocked");
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("exited 1");
    expect(log).not.toContain("stayed red");
    expect(log).not.toContain("the DoD was red on attempt");
  });

  test("the wave fan-out (`--parallel 2`) requeues a red story the same way, and leaves its green sibling alone", async () => {
    const ws = workspace({
      stories: [{ id: "S1", epic: "E1", title: "First story" }, { id: "S2", epic: "E1", title: "Second story" }],
      epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
      waves: [["S1", "S2"]],
      testScript: RED_ON_FIRST_SIGHT,
    });
    // S1 writes `broken.txt` on every attempt; S2 never does. NOT `S1#2` in
    // FAKE_BUILD_WRITE: the fake's per-attempt counter is one JSON file two
    // concurrent spawns read-modify-write, and a lost update replays attempt 1
    // (measured: 1 red in 5 full-file runs, the log showing attempt 2's DoD red).
    process.env.FAKE_BUILD_WRITE = JSON.stringify({ S1: { "broken.txt": "half done\n" }, S2: { "s2.md": "fine\n" } });

    await next(ws, 2);

    expect(startedAttempts(ws, "S1")).toEqual([1, 2]);
    expect(startedAttempts(ws, "S2")).toEqual([1]);
    expect(story(ws, "S1")).toContain("status: done");
    expect(story(ws, "S2")).toContain("status: done");
  });
});

describe("#313 · every other half-A failure still blocks on the first attempt", () => {
  test("a developer REFUSED at the permission layer, with work and a red DoD, blocks after ONE attempt", async () => {
    const ws = workspace(one({ testScript: RED_ONLY_AFTER_DEVELOPER }));
    process.env.FAKE_BUILD_DENIED = JSON.stringify({ S1: "rm -rf build" });
    process.env.FAKE_BUILD_DENIED_WORK = JSON.stringify({ S1: "committed" });

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1]);
    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(story(ws, "S1")).toContain("status: blocked");
    // The instrument: the DoD really ran red here, so the block is this rule's
    // exclusion and not a story that never reached its DoD.
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("exited 1");
    expect(log).not.toContain("the DoD was red on attempt");
  });

  test("a developer killed on its CAP, with work and a red DoD, blocks after ONE attempt", async () => {
    const ws = workspace(one({ testScript: RED_ONLY_AFTER_DEVELOPER }));
    process.env.FAKE_BUILD_FAIL = "developer:S1#1";
    process.env.FAKE_BUILD_FAIL_WORK = JSON.stringify({ S1: "committed" });

    await next(ws);

    expect(startedAttempts(ws, "S1")).toEqual([1]);
    expect(developerSpawns(ws, "S1")).toBe(1);
    expect(story(ws, "S1")).toContain("status: blocked");
    // The instrument: the DoD really ran red here, so the block is this rule's
    // exclusion and not a story that never reached its DoD.
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("exited 1");
    expect(log).not.toContain("the DoD was red on attempt");
  });
});
