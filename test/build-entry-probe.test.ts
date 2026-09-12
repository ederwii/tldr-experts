/**
 * Build ENTRY proves the DoD can run IN A WORKTREE before a developer is paid
 * (#254).
 *
 * The measured failure, on a live workspace 2026-09-12 at tldrx 0.16.1: 18 h from
 * `run auto` to the first story that could run, five relaunches, two of them
 * environment. The repo's `install:` named `./install.sh`, which existed in the
 * human's checkout and was UNTRACKED — a `git worktree` carries tracked files
 * only — so every story's install failed identically in its own tree, each time
 * after the story was opened and immediately before the paid turn. The base
 * pre-flight was green throughout, correctly: it measures in the checkout, where
 * the file is.
 *
 * Every test here runs the REAL pipeline — a real git repo, real worktrees, a
 * real install script. Only the sub-agents are faked, and the load-bearing
 * assertion in the two red cases is that the fake was never spawned at all.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
import {
  UNTRACKED_INSTALL_MARKER, WORKTREE_PROBE_TTL_MS, WORKTREE_UNREACHABLE_MARKER,
  repoPathToken, resolveHead, worktreeProbeFor,
} from "../src/core/build/entryProbe.ts";
import { loadPreflight } from "../src/core/build/preflight.ts";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_STATE", "FAKE_BUILD_COST"] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

const ONE_STORY = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
} satisfies Partial<BuildWorkspaceOptions>;

/** An install that succeeds and says so — the shape `./install.sh` has in the wild. */
const INSTALL_SH = "#!/bin/sh\nexit 0\n";

/** What a real `npm ci` does, minus the network: put the binary in the tree. */
const INSTALL_JS = [
  "const fs = require('node:fs');",
  "fs.mkdirSync('node_modules/.bin', {recursive: true});",
  "fs.writeFileSync('node_modules/.bin/dodbin', '#!/bin/sh\\nexit 0\\n');",
  "fs.chmodSync('node_modules/.bin/dodbin', 0o755);",
  "",
].join("\n");

function make(options: Partial<BuildWorkspaceOptions>): BuildWorkspace {
  const made = makeBuildWorkspace({ ...ONE_STORY, ...options } as BuildWorkspaceOptions);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  process.env.FAKE_BUILD_COST = "0.10";
  return made;
}

/**
 * The BASE tree has its dependencies — as the live one did, which is exactly why
 * its pre-flight was green while every story worktree was 127. Gitignored, so the
 * dirty-tree refusal does not see it and no worktree inherits it.
 */
function installIntoCheckout(ws: BuildWorkspace): void {
  mkdirSync(join(ws.repoDir, "node_modules", ".bin"), { recursive: true });
  const bin = join(ws.repoDir, "node_modules", ".bin", "dodbin");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(bin, 0o755);
}

/** `tools/check.sh`: in the checkout, executable, and gitignored so git never tracks it. */
function writeCheckScript(ws: BuildWorkspace): void {
  mkdirSync(join(ws.repoDir, "tools"), { recursive: true });
  const script = join(ws.repoDir, "tools", "check.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(script, 0o755);
}

function next(ws: BuildWorkspace): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false,
    actor: "alan", at: "2026-08-29T09:00:00Z",
  }) as never;
}

/** Every event of one type the run wrote — the instrument for "nothing was spawned". */
function eventsOfType(ws: BuildWorkspace, type: string): readonly unknown[] {
  return (EventLog.forRun(ws.runDir).read() as readonly { type: string }[])
    .filter((event) => event.type === type);
}

