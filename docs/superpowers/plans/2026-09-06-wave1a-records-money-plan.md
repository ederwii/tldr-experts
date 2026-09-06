# Wave 1a — records and money that do not lie: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven measured mechanisms by which this framework's own ledger, event log,
pre-flight cache and fix lists record something that is not true.

**Architecture:** Every fix lands in the LEAF that owns the derivation — `spawnAgent.interpret`
for `metered`, `Event.ts` for the payload cap, `preflight.ts` for cache freshness, `fixlist.ts`
for the `Resolved:` line, `FactsStore` for the fact cap — and the callers only pass arguments.
`src/core/facilitator/executors/build.ts` is NOT restructured (AGENTS.md §12); the three edits it
takes are argument-passing on existing call sites. Every new file field is ADDITIVE under
`version: 1` (AGENTS.md §7): old records load unchanged, and an absent value is named with a
reason rather than filled in.

**Tech Stack:** TypeScript on Bun (build + test) targeting Node ≥ 20 at runtime; `bun:test`;
no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-06-wave1a-records-money-design.md` — approved
2026-09-06. Read it beside this plan; the plan argues from it and does not re-open its decisions.

## Global Constraints

Copied verbatim from `AGENTS.md`; every task's requirements implicitly include these.

- **Gates, all five, after every task, each run without a pipe and with its exit code read on
  its own line:** `bun run typecheck` · `bun test` · `bun run build` · `bun run docs:build` ·
  and no `Bun.*` under `src/` outside `src/core/runtime/`.
- **Red-first, always.** Every behaviour change starts with a failing test whose verbatim RED
  output you keep. A test that passed before the fix is a **guard**, not a proof — label it.
  Mutate the code under test and confirm the new test goes red (both directions where the fix
  has two halves).
- **Exit codes are never read through a pipe or after a trailing command.** The shell here is
  zsh; `${PIPESTATUS[0]}` is a bashism, and `status` is a reserved variable name — never use it.
- **`version: 1` file formats only grow.** Additive fields, tolerant reads of old records, never
  a changed meaning.
- **One implementation per derivation.** Grammar/regex/arithmetic live in exactly one file.
- **Absent-with-reason, never invented.** A value that cannot be derived is named with WHY.
- **Hermeticity is law.** Every spawning test gets a private `$TMPDIR` per invocation; never
  scan shared tmp. A NEW test file that spawns processes must import
  `./fixtures/machineLoad.ts` and call `setDefaultTimeout(spawnTestTimeout())` — otherwise
  `test/machine-load.test.ts` goes red, and it auto-adds one guard row per such file, so your
  measured `+N` will be one higher than the tests you wrote. Reconcile the number; do not
  hand-wave it.
- **No private workspace names anywhere.** The spec deliberately cites none; neither do the
  code comments, the tests, the CHANGELOG or the docs this plan writes. Cite mechanisms and
  dates, never a real run id or repo.
- **Never quote a CLI command or flag from memory.** `tldrx <cmd> --help` (rendered from
  `src/cli/helpText.ts`) is the authoritative surface; docs quote it, they do not invent it.
- **New out-of-scope bugs → a GitHub issue with evidence**, not a fix inside this change.
- Every commit message ends with:

  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
  ```

## File Structure

Created:

| File | Responsibility |
|---|---|
| `src/cli/commands/facts.ts` | argv + exit codes for `tldrx facts add`; all work is in `FactsStore` |
| `test/facts-add.test.ts` | the `facts add` command: cap, marker, attribution, mandate agreement |
| `test/payload-cap.test.ts` | the 4096-byte emit seam and the executor `try`/`finally` |

Modified:

| File | What changes |
|---|---|
| `src/core/facilitator/spawnAgent.ts` | `metered` derived from the presence of a USD figure (Task 1) |
| `src/core/facilitator/runNext.ts` | cost row before the questions refusal (2); token split on the task row (3); capped emit seam + `try`/`finally` (4) |
| `src/core/run/RunFile.ts` | `RunTask.input_tokens` / `.output_tokens`, additive + validated (3) |
| `src/core/run/emitRunYaml.ts` | emit the two token keys only when present (3) |
| `src/core/facilitator/executors/index.ts` | `ExecutorTask.inputTokens` / `.outputTokens`, optional (3) |
| `src/core/events/Event.ts` | `capPayload()` — the one place that knows the 4096-byte cap (4) |
| `src/core/facts/Fact.ts` | `FactSource.decided_by`, additive (5) |
| `src/core/facts/emitFactsYaml.ts` | emit `decided_by` when present (5) |
| `src/core/facts/validateFactsFile.ts` | validate `decided_by` when present (5) |
| `src/cli/index.ts` · `src/cli/helpText.ts` | register + document `facts` (5) |
| `src/core/build/preflight.ts` | `commandHash()`, per-row `command_hash` / `checked_at`, red TTL, `--prepare` re-probe (6) |
| `src/core/build/git.ts` | `canonicalSha()` (7) |
| `src/core/build/fixlist.ts` | `canonicalizeResolvedSha()` — sibling of `markUnverified` (7) |
| `src/core/build/index.ts` | re-export the two new leaf functions (6, 7) |
| `src/core/facilitator/executors/build.ts` | THREE argument-passing edits only: usage onto two task pushes (3), freshness args into `baseResultFor` + `commandHash` onto the measured row (6), canonical sha write-back in `verifyResolutions` (7) |
| `src/core/facilitator/executors/watch.ts` | usage onto the task push (3) |
| `docs/spec.md` · `docs/ROADMAP.md` · `docs/guide/08-cli-reference.md` · `docs-site/reference/cli.md` · `docs-site/es/reference/cli.md` | (8) |
| `CHANGELOG.md` | `## 0.9.1 — unreleased` (9) |
| existing tests listed per task | re-pins, each one named (1, 6) |

---

### Task 1: `metered` is derived from the presence of a USD figure

**Why:** `src/core/facilitator/spawnAgent.ts:339-340` writes `costUsd` `0` and `metered`
`true` for a Claude turn whose result carries no `total_cost_usd`, which contradicts the
field's own contract three lines up (`:149`: *"False when the provider reports tokens but no
provider-metered USD amount"*). `runNext.ts:580` then writes `cost_usd: <0>` with no
`metered:` key, and a stage or a whole run reads `$0.00` after real turns ran.

**Files:**
- Modify: `src/core/facilitator/spawnAgent.ts:339-340` (the derivation) and the contract
  comment at `:148-150`
- Test: `test/agent-stream.test.ts` (new cases in the existing `describe("interpret, over
  either format")` block)
