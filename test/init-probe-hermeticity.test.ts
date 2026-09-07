/**
 * No test in this suite may run a real `tldrx init` that PROBES (#168, controller ruling 1).
 *
 * `init` now runs the inspected repo's own `build`/`test`/`lint`/`typecheck` commands. A test
 * that spawns the real CLI on a fixture therefore runs the BOX's toolchain inside a temp
 * directory, with the whole test environment inherited. That is not hypothetical: on the first
 * cut of this feature six call sites did exactly that, and `ps -Ao pid,ppid,command` caught
 * `dotnet build`, `dotnet test`, `dotnet format --verify-no-changes`, `npm run build` and
 * `npm run typecheck` as children of a test's CLI process. The suite stayed green — because
 * this machine happens to have npm and dotnet and a warm cache. On a machine without them, or
 * with a cold NuGet restore, each probe can burn up to the 120 s deadline inside a test file
 * whose whole budget is `spawnTestTimeout()`.
 *
 * Prose in a report cannot hold that line; the six sites were added by someone who had read the
 * rule. So this is the mechanical guard, in the style of the #80-family shape tests: it reads
 * every test source and refuses a real-CLI `init` invocation that does not pass `--no-probe`.
 *
 * How an invocation is RECOGNISED, and why it cannot be a grep:
 *   - `"init"` alone is far too common (a chapter id, a phase name, `git init`).
 *   - So the innermost bracketed region around each `"init"` literal is taken, and the region
 *     counts as a `tldrx init` invocation only when it names at least one flag that `tldrx init`
 *     DECLARES — read from `src/cli/helpText.ts`, the one registry, never retyped here.
 *     `git init -q --bare -b main` names none of them and drops out on its own, and so does
 *     `tldrx("init", "--nope")` — the usage-error test, which `parseInitArgs` refuses on the
 *     unknown flag before `init` does any work at all. Add a real flag to that call and this
 *     guard starts asking about it, which is the behaviour we want.
 *
 * What it CANNOT see, so nobody reads it as a proof it is not: it keys on the double-quoted
 * literal `"init"` and on double-quoted `"--flag"` tokens, so a single-quoted `'init'`, a
 * template literal, an argv array assembled from a `const` outside the bracketed region, and
 * a one-token `--root=<path>` form are all outside its reach. `measured` 2026-09-07, by
 * sweeping every one of those quoting forms across `test/`: no invocation in any of those
 * shapes exists today, so widening the two regexes would buy nothing now — it is the fix the
 * moment one appears, and this paragraph is here so that fix is obvious rather than archaeology.
 *
 * Reads files and calls one pure function. Spawns nothing, so it takes no load-aware timeout.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { declaredFlags } from "../src/cli/helpText.ts";

const TEST_DIR = join(FRAMEWORK_ROOT, "test");

/**
 * This file, which holds the pattern it searches for and no invocation of anything.
 * It is the ONLY exclusion by filename, and it is here so the scanner does not match itself.
 */
const SELF = "init-probe-hermeticity.test.ts";

/**
 * Helpers that RENDER a command line rather than run one. `displayCommand(["init", …])` is a
 * pure string function under test; passing it `--no-probe` would change an assertion about
 * formatting to satisfy a guard about spawning.
 */
const RENDERS_ONLY = ["displayCommand", "expandCommand"];

function sources(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && entry.name !== SELF) out.push(path);
    }
  };
  walk(TEST_DIR);
  return out;
}

const OPENERS = "([";
const CLOSERS = ")]";

/** The innermost `(…)` or `[…]` that encloses `at`, or "" when nothing does. */
export function enclosingRegion(source: string, at: number): string {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i -= 1) {
    const char = source[i] ?? "";
    if (CLOSERS.includes(char)) depth += 1;
    else if (OPENERS.includes(char)) {
      if (depth === 0) { start = i; break; }
      depth -= 1;
    }
  }
  if (start === -1) return "";
  depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** `file:line` of every real-CLI `init` invocation in `source` that does not pass `--no-probe`. */
export function probingInvocations(source: string, label: string, flags: ReadonlySet<string>): readonly string[] {
  const found: string[] = [];
  for (const hit of source.matchAll(/"init"/g)) {
    const at = hit.index ?? 0;
    const region = enclosingRegion(source, at);
    if (region === "") continue;
    const names = [...region.matchAll(/"--([a-z][a-z-]*)"/g)].map((flag) => flag[1] ?? "");
    if (!names.some((name) => flags.has(name))) continue;
    if (RENDERS_ONLY.some((name) => source.slice(Math.max(0, at - 80), at).includes(name))) continue;
    if (region.includes("--no-probe")) continue;
    found.push(`${label}:${String(source.slice(0, at).split("\n").length)}`);
  }
  return found;
}

describe("no test runs a real `tldrx init` that probes (#168, ruling 1)", () => {
  const flags = declaredFlags("init");

  test("the flag set comes from the registry and is not empty, so this is not vacuous", () => {
    expect(flags.has("no-probe")).toBe(true);
    expect(flags.has("provider")).toBe(true);
    // `git init --bare -b main` must not be mistaken for a tldrx invocation.
    expect(flags.has("bare")).toBe(false);
  });

  test("the recogniser fires on a real invocation and not on `git init`", () => {
    const cli = `await tldrx("init", "--root", root, "--provider", "static");`;
    const git = `await run(["git", "init", "-q", "--bare", "-b", "main", dir]);`;
    expect(probingInvocations(cli, "x.ts", flags)).toEqual(["x.ts:1"]);
    expect(probingInvocations(git, "x.ts", flags)).toEqual([]);
    expect(probingInvocations(`${cli.slice(0, -2)}, "--no-probe");`, "x.ts", flags)).toEqual([]);
  });

  test("every real-CLI `init` in test/ passes --no-probe", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const label = file.slice(FRAMEWORK_ROOT.length + 1);
      offenders.push(...probingInvocations(readFileSync(file, "utf8"), label, flags));
    }
    expect(offenders).toEqual([]);
  });
});
