# Wave 3 — mechanical blockers and the cost-ledger remainder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven measured blockers of `docs/superpowers/specs/2026-09-06-wave3-blockers-design.md` — a reviewer turn's token split, the spend basis that cannot see a provider split, a fabricated `exit 126`, a refusal that names a verb instead of a command, a reviewer prompt that diffs an empty range, `commands:` nobody ran, and a PR body that is a gate document — without moving a single committed golden byte that the change does not name first.

**Architecture:** Every fix is a LEAF plus its call sites. New derivations go in one file each (`budget/turnTokens.ts`, `run/shipBody.ts`, `detect/probeCommands.ts`); existing leaves grow additive fields (`DodResult.status`, `ReviewerPromptParts.diffBase`, `PendingReview.epic_base`, `workspace.yml command_probes`). `src/core/facilitator/executors/build.ts` stays an orchestrator: it captures values and passes them; no derivation is added to it.

**Tech Stack:** TypeScript on Bun (tests, build) running under Node ≥ 20 at runtime; `bun:test`; VitePress for the docs site.

**Spec:** `docs/superpowers/specs/2026-09-06-wave3-blockers-design.md` (approved 2026-09-06; do not re-open its decisions).

**Base:** worktree `wt-wave3`, branch `fix/wave3-blockers`, base = `b0729bc` (release 0.9.2). Everything below was re-verified against the files at that commit; file:line citations are from it.

## Global Constraints

Copied from `AGENTS.md`; every task's requirements implicitly include this section.

- **Evidence before assertion.** Label a claim `measured` / `inferred` / `assumed`. Never copy a measurement out of a doc or a comment when you can take one.
- **Never quote a CLI command or flag from memory.** `src/cli/helpText.ts` (and `tldrx <cmd> --help`) is the authoritative command surface.
- **Exit codes are never read through a pipe or after a trailing command.** Run the gate command on its own line and read its own exit code. The shell here is zsh: no `${PIPESTATUS[0]}`, and never name a variable `status`.
- **Red-first, always.** Every behaviour change starts with a failing test whose VERBATIM red output you keep for the commit message / issue close. A test that passed before the fix is a guard, not a proof — say so.
- **Gates for any change** (each run without pipes, each exit code read):
  `bun run typecheck` · `bun test` · `bun run build` · `bun run docs:build` · and `grep -rn 'Bun\.' src | grep -v src/core/runtime/` must print nothing.
- **Runtime code must run under Node.** No `Bun.*` under `src/` outside `src/core/runtime/`.
- **`version: 1` file formats only grow.** Additive optional fields, tolerant reads of old records, never a changed meaning. Every new key in this plan gets a test that an OLD record still loads.
- **One implementation per derivation.** Grammar / regex / arithmetic lives in exactly one file. If two sites need the same sentence, extract a leaf.
- **Absent-with-reason, never invented.** A value that cannot be derived is named with WHY, never guessed, never a confident zero.
- **Golden discipline (spec §2.2, AGENTS.md §12).** `test/build-golden.test.ts` freezes 18 artifacts. **A golden byte change IS a behaviour change**: it is allowed only when the task's commit message names WHICH artifacts changed, WHICH rows/lines, and WHY. Never run `TLDRX_GOLDEN_UPDATE=1` to make a diff go away. Each golden-affecting task below lists its artifacts BEFORE the change; the review diffs the golden against that list.
- **Hermetic tests.** Every spawning test file gets its own `mkdtemp` root and imports `./fixtures/machineLoad.ts`, calling `setDefaultTimeout(spawnTestTimeout())` at the top — `test/machine-load.test.ts` auto-discovers spawning files (`node:child_process` / `Bun.spawn` / `makeBuildWorkspace` / `makeSandbox` in the source) and asserts it, so a new spawning test file adds one row there. Reconcile the count; do not hand-wave.
- **No private workspace names** anywhere in code, tests, docs or fixtures.
- **Commit trailers on every commit in this plan:**

  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
  ```

- **No release steps.** This plan ends at a green gate and a clean tree. `scripts/release.sh` is somebody else's turn.

---

## File Structure

Files created:

| File | Responsibility |
|---|---|
| `src/core/budget/turnTokens.ts` | ONE derivation of "how many tokens did this turn declare" — `tokens ?? (input+output when both present)`. Both spend-basis feeders call it. |
| `src/core/detect/probeCommands.ts` | Probe the four gate slots once through `CommandRunner`, with a timeout, and return `command_probes` rows. Never probes `run`. |
| `src/core/run/shipBody.ts` | `renderShipBody` — the PR body: the handoff's done/not-done split, the open fix-list findings (obtained by CALLING `build/fixlist.ts`), and the handoff itself in a `<details>` block. |
| `test/fixtures/build/golden/refused-*.txt`/`.md` | The FOURTH golden scenario's committed artifacts (new files only; no existing golden byte moves). |

Files modified (the load-bearing ones; each task names its own list):

`src/core/facilitator/executors/build.ts` (reviewer task structs, the epic-sha capture, `task.done`), `src/core/build/{outcome,dodRunner,preflight,handoff,review,retroLog,prompts,reviewRound,reviewBundle,reviewLedger,branchClaims,phaseCost,git}.ts`, `src/core/dashboard/model.ts`, `src/core/facilitator/pending.ts`, `src/core/run/ship.ts`, `src/core/detect/{types,detectWorkspace}.ts`, `src/core/init/{workspaceDocument,runInit,validateEmitted}.ts`, `src/core/schemas/workspace.ts`, `src/hooks/lib/workspace.ts`, `src/cli/helpText.ts`, plus tests, `CHANGELOG.md`, `docs/spec.md`, `docs/guide/*`, `docs-site/**` (EN and ES in lockstep).

---

## Task 1: #173 — the reviewer's token split reaches `run.yml`

**Files:**
- Modify: `src/core/facilitator/executors/build.ts` — `formatRetry` (`:1853-1896`), `recordReview` (`:1976-2000`), the spawn call site (`:1824-1840`), the host-envelope call site (`:802-815`)
- Test: `test/build-executor.test.ts` (new test), `test/money-safety.test.ts` (existing `tokenSplit` pins — read, do not change)
- Golden (bytes WILL change — named below): `test/fixtures/build/golden/headless-run-tasks.txt`, `rounds-run-tasks.txt`, `insession-run-tasks.txt`

**Interfaces:**
- Consumes: `tokenSplit(input, output)` from `src/core/facilitator/runNext.ts:2461` — the ONE derivation of "both-or-nothing" presence. Do not re-implement it, do not widen it.
- Produces: `ExecutorTask.inputTokens?: number` / `outputTokens?: number` now populated on reviewer rows, which Task 2 reads.

### The measured problem

`build.ts:1858-1862` says it in its own docstring: `formatRetry`'s and `recordReview`'s `task` param narrows the reviewer's `AgentOutcome` before it reaches `this.tasks.push`, so `agent.usage` never becomes a row's `input_tokens`/`output_tokens`. The developer path does it right at `build.ts:1702-1703` (`inputTokens: agent.usage.input_tokens`).

### The golden artifacts this task changes — STATE THESE IN THE COMMIT

Measured at `b0729bc` by reading the committed files:

1. `test/fixtures/build/golden/headless-run-tasks.txt` — **row `t2` only** (the spawned reviewer, `"session_id":"fake-reviewer-S1"`). It gains `"input_tokens":100` and `"output_tokens":10` in the sorted-key JSON. Row `t1` (developer) already has them and does not move.
2. `test/fixtures/build/golden/rounds-run-tasks.txt` — **rows `t2` and `t4` only** (S1's two spawned reviewers). Rows `t1`, `t3`, `t5` (developers) already carry the split and do not move.
3. `test/fixtures/build/golden/insession-run-tasks.txt` — **row `t2` only**. **This one is beyond spec §2.3's list and is a deviation to state prominently**: the spec named only `headless` t2 and `rounds` t2/t4, but `--commit` still SPAWNS the reviewer (`test/fixtures/build/golden.ts:272` reads `reviewer-S1-1.md`; the row's `session_id` is `fake-reviewer-S1`) and the fake emits `usage: {input_tokens: 100, output_tokens: 10}` for every role (`test/fixtures/build/fakeClaude.ts:107`). Row `t1` is the HOST developer turn (`session_id: null`, no usage) and does NOT move.

No EVENT golden moves: `recordExecutorTasks` spreads `tokenSplit(...)` into the `run.yml` row (`runNext.ts:1278`) but NOT into the `agent.result` payload (`runNext.ts:1280-1290`). No prompt golden moves. Confirm this by diffing after regeneration — if any other artifact moves, STOP and revert.

- [ ] **Step 1: Write the failing test**

Add to `test/build-executor.test.ts`, in the money/ledger describe block nearest the existing reviewer-row assertions:

```ts
test("a spawned reviewer's row carries the provider's token split, like the developer's", async () => {
  const ws = workspace(ONE_STORY);

  const outcome = await next(ws);
  expect(outcome.code).toBe(4);

  const run = RunStore.open(ws.runDir).run;
  const rows = run.phases.flatMap((p) => p.stages).flatMap((s) => s.tasks);
  const reviewer = rows.find((row) => row.session_id === "fake-reviewer-S1");
  expect(reviewer, "the spawned reviewer wrote a task row").toBeDefined();
  // The fake emits the same usage for both roles (fakeClaude.ts:107), so the
  // reviewer's row is compared against the DEVELOPER's — behaviour, not a
  // constant typed twice.
  const developer = rows.find((row) => row.session_id === "fake-developer-S1");
  expect(reviewer?.input_tokens).toBe(developer?.input_tokens);
  expect(reviewer?.output_tokens).toBe(developer?.output_tokens);
  expect(reviewer?.input_tokens).toBeGreaterThan(0);
});
```

Use the file's existing `workspace(...)` / `next(...)` helpers and its existing `ONE_STORY` plan constant — read the top of `test/build-executor.test.ts` and match them exactly rather than inventing names.

- [ ] **Step 2: Run it and keep the RED verbatim**

Run: `bun test test/build-executor.test.ts -t "carries the provider's token split"`
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined`, `expected: 100`. Paste the verbatim output into the commit message.

- [ ] **Step 3: Widen both structs and both call sites**

In `build.ts`, `formatRetry`'s `task` param (`:1863-1869`): DELETE the five-line `KNOWN LIMITATION` comment (it is now false) and add the two fields:

```ts
    task: {
      costUsd: number;
      sessionId: string | null;
      /** False ⇒ the turn was billed to the host session, as in `recordReview`. */
      metered: boolean;
      tokens?: number;
      /** The provider's own split for this turn, when it reported one. */
      inputTokens?: number;
      outputTokens?: number;
    },
```

and in its `this.tasks.push({...})` (`:1875-1882`) add, beside the existing spreads:

```ts
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
```

Do the identical two edits to `recordReview` (`:1979-1987` for the param — replace its `KNOWN LIMITATION` line with the same two fields — and `:1991-1998` for the push).

At the SPAWN call sites, pass the usage through:

```ts
      const again = this.formatRetry(story, review, {
        costUsd: turn, sessionId: agent.sessionId, metered: agent.metered,
        inputTokens: agent.usage.input_tokens, outputTokens: agent.usage.output_tokens,
      });
```

(`build.ts:1824-1826`) and

```ts
      this.recordReview(story, review, {
        costUsd: turn,
        sessionId: agent.sessionId,
        error: agent.error,
        metered: agent.metered,
        inputTokens: agent.usage.input_tokens,
        outputTokens: agent.usage.output_tokens,
        source: "agent",
      });
```

(`build.ts:1833-1839`).

**Leave the HOST-envelope call sites at `:802-815` alone.** A host review has no `agent`; there is no usage to pass, and passing zeros would invent a number. `tokenSplit` already refuses a half-known split; absence here is the honest record.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/build-executor.test.ts -t "carries the provider's token split"`
Expected: PASS, 1 pass 0 fail.

- [ ] **Step 5: Prove the guard has teeth in both directions**

Temporarily change `inputTokens: task.inputTokens` to `inputTokens: undefined` in `recordReview` and re-run Step 4 — it must go RED again. Revert the mutation.

- [ ] **Step 6: Move the golden, deliberately**

Run: `bun test test/build-golden.test.ts`
Expected: FAIL, naming exactly the three artifacts listed above and no others. Read the failure list. **If a fourth artifact is named, STOP and revert** — that is a behaviour change you did not mean.

Then regenerate and re-verify:

```
TLDRX_GOLDEN_UPDATE=1 bun test test/build-golden.test.ts
```

(This run FAILS by design — "golden regenerated".) Then:

```
git diff --stat test/fixtures/build/golden/
bun test test/build-golden.test.ts
```

Expected: `git diff --stat` lists exactly `headless-run-tasks.txt`, `rounds-run-tasks.txt`, `insession-run-tasks.txt`; the second command exits 0.

- [ ] **Step 7: Read the golden diff line by line**

Run: `git diff test/fixtures/build/golden/`
Expected: every changed line is a task row that gained `"input_tokens":100,` and `"output_tokens":10,` and changed in NO other way. Anything else → revert.

- [ ] **Step 8: Gate and commit**

