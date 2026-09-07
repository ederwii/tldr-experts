/**
 * The Build executor's GOLDEN GUARD (wave 2, step 0b).
 *
 * Wave 2 cuts a 4,351-line file into modules and claims it changed nothing. That
 * claim is only worth what proves it, and the existing suite proves PROPERTIES —
 * this proves BYTES. FOUR fake-agent builds produce twenty-two artifacts that are
 * compared, byte for byte, against files committed under `golden/`:
 *
 *   HEADLESS (`tldrx next`) — the path that spawns both sub-agents:
 *     1. the developer prompt the SPAWNED developer was handed
 *     2. the reviewer prompt the SPAWNED reviewer was handed
 *     3. the ordered event stream — index, type, actor, cost, sorted payload keys
 *        AND payload values
 *     4. `run.yml`'s task rows — the money ledger `validateRunFile` polices
 *     5. the exit code
 *
 *   IN-SESSION (`--prepare` then `--commit`) — the path that spawns no developer:
 *     6. the `--prepare` bundle's own `prompt.md`
 *     7. the reviewer prompt the SPAWNED reviewer was handed
 *     8. the ordered event stream
 *     9. `run.yml`'s task rows (the HOST-declared developer turn, `session_id: null`)
 *    10. the two exit codes
 *
 *   ROUNDS (`GOLDEN_ROUNDS`, headless) — the two UNHAPPY paths, which the
 *   all-green captures above pin nothing about:
 *    11-15. five spawned prompts — S1's two developer turns (the second carrying
 *           `## Previous attempt`), S1's two reviewer turns, and S2's one
 *    16. the ordered event stream: a `changes` verdict, a `story.base_fastforwarded`,
 *        a second `task.started` at `attempt: 2`, and a developer that errored
 *    17. five task rows, one of them `status: "failed"` with the error verbatim
 *    18. the exit code
 *
 *   REFUSED (`GOLDEN_REFUSED`, headless) — a DoD command the gate DECLINES to
 *   run, which the three above pin nothing about because all three run theirs:
 *    19. the developer prompt (the only spawned turn — a red DoD blocks the story
 *        before a reviewer is asked for, so there is no reviewer prompt here)
 *    20. the ordered event stream: a `check.failed` whose `keys=[…]` carries
 *        `refused` and does NOT carry `exit_code`, and a `task.done` at
 *        `status: "blocked"` with `commit: null`
 *    21. one task row — the developer's; there is no reviewer row to have
 *    22. the exit code (`4`, `EXIT_AWAITING_HUMAN`: the stage still reached its
 *        human gate, exactly as the two green headless scenarios do — a blocked
 *        story is not a usage error and not a gate refusal)
 *
 * Why a third scenario: every path tasks 4 and 5 move was covered by an existing
 * pin EXCEPT `blockedByFailedDeveloper`. `GOLDEN_ROUNDS` is that path, beside the
 * second review round that `ReviewCounters` exists to bound.
 *
 * Why a fourth: the other three all record a command that RAN, so none of them
 * can show what an ABSENCE looks like on the wire. `GOLDEN_REFUSED` freezes the
 * one record #165 was about — a check with no exit code in it at all.
 *
 * Both cycles are needed and neither is redundant. Measured at e48f4a0: a
 * `--prepare` spawns NOTHING and a `--commit` spawns only the reviewer, so the
 * in-session cycle can never show what bytes a developer sub-agent actually
 * receives — only the headless cycle can. And the headless cycle never writes a
 * bundle, so only the in-session cycle covers `prepare()`/`commit()`, the bundle
 * on disk, and an unmetered host turn's row.
 *
 * Measured at e48f4a0, artifacts 1 and 6 came out byte-identical and 2 and 7
 * differed by one line (`status: todo` vs `status: in_progress`). They are still
 * pinned separately rather than collapsed into one file plus an equality
 * assertion: they are assembled on two different code paths, and freezing each
 * path's own bytes is what a refactor guard is for. That they agree today is a
 * measurement, not an invariant this file invents.
 *
 * **A golden byte change is a BEHAVIOUR change. Revert the step; do not update
 * the golden.**
 *
 * ## What is normalised, and why each one is genuinely nondeterministic
 *
 * Measured at e48f4a0 by capturing two headless cycles back to back and diffing
 * them raw: the ONLY byte that moved in either prompt was the workspace root
 * path. No sha, timestamp or duration appeared in a prompt at all. Since #166 a
 * reviewer prompt DOES name a sha — the epic's, as it was immediately before the
 * story merged, because the branch name it used to carry produces an empty diff
 * once the story is an ancestor — so shas are scrubbed out of prompts too. So:
 *
 * | Artifact | Normalised | Why |
 * |---|---|---|
 * | prompts | the workspace root → `<ROOT>` (and its `realpath`, since macOS's `/var/folders` is a symlink to `/private/var/folders`), plus every commit sha → `<SHA>` (#166) | `mkdtempSync(join(tmpdir(), "tldrx-build-"))` (`workspace.ts:122`) — a fresh temp dir per invocation. Both are EXACT strings read from the machine, long and unique, so nothing incidental can match. The sha is the reviewer's diff base, which git derives from commit timestamps and so moves every run; it is replaced by the same VERIFIED rule the event normaliser uses (`scrubPrompt`). |
 * | events | the workspace root, plus every commit sha → `<SHA>` | Git shas move with commit timestamps every run. |
 * | task rows | the workspace root, every commit sha, plus `"ended_at": "<TS>"` | `ended_at` is the wall clock at the moment the row was written. `started_at` is NOT normalised — measured, it is `options.at` verbatim, so it is a real assertion. |
 *
 * The sha normaliser is narrow in the sense that matters — every replacement is
 * VERIFIED against the machine before it happens, never inferred from a pattern:
 *   - a payload value that is a WHOLE string of 7-40 hex characters AND is a
 *     prefix of a sha `git rev-list --all` reports in the fixture repo becomes
 *     `<SHA>`. A hex-looking value that is not a commit in that repo stays raw;
 *   - the full 40-char sha is replaced as a substring anywhere, because a
 *     40-char hex string cannot occur innocently.
 * Prose is untouchable by construction: the short rule only ever compares WHOLE
 * string values, so it cannot reach inside a sentence.
 *
 * It reads the whole commit list and not the branch tips because of a bug the
 * `GOLDEN_ROUNDS` capture found: attempt 1's `task.done.commit` is a commit the
 * story branch has already moved past by capture time, so a tips-only normaliser
 * wrote a RAW sha into the golden. See `machineOf`.
 *
 * NOT normalised, on purpose, each one a live assertion:
 *   - the run id. `createRun` derives it as `yymmdd(now)-slug` (`newRun.ts`) and
 *     the fixture pins `now: 2026-08-29T09:00:00Z`, slug `build`, so it is
 *     `260829-build` on every machine. The test asserts that explicitly, so the
 *     day it stops being true is a red test, not a golden that quietly went
 *     unstable.
 *   - the session ids. The fake emits `fake-developer-S1` / `fake-reviewer-S1`
 *     deterministically (`fakeClaude.ts:105`), and `null` for the host turn — it
 *     is a real assertion that the right role produced the row.
 *   - the per-agent ceilings, including the one inside the failed developer's
 *     error text (`Reached maximum budget ($1.60)`), which pins the cap
 *     arithmetic task 2 moves.
 *   - `started_at`, costs, token counts, `max_budget_usd`, verdicts, exit codes.
 *   - an event's `ts`, which is not rendered at all rather than blanked: it is
 *     the wall clock, and `validateEvent` already refuses an event without one.
 *
 * ## The residual
 *
 * Events are pinned as an ORDERED list with their values, so an adjacent swap is
 * caught unless the two events are identical in type, keys AND values. Measured
 * at e48f4a0: no two events in either capture are identical, so this capture has
 * no residual — but a future capture could, and that is the one reordering this
 * guard would not see.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMEWORK_ROOT } from "../../../src/core/paths.ts";
import { EventLog } from "../../../src/core/events/EventLog.ts";
import { RunStore } from "../../../src/core/run/RunStore.ts";
import { runNext, type NextOptions } from "../../../src/core/facilitator/runNext.ts";
import type { BuildWorkspace, BuildWorkspaceOptions } from "./workspace.ts";

export const GOLDEN_DIR = join(FRAMEWORK_ROOT, "test", "fixtures", "build", "golden");

/** One story, one epic, one wave — the smallest plan that exercises the whole pipeline. */
export const GOLDEN_STORY: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story" }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
};

