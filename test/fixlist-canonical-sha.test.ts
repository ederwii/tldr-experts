/**
 * The fix list records the CANONICAL 40-hex sha, not whatever abbreviation
 * happened to check out (#130 follow-up, task 7 of the wave-1a records-and-money
 * plan, spec 2026-09-06-wave1a-records-money-design.md §2 "Fix-list canonical
 * sha").
 *
 * `RESOLVED_SHA_RE` accepts 7-40 hex characters on purpose — demanding 40 at
 * parse time would refuse the `yes 9f2c1ab` a person legitimately types. The gap
 * that leaves: `git rev-parse` resolves a 39-character sha exactly as happily as
 * a 7-character one, so a truncated 40-hex sha (one dropped character) reads as
 * a deliberate abbreviation, the claim verifies, and the record keeps a spelling
 * no later reader can tell apart from a prefix of a DIFFERENT commit.
 *
 * Three functions close that gap, tested here at each seam:
 *   - `canonicalSha` (git.ts) — the git resolution: a sha in, the full 40-hex
 *     object id or null out.
 *   - `canonicalizeResolvedSha` (fixlist.ts) — the text edit: replaces ONLY the
 *     sha token inside one finding's `Resolved: yes …` line, so whatever prose
 *     the grammar tolerates around it (`(9f2c1ab)`, `— commit 9f2c1ab`) survives.
 *   - `canonicalizeResolutions` (fixlist.ts) — the leaf `verifyResolutions`
 *     calls exactly once: walks the survivors of verification, resolves each
 *     one's sha, and returns the rewritten findings, text and report lines
 *     together so the call site is a single call with no conditional of its own.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha } from "../src/core/build/git.ts";
import { canonicalizeResolutions, canonicalizeResolvedSha, parseFixlistFile } from "../src/core/build/fixlist.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns a REAL git process to build repositories `canonicalSha` resolves
// against. Process cost is a property of the machine, not of the code (#43) — a fixed
// 5000 ms budget would measure the box, not the seam.
setDefaultTimeout(spawnTestTimeout());

let scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

/** A throwaway repo with one commit on `main`. */
function bareRepo(): { dir: string; sha: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-canonsha-"));
  scratch.push(dir);
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "fixture@example.com");
  run("config", "user.name", "tldrx fixture");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  run("add", "-A");
  run("commit", "-qm", "c1");
  return { dir, sha: run("rev-parse", "HEAD"), git: run };
}

describe("canonicalizeResolvedSha — replaces only the sha token, prose survives", () => {
  test("a Resolved: yes that names an abbreviation is rewritten to the full 40-hex object id", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const text = [
      "## 1 · The retry loop swallows the error  [major]",
      "",
      "Where: src/a.ts:12",
      "Disposition: **fix-now**",
      `Resolved: yes ${full.slice(0, 39)}`,
      "",
    ].join("\n");

    const rewritten = canonicalizeResolvedSha(text, 1, full);

    expect(rewritten).toContain(`Resolved: yes ${full}`);
    expect(rewritten).not.toContain(`${full.slice(0, 39)}\n`);
    // Everything else about the finding is left exactly as it was.
    expect(rewritten).toContain("Disposition: **fix-now**");
    expect(rewritten).toContain("Where: src/a.ts:12");
    expect(parseFixlistFile(rewritten)[0]?.resolvedSha).toBe(full);
  });

  test("touches no other finding, and no `no` line", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const text = [
      "## 1 · One  [minor]", "", "Disposition: **fix-now**", "Resolved: yes 0123456", "",
      "## 2 · Two  [minor]", "", "Disposition: **fix-now**", "Resolved: no", "",
    ].join("\n");

    const rewritten = canonicalizeResolvedSha(text, 1, full);

    expect(rewritten).toContain(`Resolved: yes ${full}`);
    expect(rewritten).toContain("Resolved: no");
  });

  test("a 7-40 hex abbreviation is still ACCEPTED by the parser — nothing legitimate is refused", () => {
    // The grammar is unchanged on purpose. Demanding 40 would refuse the `yes
    // 9f2c1ab` a person types, which is a real close; canonicalising after the
    // verification is strictly stronger and refuses nobody. Asserted through
    // `parseFixlistFile` rather than the private regex (AGENTS.md §8: behaviour,
    // not the constant that produced it).
    expect(parseFixlistFile([
      "## 1 · One  [minor]", "", "Disposition: **fix-now**", "Resolved: yes 9f2c1ab", "",
    ].join("\n"))[0]?.resolvedSha).toBe("9f2c1ab");
  });

  test("`yes (abbrev)` becomes `yes (<40hex>)` — the parens around it survive", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const abbrev = full.slice(0, 7);
    const text = [
      "## 1 · Finding  [minor]", "", "Disposition: **fix-now**", `Resolved: yes (${abbrev})`, "",
    ].join("\n");

    const rewritten = canonicalizeResolvedSha(text, 1, full);

    expect(rewritten).toContain(`Resolved: yes (${full})`);
    expect(parseFixlistFile(rewritten)[0]?.resolvedSha).toBe(full);
  });

  test("`yes — commit abbrev` becomes `yes — commit <40hex>` — the surrounding prose survives", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const abbrev = full.slice(0, 7);
    const text = [
      "## 1 · Finding  [minor]", "", "Disposition: **fix-now**", `Resolved: yes — commit ${abbrev}`, "",
    ].join("\n");

    const rewritten = canonicalizeResolvedSha(text, 1, full);

    expect(rewritten).toContain(`Resolved: yes — commit ${full}`);
    expect(parseFixlistFile(rewritten)[0]?.resolvedSha).toBe(full);
  });

  test("a bare `Resolved: yes` with no sha at all is left exactly alone", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const text = [
      "## 1 · Finding  [minor]", "", "Disposition: **fix-now**", "Resolved: yes", "",
    ].join("\n");

    expect(canonicalizeResolvedSha(text, 1, full)).toBe(text);
  });
});