- Re-pin: every assertion listed in Step 5 below

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interpret(exitCode, stdout, stderr, timedOut, provider?) => AgentOutcome` with
  `metered: boolean` now meaning *"a provider-metered USD figure was present on the result
  document"*. `AgentOutcome.costUsd` stays `number` (0 when unmetered) — every consumer already
  reads it through `metered`, and `runNext.ts:580` turns the pair into the `cost_usd: null` +
  `metered: false` row the schema requires (`RunFile.ts:631`).

- [ ] **Step 1: Write the failing tests**

Add to `test/agent-stream.test.ts`, inside `describe("interpret, over either format", …)`:

```ts
  /**
   * The invented `$0.00`. A Claude result event WITHOUT `total_cost_usd` is a turn
   * whose dollars nothing here saw — and `metered: true` on it made `runNext` write
   * `cost_usd: 0`, a measurement, and a false one. The field's own contract
   * (`spawnAgent.ts` `AgentOutcome.metered`) always said what this now does.
   */
  test("a Claude result with no total_cost_usd is UNMETERED, not a metered $0.00", () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "sess-nousd",
      usage: { input_tokens: 11, output_tokens: 22 },
      structured_output: { outputs: [], questions_asked: [], notes: "" },
    });

    const outcome = interpret(0, line, "", false);

    expect(outcome.ok).toBe(true);
    expect(outcome.metered).toBe(false);
    expect(outcome.costUsd).toBe(0);
    // The tokens are still real: "no dollars" is not "no turn".
    expect(outcome.usage.input_tokens).toBe(11);
    expect(outcome.usage.output_tokens).toBe(22);
  });

  test("a Claude result that DOES carry total_cost_usd is metered, including a real zero", () => {
    const withCost = interpret(0, TRANSCRIPT, "", false);
    expect(withCost.metered).toBe(true);
    expect(withCost.costUsd).toBe(REAL_COST);

    // A provider that reports an honest zero is still a MEASUREMENT — the
    // difference this fix is about is the absence of the key, not its value.
    const zero = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      total_cost_usd: 0, session_id: "sess-zero",
      structured_output: { outputs: [], questions_asked: [], notes: "" },
    });
    expect(interpret(0, zero, "", false).metered).toBe(true);
  });

  test("a process that produced no result document at all is unmetered", () => {
    // Nothing was parsed, so nothing reported a cost. `cost_usd: 0` here would be
    // the same lie in its loudest form: a crashed turn recorded as a free one.
    const outcome = interpret(1, "", "claude: command not found", false);
    expect(outcome.ok).toBe(false);
    expect(outcome.metered).toBe(false);
  });

  test("Codex is unchanged — its synthesized result doc still reports no dollars", () => {
    const outcome = interpret(0, CODEX_TRANSCRIPT, "", false, "codex");
    expect(outcome.metered).toBe(false);
    expect(outcome.costUsd).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/agent-stream.test.ts`
Expected: FAIL. The first case reports
`expect(received).toBe(expected) … Expected: false, Received: true` on
`outcome.metered`; the third case fails the same way. The second and fourth pass already —
label them **guards**, not proofs, in the task report.

- [ ] **Step 3: Write the implementation**

In `src/core/facilitator/spawnAgent.ts`, replace lines 339-340:

```ts
  // `metered` is DERIVED from the presence of a USD figure, not from the provider's
  // name. A result document with no `total_cost_usd` is a turn whose dollars nothing
  // in this process saw, and `costUsd: 0` on it is a measurement and a false one —
  // `runNext` turns this pair into the `cost_usd: null` + `metered: false` row the
  // schema already requires. The `provider === "claude"` half stays because
  // `resolveCodexResultDoc` synthesizes `total_cost_usd: 0` for a turn Codex meters
  // in tokens only (`agentEvents.ts:159`): dropping the guard would read that
  // synthesized zero as a measurement and re-introduce the same lie for Codex.
  const hasUsd = typeof doc?.total_cost_usd === "number";
  const costUsd = hasUsd ? (doc?.total_cost_usd as number) : 0;
  const metered = provider === "claude" && hasUsd;
```

And tighten the contract comment at `:149` so the field's docstring and its derivation cannot
drift again:

```ts
  /**
   * True only when the provider's result document carried a USD figure. False for a
   * turn that reported tokens and no dollars, for a Codex turn (metered in tokens),
   * and for a process that died before it produced a result document at all. A
   * `false` here means `costUsd` is not a measurement and nothing may sum it.
   */
  readonly metered: boolean;
```

- [ ] **Step 4: Run the new tests to verify they pass, then mutate to prove they bite**

Run: `bun test test/agent-stream.test.ts`
Expected: PASS.

Then mutate `const metered = provider === "claude" && hasUsd;` back to
`const metered = provider === "claude";`, re-run the same command, and confirm cases 1 and 3
go RED again. Restore the fix. Record both directions in the task report.

- [ ] **Step 5: Run the whole suite and re-pin every assertion this behaviour change moves**

Run: `bun test`

**Expected: GREEN — and this is `measured`, not predicted.** The exact change in Step 3 was
applied to a clean `fix/wave1a-records-money` worktree (branched from `ac35642`, one commit
past `fa00f15`) on 2026-09-06 and the full suite was run with no other edit:

```
 3627 pass
 0 fail
Ran 3627 tests across 137 files. [778.60s]
EXIT=0
```

So the re-pin list the spec anticipated is **empty as measured on that tree**: not one existing
assertion pins the invented zero, including on the failed-spawn path where `runNext.ts:580`
now writes `cost_usd: null` + `metered: false` instead of `cost_usd: 0`. Record that verbatim
in the task report — an empty list stated as a measurement, with the command and the totals
beside it, is the finding; "nothing broke" without the numbers is not.

Two consequences to state out loud rather than pass over:

- The suite had **no coverage at all** of a Claude turn that produces no `total_cost_usd`.
  That is why the bug survived, and it is why the tests in Step 1 are the proof rather than the
  formality. File it as a note in the task report.
- If the suite is NOT green on your tree, do not treat this plan's measurement as authority
  over your own — yours is the newer one. Re-pin each failure and list it in the task report
  under "re-pinned assertions (behaviour change, not a guard)", applying exactly one of these
  three shapes:

1. **A task row on a FAILED headless spawn** that asserted `cost_usd` `0` (or a
   `budget.spent_usd` / `stage.cost_usd` total that included such a row): change the
   expectation to `cost_usd: null` plus `metered: false`, and add one sentence to the test's
   docstring saying the turn produced no result document so its dollars were never observed.
2. **An `agent.result` event** whose `cost_usd` envelope field was asserted as `0`: the
   envelope field stays `0` (spec §2.9 requires a number ≥ 0 —
   `runNext.ts:609` writes `agent.metered ? round2(agent.costUsd) : 0`), and the payload now
   carries `metered: false`. Assert the payload key rather than loosening the envelope.
3. **An `outcome.metered` / `outcome.costUsd` assertion in a unit test** over a fixture with
   no `total_cost_usd`: flip it to the honest value.

These four are the assertions nearest the change. All four were **measured green** in the run
above and must stay green — they are guards, not proofs, and the report says so:

- `test/model-provider.test.ts:102-103` — `expect(outcome.metered).toBe(false)` /
  `expect(outcome.costUsd).toBe(0)` for the Codex spawn. Green: the provider pin was not
  weakened (AGENTS.md §10 — weakening an existing provider pin is a finding, not a migration).
  This is the assertion the `provider === "claude" &&` half of the derivation exists to keep.
- `test/agent-stream.test.ts:133-136` — the same pair for `interpret(…, "codex")`. Green.
- `test/build-executor.test.ts:1248-1263` and `:2351-2363` — already pin
  `cost_usd: null` + `metered: false` for the unmetered in-session turn. Green; they must not
  move.
- `test/money-safety.test.ts:115-204` — the whole `M7 · unmetered is not zero` block. Green.

Do NOT "fix" a red by widening an assertion (`toBeDefined`, `toBeGreaterThanOrEqual(0)`) or by
deleting it. If a red cannot be re-pinned to a value the new behaviour actually produces, stop
and report it — that is a finding about the design, not a test to edit.

- [ ] **Step 6: Run every gate, each exit code on its own line**

```bash
bun run typecheck
echo "typecheck=$?"
bun test
echo "test=$?"
bun run build
echo "build=$?"
bun run docs:build
echo "docsbuild=$?"
grep -rn "Bun\." src --include=*.ts | grep -v "src/core/runtime/"
echo "seam_hits_exit=$?"   # 1 == no hits == clean
```

Expected: `typecheck=0`, `test=0`, `build=0`, `docsbuild=0`, `seam_hits_exit=1`.

- [ ] **Step 7: Commit**

```bash
git add src/core/facilitator/spawnAgent.ts test/
git commit -m "$(cat <<'EOF'
fix(money): a turn with no provider USD figure is unmetered, not a metered $0.00

`interpret` wrote `cost_usd: 0, metered: true` for a Claude result document that
carried no `total_cost_usd` — contradicting the field's own contract and letting a
stage read $0.00 after real turns ran. `metered` is now derived from the presence of
the figure; the Codex guard stays, because its synthesized result doc carries a
`total_cost_usd: 0` that is a placeholder, not a measurement.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 2: the cost row lands before the questions refusal

**Why:** `runNext.ts:1230-1240` returns `EXIT_AGENT_FAILED` on a `questions.md` the §2.7 parser
cannot read — BEFORE `recordTask` at `:1251`. The turn ran, the host spent (or declared) money,
and the ledger has no row for it.

**Files:**
- Modify: `src/core/facilitator/runNext.ts:1216-1287` (`commitStage`)
- Test: `test/questions-grammar.test.ts` (the existing refusal test at `:320-346` gains the
  ledger assertions; one new test for the re-run)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exported symbol. The behaviour contract: after a `--commit` that refuses on
  an unreadable `questions.md`, `run.yml` carries exactly one task row for that turn, and a
  SECOND `--commit` over the same `result.json` records no second row and says so.

- [ ] **Step 1: Write the failing test**

Extend the existing test in `test/questions-grammar.test.ts` (it currently stops at
`expect(text).toContain("tldrx questions lint")` on line 345) and add one beside it:

```ts
    // The refusal is real and it still exits 5 — and the money is recorded anyway.
    // The turn RAN. A refusal that discards the row is the ledger forgetting a
    // dollar it saw, which is the one thing this file's own subject forbids.
    const store = RunStore.open(ws.runDir);
    const stage = store.run.phases.flatMap((p) => p.stages).find((s) => s.id === "alpha");
    expect(stage?.tasks).toHaveLength(1);
    expect(stage?.tasks[0]?.cost_usd).toBe(0.4);
    expect(stage?.tasks[0]?.session_id).toBeNull();
    const results = EventLog.forRun(ws.runDir).read().events
      .filter((e) => e.type === "agent.result");
    expect(results).toHaveLength(1);
    expect(results[0]?.cost_usd).toBe(0.4);
  });

  /**
   * The other half, and the one that decides whether the fix is honest: the
   * operator fixes `questions.md` and runs `--commit` again over the SAME
   * `result.json`. The stage is still `running`, so nothing else stops a second
   * row — and two rows for one turn double-counts the money, which is the same
   * lie pointing the other way.
   */
  test("a re-run after the fix does not bank the same turn twice", async () => {
    const ws = workspace([ASKER], { alpha: "auto" });
    await runNext({
      root: ws.root, dryRun: false, mode: "prepare", yolo: false,
      actor: "alan", at: "2026-08-29T09:00:00Z",
    });
    writeFileSync(join(ws.runDir, "01-what", "intent.md"), cannedIntent(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "handoff.md"), cannedHandoff(), "utf8");
    writeFileSync(join(ws.runDir, "01-what", "questions.md"), PROSE_QUESTIONS, "utf8");
    mkdirSync(join(ws.runDir, ".agent", "alpha"), { recursive: true });
    writeFileSync(
      join(ws.runDir, ".agent", "alpha", "result.json"),
      JSON.stringify({ outputs: ["01-what/intent.md"], questions_asked: [], notes: "", cost_usd: 0.4 }),
      "utf8",
    );

    const refused = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:05:00Z",
    });
    expect(refused.code).toBe(5);

    // The operator's fix, then the same command again.
    expect(await questionsCommand.run(["lint", "--root", ws.root, "--fix"])).toBe(0);
    const again = await runNext({
      root: ws.root, dryRun: false, mode: "commit", yolo: false,
      actor: "alan", at: "2026-08-29T09:10:00Z",
    });

    const stage = RunStore.open(ws.runDir).run.phases
      .flatMap((p) => p.stages).find((s) => s.id === "alpha");
    expect(stage?.tasks).toHaveLength(1);
    expect(stage?.cost_usd).toBe(0.4);
    expect(again.lines.join("\n")).toContain("already recorded as t1");
  });
```

Add the imports the file does not already have (`RunStore`, `EventLog`, `questionsCommand`,
`mkdirSync`, `writeFileSync`, `join`) — check the file's existing import block first and add
only what is missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/questions-grammar.test.ts`
Expected: FAIL. The first assertion fails with
`expect(received).toHaveLength(expected) … Expected length: 1, Received length: 0` on
`stage?.tasks`; the second test fails on `already recorded as t1` not being in the output.

- [ ] **Step 3: Write the implementation**

In `src/core/facilitator/runNext.ts`, restructure `commitStage` so the recording block runs
BEFORE the `unreadable` refusal, and add the re-run guard. Replace lines 1224-1284 with:

```ts
  // The cost of an in-session turn is DECLARED, never measured: the sub-agent ran
  // inside the host's session and was billed to it. `--cost-usd` is the host
  // saying what it was; `result.json`'s own `cost_usd` is the other way to say it.
  // With neither, this is `null` + `metered: false` — not `0`, which is a
  // measurement and a false one (2026-08-29 audit, §A: a run's ledger read
  // "$0.00 spent" after real money had gone).
  const declared = options.costUsd ?? result.cost_usd;
  const cost = declared === null || declared === undefined ? null : round2(declared);

  // Recorded BEFORE any refusal below. The turn RAN: a refusal that exits first
  // is the ledger forgetting money it saw, which is the failure this file's own
  // `cost_usd: null` rule exists to prevent, pointing the other way.
  //
  // Which makes the second `--commit` the hazard. The questions refusal leaves
  // the stage `running`, so the operator fixes `questions.md` and runs the same
  // command over the same `result.json` — and nothing but this would stop a
  // second row for one turn. `banked` is the fingerprint of THIS result document
  // among the rows already on the stage: same session, same declared cost, same
  // outputs. Matching means it is the same artefact, not a second turn.
  const banked = alreadyBanked(requireStage(store, phaseId, stageId), result, cost);
  const taskId = banked === null ? nextTaskId(store, phaseId, stageId) : banked;
  if (banked === null) {
    recordTask(store, phaseId, stageId, {
      id: taskId,
      status: "done",
      expert: stage.expert ?? spec.planned.experts[0] ?? null,
      model: options.model ?? stage.model ?? spec.planned.model,
      cost_usd: cost,
      ...(cost === null ? { metered: false } : {}),
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
      error: null,
      session_id: result.session_id,
      started_at: stage.started_at ?? options.at,
      ended_at: options.at,
      outputs: result.outputs,
    });
    store.append(event(options, store.runId, stageId, "agent.result", {
      phase: phaseId,
      task: taskId,
      session_id: result.session_id,
      model: options.model ?? stage.model ?? spec.planned.model,
      effort: options.effort ?? spec.planned.effort ?? null,
      outputs: result.outputs,
      mode: "in-session",
      // `cost_usd` on the ENVELOPE must stay a number ≥ 0 (spec §2.9), so the fact
      // that nothing was declared lives in the payload where it can be null.
      metered: cost !== null,
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    }, cost ?? 0, stage.expert));
    store.save();
  } else {
    notes.push(
      `this turn's cost is already recorded as ${banked} — an earlier \`--commit\` banked it `
      + "before refusing, so it is not recorded a second time.",
    );
  }
  if (cost === null && banked === null) {
    notes.push(
      `cost is unmetered (in-session): nothing declared it, so this turn is recorded as `
      + "`cost_usd: null, metered: false` rather than $0.00. Pass `--cost-usd <n>` when you know it.",
    );
  }

  // A questions.md the §2.7 parser cannot read is not "no questions" — it is a
  // file nobody, including the gate, can see into. Refused HERE rather than at the
  // gate because `--commit` is the last moment the host session that wrote it is
  // still around to fix it. Measured 2026-08-29: an in-session stage wrote
  // `### Q1 — …` / `**Answer:**` from the old template, and four questions
  // vanished between the sub-agent and the run.
  //
  // AFTER the recording block, not before it: this refusal used to return with
  // the turn's money unrecorded anywhere.
  const unreadable = unreadableHeadings(join(store.runDir, phaseId, "questions.md"));
  if (unreadable.length > 0) {
    return out(EXIT_AGENT_FAILED, [
      ...notes,
      `${phaseId}/questions.md has ${unreadable.length} question(s) the parser cannot read `
        + `(${unreadable.join(", ")}) — a heading must be \`## Qn · <title>\` with the `
        + "`<!-- id: Qn | status: open | area: … | asked_by: … | asked_at: … -->` line under it.",
      "As written they are invisible: the gate would read this file as \"0 open\" and sign itself.",
      `Fix: \`tldrx questions lint --run ${store.runId} --fix\`, then \`tldrx next --commit\` again.`,
    ]);
  }

  return await finishStage(store, options, phaseId, stageId, spec, notes);
}

/**
 * The id of the task row that already banked THIS `result.json`, or null when
 * none has.
 *
 * Only one path can produce such a row: the questions refusal above, which now
 * records the money before it exits and leaves the stage `running` so the
 * operator can fix the file and re-run. The fingerprint is every part of the
 * result a second turn would have changed — the session it ran in, the cost it
 * declared, and the outputs it named. All three matching is the same artefact
 * being re-read, not a second turn that happened to cost the same.
 */
function alreadyBanked(
  stage: RunStage,
  result: { session_id: string | null; outputs: readonly string[] },
  cost: number | null,
): string | null {
  const hit = stage.tasks.find((task) =>
    task.session_id === result.session_id
    && task.cost_usd === cost
    && sameOutputs(task.outputs, result.outputs));
  return hit?.id ?? null;
}

/** Element by element, so no separator character has to be chosen or escaped. */
function sameOutputs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
```

`RunStage` is already imported at `runNext.ts:20`.

- [ ] **Step 4: Run the tests to verify they pass, then mutate**

Run: `bun test test/questions-grammar.test.ts`
Expected: PASS.

Mutate in two directions and confirm each goes red:
1. Move the `unreadable` block back above the recording block → the first test's
   `toHaveLength(1)` goes red.
2. Replace `const banked = alreadyBanked(…)` with `const banked = null` → the second test's
   `toHaveLength(1)` goes red with `Received length: 2`.

Restore both. Record the verbatim RED for each in the task report.

- [ ] **Step 5: Run every gate, each exit code on its own line**

Same block as Task 1, Step 6. Expected: `typecheck=0`, `test=0`, `build=0`, `docsbuild=0`,
`seam_hits_exit=1`.

- [ ] **Step 6: Commit**

```bash
git add src/core/facilitator/runNext.ts test/questions-grammar.test.ts
git commit -m "$(cat <<'EOF'
fix(ledger): record the turn's cost before the questions.md refusal, once

`--commit` returned EXIT_AGENT_FAILED on an unreadable questions.md before
`recordTask` ran, so a turn that had already been paid for left no row at all. The
row now lands first and the refusal exits after it. Because that refusal leaves the
stage `running`, the re-run after the operator's fix reads the same result.json — so
the row is fingerprinted (session, declared cost, outputs) and never banked twice.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 3: additive `input_tokens` / `output_tokens` on the `run.yml` task row

**Why:** the provider's token split is parsed (`envelope.ts:93-101`,
`agentEvents.ts:160-165`) and reaches only the `agent.result` event. `run.yml` rows carry none,
so every dollar figure derived downstream is an unfalsifiable bound.

**Files:**
- Modify: `src/core/run/RunFile.ts` (`RunTask` at `:184-194`, task validation at `:618-635`)
- Modify: `src/core/run/emitRunYaml.ts:89-110` (`task()`)
- Modify: `src/core/facilitator/runNext.ts:575-591` (headless spawn) and `:1173-1186`
  (`recordExecutorTasks`)
- Modify: `src/core/facilitator/executors/index.ts:34-55` (`ExecutorTask`)
- Modify: `src/core/facilitator/executors/build.ts:1974-1982` and
  `src/core/facilitator/executors/watch.ts:156-164` — argument passing only
