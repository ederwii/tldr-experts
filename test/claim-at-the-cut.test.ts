/**
 * #262 — the Build executor records the epic branch it just cut BEFORE the turn
 * that can be killed.
 *
 * `ExecutorOutcome.epicBranches` reaches `run.yml` only after the executor
 * RETURNS, and a Build stage does not return for as long as a developer turn
 * takes. A SIGKILL in that window — a cancelled session, an OOM kill, a power
 * cut — leaves `epic/<slug>` in the repo and nothing in `build.epic_branch` to
 * say this run cut it, and the relaunch is then refused its OWN epic: "refusing
 * to stack this run's commits onto someone else's epic"
 * (`src/core/build/branchClaims.ts`). SIGINT and SIGTERM are hooked
 * (`src/cli/signals.ts`); SIGKILL cannot be, by any process, ever.
 *
 * So the kill here is a REAL one. A simulated throw would re-test #248 — the
 * same symptom with a mechanism that has a process left to run its catch — and
 * would have passed green before this change, proving nothing about this one.
 * The fake developer blocks on `FAKE_BUILD_SLEEP_MS`, the test waits for its pid
 * file (never for a number of milliseconds), kills the `tldrx` process with
 * SIGKILL, and reads `run.yml` off disk exactly as the next invocation would.
 *
 * The dangerous direction is pinned in the same file: an epic branch this run did
 * NOT cut is still refused. That guard PASSED before this change and is labelled
 * as one — it exists so that persisting the claim earlier can never be mistaken
 * for teaching the guard to accept inferred evidence. The claim is a RECORD.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(import.meta.dir, "..", "bin", "tldrx.ts");
const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_STATE", "FAKE_BUILD_COST", "FAKE_BUILD_SLEEP_MS", "FAKE_BUILD_PID_DIR"] as const;

const ONE_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(): BuildWorkspace {
  const made = makeBuildWorkspace(ONE_STORY);
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan",
    at: "2026-08-29T09:00:00Z", ...overrides,
  });
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Every `epic/*` branch in the repo — the second half of "one epic, not two". */
function epicBranches(repoDir: string): string[] {
  const out = git(repoDir, "branch", "--list", "epic/*", "--format=%(refname:short)");
  return out === "" ? [] : out.split("\n");
}

/** `build.epic_branch` as a process starting NOW would read it. */
function claimedOnDisk(runDir: string): readonly string[] {
  return RunStore.open(runDir).run.build?.epic_branch ?? [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("#262 — a SIGKILL between the cut and the return", () => {
  test("the claim is on disk before the developer turn, and the relaunch adopts its own epic", async () => {
    const ws = workspace();
    const pidDir = join(ws.root, "pids");

    const proc = Bun.spawn([process.execPath, BIN, "next", "--root", ws.root, "--ui", "off"], {
      cwd: ws.root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: ws.binDir,
        FAKE_BUILD_STATE: ws.statePath,
        FAKE_BUILD_PID_DIR: pidDir,
        // Long enough that the developer is certainly still blocked when the kill
        // lands — the wait below is on the FILE, never on this number.
        FAKE_BUILD_SLEEP_MS: "30000",
      },
    });

    const devPid = (): number | null => {
      if (!existsSync(pidDir)) return null;
      const file = readdirSync(pidDir).find((name) => name.startsWith("developer-"));
      return file === undefined ? null : Number(readFileSync(join(pidDir, file), "utf8").trim());
    };
    const deadline = Date.now() + spawnTestTimeout();
    while (devPid() === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const developer = devPid();
    expect(developer, "the developer turn never started").not.toBeNull();

    // The window this issue is about: the branch is in the repo, and the process
    // that cut it has not returned.
    expect(epicBranches(ws.repoDir)).toEqual(["epic/e1"]);

    proc.kill("SIGKILL");
    await proc.exited;
    // The blocked fake is this test's own grandchild; nothing else may outlive it.
    if (developer !== null && isAlive(developer)) process.kill(developer, "SIGKILL");

    // RED before the fix: the record says nothing, because the only writer of it
    // runs after a return that never happened.
    expect(claimedOnDisk(ws.runDir)).toContain("epic/e1");

    // And the consequence the operator actually hit: the relaunch is refused its
    // own epic. `run auto` cannot pass `--reuse-epic`, so this is a dead end.
    const again = await next(ws, { at: "2026-08-29T09:30:00Z" });
    const said = again.lines.join("\n");
    expect(said).not.toContain("someone else's epic");
    expect(claimedOnDisk(ws.runDir)).toEqual(["epic/e1"]);
    expect(epicBranches(ws.repoDir)).toEqual(["epic/e1"]);
  }, 180_000);
});

describe("#262 GUARD (passed before the change) — a foreign epic is still refused", () => {
  test("`epic/e1` cut by someone else, with no claim behind it, refuses exactly as it did", async () => {
    const ws = workspace();
    // Cut by a different run, off this test's control: nothing under
    // `tldrx-work/` records it, which is the case `branchClaims.ts` keeps
    // verbatim precisely so #262's relaunch finds its epic where it left it.
    git(ws.repoDir, "branch", "epic/e1");

    const outcome = await next(ws);
    const said = outcome.lines.join("\n");

    expect(said).toContain("refusing to stack this run's commits onto someone else's epic");
    expect(said).toContain("no run under tldrx-work/ records cutting it");
    // The run did not adopt it by inference, and wrote no claim to say it had.
    expect(claimedOnDisk(ws.runDir)).toEqual([]);
  }, 120_000);
});
