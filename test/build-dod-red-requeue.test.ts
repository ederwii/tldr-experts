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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dodOutputRel } from "../src/core/build/dodOutput.ts";
import { readReviewLedger } from "../src/core/build/reviewLedger.ts";
import { dodRedRequeue } from "../src/core/build/reviewRound.ts";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import { reject } from "../src/core/run/gates.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_WRITE", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_COST", "FAKE_BUILD_STATE",
  "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_FAIL", "FAKE_BUILD_FAIL_WORK", "FAKE_BUILD_FAIL_REASON",
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
    expect(settled.map((e) => [e.payload.attempt, e.payload.status])).toEqual([[1, "todo"], [2, "done"]]);

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

describe("#313 · the attempts bound holds across processes", () => {
  /**
   * Review finding on the first cut: the red-DoD requeue count lived in memory.
   * Attempt 1 red → requeued; attempt 2's developer never RAN (a spawn fault),
   * which parks the story and ends the invocation; the NEXT invocation is a fresh
   * process, and a counter that starts at 0 there hands the story a whole new run
   * of attempts — repeatable without bound. The count is read off `events.jsonl`.
   */
  test("a spawn fault between attempts does not buy a fresh run of attempts in the next invocation", async () => {
    const ws = workspace(one({ testScript: RED_ONLY_AFTER_DEVELOPER }));
    // The SECOND developer spawn dies without running; every other one delivers.
    process.env.FAKE_BUILD_FAIL = "developer:S1#2";
    // A TRANSPORT fault, not a cap death: a cap death over the kept tree is work
    // the DoD decides (#277), and that path already blocks.
    process.env.FAKE_BUILD_FAIL_REASON = "API Error: Connection reset by peer";

    // Three invocations, the stage sent back from its gate between each — the
    // way an operator (or `run auto --and-continue`) re-runs a Build stage.
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        reject(RunStore.open(ws.runDir), {
          root: ws.root, actor: "alan", at: `2026-09-14T09:0${String(i)}:00Z`, note: "run the stage again",
        });
      }
      await next(ws);
    }

    // Developer turns that RAN are the ones whose DoD was measured. With
    // `attempts: 2` there may be at most two of them, whatever the process count.
    const measured = events(ws).filter((e) => e.type === "check.failed" && e.payload.check === "dod"
      && e.payload.story === "S1").length;
    expect(measured).toBeLessThanOrEqual(2);
    const started = startedAttempts(ws, "S1");
    expect(Math.max(...(started as number[]))).toBeLessThanOrEqual(2);
    expect(started.at(-1)).toBe(2);
    expect(story(ws, "S1")).toContain("status: blocked");
    const log = readFileSync(join(ws.runDir, "04-build", "log", "S1.md"), "utf8");
    expect(log).toContain("the DoD stayed red on 2 of 2 attempts");
  });
});

/**
 * gh #360 — a refusal whose command is a COMPOUND line (or, when the caller
 * names the workspace's declared commands, one none of them grants) is not the
 * same case #313's docstring reasoned about: "the same allowance would refuse
 * the same command again" holds for a verbatim re-ask, but a compound line is
 * refused for its SHAPE, and a second attempt is not obliged to chain commands
 * the same way twice. `dodRedRequeue` is a pure function — these are unit
 * tests directly against it, the fast twin of the full-executor test below.
 */
