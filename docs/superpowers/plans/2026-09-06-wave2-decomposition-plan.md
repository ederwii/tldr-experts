# Wave 2 — decompose the Build executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `src/core/facilitator/executors/build.ts` (4,351 lines, one 107-method class) into
`src/core/build/` modules without changing one byte of behaviour.

**Architecture:** Seven move steps, each ending green on every gate. A golden guard captured
FIRST (step 0b) freezes the developer prompt, the reviewer prompt, the ordered event stream, the
`run.yml` task rows and the exit codes of a real fake-agent build; every later step keeps it
byte-identical. Extracted functions take explicit data — never `ExecutorContext` — and the
orchestrator owns the mutable state (`PreflightCache`, `EpicState`, `ReviewCounters`) and passes
the append-only sinks (`lines`, `advisories`, `tasks`) and the `SerialQueue` in. Every moved
symbol is re-exported from `build.ts`, so the public surface does not move at all.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), Bun for build/test, Node ≥ 20 at
runtime, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-06-wave2-decomposition-design.md` — read it before
Task 0. Its line ranges were measured at `0511039`; `build.ts` is byte-identical at `c045f3f`
(`git diff --stat 0511039 HEAD -- src/core/facilitator/executors/build.ts` → empty, exit 0,
measured), so every range below is a real line number in the file you are editing.

---

## Global Constraints

Copied from `AGENTS.md` and the spec. Every task's requirements implicitly include this section.

- **This is a PURE REFACTOR. No behaviour change is allowed.** Byte-identical prompts, the same
  events in the same order with the same payload keys, the same `run.yml` rows, the same exit
  codes, the same operator lines. **Anything that looks like a fix is refused and filed as a
  GitHub issue with evidence — never fixed inside this change** (AGENTS.md §1).
- **A step whose diff changes a golden byte is a behaviour change: REVERT the step. Do not
  "update the golden."** The only edit ever permitted to a file under
  `test/fixtures/build/golden/` after Task 0b is deletion of the whole directory in a future,
  deliberate change — never a per-byte accommodation.
- **Evidence before assertion.** Label every claim in a commit body or issue `measured`,
  `inferred` or `assumed` (AGENTS.md §1).
- **Exit codes are never read through a pipe or after a trailing command.** Capture each gate
  command's exit as its OWN line, immediately. The shell here is zsh: `${PIPESTATUS[0]}` is a
  bashism and does not work, and `status` is a reserved variable name — never use it.
- **No `Bun.*` under `src/` outside `src/core/runtime/`.** Runtime code must run under plain
  Node ≥ 20 (AGENTS.md §3).
- **No module under `src/core/build/` may import `ExecutorContext`, `ExecutorOutcome` or
  `ExecutorTask`.** That is the mechanical spelling of the spec's decision 3 ("extracted
  functions take data, not `ctx`"), and it is grep-checked in Task 7. Functions that today
  RETURN an `ExecutorOutcome` refusal return a `BuildRefusal` (`{ lines, error }`) instead and
  `build.ts` wraps it — the refusal helpers themselves stay in `build.ts` (spec §3).
- **Every moved symbol is re-exported from `build.ts`** so the ten importing test files,
  `src/core/run/reopenStory.ts:54` and `src/core/facilitator/index.ts:34` see no change
  (spec decision 4).
- **Source-text pins are retargeted, not weakened** (spec decision 6). When a pinned line moves,
  the SAME assertion points at the new file in the SAME commit, with the reason written in the
  test as a comment and in the commit body as a declared deviation.
- **Red-first where a NEW behaviour is asserted** (Task 0b's golden test only). Every other task
  in this plan writes no new assertion: its proof is that the EXISTING suite plus the golden
  stay green. Say so in the commit body — a test that passed before the change is a guard, not
  a proof (AGENTS.md §1).
- **Work only inside your own worktree.** Never `git reset --hard`, never `git checkout -B main`
  in the shared checkout (AGENTS.md §2).
- **No release steps.** This plan ends at Task 7. Do not tag, do not publish, do not run
  `scripts/release.sh`.
- Every commit message ends with exactly:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
  ```

### THE GATE (run at the end of every task, in this exact form)

```bash
bun run typecheck
echo "typecheck exit: $?"
bun test
echo "bun test exit: $?"
bun run build
echo "build exit: $?"
bun run docs:build
echo "docs:build exit: $?"
grep -rn 'Bun\.' src --include='*.ts' | grep -v 'src/core/runtime/'
echo "seam grep printed the lines above (expected: none)"
grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' '
echo "seam count printed above (expected: 0)"
```

Expected: `typecheck exit: 0`, `bun test exit: 0`, `build exit: 0`, `docs:build exit: 0`, the
seam grep printing nothing, and the seam count printing `0`. `bun test` also prints
`N pass  0 fail` — record N in the commit body of every task so the test delta is measured at
both ends and attributable (AGENTS.md §11).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/build/index.ts` | DELETED — dead barrel, zero code importers (measured) | 0 |
| `test/fixtures/build/golden.ts` | Capture + normalise the five golden artifacts | 0b |
| `test/fixtures/build/golden/*` | The committed golden bytes | 0b |
| `test/build-golden.test.ts` | Compares a real fake-agent build against the golden | 0b |
| `src/core/build/reviewLedger.ts` | `events.jsonl` → `ReviewLedger`, one pass, pure reader | 1 |
| `src/core/build/phaseCost.ts` | `run.yml` + this invocation's turns → the handoff's cost line | 1 |
| `src/core/build/caps.ts` | Money constants and every per-story ceiling, as plain arithmetic | 2 |
| `src/core/build/dodRunner.ts` | The story DoD, the base-tree pre-flight and its `PreflightCache` | 3 |
| `src/core/build/worktrees.ts` | Story/epic worktrees, base refresh, commit, merge, rescue; `EpicState` | 4 |
| `src/core/build/branchClaims.ts` | Epic-branch claims, the branch model, the two tree refusals, epic rows | 4 |
| `src/core/build/reviewBundle.ts` | The reviewer bundle on disk: keys, write, clear, read back | 5 |
| `src/core/build/reviewRound.ts` | `ReviewCounters`, `REVIEWER_TOOLS`, the reviewer prompt, the two bounds | 5 |
| `src/core/build/outcome.ts` | + `BuildRefusal` (additive export) | 3 |
| `src/core/facilitator/executors/build.ts` | The orchestrator: entry points, wave drivers, story state, log/handoff, refusal helpers, `SerialQueue`, and the re-export block | all |

What deliberately STAYS in `build.ts` (spec §3): `buildExecutor` + `withClaims`, the refusal
helpers (`attendedRefusal`, `refusedOnBase`, `refusedOnSequence`, `failed`, `refuseOnEnvelope`),
`openPlan` / `rederiveImplicitPlan` / `discardBundles` / `runTitleOf`, `SerialQueue`, the five
entry points, the wave drivers, the story-state cluster, the log/handoff cluster, `developerTools`,
`developerPrompt`, `spawnDeveloper`, `spawnReviewer`, `recordReview`, `round2`, and `openStory`
as the composer over `worktrees.ts`.

---

### Task 0: Delete the dead barrel

**Files:**
- Delete: `src/core/build/index.ts` (86 lines, re-exports only)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task removes a file no code reads.

- [ ] **Step 1: Prove zero code importers, three ways**

```bash
grep -rn "build/index\.ts" src test scripts bin
echo "grep A exit: $?"
grep -rn 'from "\.\./\.\./build"' src test scripts bin
echo "grep B exit: $?"
grep -rn 'from "\.\./build"\|from "\./build"\|core/build"' src test scripts bin
echo "grep C exit: $?"
```

Expected: no output from any of the three, and `grep A exit: 1`, `grep B exit: 1`,
`grep C exit: 1` (grep exits 1 when it matched nothing). Measured at `c045f3f`: all three are
empty; the only hits anywhere in the repo are prose in `docs/superpowers/`.

**If ANY of the three prints a line, STOP.** The barrel is live, spec decision 8 is refuted, and
that is a finding to report — not a file to delete anyway.

- [ ] **Step 2: Delete it**

```bash
git rm src/core/build/index.ts
```

- [ ] **Step 3: Run THE GATE**

Run the block from Global Constraints. Expected: every exit `0`, seam count `0`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(build): delete the dead src/core/build/ barrel

Zero importers, measured three ways (`build/index.ts`, `from "../../build"`,
`core/build"` — all three greps empty across src/test/scripts/bin at c045f3f).
A barrel nothing reads is a second, unpoliced list of the phase's public surface
that drifts on its first edit, and wave 2 is about to move a dozen symbols
through this directory.

Behaviour: none. No file under src/ or test/ referenced it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 0b: THE GOLDEN GUARD

This is the only task in the plan that writes a new assertion, and it is the task every later
one leans on. It runs the fake-agent build fixture end to end through `--prepare` and
`--commit` and compares five artifacts, byte for byte, against files committed under
`test/fixtures/build/golden/`.

**Files:**
- Create: `test/fixtures/build/golden.ts`
- Create: `test/build-golden.test.ts`
- Create (generated once, then committed): `test/fixtures/build/golden/developer-prompt.md`,
  `test/fixtures/build/golden/reviewer-prompt.md`, `test/fixtures/build/golden/events.txt`,
  `test/fixtures/build/golden/run-tasks.txt`, `test/fixtures/build/golden/exit-codes.txt`

**Interfaces:**
- Consumes: `makeBuildWorkspace`, `BuildWorkspace`, `BuildWorkspaceOptions` from
  `test/fixtures/build/workspace.ts`; `runNext`, `NextOptions` from
  `src/core/facilitator/runNext.ts`; `spawnTestTimeout` from `test/fixtures/machineLoad.ts`;
  `EventLog` from `src/core/events/EventLog.ts`; `RunStore` from `src/core/run/RunStore.ts`.
- Produces, for every later task:
  - `captureBuild(ws: BuildWorkspace, promptDir: string): Promise<Captured>` where
    `interface Captured { readonly developerPrompt: string; readonly reviewerPrompt: string; readonly events: string; readonly runTasks: string; readonly exitCodes: string }`
  - `GOLDEN_DIR: string` — the absolute path of `test/fixtures/build/golden/`
  - `GOLDEN_STORY: BuildWorkspaceOptions` — the one-story plan the golden is taken over.

#### Why these five, and what is normalised

The five artifacts are exactly the surfaces a refactor of this file can silently move:

1. **The developer prompt** — read from the `--prepare` bundle at
   `<runDir>/.agent/build/S1/prompt.md`. It is what `developerPrompt` + `buildDeveloperPrompt`
   assembled; a dropped expert bundle, a reordered section or a lost `notInWorktree` set all
   land here.
2. **The reviewer prompt** — read from `FAKE_BUILD_PROMPT_DIR/reviewer-S1-1.md`, which the fake
   `claude` writes verbatim from its stdin before doing anything else
   (`test/fixtures/build/fakeClaude.ts:58-63`). It is what the SPAWNED reviewer was handed.
3. **The ordered event kinds with their payload KEYS** — type plus sorted key list, never
   values. Values carry shas, temp paths and costs; keys carry the CONTRACT
   (`source: "host"` present or absent, `attempt`, `retry`, `verdict`, `commit`…), and the
   contract is what a move can break.
4. **The `run.yml` task rows** — `stage.tasks[]`, the money ledger `validateRunFile` polices.
5. **The exit codes** of the two `runNext` calls.

Normalised, each for a stated reason, and **nothing else**:

| Normalisation | Why it is genuinely nondeterministic |
|---|---|
| The workspace root path → `<ROOT>` | `mkdtempSync(join(tmpdir(), "tldrx-build-"))` (`workspace.ts:122`) — a fresh temp dir per invocation. Applied to both prompts and the task rows. |
| The epic-branch sha → `<SHA:epic>`, the story-branch sha → `<SHA:story>` (full value and any 7–12 char prefix of it) | Git shas depend on commit timestamps, which move every run. The two values are READ from the repo at capture time with `git rev-parse` and replaced by exact string, so the normaliser can never over-match an innocent hex-looking word. |
| `started_at` / `ended_at` on a task row → `<TS>` | Written by `recordExecutorTasks` from the wall clock, not from `options.at`. |
| `session_id` — **NOT normalised** | The fake emits `fake-developer-S1` / `fake-reviewer-S1` deterministically (`fakeClaude.ts:105`). Left raw on purpose: it is a real assertion that the right role produced the row. |
| The run id — **NOT normalised** | `createRun` derives it as `yymmdd(now)-slug` (`newRun.ts:145,570`) and the fixture pins `now: 2026-08-29T09:00:00Z`, slug `build`, so it is `260829-build` on every machine. Step 2 asserts that explicitly, so a change to `createRun` fails loudly instead of quietly making the golden unstable. |

- [ ] **Step 1: Write the capture helper**

Create `test/fixtures/build/golden.ts`:

```ts
/**
 * The Build executor's GOLDEN GUARD (wave 2, step 0b).
 *
 * Wave 2 cuts a 4,351-line file into modules and claims it changed nothing. That
 * claim is only worth what proves it, and the existing suite proves properties —
 * this proves BYTES. One fake-agent build, driven through `--prepare` and
 * `--commit`, produces five artifacts that are compared against files committed
 * under `golden/`:
 *
 *   1. the developer prompt (the `--prepare` bundle's own `prompt.md`)
 *   2. the reviewer prompt (what the SPAWNED reviewer was handed, captured by the
 *      fake `claude` from its stdin — see `fakeClaude.ts` and FAKE_BUILD_PROMPT_DIR)
 *   3. the ordered event kinds with their payload KEYS (never values: keys are the
 *      contract, values carry shas and temp paths)
 *   4. `run.yml`'s `stage.tasks[]` — the money ledger `validateRunFile` polices
 *   5. the exit codes of the two `runNext` calls
 *
 * **A golden byte change is a behaviour change. Revert the step; never update the
 * golden.**
 *
 * Only three things are normalised, and each is genuinely nondeterministic:
 * the temp workspace root (`mkdtempSync`), the two git shas (commit timestamps
 * move them — read from git and replaced by exact string, so nothing else can be
 * caught), and a task row's `started_at`/`ended_at` (wall clock, not `options.at`).
 * The run id is deliberately NOT normalised: `createRun` derives it from the
 * fixture's pinned `now`, so `260829-build` is the same on every machine, and the
 * test asserts that so the day it stops being true is a red test, not a flake.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export interface Captured {
  readonly developerPrompt: string;
  readonly reviewerPrompt: string;
  readonly events: string;
  readonly runTasks: string;
  readonly exitCodes: string;
}

/** The five artifacts of one `--prepare` + `--commit` cycle, normalised. */
export async function captureBuild(ws: BuildWorkspace, promptDir: string): Promise<Captured> {
  const prepare = await next(ws, { mode: "prepare", at: "2026-08-29T09:00:00Z" });

  // The host's half of the handshake: the developer wrote a file and a result.json.
  // Written here rather than by the fake, because `--prepare` spawns NOTHING —
  // that is the contract this whole path exists to keep.
  const worktree = join(ws.root, ".tldrx", "worktrees", ws.repoName, `${ws.runId}-S1`);
  writeFileSync(join(worktree, "s1.txt"), "S1 was here\n", "utf8");
  writeFileSync(
    join(ws.runDir, ".agent", "build", "S1", "result.json"),
    `${JSON.stringify({ outputs: ["s1.txt"], questions_asked: [], notes: "", cost_usd: 0.1 })}\n`,
    "utf8",
  );

  const commit = await next(ws, { mode: "commit", at: "2026-08-29T09:30:00Z", costUsd: 0.1 });

  const shas = {
    epic: rev(ws.repoDir, "epic/e1"),
    story: rev(ws.repoDir, `story/${ws.runId}/S1`),
  };
  const scrub = (text: string): string => normalise(text, ws.root, shas);

  return {
    developerPrompt: scrub(readFileSync(join(ws.runDir, ".agent", "build", "S1", "prompt.md"), "utf8")),
    reviewerPrompt: scrub(readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8")),
    events: scrub(eventShape(ws)),
    runTasks: scrub(taskRows(ws)),
    exitCodes: `prepare ${String(prepare.code)}\ncommit ${String(commit.code)}\n`,
  };
}

/** `<type> <sorted payload keys>` per line, in file order. Keys, never values. */
function eventShape(ws: BuildWorkspace): string {
  const rows = EventLog.forRun(ws.runDir).read() as readonly {
    type: string; payload?: Record<string, unknown>;
  }[];
  return `${rows
    .map((e) => `${e.type} [${Object.keys(e.payload ?? {}).sort().join(",")}]`)
    .join("\n")}\n`;
}

/** `run.yml`'s Build stage task rows, one JSON object per line with sorted keys. */
function taskRows(ws: BuildWorkspace): string {
  const run = RunStore.open(ws.runDir).run;
  const rows: string[] = [];
  for (const phase of run.phases) {
    for (const stage of phase.stages) {
      for (const task of stage.tasks) {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(task).sort()) {
          sorted[key] = (task as unknown as Record<string, unknown>)[key];
        }
        rows.push(JSON.stringify(sorted));
      }
    }
  }
  return `${rows.join("\n")}\n`;
}