- Test: `test/money-safety.test.ts` (round-trip + old-row tolerance), `test/schemas.test.ts`
  (the `version: 1` pin stays exactly as it is)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RunTask.input_tokens?: number` and `RunTask.output_tokens?: number` — non-negative finite
    numbers, absent when the turn reported no usage.
  - `ExecutorTask.inputTokens?: number` and `ExecutorTask.outputTokens?: number` — the same
    values in the executors' camelCase shape, copied through by `recordExecutorTasks`.
  - `tokens` keeps its existing meaning (a HOST declaration via `--tokens`) and is untouched.

- [ ] **Step 1: Write the failing tests**

Add to `test/money-safety.test.ts` (it already opens a workspace and a `RunStore`; reuse the
helpers at the top of the file):

```ts
describe("the provider's token split on a run.yml task row", () => {
  /**
   * The split is PARSED on every provider turn and used to reach the event log
   * only, so `run.yml` — the file every cost report and every resumed run reads —
   * could say what a turn cost in dollars and never what it cost in tokens. A
   * dollar figure with no token figure beside it cannot be checked against a
   * price table, which makes it an unfalsifiable bound.
   */
  test("round-trips through the emitter and the parser", () => {
    const ws = makeWorkspace();
    const store = newRun(ws.root);
    mapFirstTask(store, (task) => ({ ...task, input_tokens: 184_203, output_tokens: 9_114 }));
    store.save();

    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    expect(text).toContain("input_tokens: 184203");
    expect(text).toContain("output_tokens: 9114");

    const reread = RunStore.open(store.runDir).run.phases[0]?.stages[0]?.tasks[0];
    expect(reread?.input_tokens).toBe(184_203);
    expect(reread?.output_tokens).toBe(9_114);
  });

  test("a row without them is byte-identical to what it was, and still loads", () => {
    const ws = makeWorkspace();
    const store = newRun(ws.root);
    store.save();
    const text = readFileSync(join(store.runDir, "run.yml"), "utf8");
    // The keys are written only when there is something to write. Every run.yml
    // produced before this field existed round-trips unchanged.
    expect(text).not.toContain("input_tokens");
    expect(text).not.toContain("output_tokens");
    expect(RunStore.open(store.runDir).run.phases[0]?.stages[0]?.tasks[0]?.input_tokens)
      .toBeUndefined();
  });

  test("a non-number is a schema error, so the field cannot hold prose", () => {
    const ws = makeWorkspace();
    const store = newRun(ws.root);
    const doc = JSON.parse(JSON.stringify(store.run)) as Record<string, unknown>;
    const task = firstTaskOf(doc);
    if (task !== undefined) task.input_tokens = "lots";
    const report = validateRunFile(doc);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.message).join(" ")).toContain("expected a number >= 0");
  });
});
```

`makeWorkspace`, `newRun`, `mapFirstTask` and `firstTaskOf` are local helpers: reuse the ones
`test/money-safety.test.ts` already defines for its `M7` block (`withUnmetered` at `:117-137`
is the model — it reaches the first task the same way). If a helper does not exist yet, write
it beside `withUnmetered` rather than inventing a second way to reach the row.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/money-safety.test.ts`
Expected: FAIL. The first case fails at typecheck-time on `input_tokens` not existing on
`RunTask` (`bun test` reports the TypeScript error) or, once the field exists but the emitter
does not, with `expect(received).toContain(expected) … "input_tokens: 184203"` not found.

- [ ] **Step 3: Write the implementation**

**3a.** `src/core/run/RunFile.ts`, after `tokens` at `:193`:

```ts
  /**
   * The PROVIDER's own token split for this turn, when a turn this process watched
   * reported one (`AgentOutcome.usage`).
   *
   * ADDITIVE and optional, and deliberately NOT the same field as `tokens`: that
   * one is what a HOST declared with `--tokens` for a turn nothing here metered.
   * These two are a measurement, and they are what makes a dollar figure
   * checkable against a price table instead of a number nobody can falsify.
   * Absent on every row written before this existed and on every turn whose
   * result document reported no usage at all — absent means "not recorded", never
   * "zero".
   */
  readonly input_tokens?: number;
  readonly output_tokens?: number;
```

**3b.** `src/core/run/RunFile.ts`, in the task validation block, after the `metered` checks
(currently `:628-633`):

```ts
          // Additive: absence is fine, a wrong TYPE is not. A token count that is
          // not a non-negative finite number is a record that cannot be arithmetic.
          for (const key of ["input_tokens", "output_tokens"] as const) {
            const value = task[key];
            if (value === undefined) continue;
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
              issues.push({ path: `${tp}.${key}`, message: "expected a number >= 0" });
            }
          }
```

**3c.** `src/core/run/emitRunYaml.ts`, in `task()` after the `tokens` line at `:97`:

```ts
  // Written only when the turn reported them. A run.yml from before this field
  // existed, and a turn whose result document carried no usage, are byte-identical
  // to what they were.
  const inTokens = t.input_tokens === undefined ? "" : `, input_tokens: ${String(t.input_tokens)}`;
  const outTokens = t.output_tokens === undefined ? "" : `, output_tokens: ${String(t.output_tokens)}`;
```

and append `${inTokens}${outTokens}` to the first emitted line, immediately after `${tokens}`.

**3d.** `src/core/facilitator/executors/index.ts`, inside `ExecutorTask` after `tokens` at
`:54`:

```ts
  /**
   * The provider's measured token split for this turn, when the executor spawned
   * one and read its `AgentOutcome.usage`. Absent for a HOST turn — nothing here
   * watched it — and absent is "not recorded", never zero.
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
```

