/**
 * A run may not read `done` over nothing delivered (gh #210).
 *
 * ## What was measured, and what these tests hold
 *
 * tldrx 0.14.2, two real workspaces, 2026-09-09: two engine-driven runs printed
 * `run <id> is done`, both Build gates were approved by the owner from his phone,
 * and both delivered ZERO stories. The whole of what he had to decide on was
 * `{"phase":"04-build","cost_usd":1.78,"outputs":["04-build/handoff.md"],
 * "checks":["claim-sources:passed"]}`. The information existed on disk at that
 * instant — the same run's `04-build/handoff.md` `## Findings` said
 * `S1 · … — blocked — … npm run test exited 127 …` — and nothing carried it.
 *
 * So, four halves, each with its own describe below:
 *
 *  (a) the Build `gate.requested` carries `stories` counts and the first blocked
 *      story's id and reason, on EVERY gate policy, and the notification the
 *      owner reads says it in its SUMMARY.
 *  (b) `run.yml` records an additive `outcome:` when the run closes, and
 *      `run status` / the `run.finished` notification render it.
 *  (c) `tldrx ship` REFUSES a run that delivered no story (exit family 1), and a
 *      run that delivered one ships exactly as it did before.
 *  (d) the two absences are named, never invented: a run.yml written before the
 *      field reads `not recorded`, and a run with no Build phase reads `n/a`.
 *
 * The blocked story is real, not stubbed: `GOLDEN_REFUSED` is the committed
 * fixture whose DoD command the gate DECLINES to run (#165), so the fake agent
 * writes code, the story settles `blocked` with the gate's own sentence, and the
 * stage parks at its human gate. Every assertion below reads what that produced.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { buildStatus, renderStatus } from "../src/core/run/runStatus.ts";
import { shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { gateNotification, runEndNotification } from "../src/core/notify/notifications.ts";
import { EXIT_OK, EXIT_USAGE } from "../src/cli/exitCodes.ts";
import { OUTCOME_NOT_RECORDED, type RunFile } from "../src/core/run/RunFile.ts";
import {
  deliveredPhrase, deriveRunOutcome, describeRunOutcome, outcomeLine, storiesView, withRunOutcome,
} from "../src/core/run/runOutcome.ts";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import { GOLDEN_REFUSED, GOLDEN_STORY } from "./fixtures/build/golden.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns real processes — git, the fake `claude`, `npm run test`.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_PROMPT_DIR"] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/** A workspace whose fake `claude` is the only one on PATH. Its own `mkdtemp` root (#95/#97). */
function workspace(plan: Parameters<typeof makeBuildWorkspace>[0]): BuildWorkspace {
  const ws = makeBuildWorkspace(plan);
  open.push(ws);
  process.env.PATH = ws.binDir;
  process.env.FAKE_BUILD_STATE = ws.statePath;
  process.env.FAKE_BUILD_COST = "0.10";
  const promptDir = join(ws.root, "prompts");
  mkdirSync(promptDir, { recursive: true });
  process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
  return ws;
}

function build(ws: BuildWorkspace): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-29T09:00:00Z",
  });
}

