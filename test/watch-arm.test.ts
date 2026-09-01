/**
 * `tldrx watch arm --run <id>` — the detector half of gh #65 (gh #69).
 *
 * `watch check` answers "what do I check now?". Nothing answered "the PR just
 * merged, go and check it", which is the half that happens without a human
 * remembering — and the failure #65 was filed about IS a memory failure. The
 * owner's own CD gap cost 19 destroyed records; a manual command would not have
 * caught it either, because nobody ran it.
 *
 * Owner decision, 2026-09-01: a BOUNDED LOCAL POLLER over `gh pr view`. No GitHub
 * Actions, no daemon, no background process. So every loop in the poller and
 * every loop in these tests is bounded by construction, and:
 *
 *   **no test here runs the real `gh`, and none of them touches a network.**
 *
 * The unit cases drive a recording fake transport — the only way to assert the
 * argv of a command the suite must not run. The one end-to-end case puts a STUB
 * `gh` first on PATH. The clock and the sleep are injected, so a test that covers
 * a one-hour timeout finishes in milliseconds and can never hang the suite.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../src/core/paths.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import type { ShipTransport } from "../src/core/run/ship.ts";
import {
  armRun, DEFAULT_INTERVAL_S, MIN_INTERVAL_S, watcherRelPath, type ArmOutcome,
} from "../src/core/watch/index.ts";
import { EXIT_AWAITING_HUMAN, EXIT_GATE_REFUSED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());

const BIN = join(FRAMEWORK_ROOT, "bin", "tldrx.ts");
const ORIGINAL_PATH = process.env.PATH ?? "";
let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const ws of open) ws.dispose();
  open = [];
});

const ONE = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

const CARD = [
  "---",
  "version: 1",
  "id: leaderboard",
  "epic: E1",
  'title: "Player leaderboard"',
  "stories: [S1]",
  "repos: [app]",
  "status: verified",
  "---",
  "",
  "# leaderboard · Player leaderboard",
  "",
  "## Signal",
  "- `leaderboard.refreshed` is written on every refresh [src: app:README.md:1]",
  "",
  "## Where",
  "- Application Insights → `traces` [src: app:README.md:1]",
  "",
  "## Healthy baseline",
  "- 12-40 refreshes/hour, measured 2026-08-29 [src: app:README.md:1]",
  "",
  "## Looks broken when",
  "- Zero refreshes for 30 minutes [src: app:README.md:1]",
  "",
  "## Query",
  "",
  "```kql",
  "traces",
  "```",
  "",
  "## Sources",
  "",
  "One emit site.",
  "",
].join("\n");

function workspace(): BuildWorkspace {
  const made = makeBuildWorkspace(ONE);
  open.push(made);
  return made;
}

/** A run that Build branched and Watch wrote a card for — what `ship` ships. */
function shipped(ws: BuildWorkspace, branches: readonly string[] = ["epic/e1"]): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: [...branches] } }));
  store.save();
  writeFileSync(join(ws.repoDir, "README.md"), "the app\n", "utf8");
  for (const branch of branches) {
    execFileSync("git", ["branch", branch], { cwd: ws.repoDir, stdio: "ignore" });
  }
  const cardPath = join(ws.runDir, watcherRelPath("leaderboard"));
  mkdirSync(join(cardPath, ".."), { recursive: true });
  writeFileSync(cardPath, CARD, "utf8");
}

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * A transport whose `gh pr view` answers change over successive polls.
 *
 * `views` is consumed one entry per poll; the last entry repeats, so a test that
 * wants "open forever" writes one entry and the poller's own bound is what stops
 * it — never the fixture running out.
 */
function poller(views: readonly { exitCode?: number; stdout?: string }[]): ShipTransport & {
  calls: Call[];
  views: number;
} {
  const calls: Call[] = [];
  const state = { views: 0 };
  return {
    calls,
    get views() {
      return state.views;
    },
    async run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      if (cmd === "git") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "pr" && args[1] === "view") {
        const at = Math.min(state.views, views.length - 1);
        state.views++;
        const answer = views[at] ?? {};
        return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: "" };
      }
      return { exitCode: 0, stdout: "gh version 2.62.0\n", stderr: "" };
    },
  };
}

