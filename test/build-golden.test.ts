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
 * Two cycles, because neither can stand in for the other (measured at e48f4a0):
 * `--prepare` spawns nothing and `--commit` spawns only the reviewer, so the
 * developer's own prompt bytes exist only on the headless path; and the headless
 * path writes no bundle, so `prepare()`/`commit()` and the unmetered host turn
 * exist only on the in-session path. What is normalised, and why each byte is
 * genuinely nondeterministic, is in `fixtures/build/golden.ts`'s header.
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
 * It is ONLY ever legitimate for a deliberate behaviour change that is being
 * reviewed on its own terms, with the golden diff in the pull request as part of
 * the evidence. **Inside a refactor wave it is never the answer: a golden byte
 * change means the move was wrong, and the fix is to revert the move.**
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import {
  captureHeadlessBuild, captureInSessionBuild, GOLDEN_STORY, HEADLESS_GOLDEN, INSESSION_GOLDEN,
  readGolden, writeGolden,
} from "./fixtures/build/golden.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns real processes — git, the fake `claude`, `npm run test`. Process
// cost is a property of the machine, so bun's fixed 5000 ms default measures the box.
setDefaultTimeout(spawnTestTimeout());

const UPDATING = process.env.TLDRX_GOLDEN_UPDATE === "1";

const ORIGINAL_PATH = process.env.PATH ?? "";
const FAKE_KEYS = ["FAKE_BUILD_COST", "FAKE_BUILD_STATE", "FAKE_BUILD_PROMPT_DIR"] as const;

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
function workspace(): { ws: BuildWorkspace; promptDir: string } {
  const ws = makeBuildWorkspace(GOLDEN_STORY);
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
 * Compare every captured artifact against its committed file — or, under
 * `TLDRX_GOLDEN_UPDATE=1`, write it first and then compare (so a regeneration
 * run is green by construction and proves nothing, which is what it is for).
 */
function agrees(
  captured: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>>,
): void {
  for (const [field, name] of Object.entries(files)) {
    const got = captured[field];
    // Never `?? ""`: a field name that stopped matching would then compare an
    // empty string against a golden and read as a behaviour change, which is the
    // one thing this file must not say by accident.
    if (got === undefined) throw new Error(`the capture has no artifact named \`${field}\` (for ${name})`);
    if (UPDATING) writeGolden(name, got);
    expect(got, `${name} is byte-identical to the committed golden`).toBe(readGolden(name));
  }
}

describe("the Build executor's observable output is byte-frozen", () => {
  test("headless: both spawned prompts, the events, the run.yml rows and the exit code", async () => {
    const { ws, promptDir } = workspace();

    const got = await captureHeadlessBuild(ws, promptDir);

    // The premise of the artifact above it: a headless build spawns BOTH
    // sub-agents, so both prompts are real spawned bytes and not a bundle.
    expect(readdirSync(promptDir).sort()).toEqual(["developer-S1-1.md", "reviewer-S1-1.md"]);
    agrees(got, HEADLESS_GOLDEN);
  }, 120_000);

  test("in-session: the --prepare bundle, the spawned reviewer, the events, the rows and both exit codes", async () => {
    const { ws, promptDir } = workspace();

    const got = await captureInSessionBuild(ws, promptDir);

    // Why this cycle cannot supply the developer prompt, asserted rather than
    // asserted-in-a-comment: `--prepare` spawns nothing and `--commit` spawns
    // only the reviewer, so no `developer-*.md` is ever written here.
    expect(readdirSync(promptDir).sort()).toEqual(["reviewer-S1-1.md"]);
    agrees(got, INSESSION_GOLDEN);
  }, 120_000);
});