```bash
bun run typecheck
bun test
bun run build
git add -A
git commit -m "$(cat <<'EOF'
fix(build): a reviewer turn's token split reaches its run.yml row (#173)

`formatRetry` and `recordReview` narrowed the reviewer's AgentOutcome before it
reached `tasks.push`, so only the developer and Watch paths ever wrote
`input_tokens`/`output_tokens` — the file's own docstring said so and filed it
as a follow-up. Both structs now carry the split and both spawn call sites pass
`agent.usage.*`; `tokenSplit` still decides presence, so a half-known split is
still absent. The HOST-envelope call sites pass nothing: a host review has no
usage to report and a zero there would be an invented number.

Golden bytes changed, deliberately, in three artifacts and nowhere else:
  headless-run-tasks.txt  row t2       (the spawned reviewer)
  rounds-run-tasks.txt    rows t2, t4  (S1's two spawned reviewers)
  insession-run-tasks.txt row t2       (`--commit` still spawns the reviewer)
Each gains `"input_tokens":100,"output_tokens":10` and changes in no other way.
The third is beyond the spec's list: measured, `--commit` spawns a real reviewer
(golden.ts:272) and the fake emits usage for every role (fakeClaude.ts:107).
No event, prompt or exit-code golden moves — `recordExecutorTasks` spreads
`tokenSplit` into the run.yml row, not into `agent.result` (runNext.ts:1280).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 2: #159 — one `turnTokens` leaf, read by BOTH spend-basis feeders

**Files:**
- Create: `src/core/budget/turnTokens.ts`
- Modify: `src/core/budget/index.ts` (export), `src/core/build/phaseCost.ts:110-133`, `src/core/dashboard/model.ts:1188-1201`
- Test: `test/money-safety.test.ts` (the leaf), `test/dashboard.test.ts` (the feeder, end to end)

**Interfaces:**
- Consumes: Task 1's populated `input_tokens`/`output_tokens` on reviewer rows.
- Produces: `turnTokens(task: TokenBearing): number | null` — exported from `src/core/budget/turnTokens.ts` and re-exported from `src/core/budget/index.ts`. `SpendTurn` (`spendBasis.ts:34`) is UNCHANGED; `spendBasisOf` is UNCHANGED.

### The measured problem

`spendBasisOf` (`src/core/budget/spendBasis.ts:78-87`) counts a costless turn as `silent` when `turn.tokens === null`. Both feeders fill `tokens` from the scalar only — `phaseCost.ts:113` (`tokens: task.tokens ?? null`) and `dashboard/model.ts:1191` (`tokens: task.tokens`) — so a row carrying a full provider split and no host `tokens` counts as silent, and the `absent` sentence ("none of them declared host tokens", `spendBasis.ts:136`) is false about it.

- [ ] **Step 1: Write the failing tests**

Append to `test/money-safety.test.ts`:

```ts
describe("turnTokens — the scalar, else the provider's split, never a half", () => {
  test("a host-declared `tokens` wins, because it is what the host said", () => {
    expect(turnTokens({ tokens: 900, input_tokens: 100, output_tokens: 10 })).toBe(900);
  });

  test("no scalar, both sides of the split present: their sum", () => {
    expect(turnTokens({ input_tokens: 100, output_tokens: 10 })).toBe(110);
  });

  test("a HALF split is absent — the same rule `tokenSplit` writes rows by", () => {
    expect(turnTokens({ input_tokens: 100 })).toBeNull();
    expect(turnTokens({ output_tokens: 10 })).toBeNull();
    expect(turnTokens({ input_tokens: 100, output_tokens: 0 })).toBeNull();
  });

  test("nothing declared is null, never a confident zero", () => {
    expect(turnTokens({})).toBeNull();
  });

  test("a negative or non-finite side is absent, never arithmetic", () => {
    expect(turnTokens({ input_tokens: -1, output_tokens: 10 })).toBeNull();
    expect(turnTokens({ input_tokens: Number.NaN, output_tokens: 10 })).toBeNull();
  });
});
```

Add `turnTokens` to that file's import from `../src/core/budget/turnTokens.ts`.

And the feeder test — append to `test/dashboard.test.ts`, using that file's existing run-fixture helper (read the top of the file and reuse it verbatim; do not invent a helper):

```ts
test("a costless turn with a provider split is `declared`, not `absent` (#159)", () => {
  // One unmetered turn. It declares no host `tokens` and a full provider split,
  // which is exactly the shape every Codex Build turn has.
  const model = modelFor(runWithTasks([
    { id: "t1", cost_usd: null, metered: false, input_tokens: 100, output_tokens: 10 },
  ]));

  expect(model.spend.basis).not.toBe("absent");
  expect(model.spend.silentTasks).toBe(0);
  expect(model.spend.costlessTokens).toBe(110);
  expect(model.spend.reason).not.toContain("none of them declared host tokens");
});
```

- [ ] **Step 2: Run them and keep the RED verbatim**

Run: `bun test test/money-safety.test.ts -t "turnTokens"`
Expected: FAIL — `Cannot find module '../src/core/budget/turnTokens.ts'`.

Run: `bun test test/dashboard.test.ts -t "provider split is \`declared\`"`
Expected: FAIL — `expect(received).not.toBe(expected)` with `"absent"`.

- [ ] **Step 3: Write the leaf**

Create `src/core/budget/turnTokens.ts`:

```ts
/**
 * How many tokens one turn DECLARED — counted once, for every surface that asks
 * (#159).
 *
 * Two different facts live in a task row and only one of them existed when
 * `spendBasisOf` was written. `tokens` is what a HOST declared with `--tokens`
 * for a turn nothing here metered. `input_tokens`/`output_tokens` are the
 * PROVIDER's own split for a turn this process watched, written together or not
 * at all (`runNext.ts`'s `tokenSplit`). The basis feeders read only the first,
 * so a row carrying a full split and no host scalar counted as having declared
 * NOTHING — and under Codex every Build turn is unmetered, so a whole provider
 * read `absent` over rows that hold the tokens.
 *
 * The scalar wins when both are present: it is the host's own statement about a
 * turn it billed, and the split is a measurement of a turn nobody billed here —
 * they are never both descriptions of the same spend, and adding them would
 * double-count.
 *
 * A HALF-known split is absent, for the same reason `tokenSplit` refuses to
 * write one: `envelope.ts`'s parse collapses "no usage object" and "usage
 * reported as 0" into the same shape, so one real number beside one defaulted
 * zero is a manufactured total. Absent is honest; a confident number is not.
 */

/** As much of a `run.yml` task row as this reads. Every field optional — old rows have none. */
export interface TokenBearing {
  readonly tokens?: number | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
}

export function turnTokens(task: TokenBearing): number | null {
  if (positive(task.tokens)) return task.tokens as number;
  const input = task.input_tokens;
  const output = task.output_tokens;
  if (!positive(input) || !positive(output)) return null;
  return (input as number) + (output as number);
}

function positive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
```

Export it from `src/core/budget/index.ts`, beside the `spendBasis` neighbours:

```ts
export { turnTokens } from "./turnTokens.ts";
export type { TokenBearing } from "./turnTokens.ts";
```

- [ ] **Step 4: Point BOTH feeders at it**

`src/core/build/phaseCost.ts` — import it (`import { turnTokens } from "../budget/turnTokens.ts";`), then:

- `:110-114` becomes

  ```ts
        turns = found.stage.tasks.map((task) => ({
          costUsd: task.cost_usd,
          metered: task.metered !== false,
          tokens: turnTokens(task),
        }));
  ```

- `:126-133`'s `invocationTurns` map becomes `tokens: turnTokens({ tokens: task.tokens, input_tokens: task.inputTokens, output_tokens: task.outputTokens })`, and `PhaseCostTurn` (`:12-17`) gains `readonly inputTokens?: number;` / `readonly outputTokens?: number;` so the executor's own `ExecutorTask` rows (which carry the camelCase names) are readable. Keep the `<T extends PhaseCostTurn>` generic exactly as it is and keep its comment — the reason it exists (`:85-93`) has not changed.

`src/core/dashboard/model.ts:1190-1192` becomes

```ts
  const counted = spendBasisOf(
    tasks.map((task) => ({ costUsd: task.cost_usd, metered: task.metered, tokens: turnTokens(task) })),
    hostTokens,
  );