const MERGED = { stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-09-01T18:04:00Z" }) };
const OPEN_PR = { stdout: JSON.stringify({ state: "OPEN", mergedAt: null }) };
const CLOSED = { stdout: JSON.stringify({ state: "CLOSED", mergedAt: null }) };

/** A clock that only ever moves when the poller sleeps. Bounded by construction. */
function fakeClock() {
  const state = { ms: 1_000_000, sleeps: [] as number[] };
  return {
    now: () => state.ms,
    sleep: (ms: number) => {
      state.sleeps.push(ms);
      state.ms += ms;
      return Promise.resolve();
    },
    get sleeps() {
      return state.sleeps;
    },
  };
}

async function arm(
  ws: BuildWorkspace,
  transport: ShipTransport,
  extra: Record<string, unknown> = {},
): Promise<ArmOutcome> {
  const clock = fakeClock();
  return await armRun({
    root: ws.root, runId: ws.runId, transport, now: clock.now, sleep: clock.sleep, ...extra,
  });
}

describe("it refuses cleanly when there is no shipped PR", () => {
  test("a run that cut no epic branch is told `ship` cannot have run", async () => {
    const ws = workspace();
    const transport = poller([MERGED]);
    const outcome = await arm(ws, transport);
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    expect(outcome.lines.join("\n")).toContain("tldrx ship");
    // Nothing was asked of gh: a refusal that has already talked to the network
    // is a refusal that took a decision it did not have the facts for.
    expect(transport.calls.some((call) => call.args[1] === "view")).toBe(false);
  });

  test("a branch with no PR names the branch and says it may be unpushed", async () => {
    const ws = workspace();
    shipped(ws);
    const transport = poller([{ exitCode: 1 }]);
    const outcome = await arm(ws, transport);
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const said = outcome.lines.join("\n");
    expect(said).toContain("epic/e1");
    expect(said).toContain("tldrx ship");
    expect(said.toLowerCase()).toContain("push");
  });

  test("`gh` missing is named as `gh` missing, not as a branch nobody shipped", async () => {
    const ws = workspace();
    shipped(ws);
    const transport: ShipTransport = {
      calls: [] as Call[],
      async run(cmd, args) {
        (transport as unknown as { calls: Call[] }).calls.push({ cmd, args: [...args] });
        if (cmd === "git") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 127, stdout: "", stderr: "command not found: gh\n" };
      },
    } as ShipTransport & { calls: Call[] };
    const outcome = await arm(ws, transport);
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const said = outcome.lines.join("\n");
    // The old failure mode: "no PR for this branch, run `tldrx ship`" — sending an
    // operator whose only problem is an uninstalled CLI to go and re-ship.
    expect(said).toContain("gh");
    expect(said).not.toContain("tldrx ship");
  });

  test("an interval under the floor is refused rather than quietly raised", async () => {
    const ws = workspace();
    shipped(ws);
    const outcome = await arm(ws, poller([MERGED]), { intervalS: 1 });
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    expect(outcome.lines.join("\n")).toContain(String(MIN_INTERVAL_S));
  });
});

describe("it asks gh exactly what #69 says to ask", () => {
  test("`gh pr view <branch> --json state,mergedAt`, in the repo the branch lives in", async () => {
    const ws = workspace();
    shipped(ws);
    const transport = poller([MERGED]);
    await arm(ws, transport);
    const view = transport.calls.find((call) => call.args[0] === "pr" && call.args[1] === "view");
    expect(view?.args).toEqual(["pr", "view", "epic/e1", "--json", "state,mergedAt"]);
  });
});

describe("a merge fires the checklist", () => {
  test("already merged: one poll, no sleep, and the `watch check` output", async () => {
    const ws = workspace();
    shipped(ws);
    const transport = poller([MERGED]);
    const clock = fakeClock();
    const outcome = await armRun({
      root: ws.root, runId: ws.runId, transport, now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.merged).toBe(true);
    expect(outcome.polls).toBe(1);
    expect(clock.sleeps).toEqual([]);
    const said = outcome.lines.join("\n");
    expect(said).toContain("2026-09-01T18:04:00Z");
    expect(said).toContain("Post-merge checks");
    expect(said).toContain("leaderboard.refreshed");
  });

  test("open, then merged: it sleeps ONE interval and detects on the second poll", async () => {
    const ws = workspace();
    shipped(ws);
    const clock = fakeClock();
    const outcome = await armRun({
      root: ws.root, runId: ws.runId, transport: poller([OPEN_PR, MERGED]),
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.merged).toBe(true);
    expect(outcome.polls).toBe(2);
    expect(clock.sleeps).toEqual([DEFAULT_INTERVAL_S * 1000]);
  });
});

describe("every loop is bounded", () => {
  test("a PR that never merges times out, says how to re-arm, and exits 4", async () => {
    const ws = workspace();
    shipped(ws);
    const clock = fakeClock();
    const outcome = await armRun({
      root: ws.root, runId: ws.runId, transport: poller([OPEN_PR]),
      intervalS: 60, timeoutS: 300, now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.code).toBe(EXIT_AWAITING_HUMAN);
    expect(outcome.merged).toBe(false);
    // 300s at 60s a poll: bounded, and small. Never an unbounded spin.
    expect(outcome.polls).toBeLessThanOrEqual(6);
    expect(clock.sleeps.length).toBeLessThanOrEqual(6);
    expect(outcome.lines.join("\n")).toContain("tldrx watch arm");
  });

  test("a PR CLOSED without merging stops now — polling it to the timeout is a lie", async () => {
    const ws = workspace();
    shipped(ws);
    const clock = fakeClock();
    const outcome = await armRun({
      root: ws.root, runId: ws.runId, transport: poller([CLOSED]),
      now: clock.now, sleep: clock.sleep,
    });
    expect(outcome.merged).toBe(false);
    expect(outcome.polls).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(outcome.lines.join("\n")).toContain("CLOSED");
  });
});

describe("through the CLI, against a stub gh on PATH", () => {
  test("`watch arm` prints the checklist when the stub says merged", () => {
    const ws = workspace();
    shipped(ws);
    const stub = join(ws.binDir, "gh");
    writeFileSync(stub, [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "gh version 2.62.0" ;;',
      '  *) echo \'{"state":"MERGED","mergedAt":"2026-09-01T18:04:00Z"}\' ;;',
      "esac",
      "",
    ].join("\n"), "utf8");
    chmodSync(stub, 0o755);

    const out = execFileSync(
      "bun",
      [BIN, "watch", "arm", "--run", ws.runId, "--root", ws.root, "--timeout", "120"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${ws.binDir}:${ORIGINAL_PATH}` } },
    );
    expect(out).toContain("Post-merge checks");
    expect(out).toContain("2026-09-01T18:04:00Z");
  });
});