**3e.** `src/core/facilitator/runNext.ts:575-591` (the headless spawn's `recordTask`), after
`stopped_by`:

```ts
    // Written only when the provider reported something. Both keys or neither: a
    // half-recorded split reads as an output-only turn.
    ...(agent.usage.input_tokens > 0 || agent.usage.output_tokens > 0
      ? { input_tokens: agent.usage.input_tokens, output_tokens: agent.usage.output_tokens }
      : {}),
```

**3f.** `src/core/facilitator/runNext.ts:1173-1186` (`recordExecutorTasks`), after the
`tokens` spread:

```ts
      ...(task.inputTokens === undefined && task.outputTokens === undefined
        ? {}
        : { input_tokens: task.inputTokens ?? 0, output_tokens: task.outputTokens ?? 0 }),
```

**3g.** `src/core/facilitator/executors/build.ts:1974-1982` (the developer spawn — the one
push in that file that already holds an `AgentOutcome` named `agent`), add two lines to the
object literal:

```ts
      inputTokens: agent.usage.input_tokens,
      outputTokens: agent.usage.output_tokens,
```

**3h.** `src/core/facilitator/executors/watch.ts:156-164`, the same two lines from `outcome`:

```ts
        inputTokens: outcome.usage.input_tokens,
        outputTokens: outcome.usage.output_tokens,
```

Nothing else in `build.ts` changes. The reviewer path narrows its turn into a local struct
(`build.ts:2144-2146`, `:2153-2159`, typed at `:2392-2400`) before it reaches `this.tasks.push`,
so carrying usage through it is a `build.ts` change of a different size — file it as a
follow-up issue with this file:line evidence rather than doing it here (AGENTS.md §1, §12).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/money-safety.test.ts test/schemas.test.ts`
Expected: PASS, and `test/schemas.test.ts`'s `version: 1` block unchanged — additive fields do
not bump a version (AGENTS.md §7). Confirm no edit was needed there and say so in the report.

Mutation check: change `t.input_tokens === undefined ? "" : …` in the emitter to always emit
`""`, re-run, and confirm the round-trip test goes red. Restore.

- [ ] **Step 5: Run every gate, each exit code on its own line**

Same block as Task 1, Step 6.

- [ ] **Step 6: Commit**

```bash
git add src/core/run/ src/core/facilitator/ test/money-safety.test.ts
git commit -m "$(cat <<'EOF'
feat(run.yml): record the provider's token split on the task row

The split was parsed on every provider turn and reached the event log only, so
run.yml carried a dollar figure with no token figure beside it — a number nobody
could check against a price table. `input_tokens` / `output_tokens` are additive and
written only when a turn reported them; `tokens` keeps its meaning (a host
declaration). `version: 1` is unchanged and every older row loads.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 4: honour the 4096-byte payload cap at the emit seam, and never lose the rows

**Why:** `EventLog.append` throws on an oversized payload (`Event.ts:130`, `:166-169`;
`EventLog.ts:34-39`). The reviewer verdict's `detail` is the field that overflows
(`build.ts:2435-2443` — `detail: review.summary`). `runNext.ts:1082-1087` wraps the executor in
nothing, so the throw escapes past `recordExecutorTasks` (`:1114`) and `store.save()` (`:1115`):
the epic merge stands on disk and every task's cost is gone from `run.yml`.

**Files:**
- Modify: `src/core/events/Event.ts` (new `capPayload`, beside `MAX_PAYLOAD_BYTES`)
- Modify: `src/core/facilitator/runNext.ts:1082-1087` (the `emit` closure) and `:1087-1116`
  (the executor call)
- Create: `test/payload-cap.test.ts`
- No `build.ts` edit.

**Interfaces:**
- Consumes: nothing.
- Produces:
  `capPayload(payload: Readonly<Record<string, unknown>>, pointer?: string | null) =>
  Readonly<Record<string, unknown>>` — returns the payload UNCHANGED (same object) when it is
  within the cap, and otherwise a copy with a string `detail` replaced by
  `detail_omitted: string`.

- [ ] **Step 1: Write the failing tests**

Create `test/payload-cap.test.ts`:

```ts
/**
 * The 4096-byte payload cap is a rule about what an event may CARRY, and it was
 * being enforced as a rule about whether the invocation survives.
 *
 * `EventLog.append` throws on an oversized payload, the reviewer's verdict prose is
 * the field that overflows, and nothing wrapped the executor call — so one long
 * review took out `recordExecutorTasks` and `store.save()` with it: the epic merge
 * was on disk and every task's cost was gone from run.yml.
 *
 * The cap is honoured, never raised (spec §2.9). What changes is what happens at the
 * seam: the oversized field is replaced by a NAMED absence, and the executor call is
 * wrapped so nothing that was already earned is lost to a throw.
 */
import { describe, expect, test } from "bun:test";
import { capPayload, MAX_PAYLOAD_BYTES, validateEvent } from "../src/core/events/Event.ts";

function bytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

describe("capPayload", () => {
  test("a payload inside the cap comes back untouched — every existing event is byte-identical", () => {
    const payload = { phase: "04-build", check: "review", story: "S1", detail: "looks good" };
    expect(capPayload(payload)).toBe(payload);
  });

  test("an oversized `detail` is replaced by a named absence, and the result fits", () => {
    const detail = "x".repeat(MAX_PAYLOAD_BYTES * 2);
    const payload = { phase: "04-build", check: "review", story: "S1", verdict: "changes", detail };

    const capped = capPayload(payload, "04-build/log/S1.md");

    expect(capped.detail).toBeUndefined();
    expect(String(capped.detail_omitted)).toContain(String(bytes(payload)));
    expect(String(capped.detail_omitted)).toContain(String(MAX_PAYLOAD_BYTES));
    expect(String(capped.detail_omitted)).toContain("04-build/log/S1.md");
    // Everything else the event was carrying survives — the verdict is the half a
    // ledger reads, and dropping it with the prose would lose the judgement too.
    expect(capped.verdict).toBe("changes");
    expect(capped.story).toBe("S1");
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  test("with no pointer it still says where the text is NOT, rather than inventing a path", () => {
    const capped = capPayload({ detail: "x".repeat(MAX_PAYLOAD_BYTES * 2) });
    expect(String(capped.detail_omitted)).toContain("not in this event");
    expect(String(capped.detail_omitted)).not.toContain("undefined");
  });

  test("an oversized payload with no `detail` is left alone — the cap still refuses it", () => {
    // Honesty over convenience: this function knows how to name ONE absence. A
    // payload that is oversized for another reason is a bug in whoever built it,
    // and silently trimming an unknown field would be the framework editing its
    // own record.
    const payload = { blob: "x".repeat(MAX_PAYLOAD_BYTES * 2) };
    expect(capPayload(payload)).toBe(payload);
    expect(validateEvent({
      ts: "2026-09-06T00:00:00Z", run: "r", stage: null, type: "check.failed",
      actor: "facilitator", cost_usd: 0, payload,
    }).ok).toBe(false);
  });
});
```

This file spawns nothing, so it takes no `setDefaultTimeout(spawnTestTimeout())` and adds no
`machine-load` guard row. Confirm that by re-reading
`test/machine-load.test.ts`'s `spawners` filter before you commit — the filter looks for
`node:child_process`, `Bun.spawn`, `makeBuildWorkspace` and `makeSandbox`, none of which this
file uses.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/payload-cap.test.ts`
Expected: FAIL at import — `capPayload` is not exported from `../src/core/events/Event.ts`.
bun reports `SyntaxError: Export named 'capPayload' not found in module …/Event.ts`.

- [ ] **Step 3: Write the implementation**

**3a.** `src/core/events/Event.ts`, after `validateEvent`:

```ts
/**
 * Fit a payload inside the §2.9 cap by NAMING what was left out, not by raising it.
 *
 * One field overflows in practice and it is always the same one: a reviewer's
 * verdict prose, copied into `check.passed`/`check.failed` as `detail`. Until now
 * `EventLog.append` threw on it, which turned "this verdict was wordy" into "this
 * invocation loses every task row it had earned".
 *
 * So the prose is replaced by a sentence that says how big it was, what the cap is,
 * and where the full text lives — it is already on disk, written by the executor's
 * own log — and the rest of the payload, including the VERDICT, survives intact. A
 * payload that is oversized for any other reason is returned untouched and the
 * append still refuses it: this function knows how to name exactly one absence, and
 * trimming a field it does not understand would be the framework editing its own
 * record.
 *
 * Identity is the contract for the ordinary case: an in-cap payload comes back as
 * the SAME object, so every event this framework has ever written is byte-identical.
 */
export function capPayload(
  payload: Readonly<Record<string, unknown>>,
  pointer: string | null = null,
): Readonly<Record<string, unknown>> {
  const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (size <= MAX_PAYLOAD_BYTES) return payload;
  if (typeof payload.detail !== "string") return payload;
  const { detail: _dropped, ...rest } = payload;
  const where = pointer === null || pointer === ""
    ? "the full text is on disk in the stage's own artefacts, not in this event"
    : `full text in ${pointer}`;
  return {
    ...rest,
    detail_omitted: `${String(size)} bytes exceeds the ${String(MAX_PAYLOAD_BYTES)}-byte cap — ${where}`,
  };
}
```

**3b.** `src/core/facilitator/runNext.ts`, the `emit` closure at `:1082-1084`:

```ts
    emit: (type, payload, costUsd = 0, actor = null) => {
      // The cap is honoured HERE, at the one seam every executor event goes
      // through, so no executor has to know about it and none can be killed by it.
      // The pointer is composed only from keys the payload already carries; with
      // either one missing the sentence says the text is elsewhere rather than
      // naming a file that may not exist.
      const story = typeof payload.story === "string" ? payload.story : null;
      const pointer = story === null ? null : `${BUILD_PHASE}/${LOG_DIR}/${story}.md`;
      store.append(event(options, store.runId, stageId, type, capPayload(payload, pointer), costUsd, actor));
    },
```

Add to the import block: `capPayload` from `../events/Event.ts` (the file already imports
`type TldrxEvent` from there at `:39`), and `BUILD_PHASE, LOG_DIR` from `../build/plan.ts`
(`runNext.ts:61` already imports from `../build/implicitPlan.ts`, so the layer is already
crossed).

**3c.** `src/core/facilitator/runNext.ts:1087`, wrap the executor call:

```ts
  let outcome: ExecutorOutcome;
  try {
    outcome = await executor(executorCtx);
  } catch (error) {
    // A throw out of an executor used to escape past everything below: the stage
    // stayed `running` in a file nobody saved, and whatever the executor had
    // already put on disk — an epic merge, a story marked done — stood with no
    // record of what it cost.
    //
    // What CAN be recovered here is recovered: the stage is failed by name, the
    // throw is recorded as an `error` event, and the store is saved. What cannot
    // is said out loud rather than guessed at — `ExecutorOutcome.tasks` only
    // exists at RETURN, so a turn the executor completed before the throw has no
    // row here, and the message says so instead of implying the ledger is whole.
    const why = error instanceof Error ? error.message : String(error);
    store.append(event(options, store.runId, stageId, "error", {
      phase: phaseId,
      where: "executor",
      message: why,
      tasks_recorded: false,
    }, 0));
    store.save();
    return failStage(store, options, phaseId, stageId,
      `the executor threw and its task rows could not be recovered: ${why}`, notes);
  }
```

- [ ] **Step 4: Run the tests to verify they pass, then mutate**

Run: `bun test test/payload-cap.test.ts`
Expected: PASS.

Mutate `if (size <= MAX_PAYLOAD_BYTES) return payload;` to `return payload;` unconditionally,
re-run, and confirm the second and third cases go red. Restore.

Then run the executors' own suites — they are the ones that exercise the seam end to end:

Run: `bun test test/build-executor.test.ts test/review-handshake.test.ts test/watch.test.ts`
Expected: PASS with no edits. Every existing event is inside the cap, so `capPayload` returns
the same object and the bytes are unchanged. Label this a **guard**, not a proof.

- [ ] **Step 5: Run every gate, each exit code on its own line**

Same block as Task 1, Step 6.

- [ ] **Step 6: Commit**

```bash
git add src/core/events/Event.ts src/core/facilitator/runNext.ts test/payload-cap.test.ts
git commit -m "$(cat <<'EOF'
fix(events): name what the 4096-byte cap left out instead of losing the invocation

An oversized reviewer verdict made `EventLog.append` throw, and nothing wrapped the
executor call — so `recordExecutorTasks` and `store.save()` never ran and every task's
cost went missing while the epic merge stood on disk. The cap is honoured, never
raised: at the emit seam an oversized `detail` becomes `detail_omitted`, carrying its
own byte count and pointing at the log that already holds the prose, and the verdict
itself survives. The executor call is wrapped so a throw fails the stage by name and
saves, and says plainly which rows it could not recover.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 5: `tldrx facts add` becomes a real command

**Why:** the drive mandate tells the driver to run it — `src/core/drive/mandate.ts:346-347`:

```
    "Write no `tldrx note` on this run. Nobody will audit it, and no prompt ever reads one back — a",
    "fact that must outlive the turn is `tldrx facts add`, which every later prompt DOES read.",
```

pinned by `test/drive.test.ts:563` (`expect(text).toContain("tldrx facts add")`). No `facts`
command is dispatched (`src/cli/index.ts:56-88`) and there is no `facts` entry in
`src/cli/helpText.ts`. Drivers hand-edit `facts.yml` instead, which bypasses
`FactsStore.append`'s `MAX_FACT_CHARS` cut and its `truncated:` marker — the mid-word cut seen
in a real `facts.yml` (`inferred`: only a hand edit produces it).

**Files:**
- Create: `src/cli/commands/facts.ts`, `test/facts-add.test.ts`
- Modify: `src/cli/index.ts` (import + `COMMANDS`), `src/cli/helpText.ts` (a `facts` entry)
- Modify: `src/core/facts/Fact.ts` (`FactSource.decided_by`),
  `src/core/facts/emitFactsYaml.ts:82-83`, `src/core/facts/validateFactsFile.ts:84-94`

**Interfaces:**
- Consumes: nothing.
- Produces: `factsCommand: Command` (`name: "facts"`, `subcommands: ["add"]`), and
  `FactSource.decided_by?: "owner" | "driver"`.
- Surface, which `--help` is the authority for and the docs quote:

  ```
  tldrx facts add "<text>" --area <id> [--kind answer|observed|derived]
                  [--confidence measured|inferred|stated] [--decided-by owner|driver]
                  [--repo <name>] [--run <id>] [--root <path>]
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/facts-add.test.ts`:

```ts
/**
 * `tldrx facts add` — the command the drive mandate has been telling drivers to run.
 *
 * `mandate.ts` says "a fact that must outlive the turn is `tldrx facts add`, which
 * every later prompt DOES read", and until now no such command was dispatched. What
 * drivers did instead was hand-edit `.tldrx/memory/facts.yml`, which walks straight
 * past `FactsStore.append`: past the MAX_FACT_CHARS cut, past the `…` marker, past
 * the `truncated: true` flag, and past `save()`'s validation. A fact cut mid-word
 * with no marker on it is a record that does not know it is incomplete.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factsCommand } from "../src/cli/commands/facts.ts";
import { FactsStore } from "../src/core/facts/FactsStore.ts";
import { MAX_FACT_CHARS } from "../src/core/facts/Fact.ts";
import { renderMandate } from "../src/core/drive/mandate.ts";
import { spawnTestTimeout } from "./fixtures/machineLoad.ts";

setDefaultTimeout(spawnTestTimeout());
```

> **Note for the implementer:** `test/facts-add.test.ts` uses the shared workspace fixture the
> other CLI tests use (whichever `makeWorkspace`/`workspace()` helper
> `test/money-safety.test.ts` and `test/questions-grammar.test.ts` import — read one of them
> and use the SAME one; do not write a third). If the fixture it pulls in reaches
> `node:child_process` or `makeBuildWorkspace`, this file counts as a spawner and the
> `setDefaultTimeout(spawnTestTimeout())` line above is required and `test/machine-load.test.ts`
> gains one guard row — reconcile the test-count delta. If it does not, drop the
> `setDefaultTimeout` line and the `machineLoad` import, and say so in the report. Determine
> which by reading the fixture, not by guessing. Also fix `renderMandate`'s real exported name
> by reading `src/core/drive/mandate.ts` — do not quote it from memory.

Then the cases:

```ts
describe("tldrx facts add", () => {
  test("writes a fact through the store, with the area, kind and confidence given", async () => {
    const ws = makeWorkspace();
    const code = await factsCommand.run([
      "add", "The outbox lives in the billing repo, not the api one.",
      "--area", "billing", "--kind", "observed", "--confidence", "measured",
      "--root", ws.root,
    ]);

    expect(code).toBe(0);
    const store = FactsStore.load(join(ws.root, ".tldrx", "memory", "facts.yml"));
    const fact = store.facts[0];
    expect(fact?.id).toBe("F001");
    expect(fact?.fact).toBe("The outbox lives in the billing repo, not the api one.");
    expect(fact?.area).toBe("billing");
    expect(fact?.kind).toBe("observed");
    expect(fact?.confidence).toBe("measured");
    expect(fact?.truncated).toBeUndefined();
  });

  test("a fact over the cap is cut at the cap, marked, and says so on stdout", async () => {
    const ws = makeWorkspace();
    const long = "y".repeat(MAX_FACT_CHARS + 500);

    const printed = capture();
    const code = await factsCommand.run(["add", long, "--area", "unscoped", "--root", ws.root]);
    const out = printed();

    expect(code).toBe(0);
    const fact = FactsStore.load(join(ws.root, ".tldrx", "memory", "facts.yml")).facts[0];
    expect(fact?.fact).toHaveLength(MAX_FACT_CHARS);
    expect(fact?.fact.endsWith("…")).toBe(true);
    expect(fact?.truncated).toBe(true);
    // The cut is told to the person who made it, at the moment they made it — a
    // marker only a later reader sees is a marker the author never acts on.
    expect(out).toContain("truncated");
    expect(out).toContain(String(MAX_FACT_CHARS));
  });

  test("attribution is recorded, and a driver default is never cited as the owner's", async () => {
    const ws = makeWorkspace();
    await factsCommand.run([
      "add", "Retries are capped at three.", "--area", "billing",
      "--decided-by", "driver", "--root", ws.root,
    ]);

    const path = join(ws.root, ".tldrx", "memory", "facts.yml");
    expect(readFileSync(path, "utf8")).toContain("decided_by: driver");
    expect(FactsStore.load(path).facts[0]?.source.decided_by).toBe("driver");
  });

  test("a fact with no area is a usage error, and nothing is written", async () => {
    const ws = makeWorkspace();
    const code = await factsCommand.run(["add", "Something true.", "--root", ws.root]);
    expect(code).toBe(1);
    expect(existsSync(join(ws.root, ".tldrx", "memory", "facts.yml"))).toBe(false);
  });

  test("an empty fact is a usage error — a fact without an assertion is not a fact", async () => {
    const ws = makeWorkspace();
    expect(await factsCommand.run(["add", "   ", "--area", "billing", "--root", ws.root])).toBe(1);
  });

  test("the string the drive mandate tells drivers to run is a command that exists", () => {
    // The load-bearing one. `test/drive.test.ts` pins that the mandate SAYS
    // `tldrx facts add`; this pins that saying it is not a lie.
    expect(renderMandate({ mode: "unattended", tldr: true })).toContain("tldrx facts add");
    expect(factsCommand.name).toBe("facts");
    expect(factsCommand.subcommands).toContain("add");
    expect(factsCommand.implemented).toBe(true);
  });
});
```

`capture()` is the stdout-capturing helper `test/questions-grammar.test.ts:353` already uses —
import it from the same fixture rather than writing a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/facts-add.test.ts`
Expected: FAIL at import — `Cannot find module '../src/cli/commands/facts.ts'`.

- [ ] **Step 3: Write the implementation**

**3a.** `src/core/facts/Fact.ts`, inside `FactSource`:

```ts
export interface FactSource {
  readonly who: string;
  readonly when: string;
  readonly run: string | null;
  readonly q: string | null;
  /**
   * WHO DECIDED, as against `who`, which is the account that typed it.
   *
   * ADDITIVE and optional. 0.8.0's rule is that a driver's default is never cited
   * as the owner's decision, and a fact is exactly the artefact that gets cited
   * later — so a row that cannot say which of the two it was says nothing rather
   * than implying the stronger one. Absent means "not stated", never "owner".
   */
  readonly decided_by?: "owner" | "driver";
}

export const FACT_DECIDERS = ["owner", "driver"] as const;
export type FactDecider = (typeof FACT_DECIDERS)[number];
```

**3b.** `src/core/facts/emitFactsYaml.ts:82-83`, emit it only when present:

```ts
  const decidedBy = fact.source.decided_by === undefined
    ? ""
    : `, decided_by: ${yamlScalar(fact.source.decided_by)}`;
```

and append `${decidedBy}` inside the `source: {…}` braces, before the closing `}`.

**3c.** `src/core/facts/validateFactsFile.ts`, inside the `isRecord(row.source)` branch
(currently `:84-94`), after the `q` check:

```ts
      // Additive, so absence is fine and only a value outside the closed set is an
      // issue: a row written before the field existed must keep validating.
      const decidedBy = row.source.decided_by;
      if (decidedBy !== undefined && decidedBy !== "owner" && decidedBy !== "driver") {
        issues.push({
          path: `${path}.source.decided_by`,
          message: "expected owner, driver or absent",
        });
      }
```

**3d.** Create `src/cli/commands/facts.ts`. Model it on `src/cli/commands/note.ts` — argv and
exit codes here, all the work in the core:

```ts
/**
 * `tldrx facts add` — record one durable, provenanced fact (spec §2.5).
 *
 * The command the drive mandate has been naming since 0.8.0 (`mandate.ts`: "a fact
 * that must outlive the turn is `tldrx facts add`, which every later prompt DOES
 * read"). Without it, a driver's only way to write one was to edit
 * `.tldrx/memory/facts.yml` by hand — which walks past `FactsStore.append`'s cap,
 * past its `…` marker and its `truncated: true` flag, and past `save()`'s
 * validation. A fact cut mid-word with no marker is a record that does not know it
 * is incomplete.
 *
 * Everything real is in `FactsStore.update` — load, mint the id, cap, mark, validate
 * and write, all inside ONE workspace lock, because `nextId()` is `max(id) + 1` off
 * the file and two writers without the lock both mint `F001`.
 */
import type { Command } from "../Command.ts";
import { EXIT_OK, EXIT_USAGE } from "../exitCodes.ts";
import { parseArgs, repeatedFlag, stringFlag } from "../argv.ts";
import { workspaceRootFrom } from "../workspace.ts";
import { fail } from "../report.ts";
import { FactsStore } from "../../core/facts/FactsStore.ts";
import {
  FACT_CONFIDENCES, FACT_DECIDERS, FACT_KINDS, MAX_FACT_CHARS,
  type FactConfidence, type FactDecider, type FactKind,
} from "../../core/facts/Fact.ts";
import { factsPath } from "../../hooks/lib/workspace.ts";
import { RunStore } from "../../core/run/RunStore.ts";
import { EventLog } from "../../core/events/EventLog.ts";
import { currentActor, nowRfc3339 } from "../../hooks/lib/actor.ts";

