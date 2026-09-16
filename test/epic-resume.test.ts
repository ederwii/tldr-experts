/**
 * #347 — "resume, don't restart": `tldrx run auto <runId>` (headless, nobody
 * present to type `--reuse-epic`) relaunching a run whose OWN `run.yml` already
 * claims an epic branch this exact PROCESS did not itself just cut.
 *
 * Before this change, `foreignEpicRefusal`'s `claimed.has(branch)` case was a
 * bare `continue`: silent, unverified, and — because `run auto` does not expose
 * `--reuse-epic` (`runNext.ts:946`) — a headless loop had no mechanized way to
 * say so. Owner decision, 2026-09-16: adopt automatically ONLY when the claim
 * is this run's OWN (`claimed.has(branch)` is exactly that — `build.epic_branch`
 * lives in this run's own `run.yml`, no other run's), and only after (a) the
 * branch head still resolves and (b) the workspace's `typecheck` passes in a
 * throwaway detached worktree — recorded honestly (`epic.resumed`, a line)
 * rather than trusted silently. A claim ANOTHER run wrote is refused exactly as
 * before; that guard is `test/claim-at-the-cut.test.ts`'s own GUARD and is
 * untouched here.
 *
 * The harness is `test/claim-at-the-cut.test.ts`'s #262 one, unchanged: a REAL
 * SIGKILL between the epic cut (and its synchronous claim) and the developer
 * turn returning — the one way a claimed-but-unfinished epic branch exists
 * without staging it by hand. The relaunch that follows is a genuinely FRESH
 * process (a fresh `EpicState`), so `foreignEpicRefusal` sees the branch
 * claimed ON DISK but not by `state.claimed` — the shape this change targets.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runNext, type NextOptions } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { EventLog } from "../src/core/events/EventLog.ts";
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

const DECLARED_COMMANDS = (typecheckScript: string | null) => ({
  build: null,
  test: "npm run test",
  lint: null,
  typecheck: typecheckScript === null ? null : "npm run typecheck",
  run: null,
});

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

function workspace(typecheckScript: string | null): BuildWorkspace {
  const made = makeBuildWorkspace({
    ...ONE_STORY,
    commands: DECLARED_COMMANDS(typecheckScript),
    ...(typecheckScript === null ? {} : { typecheckScript }),
  });
  open.push(made);
  process.env.PATH = made.binDir;
  process.env.FAKE_BUILD_STATE = made.statePath;
  return made;
}

function next(ws: BuildWorkspace, overrides: Partial<NextOptions> = {}): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root, dryRun: false, mode: "headless", yolo: false, actor: "alan",
    at: "2026-09-16T09:00:00Z", ...overrides,
  });
}

function claimedOnDisk(runDir: string): readonly string[] {
  return RunStore.open(runDir).run.build?.epic_branch ?? [];
}

function resumedEvents(runDir: string): readonly { readonly payload: Record<string, unknown> }[] {
  return EventLog.forRun(runDir).read().filter((e) => e.type === "epic.resumed");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cut `epic/e1`, claim it (#262, synchronous), then SIGKILL the process before
 * the developer turn returns — the harness `test/claim-at-the-cut.test.ts` uses,
 * unchanged. Leaves the run with `build.epic_branch: [epic/e1]` on disk and its
 * one story still pending, exactly as a real kill would.
 */
async function killMidStory(ws: BuildWorkspace): Promise<void> {
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

  proc.kill("SIGKILL");
  await proc.exited;
  if (developer !== null && isAlive(developer)) process.kill(developer, "SIGKILL");
}

describe("#347 — a fresh process resuming its OWN already-claimed epic branch", () => {
  test("with no typecheck declared: adopted, recorded honestly as absent, never silently", async () => {
    const ws = workspace(null);
    await killMidStory(ws);
    expect(claimedOnDisk(ws.runDir)).toContain("epic/e1");
    expect(resumedEvents(ws.runDir)).toEqual([]);

    const relaunch = await next(ws, { at: "2026-09-16T09:30:00Z" });
    const said = relaunch.lines.join("\n");
    expect(said).not.toContain("someone else's epic");
    expect(said).toContain("resumed `epic/e1` in app from");
    expect(said).toContain("claim by this run");
    expect(said).toContain("typecheck: absent");

    const events = resumedEvents(ws.runDir);
    expect(events.length).toBe(1);
    expect(events[0]?.payload).toMatchObject({ branch: "epic/e1", repo: "app", typecheck: "absent" });
    expect(typeof events[0]?.payload.sha).toBe("string");
    expect(events[0]?.payload.sha).not.toBe("");
  }, 180_000);

  test("with a passing typecheck declared: adopted, gate run, recorded as ok", async () => {
    const ws = workspace('node -e "process.exit(0)"');
    await killMidStory(ws);
    expect(claimedOnDisk(ws.runDir)).toContain("epic/e1");

    const relaunch = await next(ws, { at: "2026-09-16T09:30:00Z" });
    const said = relaunch.lines.join("\n");
    expect(said).toContain("resumed `epic/e1` in app from");
    expect(said).toContain("typecheck ok");

    const events = resumedEvents(ws.runDir);
    expect(events.length).toBe(1);
    expect(events[0]?.payload.typecheck).toBe("ok");
  }, 180_000);

  test("with a FAILING typecheck declared: refused, naming the command — never trusted", async () => {
    const ws = workspace('node -e "process.exit(1)"');
    await killMidStory(ws);
    expect(claimedOnDisk(ws.runDir)).toContain("epic/e1");

    const relaunch = await next(ws, { at: "2026-09-16T09:30:00Z" });
    const said = relaunch.lines.join("\n");
    expect(said).toContain("is this run's own claim");
    expect(said).toContain("resuming it failed");
    expect(said).toContain("npm run typecheck");
    expect(said).toContain("--reuse-epic");

    // Never adopted by inference, and no event says it was.
    expect(resumedEvents(ws.runDir)).toEqual([]);
  }, 180_000);
});
