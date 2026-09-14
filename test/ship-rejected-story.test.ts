/**
 * `tldrx ship` may not open a PR over an epic carrying a story the reviewer
 * REJECTED (gh #282).
 *
 * ## What was measured
 *
 * tldrx 0.18.2, a live unattended 8-story run, story S5: the DoD went green, the
 * story merged into the epic (`48f8bdd merge(S5)`), THEN the reviewer said
 * `changes`; the requeue merged again (`7fd2468 merge(S5)`), the reviewer said
 * `changes` again, and the story settled `blocked`. The epic branch carried,
 * twice, code the reviewer rejected twice — and `ship`'s only story refusal was
 * "zero stories done" (#210). With one story `done` beside it, `ship` pushed the
 * epic and opened the PR with the rejected code in the diff, while the body's
 * `## What shipped` listed only the done story and `## Not done` said S5 was
 * blocked without one word that its diff was there.
 *
 * ## What is design and what is the defect
 *
 * Merging BEFORE the review is deliberate (#166: the reviewer reads
 * `git diff <epic-base>...<story>` over the merged tree), and every reviewer
 * outcome — `changes` included — settles with `merged: true`. That is not what
 * these tests change. The defect is downstream, in `ship`: the ledger already
 * records, per story, the LAST merge into the epic and the verdict it settled
 * under (`reviewLedger.ts` `lastMerge`, #295), so "a rejected diff is on the
 * branch you are about to ship" is a question the run can answer from disk, and
 * `ship` never asked it.
 *
 * The premise is real, not stubbed: the fake reviewer is scripted `changes`
 * twice for S2, the fake developer writes code, and the assertions below read
 * the epic branch and `events.jsonl` that produced.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
  "FAKE_BUILD_FIXLIST",
] as const;

/** One `fix-now` finding, in the envelope shape `fixlist.ts` parses — a signature with work still owed. */
const FIX_NOW_FINDING: readonly Record<string, unknown>[] = [
  {
    n: 1,
    severity: "high",
    finding: "the new branch is not covered by a test",
    where: "src/app.ts:1",
    kind: "correctness",
    disposition: "fix-now",
    detail: "add the case to the suite before this merges",
  },
];

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