/**
 * The three normalisations, and no others. Each replaces an EXACT string read
 * from the machine, so nothing incidental can be caught by a pattern.
 */
function normalise(text: string, root: string, shas: { epic: string; story: string }): string {
  let out = text.split(root).join("<ROOT>");
  for (const [name, sha] of [["epic", shas.epic], ["story", shas.story]] as const) {
    if (sha === "") continue;
    out = out.split(sha).join(`<SHA:${name}>`);
    // Git prints abbreviated shas too; only PREFIXES OF THIS EXACT SHA are replaced.
    for (let n = 12; n >= 7; n--) out = out.split(sha.slice(0, n)).join(`<SHA:${name}>`);
  }
  return out
    .replace(/"started_at":"[^"]*"/g, '"started_at":"<TS>"')
    .replace(/"ended_at":"[^"]*"/g, '"ended_at":"<TS>"');
}

function rev(repoDir: string, ref: string): string {
  try {
    return execFileSync("git", ["rev-parse", ref], { cwd: repoDir, encoding: "utf8" }).trim();
  } catch {
    return "";
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

/** Read a committed golden, or the empty string when it has not been generated yet. */
export function readGolden(name: string): string {
  const path = join(GOLDEN_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Used ONLY by the one-shot generation step. Never called by the test. */
export function writeGolden(name: string, content: string): void {
  writeFileSync(join(GOLDEN_DIR, name), content, "utf8");
}
```

- [ ] **Step 2: Write the failing test**

Create `test/build-golden.test.ts`:

```ts
/**
 * The Build executor's golden guard (wave 2, step 0b).
 *
 * Not a property test. This one compares BYTES — the developer prompt, the
 * reviewer prompt, the ordered event kinds with their payload keys, `run.yml`'s
 * task rows and the two exit codes — against files committed under
 * `test/fixtures/build/golden/`. It exists because wave 2 moves ~2,000 lines out
 * of one file and claims that changed nothing; this is what makes the claim
 * checkable rather than argued.
 *
 * **If this test goes red during a move step, the step is wrong. Revert it. Do
 * not regenerate the golden.** The only thing a golden byte can legitimately
 * change for is a deliberate behaviour change, which is not what wave 2 is.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBuildWorkspace, type BuildWorkspace } from "./fixtures/build/workspace.ts";
import { captureBuild, GOLDEN_STORY, readGolden } from "./fixtures/build/golden.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

// This file spawns real processes — git, the fake `claude`, `npm run test`. Process
// cost is a property of the machine, so bun's fixed 5000 ms default measures the box.
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

describe("the Build executor's observable output is byte-frozen", () => {
  test("prompts, events, run.yml rows and exit codes match the committed golden", async () => {
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

    const got = await captureBuild(ws, promptDir);

    expect(got.exitCodes).toBe(readGolden("exit-codes.txt"));
    expect(got.developerPrompt).toBe(readGolden("developer-prompt.md"));
    expect(got.reviewerPrompt).toBe(readGolden("reviewer-prompt.md"));
    expect(got.events).toBe(readGolden("events.txt"));
    expect(got.runTasks).toBe(readGolden("run-tasks.txt"));
  }, 120_000);
});
```

- [ ] **Step 3: Run it and keep the RED verbatim**

```bash
bun test test/build-golden.test.ts
echo "golden test exit: $?"
```

Expected: `golden test exit: 1`, with five failing `expect(...).toBe("")` — `readGolden`
returns `""` because nothing is committed yet. **Paste this output verbatim into the commit
body.** It is the proof the comparison can fail.

- [ ] **Step 4: Generate the golden files, ONCE**

```bash
mkdir -p test/fixtures/build/golden
cat > /tmp/gen-golden.ts <<'TS'
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBuildWorkspace } from "./test/fixtures/build/workspace.ts";
import { captureBuild, GOLDEN_STORY, writeGolden } from "./test/fixtures/build/golden.ts";

const ws = makeBuildWorkspace(GOLDEN_STORY);
process.env.PATH = ws.binDir;
process.env.FAKE_BUILD_STATE = ws.statePath;
process.env.FAKE_BUILD_COST = "0.10";
const promptDir = join(ws.root, "prompts");
mkdirSync(promptDir, { recursive: true });
process.env.FAKE_BUILD_PROMPT_DIR = promptDir;
const got = await captureBuild(ws, promptDir);
writeGolden("developer-prompt.md", got.developerPrompt);
writeGolden("reviewer-prompt.md", got.reviewerPrompt);
writeGolden("events.txt", got.events);
writeGolden("run-tasks.txt", got.runTasks);
writeGolden("exit-codes.txt", got.exitCodes);
ws.dispose();
console.log("golden written");
TS
bun /tmp/gen-golden.ts
echo "generate exit: $?"
rm /tmp/gen-golden.ts
```

Expected: `golden written` and `generate exit: 0`.

The generator lives in `/tmp` on purpose and is deleted: a committed regenerator is a button
labelled "make the guard agree with me", and the whole value of this guard is that there is no
such button.

- [ ] **Step 5: Read every generated file before committing it**

```bash
wc -l test/fixtures/build/golden/*
grep -c "<ROOT>" test/fixtures/build/golden/developer-prompt.md
grep -rn "/var/folders\|/tmp/tldrx-build\|$(whoami)" test/fixtures/build/golden/
echo "leak grep exit: $?"
head -20 test/fixtures/build/golden/events.txt
cat test/fixtures/build/golden/exit-codes.txt
cat test/fixtures/build/golden/run-tasks.txt
```

Expected: `leak grep exit: 1` (no machine-specific path or username survived normalisation),
`exit-codes.txt` reading `prepare 0` / `commit 0`, `events.txt` starting with `stage.started`
and containing `task.started`, `check.passed [check,command,detail,exit_code,phase,story]`,
`agent.spawned`, `check.passed [attempt,check,detail,phase,story,verdict]` and `task.done`,
and `run-tasks.txt` holding two rows (the host-declared developer turn and the spawned
reviewer turn).

**If any file contains an absolute machine path or a username, STOP** — the normaliser is
incomplete and a golden that only matches on one machine is worse than none.

- [ ] **Step 6: Run the test twice, on two clean invocations**

```bash
bun test test/build-golden.test.ts
echo "run 1 exit: $?"
bun test test/build-golden.test.ts
echo "run 2 exit: $?"
```

Expected: `run 1 exit: 0` and `run 2 exit: 0`. Two green runs over two different temp dirs and
two different sets of git shas is the evidence that the normalisation is complete — one green
run only proves the capture matched itself.

- [ ] **Step 7: Satisfy the machine-load invariant**

`test/machine-load.test.ts:103-134` collects every test file whose source contains
`makeBuildWorkspace` (among others) and asserts each one imports from
`./fixtures/machineLoad.ts` and calls `setDefaultTimeout(spawnTestTimeout(`. The new file does
both (Step 2). The count assertion is a FLOOR — `expect(spawners.length).toBeGreaterThanOrEqual(40)`
with 74 files matching at `c045f3f` (measured) — so adding one needs no arithmetic.

```bash
bun test test/machine-load.test.ts
echo "machine-load exit: $?"
```

Expected: `machine-load exit: 0`.

- [ ] **Step 8: Run THE GATE**

Run the block from Global Constraints. Expected: every exit `0`, seam count `0`.

- [ ] **Step 9: Commit**

```bash
git add test/fixtures/build/golden.ts test/fixtures/build/golden test/build-golden.test.ts
git commit -m "$(cat <<'EOF'
test(build): a golden guard over the Build executor's observable output

Wave 2 is about to move ~2,000 lines out of a 4,351-line file and claim it
changed nothing. The existing suite proves properties; this proves BYTES —
one fake-agent build driven through --prepare/--commit, compared against
committed files: the developer prompt (the bundle's own prompt.md), the
reviewer prompt (captured from the spawned reviewer's stdin by the fake
claude), the ordered event kinds with their payload KEYS, run.yml's task
rows, and both exit codes.

Keys and not values, deliberately: values carry shas, temp paths and costs;
keys carry the contract (`source: "host"` present or absent, attempt, retry,
verdict, commit) and the contract is what a move can break.

Three normalisations, each genuinely nondeterministic and each replacing an
EXACT string read from the machine so nothing incidental is caught: the
mkdtemp workspace root, the epic/story shas (read with `git rev-parse`, full
value and 7-12 char prefixes of THAT sha only), and a task row's
started_at/ended_at (wall clock, not options.at). The run id is NOT
normalised and the test asserts `260829-build`: createRun derives it from the
fixture's pinned `now`, so the day that stops holding is a red test rather
than a golden that quietly stops being stable.

There is no committed regenerator. A button labelled "make the guard agree
with me" is exactly what this guard is worth nothing with. A golden byte
change from here on is a BEHAVIOUR change: revert the step.

RED first, verbatim (five failures against `""` before the golden existed):
<paste the Step 3 output here>

Measured: two consecutive green runs over two different temp dirs and two
different sets of git shas. Tests: <N before> -> <N after>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 1: `reviewLedger.ts` + `phaseCost.ts` — the pure readers

**Files:**
- Create: `src/core/build/reviewLedger.ts`
- Create: `src/core/build/phaseCost.ts`
- Modify: `src/core/facilitator/executors/build.ts` (delete `:3879-3983`, `:3985-4098`,
  `:4100-4280`, `:4288-4299`; add imports and a re-export block)

**Symbols moved, with their real line ranges at `c045f3f`:**

| Symbol | build.ts lines (doc + body) | New home |
|---|---|---|
| `export interface ReviewLedger` | `:3879-3983` | `reviewLedger.ts` |
| `export function readReviewLedger` | `:4100-4280` | `reviewLedger.ts` |
| `function reviewEventErrored` | `:4288-4299` | `reviewLedger.ts` (not exported) |
| `export function phaseCostToDate` | `:3985-4098` | `phaseCost.ts` |

**Deviation from the spec's table, declared:** the spec lists step 1's ranges as `:3871-4096`
and `:4283-4351`. Measured against the file, those ranges are cut at doc-comment boundaries and
do not correspond to whole symbols: `:3871-4096` excludes `readReviewLedger` itself
(`:4100-4280` — the module named after it), and `:4283-4351` sweeps in `clipDetail` (`:4283`),
`isPlanStatus` (`:4301`), `refusedOnSequence` (`:4323`), `failed` (`:4337`) and `round2`
(`:4349`), which spec §3's prose explicitly leaves in `build.ts` ("the refusal helpers"). The
ranges above follow the prose and the symbols. `summaryOf` (`:3870-3873`) and `numberOf`
(`:3875-3878`) also stay: they parse a HOST ENVELOPE for `commitReview`, which stays.

**Interfaces:**
- Consumes: `DodResult`, `DEVELOPER_FAILED` from `src/core/build/outcome.ts`;
  `looksLikeReviewerError` from `src/core/build/review.ts`; `RunStore`, `stageAt`,
  `spendBasisOf`, `SpendTurn` as `phaseCostToDate` already does.
- Produces:
  ```ts
  // src/core/build/reviewLedger.ts
  export interface ReviewLedger { /* the 11 readonly fields, verbatim from :3885-3983 */ }
  export function readReviewLedger(runDir: string, storyId: string): ReviewLedger;

  // src/core/build/phaseCost.ts
  export interface PhaseCost { readonly usd: number; readonly note: string | null }
  export function phaseCostToDate(
    runDir: string,
    phaseId: string,
    stageId: string,
    invocationUsd: number,
    invocationTurns?: readonly PhaseCostTurn[],
  ): PhaseCost;
  /** One turn's accounting, as much of `ExecutorTask` as the cost line reads. */
  export interface PhaseCostTurn {
    readonly costUsd: number;
    readonly metered?: boolean;
    readonly tokens?: number;
  }
  ```

`PhaseCostTurn` is the whole reason this is a clean move: `phaseCostToDate`'s last parameter is
typed `readonly ExecutorTask[]` today (`:4051`), and `src/core/build/` may not import
`ExecutorTask` (Global Constraints). `PhaseCostTurn` is structurally the subset the body
actually reads (`task.metered`, `task.costUsd`, `task.tokens` — `:4076-4080`), so
`ExecutorTask[]` still assigns to it and `build.ts`'s call site at `:2674-2676` does not change
one character.

- [ ] **Step 1: Create `src/core/build/reviewLedger.ts`**

Move `:3879-3983` (the `ReviewLedger` interface with its full doc comment), `:4100-4280`
(`readReviewLedger` with its doc line at `:4100`) and `:4288-4299` (`reviewEventErrored` with
its doc) VERBATIM — not one word of a comment reworded, not one blank line moved. Add above
them a module docstring and these imports:

```ts
/**
 * `events.jsonl`, read once, into the answers a fresh process cannot hold in
 * memory: how many times a story was really REVIEWED, whether it is waiting on a
 * review that FAILED, what its last developer died with, and where the reset
 * boundaries are.
 *
 * A pure reader — it opens one file and returns a record. It lives here rather
 * than in the executor because every bound in the Build phase is enforced across
 * PROCESSES: `tldrx next --commit --review` settles one envelope and exits, so a
 * counter this process alone remembered would be no bound at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVELOPER_FAILED, type DodResult } from "./outcome.ts";
import { looksLikeReviewerError } from "./review.ts";
```

- [ ] **Step 2: Create `src/core/build/phaseCost.ts`**

Move `:3985-4098` verbatim (the long docstring at `:3985-4045` is the WHY of #138/#139 and is
the most load-bearing prose in the file — it moves untouched). Change exactly two things: the
`invocationTurns` parameter type from `readonly ExecutorTask[]` to `readonly PhaseCostTurn[]`,
and the inline return type to the named `PhaseCost`. Add:

```ts
/**
 * What the PHASE has spent so far, for `04-build/handoff.md`'s header — never
 * what THIS process spent (#138), and never a confident total when the ledger
 * cannot be read (#139).
 */
import { RunStore } from "../run/RunStore.ts";
import { stageAt } from "../run/RunFile.ts";
import { spendBasisOf, type SpendTurn } from "../budget/spendBasis.ts";

/** One turn's accounting — as much of an executor task as the cost line reads. */
export interface PhaseCostTurn {
  readonly costUsd: number;
  /** False ⇒ billed to a host session; `run.yml` records no dollars for it. */
  readonly metered?: boolean;
  readonly tokens?: number;
}

export interface PhaseCost {
  readonly usd: number;
  readonly note: string | null;
}

/** Local, as in every other module here (nine files define their own — measured). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 3: Rewire `build.ts`**

Delete `:3879-3983`, `:3985-4098`, `:4100-4280` and `:4288-4299`. Add to the import block
(after the existing `../../build/handoff.ts` import at `:100`):

```ts
import { readReviewLedger, type ReviewLedger } from "../../build/reviewLedger.ts";
import { phaseCostToDate } from "../../build/phaseCost.ts";
```

Add the re-export block at the END of `build.ts` (after `round2`), with the comment that says
why it exists:

```ts
// --- re-exports: the public surface does not move -------------------------
//
// Ten test files, `src/core/run/reopenStory.ts:54` and
// `src/core/facilitator/index.ts:34` import these FROM HERE. Wave 2 moves where
// they are defined and nothing else; a re-export is how "the same symbol, a
// different file" stays true for every caller.
export { readReviewLedger, phaseCostToDate };
export type { ReviewLedger };
```

Then delete the now-unused imports `DEVELOPER_FAILED`, `looksLikeReviewerError`, `stageAt`,
`spendBasisOf` and `SpendTurn` from `build.ts` **only if `typecheck` says they are unused** —
check, do not assume (`DEVELOPER_FAILED` is still used at `:2008` and `:3658`;
`looksLikeReviewerError` is not used elsewhere in `build.ts` — verify with
`grep -n "looksLikeReviewerError\|DEVELOPER_FAILED\|stageAt\|spendBasisOf\|SpendTurn" src/core/facilitator/executors/build.ts`).

- [ ] **Step 4: Prove the public surface is unchanged**

```bash
grep -rn "readReviewLedger\|phaseCostToDate\|ReviewLedger" src/core/run/reopenStory.ts src/core/facilitator/index.ts test/attempt-cost.test.ts test/fixlist.test.ts test/story-reopen.test.ts test/remaining-work.test.ts test/build-executor.test.ts
echo "importer grep exit: $?"
git diff --stat -- src/core/run/reopenStory.ts src/core/facilitator/index.ts test/
echo "collateral diff exit: $?"
```

Expected: every importer still spells `from ".../executors/build.ts"`, and
`git diff --stat` over `reopenStory.ts`, `facilitator/index.ts` and `test/` prints **nothing**.
A change to any of those files means the re-export is missing and a caller was patched instead
— that is a public-surface change, not a refactor.

- [ ] **Step 5: Run the named guard tests**

```bash
bun test test/build-golden.test.ts
echo "golden exit: $?"
bun test test/attempt-cost.test.ts test/fixlist.test.ts test/story-reopen.test.ts test/remaining-work.test.ts test/build-executor.test.ts test/dashboard-sources.test.ts
echo "guards exit: $?"
```

Expected: `golden exit: 0`, `guards exit: 0`.

`dashboard-sources.test.ts:608-628` is included and does NOT need retargeting: it asserts that
`src/core/dashboard/model.ts` does not CONTAIN the string `readReviewLedger`. The symbol name is
unchanged and `model.ts` is untouched, so the pin still pins the thing it was written for.
Running it is how that is measured rather than assumed.

**If `golden exit` is not 0: revert this task entirely.** `git checkout -- .` and re-read the
diff; a golden byte moved and that is a behaviour change.

- [ ] **Step 6: Run THE GATE**

Run the block from Global Constraints. Expected: every exit `0`, seam count `0`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(build): move the two pure readers to src/core/build/

`readReviewLedger` (the ledger every cross-process bound is read from) and
`phaseCostToDate` (the handoff's #138/#139 cost line) open a file and return a
record. Neither touches the session, and both were 300 lines of the executor's
tail.

build.ts re-exports both, so `src/core/run/reopenStory.ts:54`,
`src/core/facilitator/index.ts` and the five test files that import them see no
change — measured: `git diff --stat` over reopenStory.ts, facilitator/index.ts
and test/ is empty.

One signature widened, not narrowed: `phaseCostToDate`'s last parameter was
typed `readonly ExecutorTask[]`, and nothing under src/core/build/ may import
the executor's types. `PhaseCostTurn` is the structural subset the body already
reads (metered, costUsd, tokens), so `ExecutorTask[]` still assigns to it and
the call site at build.ts changed zero characters.

Behaviour: none. Guard, not proof — every test here passed before the change.
Golden guard green (prompts, event kinds + payload keys, run.yml rows, exit
codes byte-identical). Named guards green: attempt-cost, fixlist, story-reopen,
remaining-work, build-executor, dashboard-sources. Tests: <N before> -> <N after>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 2: `caps.ts` — the money constants and every ceiling

The spec's risk line for this step is exact: *"a transcribed divisor changes a ceiling."*
Transcribe nothing. Cut and paste every expression character for character, and let
`remaining-work.test.ts:142-155` — which cross-pins this arithmetic against
`src/core/budget/remainingWork.ts` — be the proof.

**Files:**
- Create: `src/core/build/caps.ts`
- Modify: `src/core/facilitator/executors/build.ts`

**Symbols moved, with their real line ranges at `c045f3f`:**

| Symbol | build.ts lines (doc + body) | New signature in `caps.ts` |
|---|---|---|
| `MAX_ATTEMPTS` | `:109-114` | `export const MAX_ATTEMPTS = 2;` |
| `REVIEWER_SHARE` | `:116-122` | `export const REVIEWER_SHARE = 0.25;` |
| `REVIEWER_FLOOR_USD` | `:124-137` | `export const REVIEWER_FLOOR_USD = 1.00;` |
| `developerPriceDivisor` | `:139-181` | `export function developerPriceDivisor(attempt: number): number;` |
| `DEFAULT_PARALLEL` | `:183-189` | `export const DEFAULT_PARALLEL = 1;` |
| `clampParallel` | `:191-201` | `export function clampParallel(requested: number \| undefined): number;` |
| `developerCap` | `:3316-3342` | `export function developerCap(parts: CapParts, storyId?: string, attempt?: number): number;` |
| `reviewerCap` | `:3344-3360` | `export function reviewerCap(parts: CapParts, spentUsd: number, storyId?: string): number;` |
| `priceOf` | `:3362-3371` | `export function priceOf(parts: CapParts, storyId: string \| undefined): number \| null;` |
| `priceScale` | `:3373-3388` | `export function priceScale(parts: CapParts): number;` |
| `shareOf` | `:3390-3393` | `export function shareOf(parts: CapParts, usd: number): number;` |
| `worstCaseShares` | `:3395-3402` | `export function worstCaseShares(parts: CapParts): number;` |

`SerialQueue` (`:203-223`) stays — spec §3 keeps it in `build.ts`. `spent()` (`:3404-3406`)
stays: it sums `this.tasks`, which is the orchestrator's ledger, and it is passed INTO
`reviewerCap` as `spentUsd`. `repoCommands` (`:3312-3314`) stays: it is a `workspace` lookup
with nothing to do with money — the spec's `:3312-3337` range is the doc-comment boundary of
`developerCap`, not a symbol boundary.

**Interfaces:**
- Consumes: `MAX_STORIES_PER_WAVE` from `src/core/schemas/planCommon.ts`.
- Produces:
  ```ts
  /** Everything a ceiling is derived from — the plan's prices and the stage's money. */
  export interface CapParts {
    /** `03-plan/budget.yml`'s per-story prices, as `BuildPlan.prices`. */
    readonly prices: ReadonlyMap<string, number>;
    /** `BuildPlan.storyCount`. */
    readonly storyCount: number;
    /** The stage ceiling as scaled into `run.yml` (`ctx.budgetUsd`). */
    readonly budgetUsd: number;
    /** `min(stage share, per_agent_max_usd, --max-usd)` (`ctx.maxBudgetUsd`). */
    readonly maxBudgetUsd: number;
    /** `ctx.agentCap` — the executor's own capper, passed, never re-implemented. */
    readonly agentCap: (share?: number) => number;
  }
  ```

- [ ] **Step 1: Create `src/core/build/caps.ts`**

```ts
/**
 * Every ceiling the Build phase hands a sub-agent, and the constants they are
 * derived from.
 *
 * One place, because the arithmetic here has a MIRROR: `budget/remainingWork.ts`
 * restates `MAX_ATTEMPTS`, `REVIEWER_SHARE`, `REVIEWER_FLOOR_USD` and
 * `developerPriceDivisor` on the budget-gate hook's hot path (so the hook does
 * not drag `spawnAgent` in), and `test/remaining-work.test.ts` pins the two
 * copies to each other. A ceiling derived twice in two files is how the brake and
 * the spend end up on different attempts.
 */
import { MAX_STORIES_PER_WAVE } from "../schemas/planCommon.ts";
```

Then paste `:109-201` verbatim (`MAX_ATTEMPTS` through `clampParallel`, with every docstring),
then the `CapParts` interface above, then `:3316-3402` verbatim with exactly these mechanical
substitutions and no others:

- `private developerCap(storyId?: string, attempt = 1): number {` →
  `export function developerCap(parts: CapParts, storyId?: string, attempt = 1): number {`
- `private reviewerCap(storyId?: string): number {` →
  `export function reviewerCap(parts: CapParts, spentUsd: number, storyId?: string): number {`
- `private priceOf(storyId: string | undefined): number | null {` →
  `export function priceOf(parts: CapParts, storyId: string | undefined): number | null {`
- `private priceScale(): number {` → `export function priceScale(parts: CapParts): number {`
- `private shareOf(usd: number): number {` →
  `export function shareOf(parts: CapParts, usd: number): number {`
- `private worstCaseShares(): number {` →
  `export function worstCaseShares(parts: CapParts): number {`
- inside those six bodies: `this.priceOf(` → `priceOf(parts, `, `this.shareOf(` →
  `shareOf(parts, `, `this.priceScale()` → `priceScale(parts)`, `this.worstCaseShares()` →
  `worstCaseShares(parts)`, `this.ctx.agentCap(` → `parts.agentCap(`, `this.ctx.budgetUsd` →
  `parts.budgetUsd`, `this.ctx.maxBudgetUsd` → `parts.maxBudgetUsd`, `this.plan.prices` →
  `parts.prices`, `this.plan.storyCount` → `parts.storyCount`, `this.spent()` → `spentUsd`
- add a local `round2` (the nine-file convention, same body as `build.ts:4349-4351`)

**The three arithmetic expressions that must survive character for character** — read them back
against `build.ts` before moving on:

```
developerPriceDivisor:  attempt <= 1 ? 1 + REVIEWER_SHARE : MAX_ATTEMPTS * (1 + REVIEWER_SHARE)
reviewerCap derived:    price === null
                          ? parts.agentCap(REVIEWER_SHARE / worstCaseShares(parts))
                          : parts.agentCap(shareOf(parts, price * REVIEWER_SHARE / (MAX_ATTEMPTS * (1 + REVIEWER_SHARE))))
worstCaseShares:        Math.max(parts.storyCount, 1) * MAX_ATTEMPTS * (1 + REVIEWER_SHARE)
```

- [ ] **Step 2: Rewire `build.ts`**

Delete `:109-201` and `:3316-3402`. Add a private accessor on `BuildSession` so the six call
sites read naturally and the parts are built in exactly one place:

```ts
  /** The plan's prices and this stage's money, for `build/caps.ts`. */
  private get capParts(): CapParts {
    return {
      prices: this.plan.prices,
      storyCount: this.plan.storyCount,
      budgetUsd: this.ctx.budgetUsd,
      maxBudgetUsd: this.ctx.maxBudgetUsd,
      agentCap: this.ctx.agentCap,
    };
  }
```

Rewrite the call sites, all of which are inside `BuildSession`:
`this.developerCap(id, attempt)` → `developerCap(this.capParts, id, attempt)` at `:708`,
`:1959`, `:3207`; `this.reviewerCap(id)` → `reviewerCap(this.capParts, this.spent(), id)` at
`:2112` and `:3521`. (Verified: `grep -n "this.developerCap(\|this.reviewerCap(" build.ts`
returns exactly those five lines.)

Add the imports and extend the re-export block:

```ts
import {
  clampParallel, developerCap, developerPriceDivisor, priceOf, reviewerCap,
  DEFAULT_PARALLEL, MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE,
  type CapParts,
} from "../../build/caps.ts";
```
```ts
export {
  clampParallel, developerPriceDivisor,
  DEFAULT_PARALLEL, MAX_ATTEMPTS, REVIEWER_FLOOR_USD, REVIEWER_SHARE,
};
```

`MAX_ATTEMPTS` and `REVIEWER_SHARE` are also in `src/core/facilitator/index.ts:34`'s
re-export from `./executors/build.ts` — that line does not change, because the re-export above
keeps them exported from `build.ts`.

- [ ] **Step 3: Prove the arithmetic did not move**

```bash
bun test test/money-safety.test.ts test/build-parallel.test.ts test/remaining-work.test.ts
echo "money guards exit: $?"
```

Expected: `money guards exit: 0`. These three are the cross-pins: `money-safety` imports
`MAX_ATTEMPTS`, `REVIEWER_FLOOR_USD`, `REVIEWER_SHARE`, `developerPriceDivisor` from
`build.ts` (`:25-27`); `build-parallel` imports `clampParallel`, `DEFAULT_PARALLEL`,
`REVIEWER_FLOOR_USD` (`:24`); `remaining-work` (`:26-32`, `:142-155`) asserts each constant and
the whole divisor SCHEDULE equals `budget/remainingWork.ts`'s restatement.

- [ ] **Step 4: Run the golden**

```bash
bun test test/build-golden.test.ts
echo "golden exit: $?"
```

Expected: `golden exit: 0`. A wrong divisor changes the developer's `$X.XX ceiling` in the
prepared lines and the `max_budget_usd` in the reviewer's `agent.spawned` payload — the golden
sees the second directly. **Not 0 ⇒ revert the whole task.**

- [ ] **Step 5: Run THE GATE**

Run the block from Global Constraints. Expected: every exit `0`, seam count `0`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(build): move the money constants and every ceiling to build/caps.ts

MAX_ATTEMPTS, REVIEWER_SHARE, REVIEWER_FLOOR_USD, DEFAULT_PARALLEL,
developerPriceDivisor, clampParallel and the six cap derivations
(developerCap, reviewerCap, priceOf, priceScale, shareOf, worstCaseShares)
are arithmetic over the plan's prices and the stage's money. They took a
`CapParts` record instead of the session: prices, storyCount, budgetUsd,
maxBudgetUsd and ctx.agentCap, which is PASSED and never re-implemented.
`spent()` stays in the executor and is passed to reviewerCap as spentUsd —
the ledger it sums is the orchestrator's.

Every expression was cut and pasted, never retyped: the risk this step
carries is one transcribed divisor moving a ceiling. remaining-work.test.ts
is the instrument — it pins all four constants AND the whole per-attempt
divisor schedule against budget/remainingWork.ts's restatement, which exists
so the budget-gate hook need not drag spawnAgent in.

Behaviour: none. Guard, not proof. Named guards green: money-safety,
build-parallel, remaining-work. Golden guard green — a wrong divisor would
have moved the reviewer's `max_budget_usd` in agent.spawned, which the golden
reads directly. Tests: <N before> -> <N after>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 3: `dodRunner.ts` + `PreflightCache`

The spec's risk line: *"lazy-once preflight becoming per-call (a resumed run re-pays)."*
`basePreflight()` (`:3027-3034`) loads from disk on FIRST call and caches for the process; a
`PreflightCache` that reloads per call makes a resumed run re-run a `dotnet test`. Step 4 below
pins that with a counting test.

**Files:**
- Create: `src/core/build/dodRunner.ts`
- Modify: `src/core/build/outcome.ts` (add the `BuildRefusal` type — additive)
- Modify: `src/core/facilitator/executors/build.ts`

**Symbols moved, with their real line ranges at `c045f3f`:**

| Symbol | build.ts lines (doc + body) | New home |
|---|---|---|
| `runDod` | `:2020-2065` | `runStoryDod` in `dodRunner.ts` |
| `refuseOnRedBase` | `:2921-2977` | `redBaseRefusal` in `dodRunner.ts` |
| `baseResult` | `:2979-3025` | `baseResultOf` in `dodRunner.ts` |
| `basePreflight` + the `preflight`/`preflightLoaded` fields (`:578-585`) | `:3027-3034` | `PreflightCache.read()` |
| `rememberBase` | `:3036-3054` | `PreflightCache.remember()` |

**Deviation from the spec's table, declared:** the spec gives step 3 the range `:3312-3337`.
Measured, that is `repoCommands` (`:3312-3314`, a `workspace.repoCommands` lookup) plus
`developerCap`'s doc comment (`:3316-3337`) — a doc-boundary artifact, not a symbol. The cap
went to `caps.ts` with its own function in Task 2; `repoCommands` stays in `build.ts`. Step 3
therefore ends at `:3054`. `refuseOnDirtyRepos` (`:3056-3101`, inside the spec's `:2951-3067`
range) belongs to Task 4's `branchClaims.ts` — it is also inside Task 4's `:2767-3102` range,
and it is a TREE refusal, not a DoD one.

**Interfaces:**
- Consumes: `DodCommandRefused`, `runDodCommand` from `src/hooks/lib/story.ts`;
  `BaseGateFailure`, `baseRefusalLines`, `baseResultFor`, `commandHash`, `EMPTY_PREFLIGHT`,
  `loadPreflight`, `PREFLIGHT_REL`, `savePreflight`, `withResult`, `BaseCommandResult`,
  `BasePreflight` from `src/core/build/preflight.ts`; `repoDirOf`, `shaOf` from
  `src/core/build/git.ts`; `FALLBACK_DEFAULT_BRANCH`, `WorkspaceContext` from
  `src/hooks/lib/workspace.ts`; `DodResult` from `src/core/build/outcome.ts`.
- Produces:
  ```ts
  // src/core/build/outcome.ts (additive)
  /**
   * A refusal a Build step raises, as DATA: the operator lines and the one-line
   * `stage.error`. `src/core/build/` never builds an `ExecutorOutcome` — the
   * executor owns the shape of what it returns, and a refusal that could be
   * assembled in two places would be two refusals.
   */
  export interface BuildRefusal {
    readonly lines: readonly string[];
    readonly error: string;
  }

  // src/core/build/dodRunner.ts
  /**
   * The run's base-tree measurements, loaded LAZILY and ONCE per process.
   * Lazily: a run that entered Build before `04-build/preflight.yml` existed must
   * not error on its absence. Once: a resumed run must not re-pay for a
   * `dotnet test` it already measured.
   */
  export class PreflightCache {
    constructor(runDir: string);
    read(): BasePreflight;
    /** Writes one measurement through; returns an advisory line, or null. */
    remember(result: BaseCommandResult, at: string): string | null;
    /** Disk reads so far — for the test that pins "once", and nothing else. */
    readonly loads: number;
  }

  export interface BaseParts {
    readonly runDir: string;
    readonly workspace: WorkspaceContext;
    readonly cache: PreflightCache;
    readonly at: string;
    readonly preparing: boolean;
    readonly timeoutMs: number;
    /** The executor's single writer — passed, never duplicated. */
    readonly write: <T>(work: () => Promise<T> | T) => Promise<T>;
    /** stderr sink, append-only, owned by the executor. */
    readonly advisories: string[];
  }

  export function baseResultOf(
    parts: BaseParts, repo: string, command: string,
  ): Promise<BaseCommandResult | null>;

  export function redBaseRefusal(
    parts: BaseParts, stories: readonly PlannedStory[],
  ): Promise<BuildRefusal | null>;

  export interface DodParts {
    readonly storyId: string;
    readonly repo: string;
    readonly worktree: string;
    readonly commands: readonly string[];
    readonly workspaceCommands: ReadonlySet<string>;
    readonly timeoutMs: number;
    readonly phaseId: string;
    readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
    readonly baseResult: (repo: string, command: string) => Promise<BaseCommandResult | null>;
  }

  export function runStoryDod(parts: DodParts): Promise<readonly DodResult[]>;
  ```

`emit` and `baseResult` are passed as callbacks rather than reached through `ctx` — that is
the spec's "data in" rule spelled for a function that must write events. `write` is the
executor's `SerialQueue.run`, passed and never duplicated (spec decision 3).

- [ ] **Step 1: Add `BuildRefusal` to `src/core/build/outcome.ts`**

Append the interface above at the end of the file, with its docstring. No other change to that
file.

- [ ] **Step 2: Create `src/core/build/dodRunner.ts`**

Module docstring:

```ts
/**
 * A story's ```dod block, and the base-tree pre-flight that decides whether a red
 * command is the STORY's fault (issue #41).
 *
 * A DoD is a delta gate — "this story did not break the tree" — so a command that
 * is already red on main makes every story in the plan block for something no
 * story caused. Measured on `260829-scoring-leaderboard`: two of three declared
 * commands were red on pristine main, so all 15 stories would have blocked
 * identically, each having spent a developer turn.
 *
 * `PreflightCache` is the "once per run" half of that: every base result is
 * written to `04-build/preflight.yml` and read back by the next invocation, and
 * within a process the file is opened at most once. A cache that reloaded per
 * call would make a resumed run re-pay for a `dotnet test`.
 */
```

Then move `:2020-2065`, `:2921-3054` verbatim with these mechanical substitutions and no
others:

- `private async runDod(story: StoryContext): Promise<readonly DodResult[]> {` →
  `export async function runStoryDod(parts: DodParts): Promise<readonly DodResult[]> {`;
  inside: `this.ctx.spec.planned.timeout_s * 1000` → `parts.timeoutMs`,
  `story.planned.dod.commands` → `parts.commands`, `story.worktree` → `parts.worktree`,
  `this.workspace.commands` → `parts.workspaceCommands`, `this.ctx.emit(` → `parts.emit(`,
  `this.ctx.phaseId` → `parts.phaseId`, `story.planned.story.id` → `parts.storyId`,
  `this.baseResult(story.planned.story.repo, command)` → `parts.baseResult(parts.repo, command)`
- `private async refuseOnRedBase(): Promise<ExecutorOutcome | null> {` →
  `export async function redBaseRefusal(parts: BaseParts, stories: readonly PlannedStory[]): Promise<BuildRefusal | null> {`;
  inside: `this.pendingStories()` → `stories`, `this.baseResult(` → `baseResultOf(parts, `, and
  the returned object becomes `{ lines: [...baseRefusalLines(failures)], error: … }` — the
  `ok/refused/awaiting/tasks/costUsd/outputs` fields move to the `build.ts` wrapper, and the
  `lines` and `error` expressions are pasted unchanged.
- `private async baseResult(repo: string, command: string)` →
  `export async function baseResultOf(parts: BaseParts, repo: string, command: string)`;
  inside: `this.workspace` → `parts.workspace`, `this.basePreflight()` → `parts.cache.read()`,
  `this.ctx.at` → `parts.at`, `this.ctx.mode === "prepare"` → `parts.preparing`,
  `this.ctx.spec.planned.timeout_s * 1000` → `parts.timeoutMs`,
  `await this.writes.run(() => this.rememberBase(measured))` →
  ```ts
      await parts.write(() => {
        const advisory = parts.cache.remember(measured, parts.at);
        if (advisory !== null) parts.advisories.push(advisory);
      });
  ```
- `basePreflight` + `rememberBase` become `PreflightCache`, with `:3027-3034`'s and
  `:3036-3054`'s docstrings moved onto the two methods:
  ```ts
  export class PreflightCache {
    private preflight: BasePreflight | null = null;
    private loaded = false;
    /** Disk reads so far — read by ONE test, to pin "once". */
    loads = 0;

    constructor(private readonly runDir: string) {}

    read(): BasePreflight {
      if (!this.loaded) {
        this.preflight = loadPreflight(this.runDir);
        this.loaded = true;
        this.loads++;
      }
      return this.preflight ?? EMPTY_PREFLIGHT;
    }

    remember(result: BaseCommandResult, at: string): string | null {
      const next = withResult(this.read(), result, at);
      this.preflight = next;
      this.loaded = true;
      try {
        savePreflight(this.runDir, next);
        return null;
      } catch (error) {
        return `could not write ${PREFLIGHT_REL}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  ```

- [ ] **Step 3: Rewire `build.ts`**

Delete `:2020-2065`, `:2921-3054` and the two fields at `:578-585`
(`preflight` / `preflightLoaded`, with their docstring). Add a field
`private readonly preflight = new PreflightCache(ctx.runDir);` — assigned in the constructor,
since `ctx` is a constructor parameter property.

Add a private accessor so `BaseParts` is built once:

```ts
  /** What `build/dodRunner.ts` needs to measure or recall the base tree. */
  private get baseParts(): BaseParts {
    return {
      runDir: this.ctx.runDir,
      workspace: this.workspace,
      cache: this.preflight,
      at: this.ctx.at,
      preparing: this.ctx.mode === "prepare",
      timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
      write: (work) => this.writes.run(work),
      advisories: this.advisories,
    };
  }
```

Rewrite the call sites:
- `:2058` `const base = await this.baseResult(story.planned.story.repo, command);` — now inside
  `runStoryDod`, supplied by the `baseResult` callback below.
- `:2021` — `runDod` is replaced by a thin method that builds `DodParts`:
  ```ts
    /** (e) the story's ```dod block, in the worktree, via the gate's own runner. */
    private async runDod(story: StoryContext): Promise<readonly DodResult[]> {
      return await runStoryDod({
        storyId: story.planned.story.id,
        repo: story.planned.story.repo,
        worktree: story.worktree,
        commands: story.planned.dod.commands,
        workspaceCommands: this.workspace.commands,
        timeoutMs: this.ctx.spec.planned.timeout_s * 1000,
        phaseId: this.ctx.phaseId,
        emit: (type, payload) => { this.ctx.emit(type, payload); },
        baseResult: (repo, command) => baseResultOf(this.baseParts, repo, command),
      });
    }
  ```
- `:2951` `refuseOnRedBase` becomes the wrapper that turns a `BuildRefusal` into an
  `ExecutorOutcome`, keeping the exact field set the old body returned:
  ```ts
    private async refuseOnRedBase(): Promise<ExecutorOutcome | null> {
      const refusal = await redBaseRefusal(this.baseParts, this.pendingStories());
      return refusal === null ? null : {
        ok: false, refused: true, awaiting: false, tasks: [], costUsd: 0, outputs: [],
        lines: refusal.lines, error: refusal.error,
      };
    }
  ```

Add the import and extend the re-export block:

```ts
import {
  baseResultOf, PreflightCache, redBaseRefusal, runStoryDod,
  type BaseParts, type DodParts,
} from "../../build/dodRunner.ts";
```
```ts
export { PreflightCache, runStoryDod };
```

- [ ] **Step 4: Write the ONE new assertion this task needs — "loaded once"**

The spec names the risk; a risk with no instrument is an assumption. Add to
`test/dod-preflight.test.ts` (or create the `describe` at the end of it if the file has no
natural home) a test that reads the counter:

```ts
describe("the base pre-flight is read from disk once per process", () => {
  /**
   * `basePreflight()` was lazy AND memoised: first call loads
   * `04-build/preflight.yml`, every later one reads memory. A `PreflightCache`
   * that reloaded per call would make a resumed run re-pay for the exact command
   * the file exists to remember — a `dotnet test` charged twice, silently. The
   * counter is on the class for this test and for nothing else.
   */
  test("ten reads and a write are one disk load", () => {
    const dir = mkdtempSync(join(tmpdir(), "tldrx-preflight-"));
    const cache = new PreflightCache(dir);
    for (let i = 0; i < 10; i++) cache.read();
    cache.remember({
      repo: "app", command: "npm run test", baseRef: "main", baseSha: "abc1234",
      exitCode: 0, timedOut: false, tail: "", status: "ok",
      commandHash: commandHash("npm run test", ["npm run test"]),
    }, "2026-08-29T09:00:00Z");
    cache.read();
    expect(cache.loads).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 5: Prove the new test can fail**

Temporarily change `PreflightCache.read()` to drop the `if (!this.loaded)` guard (load every
call), then:

```bash
bun test test/dod-preflight.test.ts
echo "mutated exit: $?"
```

Expected: `mutated exit: 1`, with `expect(cache.loads).toBe(1)` receiving `12`. **Keep this
output verbatim for the commit body**, then restore the guard and re-run:

```bash
bun test test/dod-preflight.test.ts
echo "restored exit: $?"
```

Expected: `restored exit: 0`.

- [ ] **Step 6: Retarget the `dod-allowlist` source pins IF they moved**

`test/dod-allowlist.test.ts:127-146` reads `build.ts` as TEXT for four things:
`tools: REVIEWER_TOOLS` + `yolo: false`, `export const REVIEWER_TOOLS: readonly string[] = [...]`,
`tools: developerTools(commands` + `yolo: this.ctx.yolo`, and
`source.split("yolo: this.ctx.yolo").length - 1 === 1`.

Measured: none of the four moves in THIS task. `spawnReviewer` (`:2100-2181`) is Task 5;
`spawnDeveloper` (`:1951-2018`) never moves. Confirm rather than assume:

```bash
grep -n "tools: REVIEWER_TOOLS\|tools: developerTools(commands\|yolo: this.ctx.yolo\|export const REVIEWER_TOOLS" src/core/facilitator/executors/build.ts
echo "pin grep exit: $?"
bun test test/dod-allowlist.test.ts
echo "dod-allowlist exit: $?"
```

Expected: all four still in `build.ts`, `pin grep exit: 0`, `dod-allowlist exit: 0`.

- [ ] **Step 7: Run the named guards and the golden**

```bash
bun test test/dod-preflight.test.ts test/dod-allowlist.test.ts test/build-executor.test.ts
echo "guards exit: $?"
bun test test/build-golden.test.ts
echo "golden exit: $?"
```

Expected: both `0`. **`golden exit` not 0 ⇒ revert the whole task.**

- [ ] **Step 8: Run THE GATE**

Run the block from Global Constraints. Expected: every exit `0`, seam count `0`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(build): move the DoD runner and the base pre-flight to build/dodRunner.ts

runDod, refuseOnRedBase, baseResult, basePreflight and rememberBase are one
subject — issue #41's "is this red command the STORY's fault or the tree's" —
and they carried the session's only two mutable non-map fields
(`preflight`/`preflightLoaded`). Those become a `PreflightCache` the executor
owns and passes.

The lazy-ONCE semantics are the risk this step carries, so they got the one new
assertion in wave 2's move steps: `cache.loads` is 1 after ten reads and a
write. A cache that reloaded per call would make a resumed run re-pay for the
exact `dotnet test` the file exists to remember.

RED first, verbatim (the guard removed from PreflightCache.read):
<paste the Step 5 mutated output here>

`src/core/build/` never builds an `ExecutorOutcome`: `redBaseRefusal` returns a
`BuildRefusal` (lines + error, added to build/outcome.ts) and the executor's
`refuseOnRedBase` wraps it, keeping the exact field set it always returned. The
SerialQueue is passed as `write`, never duplicated; `advisories` is passed as
the append-only array it already is.

Behaviour: none. Guards green: dod-preflight, dod-allowlist (its four source-text
pins on `tools: REVIEWER_TOOLS`, `yolo: false`, `tools: developerTools(commands`
and the single `yolo: this.ctx.yolo` all still land in build.ts — grepped, not
assumed), build-executor. Golden guard green. Tests: <N before> -> <N after>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 4: `worktrees.ts` + `branchClaims.ts` + `EpicState`

The spec calls this the highest-risk step: *"a dropped `claimedEpics` entry (read by
`withClaims` on every exit) or lost `writes` ordering."* Two rules for this task:

1. **`claimedEpics` stays a field of `BuildSession`.** `buildExecutor`'s `withClaims` closure
   (`:322-334`) reads `session.claimedEpics` on EVERY exit path including the failure ones.
   `EpicState` owns it and `BuildSession` exposes `get claimedEpics() { return this.epics.claimed }`
   so the closure is untouched — verify with `git diff` that `:301-360` did not change.
2. **Nothing gains or loses a `this.writes.run(...)` wrapper.** The three call sites that have
   one today (`:1044`-region `buildHalf` at `:1163`/`:1180`/`:1215`, `rereview` at `:1675`,
   `rescueUncommitted`'s own internal `this.writes.run` at `:3796`) keep it exactly where it is.

**Files:**
- Create: `src/core/build/worktrees.ts`
- Create: `src/core/build/branchClaims.ts`
- Modify: `src/core/facilitator/executors/build.ts`

**Symbols moved to `worktrees.ts`, real line ranges at `c045f3f`:**

| Symbol | build.ts lines (doc + body) | New signature |
|---|---|---|
| `refreshStoryBase` | `:1818-1920` | `refreshStoryBase(parts: RefreshParts): Promise<void>` |
| `unreadableTouches` | `:1922-1949` | `unreadableTouches(parts: TouchParts): Promise<ReadonlySet<string>>` |
| `commitIfDirty` | `:2067-2087` | `commitIfDirty(parts: CommitParts): Promise<string \| null>` |
| `mergeIntoEpic` | `:2089-2098` | `mergeIntoEpic(state, parts): Promise<MergeOutcome>` |
| `storyWorktree` | `:3705-3717` | `storyWorktreePath(root, repo, runId, storyId): string` |
| `openEpicWorktree` | `:3719-3761` | `openEpicWorktree(state, parts): Promise<string>` |
| `rescueUncommitted` | `:3763-3831` | `rescueUncommitted(parts): Promise<RescuedWork \| null>` |
| `noteMerged` | `:3168-3179` | `EpicState.noteMerged(epicBranch, storyId, carried)` |
| `mergesOnto` | `:2795-2822` | `EpicState.mergesOnto(branch, outcomes)` |
| the `epicWorktrees` / `merged` / `claimedEpics` fields | `:524-530`, `:559-560` | `EpicState` |

**Symbols moved to `branchClaims.ts`:**

| Symbol | build.ts lines (doc + body) | New signature |
|---|---|---|
| `refuseOnForeignEpic` | `:2826-2873` | `foreignEpicRefusal(state, parts, stories): Promise<BuildRefusal \| null>` |
| `claimedBranchesOnFile` | `:2875-2878` | folded into `buildOnFile` |
| `buildOnFile` | `:2880-2887` | `buildOnFile(runDir): { epic_branch; branch_model? }` |
| `resolveBranchModel` | `:2889-2919` | `resolveBranchModel(runDir, runId, stories): BranchModel` |
| `refuseOnDirtyRepos` | `:3056-3101` | `dirtyRepoRefusal(parts, stories): Promise<{ refusal; ignored }>` |
| `epicRows` | `:2767-2793` | `epicRows(state, parts, outcomes): readonly EpicSummaryRow[]` |

**Deviation from the spec's table, declared:** the spec's step-4 range `:1850-1932` cuts at
`unreadableTouches`'s BODY start; the real symbol pair is `:1818-1949`. Its `:2767-3102` range
overlaps Task 3's `:2951-3067`; the overlap is `refuseOnRedBase`/`baseResult`/`basePreflight`/
`rememberBase` (`:2921-3054`), which went to `dodRunner.ts` in Task 3, so Task 4's share of that
span is `:2767-2919` plus `refuseOnDirtyRepos` at `:3056-3101`.

**Interfaces:**
- Consumes: `BuildRefusal` from Task 3; `addWorktree`, `assertWorktreeOn`, `baseStateOf`,
  `branchExists`, `commitAll`, `currentBranch`, `dirtyPaths`, `fastForward`, `firstLine`,
  `headSha`, `isDirty`, `mergeNoFf`, `partitionDirty`, `pathAtRef`, `repoDirOf`,
  `stateDirPrefixes` from `src/core/build/git.ts`; `branchModelFor`, `branchModelOfKind`,
  `detectEpicChain`, `epicBranchOf`, `epicWorktreeSlotOf`, `BranchModel`, `BranchModelKind`
  from `src/core/plan/branchModel.ts`; `PROJECT_FRAMEWORK_DIR`, `epicWorktreeName` from
  `src/core/paths.ts`; `WORKTREES` from `src/core/build/plan.ts`; `RunStore`;
  `EpicSummaryRow` from `src/core/build/handoff.ts`.
- Produces:
  ```ts
  // src/core/build/worktrees.ts
  /**
   * The epic-side state one Build invocation accumulates: which epic branches it
   * cut or adopted, which worktree each epic is checked out in, and what each
   * merge CARRIED. Owned by the executor and passed in; every field was a private
   * map on the session.
   */
  export class EpicState {
    /** Epic branches this run cut or adopted; `runNext` writes them to run.yml. */
    readonly claimed: Set<string>;
    /** Per epic branch, the stories merged into it and what each merge carried. */
    noteMerged(epicBranch: string, storyId: string, carried: number | null): void;
    mergesOnto(
      branch: string,
      outcomes: readonly StoryOutcome[],
    ): readonly { id: string; carried: number | null }[];
    /** `repo:branch` -> the epic worktree this process opened for it. */
    worktreeFor(key: string): string | undefined;
    rememberWorktree(key: string, path: string): void;
  }

  export function storyWorktreePath(
    root: string, repo: string, runId: string, storyId: string,
  ): string;

  export interface RefreshParts {
    readonly storyId: string;
    readonly root: string;
    readonly workspaceRoot: string;
    readonly repoDir: string;
    readonly worktree: string;
    readonly branch: string;
    readonly epicBranch: string;
    readonly repo: string;
    readonly phaseId: string;
    readonly lines: string[];
    readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
  }
  export function refreshStoryBase(parts: RefreshParts): Promise<void>;

  export interface TouchParts {
    readonly repoDir: string;
    readonly branch: string;
    readonly touches: readonly string[];
    readonly advisories: string[];
  }
  export function unreadableTouches(parts: TouchParts): Promise<ReadonlySet<string>>;

  export interface CommitParts {
    readonly storyId: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly repoDir: string;
    readonly worktree: string;
    readonly lines: string[];
  }
  export function commitIfDirty(parts: CommitParts): Promise<string | null>;

  export interface EpicWorktreeParts {
    readonly root: string;
    readonly runId: string;
    readonly repo: string;
    readonly repoDir: string;
    readonly epicId: string;
    readonly epicBranch: string;
    readonly branchModel: BranchModel;
    readonly defaultBranch: string;
  }
  export function openEpicWorktree(
    state: EpicState, parts: EpicWorktreeParts,
  ): Promise<string>;

  export function mergeIntoEpic(
    state: EpicState,
    parts: EpicWorktreeParts & { readonly storyBranch: string; readonly storyId: string; readonly storyTitle: string },
  ): Promise<{ ok: boolean; conflicts: readonly string[]; detail: string }>;

  export interface RescueParts {
    readonly storyId: string;
    readonly repo: string;
    readonly workspaceRoot: string;
    readonly repoDir: string;
    readonly worktree: string;
    readonly branch: string;
    readonly phaseId: string;
    readonly status: PlanStatus;
    readonly reason: string | null;
    readonly lines: string[];
    readonly emit: (type: EventType, payload: Record<string, unknown>) => void;
    readonly write: <T>(work: () => Promise<T> | T) => Promise<T>;
  }
  export function rescueUncommitted(parts: RescueParts): Promise<RescuedWork | null>;

  // src/core/build/branchClaims.ts
  export function buildOnFile(
    runDir: string,
  ): { epic_branch: readonly string[]; branch_model?: BranchModelKind };

  export function resolveBranchModel(
    runDir: string,
    runId: string,
    stories: ReadonlyMap<string, PlannedStory>,
  ): BranchModel;

  export interface ClaimParts {
    readonly runId: string;
    readonly runDir: string;
    readonly root: string;
    readonly workspace: WorkspaceContext;
    readonly epics: ReadonlyMap<string, PlannedEpic>;
    readonly branchModel: BranchModel;
    readonly reuseEpic: boolean;
    readonly lines: string[];
  }
  export function foreignEpicRefusal(
    state: EpicState, parts: ClaimParts, stories: readonly PlannedStory[],
  ): Promise<BuildRefusal | null>;

  export function dirtyRepoRefusal(
    parts: Pick<ClaimParts, "root" | "workspace">, stories: readonly PlannedStory[],
  ): Promise<{ readonly refusal: BuildRefusal | null; readonly ignored: number }>;

  export function epicRows(
    state: EpicState,
    parts: Pick<ClaimParts, "workspace" | "epics" | "branchModel"> & {
      readonly stories: ReadonlyMap<string, PlannedStory>;
    },
    outcomes: readonly StoryOutcome[],
  ): readonly EpicSummaryRow[];
  ```

- [ ] **Step 1: Create `src/core/build/worktrees.ts`**

Module docstring:

```ts
/**
 * The git side of a Build story: its worktree, its epic's worktree, the base
 * refresh before a dispatch, the commit of whatever the agent left behind, the
 * merge onto the epic, and the rescue of work that reached no ref (#129).
 *
 * Every path here carries the RUN ID, in the branch name and in the directory
 * name both. Measured 2026-08-29: four runs of one plan all cut `story/S1`, and
 * the fourth reused the third's LIVE epic worktree, so `git merge --no-ff` ran
 * inside a checkout of another run's epic branch while every rendered line named
 * the branch it thought it was on (issue #40).
 *
 * `EpicState` is the per-invocation memory that used to be three private maps on
 * `BuildSession`. It is owned by the executor and passed in, because
 * `buildExecutor`'s `withClaims` reads `claimed` on EVERY exit — including the
 * failure paths. A run that cut `epic/x` and then fell over still cut it.
 */
```

Move each symbol verbatim with the mechanical `this.X` → `parts.X` substitutions the signatures
above imply. The two docstrings that must survive word for word are `:1818-1849`
(`refreshStoryBase`'s three shapes, and "**Never a rebase**") and `:3763-3784`
(`rescueUncommitted`'s "the framework never deletes a worktree holding changes that reached no
ref").

- [ ] **Step 2: Create `src/core/build/branchClaims.ts`**

```ts
/**
 * Which epic branch this run owns, and the two refusals that protect the tree it
 * is cut from.
 *
 * An epic branch deliberately does NOT carry the run id — an epic is the unit a
 * team merges, and `epic/260829-x-leaderboard` would be a worse name for it. So
 * collision is not made impossible, it is made DELIBERATE: a branch this run's
 * `build.epic_branch` does not claim is refused, and `--reuse-epic` is the word
 * that says "yes, stack on it". Measured 2026-08-29: four runs piled onto one
 * `epic/leaderboard` with nothing said.
 */
```

`refuseOnForeignEpic` and `refuseOnDirtyRepos` return `BuildRefusal | null` (their whole
`lines`/`error` expressions pasted unchanged); the `ok/refused/awaiting/tasks/costUsd/outputs`
fields go to the `build.ts` wrappers. `dirtyRepoRefusal` also returns `ignored`, because the
old body pushed `· ignoring N tldrx state file(s)…` onto `this.lines` AFTER the loop
(`:3097-3099`) — returning the count and letting `build.ts` push the line keeps that line in
the same place in `lines` for the same input.

- [ ] **Step 3: Rewire `build.ts`**

Delete `:1818-1949`, `:2067-2098`, `:2767-2822`, `:2826-2919`, `:3056-3101`, `:3168-3179`,
`:3705-3831` and the three field declarations at `:524-530` and `:559-560`. Add
`private readonly epics = new EpicState();` and:

```ts
  /** `buildExecutor`'s `withClaims` reads this on every exit path — including failures. */
  get claimedEpics(): ReadonlySet<string> {
    return this.epics.claimed;
  }
```

Keep every wrapper method (`refuseOnForeignEpic`, `refuseOnDirtyRepos`, `noteMerged`,
`storyWorktree`, `mergeIntoEpic`, `commitIfDirty`, `openEpicWorktree`, `rescueUncommitted`,
`refreshStoryBase`, `unreadableTouches`, `epicRows`) as one-to-five-line methods that build the
parts record and delegate. That is what keeps the ~50 call sites in `openStory`, `settle`,
`settleHalf` and `writeHandoff` byte-identical.

`resolveBranchModel` is called from the CONSTRUCTOR (`:597`); it becomes
`this.branchModel = resolveBranchModel(ctx.runDir, ctx.runId, plan.stories);`.

Add the imports and extend the re-export block:

```ts
import {
  commitIfDirty, EpicState, mergeIntoEpic, openEpicWorktree, refreshStoryBase,
  rescueUncommitted, storyWorktreePath, unreadableTouches,
} from "../../build/worktrees.ts";
import {
  buildOnFile, dirtyRepoRefusal, epicRows, foreignEpicRefusal, resolveBranchModel,
} from "../../build/branchClaims.ts";
```
```ts
export { EpicState, storyWorktreePath, resolveBranchModel };
```

- [ ] **Step 4: Prove `withClaims` did not change**

```bash
git diff -- src/core/facilitator/executors/build.ts | grep -n "^[-+].*claimedEpics\|^[-+].*withClaims\|^[-+].*branchModel:"
echo "withClaims diff grep exit: $?"
```

Expected: the ONLY `-`/`+` lines mentioning `claimedEpics` are the field declaration moving to
the `get claimedEpics()` accessor and `this.claimedEpics.add(` → `this.epics.claimed.add(`
inside `openStory` (`:1790`) and `foreignEpicRefusal`. **`buildExecutor` (`:301-360`) itself
must show zero changed lines** — check with
`git diff -U0 -- src/core/facilitator/executors/build.ts | grep -c "^@@ .*@@"` and read each hunk
header: none may fall inside 301–360.

- [ ] **Step 5: Prove the `story/${` pin is not weakened**

`test/build-executor.test.ts:1569-1571` asserts `build.ts` never contains the literal
`` `story/${ `` — story branch names come from `storyBranchOf` and nowhere else (#134). That is a
NEGATIVE assertion, and moving code out of a file can only weaken it. Retarget it in this task
to cover the new files, with the reason in the test:

```ts
  test("no story branch name is assembled inline — `storyBranchOf` is the one derivation", () => {
    // Wave 2 moved the worktree and branch-claim mechanics out of build.ts. A
    // negative pin on ONE file gets weaker every time code leaves it, so it now
    // reads every file that could contain such a template.
    for (const rel of [
      "src/core/facilitator/executors/build.ts",
      "src/core/build/worktrees.ts",
      "src/core/build/branchClaims.ts",
    ]) {
      expect([rel, readFileSync(join(FRAMEWORK_ROOT, rel), "utf8")])
        .not.toMatch(/`story\/\$\{/);
    }
  });
```

Prove the retargeted pin can still fail: temporarily add `` const x = `story/${1}`; `` to
`src/core/build/worktrees.ts`, run the test, keep the RED output verbatim, remove the line, re-run
green.

- [ ] **Step 6: Run the named guards and the golden**

```bash
bun test test/epic-chain-branch.test.ts test/story-base.test.ts test/recorded-default-branch.test.ts test/boundary.test.ts test/build-executor.test.ts
echo "guards exit: $?"
bun test test/build-golden.test.ts
echo "golden exit: $?"
```

Expected: both `0`. `build-executor.test.ts:1523,1601,1607` are the epic-claim cases the spec
names. **`golden exit` not 0 ⇒ revert the whole task.**

If any of the five named files does not exist under that exact name, find it before assuming it
is gone: `ls test | grep -i "epic\|story-base\|recorded\|boundary"`. A guard you could not run is
a guard you did not run — say which, in the commit body.

- [ ] **Step 7: Run THE GATE**

Run the block from Global Constraints. Expected: every exit `0`, seam count `0`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(build): move worktrees and epic-branch claims out of the executor

build/worktrees.ts takes the git side of a story — its worktree, its epic's
worktree, the pre-dispatch base refresh (§F.2), the commit of whatever the agent
left behind, the merge onto the epic, and the #129 rescue of work that reached no
ref. build/branchClaims.ts takes the epic claim, the branch model, the two tree
refusals and the handoff's epic rows.

The three private maps become an `EpicState` the executor owns and passes. The
one thing that could not move is `claimedEpics`: `buildExecutor`'s `withClaims`
closure reads it on EVERY exit including the failure paths — a run that cut
`epic/x` and then fell over still cut it — so `BuildSession` exposes it as an
accessor and buildExecutor's 60 lines are byte-identical (measured: no diff hunk
falls inside :301-360).

No call site gained or lost a `writes.run(...)` wrapper. The single writer is
PASSED into `rescueUncommitted` as `write`, never duplicated.

`refuseOnForeignEpic` and `refuseOnDirtyRepos` return `BuildRefusal` and the
executor wraps them, keeping the exact field set and — for the dirty-tree case —
the `ignoring N tldrx state file(s)` line in the same position in `lines`, which
is why the count comes back rather than the line.

Deviation, declared: the spec's `:1850-1932` cuts `unreadableTouches` at its body
rather than its doc (the real pair is `:1818-1949`), and its `:2767-3102`
overlaps step 3's `:2951-3067`; that overlap went to dodRunner.ts, so this step's
share is `:2767-2919` + `:3056-3101`.

Retargeted pin: build-executor.test.ts's "no `story/${` template" is a NEGATIVE
assertion, and moving code out of a file can only weaken it — it now reads
build.ts, worktrees.ts and branchClaims.ts. Proved it still fails:
<paste the Step 5 mutated RED output here>

Behaviour: none. Guards green: epic-chain-branch, story-base,
recorded-default-branch, boundary, build-executor. Golden guard green.
Tests: <N before> -> <N after>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 5: `reviewBundle.ts` + `reviewRound.ts` + `ReviewCounters`

The spec's risk: *"the three bounds conflating."* `reviews`, `fixlists` and `formatRetries`
(`:533`, `:544`, `:557`) count three different things — verdicts that cost an attempt, free
rounds granted to the AUTHOR, envelopes the format check sent back to the REVIEWER — and every
one of them falls back to the ledger for a fresh process. `ReviewCounters` keeps three separate
maps. **Never merge them, never share a fallback.**

**Files:**
- Create: `src/core/build/reviewBundle.ts`
- Create: `src/core/build/reviewRound.ts`
- Modify: `test/dod-allowlist.test.ts` (retarget two source pins)
- Modify: `src/core/facilitator/executors/build.ts`

**Symbols moved to `reviewBundle.ts`, real line ranges at `c045f3f`:**

| Symbol | build.ts lines | New signature |
|---|---|---|
| `interface ResumableReview` | `:225-236` | `export interface ResumableReview` |
| `interface ReviewWork` | `:238-253` | `export interface ReviewWork` |
| `bundleKey` | `:3465-3468` | `bundleKeyOf(stageId, storyId): string` |
| `reviewBundleKey` | `:3470-3480` | `reviewBundleKeyOf(stageId, storyId): string` |
| `reviewBundleOut` | `:3482-3485` | `reviewBundleOut(runDir, key): boolean` |
| `writeReviewBundle` | `:3487-3549` | `writeReviewBundle(parts): string` |
| `clearReviewBundle` | `:3551-3555` | `clearReviewBundle(runDir, key): void` |
| `reviewWorkFromBundle` | `:3580-3607` | `reviewWorkFromBundle(runDir, key): ReviewWork \| null` |
| `reviewWorkFromLedger` | `:3609-3624` | `reviewWorkFromLedger(runDir, storyId, status): ReviewWork \| null` |
| the rename half of `reopenReviewBundle` | `:2291-2292` | `stashRefusedEnvelope(runDir, key, n): string` |

**Symbols moved to `reviewRound.ts`:**

| Symbol | build.ts lines | New signature |
|---|---|---|
| `REVIEWER_TOOLS` | `:3858-3859` | `export const REVIEWER_TOOLS: readonly string[]` |
| `reviewerPrompt` | `:2327-2375` | `reviewerPromptFor(parts): string` |
| `recurringClasses` + the `recurring` field | `:2377-2401` | `RecurringFocus` (a one-shot memo) |
| `narrowFixlist` | `:1521-1581` | `narrowFixlist(counters, parts, storyId, review): Review` |
| `fixlistRoundsSpent` | `:1509-1519` | `ReviewCounters.fixlistRounds(runDir, storyId)` |
| `formatRetriesSpent` | `:2315-2325` | `ReviewCounters.formatRetries(runDir, storyId)` |
| `reviewAttempts` | `:3631-3634` | `ReviewCounters.verdicts(runDir, storyId)` |
| `formatRetry`'s DECISION half | `:2183-2259` | `formatRetryDecision(counters, parts): FormatRetry \| null` |
| `pendingRefusal` | `:2261-2272` | `pendingRefusal(runDir, storyId): string \| null` |
| `resumableReview` | `:3662-3684` | `resumableReview(runDir, storyId, status, fresh): ResumableReview \| null` |
| `blockedByFailedDeveloper` | `:3636-3660` | `blockedByFailedDeveloper(runDir, planned, fresh): string \| null` |
| `previousAttemptText` | `:3686-3703` | `previousAttemptText(parts): string` |

**Deliberately NOT moved, with the reason:** `spawnReviewer` (`:2100-2181`), `recordReview`
(`:2403-2469`), `reopenReviewBundle` (`:2274-2313`), `refuseOnEnvelope` (`:3412-3463`) and
`awaitingReview` (`:3626-3629`) all either push to `this.tasks`, assemble an `ExecutorOutcome`,
or both. Spec §3's prose keeps "the refusal helpers" and the entry points in `build.ts`, and
Global Constraints forbid `ExecutorTask`/`ExecutorOutcome` under `src/core/build/`. They stay,
now as thin methods over the moved pieces. `writeFixlistFor` (`:1366-1403`), `openFixNow`
(`:1405-1437`), `verifyResolutions` (`:1439-1494`) and `unverifiedBecause` (`:1496-1507`) are
the FIX-LIST cluster, not the review-round one; they stay in `build.ts` — `src/core/build/fixlist.ts`
already owns their leaf logic and a second home for them is out of this wave's scope.

**Interfaces:**
- Consumes: `readReviewLedger` (Task 1), `MAX_ATTEMPTS` (Task 2), `Review`,
  `isFormatRejection`, `MAX_FORMAT_RETRIES`, `renderFormatRefusal`, `renderPreviousAttempt`
  from `src/core/build/review.ts`; `latestFixlist`, `MAX_FIXLIST_ROUNDS` from
  `src/core/build/fixlist.ts`; `buildReviewerPrompt`, `REVIEW_SCHEMA`, `RecurringClass` from
  `src/core/build/prompts.ts`; `workspaceRecurring` from `src/core/retro/reviewerFocus.ts`;
  `writeBundle`, `PendingReview`, `PendingStage`, `PENDING_FILE`, `RESULT_FILE`, `RAW_FILE`
  from `src/core/facilitator/pending.ts`; `agentDir` from `src/core/facilitator/paths.ts`;
  `REVIEW_DIR` from `src/core/run/prepared.ts`.
- Produces:
  ```ts
  // src/core/build/reviewRound.ts
  /**
   * The three bounds a review round is held to, each counting a DIFFERENT thing,
   * each falling back to the ledger for a fresh process — and each with its own
   * map, deliberately. `verdicts` counts judgements that cost an attempt;
   * `fixlistRounds` counts free rounds granted to the AUTHOR; `formatRetries`
   * counts envelopes the format check sent back to the REVIEWER. Merging any two
   * spends a requeue the framework did not owe, or forgets a bound a restart must
   * remember.
   */
  export class ReviewCounters {
    verdicts(runDir: string, storyId: string): number;
    countVerdict(storyId: string): void;
    fixlistRounds(runDir: string, storyId: string): number;
    grantFixlistRound(storyId: string, spent: number): void;
    formatRetries(runDir: string, storyId: string): number;
    grantFormatRetry(storyId: string, spent: number): void;
    /** A verdict — any verdict — closes the envelope round (#78). */
    closeEnvelopeRound(storyId: string): void;
  }

  export interface FormatRetry {
    /** What to splice into the corrected envelope's prompt. */
    readonly refusal: string;
    /** `story.review_retried`'s payload detail, already clipped to 4 KB (§2.9). */
    readonly detail: string;
    /** 1-based: which correction this is. */
    readonly retry: number;
    readonly lines: readonly string[];
  }
  export function formatRetryDecision(
    counters: ReviewCounters,
    parts: { readonly runDir: string; readonly storyId: string; readonly review: Review },
  ): FormatRetry | null;
  ```

- [ ] **Step 1: Create `src/core/build/reviewBundle.ts`**

Move the ten symbols verbatim. `writeReviewBundle` takes every value it reads today as a field
of one `parts` record (`runDir`, `root`, `runId`, `phaseId`, `stageId`, `storyId`, `repo`,
`branch`, `epicBranch`, `worktree`, `attempt`, `model`, `effort`, `budgetUsd`, `reviewerCapUsd`,
`preparedAt`, `work`, `refusal`, `prompt`, `lines`). The `prompt` is passed as a STRING —
computed by the caller from `reviewerPromptFor` — so `reviewBundle.ts` does not have to know how
a prompt is rendered, and the "one renderer, whichever door" property (`:2327-2335`) stays where
its docstring is.

- [ ] **Step 2: Create `src/core/build/reviewRound.ts`**

`REVIEWER_TOOLS` moves HERE, not into `reviewBundle.ts` and not left behind. It has to move with
`reviewerPromptFor`'s neighbourhood because `spawnReviewer` stays in `build.ts` and imports it —
leaving the constant in `build.ts` while `spawnReviewer`'s prompt renderer lives in a module
that also names it would be the only shape that risks an import cycle. `build.ts` re-exports it,
so `facilitator/index.ts:34` and `build-executor.test.ts:22` are untouched.

`formatRetryDecision` is the DECIDING half of `:2183-2259`: it reads the bound, records the
grant in the counters, and returns what to say and what to re-prompt with. The half that stays
in `build.ts` is the half that spends money and writes events — `this.tasks.push(...)`
(`:2230-2239`) and `this.ctx.emit("story.review_retried", …)` (`:2244-2252`). The
`KNOWN LIMITATION` comment at `:2203-2209` — the reviewer's `agent.usage` never reaching a
`run.yml` row's token split — **moves verbatim with the `task` parameter it is about, which
stays in `build.ts`.** Do not reword it and do not fix it: the token split is #173, explicitly a
non-goal (spec §4).

- [ ] **Step 3: Rewire `build.ts`**

Delete the moved ranges. Add `private readonly counters = new ReviewCounters();` and
`private readonly focus = new RecurringFocus();`, delete the `reviews`/`fixlists`/`formatRetries`
fields (`:531-557`) and the `recurring` field (`:2391`), and keep every removed method as a thin
delegating wrapper so the ~30 call sites do not move.

Add the imports and extend the re-export block:

```ts
import {
  bundleKeyOf, clearReviewBundle, reviewBundleKeyOf, reviewBundleOut, reviewWorkFromBundle,
  reviewWorkFromLedger, stashRefusedEnvelope, writeReviewBundle,
  type ResumableReview, type ReviewWork,
} from "../../build/reviewBundle.ts";
import {
  blockedByFailedDeveloper, formatRetryDecision, narrowFixlist, pendingRefusal,
  previousAttemptText, RecurringFocus, resumableReview, reviewerPromptFor, ReviewCounters,
  REVIEWER_TOOLS,
} from "../../build/reviewRound.ts";
```
```ts
export { REVIEWER_TOOLS, ReviewCounters };
```

- [ ] **Step 4: Retarget the two `REVIEWER_TOOLS` source pins, in THIS commit**

`test/dod-allowlist.test.ts:127-146` reads `build.ts` as text. Two of its four assertions now
point at a file that no longer defines the thing, and two still belong on `build.ts`. Change the
`describe` to read two sources, with the reason in the test:

```ts
describe("M5 · --yolo never reaches the reviewer", () => {
  const source = readFileSync(join(FRAMEWORK_ROOT, "src", "core", "facilitator", "executors", "build.ts"), "utf8");
  // Wave 2 moved REVIEWER_TOOLS to `build/reviewRound.ts` (it is the reviewer
  // ROUND's vocabulary, and leaving it behind while its prompt renderer moved
  // was the one shape that risked an import cycle). The assertions are unchanged;
  // only the file they read moved. build.ts still holds the reviewer SPAWN, so
  // `tools: REVIEWER_TOOLS` + `yolo: false` is still read from there.
  const round = readFileSync(join(FRAMEWORK_ROOT, "src", "core", "build", "reviewRound.ts"), "utf8");

  test("the reviewer spawn passes `yolo: false`, not the context's flag", () => {
    const at = source.indexOf("tools: REVIEWER_TOOLS");
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, at + 800);
    expect(block).toContain("yolo: false");
    expect(block).not.toContain("yolo: this.ctx.yolo");
  });

  test("the reviewer's tools are still read-only", () => {
    expect(round).toContain('export const REVIEWER_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "Bash(git diff *)"]');
  });

  test("the DEVELOPER still gets it — that one is meant to write", () => {
    const at = source.indexOf("tools: developerTools(commands");
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 300)).toContain("yolo: this.ctx.yolo");
  });

  test("exactly one `yolo: this.ctx.yolo` remains in the file", () => {
    expect(source.split("yolo: this.ctx.yolo").length - 1).toBe(1);
    // And none at all in the module that now holds the reviewer's vocabulary.
    expect(round).not.toContain("yolo: this.ctx.yolo");
  });
});
```

Prove the retargeted pin can fail: temporarily change `REVIEWER_TOOLS` in `reviewRound.ts` to
add `"Write"`, run `bun test test/dod-allowlist.test.ts`, keep the RED verbatim, revert.

- [ ] **Step 5: Prove the three bounds are still three**

```bash
grep -n "class ReviewCounters" -A 40 src/core/build/reviewRound.ts | grep -n "new Map"
echo "counters grep exit: $?"
```

Expected: three distinct `new Map<string, number>()` initialisers. Two would be the exact defect
the spec's risk line names.

- [ ] **Step 6: Run the named guards and the golden**

```bash
bun test test/review-handshake.test.ts test/reviewer-envelope-authority.test.ts test/handshake-sequencing.test.ts test/payload-cap.test.ts test/attempt-cost.test.ts test/fixlist.test.ts test/dod-allowlist.test.ts
echo "guards exit: $?"
bun test test/build-golden.test.ts
echo "golden exit: $?"
```

Expected: both `0`. `review-handshake.test.ts:218-233` is the prompt byte-identity test — the
`--prepare --review` bundle's `prompt.md` must equal what the SPAWNED reviewer was handed, modulo
the story file's own `status:` line. It and the golden's `reviewer-prompt.md` are two independent
readings of the same property; both green is the evidence. **`golden exit` not 0 ⇒ revert the
whole task.**

If a named file does not exist under that exact name, find it (`ls test | grep -i "handshake\|envelope\|payload"`)
and say in the commit body which guard you could not run and why.

- [ ] **Step 7: Run THE GATE**

Run the block from Global Constraints. Expected: every exit `0`, seam count `0`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(build): move the reviewer bundle and the review round out of the executor

build/reviewBundle.ts owns the bundle ON DISK — the two keys, the write, the
clear, and reading the work back off it or off the ledger. build/reviewRound.ts
owns the round: REVIEWER_TOOLS, the one reviewer-prompt renderer, the recurring
focus memo, `narrowFixlist`, the format-retry decision, and `ReviewCounters`.

The three bounds stay three maps. `verdicts` counts judgements that cost an
attempt; `fixlistRounds` counts free rounds granted to the AUTHOR;
`formatRetries` counts envelopes the format check sent back to the REVIEWER.
Each keeps its own ledger fallback, because `--commit --review` settles one
envelope per process and a bound this process alone remembered would be no
bound at all. Merging any two is the defect this cut is most able to introduce,
so it has its own grep in the plan and its own sentence here.

What did NOT move, and why: spawnReviewer, recordReview, reopenReviewBundle,
refuseOnEnvelope and awaitingReview push to `this.tasks` or assemble an
`ExecutorOutcome`; spec §3 keeps the refusal helpers and the entry points in
build.ts and nothing under src/core/build/ may import the executor's types. The
`KNOWN LIMITATION` comment about the reviewer's token split moved with the
`task` param it describes — which stays here — verbatim. That is #173 and an
explicit non-goal; the cut makes it addressable, it does not address it.

Retargeted pins, declared: dod-allowlist.test.ts read build.ts as text for
`export const REVIEWER_TOOLS = [...]`. The constant moved to reviewRound.ts (it
is the round's vocabulary, and leaving it behind while its prompt renderer moved
was the one shape that risked an import cycle), so the SAME assertion now reads
that file, in this commit, plus a new one that reviewRound.ts contains no
`yolo: this.ctx.yolo` at all. The other two assertions still read build.ts,
which still holds the reviewer SPAWN. Proved the retargeted pin still fails:
<paste the Step 4 mutated RED output here>

Behaviour: none. Guards green: review-handshake (including the prompt
byte-identity case at :218-233), reviewer-envelope-authority,
handshake-sequencing, payload-cap, attempt-cost, fixlist, dod-allowlist.
Golden guard green — the reviewer prompt is byte-identical, which is a second
independent reading of the same property. Tests: <N before> -> <N after>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 6: Docs

**Files:**
- Modify: `CHANGELOG.md` (create `## 0.9.2 — unreleased` with a `### Changed` group)
- Modify: `docs/ROADMAP.md:104-116` (the decomposition item → done, with the module map)
- Modify: `AGENTS.md:198-199` (§12's sentence)
- Modify: `docs/spec.md` and `docs-site/` **only if a grep says they name a moved internal**

- [ ] **Step 1: Measure what actually names a build.ts internal**

```bash
grep -rn "build\.ts\|BuildSession\|readReviewLedger\|phaseCostToDate\|REVIEWER_TOOLS\|developerPriceDivisor\|clampParallel\|basePreflight\|refuseOnRedBase\|openEpicWorktree" docs/spec.md
echo "spec grep exit: $?"
grep -rn "build\.ts\|BuildSession\|readReviewLedger\|phaseCostToDate\|REVIEWER_TOOLS" docs-site --include='*.md' --include='*.ts' | grep -v node_modules
echo "docs-site grep exit: $?"
```

Measured at `c045f3f`: `docs/spec.md` has ONE hit, `:2371`, and it names the SYMBOL
`readReviewLedger`, not a file path — the symbol did not change, so **`docs/spec.md` needs no
edit** unless your grep now shows otherwise. `docs-site` has zero hits. Record both results in
the commit body. `docs/audits/2026-08-29/*` also name `build.ts:NNN`: those are dated audit
records and are **immutable** — do not touch them.

- [ ] **Step 2: `CHANGELOG.md` — create the unreleased section**

Insert directly below the `# Changelog` heading and above `## 0.9.1 — 2026-09-06`:

```markdown
## 0.9.2 — unreleased

### Changed

- **The Build executor is no longer one 4,351-line file.** `BuildSession` was 107 methods
  over five subjects — the story pipeline, the reviewer handshake, the fix-list round, the
  base-tree pre-flight and the worktree/branch mechanics — and twelve of those methods reached
  three or more of them. That is not an aesthetic complaint. Every remaining hardening fix
  lands inside this file, and a 4,000-line diff context is exactly where the review loop is
  weakest: the reviewer reads the change and cannot see what the change is next to. Seven
  modules now hold the machinery — `build/reviewLedger.ts`, `build/phaseCost.ts`,
  `build/caps.ts`, `build/dodRunner.ts`, `build/worktrees.ts`, `build/branchClaims.ts`,
  `build/reviewBundle.ts` and `build/reviewRound.ts` — each taking DATA rather than the
  session, with the mutable state the orchestrator used to hide in private maps made explicit
  (`PreflightCache`, `EpicState`, `ReviewCounters` — three counters of three different things,
  still never merged). Nothing moved that a caller can see: every symbol is re-exported from
  `executors/build.ts`, so the ten importing test files, `run/reopenStory.ts` and
  `facilitator/index.ts` are byte-identical.
  Zero behaviour change, and it is proved rather than argued: a golden guard captured before
  the first move freezes the developer prompt, the reviewer prompt, the ordered event kinds
  with their payload keys, `run.yml`'s task rows and both exit codes of a real fake-agent
  build, and every step had to keep it byte-identical. The rule while it ran was that a golden
  byte change means REVERT — never "update the golden".
```

- [ ] **Step 3: `docs/ROADMAP.md` — mark the item done with the module map**

Replace the bullet at `:104-116` (`**Decompose src/core/facilitator/executors/build.ts.**` …
through `… never a reviewer's.`) with:

```markdown
- **Decompose `src/core/facilitator/executors/build.ts`. — done (0.9.2).** It was 4,351 lines in
  one class. The machinery now lives in eight modules under `src/core/build/`, each taking data
  rather than the session: `reviewLedger.ts` (`events.jsonl` → the cross-process bounds),
  `phaseCost.ts` (the handoff's #138/#139 cost line), `caps.ts` (the money constants and every
  ceiling), `dodRunner.ts` (the story DoD + the #41 base pre-flight and its `PreflightCache`),
  `worktrees.ts` (story/epic worktrees, base refresh, commit, merge, #129 rescue, `EpicState`),
  `branchClaims.ts` (epic claims, the branch model, the two tree refusals, the epic rows),
  `reviewBundle.ts` (the reviewer bundle on disk) and `reviewRound.ts` (`ReviewCounters`,
  `REVIEWER_TOOLS`, the one reviewer-prompt renderer, the two bounds). `executors/build.ts`
  keeps the orchestration — the five entry points, the wave drivers, the story-state cluster,
  the log/handoff cluster, the refusal helpers and `SerialQueue` — and re-exports every moved
  symbol, so no caller moved. `test/build-golden.test.ts` is the guard that made it provable
  and is kept: it is the cheapest regression net this file has.
  Two defects it carried through unchanged, both still open and both filed rather than fixed
  inside a pure refactor: `ExecutorOutcome.tasks` exists only at RETURN, so a throw part-way
  through still loses the task rows the invocation had earned (`runNext.ts`'s `runExecutor`
  catch fails the stage by name and SAYS the rows are missing — honest, not whole); and the
  reviewer path narrows its `AgentOutcome` into a local struct before `tasks.push`, so the
  provider's token split reaches a developer row and never a reviewer's (#173, both sites still
  marked `KNOWN LIMITATION`).
```

- [ ] **Step 4: `AGENTS.md` §12 — the debt is paid, name the modules**

Replace `:198-199` with:

```markdown
- `src/core/facilitator/executors/build.ts` was ~4k lines and was decomposed in 0.9.2 (wave 2).
  Its machinery lives in `src/core/build/`: `reviewLedger.ts`, `phaseCost.ts`, `caps.ts`,
  `dodRunner.ts`, `worktrees.ts`, `branchClaims.ts`, `reviewBundle.ts`, `reviewRound.ts`. The
  executor keeps the orchestration and RE-EXPORTS every moved symbol — importers still write
  `from ".../executors/build.ts"`, and they must keep working. Before changing anything in
  there, know that `test/build-golden.test.ts` freezes both prompts, the ordered event kinds
  with their payload keys, `run.yml`'s task rows and the exit codes of a real fake-agent build:
  a golden byte change is a BEHAVIOUR change, so either it is the change you meant and you say
  so in the commit, or you revert. Never "update the golden" to make a diff go away.
```

- [ ] **Step 5: EN and ES in lockstep — check whether the docs-site is affected**

```bash
grep -rn "4,351\|4351\|4k lines\|BuildSession" docs-site --include='*.md' | grep -v node_modules
echo "docs-site line-count grep exit: $?"
```

Expected: no output (`exit: 1`). The docs-site does not name this file's size or internals
(measured at `c045f3f`), so there is no EN/ES pair to keep in lockstep here. **If the grep prints
anything, edit BOTH the EN page and its ES translation in this commit** (AGENTS.md §5). Record
the result either way.

- [ ] **Step 6: Run THE GATE**

Run the block from Global Constraints. `docs:build` is the gate that catches a dead link
introduced by a ROADMAP edit (`ignoreDeadLinks: false` since #114). Expected: every exit `0`.

Also run the public-surface guard by name, since this task edits prose:

```bash
bun test test/public-surface-consistency.test.ts
echo "public-surface exit: $?"
```

Expected: `public-surface exit: 0`. That test forbids typing the current version into prose —
`0.9.2` appears only in the CHANGELOG heading and the ROADMAP's `— done (0.9.2)`, which are the
established convention for those two files; if it goes red, read WHY before editing anything.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: wave 2 — the Build executor's decomposition, and the debt marked paid

CHANGELOG `## 0.9.2 — unreleased` `### Changed` with the WHY (every remaining
hardening fix lands in this file, and a 4,000-line diff context is where the
review loop is weakest), ROADMAP's decomposition item marked done with the
eight-module map and the two defects it carried through unchanged, AGENTS.md
§12 rewritten to name the modules and — more usefully to the next agent — the
golden guard and the rule that a golden byte change means revert.

Measured, not assumed: `docs/spec.md` has one hit and it names the SYMBOL
`readReviewLedger` (:2371), which did not change, so the file needs no edit;
`docs-site` names no build.ts internal and no line count, so there is no EN/ES
pair to keep in lockstep here. `docs/audits/2026-08-29/*` name `build.ts:NNN`
and are dated records — left immutable on purpose.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 7: The full gate, and the evidence for the close

No code changes. This task is the measurement the whole plan is for.

**Files:** none modified.

- [ ] **Step 1: Prove the design rule held**

```bash
grep -rn "ExecutorContext\|ExecutorOutcome\|ExecutorTask" src/core/build/
echo "ctx-leak grep exit: $?"
```

Expected: no output, `ctx-leak grep exit: 1`. That is the mechanical spelling of spec decision 3
— extracted functions take data, not `ctx`. **Any hit is a finding to fix before the close.**

- [ ] **Step 2: Prove the public surface did not move**

```bash
git diff --stat c045f3f..HEAD -- src/core/facilitator/index.ts src/core/run/reopenStory.ts
echo "surface diff exit: $?"
git diff c045f3f..HEAD --numstat -- test/ | awk '{print $3}'
echo "changed test files listed above"
```

Expected: `git diff --stat` over `facilitator/index.ts` and `reopenStory.ts` prints **nothing**,
and the only test files that changed across the whole wave are `test/build-golden.test.ts` and
`test/fixtures/build/golden.ts` (new), `test/fixtures/build/golden/*` (new),
`test/dod-preflight.test.ts` (one new assertion, Task 3), `test/dod-allowlist.test.ts` (a
retargeted pin, Task 5) and `test/build-executor.test.ts` (a retargeted pin, Task 4). Any other
changed test file is a caller that was patched instead of re-exported — a public-surface change,
not a refactor.

- [ ] **Step 3: Measure the size of the cut**

```bash
wc -l src/core/facilitator/executors/build.ts
git show c045f3f:src/core/facilitator/executors/build.ts | wc -l
wc -l src/core/build/reviewLedger.ts src/core/build/phaseCost.ts src/core/build/caps.ts src/core/build/dodRunner.ts src/core/build/worktrees.ts src/core/build/branchClaims.ts src/core/build/reviewBundle.ts src/core/build/reviewRound.ts
```

Record both numbers. `git show <ref>:<dir>` prints a tree listing and exits 0 — the command above
names a FILE, which is why it is safe; use `git cat-file blob` if you ever need to cite a
directory path (AGENTS.md §12).

- [ ] **Step 4: Run THE GATE, one last time, from a clean tree**

```bash
git status --porcelain
echo "tree clean check printed above (expected: nothing)"
bun run typecheck
echo "typecheck exit: $?"
bun test
echo "bun test exit: $?"
bun run build
echo "build exit: $?"
bun run docs:build
echo "docs:build exit: $?"
grep -rn 'Bun\.' src --include='*.ts' | grep -v 'src/core/runtime/'
echo "seam grep printed the lines above (expected: none)"
grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' '
echo "seam count printed above (expected: 0)"
```

Expected: an empty `git status --porcelain`, every exit `0`, no seam lines, seam count `0`, and
`bun test` printing `N pass  0 fail` with N equal to the Task 0 baseline plus the assertions
this wave added (one golden case in Task 0b, one `PreflightCache` case in Task 3, and the extra
assertions inside the two retargeted pins). **Reconcile the delta arithmetic explicitly — do not
hand-wave it** (AGENTS.md §8).

- [ ] **Step 5: Run the golden twice more, cold**

```bash
bun test test/build-golden.test.ts
echo "golden run 1 exit: $?"
bun test test/build-golden.test.ts
echo "golden run 2 exit: $?"
```

Expected: both `0`. Two green runs at the END of the wave, over two fresh temp dirs and two
fresh sets of shas, is the closing measurement: the executor's observable output is
byte-identical to what it was before the first symbol moved.

- [ ] **Step 6: Write the close**

No commit. Assemble the evidence AGENTS.md §11 asks for, from what you measured:

- the test delta, both ends, attributed to the tasks that added each assertion;
- the two RED proofs kept verbatim (Task 0b's golden-against-nothing, Task 3's
  `PreflightCache.loads` mutation) plus the two retarget-pin mutations (Tasks 4 and 5);
- `build.ts` before/after line counts and the eight module sizes;
- the `ctx-leak` grep result and the empty public-surface diff;
- the design paragraph: why `spawnReviewer`, `recordReview`, `refuseOnEnvelope`,
  `reopenReviewBundle`, `awaitingReview`, `SerialQueue`, `developerTools`, `spawnDeveloper` and
  the fix-list cluster stayed in `build.ts`, and why every extracted refusal returns
  `BuildRefusal` instead of an `ExecutorOutcome`;
- every deviation from the spec's line table, each with the file:line that refuted it (Task 1's
  `readReviewLedger` gap and the refusal helpers, Task 3's `:3312-3337` doc boundary, Task 4's
  `:1850-1932` doc boundary and the `:2767-3102` / `:2951-3067` overlap);
- and any out-of-scope bug found on the way, as a GitHub issue with the measurement, the
  mechanism (labelled if inferred) and file:line — **never fixed inside this change**.

---

## Self-Review

**Spec coverage.** §2.1 pure refactor → Global Constraints + the revert rule in every task.
§2.2 target directory → the File Structure table, all eight modules under `src/core/build/`.
§2.3 data not `ctx` → the grep in Task 7 Step 1, plus `PreflightCache` (Task 3), `EpicState`
(Task 4), `ReviewCounters` with its three-map grep (Task 5), and `lines`/`advisories`/`tasks`/
`writes` passed rather than duplicated. §2.4 re-exports → a re-export block extended in Tasks 1,
2, 3, 4, 5 and proved by the empty collateral diff in Tasks 1 and 7. §2.5 golden first → Task 0b,
and "a golden byte change means REVERT" repeated in every move task. §2.6 pins retargeted not
weakened → Task 4 Step 5 (`story/${`), Task 5 Step 4 (`REVIEWER_TOOLS`), Task 1 Step 5 (the
`dashboard-sources` pin measured as needing no change), each with a mutation proof. §2.7 the 126
spelling, the reviewer narrowing and `refuseOnDirtyRepos` move verbatim → named in Tasks 3, 4
and 5 with "do not fix it, it is #165/#173/#164". §2.8 dead barrel → Task 0. §3's step order →
Tasks 0–5 in the spec's order. §5 gates → THE GATE in every task, the machine-load guard row in
Task 0b Step 7. §6 docs → Task 6.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N".
Four `<paste …>` markers exist, all in commit-message bodies, all for output the executor
measures in the step immediately above; that is a value that cannot exist before the step runs,
not a placeholder for a decision. Four `<N before> -> <N after>` markers are the same thing.

**Type consistency.** `BuildRefusal` is defined once (Task 3, `build/outcome.ts`) and used by
Tasks 3 and 4. `CapParts` is defined in Task 2 and referenced only there. `PhaseCostTurn` exists
so `phaseCost.ts` need not import `ExecutorTask`, and Task 7's grep is what enforces that.
`PreflightCache` is produced by Task 3 and consumed by Task 3's `BaseParts` only. `EpicState` is
produced by Task 4's `worktrees.ts` and consumed by Task 4's `branchClaims.ts` — the import
direction is `branchClaims.ts` → `worktrees.ts`, which matches their creation order in the same
task. `ReviewCounters` is produced by Task 5's `reviewRound.ts` and consumed there and in
`build.ts`. `ReviewWork` / `ResumableReview` move to `reviewBundle.ts` in Task 5 and are imported
by `reviewRound.ts` in the same task.