/** Every event of one kind, in order, as plain records. */
function eventsOf(ws: BuildWorkspace, type: string): readonly Record<string, unknown>[] {
  const path = join(ws.runDir, "events.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === type);
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

// --- (a) the Build gate tells the story outcomes ------------------------------

describe("a Build gate says what the stage delivered (#210)", () => {
  test("gate.requested carries the counts and the first blocked story's reason", async () => {
    const ws = workspace(GOLDEN_REFUSED);

    const ran = await build(ws);

    // The premise: the story really did block, and the stage really did park at
    // a human gate. Without both, everything below is asserting about nothing.
    expect(readFileSync(join(ws.runDir, "03-plan", "stories", "S1.md"), "utf8")).toContain("status: blocked");
    const requested = eventsOf(ws, "gate.requested");
    expect(requested.length, `one gate.requested; the build exited ${String(ran.code)}`).toBe(1);

    const payload = payloadOf(requested[0]!);
    expect(payload.stories).toEqual({
      total: 1, done: 0, in_progress: 0, review: 0, blocked: 1, todo: 0,
    });
    expect(payload.blocked_story).toBe("S1");
    // The gate's own sentence, carried through from the handoff verbatim — not a
    // word this test supplies, and the whole of what #210 said was missing.
    expect(String(payload.blocked_reason)).toContain(
      "`npm run test | tee lint.log` was REFUSED in repo app and never ran",
    );
  }, 180_000);

  test("the terminal line and the notification summary both say it", async () => {
    const ws = workspace(GOLDEN_REFUSED);

    const ran = await build(ws);

    const view = storiesView(ws.runDir);
    expect(view, "the run has a plan on disk").not.toBeNull();
    // The EXPORTED phrase builder, asserted as an exact prefix rather than as
    // English prose that innocent text could satisfy (AGENTS.md §8).
    expect(deliveredPhrase(view!)).toStartWith("0 of 1 stories delivered, S1 blocked (");
    expect(ran.lines.join("\n")).toContain(`stories: ${deliveredPhrase(view!)}`);

    const notification = gateNotification(
      { runId: ws.runId, stage: "04-build/build", root: ws.root, at: "2026-08-29T09:00:00Z" }, 0.1, "human", [], view,
    );
    // The SUMMARY, not only the detail: the summary is the half that reaches a
    // lock screen, and it is the half that said only a dollar figure in #210.
    expect(notification.summary).toContain(`It ${deliveredPhrase(view!)}.`);
    expect(notification.detail.blocked_story).toBe("S1");
  }, 180_000);
});

// --- (b) an honest run outcome ------------------------------------------------

describe("a run records what it delivered (#210)", () => {
  test("run.yml gets outcome: nothing-delivered, and run status prints it", async () => {
    const ws = workspace(GOLDEN_REFUSED);
    await build(ws);

    // What the three close paths do, through the one helper they share.
    const store = RunStore.open(ws.runDir);
    store.mutate((run) => withRunOutcome(run, ws.runDir));
    store.save();

    // Read back OFF DISK: a helper returning the right object proves nothing
    // about what the emitter wrote.
    const text = readFileSync(join(ws.runDir, "run.yml"), "utf8");
    expect(text).toContain("outcome: {kind: nothing-delivered, stories_done: 0, stories_total: 1, "
      + "stories_blocked: 1, first_blocked: ");
    const reread = RunStore.open(ws.runDir).run;
    expect(reread.outcome?.kind).toBe("nothing-delivered");

    // `run status` on the closed run. The status word is forced to `done`
    // because that is the state #210 is about: every stage terminal, nothing
    // delivered, and the screen said only `done`.
    const closed: RunFile = { ...reread, status: "done" };
    const rendered = renderStatus(buildStatus(closed, RunStore.open(ws.runDir).budget, ws.runDir));
    expect(rendered).toContain("status done — nothing delivered: 0 of 1 stories; S1 — ");
  }, 180_000);

  test("the run.finished notification says it in its summary", () => {
    const outcome = { kind: "nothing-delivered", stories_done: 0, stories_total: 3, stories_blocked: 1,
      first_blocked: "S1 — npm run test exited 127" } as const;
    const notification = runEndNotification(
      { runId: "260909-x", stage: null, root: "/tmp/x", at: "2026-09-09T10:00:00Z" }, EXIT_OK, 1.78, "run 260909-x is done",
      { usd: 1.78, unmetered: 0, metered: 3 },
      // `note` (#164) is the sixth parameter and this is the seventh; null here
      // is "no foreign work was held", which is the ordinary case.
      null, outcomeLine(outcome),
    );
    expect(notification.summary)
      .toContain("The run: nothing delivered: 0 of 3 stories; S1 — npm run test exited 127.");
    expect(notification.detail.outcome).toBe("nothing-delivered");
  });
});

// --- (c) ship refuses when nothing merged -------------------------------------

/** A transport that answers every probe healthily, so only the new refusal can stop `ship`. */
function healthyTransport(): ShipTransport {
  return {
    async run(cmd, args) {
      const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
      const answers: Readonly<Record<string, string>> = {
        "gh --version": "gh version 2.62.0\n",
        "git remote": "origin\n",
        "git ls-remote --heads": "a1b2c3\trefs/heads/epic/e1\n",
        "gh pr list": "[]\n",
        "gh pr create": "https://github.com/x/app/pull/7\n",
      };
      return { exitCode: 0, stdout: answers[key] ?? "", stderr: "" };
    },
  };
}

/** Give the run the branch `ship` needs, cut for real in the fixture repo. */
function readyToShip(ws: BuildWorkspace): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: ["epic/e1"] } }));
  store.save();
  const repo = join(ws.root, "app");
  const branches = execFileSync("git", ["branch", "--list", "epic/e1"], { cwd: repo, encoding: "utf8" });
  if (branches.trim() === "") {
    execFileSync("git", ["branch", "epic/e1"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  }
}

describe("tldrx ship refuses a run that delivered nothing (#210)", () => {
  test("exit family 1, naming the counts and the first blocked reason", async () => {
    const ws = workspace(GOLDEN_REFUSED);
    await build(ws);
    readyToShip(ws);

    const outcome = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-09T10:00:00Z",
      transport: healthyTransport(),
    });

    expect(outcome.code).toBe(EXIT_USAGE);
    const text = outcome.lines.join("\n");
    expect(text).toContain(`${ws.runId} delivered no story, so there is nothing to open a PR from`);
    expect(text).toContain("0 of 1 stories delivered, S1 blocked (");
    expect(text).toContain("first blocked: S1 — ");
  }, 180_000);

  test("--dry-run is refused in exactly the same words", async () => {
    const ws = workspace(GOLDEN_REFUSED);
    await build(ws);
    readyToShip(ws);

    const wet = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-09T10:00:00Z",
      transport: healthyTransport(),
    });
    const dry = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-09T10:00:00Z",
      transport: healthyTransport(), dryRun: true,
    });

    expect(dry.code).toBe(wet.code);
    expect(dry.lines).toEqual(wet.lines);
  }, 180_000);

  // The guard half. It passed before this change, so it proves nothing about the
  // fix — it proves the fix did not take the ordinary path with it.
  test("a run with a delivered story still ships (guard)", async () => {
    const ws = workspace(GOLDEN_STORY);
    await build(ws);
    readyToShip(ws);

    expect(readFileSync(join(ws.runDir, "03-plan", "stories", "S1.md"), "utf8")).toContain("status: done");
    const outcome = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-09T10:00:00Z",
      transport: healthyTransport(), dryRun: true,
    });

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).not.toContain("delivered no story");
  }, 180_000);

  test("the PR body header states the outcome", async () => {
    const ws = workspace(GOLDEN_STORY);
    await build(ws);
    readyToShip(ws);

    let body = "";
    const outcome = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-09T10:00:00Z",
      transport: {
        async run(cmd, args) {
          const at = args.indexOf("--body-file");
          if (at !== -1) {
            const path = args[at + 1] ?? "";
            if (existsSync(path)) body = readFileSync(path, "utf8");
          }
          return healthyTransport().run(cmd, args, ws.root);
        },
      },
    });

    expect(outcome.code).toBe(EXIT_OK);
    expect(body).toContain("**Outcome:** delivered: 1 of 1 stories");
  }, 180_000);
});

