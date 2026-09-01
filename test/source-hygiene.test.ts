/**
 * Source files must stay readable by the tools that read source files.
 *
 * The bug behind this (#47): one literal NUL byte in `test/cli.test.ts` made file(1)
 * call it `data`, so `grep -I` — and ripgrep, and ugrep — dropped it from every sweep
 * SILENTLY, exit 0, no message. A `grep -lE 'child_process|Bun\.spawn' test/*.ts`
 * enumeration therefore came back 36 files with the 37th missing, that file did not get
 * the load-aware timeout it needed, and it timed out on the very next merge. Writing
 * this guard turned up a SECOND one, in `src/core/text/srcToken.ts` — same byte, same
 * silence, never reported.
 *
 * NUL is the byte that matters, and only NUL: it is what the binary-file heuristic keys
 * on. A raw ESC does not hide a file (measured — `src/core/doctor/McpProbe.ts` carries
 * one and greps fine), so this guard does not police it.
 *
 * The lesson is about instruments, not about one byte: a repo whose text is not text
 * cannot be searched, and the search does not say so. This guard keeps the instrument
 * honest, so the next grep-based sweep over `src/` or `test/` can be trusted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/** Every `.ts` under `dir`, recursively. Plain walk — no globbing, no shelling out. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

const TS_FILES = ["src", "test", "bin", "scripts"]
  .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
  .map((p) => p.slice(REPO_ROOT.length + 1))
  .sort();

/** Where the first NUL is, as `path:line`, or null. Located so a failure is actionable. */
function firstNul(path: string, label = path): string | null {
  const bytes = readFileSync(path);
  const at = bytes.indexOf(0);
  if (at === -1) return null;
  return `${label}:${bytes.subarray(0, at).toString("utf8").split("\n").length}`;
}

describe("every TypeScript source file is plain text a grep can see", () => {
  test("there are files to check, so this invariant is not vacuous", () => {
    expect(TS_FILES.length).toBeGreaterThan(100);
    expect(TS_FILES).toContain("test/cli.test.ts");
    expect(TS_FILES).toContain("src/core/text/srcToken.ts");
  });

  test("no file contains a NUL byte — that is what makes file(1) say `data`", () => {
    const offenders = TS_FILES
      .map((rel) => firstNul(join(REPO_ROOT, rel), rel))
      .filter((hit) => hit !== null);
    expect(offenders).toEqual([]);
  });

  const scratch = mkdtempSync(join(tmpdir(), "tldrx-hygiene-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("the detector really detects — a planted NUL is found, at its line", () => {
    const planted = join(scratch, "planted.ts");
    writeFileSync(planted, "const a = 1;\nconst b = 2;\nconst c = \"\0\";\n");
    expect(firstNul(planted, "planted.ts")).toBe("planted.ts:3");

    const clean = join(scratch, "clean.ts");
    writeFileSync(clean, "const a = 1;\nconst b = 2;\n");
    expect(firstNul(clean, "clean.ts")).toBeNull();
  });
});