```

with `import { turnTokens } from "../budget/turnTokens.ts";` beside the existing `spendBasisOf` import at `:52`.

**Do NOT change `hostTokens` at `model.ts:1105`.** That is the run's declared HOST tokens — a different currency with its own ceiling (`RunModel.hostTokens`, `isHostTokens`), and folding a provider split into it would change what a budget refusal is measured against. `spendBasis.ts` and `spendReason` are untouched.

- [ ] **Step 5: Run both tests**

Run: `bun test test/money-safety.test.ts -t "turnTokens"` → PASS
Run: `bun test test/dashboard.test.ts` → PASS (whole file: the basis feeds several assertions)
Run: `bun test test/build-executor.test.ts` → PASS (the handoff cost note reads the same leaf)

- [ ] **Step 6: Prove the golden did not move**

Run: `bun test test/build-golden.test.ts`
Expected: PASS, exit 0. This task changes no bytes any golden pins; if it does, one of the 18 artifacts will name itself and you have found a real behaviour change to explain or revert.

- [ ] **Step 7: Gate and commit**

```bash
bun run typecheck
bun test
git add -A
git commit -m "$(cat <<'EOF'
fix(budget): a turn that declared only a provider split is no longer counted silent (#159)

`spendBasisOf` reads one scalar, `turn.tokens`, and both feeders filled it from
the host-declared field alone (phaseCost.ts:113, dashboard/model.ts:1191). A row
carrying a full `input_tokens`/`output_tokens` split and no host scalar was
therefore counted as having declared nothing, and the `absent` sentence — "none
of them declared host tokens" — was false about it. Under Codex every Build turn
is unmetered, so a whole provider read `absent` over rows that hold the tokens.

`budget/turnTokens.ts` is the one derivation both feeders now call: the host
scalar when it is there, else the sum of a split whose two sides are BOTH
positive, else null. A half-known split stays absent for the same reason
`tokenSplit` refuses to write one. `spendBasis.ts` is unchanged — the counting
rule was right; what it was fed was not. `hostTokens` is deliberately untouched:
it is the other currency, with its own ceiling.

No golden byte moved (build-golden green).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 3: #165 — a refused DoD command is recorded as refused, never as `exit 126`

**Files:**
- Modify: `src/core/build/outcome.ts` (`DodResult` `:37-43`, `dodGreen` `:155`, new `dodFailureReason`), `src/core/build/dodRunner.ts` (`:220`, `:129-132`, `:222-237`), `src/core/build/preflight.ts` (`BaseStatus` `:54`, `BaseCommandResult` `:55-93`, `emitPreflightYaml`, `parsePreflight` `:150-170`, `baseFailureLine` `:315`), `src/core/build/handoff.ts` (`ledger` `:268-287`), `src/core/build/review.ts` (`:404-406`), `src/core/build/retroLog.ts` (`:98-106`), `src/core/build/prompts.ts` (`dodResults` `:267`, `:434-437`), `src/core/build/reviewBundle.ts` (`:147`, `:255-260`), `src/core/build/reviewLedger.ts` (`:252-260`), `src/core/facilitator/pending.ts` (`PendingReview.dod` `:263`), `src/core/facilitator/executors/build.ts` (`:1071-1080`, `:1530-1536`)
- Test: `test/dod-preflight.test.ts` (`:318`, `:420` pins), `test/dod-allowlist.test.ts`, `test/build-executor.test.ts`, `test/build-golden.test.ts` + `test/fixtures/build/golden.ts`
- Golden: **four NEW files only.** No existing golden byte changes.

**Interfaces:**
- Produces:
  - `DodResult` gains `readonly status?: "ran" | "refused"` (absent ⇒ `"ran"`, so every record written before this loads unchanged), `readonly refusedBecause?: string`, and `exitCode` becomes `readonly exitCode?: number` with the rule **`status: "ran"` always carries an `exitCode`; `status: "refused"` never does.**
  - `dodRefused(result: DodResult): boolean` and `dodFailureReason(result: DodResult, repo: string): string` — exported from `outcome.ts`, the ONE derivation of the blocked-story sentence.
  - `BaseStatus` keeps its three values; `BaseCommandResult.exitCode` becomes optional under the same rule, and gains `readonly refusedBecause?: string`.

### The measured problem

`dodRunner.ts:220` fabricates `{ command, exitCode: 126, timedOut: false, tail: error.message }` when `runDodCommand` throws `DodCommandRefused`, and `:129-132` does the same on the base side. Nothing ran. That 126 is then rendered as a measurement in three documents: the handoff evidence ledger (`handoff.ts:271-273`, `[src: $ ${command} → exit ${exitCode}]`), the review log (`review.ts:404-406`, `` `- \`cmd\` → exit 126` ``) and the retro log (`retroLog.ts:101-105`, "exited 126 on the first attempt").

Two consumers make this worse and must be fixed in the same change:
- `reviewLedger.ts:253` reads `payload.exit_code` and **defaults to 0 when absent** — so a `check.failed` written without one would be recovered from the ledger as a GREEN DoD result. That is the dangerous direction; it gets its own test.
- `build.ts:1071-1080` and `:1530-1536` build the story's blocked reason as `` `\`cmd\` exited ${exitCode}` `` in two places. Extract `dodFailureReason` and call it from both — two copies of one sentence is exactly what §7's one-derivation rule refuses.

### The golden artifacts this task touches — STATE THESE IN THE COMMIT

**ADDED (four new files, one new scenario):** `test/fixtures/build/golden/refused-developer-S1-1.md`, `refused-events.txt`, `refused-run-tasks.txt`, `refused-exit-codes.txt`.

**CHANGED: none.** The three existing scenarios declare `npm run test`, which is in the fixture's allowlist and splits cleanly, so no existing artifact can move. `bun test test/build-golden.test.ts` must report the three existing scenarios green throughout this task; if it does not, stop.

Note (measured, and worth writing down): a refused command makes the DoD non-green, so the story blocks at `buildHalf` (`build.ts:1069-1084`) BEFORE a reviewer spawns. The new scenario therefore has a developer prompt and no reviewer prompt. The reviewer-prompt rendering of a refused row (`prompts.ts:434-437`) is reachable only through a resumed review whose ledger carries one, so it is pinned by a direct unit test on `buildReviewerPrompt`, not by the golden.

- [ ] **Step 1: Write the failing tests (four of them)**

(a) The runner, in `test/dod-allowlist.test.ts`:

```ts
test("a refused command is recorded as REFUSED — no exit code is invented", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-dod-refused-"));
  const events: { type: string; payload: Record<string, unknown> }[] = [];

  const results = await runStoryDod({
    storyId: "S1",
    repo: "app",
    worktree: dir,
    commands: ["npm run lint"],
    workspaceCommands: new Set(["npm run test"]),
    timeoutMs: 5_000,
    phaseId: "04-build",
    emit: (type, payload) => { events.push({ type, payload }); },
    baseResult: async () => null,
  });

  const only = results[0];
  expect(only?.status).toBe("refused");
  expect(only?.exitCode).toBeUndefined();
  expect(only?.refusedBecause).toContain("not one of");
  expect(dodGreen({ dod: results })).toBe(false);

  const failed = events.find((e) => e.type === "check.failed");
  expect(failed).toBeDefined();
  expect("exit_code" in (failed?.payload ?? {})).toBe(false);
  expect(failed?.payload.refused).toContain("not one of");

  rmSync(dir, { recursive: true, force: true });
});
```

(b) The base side, in `test/dod-preflight.test.ts`:

```ts
test("the base side records a refusal as `unmeasured` with no exit code either", async () => {
  const preflight: BasePreflight = {
    checkedAt: "2026-08-31T09:00:00Z",
    results: [row({ command: "npm run lint", status: "unmeasured", refusedBecause: "needs a shell" })],
  };
  const hit = baseResultFor(preflight, "app", "npm run lint");
  expect(hit?.status).toBe("unmeasured");
  expect(hit?.exitCode).toBeUndefined();
  // `unmeasured` still excuses nothing — the rule this file already pins.
  expect(failedOnBase(hit)).toBe(false);
});

test("a preflight.yml written BEFORE this — `exit_code: 126` + unmeasured — still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-preflight-compat-"));
  mkdirSync(join(dir, "04-build"), { recursive: true });
  writeFileSync(join(dir, PREFLIGHT_REL),
    "version: 1\nchecked_at: '2026-08-31T09:00:00Z'\nresults:\n"
    + "  - repo: app\n    command: npm run lint\n    base_ref: main\n    base_sha: abc1234\n"
    + "    exit_code: 126\n    timed_out: false\n    tail: needs a shell\n    status: unmeasured\n",
    "utf8");
  const loaded = loadPreflight(dir);
  expect(loaded?.results[0]?.status).toBe("unmeasured");
  expect(loaded?.results[0]?.command).toBe("npm run lint");
  rmSync(dir, { recursive: true, force: true });
});

test("a refused row round-trips through the file without growing an exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-preflight-refused-"));
  savePreflight(dir, {
    checkedAt: "2026-09-06T09:00:00Z",
    results: [row({ command: "npm run lint", status: "unmeasured", refusedBecause: "needs a shell" })],
  });
  const back = loadPreflight(dir)?.results[0];
  expect(back?.exitCode).toBeUndefined();
  expect(back?.refusedBecause).toBe("needs a shell");
  rmSync(dir, { recursive: true, force: true });
});
```

`row(...)` is the file's existing fixture builder — read it and make `exitCode` optional there rather than adding a second builder.

(c) The dangerous-direction guard, in `test/build-executor.test.ts` (or the review-ledger test file if one owns `readReviewLedger` — grep first and put it beside its siblings):

```ts
test("a refused check recovered from the ledger is NOT read as exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-ledger-refused-"));
  writeFileSync(join(dir, "events.jsonl"),
    `${JSON.stringify({
      ts: "2026-09-06T09:00:00Z", run: "260906-x", stage: "build", type: "check.failed",
      actor: "facilitator", cost_usd: 0,
      payload: { phase: "04-build", check: "dod", story: "S1", command: "npm run lint",
                 refused: "`npm run lint` is not one of .tldrx/workspace.yml's commands." },
    })}\n`, "utf8");

  const ledger = readReviewLedger(dir, "S1");
  const only = ledger.dod[0];
  expect(only?.status).toBe("refused");
  expect(only?.exitCode).toBeUndefined();
  expect(dodGreen({ dod: ledger.dod })).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
```

(d) The three renderers, in `test/build-executor.test.ts`, over one `StoryOutcome` fixture with a refused row (reuse the file's existing outcome builder):

```ts
test("the three documents print `refused:` and never an `[src: $ … → exit 126]`", () => {
  const outcome = outcomeWith({
    dod: [{ command: "npm run lint", status: "refused", timedOut: false, tail: "",
            refusedBecause: "`npm run lint` is not one of .tldrx/workspace.yml's commands." }],
    status: "blocked",
  });

  const handoff = renderBuildHandoff(handoffPartsFor([outcome]));
  const log = renderReviewLog(outcome);
  const retro = storyRetroLines(outcome, "04-build/log/S1.md").join("\n");

  for (const text of [handoff, log, retro]) {
    expect(text).not.toContain("exit 126");
    expect(text).not.toContain("exited 126");
    expect(text).toContain("refused");
  }
  // The handoff's row still ends in a legal `[src: …]` token — the grammar is
  // the gate, and `$ cmd → exit n` is not available to a command that never ran.
  const row = handoff.split("\n").find((line) => line.includes("npm run lint")) ?? "";
  expect(endsWithToken(row)).toBe(true);
});
```

- [ ] **Step 2: Run all four and keep the RED verbatim**

```
bun test test/dod-allowlist.test.ts -t "recorded as REFUSED"
bun test test/dod-preflight.test.ts -t "no exit code either"
bun test test/build-executor.test.ts -t "NOT read as exit 0"
bun test test/build-executor.test.ts -t "never an \`[src"
```

Expected: four failures — the first two on `expect(received).toBe(expected)` with `received: 126`, the third with `received: 0`, the fourth on `toContain("exit 126")` matching. Keep every verbatim block.

- [ ] **Step 3: Grow `DodResult` and add the two derivations**

`src/core/build/outcome.ts` — replace `:37-43` with:

```ts
export interface DodResult {
  readonly command: string;
  /**
   * `ran` ⇒ the command was spawned and this row is a MEASUREMENT. `refused` ⇒
   * the gate declined to run it (not on `.tldrx/workspace.yml`'s allowlist, or
   * it needs a shell this gate does not open), so nothing ran and there is no
   * exit code to report.
   *
   * ADDITIVE and optional: absent means `ran`, which is every record written
   * before this field existed. The invariant readers may rely on is `ran`
   * carries an `exitCode` and `refused` never does — until 2026-09-06 a refusal
   * was written as a fabricated `exitCode: 126` and three documents rendered
   * that fabrication as a measured exit (#165).
   */
  readonly status?: "ran" | "refused";
  /** Present only on `refused`: the gate's own sentence, verbatim. */
  readonly refusedBecause?: string;
  /** The measured exit. Absent — and only ever absent — when `status` is `refused`. */
  readonly exitCode?: number;
  readonly timedOut: boolean;
  /** Last meaningful line of the combined output — the operator's first clue. */
  readonly tail: string;
}

/** True when the gate DECLINED to run this command. Absent status means it ran. */
export function dodRefused(result: Pick<DodResult, "status">): boolean {
  return result.status === "refused";
}
```

`dodGreen` (`:155-157`) becomes:

```ts
export function dodGreen(outcome: Pick<StoryOutcome, "dod">): boolean {
  return outcome.dod.length > 0
    && outcome.dod.every((r) => !dodRefused(r) && r.exitCode === 0 && !r.timedOut);
}
```

and the blocked-story sentence gets its ONE home, in the same file:

```ts
/**
 * Why a story blocked on its Definition of Done — one sentence, one derivation.
 *
 * Two call sites in the executor built this string independently
 * (`buildHalf` and `pipelineFromDod`); a refusal has to read differently from a
 * red exit in both, and two copies of one sentence is how they stop agreeing.
 */
export function dodFailureReason(result: DodResult, repo: string): string {
  if (dodRefused(result)) {
    return `\`${result.command}\` was REFUSED in repo ${repo} and never ran — `
      + `${result.refusedBecause ?? "the gate declined to run it"}`;
  }
  return `\`${result.command}\` exited ${String(result.exitCode ?? "?")} in repo ${repo}`
    + `${result.timedOut ? " (timed out)" : ""} — ${result.tail}`;
}
```

- [ ] **Step 4: Stop fabricating, on both sides**

`dodRunner.ts` — `runStoryDod` (`:215-237`) becomes:

```ts
    let result: DodResult;
    try {
      const outcome = await runDodCommand(command, parts.worktree, timeoutMs, parts.workspaceCommands);
      result = {
        command,
        status: "ran",
        exitCode: outcome.timedOut ? 124 : outcome.exitCode,
        timedOut: outcome.timedOut,
        tail: outcome.tail,
      };
    } catch (error) {
      if (!(error instanceof DodCommandRefused)) throw error;
      // NOTHING RAN. There is no exit code, so none is written — a fabricated
      // 126 was rendered as a measurement by three documents (#165).
      result = { command, status: "refused", refusedBecause: error.message, timedOut: false, tail: "" };
    }
    results.push(result);
    const green = !dodRefused(result) && result.exitCode === 0 && !result.timedOut;
    parts.emit(green ? "check.passed" : "check.failed", {
      phase: parts.phaseId,
      check: "dod",
      story: parts.storyId,
      command,
      ...(dodRefused(result) ? {} : { exit_code: result.exitCode }),
      ...(dodRefused(result) ? { refused: result.refusedBecause ?? "" } : {}),
      detail: green ? "" : (result.refusedBecause ?? result.tail),
    });
```

The rest of the loop (`:238-249`, the base attribution and the `break`) is unchanged — a refused command still asks the base side, and the base side still refuses nothing.

`baseResultOf`'s catch (`:124-133`) becomes:

```ts
  } catch (error) {
    if (!(error instanceof DodCommandRefused)) throw error;
    // The gate would not run it, so nothing was learned ABOUT THE BASE — and no
    // exit code is invented to say so. `unmeasured` is the status that already
    // means this, and it still refuses nothing and excuses nothing.
    measured = {
      repo, command, baseRef, baseSha, timedOut: false,
      tail: error.message, refusedBecause: error.message,
      status: "unmeasured", commandHash: hash,
    };
  }
```

- [ ] **Step 5: Make the preflight file tolerate both shapes**

`preflight.ts`:
- `BaseCommandResult.exitCode` → `readonly exitCode?: number;` with the same "`unmeasured` carries none" docstring rule, plus `readonly refusedBecause?: string;` (ADDITIVE, optional).
- `emitPreflightYaml`: emit `exit_code` only when it is a number; emit `refused_because` only when set.
- `parsePreflight` (`:150-170`): the current rule drops a row whose `exit_code` is not a number (`:154-155`). Change it to drop a row only when `repo`/`command` are empty; keep `exitCode` when it parses as a number, and require nothing of it otherwise. Read `refused_because` into `refusedBecause` when non-empty. **An OLD row (`exit_code: 126`, `status: unmeasured`) must still load with its 126 intact** — it is a record of what the file said, and rewriting history is not this change's job; test (b) pins that.
- `baseFailureLine` (`:315-321`) is only ever called for `status: "failed"` rows (`redBaseRefusal` filters at `:182`), which always carry an exit code — but make it total anyway: `result.exitCode === undefined ? "was refused and never ran" : \`exited ${String(result.exitCode)}\``.
- `preExistingFailureReason` (`:339`) is likewise `failed`-only; leave it, but assert the narrowing with `result.exitCode ?? 0` only if the compiler forces it — prefer a `?? "?"` in the string over a fake zero.

- [ ] **Step 6: Fix the four readers and the three renderers**

- `reviewLedger.ts:252-260`:

  ```ts
      if (payload.check === "dod" && typeof payload.command === "string") {
        const refused = typeof payload.refused === "string" && payload.refused !== "";
        const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : null;
        current.push({
          command: payload.command,
          // A refused check has no exit code, and defaulting one to 0 would
          // recover a command that never ran as a GREEN one (#165).
          ...(refused
            ? { status: "refused" as const, refusedBecause: payload.refused as string }
            : { status: "ran" as const, ...(exitCode === null ? {} : { exitCode }) }),
          timedOut: exitCode === 124,
          tail: typeof payload.detail === "string" ? payload.detail : "",
        });
        continue;
      }
  ```

  A pre-#165 event (`exit_code: 126`, no `refused`) still loads as a `ran` row with exit 126 — the file said that, and the reader reports what the file says.