/**
 * Two stories in ONE wave, and the two unhappy paths the wave's later steps move.
 *
 * `GOLDEN_STORY` is all-green, so on its own it pins nothing about a second
 * review round or a developer that never ran — and those are exactly the
 * clusters tasks 4 (`worktrees`/`branchClaims`) and 5 (`reviewBundle`/
 * `reviewRound`) cut apart. Driven with:
 *
 *   FAKE_BUILD_VERDICTS = {"S1": ["changes", "approve"]}   S1 is sent back once,
 *     then signed off — two developer turns, two reviewer turns, and the
 *     `## Previous attempt` block that `renderPreviousAttempt` builds.
 *   FAKE_BUILD_FAIL      = "developer:S2"                  S2's developer dies
 *     having written nothing, which is the `blockedByFailedDeveloper` /
 *     `parkDeveloperFailure` path: a TRANSPORT failure, not a story that could
 *     not be built, so the attempt is not consumed.
 */
export const GOLDEN_ROUNDS: BuildWorkspaceOptions = {
  stories: [
    { id: "S1", epic: "E1", title: "First story" },
    { id: "S2", epic: "E1", title: "Second story" },
  ],
  epics: [{ id: "E1", stories: ["S1", "S2"], branch: "epic/e1" }],
  waves: [["S1", "S2"]],
};

