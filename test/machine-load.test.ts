/**
 * The load-aware budgets behind #43 — and the invariant that keeps them applied.
 *
 * The bug being guarded is a false RED at the moment a merge is decided:
 * `scripts/merge-wave.sh` refuses to push on any `bun test` failure, so a timeout that
 * means "the box was busy" is indistinguishable from a regression, and the natural
 * response — re-run until green — is exactly how a real regression gets pushed.
 *
 * What must stay true is that the CLOCK moved and the ASSERTION did not. Both halves
 * are tested here: on an idle machine `perfBudgetMs(50)` is still 50, and a function
 * that genuinely takes 120 ms still fails a 50 ms budget.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  fastestOf, spawnTestTimeout, loadFactor, perfBudgetMs, SPAWN_TEST_BASE_MS, LOAD_FACTOR_CAP,
  eventWaitMs, EVENT_WAIT_BASE_MS,
} from "./fixtures/machineLoad.ts";

const TEST_DIR = import.meta.dir;

afterEach(() => {
  delete process.env.TLDRX_TEST_LOAD_FACTOR;
});

/** Burn `ms` of CPU. Not `sleep`: the point is to be genuinely, measurably slow. */
function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* deliberate */ }
}

describe("the load factor is bounded at both ends", () => {
  test("an idle machine is 1 — no budget is stretched when nothing is competing", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "0.05";
    expect(loadFactor()).toBe(1);
  });

  test("a busy machine scales, but never past the cap", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "3.5";
    expect(loadFactor()).toBe(3.5);
    process.env.TLDRX_TEST_LOAD_FACTOR = "999";
    expect(loadFactor()).toBe(LOAD_FACTOR_CAP);
  });

  test("the real machine reads as a finite number inside those bounds", () => {
    const measured = loadFactor();
    expect(Number.isFinite(measured)).toBe(true);
    expect(measured).toBeGreaterThanOrEqual(1);
    expect(measured).toBeLessThanOrEqual(LOAD_FACTOR_CAP);
  });

  test("a junk pin is ignored rather than obeyed", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "not-a-number";
    expect(Number.isFinite(loadFactor())).toBe(true);
  });
});

describe("the budgets", () => {
  test("the git-test timeout is the 5000 ms default the false reds blew, many times over", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "1";
    expect(spawnTestTimeout()).toBe(SPAWN_TEST_BASE_MS);
    expect(spawnTestTimeout()).toBeGreaterThanOrEqual(5000 * 6);
    process.env.TLDRX_TEST_LOAD_FACTOR = "4";
    expect(spawnTestTimeout()).toBe(SPAWN_TEST_BASE_MS * 4);
  });

  test("a performance budget is UNCHANGED on an idle machine", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "1";
    expect(perfBudgetMs(50)).toBe(50);
  });

  test("and stretches only in proportion to the load it measured", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "2";
    expect(perfBudgetMs(50)).toBe(100);
  });
});

describe("a wait for a pushed event is load-aware too (#193)", () => {
  test("the base is generous, and it scales exactly like the per-test budget", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "1";
    expect(eventWaitMs()).toBe(EVENT_WAIT_BASE_MS);
    // Three times the 5000 ms literal the dashboard tests reddened against on an IDLE box.
    expect(EVENT_WAIT_BASE_MS).toBeGreaterThanOrEqual(15_000);
    process.env.TLDRX_TEST_LOAD_FACTOR = "4";
    expect(eventWaitMs()).toBe(spawnTestTimeout(EVENT_WAIT_BASE_MS));
    expect(eventWaitMs()).toBe(EVENT_WAIT_BASE_MS * 4);
    expect(eventWaitMs(2_000)).toBe(8_000);
  });

  /**
   * The instrument, not the behaviour. Every one of these waits is an `fs.watch`
   * notification racing a number, and while the number was a literal the load factor
   * could not reach it — measured 2026-09-09 under `load averages: 65-107` on a 14-core
   * box, `bun test test/dashboard-live.test.ts test/dashboard-server.test.ts` five times
   * in a row: runs 1, 4 and 5 red (3, 1 and 2 failures), a different test each time, at
   * 5084.27 / 5108.01 / 5256.49 ms against the 5000 ms literal and 2002.30 / 2002.55 /
   * 2005.47 ms against the 2000 ms one. Timing out on the literal is the tell: not one of
   * them failed on CONTENT.
   *
   * So the literal is what this forbids. Re-introducing one is the only way this flake
   * comes back, and it comes back at somebody's merge.
   */
  test.each(["dashboard-live.test.ts", "dashboard-server.test.ts"])(
    "%s passes no hard-coded millisecond deadline to a wait",
    (file) => {
      const source = readFileSync(join(TEST_DIR, file), "utf8");
      expect(source).toContain('from "./fixtures/machineLoad.ts"');
      expect(source).toContain("eventWaitMs(");
      // `sse.next("reload", 5_000)` and friends.
      expect([...source.matchAll(/\.next\([^)]*,\s*\d/g)].map((hit) => hit[0])).toEqual([]);
      // `const deadline = Date.now() + 2_000;` and friends.
      expect([...source.matchAll(/deadline\s*=\s*Date\.now\(\)\s*\+\s*\d/g)].map((h) => h[0])).toEqual([]);
      // A per-test budget is the sum of the waits it can sit through, so it scales too.
      expect([...source.matchAll(/\}\s*,\s*\d[\d_]*\s*\)\s*;/g)].map((hit) => hit[0])).toEqual([]);
    },
  );
});