const VALUE_FLAGS = ["area", "kind", "confidence", "decided-by", "repo", "run", "root"];

export const factsCommand: Command = {
  name: "facts",
  summary: "Record one durable, provenanced fact the later prompts will read",
  usage:
    'tldrx facts add "<text>" --area <id> [--kind <kind>] [--confidence <level>] '
    + "[--decided-by <who>] [--repo <name>] [--run <id>] [--root <path>]",
  subcommands: ["add"],
  implemented: true,
  async run(argv: readonly string[]): Promise<number> {
    try {
      const args = parseArgs(argv, VALUE_FLAGS);
      const [sub, ...rest] = args.positionals;
      if (sub !== "add") {
        process.stderr.write(`tldrx facts: ${factsCommand.usage}\n`);
        return EXIT_USAGE;
      }
      const text = (rest[0] ?? "").trim();
      const area = (stringFlag(args, "area") ?? "").trim();
      const kind = (stringFlag(args, "kind") ?? "observed") as FactKind;
      const confidence = (stringFlag(args, "confidence") ?? "stated") as FactConfidence;
      const decidedBy = stringFlag(args, "decided-by");

      // Refused before anything is opened, and each refusal names the one thing
      // that was wrong. A fact with no assertion, or no area to file it under, is
      // not a fact the no-re-ask hook or a `{{facts}}` block can ever match.
      const problem = firstProblem(text, area, kind, confidence, decidedBy);
      if (problem !== null) {
        process.stderr.write(`tldrx facts add: ${problem}\n`);
        return EXIT_USAGE;
      }

      const root = workspaceRootFrom(args);
      // The run is provenance, and it is ABSENT WITH A REASON when it cannot be
      // established: `--run` names one, one open run is unambiguous, and several
      // open runs are not something to guess between.
      const resolved = RunStore.resolve(root, stringFlag(args, "run"));
      const runId = resolved.kind === "one" ? resolved.store.run.id : null;

      const fact = FactsStore.update(factsPath(root), (store) => store.append({
        fact: text,
        area,
        repos: [...repeatedFlag(args, "repo")],
        kind,
        confidence,
        source: {
          who: currentActor(),
          when: nowRfc3339(),
          run: runId,
          q: null,
          ...(decidedBy === undefined ? {} : { decided_by: decidedBy as FactDecider }),
        },
      }));

      const lines = [`recorded ${fact.id} in ${area}: ${fact.fact}`];
      if (fact.truncated === true) {
        lines.push(
          `  the text was truncated to ${String(MAX_FACT_CHARS)} characters and marked `
          + "`truncated: true` — a fact is one assertion, not a document",
        );
      }
      if (runId === null) {
        lines.push(
          resolved.kind === "ambiguous"
            ? "  no run recorded: several runs are open and this will not guess between them — "
              + "pass `--run <id>` to attribute it"
            : "  no run recorded: no open run to attribute it to",
        );
      } else {
        EventLog.forRun(resolved.kind === "one" ? resolved.store.runDir : "").tryAppend({
          ts: fact.source.when,
          run: runId,
          stage: null,
          type: "fact.added",
          actor: fact.source.who,
          cost_usd: 0,
          payload: { fact: fact.id, area: fact.area, kind: fact.kind, q: null },
        });
      }
      process.stdout.write(`${lines.join("\n")}\n`);
      return EXIT_OK;
    } catch (error) {
      return fail("facts", error);
    }
  },
};

/** The first thing wrong with the invocation, or null when nothing is. */
function firstProblem(
  text: string,
  area: string,
  kind: string,
  confidence: string,
  decidedBy: string | undefined,
): string | null {
  if (text === "") return "the fact text is required — a fact without an assertion is not a fact";
  if (area === "") return "--area is required: it is how every reader of facts.yml scopes a match";
  if (!(FACT_KINDS as readonly string[]).includes(kind)) {
    return `--kind must be one of ${FACT_KINDS.join(", ")}`;
  }
  if (!(FACT_CONFIDENCES as readonly string[]).includes(confidence)) {
    return `--confidence must be one of ${FACT_CONFIDENCES.join(", ")}`;
  }
  if (decidedBy !== undefined && !(FACT_DECIDERS as readonly string[]).includes(decidedBy)) {
    return `--decided-by must be one of ${FACT_DECIDERS.join(", ")}`;
  }
  return null;
}
```

Read `src/cli/report.ts`, `src/cli/workspace.ts` and `src/hooks/lib/workspace.ts` before
writing this file and fix any name that differs — `fail`, `workspaceRootFrom` and `factsPath`
are quoted from `note.ts:20-24` and `runNext.ts:37`, but confirm rather than trust the quote.
The `EventLog.forRun("")` branch above is unreachable (guarded by `runId !== null`); if the
narrowing does not satisfy the typechecker, hoist `resolved.store` into a local before the
branch rather than adding a cast.

**3e.** `src/cli/index.ts`: add `import { factsCommand } from "./commands/facts.ts";` beside
the other command imports, and put `factsCommand` in `COMMANDS` immediately after
`noteCommand` — that is where the help listing groups the "record something" verbs.

**3f.** `src/cli/helpText.ts`: add an entry modelled on the `expert` block at `:941-991`. Every
flag the command reads must be declared or `test/cli.test.ts:197` ("every flag a command reads
is declared") goes red:

```ts
  {
    name: "facts",
    description: "Record one durable, provenanced fact the later prompts will read.",
    args: [
      { name: "add", meaning: "The only subcommand today." },
      { name: '"<text>"', meaning: "The assertion, one sentence. Required." },
    ],
    flags: [
      { name: "area", arg: "<id>", meaning: "Which area the fact is about. Required — it is how every reader of facts.yml scopes a match.", sub: "add" },
      { name: "kind", arg: "<kind>", meaning: "What sort of fact this is.", values: FACT_KINDS, sub: "add" },
      { name: "confidence", arg: "<level>", meaning: "How well it is known. `measured` means you ran the check.", values: FACT_CONFIDENCES, sub: "add" },
      { name: "decided-by", arg: "<who>", meaning: "Who decided, as against who typed it. A driver default is never cited as the owner's.", values: FACT_DECIDERS, sub: "add" },
      { name: "repo", arg: "<name>", meaning: "Scope the fact to one repo. Repeatable.", repeatable: true, sub: "add" },
      { name: "run", arg: "<id>", meaning: "Attribute it to this run. Without it, one open run is used and several are refused rather than guessed between.", sub: "add" },
      root(),
    ],
    examples: [
      'tldrx facts add "The outbox lives in the billing repo." --area billing --kind observed --confidence measured',
      'tldrx facts add "Retries are capped at three." --area billing --decided-by owner',
    ],
    exits: [EXIT_OK, EXIT_USAGE],
    notes: [
      "A fact is one assertion, capped at 2000 characters. Over the cap it is cut, ends in `…`, and carries `truncated: true` — and the command says so on stdout, because a marker only a later reader sees is one the author never acts on.",
      "It writes through `FactsStore`, under the workspace lock: load, mint the id, cap, validate, save. Editing `.tldrx/memory/facts.yml` by hand walks past all four.",
      "`--decided-by` is optional and absent means \"not stated\", never \"owner\": a fact gets cited later, and a row that cannot say which it was must not imply the stronger one.",
    ],
  },
```

Import `FACT_CONFIDENCES`, `FACT_DECIDERS` and `FACT_KINDS` from `../core/facts/Fact.ts` at the
top of `helpText.ts` — the file's own docstring (`:17-19`) requires closed value sets to be
imported from where they are enforced, never retyped.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/facts-add.test.ts test/cli.test.ts test/drive.test.ts test/schemas.test.ts`
Expected: PASS. In particular:
- `test/cli.test.ts:177` ("every dispatchable command has an entry") and `:197` ("every flag a
  command reads is declared") must pass without loosening either.
- `test/drive.test.ts:563` stays green untouched — it is now a proof rather than a wish.
- `test/schemas.test.ts` needs no edit: `decided_by` is additive under `version: 1`.

Mutation check: remove `decided_by` from the `emitFactsYaml` source line, re-run, and confirm
the attribution test goes red.

- [ ] **Step 5: Run every gate, each exit code on its own line**

Same block as Task 1, Step 6. `bun run docs:build` matters here: `test/cli.test.ts:416`
requires a `## \`tldrx facts\`` heading only for the five commands in `DOCUMENTED_SUBCOMMANDS`,
which `facts` is not — the docs page for it is Task 8. If a gate demands it earlier, do it here
and say so.

- [ ] **Step 6: Commit**

```bash
git add src/cli/ src/core/facts/ test/facts-add.test.ts
git commit -m "$(cat <<'EOF'
feat(facts): tldrx facts add — the command the drive mandate already names

Since 0.8.0 the mandate has told drivers "a fact that must outlive the turn is
`tldrx facts add`", and no such command was dispatched. What they did instead was
hand-edit facts.yml, which walks past FactsStore.append's 2000-character cap, its `…`
marker, its `truncated: true` flag and save()'s validation — a fact cut mid-word with
no marker is a record that does not know it is incomplete. The command writes through
the store, under the workspace lock, and records attribution: `decided_by` is
additive and absent means "not stated", never "owner", because a driver's default is
never cited as the owner's decision.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 6: pre-flight cache honesty — `command_hash`, a red TTL, and `--prepare` always probes

**Why:** `04-build/preflight.yml` is invalidated only by the base-sha comparison at
`preflight.ts:189`, which no-ops when either sha is `""`. `checked_at` is written
(`:88`) and never compared. So a cached RED is trusted forever: `--prepare` returns it in
0 seconds (`build.ts:667-673` → `refuseOnRedBase` → `baseResultFor` at `:2971`) over a base
that a live probe now shows green, and the operator's fix to `.tldrx/workspace.yml` — the fix
the refusal itself tells them to make — is invisible to the cache.

**Files:**
- Modify: `src/core/build/preflight.ts` (the whole freshness rule; it is a leaf)
- Modify: `src/core/build/index.ts` (re-export `commandHash`, `PREFLIGHT_RED_TTL_MS`)
- Modify: `src/core/facilitator/executors/build.ts:2962-2994` — argument passing only
- Test: `test/dod-preflight.test.ts` — new unit cases, and the re-scope of `:159-172`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `commandHash(command: string, workspaceCommands: readonly string[]) => string` — 12 hex
    characters.
  - `PREFLIGHT_RED_TTL_MS = 30 * 60 * 1000`.
  - `BaseCommandResult.commandHash?: string` and `BaseCommandResult.checkedAt?: string`
    (additive, per row).
  - `baseResultFor(preflight, repo, command, baseSha?, freshness?: BaseFreshness)` — the
    existing four-argument call sites are unchanged.
  - `interface BaseFreshness { commandHash?: string; at?: string; prepare?: boolean }`.

- [ ] **Step 1: Write the failing tests**

Add to `test/dod-preflight.test.ts`, in the `describe("attributing a red DoD command")` file
section (the leaf is where the decision lives, so this is where it is pinned):

```ts
describe("when a cached RED may still be trusted", () => {
  const HASH = "0123456789ab";
  const red: BasePreflight = {
    checkedAt: "2026-08-31T09:00:00Z",
    results: [row({ commandHash: HASH, checkedAt: "2026-08-31T09:00:00Z" })],
  };
  const green: BasePreflight = {
    checkedAt: "2026-08-31T09:00:00Z",
    results: [row({
      exitCode: 0, status: "ok", tail: "",
      commandHash: HASH, checkedAt: "2026-08-31T09:00:00Z",
    })],
  };

  test("a fresh red, same command hash, is served from the cache", () => {
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-08-31T09:20:00Z",
    });
    expect(failedOnBase(hit)).toBe(true);
  });

  test("a red older than the TTL is null, so the caller re-probes", () => {
    // 30 minutes. A base tree is a moving thing and a red is the answer that
    // costs the most to be wrong about: every story blocks for it.
    expect(PREFLIGHT_RED_TTL_MS).toBe(30 * 60 * 1000);
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-08-31T09:31:00Z",
    });
    expect(hit).toBeNull();
  });

  test("a red measured under a different command hash is null — the operator's fix is visible", () => {
    // The refusal tells the operator to fix `.tldrx/workspace.yml`. The command
    // string can come back byte-identical from that edit while everything AROUND
    // it changed, and joining on the string alone made the fix invisible.
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: "ffffffffffff", at: "2026-08-31T09:01:00Z",
    });
    expect(hit).toBeNull();
  });

  test("under --prepare a red is always re-probed, however fresh", () => {
    // A `--prepare` that returns a refusal in 0 seconds over a base nobody
    // measured today is the lie this is about.
    const hit = baseResultFor(red, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-08-31T09:00:30Z", prepare: true,
    });
    expect(hit).toBeNull();
  });

  test("a cached GREEN keeps today's rule — hash, age and --prepare change nothing", () => {
    for (const freshness of [
      { commandHash: "ffffffffffff", at: "2026-09-30T09:00:00Z" },
      { commandHash: HASH, at: "2026-09-30T09:00:00Z", prepare: true },
    ]) {
      expect(baseResultFor(green, "app", "npm run test", "", freshness)?.exitCode).toBe(0);
    }
  });

  test("an unmeasured row is not re-probed either — the gate declined to run it", () => {
    const unmeasured: BasePreflight = {
      checkedAt: "2026-08-31T09:00:00Z",
      results: [row({ exitCode: 126, status: "unmeasured", tail: "needs a shell" })],
    };
    expect(baseResultFor(unmeasured, "app", "npm run test", "", {
      at: "2026-09-30T09:00:00Z", prepare: true,
    })?.status).toBe("unmeasured");
  });

  test("a row with no clock and no hash is never invalidated by their absence", () => {
    // The same rule the sha comparison already follows: a missing answer is not a
    // mismatch. Every preflight.yml written before these fields existed is in
    // exactly this shape.
    const old: BasePreflight = { checkedAt: "", results: [row()] };
    expect(failedOnBase(baseResultFor(old, "app", "npm run test", "", {
      commandHash: HASH, at: "2026-09-30T09:00:00Z",
    }))).toBe(true);
  });

  test("the hash covers the workspace allowlist, not only the command string", () => {
    expect(commandHash("npm run test", ["npm run test"]))
      .not.toBe(commandHash("npm run test", ["npm run test", "npm run lint"]));
    expect(commandHash("npm run test", ["a", "b"])).toBe(commandHash("npm run test", ["b", "a"]));
    expect(commandHash("npm run test", [])).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the new keys round-trip and are written only when present", () => {
    const text = emitPreflightYaml(red);
    expect(text).toContain(`command_hash: ${HASH}`);
    expect(parsePreflight(text)).toEqual(red);

    const bare = emitPreflightYaml({ checkedAt: "", results: [row()] });
    expect(bare).not.toContain("command_hash");
    expect(parsePreflight(bare)?.results[0]?.commandHash).toBeUndefined();
  });
});
```

Extend the import at `test/dod-preflight.test.ts:26-30` with `commandHash` and
`PREFLIGHT_RED_TTL_MS`.

Then **re-scope** the integration test at `:159-172`. Its claim — "the base check is paid for
once per run", asserted over a RED base with a second invocation 65 minutes later
(`at: "2026-08-29T09:00:00Z"` then `"2026-08-29T10:05:00Z"`) — is exactly the behaviour that
is now wrong. Replace it with:

```ts
  test("a fresh cached red refuses again without re-running the command", async () => {
    const ws = workspace({ ...ONE, testScript: RED_ON_BASE });

    await next(ws);
    expect(tickCount()).toBe(1);
    expect(existsSync(join(ws.runDir, PREFLIGHT_REL))).toBe(true);
    const cached = readFileSync(join(ws.runDir, PREFLIGHT_REL), "utf8");
    expect(cached).toContain("npm run test");
    expect(cached).toContain("command_hash:");

    // Five minutes later, same workspace: the cache answers and the repo is not touched.
    const again = await next(ws, { at: "2026-08-29T09:05:00Z" });
    expect(again.code).toBe(2);
    expect(tickCount()).toBe(1);
  }, 90_000);

  test("a red older than the TTL is measured again rather than trusted", async () => {
    // The whole point: a base tree moves, and a red is the answer that costs the
    // most to be wrong about — it blocks every story in the plan.
    const ws = workspace({ ...ONE, testScript: RED_ON_BASE });

    await next(ws);
    expect(tickCount()).toBe(1);

    const again = await next(ws, { at: "2026-08-29T10:05:00Z" });
    expect(again.code).toBe(2);
    expect(tickCount()).toBe(2);
  }, 90_000);