// --- (d) the two absences, named ----------------------------------------------

describe("an outcome nobody can derive is named, never invented (#210)", () => {
  test("a run.yml written before the field reads `not recorded`", () => {
    expect(describeRunOutcome(undefined)).toBe(OUTCOME_NOT_RECORDED);
    expect(OUTCOME_NOT_RECORDED).toContain("not recorded");
    expect(outcomeLine(undefined).kind).toBe("not-recorded");
  });

  test("a run with no Build phase reads `n/a`, with the reason in it", () => {
    const ws = workspace(GOLDEN_STORY);
    const run = RunStore.open(ws.runDir).run;
    const docsScope: RunFile = { ...run, phases: run.phases.filter((phase) => phase.id !== "04-build") };

    const outcome = deriveRunOutcome(docsScope, ws.runDir);

    expect(outcome.kind).toBe("n/a");
    expect(outcome.why).toContain("no Build phase");
    // Never a confident zero about a plan that never existed (§7).
    expect(outcome.stories_total).toBeUndefined();
    expect(describeRunOutcome(outcome)).toStartWith("n/a — ");
  });

  test("a Build phase with no plan on disk reads `n/a` too", () => {
    const ws = workspace(GOLDEN_STORY);
    const run = RunStore.open(ws.runDir).run;
    const empty = join(ws.root, "no-plan-here");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "keep"), "", "utf8");

    const outcome = deriveRunOutcome(run, empty);

    expect(outcome.kind).toBe("n/a");
    expect(outcome.why).toContain("no plan on disk");
  });
});