describe("canonicalSha — the git resolution the record gets rewritten to", () => {
  test("a 7-hex abbreviation resolves to the full 40-hex object id", async () => {
    const { dir, sha } = bareRepo();

    const full = await canonicalSha(dir, sha.slice(0, 7));

    expect(full).toBe(sha);
    expect(full).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the full 40-hex object id resolves to itself — the idempotent case", async () => {
    const { dir, sha } = bareRepo();
    expect(await canonicalSha(dir, sha)).toBe(sha);
  });

  test("a sha git has never heard of resolves to null, not a guess", async () => {
    const { dir } = bareRepo();
    expect(await canonicalSha(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
  });

  test("a blob is not a commit — `^{commit}` refuses it, exactly like `shaReachability`", async () => {
    const { dir, git } = bareRepo();
    const blobSha = git("hash-object", "-w", join(dir, "a.txt"));
    expect(await canonicalSha(dir, blobSha)).toBeNull();
  });
});

describe("canonicalizeResolutions — the single leaf `verifyResolutions` calls", () => {
  test("a survivor's abbreviation is rewritten in the findings, the text, and reported once", async () => {
    const { dir, sha } = bareRepo();
    const abbrev = sha.slice(0, 7);
    const text = [
      "## 1 · Finding  [minor]", "", "Disposition: **fix-now**", `Resolved: yes ${abbrev}`, "",
    ].join("\n");

    const result = await canonicalizeResolutions(dir, parseFixlistFile(text), text);

    expect(result.findings[0]?.resolvedSha).toBe(sha);
    expect(result.text).toContain(`Resolved: yes ${sha}`);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain(abbrev);
    expect(result.lines[0]).toContain(sha);
  });

  test("a sha that already names the full object id is left alone — idempotent, no report line", async () => {
    const { dir, sha } = bareRepo();
    const text = [
      "## 1 · Finding  [minor]", "", "Disposition: **fix-now**", `Resolved: yes ${sha}`, "",
    ].join("\n");
    const findings = parseFixlistFile(text);

    const result = await canonicalizeResolutions(dir, findings, text);

    expect(result.text).toBe(text);
    expect(result.lines).toEqual([]);
    expect(result.findings).toEqual(findings);
  });

  test("a second run over its own output changes nothing further", async () => {
    const { dir, sha } = bareRepo();
    const abbrev = sha.slice(0, 7);
    const text = [
      "## 1 · Finding  [minor]", "", "Disposition: **fix-now**", `Resolved: yes ${abbrev}`, "",
    ].join("\n");

    const first = await canonicalizeResolutions(dir, parseFixlistFile(text), text);
    const second = await canonicalizeResolutions(dir, first.findings, first.text);

    expect(second.text).toBe(first.text);
    expect(second.lines).toEqual([]);
  });

  test("an unresolved finding and a bare `yes` with no sha are left alone, and nothing about them is reported", async () => {
    const { dir } = bareRepo();
    const text = [
      "## 1 · One  [minor]", "", "Disposition: **fix-now**", "Resolved: no", "",
      "## 2 · Two  [minor]", "", "Disposition: **fix-now**", "Resolved: yes", "",
    ].join("\n");
    const findings = parseFixlistFile(text);

    const result = await canonicalizeResolutions(dir, findings, text);

    expect(result.text).toBe(text);
    expect(result.lines).toEqual([]);
    expect(result.findings).toEqual(findings);
  });

  test("only the named finding is rewritten — its siblings, including a `no`, are untouched", async () => {
    const { dir, sha } = bareRepo();
    const abbrev = sha.slice(0, 7);
    const text = [
      "## 1 · One  [minor]", "", "Disposition: **fix-now**", "Resolved: no", "",
      "## 2 · Two  [minor]", "", "Disposition: **fix-now**", `Resolved: yes ${abbrev}`, "",
    ].join("\n");
    const findings = parseFixlistFile(text);

    const result = await canonicalizeResolutions(dir, findings, text);

    expect(result.text).toContain("Resolved: no");
    expect(result.text).toContain(`Resolved: yes ${sha}`);
    expect(result.findings[0]?.resolvedSha).toBeNull();
    expect(result.findings[1]?.resolvedSha).toBe(sha);
  });

  test("a sha git will not resolve at all is left as-is — resolution never invents a commit", async () => {
    const { dir } = bareRepo();
    const text = [
      "## 1 · Finding  [minor]", "", "Disposition: **fix-now**", "Resolved: yes deadbeefdeadbeef", "",
    ].join("\n");
    const findings = parseFixlistFile(text);

    const result = await canonicalizeResolutions(dir, findings, text);

    expect(result.text).toBe(text);
    expect(result.lines).toEqual([]);
    expect(result.findings[0]?.resolvedSha).toBe("deadbeefdeadbeef");
  });
});