- `handoff.ts` `ledger()` (`:268-287`): the measured row keeps its `[src: $ cmd → exit n]` byte for byte. The refused row becomes

  ```ts
        rows.push(
          dodRefused(result)
            ? `- ${outcome.id}: \`${result.command}\` in ${outcome.repo} was REFUSED and never ran — `
              + `${result.refusedBecause ?? "the gate declined to run it"} [src: ${outcome.reviewRel}:1]`
            : `- ${outcome.id}: \`${result.command}\` in ${outcome.repo} `
              + `[src: $ ${result.command} → exit ${String(result.exitCode)}]`,
        );
  ```

  The citation is the review log and not a `cmd` token, deliberately: `src/core/text/srcToken.ts:10` defines `cmd := "$ " command " → exit " digit+`, so a command that never ran has no legal `cmd` citation, and the log is where its refusal is written verbatim. This is the same shape the `dodUnrecovered` rows already use (`handoff.ts:276-280`).

- `review.ts:404-406`: `` `- \`${r.command}\` → REFUSED, never ran — ${r.refusedBecause}` `` for a refused row; the measured row's line is unchanged.

- `retroLog.ts:98-106`: skip the `exitCode === 0` guard for refused rows and write `` `- \`S1\` — dod \`cmd\` was REFUSED and never ran on the first attempt: <why> <src>` ``.

- `prompts.ts`: `ReviewerPromptParts.dodResults` (`:267`) becomes `readonly { command: string; exitCode?: number; status?: "ran" | "refused"; refusedBecause?: string }[]`; the render at `:434-437` prints `` `- \`cmd\` → REFUSED, never ran` `` for a refused row. `reviewRound.ts:213` passes the four fields through. Add a direct unit test on `buildReviewerPrompt` asserting the refused line, since the golden cannot reach it.

- `reviewBundle.ts:147` and `pending.ts:263`: `PendingReview.dod` rows become `{ command: string; exit_code?: number; refused?: string }` (ADDITIVE — `exit_code` optional, `refused` new). `reviewWorkFromBundle` (`:255-260`) reads them back into the new `DodResult` shape and must not default a missing `exit_code` to anything.

- `build.ts:1071-1080` and `:1530-1536`: replace both hand-built sentences with `dodFailureReason(failing, story.planned.story.repo)`, importing it from `../../build/outcome.ts`. The `failing` finder becomes `dod.find((r) => dodRefused(r) || r.exitCode !== 0 || r.timedOut)`.

- [ ] **Step 7: Change the two 126 pins, with their RED kept**

`test/dod-preflight.test.ts:318` and `:420` construct fixture rows as `row({ exitCode: 126, status: "unmeasured", tail: "needs a shell" })`. Change both to `row({ status: "unmeasured", refusedBecause: "needs a shell", tail: "needs a shell" })` and drop the `exitCode`. Both assertions around them (`failedOnBase(...) === false`, "an unmeasured row is not re-probed") must still pass — they are about `status`, not about the number, and that is the point.

Run: `bun test test/dod-preflight.test.ts` → PASS.

- [ ] **Step 8: Add the FOURTH golden scenario**

In `test/fixtures/build/golden.ts`:

```ts
/**
 * A story whose DoD command the gate will not run — the fourth scenario (#165).
 *
 * `npm run lint` is NOT in the fixture workspace's `commands:` (which declares
 * `npm run test` only), so `runDodCommand` refuses it before anything spawns.
 * Nothing ran, so the capture is what an ABSENCE looks like end to end: a
 * `check.failed` with no `exit_code` and a `refused` sentence, a story blocked
 * with a reason that says REFUSED, and one developer task row. No reviewer is
 * spawned — a red DoD blocks the story before the review (build.ts:1069) — so
 * this scenario is exactly the one the other three cannot stand in for.
 *
 * It also covers the BASE side: the Build-entry pre-flight probes the same
 * command and records it `unmeasured`, refusing nothing.
 */
export const GOLDEN_REFUSED: BuildWorkspaceOptions = {
  stories: [{ id: "S1", epic: "E1", title: "First story", dod: ["npm run lint"] }],
  epics: [{ id: "E1", stories: ["S1"], branch: "epic/e1" }],
  waves: [["S1"]],
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

export async function captureRefusedBuild(
  ws: BuildWorkspace,
  promptDir: string,
): Promise<CapturedRefused> {
  const headless = await next(ws, { mode: "headless" });
  const machine = machineOf(ws);
  return {
    developerPrompt: scrubPaths(readFileSync(join(promptDir, "developer-S1-1.md"), "utf8"), machine),
    events: eventStream(ws, machine),
    runTasks: taskRows(ws, machine),
    exitCodes: `headless ${String(headless.code)}\n`,
  };
}
```

Update the file header's "THREE fake-agent builds produce eighteen artifacts" sentence to FOUR builds and twenty-two artifacts, and add the scenario to the numbered list — the header is the guard's own account of itself and a stale one is worse than none.

In `test/build-golden.test.ts`, add the fourth test beside its siblings:

```ts
  /**
   * A DoD command the gate REFUSES: nothing runs, and the whole point is that
   * nothing in the record says otherwise. The all-green captures pin no absence
   * at all, and the rounds capture's unhappy paths are both about turns that DID
   * run.
   */
  test("refused: a DoD command the allowlist does not carry blocks the story with no exit code", async () => {
    const { ws, promptDir } = workspace(GOLDEN_REFUSED);

    const got = await captureRefusedBuild(ws, promptDir);

    // The premise: one developer turn and no reviewer — a red DoD blocks the
    // story before the review is asked for.
    expect(readdirSync(promptDir).sort()).toEqual(["developer-S1-1.md"]);
    agrees(got, REFUSED_GOLDEN);
  }, 120_000);
```

Update the test file's own header (`THREE scenarios` → `FOUR scenarios`) with the one-line reason.

- [ ] **Step 9: Generate the four NEW files and read every byte**

Run: `bun test test/build-golden.test.ts`
Expected: the new test fails with `no golden on disk (nothing has been committed for it)` for its four artifacts, and the three existing scenarios PASS.

Then:

```
TLDRX_GOLDEN_UPDATE=1 bun test test/build-golden.test.ts
git status --porcelain test/fixtures/build/golden/
bun test test/build-golden.test.ts
```

Expected: `git status` shows exactly four `??` (untracked, new) entries and NO ` M ` (modified) entry. **A modified existing golden here means this task changed behaviour it did not mean to — stop and find it.** The third command exits 0.

- [ ] **Step 10: Read the new golden by hand**

Run: `cat test/fixtures/build/golden/refused-events.txt`
Expected, and assert it with your eyes before committing: the `check.failed` line's `keys=[...]` contains `refused` and does NOT contain `exit_code`; its payload's `detail` is the refusal sentence; the `task.done` line has `"status":"blocked"`. `refused-run-tasks.txt` holds ONE row (the developer). `refused-exit-codes.txt` is a single `headless <n>` line — record which `n` and say in the commit why that is the right exit family (`src/cli/exitCodes.ts`: a blocked story is not a usage error).

- [ ] **Step 11: The docs note on quoted tokens and `scripts/gate/*.sh`**

In `docs/guide/03-runs-and-gates.md` (or whichever guide page owns the DoD allowlist — grep for `isAllowedDodCommand` / "allowlist" and put it beside the existing prose), add a short subsection stating the two MEASURED facts:

- A QUOTED token in a `commands:` entry is passed to the child as one literal argument (`src/hooks/lib/story.ts:99-112`), so `sh -c "npm run test | tee out.txt"` is already expressible **when the whole string is declared verbatim in `.tldrx/workspace.yml`**. The allowlist is the control; the syntax is not.
- A BARE token carrying `| & ; < > $ \` ( ) { } * ? ~ \` makes the command unsplittable and it is refused. The convention for anything that genuinely needs a shell is a checked-in script — `scripts/gate/<slot>.sh` — declared under the repo's `commands:` and cited by the story's `dod` block.
- A refused command is now recorded as refused: no exit code, and the handoff/review/retro say "was REFUSED and never ran".

Mirror it into the docs-site EN and ES pages in Task 8.

- [ ] **Step 12: Gate and commit**

```bash
bun run typecheck
bun test
bun run build
git add -A
git commit -m "$(cat <<'EOF'
fix(build): a refused DoD command is recorded as refused, not as `exit 126` (#165)

`runDodCommand` throwing `DodCommandRefused` was caught and turned into
`{exitCode: 126}` on both the story side (dodRunner.ts:220) and the base side
(:130). Nothing ran — and three documents then rendered that number as a
measurement: the handoff's evidence ledger as `[src: $ cmd → exit 126]`, the
review log as `→ exit 126`, the retro log as "exited 126 on the first attempt".

`DodResult` now carries `status: "ran" | "refused"` and `refusedBecause`, and
`exitCode` is present only on `ran` — absent means nothing ran, which is the
honest record. The `check.failed` event drops `exit_code` and carries `refused`.
The base side records `unmeasured` with no exit code and still excuses nothing.
`dodFailureReason` in outcome.ts is the one derivation of the blocked-story
sentence, replacing two copies in build.ts.

Two readers are fixed in the dangerous direction: `readReviewLedger` defaulted a
missing `exit_code` to 0, which would recover a command that never ran as GREEN;
and `dodGreen` now refuses a refused row explicitly. `version: 1` compatibility
is pinned both ways — an old `preflight.yml` with `exit_code: 126` + unmeasured
still loads, and an old `check.failed` with an exit code still reads as `ran`.

Golden: a FOURTH scenario is ADDED (refused-*.md/.txt, four new files). No
existing golden byte changed — the other three scenarios declare `npm run test`,
which is allowlisted and splits.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 4: #164 — the dirty-tree refusal prints the command, and the true reason

**Files:**
- Modify: `src/core/build/branchClaims.ts` — `dirtyRepoRefusal` (`:124-163`) and its docstring
- Modify: `src/core/facilitator/executors/build.ts` — the `dirtyRepoRefusal` call site (grep `dirtyRepoRefusal(`)
- Test: `test/build-executor.test.ts` (`:1339` "a dirty repo is refused before anything is cut, and says what to do", `:1382` "single-repo: a product file still refuses…")

**Interfaces:**
- Consumes: `ClaimParts.runId` — `dirtyRepoRefusal`'s `parts` widens from `Pick<ClaimParts, "root" | "workspace">` to `Pick<ClaimParts, "root" | "workspace" | "runId">`. The executor already holds `runId` (it passes `parts.runId` to `foreignEpicRefusal`), so the call site gains one field.

### The measured problem

`branchClaims.ts:157` prints `` `Commit or stash them in ${rel}/, then run \`tldrx next\` again.` `` — a verb, never the command. And the docstring at `:124-127` gives a reason that is not the reason: "the epic branch is cut from that tree's branch and `git worktree add` would carry the mess forward". A `git worktree add` does not carry an unstaged working tree. The real reason (spec §1.4, and `dodRunner.ts:152-161` says it in its own words) is that **the base pre-flight runs in the repo's own checkout** — it needs a product-clean tree there to mean anything.

- [ ] **Step 1: Write the failing test**

Extend the two existing tests rather than adding a third — they already produce the refusal:

```ts
  test("a dirty repo is refused before anything is cut, and says what to do", async () => {
    const ws = workspace(TWO_WAVES);
    writeFileSync(join(ws.repoDir, "README.md"), "# app\n\nuncommitted\n", "utf8");

    const outcome = await next(ws);
    expect(outcome.code).toBe(2);
    const text = outcome.lines.join("\n");
    expect(text).toContain("uncommitted change(s)");
    // The literal, runnable commands — not the verb. A message that names a verb
    // makes the operator compose the command, and this one has a run-specific
    // stash message in it.
    expect(text).toContain(`git -C ${ws.repoDir} stash push -u -m "tldrx ${ws.runId} foreign work"`);
    expect(text).toContain(`git -C ${ws.repoDir} stash pop`);
    // And the true reason: the base pre-flight runs in THIS checkout.
    expect(text).toContain("the base pre-flight runs in this checkout");
    expect(text).not.toContain("worktree add");
    // Nothing was cut.
    expect(() => git(ws, ["rev-parse", "--verify", "epic/e1"])).toThrow();
    expect(story(ws, "S1")).toContain("status: todo");
  });
```

Add the same three assertions to the `single-repo: a product file still refuses` test at `:1382`, keeping its existing `not.toContain(PROJECT_WORK_DIR)` assertions intact.

- [ ] **Step 2: Run it and keep the RED verbatim**

Run: `bun test test/build-executor.test.ts -t "a dirty repo is refused before anything is cut"`
Expected: FAIL on `toContain` — the received text carries `Commit or stash them in ./`.

- [ ] **Step 3: Rewrite the refusal and the docstring**

`branchClaims.ts:124-135`, the docstring — replace the false reason:

```ts
/**
 * Spec §5, Build executor safety: a repo whose tree is dirty is refused BEFORE
 * anything is cut.
 *
 * **The reason, corrected 2026-09-06 (#164).** This used to say the refusal was
 * because `git worktree add` would carry the mess forward. It would not — a new
 * worktree is a fresh checkout and does not inherit an unstaged tree or an
 * index. The real reason is that the #41 base pre-flight runs the workspace's
 * gate commands IN THE REPO'S OWN CHECKOUT (`build/dodRunner.ts` —
 * deliberately, because that is the tree with the installed dependencies), so
 * uncommitted product changes there are silently INSIDE the measurement that
 * decides whether a story's red DoD is the story's fault or the base's.
 *
 * PRODUCT dirt only. `tldrx-work/` and `.tldrx/` are the framework's own state,
 * and in a `root_is_repo: true` workspace they sit inside the product repo — so
 * counting them made this command refuse the files it had just written itself.
 *
 * The refusal prints the two literal commands, with this run's id in the stash
 * message, and does NOT stash anything itself: a framework-owned stash that a
 * crash mid-wave left behind would strand somebody's work in a place they did
 * not put it (the #129 shape). The operator's tree stays the operator's.
 */
```

`:152-160`, the lines:

```ts
    return { ignored, refusal: {
      lines: [
        `[tldrx] build: repo \`${name}\` has ${String(dirty.length)} uncommitted change(s) on ` +
          `\`${branch}\` — refusing to cut an epic branch from a dirty tree.`,
        `  ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? `, +${String(dirty.length - 5)} more` : ""}`,
        "  Why: the base pre-flight runs in this checkout, so uncommitted product changes here",
        "  land inside the measurement that decides whether a red DoD is the story's fault.",
        "  Commit them, or set them aside and take them back afterwards:",
        `    git -C ${dir} stash push -u -m "tldrx ${parts.runId} foreign work"`,
        `    tldrx next`,
        `    git -C ${dir} stash pop`,
      ],
      error: `repo \`${name}\` has uncommitted changes`,
    } };