describe("`fastestOf` reports the floor, which is what a stall cannot inflate", () => {
  test("one slow run among fast ones does not decide the number", () => {
    let call = 0;
    const stallOnce = () => { call += 1; if (call === 1) spin(80); };
    const fastest = fastestOf(3, stallOnce);
    expect(call).toBe(3);
    expect(fastest).toBeLessThan(20);
  });

  test("a single sample WOULD have been decided by that stall", () => {
    let call = 0;
    expect(fastestOf(1, () => { call += 1; if (call === 1) spin(80); })).toBeGreaterThanOrEqual(75);
  });

  test("a genuinely slow function still fails the budget — the assertion keeps its teeth", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = "1";
    expect(fastestOf(3, () => spin(120))).toBeGreaterThan(perfBudgetMs(50));
  });

  test("even at the cap, a 500 ms function fails a 50 ms budget", () => {
    process.env.TLDRX_TEST_LOAD_FACTOR = String(LOAD_FACTOR_CAP);
    expect(perfBudgetMs(50)).toBeLessThan(500);
  });
});

describe("every file that spawns a real process takes the load-aware timeout", () => {
  /**
   * Spawning is the tell — `git`, `bun`, the CLI. How long a process takes to start is a
   * property of the machine, so a fixed 5000 ms budget on such a test measures the box.
   * `makeBuildWorkspace` counts: it `git init`s a repo behind the caller's back, and so does
   * `makeSandbox` — `tldrx learn`'s sandbox builds a real repo and then runs the real CLI
   * against it as a subprocess, which is the same cost with a different name.
   *
   * `runTraining` is the fifth shape, and it was missed for a while (#194): a training turn
   * spawns the agent through `spawnAgent.ts`, so the child is as real as the CLI's, but the
   * file that calls it names neither `node:child_process` nor `Bun.spawn` — the spawn happens
   * two imports away. `makeTrainingWorkspace` rides along with it because that fixture is what
   * plants the fake `claude` on PATH for the turn to find; a file that only builds the
   * workspace and never trains is claimed too, which costs it one `setDefaultTimeout` line and
   * costs a missed spawner a false RED on a busy box. Over-claiming is the cheap direction.
   *
   * Read, never grepped. The first version of this list WAS a `grep -l`, and it silently
   * skipped `cli.test.ts` — one stray NUL byte at line 366 makes the file `data` to
   * file(1), and grep's `-I` drops binary files without a word. The test it hid then
   * timed out at 5004 ms on the very merge that was fixing timeouts.
   */
  const spawners = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      const source = readFileSync(join(TEST_DIR, f), "utf8");
      return [
        "node:child_process", "Bun.spawn", "makeBuildWorkspace", "makeSandbox",
        "runTraining", "makeTrainingWorkspace",
      ].some((m) => source.includes(m));
    });

  test("there are such files, so this invariant is not vacuous", () => {
    expect(spawners.length).toBeGreaterThanOrEqual(40);
    expect(spawners).toContain("cli.test.ts");
    // Anchored on purpose: `knowledge-value.test.ts` spawns ONLY through the training
    // fixture, so it is the file that says whether the training markers are still here.
    // Without this line, dropping them from the list would silently shrink the `test.each`
    // rows below to a shorter green, which is how a missing marker hides rather than fails.
    expect(spawners).toContain("knowledge-value.test.ts");
  });

  test.each(spawners)("%s calls setDefaultTimeout(spawnTestTimeout(…))", (file) => {
    const source = readFileSync(join(TEST_DIR, file), "utf8");
    expect(source).toContain('from "./fixtures/machineLoad.ts"');
    expect(source).toContain("setDefaultTimeout(spawnTestTimeout(");
  });
});
