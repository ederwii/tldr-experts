/**
 * `tldrx ship` may not open a PR over an epic carrying a merged diff NOBODY
 * judged (gh #311) — #282's sibling.
 *
 * ## The gap #282 left
 *
 * #282 closed the case where a reviewer READ the diff and said `changes`: a
 * rejection that stands, with the rejected code on the epic branch. Three settle
 * paths park a story at `review` with `merged: true` and a verdict that is not a
 * verdict at all:
 *
 * - the reviewer was refused for want of money and never spawned (#289,
 *   `build.ts` `reviewerUnderfunded`) → `verdict: "n-a"`;
 * - the run was cancelled before the review (#305, `build.ts` `cancelledUnder`)
 *   → `verdict: "n-a"`, its reason saying in words "the diff is merged on the
 *   epic branch and nobody has judged it";
 * - the reviewer FAILED mid-read → `verdict: "error"`.
 *
 * `reviewLedger.ts` already names the class — "`n-a` and `error` mean nothing
 * did [judge it]" — and `outcome.ts` `reviewNeverCompleted` is the one predicate
 * for it, which the as-is path reads to re-run the REVIEW instead of a
 * developer. `ship` had no condition on any of it: with one story `done` beside
 * the parked one, #210 does not fire, #282's predicate (`changes`) does not
 * match, and the PR opens with an unjudged diff in it while the body lists the
 * story under `## Not done` without one word that its code is in the diff.
 *
 * ## What is real here and what is not
 *
 * The premise of the first three tests is produced, not stubbed: the fake
 * reviewer is made to FAIL for S2, so S2's diff really is merged onto `epic/e1`
 * and the ledger really records `error` over it. The `n-a` half is the same real
 * run with the recorded verdict rewritten in `events.jsonl` — the two paths that
 * write `n-a` are pinned where they happen (#289 in `build-executor.test.ts`,
 * #305 in `run-cancel-under-build.test.ts`), and neither can be made to coincide
 * with a `done` sibling in this fixture's single wave without a scaffold that
 * would prove less than the rewrite does: what is under test HERE is that
 * `ship`'s condition reads the whole class and not only `error`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNext } from "../src/core/facilitator/runNext.ts";
import { RunStore } from "../src/core/run/RunStore.ts";
import { shipRun, type ShipTransport } from "../src/core/run/ship.ts";
import { readReviewLedger } from "../src/core/build/reviewLedger.ts";
import { EXIT_GATE_REFUSED, EXIT_OK } from "../src/cli/exitCodes.ts";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import { GOLDEN_ROUNDS } from "./fixtures/build/golden.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns real processes — git, the fake `claude`, `npm run test`.
setDefaultTimeout(spawnTestTimeout());

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_PROMPT_DIR", "FAKE_BUILD_VERDICTS", "FAKE_BUILD_FAIL",
] as const;

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

/** A transport that answers every probe healthily, so only a story refusal can stop `ship`. */
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

/** Give the run the branch `ship` needs — the one the Build stage really cut in the fixture repo. */
function readyToShip(ws: BuildWorkspace): void {
  const store = RunStore.open(ws.runDir);
  store.mutate((run) => ({ ...run, build: { epic_branch: ["epic/e1"] } }));
  store.save();
}