describe("a declared command that names a path git does not track", () => {
  test("an untracked `install:` script refuses Build at entry, before anything is spawned", async () => {
    const ws = make({
      // Ignored so the dirty-tree door (#164) does not see it: the live repo's was
      // ignored too, which is exactly why nobody noticed it was never committed.
      repoFiles: { ".gitignore": "install.sh\n" },
      commands: { build: null, test: "npm run test", lint: null, typecheck: null, install: "./install.sh" },
    });
    const script = join(ws.repoDir, "install.sh");
    writeFileSync(script, INSTALL_SH, "utf8");
    chmodSync(script, 0o755);

    const result = await next(ws);
    const text = result.lines.join("\n");
    expect(result.code).toBe(2);
    expect(text).toContain(UNTRACKED_INSTALL_MARKER);
    expect(text).toContain("install.sh");
    expect(text).toContain("git add install.sh");
    // The whole point: not one paid turn, and not one story row.
    expect(eventsOfType(ws, "agent.spawned")).toHaveLength(0);
    expect(eventsOfType(ws, "story.opened")).toHaveLength(0);
  });

  test("GUARD (not a proof — it passed before the fix too): the same fixture with the script committed reaches the first story", async () => {
    const ws = make({
      commands: { build: null, test: "npm run test", lint: null, typecheck: null, install: "./install.sh" },
    });
    const script = join(ws.repoDir, "install.sh");
    writeFileSync(script, INSTALL_SH, "utf8");
    chmodSync(script, 0o755);
    execFileSync("git", ["add", "--chmod=+x", "install.sh"], { cwd: ws.repoDir });
    execFileSync("git", ["commit", "-m", "add install.sh"], { cwd: ws.repoDir });

    const result = await next(ws);
    expect(result.lines.join("\n")).not.toContain(UNTRACKED_INSTALL_MARKER);
    expect(eventsOfType(ws, "agent.spawned").length).toBeGreaterThan(0);
  });
});

describe("a DoD command whose binary the worktree will not have", () => {
  test("a DoD command naming a path the worktree lacks is refused at entry, not at story 1", async () => {
    const ws = make({
      repoFiles: { ".gitignore": "tools/\n" },
      commands: {
        build: null, test: "npm run test", lint: null, typecheck: null, check: "./tools/check.sh",
      },
      // FIRST in the list on purpose: nothing declared runs before it in the probe
      // tree, so its absence has exactly one reading. See the next test for what
      // happens when something could have built it.
      stories: [{ id: "S1", epic: "E1", title: "First story", dod: ["./tools/check.sh", "npm run test"] }],
    });
    writeCheckScript(ws);

    const result = await next(ws);
    const text = result.lines.join("\n");
    expect(result.code).toBe(2);
    expect(text).toContain(WORKTREE_UNREACHABLE_MARKER);
    expect(text).toContain("./tools/check.sh");
    expect(eventsOfType(ws, "agent.spawned")).toHaveLength(0);
  });

  test("THE DANGEROUS DIRECTION, second half: a path named AFTER another dod command is not refused", async () => {
    // A dod list runs in order, so `dod: ["npm run build", "dist/check.sh"]` is an
    // ordinary shape and the base pre-flight is honestly green on it — it runs the
    // whole list in the checkout. This probe deliberately runs no suite, so it
    // cannot tell "nobody committed it" from "the command before it builds it".
    // Undecidable means advisory, not verdict: the run goes on.
    const ws = make({
      repoFiles: { ".gitignore": "tools/\n" },
      commands: {
        build: null, test: "npm run test", lint: null, typecheck: null, check: "./tools/check.sh",
      },
      stories: [{ id: "S1", epic: "E1", title: "First story", dod: ["npm run test", "./tools/check.sh"] }],
    });
    writeCheckScript(ws);

    const result = await next(ws);
    expect(result.lines.join("\n")).not.toContain(WORKTREE_UNREACHABLE_MARKER);
    expect(result.code).not.toBe(2);
    expect(eventsOfType(ws, "agent.spawned").length).toBeGreaterThan(0);
  });

  test("THE DANGEROUS DIRECTION: a DoD command naming something the `install:` CREATES is not refused", async () => {
    // `node_modules/.bin/dodbin` is untracked in every repo on earth and it is
    // there by the time the DoD runs. A gate that refused this would block a whole
    // run, before a cent was spent, over a file that was always going to exist —
    // which is the expensive half of being wrong about an entry refusal.
    const ws = make({
      repoFiles: { ".gitignore": "node_modules/\n", "install.js": INSTALL_JS },
      commands: {
        build: null, test: "npm run test", lint: null, typecheck: null,
        install: "node install.js", check: "node_modules/.bin/dodbin",
      },
      stories: [{ id: "S1", epic: "E1", title: "First story", dod: ["npm run test", "node_modules/.bin/dodbin"] }],
    });
    installIntoCheckout(ws);

    const result = await next(ws);
    const text = result.lines.join("\n");
    expect(text).not.toContain(WORKTREE_UNREACHABLE_MARKER);
    expect(text).not.toContain(UNTRACKED_INSTALL_MARKER);
    expect(eventsOfType(ws, "agent.spawned").length).toBeGreaterThan(0);
  });
});

