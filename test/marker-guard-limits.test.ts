/**
 * gh #324 — the three named limits of the #286 conflict-turn marker guard,
 * driven against a REAL git repo (the guard is `git diff`/`git ls-files` plus a
 * read, and a fake of either would be a test of the fake).
 *
 * What each describe below is about:
 *   - **An unreadable path is not a clean one** (limit 2). `holdsConflict` used
 *     to catch every read failure and return `false`: a guard failing OPEN, and
 *     silently. Now the path is NAMED with its reason and the CALL SITE decides
 *     — `markerGuardVerdict` is that decision, and it is tested under both
 *     policies here because the repo owner still owes the answer.
 *   - **ENOENT stays silent.** A file that vanished between the listing and the
 *     read cannot carry a marker into a commit, so it is genuinely clean — the
 *     one errno that must NOT raise a name.
 *   - **The scan is bounded and says so** (limit 3). A path skipped by the count
 *     cap or the size cap surfaces exactly as an unreadable one does; the old
 *     code had no cap at all, so "slow/large" was the only failure mode and
 *     "silently clean" was never one.
 *
 * Hermetic: every repo is a fresh `mkdtempSync` under this invocation's private
 * `$TMPDIR`, removed in `afterEach`; nothing reads a shared temp directory.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";
import {
  leftoverMerge, MARKER_SCAN_MAX_BYTES, MARKER_SCAN_MAX_PATHS, markerGuardVerdict,
} from "../src/core/build/git.ts";

setDefaultTimeout(spawnTestTimeout(120_000));

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    // A 000-mode file planted below would otherwise refuse its own removal.
    try { chmodSync(join(dir, "locked.ts"), 0o644); } catch { /* not every case plants one */ }
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

/** A fresh repo with one commit, and the sha the conflict turn would have been handed. */
function repoWithOneCommit(): { dir: string; since: string } {
  const dir = mkdtempSync(join(tmpdir(), "mg324-"));
  dirs.push(dir);
  const run = (...args: string[]): string => execFileSync("git", args, { cwd: dir }).toString();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  writeFileSync(join(dir, "kept.ts"), "export const kept = 1;\n");
  run("add", "-A");
  run("commit", "-qm", "base");
  return { dir, since: run("rev-parse", "HEAD").trim() };
}

describe("limit 2 — a path the guard could not READ is named, never counted clean", () => {
  test("an unreadable handed file is reported with its reason, and holds no marker claim", async () => {
    const { dir, since } = repoWithOneCommit();
    writeFileSync(join(dir, "locked.ts"), "<<<<<<< HEAD\n");
    chmodSync(join(dir, "locked.ts"), 0o000);
    const left = await leftoverMerge(dir, ["locked.ts"], since);
    expect(left.markers).toEqual([]);
    expect(left.unchecked.map((u) => u.path)).toEqual(["locked.ts"]);
    expect(left.unchecked[0]?.reason).toContain("EACCES");
  });

  test("a directory standing where a handed file should be is unchecked, not clean", async () => {
    const { dir, since } = repoWithOneCommit();
    mkdirSync(join(dir, "as-dir.ts"));
    const left = await leftoverMerge(dir, ["as-dir.ts"], since);
    expect(left.unchecked.map((u) => u.path)).toEqual(["as-dir.ts"]);
  });

  test("ENOENT is genuinely clean and stays SILENT — a vanished file carries nothing", async () => {
    const { dir, since } = repoWithOneCommit();
    const left = await leftoverMerge(dir, ["never-existed.ts"], since);
    expect(left.markers).toEqual([]);
    expect(left.unchecked).toEqual([]);
  });

  test("the POLICY is the call site's, not the guard's: refuse blocks, warn passes — both name it", () => {
    const left = { markers: [], inProgress: false, unchecked: [{ path: "locked.ts", reason: "EACCES" }] };
    const refuse = markerGuardVerdict(left, "refuse");
    expect(refuse.blocks).toBe(true);
    expect(refuse.unchecked).toContain("`locked.ts`");
    const warn = markerGuardVerdict(left, "warn");
    expect(warn.blocks).toBe(false);
    expect(warn.unchecked).toBe(refuse.unchecked);
  });

  test("markers and an open merge block under EITHER policy, and a clean read blocks under neither", () => {
    expect(markerGuardVerdict({ markers: ["a.ts"], inProgress: false, unchecked: [] }, "warn").blocks).toBe(true);
    expect(markerGuardVerdict({ markers: [], inProgress: true, unchecked: [] }, "warn").blocks).toBe(true);
    const clean = markerGuardVerdict({ markers: [], inProgress: false, unchecked: [] }, "refuse");
    expect(clean.blocks).toBe(false);
    expect(clean.unchecked).toBeNull();
  });
});

describe("limit 3 — the untracked scan is bounded, and a skip SAYS so", () => {
  test("a file over the size cap is unchecked and named, not read and not passed", async () => {
    const { dir, since } = repoWithOneCommit();
    writeFileSync(join(dir, "huge.bin"), `${"x".repeat(MARKER_SCAN_MAX_BYTES + 1)}\n<<<<<<< HEAD\n`);
    const left = await leftoverMerge(dir, [], since);
    expect(left.markers).toEqual([]);
    expect(left.unchecked.map((u) => u.path)).toEqual(["huge.bin"]);
    expect(left.unchecked[0]?.reason).toContain("cap");
  });

  test("a file just under the cap is READ, so the cap did not swallow the normal case", async () => {
    const { dir, since } = repoWithOneCommit();
    writeFileSync(join(dir, "big.ts"), `${"x".repeat(MARKER_SCAN_MAX_BYTES - 64)}\n<<<<<<< HEAD\n`);
    const left = await leftoverMerge(dir, [], since);
    expect(left.markers).toEqual(["big.ts"]);
    expect(left.unchecked).toEqual([]);
  });

  test("paths past the count cap are unchecked and named, in order, never silently clean", async () => {
    const { dir, since } = repoWithOneCommit();
    mkdirSync(join(dir, "gen"));
    for (let i = 0; i <= MARKER_SCAN_MAX_PATHS; i += 1) {
      writeFileSync(join(dir, "gen", `f${String(i).padStart(5, "0")}.ts`), "export const x = 1;\n");
    }
    const left = await leftoverMerge(dir, [], since);
    expect(left.unchecked.length).toBe(1);
    expect(left.unchecked[0]?.reason).toContain(String(MARKER_SCAN_MAX_PATHS));
  });
});

describe("limit 1 — a MODIFIED pre-existing file is in scope (measured, gh #324)", () => {
  test("markers pasted into a tracked file that neither conflicted nor was added are caught", async () => {
    const { dir, since } = repoWithOneCommit();
    writeFileSync(join(dir, "kept.ts"), "export const kept = 1;\n<<<<<<< HEAD\nstolen\n>>>>>>> other\n");
    const left = await leftoverMerge(dir, ["absent.ts"], since);
    expect(left.markers).toEqual(["kept.ts"]);
  });

  test("an ordinary modification is still clean — the widening did not turn every edit into a block", async () => {
    const { dir, since } = repoWithOneCommit();
    writeFileSync(join(dir, "kept.ts"), "export const kept = 2;\n=======\nunderline heading\n");
    const left = await leftoverMerge(dir, [], since);
    expect(left.markers).toEqual([]);
    expect(left.unchecked).toEqual([]);
  });
});