function git(ws: BuildWorkspace, args: readonly string[]): { code: number; out: string } {
  try {
    const out = execFileSync("git", [...args], {
      cwd: join(ws.root, "app"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: out.trim() };
  } catch (error) {
    return { code: (error as { status?: number }).status ?? 1, out: "" };
  }
}

function storyStatus(ws: BuildWorkspace, id: string): string {
  const text = readFileSync(join(ws.runDir, "03-plan", "stories", `${id}.md`), "utf8");
  return /^status: (\S+)$/m.exec(text)?.[1] ?? "(no status line)";
}

/**
 * Rewrite the verdict every `task.done` for `id` recorded, in place.
 *
 * The events are the ledger's only source (`reviewLedger.ts` reads the log), so
 * this is how the SAME merged premise is re-read under the other verdict of the
 * class — see the header for why the `n-a` producers are pinned elsewhere.
 */
function rewriteSettledVerdict(ws: BuildWorkspace, id: string, verdict: string): void {
  const path = join(ws.runDir, "events.jsonl");
  const lines = readFileSync(path, "utf8").split("\n").map((line) => {
    if (line.trim() === "") return line;
    const event = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
    if (event.type !== "task.done" || event.payload?.story !== id) return line;
    return JSON.stringify({ ...event, payload: { ...event.payload, verdict } });
  });
  writeFileSync(path, lines.join("\n"));
}

async function ship(ws: BuildWorkspace, dryRun: boolean) {
  return await shipRun({
    root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-14T10:00:00Z",
    transport: healthyTransport(), dryRun,
  });
}

/** S1 delivered, S2's reviewer died: S2's diff is on the epic and `error` is what judged it. */
async function reviewerFailed(): Promise<BuildWorkspace> {
  const ws = workspace(GOLDEN_ROUNDS);
  process.env.FAKE_BUILD_FAIL = "reviewer:S2";
  await build(ws);
  readyToShip(ws);
  return ws;
}

describe("tldrx ship refuses an epic carrying a merged diff nobody judged (#311)", () => {
  test("S1 done, S2 merged with a FAILED reviewer: exit family 2, naming S2, the merge and the non-verdict", async () => {
    const ws = await reviewerFailed();

    // The premise, read off what the build produced. One story delivered, so
    // #210's refusal does not fire and the PR would open.
    expect(storyStatus(ws, "S1")).toBe("done");
    expect(storyStatus(ws, "S2")).toBe("review");
    const ledger = readReviewLedger(ws.runDir, "S2");
    expect(ledger.lastMerge?.verdict).toBe("error");
    // And the unjudged diff IS on the epic branch: the merge the ledger names is
    // an ancestor of `epic/e1`'s tip, and it moved code (its commit is not its
    // base). This is the fact the PR would carry and the body would not mention.
    const merged = ledger.lastMerge?.commit ?? "(none)";
    expect(git(ws, ["merge-base", "--is-ancestor", merged, "epic/e1"]).code).toBe(0);
    expect(merged).not.toBe(ledger.lastMerge?.epicBase);

    const outcome = await ship(ws, true);

    // Family 2, like #282's sibling refusal: what is missing is a GATE — the
    // review is a check, and no check ever ran over this diff.
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toContain(`${ws.runId} carries a story whose merged diff nobody judged, and it is on \`epic/e1\``);
    expect(text).toContain(`S2 — its last merge into the epic (commit ${merged.slice(0, 7)} over epic base `);
    expect(text).toContain("settled under `error`");
    // The handoff's own reason travels, never a paraphrase.
    expect(text).toContain("the reviewer FAILED");
    // The remedy is the review, not a reopen: `tldrx next` settles a story parked
    // at `review` by re-running the REVIEW, with no developer spawned.
    expect(text).toContain("tldrx next");
    expect(text).not.toContain("gh pr create");
  }, 240_000);

  test("an `n-a` merge — no reviewer ever spawned — is refused in the same words", async () => {
    const ws = await reviewerFailed();
    rewriteSettledVerdict(ws, "S2", "n-a");

    expect(readReviewLedger(ws.runDir, "S2").lastMerge?.verdict).toBe("n-a");

    const outcome = await ship(ws, true);

    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toContain("carries a story whose merged diff nobody judged");
    expect(text).toContain("settled under `n-a`");
  }, 240_000);

  test("the real ship is refused in exactly the words --dry-run is, and nothing is created", async () => {
    const ws = await reviewerFailed();

    const calls: string[] = [];
    const recording: ShipTransport = {
      async run(cmd, args, cwd) {
        calls.push(`${cmd} ${args.join(" ")}`);
        return await healthyTransport().run(cmd, args, cwd);
      },
    };
    const wet = await shipRun({
      root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-14T10:00:00Z", transport: recording,
    });
    const dry = await ship(ws, true);

    expect(wet.code).toBe(EXIT_GATE_REFUSED);
    expect(dry.lines).toEqual(wet.lines);
    // Refused before the outside world is touched: no `gh`, no `git push`, no PR.
    expect(calls).toEqual([]);
  }, 240_000);

  // Guards: both pass before the fix too, so they prove only that the ordinary
  // paths did not go with it.
  test("GUARD: a story judged `approve` is not unjudged — it ships", async () => {
    const ws = workspace(GOLDEN_ROUNDS);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S2: ["changes", "approve"] });
    await build(ws);
    readyToShip(ws);

    expect(storyStatus(ws, "S2")).toBe("done");
    expect(readReviewLedger(ws.runDir, "S2").lastMerge?.verdict).toBe("approve");

    const outcome = await ship(ws, true);

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).not.toContain("nobody judged");
  }, 240_000);

  test("GUARD: a story that never merged — its developer died — carries no unjudged diff", async () => {
    const ws = workspace(GOLDEN_ROUNDS);
    process.env.FAKE_BUILD_FAIL = "developer:S2";
    await build(ws);
    readyToShip(ws);

    expect(storyStatus(ws, "S1")).toBe("done");
    expect(storyStatus(ws, "S2")).not.toBe("done");
    expect(readReviewLedger(ws.runDir, "S2").lastMerge).toBeNull();

    const outcome = await ship(ws, true);

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).not.toContain("nobody judged");
  }, 240_000);
});