describe("#360 · dodRedRequeue (unit): a compound or undeclared refusal does not itself block", () => {
  const RED_ROW = [{ command: "npm run test", exitCode: 1, timedOut: false, tail: "FAIL" }];
  const parts = (refused: string | null, extra: Record<string, unknown> = {}) => ({
    dod: RED_ROW, refused, budgetDeath: null, attempt: 1, attempts: 2, ...extra,
  });

  test("today's rule, unchanged: no separator, no `declared` passed (`unknown`) still blocks", () => {
    expect(dodRedRequeue(parts("rm -rf build"))).toBe(false);
  });

  for (const compound of [
    ["a `;` chain", "npm run test; echo EXIT:$?"],
    ["a `&&`/`||` chain", "docker info >/dev/null 2>&1 && echo DOCKER_OK || echo NO_DOCKER"],
    ["a pipe", "find . -iname '*.ts' | grep -v node_modules | xargs cat"],
    ["a redirect", "npm run test > /tmp/out.log 2>&1"],
    ["a heredoc", "cat <<EOF\nhello\nEOF"],
  ] as const) {
    test(`requeues on ${compound[0]}`, () => {
      expect(dodRedRequeue(parts(compound[1]))).toBe(true);
    });
  }

  test("an undeclared command requeues once the caller passes `declared`", () => {
    expect(dodRedRequeue(parts("rm -rf build", { declared: ["npm run test"] }))).toBe(true);
  });

  test("an ungranted git VERB still blocks — the verbatim line would be refused again", () => {
    expect(dodRedRequeue(parts("git checkout -- src/x.ts"))).toBe(false);
  });

  test("`git -C <dir>` (elsewhere) still blocks", () => {
    expect(dodRedRequeue(parts("git -C ../other log"))).toBe(false);
  });

  test("a compound refusal still respects the attempt cap", () => {
    expect(dodRedRequeue(parts("npm run test && echo ok", { attempt: 2, attempts: 2 }))).toBe(false);
  });

  test("a compound refusal never overrides a cap death", () => {
    expect(dodRedRequeue(parts("npm run test && echo ok", { budgetDeath: "Reached maximum budget" }))).toBe(false);
  });

  test("no refusal at all still requeues exactly as before", () => {
    expect(dodRedRequeue(parts(null))).toBe(true);
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

describe("#360 · a compound-line refusal requeues a red DoD instead of blocking it (full executor)", () => {
  // The denied branch of `fakeClaude.ts` writes the story's own default file
  // (`s1.txt`), not `FAKE_BUILD_WRITE`'s content (gh #261's shape) — so RED
  // reads on THAT file, and clears once the un-denied attempt 2 writes `fixed.txt`.
  const RED_UNTIL_FIXED_AFTER_DENIAL =
    'node -e "var fs=require(\'fs\');console.log(\'FAIL — the denied attempt left s1.txt unresolved\');'
    + 'process.exit(fs.existsSync(\'s1.txt\')&&!fs.existsSync(\'fixed.txt\')?1:0)"';

  test(
    "attempt 1 refused on a COMPOUND ad hoc line + a red DoD, attempt 2 clean: DONE with no human reopen, "
      + "and the refusal is still on record",
    async () => {
      const ws = workspace(one({ testScript: RED_UNTIL_FIXED_AFTER_DENIAL }));
      // Scoped to attempt 1 only (`S1#1`) — a genuine second attempt, not the
      // same denied line re-asked, which is exactly #360's point.
      process.env.FAKE_BUILD_DENIED = JSON.stringify({ "S1#1": "docker info >/dev/null 2>&1 && echo DOCKER_OK" });
      process.env.FAKE_BUILD_DENIED_WORK = JSON.stringify({ S1: "committed" });
      process.env.FAKE_BUILD_WRITE = JSON.stringify({ "S1#2": { "fixed.txt": "regenerated\n" } });

      await next(ws);

      // Requeued like any other red DoD — no human reopen needed.
      expect(startedAttempts(ws, "S1")).toEqual([1, 2]);
      expect(developerSpawns(ws, "S1")).toBe(2);
      expect(story(ws, "S1")).toContain("status: done");
      expect(events(ws).some((e) => e.type === "story.reopened")).toBe(false);
      // The refusal is still recorded on attempt 1's own row — narrowing the
      // block must never narrow the record (§7, "absent-with-reason, never
      // invented" cuts both ways: nothing here may go quiet either). Attempt
      // 2's own settle is a fresh attempt with no refusal of its own (gh #271's
      // "a refusal is attributed to its own story only" rule extends to its own
      // ATTEMPT too), so the log file — overwritten by the LAST settle — is not
      // where this is read; the event stream is.
      const done1 = events(ws).find((e) => e.type === "task.done" && e.payload.story === "S1" && e.payload.attempt === 1);
      expect(done1?.payload.permission_refused).toBe("docker info >/dev/null 2>&1 && echo DOCKER_OK");
    },
  );
});

describe("#313 · the ledger counts only the attempts a red DoD could have requeued", () => {
  /**
   * Re-review Minor on fdeb58c: `redDodAttempts` counted ANY non-green dod row,
   * so a REFUSED command or a binary ABSENT from the tree — attempts
   * `dodRedRequeue` never treats as requeue-eligible — spent the bound a later
   * resume is held to. One predicate now answers both (`dodRequeueRed`).
   */
  function ledgerOver(row: Record<string, unknown>): number {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-313-ledger-"));
    const lines = [
      { type: "task.started", payload: { story: "S1", attempt: 1 } },
      { type: "check.failed", payload: { check: "dod", story: "S1", command: "npm run test", ...row } },
      { type: "task.done", payload: { story: "S1", status: "blocked", verdict: "n-a", commit: null, attempt: 1 } },
    ].map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(join(dir, "events.jsonl"), `${lines}\n`, "utf8");
    return readReviewLedger(dir, "S1").redDodAttempts;
  }

  test("a plain red row spends one attempt", () => {
    expect(ledgerOver({ exit_code: 1, detail: "FAIL test_x" })).toBe(1);
  });

  test("a REFUSED row spends none — the resume that follows still has its attempts", () => {
    expect(ledgerOver({ refused: "not one of workspace.yml's commands", detail: "refused" })).toBe(0);
  });

  test("a row whose binary was ABSENT from the tree spends none (#209)", () => {
    expect(ledgerOver({ exit_code: 127, absent_binary: "jest", detail: "sh: jest: command not found" })).toBe(0);
  });
});
