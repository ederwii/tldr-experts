/**
 * `tldrx update`, and the one-line new-version notice (issue #62).
 *
 * ## The gap
 *
 * The owner installed 0.4.0 on a second machine and found there was no way to ask
 * the tool to update itself, and no way to be told a newer one existed. Every other
 * CLI he uses tells him.
 *
 * ## The constraints, which are the whole design
 *
 * The issue is explicit, and each of these has a test below rather than a comment:
 *
 *   - **The registry is never on the hot path.** A command reads a CACHE FILE and
 *     nothing else; the network call happens in a DETACHED child after the output
 *     is written, and its answer is for the NEXT invocation.
 *   - **Silent on any network failure.** A refused connection, a 500, a body that is
 *     not JSON: all of them write nothing and print nothing.
 *   - **Never in `--json` output, and never during hook execution.** A hook must stay
 *     deterministic, and a JSON consumer must never be handed prose.
 *   - **One line, exactly**, in the wording the issue fixed.
 *   - **On by default, with an opt-out** (owner decision, 2026-09-01).
 *
 * ## What is NOT here
 *
 * No test in this file reaches the network, and none runs `npm`. `updateRun` takes a
 * transport for the same reason `shipRun` does: it is the only way to ASSERT the
 * argv of a command the suite must not run. The registry check takes its fetcher the
 * same way.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_FAILED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { compareVersions, isNewer } from "../src/core/update/version.ts";
import { changelogDelta } from "../src/core/update/changelog.ts";
import {
  CACHE_TTL_MS, REGISTRY_URL, UPDATE_CHECK_ENV, isFresh, noticeLine, readCache,
  suppressionReason, userCachePath, versionCheckOnce, writeCache,
} from "../src/core/update/notice.ts";
import { updateRun, type UpdateTransport } from "../src/core/update/update.ts";

let homes: string[] = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-home-"));
  homes.push(dir);
  return dir;
}

const CHANGELOG = [
  "# Changelog",
  "",
  "## 0.5.0 — 2026-09-10",
  "",
  "### Added",
  "",
  "- `tldrx update` and a version notice (#62).",
  "",
  "## 0.4.1 — 2026-09-05",
  "",
  "### Fixed",
  "",
  "- ship opens one PR per repo (#66).",
  "",
  "## 0.4.0 — 2026-09-01",
  "",
  "### Changed",
  "",
  "- Dependent epics share one integration branch (#57).",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Comparing versions
// ---------------------------------------------------------------------------

describe("version comparison", () => {
  test("orders by numeric field, not by string", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  test("a prerelease sorts BELOW the release it is a prerelease of", () => {
    expect(compareVersions("0.5.0-beta.1", "0.5.0")).toBeLessThan(0);
    expect(isNewer("0.5.0-beta.1", "0.4.0")).toBe(true);
  });

  test("nonsense is never newer — an unparseable version can only be silence", () => {
    expect(isNewer("not-a-version", "0.4.0")).toBe(false);
    expect(isNewer("", "0.4.0")).toBe(false);
    expect(isNewer("0.5.0", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cache: the only thing a command is allowed to read
// ---------------------------------------------------------------------------

describe("the version cache", () => {
  test("lives under the user config dir, not in the workspace", () => {
    const dir = home();
    expect(userCachePath(dir).startsWith(join(dir, ".tldrx"))).toBe(true);
  });

  test("a missing file reads as null rather than throwing", () => {
    expect(readCache(join(home(), ".tldrx", "nope.json"))).toBeNull();
  });

  test("an unreadable or corrupt file reads as null rather than throwing", () => {
    const dir = home();
    const path = userCachePath(dir);
    mkdirSync(join(dir, ".tldrx"), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    expect(readCache(path)).toBeNull();
    writeFileSync(path, '{"latest": 5}', "utf8");
    expect(readCache(path)).toBeNull();
  });

  test("round-trips what was written", () => {
    const path = userCachePath(home());
    writeCache(path, { latest: "0.5.0", checked_at: "2026-09-01T10:00:00.000Z" });
    expect(readCache(path)).toEqual({ latest: "0.5.0", checked_at: "2026-09-01T10:00:00.000Z" });
  });

  test("goes stale after about a day", () => {
    const at = Date.parse("2026-09-01T10:00:00.000Z");
    const cache = { latest: "0.5.0", checked_at: "2026-09-01T10:00:00.000Z" };
    expect(isFresh(cache, at + 1000)).toBe(true);
    expect(isFresh(cache, at + CACHE_TTL_MS - 1)).toBe(true);
    expect(isFresh(cache, at + CACHE_TTL_MS + 1)).toBe(false);
    // A clock that went backwards is not a licence to never check again.
    expect(isFresh(cache, at - CACHE_TTL_MS * 2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suppression — the half of the issue that is about not printing
// ---------------------------------------------------------------------------

/** The shape in which the notice IS allowed: a human, at a terminal, plain command. */
function allowed(over: Record<string, unknown> = {}) {
  return {
    command: "status",
    argv: [] as readonly string[],
    isTty: true,
    env: {} as Readonly<Record<string, string | undefined>>,
    home: home(),
    ...over,
  };
}

