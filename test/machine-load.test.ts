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
   * Read, never grepped. The first version of this list WAS a `grep -l`, and it silently
   * skipped `cli.test.ts` — one stray NUL byte at line 366 makes the file `data` to
   * file(1), and grep's `-I` drops binary files without a word. The test it hid then
   * timed out at 5004 ms on the very merge that was fixing timeouts.
   */
  const spawners = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      const source = readFileSync(join(TEST_DIR, f), "utf8");
      return ["node:child_process", "Bun.spawn", "makeBuildWorkspace", "makeSandbox"]
        .some((m) => source.includes(m));
    });

  test("there are such files, so this invariant is not vacuous", () => {
    expect(spawners.length).toBeGreaterThanOrEqual(40);
    expect(spawners).toContain("cli.test.ts");
  });

  test.each(spawners)("%s calls setDefaultTimeout(spawnTestTimeout(…))", (file) => {
    const source = readFileSync(join(TEST_DIR, file), "utf8");
    expect(source).toContain('from "./fixtures/machineLoad.ts"');
    expect(source).toContain("setDefaultTimeout(spawnTestTimeout(");
  });
});
