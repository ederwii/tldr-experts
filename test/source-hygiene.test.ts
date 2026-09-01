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
 * NUL is the byte that hides a file: it is what the binary-file heuristic keys on.
 * A raw ESC does not hide anything (measured — `src/core/doctor/McpProbe.ts` carried
 * one for months and greps found it fine), so the two are checked SEPARATELY and for
 * different reasons.
 *
 * ESC is the second check (#52), and it is about LEGIBILITY, not about search. The one
 * that was in `McpProbe.ts` sat inside a regex literal where `\x1b` was meant, so the
 * source read `/<ESC>\[[0-9;]*m/g` and a reader — in a diff, in a review, in a terminal,
 * in most editors — saw `/\[[0-9;]*m/g`, which is a different and wrong-looking regex.
 * Someone tidying that is one keystroke from breaking `tldrx doctor --mcp` silently. It
 * is policed here rather than left to a style call because it costs one `indexOf`, and
 * because — measured across all 479 `.ts` files under src/test/bin/scripts — a raw ESC
 * has exactly one legitimate use in this repo, which is none: an escape sequence says
 * the same thing to the compiler and something readable to the human.
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

/** Where the first `byte` is, as `path:line`, or null. Located so a failure is actionable. */
function firstByte(byte: number, path: string, label = path): string | null {
  const bytes = readFileSync(path);
  const at = bytes.indexOf(byte);
  if (at === -1) return null;
  return `${label}:${bytes.subarray(0, at).toString("utf8").split("\n").length}`;
}

const NUL = 0x00;
const ESC = 0x1b;

const firstNul = (path: string, label = path): string | null => firstByte(NUL, path, label);
const firstEsc = (path: string, label = path): string | null => firstByte(ESC, path, label);

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

  test("no file contains a raw ESC byte — write `\\x1b`, which reads as itself (#52)", () => {
    const offenders = TS_FILES
      .map((rel) => firstEsc(join(REPO_ROOT, rel), rel))
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

  test("the ESC detector really detects — and does not fire on the escape SEQUENCE", () => {
    const planted = join(scratch, "planted-esc.ts");
    writeFileSync(planted, `const a = 1;\nconst b = "\x1b[32m";\n`);
    expect(firstEsc(planted, "planted-esc.ts")).toBe("planted-esc.ts:2");
    expect(firstNul(planted, "planted-esc.ts")).toBeNull();

    // The two-character source form `\` + `x1b` is what the fix writes, and it must
    // pass: policing the byte is only useful if the readable spelling is allowed.
    const escaped = join(scratch, "escaped.ts");
    writeFileSync(escaped, "const p = /\\x1b\\[[0-9;]*m/g;\n");
    expect(firstEsc(escaped, "escaped.ts")).toBeNull();
  });
});
