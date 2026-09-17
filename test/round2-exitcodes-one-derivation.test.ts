/**
 * `round2` and the spec §3 exit-code table, each pinned to ONE derivation (#174,
 * AGENTS.md §7).
 *
 * Measured (gh #174): `grep -rn "function round2" src/` found the same
 * `Math.round(n * 100) / 100` restated in NINE files — `core/seed/runTriage.ts`,
 * the training module's run entrypoint, `core/facilitator/runAuto.ts`,
 * `core/facilitator/executors/watch.ts`, `core/facilitator/runNext.ts`,
 * `core/build/caps.ts` (the one EXPORTED copy, already imported by
 * `build/phaseCost.ts`), `core/run/autoGate.ts`, `core/run/newRun.ts` and
 * `core/budget/remainingWork.ts`. (Its exact filename is elided here on
 * purpose: it is one of `test/machine-load.test.ts`'s textual spawn markers,
 * and naming it in THIS file's prose would misclassify this read-only guard as
 * a process-spawning test.) Separately, the spec §3 exit table
 * (`cli/exitCodes.ts`) is restated as unexported, unimported local consts in
 * `core/facilitator/runNext.ts` and `core/facilitator/runAuto.ts` — which is why a
 * golden-guard mutation of `cli/exitCodes.ts` left `test/build-golden.test.ts`
 * byte-identical: the Build path never reads that file's constants at all.
 *
 * The guard is on the SHAPE, not on nine names, for the reason
 * `phase-ids-one-derivation.test.ts` gives about its own family: deleting a
 * second copy does not stop a third, and a tenth `round2` under a name this file
 * never mentions would be the same defect. What is asserted is that only the
 * canonical file defines each — `export function round2` in `build/caps.ts`, and
 * `export const EXIT_*` in `cli/exitCodes.ts` — everywhere else under `src/`.
 *
 * `function round2(` (no `export`) and `const EXIT_[A-Z_]+ = <digits>;` (no
 * `export`) are exactly the local-redeclaration shapes measured above; the
 * canonical file's own `export function` / `export const` lines never match
 * either pattern, so no file needs to be excluded by name for the assertions to
 * hold — the regex tells the two apart on its own.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";

const THE_ONE_ROUND2 = "core/build/caps.ts";
const THE_ONE_EXIT_TABLE = "cli/exitCodes.ts";

/**
 * Every `.ts` / `.mts` / `.cts` file under `dir`, repo-relative and `/`-separated.
 *
 * A plain recursive readdir on purpose, not `walkFiles`: that walker drops any
 * directory named `build`, and `src/core/build/` — home of the one legitimate
 * `round2` — is real source. Same blind spot called out in
 * `pack-templates.test.ts` and `phase-ids-one-derivation.test.ts`.
 */
function sourceFilesUnder(dir: string, base = ""): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFilesUnder(join(dir, entry.name), rel));
    else if (/\.(?:ts|mts|cts)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** A LOCAL (non-exported) `round2` definition — the shape all nine copies shared. */
const LOCAL_ROUND2 = /^function round2\(/m;

/**
 * A LOCAL (non-exported) exit-code constant — the shape `runNext.ts` and
 * `runAuto.ts` restated. Matches `const EXIT_OK = 0;`, `const EXIT_REFUSED = 2;`,
 * etc.; never `export const EXIT_OK = 0;`, which is the canonical file's own line.
 */
const LOCAL_EXIT_CONST = /^const EXIT_[A-Z_]+\s*=\s*\d+;/m;

describe("round2 is defined once (#174)", () => {
  const srcRoot = join(FRAMEWORK_ROOT, "src");
  const files = sourceFilesUnder(srcRoot);

  test("the enumeration is not vacuous and reaches the directory the shared walker skips", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((file) => file.startsWith("core/build/"))).toBe(true);
    expect(files).toContain(THE_ONE_ROUND2);
  });

  test("the pattern can see a real local definition (control, over the pre-dedupe shape)", () => {
    // A local definition looks exactly like the nine measured copies did.
    expect(LOCAL_ROUND2.test("function round2(n: number): number {\n  return Math.round(n * 100) / 100;\n}")).toBe(true);
    // The canonical file's own EXPORTED line must not match its own guard.
    expect(LOCAL_ROUND2.test(readFileSync(join(srcRoot, THE_ONE_ROUND2), "utf8"))).toBe(false);
  });

  test("no file under src/ other than build/caps.ts defines a local `round2`", () => {
    const offenders = files.filter((file) => LOCAL_ROUND2.test(readFileSync(join(srcRoot, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("the spec §3 exit-code table is defined once (#174)", () => {
  const srcRoot = join(FRAMEWORK_ROOT, "src");
  const files = sourceFilesUnder(srcRoot);

  test("the enumeration reaches cli/", () => {
    expect(files).toContain(THE_ONE_EXIT_TABLE);
  });

  test("the pattern can see a real local table (control) and not the canonical exports", () => {
    expect(LOCAL_EXIT_CONST.test("const EXIT_OK = 0;\nconst EXIT_REFUSED = 2;\n")).toBe(true);
    expect(LOCAL_EXIT_CONST.test(readFileSync(join(srcRoot, THE_ONE_EXIT_TABLE), "utf8"))).toBe(false);
  });

  test("no file under src/ other than cli/exitCodes.ts restates the exit codes as local consts", () => {
    const offenders = files.filter((file) => LOCAL_EXIT_CONST.test(readFileSync(join(srcRoot, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