/** The fake-agent scripting `GOLDEN_ROUNDS` needs. Set by `captureRoundsBuild`. */
export const GOLDEN_ROUNDS_ENV: Readonly<Record<string, string>> = {
  FAKE_BUILD_VERDICTS: JSON.stringify({ S1: ["changes", "approve"] }),
  FAKE_BUILD_FAIL: "developer:S2",
};

/**
 * What one headless `tldrx next` over `GOLDEN_STORY` produced.
 *
 * A type alias and not an interface, on purpose: only an alias gets TypeScript's
 * implicit index signature, which is what lets the test walk it against the
 * file-name map below without a cast.
 */
export type CapturedHeadless = {
  /** The bytes the SPAWNED developer read on stdin. */
  readonly developerPrompt: string;
  /** The bytes the SPAWNED reviewer read on stdin. */
  readonly reviewerPrompt: string;
  readonly events: string;
  readonly runTasks: string;
  readonly exitCodes: string;
};

/** What one `--prepare` + `--commit` cycle over `GOLDEN_STORY` produced. */
export type CapturedInSession = {
  /** `<runDir>/.agent/build/S1/prompt.md` — what `--prepare` left for the host. */
  readonly bundlePrompt: string;
  /** The bytes the SPAWNED reviewer read on stdin; `--commit` still spawns one. */
  readonly reviewerPrompt: string;
  readonly events: string;
  readonly runTasks: string;
  readonly exitCodes: string;
};

/** Field → committed file name. The test iterates these, so nothing is compared by hand. */
export const HEADLESS_GOLDEN: Readonly<Record<keyof CapturedHeadless, string>> = {
  exitCodes: "headless-exit-codes.txt",
  developerPrompt: "headless-developer-prompt.md",
  reviewerPrompt: "headless-reviewer-prompt.md",
  events: "headless-events.txt",
  runTasks: "headless-run-tasks.txt",
};

export const INSESSION_GOLDEN: Readonly<Record<keyof CapturedInSession, string>> = {
  exitCodes: "insession-exit-codes.txt",
  bundlePrompt: "insession-bundle-prompt.md",
  reviewerPrompt: "insession-reviewer-prompt.md",
  events: "insession-events.txt",
  runTasks: "insession-run-tasks.txt",
};

/** The pipeline `GOLDEN_REFUSED` declares and the gate then declines to run. */
const REFUSED_COMMAND = "npm run test | tee lint.log";

