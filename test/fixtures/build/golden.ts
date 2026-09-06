/**
 * The Build executor's GOLDEN GUARD (wave 2, step 0b).
 *
 * Wave 2 cuts a 4,351-line file into modules and claims it changed nothing. That
 * claim is only worth what proves it, and the existing suite proves PROPERTIES —
 * this proves BYTES. Two fake-agent builds over the same one-story plan produce
 * ten artifacts that are compared, byte for byte, against files committed under
 * `golden/`:
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
 * path. No sha, timestamp or duration appears in a prompt at all. So:
 *
 * | Artifact | Normalised | Why |
 * |---|---|---|
 * | prompts | the workspace root → `<ROOT>` (and its `realpath`, since macOS's `/var/folders` is a symlink to `/private/var/folders`) | `mkdtempSync(join(tmpdir(), "tldrx-build-"))` (`workspace.ts:122`) — a fresh temp dir per invocation. Both are EXACT strings read from the machine, long and unique, so nothing incidental can match. |
 * | events | the workspace root, plus the epic/story branch shas | `task.done`'s `commit` is the story branch's tip, abbreviated by git; commit timestamps move it every run. |
 * | task rows | the workspace root, plus `"ended_at": "<TS>"` | `ended_at` is the wall clock at the moment the row was written. `started_at` is NOT normalised — measured, it is `options.at` verbatim, so it is a real assertion. |
 *
 * The sha normaliser is deliberately narrow, because a blunt "replace any 7-char
 * hex prefix" pass over 400 lines of prose is a normalisation that could hide a
 * real byte change:
 *   - a payload value that is a WHOLE string of >= 7 chars and is a prefix of the
 *     epic or story sha becomes `<SHA:epic>` / `<SHA:story>` — this is what
 *     catches `"commit": "200819e"`;
 *   - the full 40-char sha is replaced as a substring anywhere, because a
 *     40-char hex string cannot occur innocently.
 * Any other hex — including `main`'s sha, which measured does not appear in any
 * artifact — is left raw. If a refactor ever puts one somewhere new, the golden
 * goes RED, which is the answer we want.
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
    developerPrompt: scrubPaths(readFileSync(join(promptDir, "developer-S1-1.md"), "utf8"), machine),
    reviewerPrompt: scrubPaths(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8"), machine),
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
    bundlePrompt: scrubPaths(
      readFileSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"), "utf8"),
      machine,
    ),
    reviewerPrompt: scrubPaths(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8"), machine),
    events: eventStream(ws, machine),
    runTasks: taskRows(ws, machine),
    exitCodes: `prepare ${String(prepare.code)}\ncommit ${String(commit.code)}\n`,
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
  /** Branch tips, longest sha first so a prefix pass can never shadow a full one. */
  readonly shas: readonly { readonly name: string; readonly sha: string }[];
}

function machineOf(ws: BuildWorkspace): Machine {
  const roots = [ws.root];
  const real = realpathOrNull(ws.root);
  if (real !== null && real !== ws.root) roots.push(real);
  const shas = [
    { name: "epic", sha: rev(ws.repoDir, "epic/e1") },
    { name: "story", sha: rev(ws.repoDir, `story/${ws.runId}/S1`) },
  ].filter((entry) => entry.sha !== "");
  // Longest first: `roots` may hold `/var/…` and `/private/var/…` for the same
  // directory, and replacing the SHORT one first would leave `/private<ROOT>`.
  return { roots: [...roots].sort((a, b) => b.length - a.length), shas };
}

/** The one normalisation a prompt gets: the temp workspace root, by exact string. */
function scrubPaths(text: string, machine: Machine): string {
  let out = text;
  for (const root of machine.roots) out = out.split(root).join("<ROOT>");
  return out;
}

/**
 * A whole string value that is a >= 7-char prefix of a known branch tip, or a
 * full 40-char sha embedded anywhere. Nothing else — see the header.
 */
function scrubShaValue(value: string, machine: Machine): string {
  for (const { name, sha } of machine.shas) {
    if (value.length >= 7 && sha.startsWith(value)) return `<SHA:${name}>`;
  }
  return value;
}

function scrubFullShas(text: string, machine: Machine): string {
  let out = text;
  for (const { name, sha } of machine.shas) out = out.split(sha).join(`<SHA:${name}>`);
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
    for (const key of keys) {
      const value = payload[key];
      scrubbed[key] = typeof value === "string" ? scrubShaValue(value, machine) : value;
    }
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
        for (const key of Object.keys(source).sort()) {
          const value = source[key];
          sorted[key] = typeof value === "string" ? scrubShaValue(value, machine) : value;
        }
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

function rev(repoDir: string, ref: string): string {
  try {
    return execFileSync("git", ["rev-parse", ref], { cwd: repoDir, encoding: "utf8" }).trim();
  } catch {
    return "";
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
