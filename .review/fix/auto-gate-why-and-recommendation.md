verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 967f925

## Findings

No Critical or Important issues found. `bun run typecheck` exit 0; targeted tests
(`test/auto-gate-questions.test.ts`, `test/notify-hook.test.ts`, `test/decision-cards.test.ts`,
`test/questions-cards.test.ts`, `test/questions-grammar.test.ts`, `test/close-open-questions.test.ts`,
`test/gate-conditions.test.ts`, `test/gates.test.ts`, `test/gate-authority.test.ts`,
`test/agent-gate.test.ts`) all exit 0 (57+81+151 pass, 0 fail across the runs). `notify-hook.test.ts`
alone: 27 pass, confirming the fixture extraction is byte-behavior-identical. `bash
scripts/release-check.sh --ci` exits 0. CHANGELOG has exactly one `### Fixed` and one `### Added`
heading under `## 0.14.1 — unreleased` (verified by heading scan, no duplicates). `mandate.ts`,
`build-golden.test.ts`, `drive.test.ts` are byte-untouched (confirmed via `git diff --stat`).

**Self-close safety (CONFIRMED safe).** `selfCloseAutoGate` (runAuto.ts:672) and the stage-end
auto-close in `runNext.ts` both call the same `evaluateAutoGate`/`approve` functions — one
implementation, reused. `checksCondition` (autoGate.ts:158) only fails on `status === "failed"`;
`skipped` (write-time hooks, checks.ts:61) is treated as holding identically in both call sites,
since both route through the same function — not a new asymmetry. Guarded to `auto` only:
`selfCloseAutoGate` returns `false` immediately for any other policy (runAuto.ts:660), and
`test/auto-gate-questions.test.ts` describe block (d) asserts a `human` gate whose conditions all
hold is never signed by the loop. A person's `approve`/`reject` lands first structurally —
`waitForGate`'s poll checks `gate.status` for `approved`/`rejected` before calling
`selfCloseAutoGate` (runAuto.ts:636-644) — and a mid-poll new question reopens the `questions`
condition on the very next re-evaluation (each poll re-reads `questions.md` off disk), so a race
window closes itself within one poll tick, never past it since `approve` itself re-runs the
checks (fail-closed).

**Deferral correctness (CONFIRMED, matches explicit tests — initially looked like a regression,
was not).** With no `--wait-answers`/`--wait-gates` at all, or with `--wait-answers` alone timing
out, the deferred gate notification is dropped for good — verified this is INTENTIONAL and
tested: `test/auto-gate-questions.test.ts` describe (a) `"the questions reach the phone FIRST,
and no gate notification goes out at all"` explicitly asserts `kinds).not.toContain
("gate.requested")` with no wait flags, while `gateRequested(ws)` (the event) is still defined.
The rationale (a gate held only by questions is downstream of them, not a second ask) is
documented in three places (runAuto.ts comment, docs-site guide, docs/spec.md §2.18) and is
consistent everywhere. `gate.requested` is *always* appended regardless of notify defer/flush —
confirmed structurally (`store.append` in runNext.ts precedes any notify logic, which lives
entirely in a separate module). Under `--wait-gates` only (no `--wait-answers`), the
`questionNotification` still fires unconditionally before the wait-flag branching
(runAuto.ts:439-441), so the owner is never left waiting 4h in silence.

**`held_by`/`why` payload:** additive, present only for `policy === "auto"` (runNext.ts:1808),
confirmed via the spread-conditional; a `human`/`agent` gate carries neither key.

**Recommendation regex/precedence:** `RECOMMENDED_RE` matches the `OPTION_RE` A–E restriction
(consistent scope limit, not a new gap). A bad `[src:]` in a `Recommended:` line is NOT silently
ignored — `checkClaimSources` (checks.ts:99) scans the raw bytes of any declared `.md` output
generically via `validateCitations`, which already covers the pre-existing `Why asked: … [src:]`
token the same way; a `Recommended:` line's citation is caught by the same existing mechanism,
not a new code path. Precedence (evidence note wins) is implemented exactly as documented
(decisionCards.ts:254-262).

**Machine-load guard:** the new test file is not caught by `machine-load.test.ts`'s marker list
(`makeFacilitatorWorkspace` isn't one of the six string markers), but this is a pre-existing gap
— `test/notify-hook.test.ts` (unchanged by this PR) uses the identical fixture and pattern and
was never covered either. The new file voluntarily follows the same convention
(`setDefaultTimeout(spawnTestTimeout(60_000))` + the `machineLoad.ts` import), so it is compliant
today; the guard's marker-list blind spot for this fixture shape predates this change and is not
this PR's to fix.

**Minor, not blocking:** a gate that self-closes mid-`--wait-gates`-poll produces no
notifier-facing completion message (only a console `say()` line) — the owner learns about it only
via the next stage's own events or a status check. This is pre-existing behavior for a *manual*
`tldrx approve` landing mid-poll too (same code path, same silence before this PR), not something
introduced here.

**Docs:** EN/ES guide sections are 1:1 in heading count and order; spec.md §2.7/§2.17/§2.18/§5
additions are consistent with the code and with each other; `stages/{what,how,plan}/stage.md` and
`templates/questions.md` add the same `Recommended:` guidance verbatim across all three stage
files.