```

The green-base half of the old claim — "a cached green is not re-run" — is pinned at the leaf
by the `a cached GREEN keeps today's rule` case above, where it can be asserted directly
instead of inferred from a tick file that a green base's story-tree DoD run would also touch.
Say exactly that in the task report.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dod-preflight.test.ts`
Expected: FAIL at import — `Export named 'commandHash' not found in module …/preflight.ts`.
Once the exports exist but the rule does not, the `--prepare` and TTL cases fail with
`expect(received).toBeNull() … Received: {repo: "app", …}`, and the integration re-scope fails
with `Expected: 2, Received: 1` on `tickCount()`.

- [ ] **Step 3: Write the implementation**

**3a.** `src/core/build/preflight.ts` — add to the imports:

```ts
import { createHash } from "node:crypto";
```

**3b.** Extend `BaseCommandResult` (after `status`):

```ts
  /**
   * What the row was measured UNDER, beyond the command string itself.
   *
   * The command string is already the join key, so a hash OF IT would never
   * differ for a row that matched. This hashes the command together with the
   * workspace's whole declared command list — because the refusal's own advice is
   * "fix `.tldrx/workspace.yml`", and that edit can leave one command byte-identical
   * while changing what the gate will run at all. Without this, the fix the tool
   * asked for was the one thing the cache could not see.
   *
   * ADDITIVE and optional. Absent on every preflight.yml written before it existed,
   * and an absence never invalidates anything — the same rule the sha comparison
   * follows: a missing answer is not a mismatch.
   */
  readonly commandHash?: string;
  /**
   * When THIS row was measured, as against the file-level `checked_at`, which is
   * only ever the newest write in the file. Per-row because the freshness rule
   * below is per-row: with one shared clock, re-probing the first stale red would
   * stamp the file `now` and make every other stale red in it look fresh.
   *
   * ADDITIVE and optional; absent falls back to the file-level `checked_at`, and
   * with neither the row is never invalidated by age.
   */
  readonly checkedAt?: string;
```

**3c.** Add the hash and the TTL:

```ts
/**
 * How long a MEASURED RED may be trusted before it is probed again.
 *
 * Only a red has a TTL. A green base that has not moved is the same green base —
 * the sha rule already covers the case where it moved. A red is the answer that
 * costs the most to be wrong about: it blocks every story in the plan for something
 * no story caused, and the operator is being told to go fix the workspace, so the
 * cache has to be willing to notice that they did.
 */
export const PREFLIGHT_RED_TTL_MS = 30 * 60 * 1000;

/** The command AND the allowlist it ran under, as twelve hex characters. */
export function commandHash(command: string, workspaceCommands: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([command, [...workspaceCommands].sort()]), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/** What THIS invocation knows about itself, for deciding whether a red still holds. */
export interface BaseFreshness {
  /** `commandHash(command, workspace.commands)` for this invocation. */
  readonly commandHash?: string;
  /** The invocation's own `at` (RFC3339) — never a clock this function reads. */
  readonly at?: string;
  /** True under `tldrx next --prepare`: a 0-second prepare over a red is the lie. */
  readonly prepare?: boolean;
}
```

**3d.** Emit the two keys, conditionally, in `emitPreflightYaml`'s row loop:

```ts
      if (row.commandHash !== undefined) lines.push(`    command_hash: ${yamlScalar(row.commandHash)}`);
      if (row.checkedAt !== undefined) lines.push(`    checked_at: ${yamlScalar(row.checkedAt)}`);
```

**3e.** Read them back in `parsePreflight`, present-only so the round trip is exact:

```ts
    const hash = asText(row.command_hash);
    const rowCheckedAt = asText(row.checked_at);
    results.push({
      repo,
      command,
      baseRef: asText(row.base_ref),
      baseSha: asText(row.base_sha),
      exitCode,
      timedOut: row.timed_out === true,
      tail: asText(row.tail),
      status: row.status === "ok" || row.status === "failed" ? row.status : "unmeasured",
      ...(hash === "" ? {} : { commandHash: hash }),
      ...(rowCheckedAt === "" ? {} : { checkedAt: rowCheckedAt }),
    });
```

**3f.** Replace `baseResultFor` with the freshness-aware version, keeping the positional shape:

```ts
export function baseResultFor(
  preflight: BasePreflight | null,
  repo: string,
  command: string,
  baseSha = "",
  freshness: BaseFreshness = {},
): BaseCommandResult | null {
  if (preflight === null) return null;
  for (const row of preflight.results) {
    if (row.repo !== repo || row.command !== command) continue;
    if (baseSha !== "" && row.baseSha !== "" && row.baseSha !== baseSha) continue;
    // Only a MEASURED RED expires. A green that has not moved is the same green,
    // and `unmeasured` is not evidence of anything, so re-running the command the
    // gate already declined to run would buy nothing.
    if (row.status !== "failed") return row;
    if (freshness.prepare === true) continue;
    if (
      freshness.commandHash !== undefined && row.commandHash !== undefined
      && freshness.commandHash !== row.commandHash
    ) continue;
    if (isStale(row.checkedAt ?? preflight.checkedAt, freshness.at)) continue;
    return row;
  }
  return null;
}

/**
 * Is a red older than the TTL?
 *
 * Both clocks come from the CALLER — the row's own stamp and the invocation's `at`
 * — so this reads no clock of its own and a test can drive it. A clock that is
 * missing or unparseable makes nothing stale: a missing answer is not a mismatch,
 * the same rule an empty sha already follows.
 */
function isStale(measuredAt: string, at: string | undefined): boolean {
  if (measuredAt === "" || at === undefined || at === "") return false;
  const then = Date.parse(measuredAt);
  const now = Date.parse(at);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return false;
  return now - then > PREFLIGHT_RED_TTL_MS;
}
```

**3g.** `withResult` stamps the row's own clock, so `build.ts` keeps its existing call:

```ts
export function withResult(
  preflight: BasePreflight,
  result: BaseCommandResult,
  checkedAt: string,
): BasePreflight {
  const kept = preflight.results.filter((row) => !(row.repo === result.repo && row.command === result.command));
  // The row carries the moment it was measured, beside the file-level stamp: the
  // freshness rule is per row, and one shared clock would make re-probing the
  // first stale red look like a re-probe of every other row in the file.
  const stamped = checkedAt === "" ? result : { ...result, checkedAt };
  return { checkedAt: checkedAt === "" ? preflight.checkedAt : checkedAt, results: [...kept, stamped] };
}
```

**3h.** `src/core/facilitator/executors/build.ts:2962-2994` — argument passing only. Compute
the hash once, pass the freshness in, and stamp it on both `measured` literals:

```ts
    const baseSha = await shaOf(repoDir, baseRef);
    const hash = commandHash(command, this.workspace.commands);
    const cached = baseResultFor(this.basePreflight(), repo, command, baseSha, {
      commandHash: hash,
      at: this.ctx.at,
      prepare: this.ctx.mode === "prepare",
    });
    if (cached !== null) return cached;
```

and add `commandHash: hash,` to the two `measured = { … }` object literals at `:2979-2982` and
`:2988-2991`. Add `commandHash` to the `preflight.ts` import at `build.ts:71-72`.

**3i.** `src/core/build/index.ts`: re-export `commandHash`, `PREFLIGHT_RED_TTL_MS` and
`type BaseFreshness` beside the existing preflight exports.

- [ ] **Step 4: Run the tests to verify they pass, then mutate**

Run: `bun test test/dod-preflight.test.ts test/dashboard-leftovers.test.ts`
Expected: PASS. `test/dashboard-leftovers.test.ts:112` writes a `preflight.yml` fixture with no
`command_hash` — it must stay green untouched, which is the tolerant-read proof.

Mutate `if (freshness.prepare === true) continue;` to `if (false) continue;`, re-run, confirm
the `--prepare` cases go red. Then mutate `isStale` to `return false;` and confirm the TTL
cases go red. Restore both.

- [ ] **Step 5: Run every gate, each exit code on its own line**

Same block as Task 1, Step 6.

- [ ] **Step 6: Commit**

```bash
git add src/core/build/ src/core/facilitator/executors/build.ts test/dod-preflight.test.ts
git commit -m "$(cat <<'EOF'
fix(build): stop trusting a cached red base forever

preflight.yml was invalidated only by a base-sha comparison that no-ops on an empty
sha, and `checked_at` was written and never read — so a red measured once was
returned in 0 seconds by every later `--prepare`, over a base a live probe now shows
green, and the workspace.yml fix the refusal itself asks for was the one thing the
cache could not see. A red is now re-probed when the command hash differs (the hash
covers the whole declared allowlist, because the command string is already the join
key), when it is older than 30 minutes, or always under `--prepare`. A cached green
keeps the rule it had. Both new fields are additive and an absent one invalidates
nothing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 7: the fix list records the canonical 40-hex sha

**Why:** `fixlist.ts:379` reads a resolved sha with `/\b([0-9a-f]{7,40})\b/`, so a 39-character
sha is treated as an abbreviation. `git rev-parse` resolves it happily
(`git.ts:251-257`), the claim verifies, and the record keeps the truncated form — a sha a
later reader cannot distinguish from a deliberate abbreviation of a different commit.

**Files:**
- Modify: `src/core/build/git.ts` (new `canonicalSha`, beside `shaReachability`)
- Modify: `src/core/build/fixlist.ts` (new `canonicalizeResolvedSha`, sibling of
  `markUnverified` at `:482-493`)
- Modify: `src/core/build/index.ts` (re-export both)
- Modify: `src/core/facilitator/executors/build.ts:1460-1476` (`verifyResolutions`) — the
  call site only
- Test: whichever existing file pins `markUnverified` / `claimed-unverified` (find it with
  `grep -rln "markUnverified\|CLAIMED_UNVERIFIED" test/`); add there rather than starting a
  new file.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `canonicalSha(cwd: string, sha: string) => Promise<string | null>` — the full 40-hex
    object id, or null when git will not resolve it to a commit.
  - `canonicalizeResolvedSha(text: string, n: number, sha: string) => string` — text in, text
    out, no I/O, exactly like `markUnverified`.

- [ ] **Step 1: Write the failing tests**

Add to the file you found above:

```ts
describe("a Resolved: yes that names an abbreviation", () => {
  test("is rewritten to the full 40-hex object id", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const text = [
      "## 1 · The retry loop swallows the error  [major]",
      "",
      "Where: src/a.ts:12",
      "Disposition: **fix-now**",
      `Resolved: yes ${full.slice(0, 39)}`,
      "",
    ].join("\n");

    const rewritten = canonicalizeResolvedSha(text, 1, full);

    expect(rewritten).toContain(`Resolved: yes ${full}`);
    expect(rewritten).not.toContain(full.slice(0, 39) + "\n");
    // Everything else about the finding is left exactly as it was.
    expect(rewritten).toContain("Disposition: **fix-now**");
    expect(rewritten).toContain("Where: src/a.ts:12");
    expect(parseFixlistFile(rewritten)[0]?.resolvedSha).toBe(full);
  });

  test("touches no other finding, and no `no` line", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    const text = [
      "## 1 · One  [minor]", "", "Disposition: **fix-now**", "Resolved: yes 0123456", "",
      "## 2 · Two  [minor]", "", "Disposition: **fix-now**", "Resolved: no", "",
    ].join("\n");

    const rewritten = canonicalizeResolvedSha(text, 1, full);

    expect(rewritten).toContain(`Resolved: yes ${full}`);
    expect(rewritten).toContain("Resolved: no");
  });

  test("a 7-40 hex abbreviation is still ACCEPTED — nothing legitimate is refused", () => {
    // The grammar is unchanged on purpose. Demanding 40 would refuse the `yes
    // 9f2c1ab` a person types, which is a real close; canonicalising after the
    // verification is strictly stronger and refuses nobody.
    expect(RESOLVED_SHA_SOURCE).toBe("\\b([0-9a-f]{7,40})\\b");
  });
});
```

If `RESOLVED_SHA_RE` is not exported, do not export it for this assertion — instead pin the
behaviour through `parseFixlistFile`:

```ts
    expect(parseFixlistFile([
      "## 1 · One  [minor]", "", "Disposition: **fix-now**", "Resolved: yes 9f2c1ab", "",
    ].join("\n"))[0]?.resolvedSha).toBe("9f2c1ab");
