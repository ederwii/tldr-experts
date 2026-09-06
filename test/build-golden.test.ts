/**
 * The Build executor's golden guard (wave 2, step 0b).
 *
 * Not a property test. This one compares BYTES — the SPAWNED developer prompt,
 * the SPAWNED reviewer prompt, the `--prepare` bundle's own `prompt.md`, the
 * ordered event stream with its payload keys AND values, `run.yml`'s task rows
 * and the exit codes — against files committed under `test/fixtures/build/golden/`.
 * It exists because wave 2 moves ~2,000 lines out of one 4,351-line file and
 * claims that changed nothing; this is what makes the claim checkable rather
 * than argued.
 *
 * THREE scenarios, none of which can stand in for another (measured at e48f4a0):
 * `--prepare` spawns nothing and `--commit` spawns only the reviewer, so the
 * developer's own prompt bytes exist only on the headless path; the headless
 * path writes no bundle, so `prepare()`/`commit()` and the unmetered host turn
 * exist only in-session; and both of those are all-green, so a second review
 * round and a developer that never ran exist only in `GOLDEN_ROUNDS`. What is
 * normalised, and why each byte is genuinely nondeterministic, is in
 * `fixtures/build/golden.ts`'s header.
 *
 * **If this test goes red during a move step, the step is wrong. Revert it. Do
 * not regenerate the golden.**
 *
 * ## The regenerator
 *
 * `TLDRX_GOLDEN_UPDATE=1 bun test test/build-golden.test.ts` rewrites every file
 * under `golden/` from this run. It is here rather than in a throwaway script so
 * that the thing that writes the golden is the same code that reads it — a
 * separate generator can drift from the assertion, and a drifted generator is a
 * guard that agrees with itself.
 *
 * A regeneration run FAILS, deliberately, after writing. An exported environment
 * variable must never be able to produce a passing suite: `TLDRX_GOLDEN_UPDATE=1`
 * left in a shell would otherwise turn this guard green forever while comparing
 * nothing at all.
 *
 * It is ONLY ever legitimate for a deliberate behaviour change that is being
 * reviewed on its own terms, with the golden diff in the pull request as part of
 * the evidence. **Inside a refactor wave it is never the answer: a golden byte
 * change means the move was wrong, and the fix is to revert the move.**
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  makeBuildWorkspace, type BuildWorkspace, type BuildWorkspaceOptions,
} from "./fixtures/build/workspace.ts";
import {
  captureHeadlessBuild, captureInSessionBuild, captureRoundsBuild, GOLDEN_ROUNDS, GOLDEN_STORY,
  HEADLESS_GOLDEN, INSESSION_GOLDEN, readGolden, ROUNDS_GOLDEN, writeGolden,
} from "./fixtures/build/golden.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns real processes — git, the fake `claude`, `npm run test`. Process
// cost is a property of the machine, so bun's fixed 5000 ms default measures the box.
setDefaultTimeout(spawnTestTimeout());

const UPDATING = process.env.TLDRX_GOLDEN_UPDATE === "1";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = [
  "FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_PROMPT_DIR",
  "FAKE_BUILD_VERDICTS", "FAKE_BUILD_FAIL",
] as const;

let open: BuildWorkspace[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_KEYS) delete process.env[key];
  for (const ws of open) ws.dispose();
  open = [];
});

/**
 * A workspace whose fake `claude` is the only one on PATH, plus the directory it
 * writes every prompt it was handed into. `makeBuildWorkspace` gives each
 * invocation its own `mkdtemp` root and `dispose()` takes it back, which is this
 * fixture's spelling of the private-temp-dir rule (#95/#97) and what the three
 * sibling `makeBuildWorkspace` files do.
 */
function workspace(plan: BuildWorkspaceOptions): { ws: BuildWorkspace; promptDir: string } {
  const ws = makeBuildWorkspace(plan);
  open.push(ws);
  process.env.PATH = ws.binDir;
  process.env.FAKE_BUILD_STATE = ws.statePath;
  process.env.FAKE_BUILD_COST = "0.10";
  const promptDir = join(ws.root, "prompts");
  mkdirSync(promptDir, { recursive: true });
  process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
  // Not normalised, and asserted so it stays that way: `createRun` derives the
  // run id from the fixture's pinned `now`, so it is the same on every machine.
  // The day that stops being true, this line goes red instead of the golden
  // quietly becoming unstable.
  expect(ws.runId).toBe("260829-build");
  return { ws, promptDir };
}