/**
 * A story whose DoD command the gate will not run — the fourth scenario (#165).
 *
 * The command is DECLARED under the repo's `commands:` and still refused, and
 * that combination is the only one that reaches the DoD gate at all. Measured
 * 2026-09-06 with an UNDECLARED command (`npm run lint` against the default
 * fixture allowlist): `loadBuildPlan` calls `validatePlan(planDir, allowed)`
 * (`src/core/build/plan.ts:127`), which refuses the whole plan —
 * `04-build/build failed: 03-plan/ does not validate — stories/S1.md dod[0]:
 * \`npm run lint\` is not one of .tldrx/workspace.yml's commands`, exit 5 —
 * so nothing is dispatched and there is no refusal to capture. Plan validation
 * checks allowlist MEMBERSHIP only (`schemas/commandAllowlist.ts:69`, a
 * `Set.has`); `runDodCommand` is the one that also refuses a command it cannot
 * argv-split (`hooks/lib/story.ts:145`). A declared pipeline is exactly the gap
 * between the two.
 *
 * Nothing ran, so the capture is what an ABSENCE looks like end to end: a
 * `check.failed` with no `exit_code` and a `refused` sentence, a story blocked
 * with a reason that says REFUSED, and one developer task row. No reviewer is
 * spawned — a red DoD blocks the story before the review (build.ts:1069) — so
 * this scenario is exactly the one the other three cannot stand in for.
 *
 * What it does NOT freeze, said out loud because the header is this guard's own
 * account of itself: the BASE side. The scenario genuinely EXERCISES it — the
 * Build-entry pre-flight probes the same command and records it `unmeasured` in
 * `04-build/preflight.yml` — but that file is in none of the four artifacts, and
 * the base pre-flight deliberately emits no event (docs/spec.md §2.5), so
 * `refused-events.txt` cannot reach it either. The base side is pinned by
 * `test/dod-preflight.test.ts`'s `#165` describes instead.
 */
export const GOLDEN_REFUSED: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story", dod: [REFUSED_COMMAND] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
  commands: { build: null, test: "npm run test", lint: REFUSED_COMMAND, typecheck: null, run: null },
};

export type CapturedRefused = {
  readonly developerPrompt: string;
  readonly events: string;
  readonly runTasks: string;
  readonly exitCodes: string;
};

export const REFUSED_GOLDEN: Readonly<Record<keyof CapturedRefused, string>> = {
  exitCodes: "refused-exit-codes.txt",
  developerPrompt: "refused-developer-S1-1.md",
  events: "refused-events.txt",
  runTasks: "refused-run-tasks.txt",
};

/**
 * What one headless `tldrx next` over `GOLDEN_ROUNDS` produced. Five prompts:
 * both of S1's developer turns, both of its reviewer turns, and S2's one
 * developer turn — the one that died.
 */
export type CapturedRounds = {
  readonly developerS1Round1: string;
  readonly developerS1Round2: string;
  readonly reviewerS1Round1: string;
  readonly reviewerS1Round2: string;
  readonly developerS2: string;
  readonly events: string;
  readonly runTasks: string;
  readonly exitCodes: string;
};

export const ROUNDS_GOLDEN: Readonly<Record<keyof CapturedRounds, string>> = {
  exitCodes: "rounds-exit-codes.txt",
  developerS1Round1: "rounds-developer-S1-1.md",
  developerS1Round2: "rounds-developer-S1-2.md",
  reviewerS1Round1: "rounds-reviewer-S1-1.md",
  reviewerS1Round2: "rounds-reviewer-S1-2.md",
  developerS2: "rounds-developer-S2-1.md",
  events: "rounds-events.txt",
  runTasks: "rounds-run-tasks.txt",
};

/**
 * One headless `tldrx next`: worktree, spawned developer, DoD, commit, merge,
 * spawned reviewer, handoff, gate. The only cycle in which a developer prompt
 * exists to capture.
 */