```

`error` is unchanged — it is the one-line `stage.error` and several assertions read it.

Widen the signature to `parts: Pick<ClaimParts, "root" | "workspace" | "runId">` and pass `runId` at the call site in `build.ts`.

`relative` (imported at `:5`) may become unused once `dir` is printed absolutely — if so, remove the import; `bun run typecheck` will tell you, and an unused import is a lint failure waiting for someone else.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/build-executor.test.ts -t "dirty"`
Expected: PASS, all dirty-tree tests green.

- [ ] **Step 5: Prove the golden did not move**

Run: `bun test test/build-golden.test.ts` → PASS. (No golden scenario starts dirty; this must stay true.)

- [ ] **Step 6: Gate and commit**

```bash
bun run typecheck
bun test
git add -A
git commit -m "$(cat <<'EOF'
fix(build): the dirty-tree refusal prints the commands, and the reason it gives is true (#164)

Two things were wrong with one message. It said "Commit or stash them in <dir>/"
— a verb, leaving the operator to compose a command whose stash message it
cannot guess. And the guard's docstring gave a reason that is not the reason:
`git worktree add` does not carry an unstaged tree forward. The real reason is
that the #41 base pre-flight runs the gate commands in the repo's OWN checkout,
so uncommitted product changes there sit inside the measurement that decides
whether a story's red DoD is the story's fault or the base's.

The refusal now prints `git -C <dir> stash push -u -m "tldrx <run> foreign work"`,
`tldrx next` and the matching `stash pop`, and states the corrected reason. It
still stashes nothing itself — a framework-owned stash stranded by a crash
mid-wave is the #129 shape, and the operator's tree stays the operator's.

No flag was added; `stage.error` is unchanged; no golden byte moved.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 5: #166 — the reviewer diffs the epic as it was BEFORE the merge

**Files:**
- Modify: `src/core/facilitator/executors/build.ts` — `settleHalf` (`:1104-1142`), `reviewAndSettle` (`:1155-1210`), `spawnReviewer` / `reviewerPrompt` (`:1949-1966`), `handOffReview`, `rereview` (`:1477-1497`), `settle`'s `task.done` emit (`:2134-2142`)
- Modify: `src/core/build/reviewRound.ts` (`ReviewerPromptParts` `:172-189`, `reviewerPromptFor` `:200-235`), `src/core/build/prompts.ts` (`ReviewerPromptParts` `:259-306`, `buildReviewerPrompt` `:406-408`), `src/core/build/reviewBundle.ts` (`ReviewBundleParts`, `writeReviewBundle` `:134-148`, `ReviewWork`, `reviewWorkFromBundle` `:246-262`, `reviewWorkFromLedger`, `resumableReview` `:305-312`), `src/core/build/reviewLedger.ts` (`ReviewLedger`, the `task.done` branch `:225-237`), `src/core/facilitator/pending.ts` (`PendingReview` `:249-266`)
- Test: `test/review-handshake.test.ts`, `test/build-executor.test.ts`, `test/build-golden.test.ts` + `test/fixtures/build/golden.ts` (a new normaliser)
- Golden (bytes WILL change — named below): `headless-reviewer-prompt.md`, `insession-reviewer-prompt.md`, `insession-bundle-prompt.md`, `rounds-reviewer-S1-1.md`, `rounds-reviewer-S1-2.md`, `headless-events.txt`, `insession-events.txt`, `rounds-events.txt`

**Interfaces:**
- Produces:
  - `ReviewerPromptParts.diffBase?: string` (both copies: `reviewRound.ts` and `prompts.ts`). **Absent ⇒ `epicBranch`**, which is today's bytes exactly.
  - `PendingReview.epic_base?: string` (additive) and `ReviewWork.epicBase?: string`.
  - `task.done` payload gains `epic_base` (additive; absent on every event written before this).
  - `ReviewLedger.epicBase: string | null`.

### The measured problem

`build.ts:1130-1142`: `commitsBetween` is measured, `mergeIntoEpic` runs, and only THEN `reviewAndSettle` spawns the reviewer. The prompt renders `diffCommand(parts.epicBranch, parts.branch)` (`prompts.ts:408`) → `git diff <epic>...<story>`, which is empty once the story is an ancestor. The code says so itself at `build.ts:1126-1129`: "once the story branch is an ancestor of the epic, `git diff <epic>...<story>` is empty whether it carried thirty commits or none." The epic sha before the merge is recorded nowhere.

### The golden artifacts this task changes — STATE THESE IN THE COMMIT

Five prompt files (every reviewer prompt and the bundle prompt) gain a sha in place of a branch name on the `git diff` line; three event streams gain an `epic_base` key on `task.done`. Because a sha is machine-nondeterministic, the prompt normaliser must learn to scrub it FIRST (Step 3) — otherwise the golden becomes unstable and this guard starts lying. List the eight files in the commit and diff them one by one.

`headless-run-tasks.txt`, `insession-run-tasks.txt`, `rounds-run-tasks.txt`, `refused-*` and the exit-code files must NOT move.

- [ ] **Step 1: Write the failing tests**

(a) The diff base, in `test/build-executor.test.ts`:

```ts
test("the reviewer is asked to diff the epic as it was BEFORE the merge (#166)", async () => {
  const ws = workspace(ONE_STORY);
  const promptDir = join(ws.root, "prompts");
  mkdirSync(promptDir, { recursive: true });
  process.env.FAKE_BUILD_PROMPT_DIR = promptDir;

  await next(ws);

  const prompt = readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8");
  const diffLine = prompt.split("\n").find((line) => line.includes("git diff")) ?? "";
  // A sha, not the branch name: `git diff epic/e1...story/...` is EMPTY once the
  // story is an ancestor of the epic, which it is by the time the reviewer runs.
  expect(diffLine).not.toContain("epic/e1...");
  expect(diffLine).toMatch(/git diff [0-9a-f]{7,40}\.\.\./);

  // And the range is non-empty in the real repo — the whole point.
  const range = /git diff (\S+)/.exec(diffLine)?.[1] ?? "";
  const out = execFileSync("git", ["diff", "--name-only", range], { cwd: ws.repoDir, encoding: "utf8" });
  expect(out.trim()).not.toBe("");
});
```

(b) The tool allowance, in the same file (a cheap test that would have caught a whole class of mistake):

```ts
test("the sha-form diff command is still inside the reviewer's `Bash(git diff *)` allowance", () => {
  const command = diffCommand("0123456789abcdef0123456789abcdef01234567", "story/260829-build/S1");
  const pattern = REVIEWER_TOOLS.find((tool) => tool.startsWith("Bash("));
  expect(pattern).toBe("Bash(git diff *)");
  // The allowance is a prefix-glob: everything after `git diff ` is the wildcard.
  expect(command.startsWith("git diff ")).toBe(true);
});
```

(c) Recovery, in `test/review-handshake.test.ts`, added to the `--prepare on a story awaiting review` and `re-review` describes:

```ts
  test("the bundle records the epic base, so `--commit --review` reviews the same range", async () => {
    const ws = workspace(ONE_STORY_ATTENDED);
    await prepareAndAnswerDeveloper(ws);
    await next(ws, { mode: "commit" });

    const pending = JSON.parse(readFileSync(
      join(ws.runDir, ".agent", "build", "S1", "review", "pending.json"), "utf8",
    )) as { review?: { epic_base?: string; diff?: string } };

    expect(pending.review?.epic_base).toMatch(/^[0-9a-f]{7,40}$/);
    expect(pending.review?.diff).toContain(pending.review?.epic_base ?? "NOPE");
  });

  test("a re-review recovers the epic base from the ledger rather than diffing an empty range", async () => {
    // Reuse this file's errored-review fixture; assert the SECOND reviewer prompt's
    // diff line carries the same sha the first one did.
    const first = readFileSync(join(promptDir, "reviewer-S1-1.md"), "utf8");
    const second = readFileSync(join(promptDir, "reviewer-S1-2.md"), "utf8");
    const shaOf = (text: string) => /git diff (\S+)\.\.\./.exec(text)?.[1] ?? "";
    expect(shaOf(second)).toBe(shaOf(first));
    expect(shaOf(second)).not.toBe("");
  });
```

Adapt the helper names to whatever `test/review-handshake.test.ts` already uses (read `:173-260` and `:464-506`); do not invent fixtures it does not have.

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/build-executor.test.ts -t "BEFORE the merge"
bun test test/review-handshake.test.ts -t "records the epic base"
```
Expected: the first fails on `expect(received).not.toContain("epic/e1...")`; the second on `expect(undefined).toMatch(...)`.

- [ ] **Step 3: Teach the golden normaliser to scrub shas inside PROMPT files — BEFORE the behaviour change**

This step lands first because without it the next step makes the golden machine-dependent. In `test/fixtures/build/golden.ts`, `scrubPaths` (`:372-377`) is the only normalisation a prompt gets. Add the sha pass to the prompt path:

```ts
/**
 * The one normalisation a prompt gets: the temp workspace root — and, since
 * #166, commit shas, because a reviewer prompt now names the epic's sha before
 * the merge instead of the epic BRANCH (a branch name is deterministic; a sha is
 * not).
 *
 * The same verified rule the event/task normaliser uses, applied to text rather
 * than to values: only a >= 7-char prefix of a sha `git rev-list --all` reports
 * in THIS fixture repo is replaced, so a hex-looking word that is not a commit
 * here stays raw. `scrubFullShas` handles the 40-char form; the short form is
 * matched with a word boundary so `abc1234` inside a longer token is untouched.
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
```

Route every prompt capture through `scrubPrompt` instead of `scrubPaths` — `captureHeadlessBuild` (`:238-239`), `captureInSessionBuild` (`:268-272`), `captureRoundsBuild` (`:295-296`), `captureRefusedBuild` (Task 3). Update the header's normalisation table row for prompts, naming #166 as the reason.