/** Every `task.done` for `id` that carried both `commit` and `epic_base`, in order — the merges the ledger saw. */
function taskDoneMerges(ws: BuildWorkspace, id: string): readonly { commit: string; epicBase: string }[] {
  return readFileSync(join(ws.runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
    .filter((event) => event.type === "task.done" && event.payload?.story === id)
    .flatMap((event) => {
      const commit = event.payload?.commit;
      const epicBase = event.payload?.epic_base;
      return typeof commit === "string" && commit !== "" && typeof epicBase === "string" && epicBase !== ""
        ? [{ commit, epicBase }]
        : [];
    });
}

function storyStatus(ws: BuildWorkspace, id: string): string {
  const text = readFileSync(join(ws.runDir, "03-plan", "stories", `${id}.md`), "utf8");
  return /^status: (\S+)$/m.exec(text)?.[1] ?? "(no status line)";
}

async function ship(ws: BuildWorkspace, dryRun: boolean) {
  return await shipRun({
    root: ws.root, runId: ws.runId, actor: "alan", at: "2026-09-14T10:00:00Z",
    transport: healthyTransport(), dryRun,
  });
}

describe("tldrx ship refuses an epic carrying a story the reviewer rejected (#282)", () => {
  test("S1 done, S2 rejected twice and merged twice: exit family 2, naming S2, the verdict and the merge", async () => {
    const ws = workspace(GOLDEN_ROUNDS);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S2: ["changes", "changes"] });
    await build(ws);
    readyToShip(ws);

    // The premise, read off what the build produced — the shape #282 measured.
    // One story delivered, so #210's refusal does not fire and the PR would open.
    expect(storyStatus(ws, "S1")).toBe("done");
    expect(storyStatus(ws, "S2")).toBe("blocked");
    const ledger = readReviewLedger(ws.runDir, "S2");
    expect(ledger.lastMerge?.verdict).toBe("changes");
    // And the rejected diff IS on the epic branch: every commit a `task.done`
    // for S2 recorded beside an `epic_base` — the settles that watched a merge
    // happen — is an ancestor of `epic/e1`'s tip, and at least one of them moved
    // real code (its commit is not its base: the fake developer's second attempt
    // lands nothing new, so that one reads as a no-op merge over the first).
    // This is the fact the PR would carry and the body would not mention.
    const merges = taskDoneMerges(ws, "S2");
    expect(merges.length).toBeGreaterThanOrEqual(2);
    for (const merge of merges) {
      expect(git(ws, ["merge-base", "--is-ancestor", merge.commit, "epic/e1"]).code, merge.commit).toBe(0);
    }
    expect(merges.some((merge) => merge.commit !== merge.epicBase)).toBe(true);
    const merged = ledger.lastMerge?.commit ?? "";
    expect(merged).toBe(merges.at(-1)?.commit ?? "(none)");

    const outcome = await ship(ws, true);

    // A gate said no — the reviewer is a check (`check.failed check:review`) and
    // its verdict is what blocks the story — so this is family 2, not #210's 1.
    expect(outcome.code).toBe(EXIT_GATE_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toContain(`${ws.runId} carries a story the reviewer rejected, and its diff is on \`epic/e1\``);
    expect(text).toContain(`S2 — its last merge into the epic (commit ${merged.slice(0, 7)} over epic base `);
    expect(text).toContain("was judged `changes`");
    // The handoff's own reason travels, never a paraphrase.
    expect(text).toContain("the reviewer asked for changes twice");
    // The remedy is the one #210 already names, plus the hand-PR escape.
    expect(text).toContain("tldrx story reopen S2 --note");
    expect(text).not.toContain("gh pr create");
  }, 240_000);

  test("the real ship is refused in exactly the words --dry-run is, and nothing is created", async () => {
    const ws = workspace(GOLDEN_ROUNDS);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S2: ["changes", "changes"] });
    await build(ws);
    readyToShip(ws);

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

  // Guards: both passed before the fix, so they prove only that the ordinary
  // paths did not go with it.
  test("GUARD: a `changes` that was requeued and then approved is not a rejection — the story ships", async () => {
    const ws = workspace(GOLDEN_ROUNDS);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S2: ["changes", "approve"] });
    await build(ws);
    readyToShip(ws);

    expect(storyStatus(ws, "S2")).toBe("done");
    expect(readReviewLedger(ws.runDir, "S2").lastMerge?.verdict).toBe("approve");

    const outcome = await ship(ws, true);

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).not.toContain("the reviewer rejected");
  }, 240_000);

  test("GUARD: a story parked at `review` under a SIGNED fix list is not a rejection — it ships, findings listed", async () => {
    const ws = workspace(GOLDEN_ROUNDS);
    process.env.FAKE_BUILD_VERDICTS = JSON.stringify({ S2: ["fixlist"] });
    process.env.FAKE_BUILD_FIXLIST = JSON.stringify({ S2: FIX_NOW_FINDING });
    await build(ws);
    readyToShip(ws);

    // The premise: S2's diff is merged and the reviewer SIGNED it with a finding
    // still to fix — parked, not rejected. `fixlist` is the one verdict that
    // spends no attempt (design §B.4), and #167's body lists what it left open.
    expect(storyStatus(ws, "S2")).toBe("review");
    expect(readReviewLedger(ws.runDir, "S2").lastMerge?.verdict).toBe("fixlist");

    const outcome = await ship(ws, true);

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).not.toContain("the reviewer rejected");
  }, 240_000);

  test("GUARD: a story that never merged — its developer died — is not a rejected diff; the done story ships", async () => {
    const ws = workspace(GOLDEN_ROUNDS);
    process.env.FAKE_BUILD_FAIL = "developer:S2";
    await build(ws);
    readyToShip(ws);

    expect(storyStatus(ws, "S1")).toBe("done");
    expect(storyStatus(ws, "S2")).not.toBe("done");
    expect(readReviewLedger(ws.runDir, "S2").lastMerge).toBeNull();

    const outcome = await ship(ws, true);

    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.lines.join("\n")).not.toContain("the reviewer rejected");
  }, 240_000);
});