export async function captureHeadlessBuild(
  ws: BuildWorkspace,
  promptDir: string,
): Promise<CapturedHeadless> {
  const headless = await next(ws, { mode: "headless" });
  const machine = machineOf(ws);
  return {
    developerPrompt: scrubPrompt(readFileSync(join(promptDir, "developer-S1-1.md"), "utf8"), machine),
    reviewerPrompt: scrubPrompt(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8"), machine),
    events: eventStream(ws, machine),
    runTasks: taskRows(ws, machine),
    exitCodes: `headless ${String(headless.code)}\n`,
  };
}

/**
 * One `--prepare` + `--commit` cycle. `--prepare` spawns NOTHING — that is the
 * contract this whole path exists to keep — so the host's half of the handshake
 * (a file in the worktree, a `result.json` beside the bundle) is written here.
 */
export async function captureInSessionBuild(
  ws: BuildWorkspace,
  promptDir: string,
): Promise<CapturedInSession> {
  const prepare = await next(ws, { mode: "prepare" });

  const worktree = join(ws.root, ".tldrx", "worktrees", ws.repoName, `${ws.runId}-S1`);
  writeFileSync(join(worktree, "s1.txt"), "S1 was here\n", "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", "S1", "result.json"),
    `${JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0.1 })}\n`,
    "utf8",
  );

  const commit = await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z", costUsd: 0.1 });
  const machine = machineOf(ws);
  return {
    bundlePrompt: scrubPrompt(
      readFileSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"), "utf8"),
      machine,
    ),
    reviewerPrompt: scrubPrompt(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8"), machine),
    events: eventStream(ws, machine),
    runTasks: taskRows(ws, machine),
    exitCodes: `prepare ${String(prepare.code)}\ncommit ${String(commit.code)}\n`,
  };
}

/**
 * One headless `tldrx next` over `GOLDEN_ROUNDS`: S1 sent back once and then
 * approved, S2's developer dying with nothing written.
 *
 * The fake-agent scripting is set here rather than in the test because it IS the
 * scenario — `GOLDEN_ROUNDS` without `GOLDEN_ROUNDS_ENV` is a different capture
 * entirely. The test clears both keys in its `afterEach`.
 */
export async function captureRoundsBuild(
  ws: BuildWorkspace,
  promptDir: string,
): Promise<CapturedRounds> {
  for (const [key, value] of Object.entries(GOLDEN_ROUNDS_ENV)) process.env[key] = value;

  const headless = await next(ws, { mode: "headless" });
  const machine = machineOf(ws);
  const prompt = (name: string): string =>
    scrubPrompt(readFileSync(join(promptDir, name), "utf8"), machine);

  return {
    developerS1Round1: prompt("developer-S1-1.md"),
    developerS1Round2: prompt("developer-S1-2.md"),
    reviewerS1Round1: prompt("reviewer-S1-1.md"),
    reviewerS1Round2: prompt("reviewer-S1-2.md"),
    developerS2: prompt("developer-S2-1.md"),
    events: eventStream(ws, machine),
    runTasks: taskRows(ws, machine),
    exitCodes: `headless ${String(headless.code)}\n`,
  };
}

/**
 * One headless `tldrx next` over `GOLDEN_REFUSED`: the developer runs, its DoD
 * command is REFUSED, and the story blocks before a reviewer is ever asked for.
 */
export async function captureRefusedBuild(
  ws: BuildWorkspace,
  promptDir: string,
): Promise<CapturedRefused> {
  const headless = await next(ws, { mode: "headless" });
  const machine = machineOf(ws);
  return {
    developerPrompt: scrubPrompt(readFileSync(join(promptDir, "developer-S1-1.md"), "utf8"), machine),
    events: eventStream(ws, machine),
    runTasks: taskRows(ws, machine),
    exitCodes: `headless ${String(headless.code)}\n`,
  };
}

/** Read a committed golden, or the empty string when it has not been generated yet. */
export function readGolden(name: string): string {
  const path = join(GOLDEN_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * Overwrite one committed golden.
 *
 * Reachable ONLY from `test/build-golden.test.ts` under `TLDRX_GOLDEN_UPDATE=1`,
 * and only ever legitimate for a deliberate, separately reviewed behaviour
 * change. Inside a refactor wave a golden byte change means the move was wrong.
 */
export function writeGolden(name: string, content: string): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(join(GOLDEN_DIR, name), content, "utf8");
}

// --- the machine's own nondeterministic bytes --------------------------------

interface Machine {
  /** The workspace root, and its realpath when the two differ (macOS `/var` → `/private/var`). */
  readonly roots: readonly string[];
  /** EVERY commit the fixture repo holds — see `machineOf`. */
  readonly shas: readonly string[];
}

/**
 * The workspace root and EVERY commit sha the fixture repo holds.
 *
 * The first version resolved two refs — the epic tip and the story tip — and
 * replaced values that were a prefix of one of them. That was wrong, and the
 * two-story capture proved it: `task.done`'s `commit` for attempt 1 is the
 * commit that attempt made, and by capture time the story branch has moved on to
 * attempt 2, so attempt 1's sha is a tip no longer. It went into the golden RAW
 * (`"commit":"05ed8c5"`) and would have moved on the next run. A normaliser that
 * only knows where the branches ENDED cannot see the history they walked.
 *
 * So: `git rev-list --all` in the fixture repo, once, and a value is normalised
 * when it is a >= 7-character prefix of a sha that repo actually contains. Every
 * replacement is still an EXACT string VERIFIED against the machine — stronger
 * than a hex pattern, which would eventually eat a word — and it can no longer
 * miss a commit just because nothing points at it any more.
 *
 * One marker, `<SHA>`, for all of them. The earlier `<SHA:epic>` / `<SHA:story>`
 * naming read as more information than it carried: attempt 2's story commit IS
 * the epic tip after a fast-forward merge, so it rendered as `<SHA:epic>` while
 * being the story's commit. A label that can be wrong in a guard is worse than
 * no label.
 */
function machineOf(ws: BuildWorkspace): Machine {
  const roots = [ws.root];
  const real = realpathOrNull(ws.root);
  if (real !== null && real !== ws.root) roots.push(real);
  // Longest first: `roots` may hold `/var/…` and `/private/var/…` for the same
  // directory, and replacing the SHORT one first would leave `/private<ROOT>`.
  return {
    roots: [...roots].sort((a, b) => b.length - a.length),
    shas: revList(ws.repoDir),
  };
}

/** The temp workspace root, by exact string. */
function scrubPaths(text: string, machine: Machine): string {
  let out = text;
  for (const root of machine.roots) out = out.split(root).join("<ROOT>");
  return out;
}

/**
 * The normalisation a prompt gets: the temp workspace root — and, since #166,
 * commit shas, because a reviewer prompt now names the epic's sha before the
 * merge instead of the epic BRANCH (a branch name is deterministic; a sha is
 * not).
 *
 * The same verified rule the event/task normaliser uses, applied to text rather
 * than to values: only a >= 7-char prefix of a sha `git rev-list --all` reports
 * in THIS fixture repo is replaced, so a hex-looking word that is not a commit
 * here stays raw. `scrubFullShas` handles the 40-char form; the short form is
 * matched with a word boundary so `abc1234` inside a longer token is untouched.
 *
 * Landed as a NO-OP: at the commit that introduced it no prompt contained a sha
 * at all, and `bun test test/build-golden.test.ts` passed over the unchanged
 * golden files — which is the property that makes it safe to rely on next.
 */
function scrubPrompt(text: string, machine: Machine): string {
  let out = scrubFullShas(scrubPaths(text, machine), machine);
  for (const sha of machine.shas) {
    for (let n = 40; n >= 7; n--) {
      const prefix = sha.slice(0, n);
      out = out.replace(new RegExp(`\\b${prefix}\\b`, "g"), "<SHA>");
    }
  }
  return out;
}

/**
 * A whole string value that is a >= 7-char prefix of a known branch tip, or a
 * full 40-char sha embedded anywhere. Nothing else — see the header.
 */
function scrubShaValue(value: string, machine: Machine): string {
  if (value.length < 7 || value.length > 40 || !/^[0-9a-f]+$/.test(value)) return value;
  return machine.shas.some((sha) => sha.startsWith(value)) ? "<SHA>" : value;
}

/**
 * `scrubShaValue`, but reaching every string ANYWHERE in a payload — inside
 * arrays, inside nested objects, at any depth.
 *
 * The first version only reached top-level strings, which was enough for the
 * payloads that exist today (measured) and would have gone quietly wrong the
 * first time a later task moved a sha into `conflicts: [...]` or a nested
 * `merge: {...}`. A guard whose normalisation depends on the shape not changing
 * is a guard that flakes exactly when the wave gets interesting.
 */
function scrubDeep(value: unknown, machine: Machine): unknown {
  if (typeof value === "string") return scrubShaValue(value, machine);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, machine));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(nested, machine);
    }
    return out;
  }
  return value;
}