/**
 * Compare EVERY captured artifact against its committed file, then assert once.
 *
 * The first version asserted inside the loop, and `expect().toBe()` throws — so
 * the first mismatch aborted the rest and four of the ten artifacts had never
 * been shown capable of failing at all. That is a guard reporting on itself:
 * whichever artifact happens to be compared first is the only one whose teeth
 * anyone has seen. Mismatches are collected with the first differing line and
 * asserted together, so one run names every artifact that moved.
 */
function agrees(
  captured: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>>,
): void {
  const mismatches: string[] = [];
  for (const [field, name] of Object.entries(files)) {
    const got = captured[field];
    // Never `?? ""`: a field name that stopped matching would then compare an
    // empty string against a golden and read as a behaviour change, which is the
    // one thing this file must not say by accident.
    if (got === undefined) throw new Error(`the capture has no artifact named \`${field}\` (for ${name})`);
    if (UPDATING) {
      writeGolden(name, got);
      continue;
    }
    const want = readGolden(name);
    if (got !== want) mismatches.push(`${name} — ${firstDifference(got, want)}`);
  }
  // A regeneration run must never be a PASSING run: an exported environment
  // variable would otherwise turn the whole suite green while proving nothing.
  if (UPDATING) {
    throw new Error(
      "golden regenerated — re-run without TLDRX_GOLDEN_UPDATE to compare",
    );
  }
  expect(mismatches, "every artifact is byte-identical to its committed golden").toEqual([]);
}

/** Where two artifacts first part company, as `line N: want … / got …`. */
function firstDifference(got: string, want: string): string {
  if (want === "") return "no golden on disk (nothing has been committed for it)";
  const gotLines = got.split("\n");
  const wantLines = want.split("\n");
  const upto = Math.max(gotLines.length, wantLines.length);
  for (let i = 0; i < upto; i++) {
    const g = gotLines[i];
    const w = wantLines[i];
    if (g === w) continue;
    return `line ${String(i + 1)}: want ${show(w)} / got ${show(g)}`;
  }
  return "identical line by line but not byte for byte (a trailing-newline change)";
}

function show(line: string | undefined): string {
  if (line === undefined) return "<no such line>";
  return JSON.stringify(line.length > 120 ? `${line.slice(0, 120)}…` : line);
}

describe("the Build executor's observable output is byte-frozen", () => {
  test("headless: both spawned prompts, the events, the run.yml rows and the exit code", async () => {
    const { ws, promptDir } = workspace(GOLDEN_STORY);

    const got = await captureHeadlessBuild(ws, promptDir);

    // The premise of the artifact above it: a headless build spawns BOTH
    // sub-agents, so both prompts are real spawned bytes and not a bundle.
    expect(readdirSync(promptDir).sort()).toEqual(["developer-S1-1.md", "reviewer-S1-1.md"]);
    agrees(got, HEADLESS_GOLDEN);
  }, 120_000);

  test("in-session: the --prepare bundle, the spawned reviewer, the events, the rows and both exit codes", async () => {
    const { ws, promptDir } = workspace(GOLDEN_STORY);

    const got = await captureInSessionBuild(ws, promptDir);

    // Why this cycle cannot supply the developer prompt, asserted rather than
    // asserted-in-a-comment: `--prepare` spawns nothing and `--commit` spawns
    // only the reviewer, so no `developer-*.md` is ever written here.
    expect(readdirSync(promptDir).sort()).toEqual(["reviewer-S1-1.md"]);
    agrees(got, INSESSION_GOLDEN);
  }, 120_000);

  /**
   * The unhappy paths, because the all-green capture above pins neither.
   *
   * Tasks 4 and 5 cut apart the worktree/branch-claim and review-round clusters,
   * and every path they move was mapped onto an existing pin EXCEPT
   * `blockedByFailedDeveloper`. This is that path, beside the second review
   * round that `ReviewCounters` exists to bound: S1 is sent back once and then
   * approved, S2's developer dies having written nothing.
   */
  test("rounds: a second review round for S1, a failed developer for S2", async () => {
    const { ws, promptDir } = workspace(GOLDEN_ROUNDS);

    const got = await captureRoundsBuild(ws, promptDir);

    // The premise: five spawned turns, and NO second developer for S2 — a
    // developer that never ran does not consume the attempt it was given.
    expect(readdirSync(promptDir).sort()).toEqual([
      "developer-S1-1.md", "developer-S1-2.md", "developer-S2-1.md",
      "reviewer-S1-1.md", "reviewer-S1-2.md",
    ]);
    agrees(got, ROUNDS_GOLDEN);
  }, 180_000);
});
