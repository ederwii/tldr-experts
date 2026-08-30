import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunRuntime, liveChildren, nodeRuntime, type Runtime } from "../src/core/runtime/index.ts";

/**
 * The seam is only worth having if both halves behave the same, so every test
 * here runs against BOTH implementations. The timeout cases exist because of a
 * real Linux-only CI failure (2026-08-28): `/bin/sh` is dash on Ubuntu and bash
 * on macOS, dash forks where bash `exec`s, and a killed shell therefore left a
 * live grandchild holding the stdout pipe. The spawn never settled and the DoD
 * gate hung instead of denying. `sleep … & wait` forks on BOTH platforms, so
 * these reproduce it everywhere rather than only on the machine that broke.
 */

const IMPLEMENTATIONS: readonly (readonly [string, Runtime])[] = [
  ["bunRuntime", bunRuntime],
  ["nodeRuntime", nodeRuntime],
];

/** The pids the registry has gained since `before` — this spawn's, and nothing else's. */
function added(before: ReadonlySet<number>): readonly number[] {
  return liveChildren().filter((pid) => !before.has(pid));
}

/** Poll until `ready()`, or give up after `limitMs` and let the assertion say so. */
async function until(ready: () => boolean, limitMs = 2_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const scratch = mkdtempSync(join(tmpdir(), "tldrx-runtime-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

for (const [name, runtime] of IMPLEMENTATIONS) {
  describe(`${name}.spawn`, () => {
    test("captures stdout and the exit code", async () => {
      const result = await runtime.spawn("/bin/sh", ["-c", "echo hello; exit 3"]);
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(3);
      expect(result.timedOut).toBe(false);
    });

    test("a command that does not exist comes back as 127, not a throw", async () => {
      const result = await runtime.spawn("tldrx-no-such-binary", []);
      expect(result.exitCode).toBe(127);
      expect(typeof result.stderr).toBe("string");
    });

    test("writes stdin and closes it", async () => {
      const result = await runtime.spawn("/bin/sh", ["-c", "cat"], { stdin: "piped-in\n" });
      expect(result.stdout).toBe("piped-in\n");
      expect(result.exitCode).toBe(0);
    });

    test("a timeout kills the shell's children too, and settles with strings", async () => {
      // `&` + `wait` forces a grandchild on every shell: killing only the shell
      // leaves `sleep` holding stdout, and the promise never settles.
      const started = Date.now();
      const result = await runtime.spawn("/bin/sh", ["-c", "sleep 30 & wait"], { timeoutMs: 300 });
      const elapsed = Date.now() - started;

      expect(result.timedOut).toBe(true);
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
      expect(elapsed).toBeLessThan(4_000);
    }, 10_000);

    test("a timeout kills a child that ignores SIGTERM", async () => {
      const started = Date.now();
      const result = await runtime.spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30 & wait"], { timeoutMs: 300 });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(4_000);
    }, 10_000);

    test("a command that finishes inside its timeout is not marked timed out", async () => {
      const result = await runtime.spawn("/bin/sh", ["-c", "echo quick"], { timeoutMs: 5_000 });
      expect(result.timedOut).toBe(false);
      expect(result.stdout.trim()).toBe("quick");
      expect(result.exitCode).toBe(0);
    });

    /**
     * The seam between wave Q and wave N. Q registers every spawned child so the
     * CLI's signal handler knows what to kill; N kills a child MID-TURN when the
     * `max_reads` cap bites. Both deliberate kills go through `killChildTree`,
     * which drops the pid IN THE SAME BREATH as it signals it.
     *
     * The assertion is deliberately taken BETWEEN the abort and the settle. A
     * bare `killProcessTree` would also leave an empty registry once the process
     * finally settled — the spawn unregisters on exit regardless — so a check
     * taken afterwards proves nothing. The window this closes is the one between
     * the kill and the exit: a Ctrl-C landing in it would have `killAllChildren`
     * signal a pid that is already dead, and which the OS may since have handed
     * to something else.
     *
     * The registry is global, so these track the ONE pid this spawn added rather
     * than counting the set: another spawn settling elsewhere is not this bug.
     */
    test("an abort drops the child from the registry at the kill, not at the settle", async () => {
      const before = new Set(liveChildren());
      const controller = new AbortController();
      const spawned = runtime.spawn("/bin/sh", ["-c", "sleep 30 & wait"], { signal: controller.signal });
      await until(() => added(before).length === 1);
      const pid = added(before)[0];

      const started = Date.now();
      controller.abort();
      // Synchronous with the abort: nothing is awaited between these two lines.
      expect(liveChildren()).not.toContain(pid);

      const result = await spawned;
      expect(Date.now() - started).toBeLessThan(4_000);
      // Aborted is not timed out: the caller stopped it, the clock did not.
      expect(result.timedOut).toBe(false);
      expect(typeof result.stdout).toBe("string");
      expect(liveChildren()).not.toContain(pid);
    }, 10_000);

    test("a timeout drops it the same way, and still reports timedOut", async () => {
      const before = new Set(liveChildren());
      const spawned = runtime.spawn("/bin/sh", ["-c", "sleep 30 & wait"], { timeoutMs: 2_000 });
      await until(() => added(before).length === 1);
      const pid = added(before)[0];

      const result = await spawned;
      expect(result.timedOut).toBe(true);
      expect(liveChildren()).not.toContain(pid);
    }, 10_000);

    // The ordering hazard the resolution created: the child is registered BEFORE
    // an already-aborted signal is checked, so the immediate kill has a pid to
    // drop. Registered after, this would leak the pid for the process's lifetime.
    test("a signal already aborted before the spawn leaks nothing", async () => {
      const before = new Set(liveChildren());
      const started = Date.now();
      const spawned = runtime.spawn("/bin/sh", ["-c", "sleep 30 & wait"], { signal: AbortSignal.abort() });
      expect(added(before)).toEqual([]);

      const result = await spawned;
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(typeof result.stdout).toBe("string");
      expect(added(before)).toEqual([]);
    }, 10_000);
  });

  describe(`${name} filesystem`, () => {
    test("exists() is true for a file, false for a directory and for nothing", async () => {
      const dir = join(scratch, `${name}-fs`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "a.txt"), "a\n", "utf8");

      expect(await runtime.exists(join(dir, "a.txt"))).toBe(true);
      expect(await runtime.exists(dir)).toBe(false);
      expect(await runtime.exists(join(dir, "missing.txt"))).toBe(false);
    });

    test("writeText creates missing parent directories", async () => {
      const path = join(scratch, `${name}-nested`, "deep", "note.md");
      await runtime.writeText(path, "written\n");
      expect(readFileSync(path, "utf8")).toBe("written\n");
      expect(await runtime.readText(path)).toBe("written\n");
    });
  });
}