```

Prefer this second form: it asserts behaviour, not the constant that produced it
(AGENTS.md §8).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test <the file you added to>`
Expected: FAIL — `canonicalizeResolvedSha is not defined` / `Export named
'canonicalizeResolvedSha' not found in module …/fixlist.ts`.

- [ ] **Step 3: Write the implementation**

**3a.** `src/core/build/git.ts`, immediately after `shaReachability`:

```ts
/**
 * The full 40-hex object id `sha` names, or null when git will not resolve it to a
 * commit.
 *
 * `shaReachability` already runs this exact `rev-parse` and throws the answer away.
 * A second call rather than a changed return type, on purpose: the three-value
 * reachability answer is what every caller switches on, and widening it to carry a
 * payload would make every one of them handle a shape it does not need. The cost is
 * one `rev-parse` on the path that already verified.
 */
export async function canonicalSha(cwd: string, sha: string): Promise<string | null> {
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], cwd);
  const full = resolved.stdout.trim();
  return resolved.ok && /^[0-9a-f]{40}$/.test(full) ? full : null;
}
```

**3b.** `src/core/build/fixlist.ts`, immediately after `markUnverified`:

```ts
/**
 * Rewrite finding `n`'s `Resolved: yes …` line to name the FULL object id.
 *
 * The 7-40 grammar stays: demanding 40 would refuse the `yes 9f2c1ab` a person
 * legitimately types. What it could not tell apart was a deliberate abbreviation and
 * a sha that lost a character — a 39-hex string resolves in git exactly as happily,
 * and the record then kept a form no later reader can check against anything.
 * Canonicalising AFTER the verification is strictly stronger and refuses nobody.
 *
 * A sibling of `markUnverified`, and deliberately its mirror image: that one can
 * only move a finding from closed to open, this one changes nothing but the sha's
 * spelling. Text in, text out, no I/O — the caller owns the file, this owns the line.
 */
export function canonicalizeResolvedSha(text: string, n: number, sha: string): string {
  let at: number | null = null;
  return text.split("\n").map((line) => {
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      at = Number(heading[1] ?? "0");
      return line;
    }
    if (at !== n) return line;
    const resolved = RESOLVED_RE.exec(line);
    // Only a `yes` may carry a sha, so only a `yes` is rewritten. A `no` line with
    // a hex word in it is prose.
    if (resolved === null || (resolved[1] ?? "").toLowerCase() !== "yes") return line;
    return `Resolved: yes ${sha}`;
  }).join("\n");
}
```

**3c.** `src/core/facilitator/executors/build.ts:1460-1476`, inside the `verifyResolutions`
loop, replace the `if (why === null) { findings.push(finding); continue; }` branch:

```ts
      if (why === null) {
        // The claim checks out. Now make the RECORD of it checkable too: a 39-hex
        // sha resolves as happily as a 7-hex one, and a reader cannot tell a
        // dropped character from a deliberate abbreviation.
        const full = finding.resolvedSha === null
          ? null
          : await canonicalSha(story.repoDir, finding.resolvedSha);
        if (full === null || full === finding.resolvedSha) {
          findings.push(finding);
          continue;
        }
        findings.push({ ...finding, resolvedSha: full });
        text = canonicalizeResolvedSha(text ?? readFileSync(fixlist.path, "utf8"), finding.n, full);
        this.lines.push(
          `  · ${id}: fix-list finding #${String(finding.n)} named \`${finding.resolvedSha}\` — `
          + `rewritten to the full object id \`${full}\`, so the record names one commit and not a prefix`,
        );
        continue;
      }
```

Add `canonicalSha` to the `git.ts` import at `build.ts:68` and `canonicalizeResolvedSha` to the
`fixlist.ts` import at `:96`. The single `writeFileSync(fixlist.path, text, "utf8")` at
`:1477` already covers both rewrites — do not add a second write.

**3d.** `src/core/build/index.ts`: re-export `canonicalSha` and `canonicalizeResolvedSha`.

- [ ] **Step 4: Run the tests to verify they pass, then mutate**

Run: `bun test <the file you added to> test/build-executor.test.ts`
Expected: PASS. `test/build-executor.test.ts` exercises `verifyResolutions` end to end against
a real git repo — a fix list whose `Resolved: yes <full sha>` already names 40 hex must stay
byte-identical, which is the "refuses nobody" half.

Mutate `if (full === null || full === finding.resolvedSha)` to `if (true)`, re-run, and confirm
the rewrite case goes red. Restore.

- [ ] **Step 5: Run every gate, each exit code on its own line**

Same block as Task 1, Step 6.

- [ ] **Step 6: Commit**

```bash
git add src/core/build/ src/core/facilitator/executors/build.ts test/
git commit -m "$(cat <<'EOF'
fix(fixlist): write the canonical 40-hex sha back into the record

`Resolved: yes <sha>` accepted 7-40 hex, so a 39-character sha read as an
abbreviation: git resolved it, the claim verified, and the audit record kept a form
no later reader can tell from a deliberate prefix of a different commit. The grammar
is unchanged — demanding 40 would refuse the abbreviation a person legitimately types
— and the full object id is written back after the verification, which is strictly
stronger and refuses nobody.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 8: docs — EN and ES in lockstep

**Why:** spec §5. Docs are part of the change (AGENTS.md §5), `docs:build` is a gate since #114
(`ignoreDeadLinks: false`), and one sentence already on the page is now false:
`docs/spec.md:2827` says the 4096-byte cap "REFUSES an oversize one whole rather than
truncating it."

**Files:**
- Modify: `docs/spec.md` — §2.2 `run.yml` task table (`:187-191`), §2.9 payload
  (`:1131-1132`), the reviewer-handshake sentence at `:2827`, and the Build pre-flight
  description wherever `preflight.yml` is specified
- Modify: `docs/ROADMAP.md` — the `## Next — open, nothing written yet` section
- Modify: `docs/guide/08-cli-reference.md` — a `## \`tldrx facts\`` section
- Modify: `docs-site/reference/cli.md` and `docs-site/es/reference/cli.md` — the
  "Knowledge, output and the rest" / "Conocimiento, salida y lo demás" tables

**Interfaces:**
- Consumes: the exact surface Task 5 shipped. **Read `tldrx facts --help` (or
  `src/cli/helpText.ts`) and quote it** — AGENTS.md §1: never quote a CLI flag from memory.
- Produces: nothing code reads, except that `test/cli.test.ts` and
  `test/public-surface-consistency.test.ts` both run over these files.

- [ ] **Step 1: `docs/spec.md` — the four edits**

**1a.** In the §2.2 task table, after the `tasks[].tokens` row at `:190`:

```markdown
| `tasks[].input_tokens` / `.output_tokens` | number ≥0 | n | **Additive.** The PROVIDER's own token split for a turn this process watched, from the result document's `usage`. Distinct from `tokens`, which is a HOST declaration for a turn nothing here metered. Written only when the turn reported them; absent means "not recorded", never zero. Together with `cost_usd` they are what makes a dollar figure checkable against a price table instead of a number nobody can falsify |
```

**1b.** In the §2.9 table at `:1131-1132`, after the `payload` row:

```markdown
| `payload.detail_omitted` | str | n | **Additive.** Written by the emit seam INSTEAD of `detail` when the payload would exceed the cap: it carries the omitted field's byte count, the cap, and where the full text is (the stage's own log). The cap is never raised, and the rest of the payload — including the verdict — survives. A payload oversized for any other reason is still refused whole |
```

**1c.** Replace the clause at `:2827`. It currently reads:

> the verdict's prose is copied into a `check.passed`/`check.failed` payload, and §2.9's
> 4096-byte payload cap REFUSES an oversize one whole rather than truncating it.

with:

> the verdict's prose is copied into a `check.passed`/`check.failed` payload, and §2.9's
> 4096-byte payload cap will not carry an oversize one: the prose is replaced by
> `detail_omitted`, which names its byte count and points at the review log that already holds
> it, while the verdict itself is kept. It used to REFUSE the event whole, which threw out of
> `EventLog.append` and took the invocation's unsaved task rows with it.

**1d.** Wherever §5's Build pre-flight describes `04-build/preflight.yml`, add the two new
row fields and the freshness rule (find the section with
`grep -n "preflight" docs/spec.md`):

```markdown
Each row additionally carries `command_hash` — the command together with the workspace's whole
declared command list — and its own `checked_at`. A cached **green** is reused exactly as before
(the base-sha rule). A cached **red** is re-probed when the hash differs, when the row is older
than 30 minutes, or always under `--prepare`: a `--prepare` that returns a refusal in 0 seconds
over a base nobody measured today is not evidence, and the `workspace.yml` fix the refusal asks
for has to be something the cache can see. Both fields are additive and an absent one
invalidates nothing.
```

- [ ] **Step 2: `docs/ROADMAP.md` — the tracked decomposition item**

AGENTS.md §12 names `build.ts`'s decomposition as a planned roadmap item and the roadmap does
not. Add to `## Next — open, nothing written yet`:

```markdown
- **Decompose `src/core/facilitator/executors/build.ts`.** ~4k lines by design debt, and
  `AGENTS.md` §12 already tells every agent not to restructure it inside another change — which
  only holds as long as there is a change that WILL. The seams are visible from the outside: the
  story pipeline, the reviewer handshake, the fix-list round, the pre-flight cache and the
  worktree/branch mechanics are five subjects sharing one class. Two things it must carry with
  it, both filed from wave 1a: `ExecutorOutcome.tasks` exists only at return, so a throw
  mid-executor loses every row the run had earned; and the reviewer path narrows its turn into a
  local struct before `this.tasks.push`, so the provider's token split reaches the developer
  row and not the reviewer's.
```

- [ ] **Step 3: `docs/guide/08-cli-reference.md` — the `facts` section**

Insert between `## \`tldrx note\`` (`:580`) and `## \`tldrx story\`` (`:600`), matching that
page's voice — a sentence of what it is for, the usage block copied from `--help`, then what it
does that a reader cannot infer:

```markdown
## `tldrx facts`

Record one durable, provenanced fact — the thing later prompts actually read back.

```
tldrx facts add "<text>" --area <id> [--kind answer|observed|derived]
                [--confidence measured|inferred|stated] [--decided-by owner|driver]
                [--repo <name>] [--run <id>] [--root <path>]
```

`--area` is required: it is how every reader of `facts.yml` scopes a match. A fact is one
assertion, capped at 2000 characters — over the cap it is cut, ends in `…`, carries
`truncated: true`, and the command says so on stdout, because a marker only a later reader sees
is one the author never acts on.

It writes through `FactsStore`, under the workspace lock: load, mint the id, cap, validate,
save. Editing `.tldrx/memory/facts.yml` by hand walks past all four, and a fact cut mid-word
with no marker is a record that does not know it is incomplete.

`--decided-by` is attribution, as against who typed it. It is optional and absent means "not
stated", never "owner" — a fact gets cited later, and a driver's default is never cited as the
owner's decision. Without `--run`, one open run is used and several are refused rather than
guessed between; with no open run the fact is recorded with no run and the command says so.
Exits: `0` `1`.
```

Verify the usage block against the real output before committing:

```bash
bun run src/cli/main.ts facts --help
echo "help_exit=$?"
```

(read `package.json` for the actual entry point rather than assuming `src/cli/main.ts`).

- [ ] **Step 4: the docs-site, EN and ES in lockstep**

`docs-site/reference/cli.md`, in the "Knowledge, output and the rest" table, immediately after
the `tldrx note` row at `:89`:

```markdown
| `tldrx facts add "…" --area <id>` | Record one durable, provenanced fact — what later prompts read back. Capped at 2000 characters, cut and marked `truncated:` past it. `--decided-by owner\|driver` records who decided, as against who typed it. |
```

`docs-site/es/reference/cli.md`, the same position in "Conocimiento, salida y lo demás"
(`:89`). A real translation, not a gloss; sample CLI strings stay in English by owner decision
(AGENTS.md §5):

```markdown
| `tldrx facts add "…" --area <id>` | Registra un hecho durable y con procedencia — lo que los prompts posteriores sí vuelven a leer. Tope de 2000 caracteres: pasado eso se corta y queda marcado con `truncated:`. `--decided-by owner\|driver` registra quién decidió, que no es lo mismo que quién lo escribió. |
```

- [ ] **Step 5: Verify the docs gates**

```bash
bun run docs:build
echo "docsbuild=$?"
bun test test/cli.test.ts test/public-surface-consistency.test.ts
echo "docstests=$?"
```

Expected: `docsbuild=0`, `docstests=0`. Watch for:
- `ignoreDeadLinks: false` — a link to a page that does not exist fails the build.
- `test/public-surface-consistency.test.ts:116-137` — never type the current version into
  prose, and never write "lightweight" or a bare "tool-agnostic".
- `test/cli.test.ts:383` — the exit table in the CLI reference is the one `exitCodes.ts`
  defines; do not restate a code the entry does not declare.
- `git status --porcelain` must be clean after `docs:build` — it leaves the tree clean by
  design; if it does not, that is a finding.

- [ ] **Step 6: Commit**