describe("when the notice must stay silent", () => {
  test("the default — a human at a terminal — is NOT suppressed (on by default)", () => {
    expect(suppressionReason(allowed())).toBeNull();
  });

  test("--json anywhere in argv suppresses it", () => {
    expect(suppressionReason(allowed({ argv: ["--json"] }))).not.toBeNull();
    expect(suppressionReason(allowed({ argv: ["status", "--json"] }))).not.toBeNull();
    expect(suppressionReason(allowed({ argv: ["--json=1"] }))).not.toBeNull();
  });

  test("hook execution suppresses it — a hook must stay deterministic", () => {
    expect(suppressionReason(allowed({ command: "hook" }))).not.toBeNull();
    expect(suppressionReason(allowed({ command: "statusline" }))).not.toBeNull();
  });

  test("`update` itself suppresses it — it is about to say more than one line", () => {
    expect(suppressionReason(allowed({ command: "update" }))).not.toBeNull();
  });

  test("a pipe suppresses it — a courtesy line is for a human, not for a script", () => {
    expect(suppressionReason(allowed({ isTty: false }))).not.toBeNull();
  });

  test("CI suppresses it", () => {
    expect(suppressionReason(allowed({ env: { CI: "true" } }))).not.toBeNull();
  });

  test(`${UPDATE_CHECK_ENV}=off is the env opt-out, and its spellings`, () => {
    for (const value of ["off", "0", "false", "no", "never"]) {
      expect(suppressionReason(allowed({ env: { [UPDATE_CHECK_ENV]: value } }))).not.toBeNull();
    }
    for (const value of ["on", "1", "true", ""]) {
      expect(suppressionReason(allowed({ env: { [UPDATE_CHECK_ENV]: value } }))).toBeNull();
    }
  });

  test("`update_check: off` in ~/.tldrx/config.yml is the persistent opt-out", () => {
    const dir = home();
    mkdirSync(join(dir, ".tldrx"), { recursive: true });
    writeFileSync(join(dir, ".tldrx", "config.yml"), "version: 1\nupdate_check: off\n", "utf8");
    expect(suppressionReason(allowed({ home: dir }))).not.toBeNull();

    writeFileSync(join(dir, ".tldrx", "config.yml"), "version: 1\nupdate_check: on\n", "utf8");
    expect(suppressionReason(allowed({ home: dir }))).toBeNull();
  });

  test("a config file that does not parse is not an opt-out, and not a crash", () => {
    const dir = home();
    mkdirSync(join(dir, ".tldrx"), { recursive: true });
    writeFileSync(join(dir, ".tldrx", "config.yml"), "\tnot: [yaml\n", "utf8");
    expect(suppressionReason(allowed({ home: dir }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The line itself
// ---------------------------------------------------------------------------

describe("the notice line", () => {
  test("is the exact sentence the issue asked for, and exactly one line", () => {
    const line = noticeLine("0.5.0", "0.4.0");
    expect(line).toBe("tldr-experts 0.5.0 available (you have 0.4.0) — tldrx update");
    expect((line ?? "").includes("\n")).toBe(false);
  });

  test("says nothing when there is nothing to say", () => {
    expect(noticeLine("0.4.0", "0.4.0")).toBeNull();
    expect(noticeLine("0.3.0", "0.4.0")).toBeNull();
    expect(noticeLine("", "0.4.0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The detached check — what the background child does
// ---------------------------------------------------------------------------

describe("the registry check that runs off the hot path", () => {
  test("writes the cache from the registry's answer", async () => {
    const dir = home();
    const asked: string[] = [];
    await versionCheckOnce({
      home: dir,
      now: new Date("2026-09-01T10:00:00.000Z"),
      fetchText: async (url) => {
        asked.push(url);
        return JSON.stringify({ version: "0.5.0" });
      },
    });
    expect(asked).toEqual([REGISTRY_URL]);
    expect(readCache(userCachePath(dir))).toEqual({
      latest: "0.5.0",
      checked_at: "2026-09-01T10:00:00.000Z",
    });
  });

  test("a network failure writes nothing and throws nothing", async () => {
    const dir = home();
    await versionCheckOnce({
      home: dir,
      now: new Date("2026-09-01T10:00:00.000Z"),
      fetchText: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(readCache(userCachePath(dir))).toBeNull();
  });

  test("a body that is not the JSON we asked for writes nothing", async () => {
    const dir = home();
    for (const body of ["<html>502</html>", "{}", '{"version": 5}']) {
      await versionCheckOnce({
        home: dir,
        now: new Date("2026-09-01T10:00:00.000Z"),
        fetchText: async () => body,
      });
      expect(readCache(userCachePath(dir))).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The CHANGELOG delta
// ---------------------------------------------------------------------------

describe("the CHANGELOG delta between two versions", () => {
  test("is every section above the old version, up to and including the new one", () => {
    const delta = changelogDelta(CHANGELOG, "0.4.0", "0.5.0");
    expect(delta).toContain("0.5.0");
    expect(delta).toContain("0.4.1");
    expect(delta).toContain("`tldrx update` and a version notice (#62).");
    expect(delta).toContain("ship opens one PR per repo (#66).");
    // Not the version you already had, and not what came before it.
    expect(delta).not.toContain("Dependent epics share one integration branch");
  });

  test("skipping a version still shows the ones in between", () => {
    expect(changelogDelta(CHANGELOG, "0.4.1", "0.5.0")).not.toContain("#66");
    expect(changelogDelta(CHANGELOG, "0.4.1", "0.5.0")).toContain("#62");
  });

  test("no movement is an empty delta, never a fabricated one", () => {
    expect(changelogDelta(CHANGELOG, "0.5.0", "0.5.0")).toBe("");
    expect(changelogDelta(CHANGELOG, "0.5.0", "0.4.0")).toBe("");
    expect(changelogDelta("", "0.4.0", "0.5.0")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// `tldrx update`
// ---------------------------------------------------------------------------

interface Call { readonly cmd: string; readonly args: readonly string[] }

function fakeNpm(
  answers: Readonly<Record<string, { exitCode?: number; stdout?: string; stderr?: string }>> = {},
): UpdateTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      const answer = answers[`${cmd} ${args[0] ?? ""}`] ?? answers[cmd];
      return { exitCode: answer?.exitCode ?? 0, stdout: answer?.stdout ?? "", stderr: answer?.stderr ?? "" };
    },
  };
}

/** A fake global prefix holding the version `npm i -g` is pretending to have put there. */
function installed(version: string, changelog = CHANGELOG): string {
  const root = mkdtempSync(join(tmpdir(), "tldrx-npmroot-"));
  homes.push(root);
  const dir = join(root, "tldr-experts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tldr-experts", version }), "utf8");
  writeFileSync(join(dir, "CHANGELOG.md"), changelog, "utf8");
  return root;
}

describe("tldrx update", () => {
  test("runs `npm i -g tldr-experts@latest` and prints the delta it actually installed", async () => {
    const root = installed("0.5.0");
    const dir = home();
    const transport = fakeNpm({ "npm root": { stdout: `${root}\n` } });
    const outcome = await updateRun({ current: "0.4.0", home: dir, transport });

    expect(outcome.code).toBe(EXIT_OK);
    const install = transport.calls.find((call) => call.args[0] === "i" || call.args[0] === "install");
    expect(install?.cmd).toBe("npm");
    expect(install?.args).toContain("-g");
    expect(install?.args).toContain("tldr-experts@latest");

    const text = outcome.lines.join("\n");
    expect(text).toContain("0.4.0");
    expect(text).toContain("0.5.0");
    expect(text).toContain("`tldrx update` and a version notice (#62).");
    expect(text).toContain("ship opens one PR per repo (#66).");
  });

  test("the version it reports is READ BACK from what was installed, not assumed", async () => {
    // npm succeeds but the registry had nothing newer: the honest answer is "no change".
    const root = installed("0.4.0");
    const transport = fakeNpm({ "npm root": { stdout: `${root}\n` } });
    const outcome = await updateRun({ current: "0.4.0", home: home(), transport });

    expect(outcome.code).toBe(EXIT_OK);
    const text = outcome.lines.join("\n");
    expect(text).toContain("0.4.0");
    expect(text.toLowerCase()).toContain("already");
    // Nothing invented: no changelog section is printed for a version that did not change.
    expect(text).not.toContain("#62");
  });

  test("npm failing is a failure that names the command, and claims no delta", async () => {
    const transport = fakeNpm({ "npm i": { exitCode: 1, stderr: "EACCES: permission denied\n" } });
    const outcome = await updateRun({ current: "0.4.0", home: home(), transport });

    expect(outcome.code).not.toBe(EXIT_OK);
    const text = outcome.lines.join("\n");
    expect(text).toContain("npm i -g tldr-experts@latest");
    expect(text).toContain("EACCES");
    expect(text).not.toContain("#62");
  });

  test("no npm on PATH is a sentence, not a stack, and installs nothing", async () => {
    const transport = fakeNpm({ "npm --version": { exitCode: 127, stderr: "command not found: npm\n" } });
    const outcome = await updateRun({ current: "0.4.0", home: home(), transport });

    expect(outcome.code).not.toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).toContain("npm");
    expect(transport.calls.some((call) => call.args[0] === "i")).toBe(false);
  });

  test("--dry-run prints the command and installs nothing", async () => {
    const transport = fakeNpm();
    const outcome = await updateRun({ current: "0.4.0", home: home(), transport, dryRun: true });

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).toContain("npm i -g tldr-experts@latest");
    expect(transport.calls.some((call) => call.args[0] === "i")).toBe(false);
  });

  test("a successful update refreshes the cache, so the notice stops at once", async () => {
    const root = installed("0.5.0");
    const dir = home();
    writeCache(userCachePath(dir), { latest: "0.5.0", checked_at: "2026-09-01T10:00:00.000Z" });
    const transport = fakeNpm({ "npm root": { stdout: `${root}\n` } });
    await updateRun({ current: "0.4.0", home: dir, transport });

    expect(readCache(userCachePath(dir))?.latest).toBe("0.5.0");
    // And with the new version installed, that cache no longer says anything.
    expect(noticeLine(readCache(userCachePath(dir))?.latest ?? "", "0.5.0")).toBeNull();
  });

  test("it never reaches the network itself — npm does, and only npm", async () => {
    const root = installed("0.5.0");
    const transport = fakeNpm({ "npm root": { stdout: `${root}\n` } });
    await updateRun({ current: "0.4.0", home: home(), transport });
    expect([...new Set(transport.calls.map((call) => call.cmd))]).toEqual(["npm"]);
  });

  test("an install that leaves nothing readable says so instead of guessing", async () => {
    const transport = fakeNpm({ "npm root": { stdout: `${join(tmpdir(), "tldrx-absent-root")}\n` } });
    const outcome = await updateRun({ current: "0.4.0", home: home(), transport });
    const text = outcome.lines.join("\n");
    expect(outcome.code).toBe(EXIT_OK);
    expect(text.toLowerCase()).toContain("could not");
    expect(text).not.toContain("#62");
  });
});

// ---------------------------------------------------------------------------
// The CLI surface
// ---------------------------------------------------------------------------

describe("the update command is wired in", () => {
  test("`tldrx update --help` answers without running npm", async () => {
    const { lookup } = await import("../src/cli/index.ts");
    expect(lookup("update")).toBeDefined();
    expect(lookup("update")?.implemented).toBe(true);
  });

  test("EXIT_FAILED is what a failed update returns", async () => {
    const transport = fakeNpm({ "npm i": { exitCode: 1, stderr: "boom\n" } });
    expect((await updateRun({ current: "0.4.0", home: home(), transport })).code).toBe(EXIT_FAILED);
  });
});