function scrubFullShas(text: string, machine: Machine): string {
  let out = text;
  for (const sha of machine.shas) out = out.split(sha).join("<SHA>");
  return out;
}

// --- the four renderings -----------------------------------------------------

/**
 * One line per event, in file order:
 * `#NN <type> stage=… actor=… cost_usd=… keys=[…] payload={…}`.
 *
 * The index makes a reordering read as a reordering rather than as ten changed
 * lines. `ts` is not rendered (wall clock). Payload keys are sorted so a
 * serialisation order change is not mistaken for a contract change; the values
 * are pinned beside them because measured, every one of them is deterministic
 * once the shas are scrubbed, and a key list alone would not notice `verdict`
 * flipping from `approve` to `changes`.
 *
 * `keys=[…]` duplicates what `payload={…}` already shows, and does so on
 * purpose: a gained or lost key then changes a short field at the FRONT of the
 * line instead of hiding inside a 200-character JSON blob, and the key set is
 * the half of the contract that a pure refactor must not touch at all.
 */
function eventStream(ws: BuildWorkspace, machine: Machine): string {
  const rows = EventLog.forRun(ws.runDir).read() as readonly {
    type: string;
    stage: string | null;
    actor?: string;
    cost_usd?: number;
    payload?: Record<string, unknown>;
  }[];
  const lines = rows.map((event, index) => {
    const payload = event.payload ?? {};
    const keys = Object.keys(payload).sort();
    const scrubbed: Record<string, unknown> = {};
    for (const key of keys) scrubbed[key] = scrubDeep(payload[key], machine);
    return [
      `#${String(index).padStart(2, "0")}`,
      event.type,
      `stage=${event.stage ?? "-"}`,
      `actor=${event.actor ?? "-"}`,
      `cost_usd=${JSON.stringify(event.cost_usd ?? null)}`,
      `keys=[${keys.join(",")}]`,
      `payload=${JSON.stringify(scrubbed)}`,
    ].join(" ");
  });
  return `${scrubFullShas(scrubPaths(lines.join("\n"), machine), machine)}\n`;
}