```bash
git add docs/ docs-site/
git commit -m "$(cat <<'EOF'
docs: the new fields, the new command, and the sentence that stopped being true

spec.md gains the run.yml token split, the `detail_omitted` payload key and the
preflight freshness rule — and loses the §2.17 clause promising that an oversize
verdict is refused whole, which is exactly the behaviour wave 1a replaced. The CLI
reference documents `tldrx facts add` from its own `--help`; the docs-site carries it
in both locales. ROADMAP finally tracks the build.ts decomposition AGENTS.md §12
already tells every agent to defer to.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 9: CHANGELOG — `## 0.9.1 — unreleased`

**Why:** AGENTS.md §5 — post-release work goes under a NEW `## <next-version> — unreleased`
heading, released (dated) sections are immutable, and the bullet says the WHY. `CHANGELOG.md`
currently opens with `## 0.9.0 — 2026-09-06`, which is dated and must not be touched.

**Files:**
- Modify: `CHANGELOG.md` (insert above `## 0.9.0 — 2026-09-06`)

**Interfaces:**
- Consumes: everything Tasks 1-8 shipped.
- Produces: one `## 0.9.1 — unreleased` section, one `### Fixed` group and one `### Added`
  group — never two of either (AGENTS.md §2: a duplicate `### Fixed` group has shipped before).

- [ ] **Step 1: Write the section**

Read the last two released sections first for the voice — long bullets, the mechanism, the
measured consequence, and no private workspace names. Insert immediately after `# Changelog`:

```markdown
## 0.9.1 — unreleased

### Fixed

- **A turn with no provider USD figure is unmetered, not a metered `$0.00`.** `interpret`
  wrote `cost_usd: 0, metered: true` for a Claude result document that carried no
  `total_cost_usd` — contradicting the `metered` field's own contract three lines above it, and
  letting a stage, and then a whole run, read `$0.00` after real turns had run. `metered` is now
  derived from the presence of the figure, so those turns reach `cost_usd: null` +
  `metered: false` and every report that already knows how to say "LOWER BOUND, not a total"
  says it. No new `spendBasis` word: `absent` already meant this, and the fix is to make more
  turns reach it honestly. Codex keeps its pin — its synthesized result document carries a
  `total_cost_usd: 0` that is a placeholder, and reading it as a measurement would be the same
  lie under a different provider.
- **A refusal no longer discards a cost.** `tldrx next --commit` returned `EXIT_AGENT_FAILED`
  on a `questions.md` the §2.7 parser cannot read BEFORE it recorded the task — so a turn that
  had already been paid for left no row anywhere, and the run's own ledger was short by exactly
  the amount nobody could see. The row lands first and the refusal exits after it. Because that
  refusal deliberately leaves the stage `running` so the operator can fix the file and re-run,
  the row is fingerprinted by session, declared cost and outputs, and the same turn is never
  banked twice.
- **An oversized reviewer verdict no longer takes the whole invocation's ledger with it.** The
  4096-byte payload cap was enforced by `EventLog.append` throwing, nothing wrapped the executor
  call, and the reviewer's verdict prose is the field that overflows — so one wordy review
  escaped past `recordExecutorTasks` and `store.save()`, leaving the epic merge on disk and
  every task's cost gone from `run.yml`. The cap is honoured, never raised: at the emit seam the
  oversized `detail` becomes `detail_omitted`, carrying its own byte count and pointing at the
  review log that already holds the prose, while the verdict itself survives. The executor call
  is wrapped so a throw fails the stage by name, saves, and says plainly which rows it could not
  recover rather than implying the ledger is whole.
- **A cached red base is no longer trusted forever.** `04-build/preflight.yml` was invalidated
  only by a base-sha comparison that no-ops when either sha is empty, and `checked_at` was
  written and never read — so a red measured once came back from every later `--prepare` in 0
  seconds, over a base a live probe would show green, and the `.tldrx/workspace.yml` fix that
  the refusal itself asks the operator to make was the one thing the cache could not see. A red
  is now re-probed when the command hash differs, when the row is older than 30 minutes, or
  always under `--prepare`. The hash covers the command together with the workspace's whole
  declared command list, because the command string was already the join key and hashing it
  alone would have changed nothing. A cached green keeps the rule it had; both new row fields
  are additive and an absent one invalidates nothing.
- **A fix list records the canonical 40-hex sha.** `Resolved: yes <sha>` accepted 7-40 hex, so
  a sha that had lost a character read as a deliberate abbreviation: git resolved it, the claim
  verified, and the audit record kept a form no later reader can tell from a prefix of a
  different commit. The grammar is unchanged — demanding 40 would refuse the abbreviation a
  person legitimately types — and the full object id is written back after the verification,
  which is strictly stronger and refuses nobody.

### Added

- **`tldrx facts add` — the command the drive mandate has been naming since 0.8.0.** The
  mandate tells the driver "a fact that must outlive the turn is `tldrx facts add`, which every
  later prompt DOES read", and no such command was dispatched. What drivers did instead was edit
  `.tldrx/memory/facts.yml` by hand, which walks past `FactsStore.append`'s 2000-character cap,
  past its `…` marker and its `truncated: true` flag, and past `save()`'s validation — and a
  fact cut mid-word with no marker is a record that does not know it is incomplete. It writes
  through the store, under the workspace lock, and records attribution: `--decided-by
  owner|driver` is additive and absent means "not stated", never "owner", because a driver's
  default is never cited as the owner's decision. Without `--run` it uses the one open run and
  refuses to guess between several, recording the absence with its reason.
- **The provider's token split on the `run.yml` task row.** `input_tokens` and `output_tokens`
  were parsed on every provider turn and reached the event log only, so `run.yml` — the file
  every cost report and every resumed run reads — carried a dollar figure with no token figure
  beside it, which is a number nobody can check against a price table. Both fields are additive,
  written only when a turn reported them, and distinct from `tokens`, which keeps its meaning as
  a host declaration. `version: 1` is unchanged and every older row loads.
```

- [ ] **Step 2: Verify**

```bash
bun test test/public-surface-consistency.test.ts
echo "surface=$?"
grep -c "^### Fixed" CHANGELOG.md
grep -c "^## 0.9.1" CHANGELOG.md
```

Expected: `surface=0`; exactly one `## 0.9.1` heading; and inside the 0.9.1 section exactly one
`### Fixed` and one `### Added` (check by eye — the `grep -c` counts the whole file). The
0.9.0 section and everything below it must be byte-identical:

```bash
git diff --stat CHANGELOG.md
git diff CHANGELOG.md | grep -c "^-"
echo "removed_lines=$?"
```

Expected: no removed lines other than the blank line the insert re-flows, if any.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): 0.9.1 — records and money that do not lie

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016cUJTuqLgHQcyZHhkwnuwv
EOF
)"
```

---

### Task 10: the full gate run, with exit codes captured on their own lines

**Why:** AGENTS.md §1 and §3 — `cmd | tail` eats the exit code and `cmd; git log; echo $?`
reports `git log`'s. The only green is the project's real gate, read directly. This task
produces the evidence block the change is reported with, and it is the last thing done: no
release steps are in this plan (see `docs/RELEASING.md` and AGENTS.md §6 for those).

**Files:** none modified. If a gate goes red, the fix belongs in the task that caused it — go
back to that task, fix it there, and re-run this one.

**Interfaces:**
- Consumes: every task above.
- Produces: the measured evidence block, and a clean tree.

- [ ] **Step 1: Run all five gates, each exit code on its own line**

```bash
bun run typecheck
echo "typecheck=$?"
```

```bash
bun test
echo "test=$?"
```

```bash
bun run build
echo "build=$?"
```

```bash
bun run docs:build
echo "docsbuild=$?"
```

```bash
grep -rn "Bun\." src --include=*.ts | grep -v "src/core/runtime/"
echo "seam_grep_exit=$?"
```

Expected: `typecheck=0`, `test=0`, `build=0`, `docsbuild=0`, and `seam_grep_exit=1` (grep exits
1 when it finds nothing, which is the clean state). Each `echo` is its OWN command line — never
`bun test | tail`, never `bun test; git status; echo $?`.

- [ ] **Step 2: Record the measured test delta**

```bash
bun test 2>&1 | tail -5
```

Read the pass/fail/total line. The starting figure is `measured` on
`fix/wave1a-records-money` at `ac35642` (one commit past `fa00f15`, docs only) on 2026-09-06:
**3627 pass, 0 fail, 137 files, 778.60 s** — but that box was running a second suite
concurrently, so treat the number as the baseline and the wall clock as meaningless. Re-measure
it yourself rather than citing this line: run `bun test` in a second, clean worktree of
`origin/main`, because the branch may have moved since.

```bash
git fetch origin
git worktree add ../wt-baseline origin/main
```

then run `bun test` there and diff the totals. Your `+N` will be **one higher** than the tests
you wrote for every NEW test file that spawns processes, because `test/machine-load.test.ts`
auto-adds one `test.each(spawners)` guard row per such file (AGENTS.md §8). Reconcile the
number exactly; do not hand-wave it. Remove the baseline worktree when done.

- [ ] **Step 3: Confirm the tree is clean**

```bash
git status --porcelain
echo "porcelain_lines=$(git status --porcelain | wc -l | tr -d ' ')"
```

Expected: no output, `porcelain_lines=0`. `docs:build` leaves the tree clean by design; a
generated file appearing here is a finding, not something to `git add`.

- [ ] **Step 4: Write the report**

Assemble, for the issue close / PR body (AGENTS.md §11):

1. The five gate lines above, verbatim, with their exit codes.
2. The measured test delta, both ends attributed, with the machine-load reconciliation shown.
3. Every RED proof kept from Tasks 1-7, verbatim, including the mutation runs that proved each
   new test bites in both directions.
4. **The re-pin list from Task 1, Step 5** — each moved assertion by `file:line`, labelled
   *behaviour change*, with one sentence saying what it used to pin and what it pins now. The
   assertions that stayed green are labelled *guard*, not *proof*.
5. The design paragraphs where a judgement call was made: the `alreadyBanked` fingerprint
   (Task 2), what `capPayload` deliberately does NOT trim and what the executor `catch` cannot
   recover (Task 4), and why `command_hash` covers the allowlist rather than the command string
   (Task 6).
6. The follow-up issues filed, with their evidence and `file:line`: the reviewer path's missing
   token split (`build.ts:2144-2146`, `:2392-2400`, `:2402-2411`), and
   `ExecutorOutcome.tasks` existing only at return (`executors/index.ts:189`,
   `runNext.ts:1087`).

Nothing in this task commits. There is no release step in this plan.

---

## Self-review

**Spec coverage.** §1's seven mechanisms map to Tasks 1 (invented `$0.00`), 2 (refusal
discards a cost), 4 (the cap throws), 3 (token split never persisted), 5 (`facts add` does not
exist), 6 (cached red trusted forever), 7 (truncated sha accepted). §2's decisions: no new
`spendBasis` word (Task 1 — `spendBasis.ts` is untouched and named as untouched); `metered`
derived from presence (1); cost before refusal (2); additive token fields (3); cap at the emit
seam with `try`/`finally` (4); `facts add` matching the mandate (5); preflight honesty (6);
canonical sha (7); the deferred wave-2 items are filed, not fixed (10, step 4.6). §3's
non-goals are respected: the cap is not raised, no fifth `spendBasis` word, `build.ts` takes
three argument-passing edits and no restructure, `tokens` keeps its meaning, and the only
docs-site pages touched are the two the change requires. §4's test list is covered case by
case. §5's docs list is Task 8 plus Task 9.

**Two places the spec's letter does not survive contact with the code**, both flagged for the
owner rather than decided here:

1. **§2, the `try/finally`:** `recordExecutorTasks` cannot run on a throw, because
   `ExecutorOutcome.tasks` only exists at RETURN (`executors/index.ts:189`) and
   `BuildSession.tasks` is private (`build.ts:859` and its siblings). Task 4 therefore fixes the
   cause (the throw), and its `catch` records an `error` event, saves, and states in the message
   that the rows could not be recovered — rather than implying a ledger it did not restore.
   Making the rows survive a mid-executor throw needs `BuildSession` to expose its accumulated
   tasks, which is a `build.ts` change the spec forbids; filed as a follow-up.
2. **§2, `checked_at` as the red TTL clock:** the file-level `checked_at` is only ever the
   newest write (`preflight.ts:207`), so re-probing the first stale red would stamp the file
   `now` and make every other stale red in it look fresh. Task 6 adds a per-row `checked_at`
   alongside `command_hash` — additive, tolerant, `version: 1` unchanged — and falls back to the
   file-level stamp when a row has none.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N".
Three places deliberately instruct the implementer to READ before writing rather than quoting a
name this plan cannot verify — `renderMandate`'s exported name and the shared workspace/capture
fixtures (Task 5, Step 1), the file that pins `markUnverified` (Task 7), and the package entry
point for `facts --help` (Task 8, Step 3). Each says what to read and why, which is the rule
this repo already holds itself to: never quote a name from memory.

**One thing in this plan is measured rather than reasoned**, and it is the one the spec asked
for by name. Task 1's change was applied alone to a clean worktree at `ac35642` and the full
suite run: `3627 pass, 0 fail, 137 files`, exit 0. So the spec's "each such re-pin is listed in
the report as a behaviour change" resolves to an EMPTY list — and the reason is itself a
finding: nothing in the suite covered a Claude turn without `total_cost_usd`, which is how the
invented `$0.00` survived. Everything else in this plan is `inferred` from reading the code at
the file:line cited, and every task re-verifies before it edits.

**Type consistency.** `capPayload(payload, pointer)` is defined in Task 4 and used only there.
`commandHash(command, workspaceCommands)`, `BaseFreshness` and `PREFLIGHT_RED_TTL_MS` are
defined in Task 6 and used only there. `canonicalSha(cwd, sha)` and
`canonicalizeResolvedSha(text, n, sha)` are defined in Task 7 and used only there.
`RunTask.input_tokens` / `.output_tokens` (snake_case, the file format) and
`ExecutorTask.inputTokens` / `.outputTokens` (camelCase, the in-memory shape) are the same two
values in the two casings this codebase already uses on either side of that boundary — Task 3
defines both and shows the copy between them. `FactSource.decided_by` and `FACT_DECIDERS` are
defined in Task 5 and consumed by Task 5's help entry and Task 8's docs.