describe("what the probe reads, and what invalidates it", () => {
  test("only a token the spawn would resolve against the TREE is a repo path", () => {
    expect(repoPathToken("./install.sh")).toBe("install.sh");
    expect(repoPathToken("node_modules/.bin/dodbin")).toBe("node_modules/.bin/dodbin");
    // A bare name is a PATH lookup, identical in both trees — not the tree's answer.
    expect(repoPathToken("npm run test")).toBeNull();
    expect(repoPathToken("/usr/bin/true")).toBeNull();
    expect(repoPathToken("../outside/run.sh")).toBeNull();
    // Unsplittable: refused by the allowlist gate in its own words, not here.
    expect(repoPathToken("./a.sh | tee log")).toBeNull();
  });

  test("a bare head resolves the way the spawn resolves it, and a tree path against the tree", () => {
    expect(resolveHead("sh -c true", "/nonexistent")).not.toBeNull();
    expect(resolveHead("definitely-not-a-real-binary-254", "/nonexistent")).toBeNull();
    expect(resolveHead("./nope.sh", "/nonexistent")).toBeNull();
  });

  test("a green row is invalidated by a moved base, a changed declaration, and by age", () => {
    const row = {
      repo: "app", baseRef: "main", baseSha: "abc1234", status: "ok" as const, timedOut: false,
      tail: "green", declarationHash: "h1", checkedAt: "2026-09-12T10:00:00Z",
    };
    const fresh = { declarationHash: "h1", at: "2026-09-12T10:05:00Z" };
    expect(worktreeProbeFor([row], "app", "abc1234", fresh)).not.toBeNull();
    expect(worktreeProbeFor([row], "app", "def5678", fresh)).toBeNull();
    expect(worktreeProbeFor([row], "app", "abc1234", { ...fresh, declarationHash: "h2" })).toBeNull();
    const later = new Date(Date.parse(row.checkedAt) + WORKTREE_PROBE_TTL_MS + 1000).toISOString();
    expect(worktreeProbeFor([row], "app", "abc1234", { ...fresh, at: later })).toBeNull();
  });

  test("the measured row is cached beside the base result, so a resumed run does not re-pay", async () => {
    const ws = make({
      repoFiles: { ".gitignore": "node_modules/\n", "install.js": INSTALL_JS },
      commands: {
        build: null, test: "npm run test", lint: null, typecheck: null,
        install: "node install.js", check: "node_modules/.bin/dodbin",
      },
      stories: [{ id: "S1", epic: "E1", title: "First story", dod: ["npm run test", "node_modules/.bin/dodbin"] }],
    });
    installIntoCheckout(ws);
    await next(ws);
    const preflight = loadPreflight(ws.runDir);
    expect(preflight?.worktree?.length).toBe(1);
    const row = preflight?.worktree?.[0];
    expect(row?.repo).toBe(ws.repoName);
    expect(row?.status).toBe("ok");
    expect(typeof row?.durationMs).toBe("number");
    // The file it lives in is the base pre-flight's own, additively (§7).
    expect(readFileSync(join(ws.runDir, "04-build", "preflight.yml"), "utf8")).toContain("worktree:");
  });
});