/** `run.yml`'s task rows, one JSON object per line with sorted keys. */
function taskRows(ws: BuildWorkspace, machine: Machine): string {
  const run = RunStore.open(ws.runDir).run;
  const rows: string[] = [];
  for (const phase of run.phases) {
    for (const stage of phase.stages) {
      for (const task of stage.tasks) {
        const source = task as unknown as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) sorted[key] = scrubDeep(source[key], machine);
        rows.push(JSON.stringify(sorted));
      }
    }
  }
  const text = scrubFullShas(scrubPaths(rows.join("\n"), machine), machine);
  // Anchored on the JSON key, so only the wall-clock field is blanked and
  // `started_at` — which is `options.at` verbatim — stays a real assertion.
  return `${text.replace(/"ended_at":"[^"]*"/g, '"ended_at":"<TS>"')}\n`;
}

// --- plumbing ----------------------------------------------------------------

/** Every commit in the fixture repo, on any ref. Empty when git says nothing. */
function revList(repoDir: string): readonly string[] {
  try {
    return execFileSync("git", ["rev-list", "--all"], { cwd: repoDir, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function next(
  ws: BuildWorkspace,
  overrides: Partial<NextOptions>,
): Promise<{ code: number; lines: readonly string[] }> {
  return runNext({
    root: ws.root,
    dryRun: false,
    mode: "headless",
    yolo: false,
    actor: "alan",
    at: "2026-08-29T09:00:00Z",
    ...overrides,
  });
}