Run: `bun test test/build-golden.test.ts`
Expected: still PASS. **The normaliser must be a no-op today** — no prompt currently contains a sha (measured: the header's table says the only nondeterministic byte in a prompt is the root path). If it goes red now, the normaliser is over-reaching and must be narrowed before anything else happens.

Commit this step ON ITS OWN so the "no-op today" property is visible in history:

```bash
bun run typecheck
bun test test/build-golden.test.ts
git add test/fixtures/build/golden.ts
git commit -m "test(golden): the prompt normaliser learns to scrub verified shas (no-op today, needed by #166)"
```
(with the two trailers).

- [ ] **Step 4: Capture the sha and thread `diffBase` through**

In `build.ts` `settleHalf` (`:1128-1142`), immediately before the merge:

```ts
    const carried = await commitsBetween(story.repoDir, story.epicBranch, story.branch);
    // The epic AS IT WAS. Captured here and nowhere else: after the merge the
    // story branch is an ancestor, and `git diff <epic>...<story>` — the command
    // the reviewer's prompt hands it — is empty whether the story carried thirty
    // commits or none (#166). `""` when git had no answer, which renders the
    // branch name exactly as it did before this existed.
    const epicBase = await shaOf(story.repoDir, story.epicBranch);
    const merge = await this.mergeIntoEpic(story);
```

Pass `epicBase` into `reviewAndSettle` as a new parameter (`epicBase: string | null`), from `settleHalf` (`:1142`) and from `rereview` (`:1497`, where it comes from the ledger — see Step 6). Thread it into `spawnReviewer` → `reviewerPrompt` → `reviewerPromptFor({ ..., diffBase: epicBase })`, into `handOffReview` → `writeReviewBundle`, and into `settle`'s `task.done` payload.

`reviewRound.ts` `ReviewerPromptParts` gains:

```ts
  /**
   * What the reviewer's `git diff` starts FROM — the epic's sha immediately
   * before this story was merged into it (#166).
   *
   * ADDITIVE and optional. Absent, null or empty ⇒ `epicBranch`, which is
   * byte-for-byte the prompt this rendered before the field existed: a story
   * reviewed out of a bundle written by an older binary reads exactly as it did.
   */
  readonly diffBase?: string | null;
```

`reviewerPromptFor` passes it straight through; `prompts.ts`'s `ReviewerPromptParts` gains the same field with the same docstring, and `buildReviewerPrompt:408` becomes:

```ts
  const base = parts.diffBase === undefined || parts.diffBase === null || parts.diffBase === "" 
    ? parts.epicBranch 
    : parts.diffBase;
  const diff = diffCommand(base, parts.branch);
```

`diffCommand` (`git.ts:521`) is UNCHANGED — one derivation, and a sha and a branch are both refs.

- [ ] **Step 5: Persist it — the bundle and `task.done`**

`pending.ts` `PendingReview` gains:

```ts
  /**
   * The epic's sha immediately before this story merged — what `diff` above is
   * computed from (#166). ADDITIVE and optional: absent on every bundle written
   * before this existed, and a reader that finds none falls back to
   * `epic_branch`, which is what those bundles meant.
   */
  readonly epic_base?: string;
```

`writeReviewBundle` (`reviewBundle.ts:134-148`) writes `epic_base` when it has one and computes `diff: diffCommand(parts.epicBase ?? parts.epicBranch, parts.branch)` — so the bundle's recorded command and the prompt's command are the same string, which is the property the handshake's whole claim rests on.

`settle`'s `task.done` emit (`build.ts:2134-2142`) gains `...(epicBase === null || epicBase === "" ? {} : { epic_base: epicBase })`. Additive and omitted when unknown — never an empty string in the ledger.

- [ ] **Step 6: Recover it on both resume doors**

`reviewLedger.ts`: add `readonly epicBase: string | null;` to `ReviewLedger` (documented as "the epic sha the last `task.done` recorded; null on a run whose Build predates #166"), initialise it in `empty` and in the `story.reopened` reset, and read it in the `task.done` branch (`:225-237`):

```ts
      if (typeof payload.epic_base === "string" && payload.epic_base !== "") epicBase = payload.epic_base;
```

`reviewBundle.ts`: `ReviewWork` gains `readonly epicBase?: string`; `resumableReview` and `reviewWorkFromLedger` fill it from `ledger.epicBase`; `reviewWorkFromBundle` (`:246-262`) fills it from `review.epic_base`. `ResumableReview` gains it too, and `build.ts`'s `rereview` (`:1497`) passes `resume.epicBase ?? null` into `reviewAndSettle`.

**The fallback is the point**: a run whose ledger has no `epic_base` — every run built before this change — gets `null`, renders the branch name, and behaves exactly as it does today. Pin that with a test that feeds `readReviewLedger` an events file with a `task.done` carrying no `epic_base` and asserts `epicBase === null` and a prompt containing `epic/e1...`.

- [ ] **Step 7: Run the tests**

```
bun test test/build-executor.test.ts -t "BEFORE the merge"
bun test test/build-executor.test.ts -t "Bash(git diff"
bun test test/review-handshake.test.ts
```
Expected: all PASS.

- [ ] **Step 8: Move the golden, deliberately**

Run: `bun test test/build-golden.test.ts`
Expected: FAIL naming exactly the eight artifacts listed above. Read the list. A ninth → stop.

```
TLDRX_GOLDEN_UPDATE=1 bun test test/build-golden.test.ts
git diff test/fixtures/build/golden/
bun test test/build-golden.test.ts
```

Expected in the diff, and check every hunk: each prompt's `    git diff …` line changes from `git diff epic/e1...story/260829-build/S1` to `git diff <SHA>...story/260829-build/S1` and nothing else in that file changes; each event stream's `task.done` line gains `epic_base` in both `keys=[…]` and `payload={…}` with the value `"<SHA>"` — **never a raw hex string**. A raw sha in the golden means the Step 3 normaliser is wrong; fix it and regenerate rather than committing an unstable file.

- [ ] **Step 9: Gate and commit**

```bash
bun run typecheck
bun test
bun run build
git add -A
git commit -m "$(cat <<'EOF'
fix(build): the reviewer diffs the epic as it was before the merge (#166)

The story is merged into the epic BEFORE the reviewer spawns (build.ts:1130),
and the reviewer's prompt asked it to read `git diff <epic>...<story>` — which
is empty once the story is an ancestor. build.ts:1126 said so in its own words
about `carried`, and then the prompt did exactly that anyway. The epic's sha
before the merge was recorded nowhere, so nothing downstream could recover it.

`settleHalf` now captures `shaOf(repo, epicBranch)` immediately before the merge
and threads it as `ReviewerPromptParts.diffBase`, which defaults to `epicBranch`
when absent — so a bundle or ledger from an older binary renders byte-identical
bytes. It is persisted additively on `task.done` as `epic_base` and on the review
bundle's `PendingReview`, so `--prepare --review` and `rereview` recover the same
range instead of re-deriving an empty one. `diffCommand` is unchanged: a sha and
a branch are both refs, and a test pins that the sha form is still inside
`REVIEWER_TOOLS`' `Bash(git diff *)`.

Golden bytes changed, deliberately, in eight artifacts:
  headless-reviewer-prompt.md, insession-reviewer-prompt.md,
  insession-bundle-prompt.md, rounds-reviewer-S1-1.md, rounds-reviewer-S1-2.md
    — the `git diff` line now names <SHA> instead of `epic/e1`
  headless-events.txt, insession-events.txt, rounds-events.txt
    — `task.done` gains the additive `epic_base` key
The prompt normaliser learned to scrub verified shas in a separate, no-op commit
first, so the golden stays machine-independent. No task-row or exit-code golden
moved.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 6: #168 — `command_probes`, beside a `commands:` that stays byte-identical

**Files:**
- Create: `src/core/detect/probeCommands.ts`
- Modify: `src/core/detect/types.ts` (`DetectedRepo`), `src/core/detect/detectWorkspace.ts` (`:64-108`), `src/core/detect/commands.ts` (mark the synthesised rows), `src/core/init/workspaceDocument.ts` (`WorkspaceRepoDocument`, `toRepoDocument`), `src/core/schemas/workspace.ts` (`validateWorkspace`), `src/core/init/validateEmitted.ts`, `src/hooks/lib/workspace.ts` (read it into `WorkspaceContext`), `src/core/build/preflight.ts` (`redBaseRefusal`'s lines may cite a probe)
- Test: `test/detect.test.ts`, `test/init.test.ts`, `test/workspace-schema.test.ts` (grep for the file that owns `validateWorkspace`)

**Interfaces:**
- Produces: `command_probes: { <slot>: { verified: boolean; exit_code: number | null; at: string; reason: string } }` per repo in `.tldrx/workspace.yml`, ADDITIVE and optional. `probeCommands(runner, repoDir, commands, opts) => CommandProbes` from `src/core/detect/probeCommands.ts`.
- **`commands:` is byte-identical.** It is the allowlist; nothing here edits it.

### The measured problem

`tldrx init` writes `commands:` it never ran (`detect/commands.ts` reads manifests only — its own header at `:5-7` says "A command is only recorded when a file on disk declares it; nothing here is conventional wisdom about a stack"), and yet `addGoAndRust` (`:134-143`) SYNTHESISES `go build ./...`, `go test ./...`, `cargo build`, `cargo test` from the language id alone, and `addDotnet` (`:97-100`) does the same for `dotnet build` / `dotnet format --verify-no-changes`. The docstring and the code disagree; the file's claim is the one that is false.

- [ ] **Step 1: Write the failing tests**

In `test/detect.test.ts`:

```ts
describe("command probes", () => {
  test("each of the four gate slots is probed once, through the runner, and `run` never is", async () => {
    const runner = recordingRunner({ exitCode: 0 });
    const probes = await probeCommands(runner, "/repo", {
      build: "npm run build", test: "npm run test", lint: null, typecheck: "npm run typecheck",
      run: "npm run dev",
    }, { at: "2026-09-06T09:00:00Z", timeoutMs: 30_000, synthesised: new Set() });

    expect(runner.calls.map((c) => c.argv.join(" "))).toEqual([
      "npm run build", "npm run test", "npm run typecheck",
    ]);
    // `run` starts a server. It is never probed, and it says so rather than
    // being silently absent.
    expect(probes.run?.verified).toBe(false);
    expect(probes.run?.reason).toContain("not probed");
    expect(probes.build?.verified).toBe(true);
    expect(probes.build?.exit_code).toBe(0);
  });

  test("a non-zero exit is recorded as measured-and-red, not as absent", async () => {
    const runner = recordingRunner({ exitCode: 2 });
    const probes = await probeCommands(runner, "/repo", { test: "npm run test" }, defaults());
    expect(probes.test?.verified).toBe(false);
    expect(probes.test?.exit_code).toBe(2);
    expect(probes.test?.reason).toContain("exited 2");
  });

  test("a timeout writes `verified: false` with the reason and no exit code", async () => {
    const runner = hangingRunner();
    const probes = await probeCommands(runner, "/repo", { test: "npm run test" },
      { ...defaults(), timeoutMs: 20 });
    expect(probes.test?.verified).toBe(false);
    expect(probes.test?.exit_code).toBeNull();
    expect(probes.test?.reason).toContain("timed out");
  });

  test("a SYNTHESISED command says it was synthesised from the language id", async () => {
    const runner = recordingRunner({ exitCode: 0 });
    const probes = await probeCommands(runner, "/repo", { test: "go test ./..." },
      { ...defaults(), synthesised: new Set(["test"]) });
    expect(probes.test?.reason).toContain("synthesised from the language id");
  });

  test("a null slot is absent from the probes, never a guessed row", async () => {
    const probes = await probeCommands(recordingRunner({ exitCode: 0 }), "/repo",
      { test: null }, defaults());
    expect(probes.test).toBeUndefined();
  });
});
```

Write `recordingRunner` / `hangingRunner` / `defaults()` as small local helpers in that file (a `CommandRunner` is one method — `run(argv, cwd)`), and never spawn a real process here: this is a unit test of the probe policy.

In `test/init.test.ts`:

```ts
  test("workspace.yml carries command_probes beside a byte-identical commands map", async () => {
    // <the file's existing init fixture>
    const doc = parseYaml(readFileSync(join(out, WORKSPACE_FILE), "utf8")) as Record<string, unknown>;
    const repo = (doc.repos as Record<string, unknown>[])[0] ?? {};
    expect(repo.commands).toEqual(EXPECTED_COMMANDS);   // unchanged, byte for byte
    const probes = repo.command_probes as Record<string, { verified: boolean; at: string }>;
    expect(Object.keys(probes).sort()).toEqual(["build", "test"]);  // the slots this fixture declares
    expect(probes.test?.at).toBe(FIXED_NOW);
  });

  test("a workspace.yml written before command_probes existed still validates and loads", () => {
    const older = { version: 1, mode: "single", root: ".", repos: [{ name: "app", path: "." }] };
    expect(validateWorkspace(older).ok).toBe(true);
  });
```

- [ ] **Step 2: Run them and keep the RED verbatim**

```
bun test test/detect.test.ts -t "command probes"
bun test test/init.test.ts -t "command_probes"
```
Expected: module-not-found for the first; `expect(undefined)` for the second.

- [ ] **Step 3: Write the probe leaf**

Create `src/core/detect/probeCommands.ts`:

```ts
/**
 * Did the commands `tldrx init` is about to write actually run? (#168)
 *
 * `commands:` is the DoD gate's allowlist and it stays byte-identical — this
 * writes an ADDITIVE sibling, `command_probes:`, saying what was measured about
 * each one. The reason it is needed: `detect/commands.ts` claims in its own
 * header that "nothing here is conventional wisdom about a stack", and then
 * SYNTHESISES `go build ./...`, `cargo test` and `dotnet build` from the
 * language id alone. Those are conventions, and a file that presents them beside
 * a `package.json`-sourced command with no way to tell them apart is a file that
 * cannot be checked.
 *
 * Three rules, each one the difference between a record and a guess:
 *   - `run` is NEVER probed. It starts a server (`dev`/`start`/`dotnet run`) and
 *     a probe of it either hangs or leaves a process behind. Its row says so.
 *   - Everything goes through `CommandRunner`, argv-only, so nothing is ever
 *     string-concatenated into a shell — the same seam detection already spawns
 *     git through.
 *   - Nothing is inferred. A timeout is `verified: false` with `exit_code: null`
 *     and "timed out after Ns"; a non-zero exit is `verified: false` with the
 *     real code. Neither is an absence and neither is a guess.
 */
import { splitArgv } from "../../hooks/lib/story.ts";
import type { CommandRunner } from "./CommandRunner.ts";
import { COMMAND_SLOTS, type CommandSlot } from "./types.ts";

/** The four slots a gate can meaningfully run. `run` starts a server; it is not one. */
export const PROBED_SLOTS: readonly CommandSlot[] = ["build", "test", "lint", "typecheck"];

export interface CommandProbe {
  /** True only when the command ran to completion and exited 0. */
  readonly verified: boolean;
  /** The measured exit code, or null when nothing exited (timeout, unspawnable). */
  readonly exit_code: number | null;
  /** When this probe was taken. */
  readonly at: string;
  /** Why `verified` is what it is — always a sentence, never empty. */
  readonly reason: string;
}

export type CommandProbes = Partial<Record<CommandSlot, CommandProbe>>;

export interface ProbeOptions {
  readonly at: string;
  readonly timeoutMs: number;
  /** Slots whose command came from the language id rather than from a file. */
  readonly synthesised: ReadonlySet<string>;
}

export async function probeCommands(
  runner: CommandRunner,
  repoDir: string,
  commands: Readonly<Partial<Record<CommandSlot, string | null>>>,
  options: ProbeOptions,
): Promise<CommandProbes> {
  const probes: Record<string, CommandProbe> = {};
  for (const slot of COMMAND_SLOTS) {
    const command = commands[slot] ?? null;
    if (command === null || command === "") continue;
    const origin = options.synthesised.has(slot)
      ? " (this command was synthesised from the language id, not read from a file)"
      : "";
    if (!PROBED_SLOTS.includes(slot)) {
      probes[slot] = {
        verified: false, exit_code: null, at: options.at,
        reason: `not probed: \`${slot}\` starts a long-running process${origin}`,
      };
      continue;
    }
    const argv = splitArgv(command);
    if (argv === null) {
      probes[slot] = {
        verified: false, exit_code: null, at: options.at,
        reason: `not probed: \`${command}\` needs a shell and this probe does not open one${origin}`,
      };
      continue;
    }
    const started = Date.now();
    let result: { exitCode: number } | null = null;
    try {
      result = await runner.run(argv, repoDir);
    } catch {
      result = null;
    }
    const timedOut = result === null || Date.now() - started >= options.timeoutMs;
    if (result === null || timedOut) {
      probes[slot] = {
        verified: false, exit_code: null, at: options.at,
        reason: `not verified: \`${command}\` timed out after ${String(Math.round(options.timeoutMs / 1000))}s${origin}`,
      };
      continue;
    }
    probes[slot] = {
      verified: result.exitCode === 0,
      exit_code: result.exitCode,
      at: options.at,
      reason: result.exitCode === 0
        ? `verified: \`${command}\` exited 0${origin}`
        : `not verified: \`${command}\` exited ${String(result.exitCode)}${origin}`,
    };
  }
  return probes;
}
```

The probe's timeout is the runner's: construct the probing runner as `new SpawnCommandRunner(PROBE_TIMEOUT_MS)` at the call site (`SpawnCommandRunner`'s constructor already takes one — `CommandRunner.ts:22`). Pick `PROBE_TIMEOUT_MS = 120_000` and say why in a comment (`init` is already a minutes-long command; a build that cannot finish in two minutes is a fact worth recording, not worth waiting for).

- [ ] **Step 4: Mark the synthesised slots and wire the probe in**

`detect/commands.ts`: `DetectedCommands` gains `readonly synthesised: ReadonlySet<CommandSlot>` — populated by `addGoAndRust` and `addDotnet` (and by `addPython`, which infers from a manifest MENTION and is therefore also a convention: `pytest` in `requirements.txt` does not prove `pytest` runs). `addPackageScripts` and `addMakefile` are NOT synthesised — those read a declaration. `record(...)` grows a fourth argument for it rather than a second map.

`detect/detectWorkspace.ts`: after `detectCommands` (`:65`), probe:

```ts
    const probes = await probeCommands(probeRunner, absPath, commands.commands, {
      at: options.at, timeoutMs: PROBE_TIMEOUT_MS, synthesised: commands.synthesised,
    });
```

`detectWorkspace` currently takes no clock; add `at: string` to `DetectProgress`'s sibling options object (or a fourth parameter with a default) — do NOT call `new Date()` inside the leaf, because `test/init.test.ts` pins a fixed `detected_at` and a second clock in the same document would drift. `DetectedRepo` gains `readonly commandProbes: CommandProbes;`.

`init/workspaceDocument.ts`: `WorkspaceRepoDocument` gains `readonly command_probes?: Readonly<Record<string, CommandProbe>>;`, and `toRepoDocument` writes it only when non-empty (`...(Object.keys(repo.commandProbes).length === 0 ? {} : { command_probes: repo.commandProbes })`). The `commands` block at `:107-113` is untouched.

`schemas/workspace.ts`: validate `command_probes` the way `stack_packs` is validated (`:86-98`) — a mapping whose every value is a mapping with a boolean `verified`, a number-or-null `exit_code`, a string `at` and a string `reason`. Absent is fine. Additive.

`init/validateEmitted.ts`: the projection at `:25-32` passes `repos` through, so a new repo key needs no change — but run the existing init tests to confirm rather than assuming.

`hooks/lib/workspace.ts`: read the probes into `WorkspaceContext` as `readonly commandProbes: ReadonlyMap<string, ReadonlyMap<string, CommandProbe>>` beside `commandRoles` (`:~63` is the allowlist read; `:~213` is `toSrcContext`). **The DoD reads nothing new** — the allowlist is still `commands`, and a probe never permits or refuses anything.

`build/preflight.ts` `baseRefusalLines` (`:328-336`) MAY append one line when the failing command has a probe saying it was already red at init — that is a real help to the operator and costs nothing. Keep it to one line, and only when a probe exists.

- [ ] **Step 5: Run the tests**

```
bun test test/detect.test.ts
bun test test/init.test.ts
bun test test/dod-allowlist.test.ts
```
Expected: all PASS. The third is the one that proves the allowlist did not change meaning.

- [ ] **Step 6: Gate and commit**

```bash
bun run typecheck
bun test
bun run build
git add -A
git commit -m "$(cat <<'EOF'
feat(init): `command_probes` — what init actually ran, beside a commands map it did not change (#168)

`detect/commands.ts` says in its own header that "nothing here is conventional
wisdom about a stack", and then synthesises `go build ./...`, `go test ./...`,
`cargo build`, `cargo test`, `dotnet build` and `dotnet format` from the language
id alone, plus python's tools from a mention in a manifest. Those are exactly
conventional wisdom, and `workspace.yml` presented them beside a
package.json-sourced command with nothing to tell them apart.

`commands:` is BYTE-IDENTICAL — it is the DoD gate's allowlist and this change
does not touch it. The new `command_probes:` sibling records, per slot,
`{verified, exit_code, at, reason}` from probing build/test/lint/typecheck ONCE
through `CommandRunner` with a timeout. `run` is never probed and its row says
why (it starts a server). A timeout is `verified: false`, `exit_code: null` and
"timed out after Ns" — an absence with a reason, never a guess. A synthesised
command's reason says it was synthesised from the language id.

Additive and optional: a `workspace.yml` written before this validates and loads
unchanged, and the DoD gate reads nothing new.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 7: #167 — a PR body written for a PR, and a state refusal that reads `touches:`

**Files:**
- Create: `src/core/run/shipBody.ts`
- Modify: `src/core/run/ship.ts` (`shipRun` `:134-192`, `shipOne` `:202-230`, `shipMany` `:271-290`, `createArgs` `:403-418`, `prepareRepo` `:434-495`, `stateOnBranch` `:509-524`)
- Test: `test/ship.test.ts` (the pins at `:132` "opens the PR from the epic branch with the handoff as the body" and `:267`), `test/ship-multi-repo.test.ts`

**Interfaces:**
- Produces: `renderShipBody(parts: ShipBodyParts): string` from `src/core/run/shipBody.ts`, where

  ```ts
  export interface ShipBodyParts {
    readonly runId: string;
    readonly title: string;
    readonly branch: string;
    /** The handoff text, verbatim — it goes inside the `<details>` block. */
    readonly handoff: string;
    readonly handoffRel: string;
    /** Open fix-list findings, from `build/fixlist.ts`. NEVER re-parsed here. */
    readonly openFindings: readonly { rel: string; finding: FixFinding }[];
  }
  ```

- Consumes: `parseHandoff` (`src/core/text/handoff.ts:70`) for the done/not-done split, and `fixlistRounds` / `latestFixlist` / `openFindings` from `src/core/build/fixlist.ts` (`:621`, `:642`, `:111`). **Call them; never re-parse a fix list here** — `fixlist.ts` is the one implementation.

### The measured problem

`ship.ts:162-170` makes the LAST phase handoff the PR body, and `createArgs:416` passes it as `--body-file`. A Build handoff is a gate document: `## Gate — Blocked on: **human approval**` with operator instructions (`build/handoff.ts:127-140`). And `prepareRepo:474-491` refuses any epic branch that changes `tldrx-work/` or `.tldrx/` — with no allowed move for a story that legitimately edits `.tldrx/workspace.yml`, which is a real story shape.

- [ ] **Step 1: Write the failing tests**

In `test/ship.test.ts`:

```ts
  test("the PR body is written for a PR: what shipped, what did not, open findings, handoff folded away", async () => {
    const ws = workspace();
    readyToShip(ws);
    const transport = healthy();

    await ship(ws, transport);

    const create = transport.calls.find((call) => call.cmd === "gh" && call.args[0] === "pr");
    const bodyFile = create?.args[(create?.args.indexOf("--body-file") ?? -1) + 1] ?? "";
    const body = readFileSync(bodyFile, "utf8");

    // Not the raw gate document.
    expect(body).not.toMatch(/^Blocked on: \*\*human approval\*\*/m);
    expect(body).toContain("## What shipped");
    expect(body).toContain("S1");
    // The handoff is still there, in full, folded away.
    expect(body).toContain("<details>");
    expect(body).toContain("04-build/handoff.md");
    expect(body).toContain("Blocked on: **human approval**");   // inside the <details>
    const details = body.slice(body.indexOf("<details>"));
    expect(details).toContain("Blocked on: **human approval**");
  });

  test("open fix-list findings are listed, and come from fixlist.ts", async () => {
    const ws = workspace();
    readyToShip(ws);
    writeFixlistFixture(ws, "S1", [{ disposition: "fix-now", finding: "the token is logged" }]);

    await ship(ws, healthy());
    const body = readFileSync(bodyFileOf(ws), "utf8");

    expect(body).toContain("## Open findings");
    expect(body).toContain("the token is logged");
  });

  test("a story that DECLARES a .tldrx path in `touches:` excuses it, and the refusal names which story", async () => {
    const ws = workspace();
    readyToShip(ws, { touches: [".tldrx/workspace.yml"], settled: ["S1"] });
    dirtyStatePaths(ws, [".tldrx/workspace.yml"]);

    const outcome = await ship(ws, healthy());
    // The declared path is excused: the ship proceeds.
    expect(outcome.code).toBe(EXIT_OK);
  });

  test("an UNDECLARED state path still refuses, and the message says which story excused which", async () => {
    const ws = workspace();
    readyToShip(ws, { touches: [".tldrx/workspace.yml"], settled: ["S1"] });
    dirtyStatePaths(ws, [".tldrx/workspace.yml", "tldrx-work/260829-x/run.yml"]);

    const outcome = await ship(ws, healthy());
    expect(outcome.code).toBe(EXIT_REFUSED);
    const text = outcome.lines.join("\n");
    expect(text).toContain("tldrx-work/260829-x/run.yml");
    expect(text).toContain("excused by S1");        // the declared one, and by whom
    expect(text).not.toMatch(/^\s+\.tldrx\/workspace\.yml$/m);
  });
```

Build `readyToShip`'s new options and the two helpers from what `test/ship.test.ts` already has — read `:100-200` first and extend its fixtures rather than adding parallel ones.

- [ ] **Step 2: Run them and keep the RED verbatim**

Run: `bun test test/ship.test.ts -t "written for a PR"`
Expected: FAIL — the body IS the handoff, so `toContain("## What shipped")` fails.

- [ ] **Step 3: Write the body leaf**

Create `src/core/run/shipBody.ts` with `renderShipBody`, rendering, in order:

1. `# <title>` and a one-line `Run \`<runId>\` · branch \`<branch>\``.
2. `## What shipped` — the handoff's `## Findings` bullets whose story reached `done`, read via `parseHandoff`. When there are none: `- (nothing settled `done` in this run)`.
3. `## Not done` — the handoff's `## Unknowns` bullets, verbatim, or `- none` when the section is empty. These are the two halves the handoff already computes (`build/handoff.ts:85-86` splits `done` / `notDone`); this reads the rendered document rather than recomputing the split, because the document is what shipped.
4. `## Open findings` — one bullet per `openFindings` entry, each citing its fix-list `rel`. Omit the whole section when there are none. **The findings arrive as a parameter**; `ship.ts` obtains them by calling `fixlistRounds`/`latestFixlist` + `openFindings` from `build/fixlist.ts`.
5. `<details><summary>The full handoff (<rel>)</summary>` + a blank line + the handoff verbatim + `</details>`.

The handoff goes in verbatim and is never edited: it is the gate document, it is cited by other records, and a PR that paraphrases it is a PR that disagrees with the run.

- [ ] **Step 4: Call it from `ship.ts`**

`shipRun` keeps the no-handoff refusal exactly as it is (`:163-170`) — the body still cannot be invented. After it, render the body to a temp file inside the run directory (e.g. `<runDir>/04-build/.ship-body.md`, or `mkdtempSync` — whichever the file's existing temp discipline suggests; do NOT write into the repo, where it would become a diff), and pass THAT path to `createArgs`. `createArgs` itself is unchanged: `--body-file` still takes a path.

The `--dry-run` lines (`:220-228`) currently print `body: <handoff.rel> (<bytes> B)`. Change to name the rendered body and say what it is made of — one line, and keep the four-line shape the test at `:267` and `test/ship-multi-repo.test.ts` assert on.

- [ ] **Step 5: Subtract settled stories' `touches:` from the state refusal**

`stateOnBranch` (`:509-524`) stays exactly as it is — it answers "which of tldrx's own paths did this branch change". The SUBTRACTION happens in `prepareRepo` (`:474`): load the run's stories, take every story whose status is settled (`done`, and `review`/`blocked` do NOT excuse — an unsettled story's declaration is a plan, not a fact), and drop from `state` every path a settled story declares in `touches:` (prefix match on the declared path, since `touches:` may name a directory). Keep a `Map<path, storyId>` while you do it so the refusal can say who excused what.

The refusal's lines change only in the excused case: append

```
  (`.tldrx/workspace.yml` is excused by S1, which declares it in `touches:`)
```

one line per excused path, so the operator can see the subtraction rather than wondering why a path stopped being refused. When nothing is left after the subtraction, there is no refusal at all.

- [ ] **Step 6: Run the tests**

```
bun test test/ship.test.ts
bun test test/ship-multi-repo.test.ts
```
Expected: PASS. The four-line single-repo output the multi-repo test asserts as exact strings must still match; if it does not, you changed a line you were told (`ship.ts:198-201`) not to.

- [ ] **Step 7: Gate and commit**

```bash
bun run typecheck
bun test
bun run build
git add -A
git commit -m "$(cat <<'EOF'
feat(ship): a PR body written for a PR, and a state refusal a story can answer (#167)

`tldrx ship` sent the last phase handoff as the PR body. A Build handoff is a
GATE document — it opens "Blocked on: **human approval**" and carries operator
instructions — so every PR this verb opened led with an instruction to somebody
who was not reading it. And the `.tldrx`/`tldrx-work` state refusal had no
allowed move: a story that legitimately edits `.tldrx/workspace.yml` could not
be shipped at all.

`run/shipBody.ts` builds the body: what shipped and what did not, taken from the
handoff's own done/not-done split; the OPEN fix-list findings, obtained by
CALLING `build/fixlist.ts` rather than re-parsing (one implementation); and the
handoff itself, verbatim and complete, inside a `<details>` block — nothing is
paraphrased and nothing is dropped. The no-handoff refusal is unchanged: the
body still cannot be invented.

The state refusal now subtracts paths a SETTLED story declares in `touches:` and
names which story excused which path. An unsettled story's declaration excuses
nothing — it is a plan, not a fact. An undeclared state path refuses exactly as
before.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 8: Docs — EN and ES in lockstep (spec §5)

**Files:**
- Modify: `docs/spec.md` — §2.1 (`command_probes`), §2.8 (the refused evidence row), §2.9 (`check.failed` without `exit_code`, `task.done.epic_base`), §2.13 if the dod prose needs it
- Modify: `docs/guide/03-runs-and-gates.md` (or the page that owns the DoD allowlist — grep) and `docs/guide/08-cli-reference.md` (hand-written; `init` probes, `ship` body)
- Modify: `src/cli/helpText.ts` — the `init` and `ship` `notes[]` (this is what the GENERATED site page renders; `docs-site/scripts/gen-cli.ts` builds `/reference/cli-flags` from it at build time)
- Modify: `docs-site/reference/cli.md` + `docs-site/es/reference/cli.md`; `docs-site/guides/*.md` + `docs-site/es/guides/*.md` for the DoD-allowlist prose
- Test: `test/public-surface-consistency.test.ts` (it has teeth — read it before writing a word)

**Interfaces:** none; this task adds no code.

- [ ] **Step 1: Read the surface rules before writing**

Run: `bun test test/public-surface-consistency.test.ts`
Expected: PASS (it is green now). Then READ the file. The rules it encodes and that this task must not break: **the current version is never typed into prose** (the site derives it from `package.json`); banned positioning — "lightweight", bare "tool-agnostic", absolute state-coherence claims; runtime requirements distinguish running (Node ≥ 20) from building/contributing (Bun); the landing must name `tldrx drive`; provider wording is fixed: "The workflow and persisted state format are provider-independent. The automated runner supports Claude Code and Codex."

- [ ] **Step 2: `docs/spec.md`**

- §2.1 (`:59`): add `command_probes` to the `workspace.yml` example and one paragraph — additive, optional, `{verified, exit_code, at, reason}` per slot, `run` never probed, `commands:` unchanged because it is the allowlist.
- §2.8 (`:896`): the `cmd` src grammar is `$ <command> → exit <n>`, so a command that never ran has no legal `cmd` citation. State the refused evidence row's shape and that it cites the review log instead.
- §2.9 (`:1052`): `check.failed` for `check: "dod"` carries `exit_code` when the command RAN and `refused` when the gate declined to run it — never both, and never a fabricated code. `task.done` carries the additive `epic_base`: the epic's sha immediately before the story merged, absent on every event written before it existed.

Every claim in these paragraphs is `measured` against the code you just wrote — cite the file, not the plan.

- [ ] **Step 3: `src/cli/helpText.ts` (the authoritative surface)**

Add to `init`'s `notes[]` one sentence: after detection it probes each repo's build/test/lint/typecheck once with a timeout and records the result in `command_probes`; `run` is never probed; `commands:` is unchanged.

Add to `ship`'s `notes[]`: the PR body is now assembled from the run — what shipped, what did not, the open fix-list findings — with the full handoff folded into a `<details>` block; and the state refusal subtracts paths a settled story declares in `touches:`, naming which story excused which. **Edit the existing `ship` note at `:844` that says "The body is the LAST phase handoff…" — it is about to be false.**

Verify by BUILDING, never by memory:

```bash
bun run build
node dist/cli.js ship --help
node dist/cli.js init --help
```

(Check the built entry point's real name from `scripts/build.ts` / `package.json` `bin` before running it.) Quote the OUTPUT of those two commands in the docs, not your recollection of it.

- [ ] **Step 4: The guide pages and the docs-site twins**

`docs/guide/08-cli-reference.md`: the `init` and `ship` sections gain the same two facts, in that page's voice.
The DoD-allowlist guide page gains Task 3 Step 11's subsection (quoted tokens, `scripts/gate/*.sh`, "refused" is not "exit 126").
`docs-site/reference/cli.md` and `docs-site/es/reference/cli.md`: the curated tour's `init`/`ship` rows, EN and ES. ES is a real translation, not a copy; sample CLI strings stay in English (owner decision).
`docs-site/guides/*.md` + `docs-site/es/guides/*.md`: the DoD-allowlist prose, both languages.

- [ ] **Step 5: Gate**

```bash
bun test test/public-surface-consistency.test.ts
bun run docs:build
git status --porcelain
```
Expected: the first PASSes; the second exits 0 (`ignoreDeadLinks: false` is deliberate — a moved page or a throwing generator fails here rather than at deploy); the third prints nothing beyond your own edits (`docs:build` leaves the tree clean).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: wave 3's four file-format facts, EN and ES (#165 #166 #167 #168)

spec §2.1 gains `command_probes`; §2.8 says why a command that never ran has no
legal `cmd` citation; §2.9 says `check.failed` carries `exit_code` OR `refused`
and that `task.done` now carries `epic_base`. The DoD guide gains the two
measured facts about the allowlist — a QUOTED token is passed literally, so a
declared `sh -c "…"` is already expressible, and anything needing a shell goes in
`scripts/gate/<slot>.sh` and is declared there. `helpText.ts`'s `ship` note, which
said the body IS the last handoff, is corrected; both new notes were checked
against the BUILT `--help`, not from memory. docs-site EN and ES in lockstep.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

## Task 9: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Check what the top section is, rather than assuming**

Run: `head -5 CHANGELOG.md`
Expected at `b0729bc` (measured): the first section is `## 0.9.2 — 2026-09-07`, a DATED and therefore IMMUTABLE section. **If a `## <version> — unreleased` heading exists by the time you run this** — a sibling merged one while this branch was open — do NOT add a second: rename it to `## 0.10.0 — unreleased` if its version is lower, and merge your bullets into its `### Fixed` / `### Added` / `### Changed` groups under the UNION rule (every bullet from both sides survives; one section per version, one heading per kind; a duplicate `### Fixed` group has shipped before and must not again).

- [ ] **Step 2: Write the section**

Insert directly under `# Changelog`, above `## 0.9.2`. `0.10.0` because gate behaviour and file formats GROW (`DodResult.status`, `check.failed`'s payload, `task.done.epic_base`, `command_probes`, the PR body) — a minor, per the spec's release target.

Write the WHY, in the voice of the existing entries (read three of them first — they explain the failure, not the diff):

```markdown
## 0.10.0 — unreleased

### Fixed

- **A refused Definition-of-Done command is no longer recorded as `exit 126`.** … (#165)
- **The reviewer no longer diffs an empty range.** … (#166)
- **A costless turn that declared only a provider token split is no longer counted silent.** … (#159)
- **A reviewer turn's token split reaches its `run.yml` row.** … (#173)
- **The dirty-tree refusal prints the commands, and the reason it gives is true.** … (#164)

### Added

- **`command_probes:` — what `tldrx init` actually ran.** … (#168)

### Changed

- **`tldrx ship`'s PR body is written for a PR.** … (#167)
```

Each bullet: the measured failure first, the fix second, the compatibility statement third where a format grew.

- [ ] **Step 3: Verify and commit**

```bash
bun run docs:build
git add CHANGELOG.md
git commit -m "docs(changelog): 0.10.0 — unreleased, the wave 3 blockers"
```
(with the two trailers). `docs:build` regenerates the site's changelog page from this file, so a malformed heading fails there.

---

## Task 10: The full gate, on its own lines

**Files:** none.

- [ ] **Step 1: Run every gate, each exit code on its own line**

```bash
bun run typecheck
echo "typecheck: $?"
```
```bash
bun test
echo "test: $?"
```
```bash
bun run build
echo "build: $?"
```
```bash
bun run docs:build
echo "docs: $?"
```
```bash
grep -rn 'Bun\.' src | grep -v src/core/runtime/
echo "seam hits: $(grep -rn 'Bun\.' src | grep -v src/core/runtime/ | wc -l | tr -d ' ')"
```

Expected: `0` for the first four; `0` seam hits. Do not read any of these through a pipe or after another command — a pipe eats the exit code, and `cmd; git log; echo $?` reports `git log`'s.

- [ ] **Step 2: Prove the tree is clean and the golden is exactly as intended**

```bash
git status --porcelain
echo "status lines: $(git status --porcelain | wc -l | tr -d ' ')"
```
Expected: 0 lines.

```bash
git diff --stat b0729bc -- test/fixtures/build/golden/
```
Expected, and reconcile against the three commits that said so: `headless-run-tasks.txt`, `rounds-run-tasks.txt`, `insession-run-tasks.txt` (Task 1); five prompt files and three event files (Task 5); four NEW `refused-*` files (Task 3). **Nothing else.** Any other artifact in this list is an unexplained behaviour change — find it and either explain it in a commit or revert it.

- [ ] **Step 3: Reconcile the test delta**

```bash
git stash list
bun test 2>&1 | tail -5
```
Read the `N pass` line and compare it against `b0729bc`'s (`git stash`-free: check out the base in a second worktree if you need the number). The delta must equal the tests this plan adds plus one row per NEW spawning test file in `test/machine-load.test.ts`'s auto-discovered `test.each` — reconcile it, do not hand-wave. State both ends, measured, in whatever close is written for these issues.

- [ ] **Step 4: Stop**

No tag, no `npm publish`, no `scripts/release.sh`. The branch is ready for `scripts/merge-wave.sh fix/wave3-blockers "<merge message>"` — two arguments — and that is somebody's decision, not this plan's.

---

## Self-Review

**Spec coverage.** §2.1 order → Tasks 1-7 in that order. §2.2 golden discipline → every golden-affecting task lists artifacts before the change and repeats them in the commit; §2.2's "#165 ADDS a fourth scenario" → Task 3 Step 8. §2.3 → Task 1 (with one named deviation: `insession-run-tasks.txt` t2 also moves). §2.4 → Task 2. §2.5 → Task 3, including the docs note and the changed `dod-preflight` pins. §2.6 → Task 4. §2.7 → Task 5, including the normaliser, the `REVIEWER_TOOLS` test and both recovery doors. §2.8 → Task 6. §2.9 → Task 7. §3 non-goals: the `runExecutor` catch and #169/#170/#171 appear nowhere; no prompt change beyond #166's diff line. §4 → red-first in every task; `version: 1` compat tests in Tasks 3, 5 and 6. §5 → Task 8, plus Task 9 for the CHANGELOG.

**Where the spec meets the code awkwardly, stated rather than smoothed over.**

1. `insession-run-tasks.txt` row t2 moves under #173 and spec §2.3 does not name it. Measured, not inferred: `--commit` spawns a real reviewer (`test/fixtures/build/golden.ts:272`, and the row's `session_id` is `fake-reviewer-S1`) and the fake emits usage for every role (`test/fixtures/build/fakeClaude.ts:107`). Task 1 names it in the commit.
2. `preflight.ts`'s parser DROPS a row whose `exit_code` is not a number (`src/core/build/preflight.ts:154-155`), so "the base side drops its 126" requires a parser change, not only an emitter change. Task 3 Step 5 does both and pins the old shape still loading.
3. `reviewLedger.ts:253` defaults a missing `exit_code` to `0`, which would recover a refused command as GREEN. The spec does not mention this reader; it is the dangerous direction and Task 3 fixes it with its own test.
4. The blocked-story reason is built twice in `build.ts` (`:1071-1080`, `:1530-1536`) — a fourth surface beyond the spec's "three renderers". Task 3 extracts `dodFailureReason` rather than editing both copies.
5. A refused DoD blocks the story before a reviewer spawns (`build.ts:1069`), so the reviewer prompt's refused-row rendering is unreachable from the fourth golden scenario. Task 3 pins it with a direct `buildReviewerPrompt` unit test and says so.
6. `detectWorkspace` has no clock, and `test/init.test.ts` pins `detected_at`. Task 6 passes `at` in rather than calling `new Date()` in the leaf — two clocks in one document would drift.
