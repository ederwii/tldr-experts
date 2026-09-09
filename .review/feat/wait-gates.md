verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 8b2997b

Findings summary (no Important/Critical):

- Correctness of the wait (CONFIRMED, runAuto.ts:432-434): `waitForGate` re-opens
  `RunStore.open(runDir)` fresh on every poll (`gateOf`, runAuto.ts:~600), so an approve/reject
  written by `tldrx approve`/`reject` in another process is seen within one `pollInterval` —
  no in-memory caching, same pattern as the pre-existing `waitForAnswers`/`stillBlocking`.
  Approve → `continue` re-enters the main `for` loop → fresh `RunStore.open` → `runNext` again,
  which is what actually advances the cursor (confirmed by the `stage.started` event for
  `beta` asserted in the "resumes it rather than exiting 4" test). Reject → stops with
  `outcome.code` unchanged (exit 4, same family as today) and the note is `say()`'d AFTER
  `stopLines`, so it is `lines[lines.length-1]` and lands in `run.failed`'s summary
  (`finish()` uses `lines[lines.length-1]`) — verified by the "rejection stops the loop"
  test asserting the note text inside the `run.failed` summary.
  Both-flags case: the branch is `if (card !== null && waitAnswersMs) {...} else if (waitGatesMs) {...}`.
  Traced this for the case a question is open, `--wait-gates` alone is set, and EXIT_AWAITING_HUMAN
  fires for that question (not a gate): `pendingGate(runDir)` re-derives from `waitingFor`
  (kind must literally be `"gate"`), so it returns null and the gate branch is a no-op — no
  deadlock, because only one of the two conditions can be true of the run's actual cursor
  status at a time, verified independently by the second reader rather than assumed from
  which flags were passed.
- Lapse handling (CONFIRMED via tests): `gate.timeout` sent exactly once, exit 4, zero task
  rows added (`taskRows` before/after equal) — asserted directly. Heartbeat keeps firing during
  the wait (`waitForGate`'s loop `await`s a `setTimeout`, yielding the event loop so the
  parallel `setInterval` heartbeat still ticks) — the dedicated heartbeat test confirms
  `waiting_on_gate` appears in `status` payloads sent while `--wait-gates` is polling, and
  stops after `finish()` clears the interval (unchanged code path from a prior wave).
- Notifier `closed`/finally-drain (674049a) is untouched by this diff — the heartbeat
  registration and `finish()`'s clear+drain are the same code, just now also computing
  `pendingGate(runDir)`, a pure read.
- Heartbeat/payload: `waiting_on` for questions is unchanged (still question ids only,
  confirmed by the "WITHOUT the flag" test's exact-keys check `["status_text","waiting_on"]`
  on an unparked run). `waiting_on_gate`/`gate_policy` are additive siblings, absent when
  nothing is pending — confirmed. NOTIFY_KINDS (payload.ts), spec.md's kind table, and both
  EN/ES `unattended-operation.md` "nine kinds" tables all list `gate.timeout` consistently.
- One implementation: `pendingGate` built on `waitingFor` (no second predicate); `pollInterval`
  shared by both waits; `gatePhrase` is the single function used by `gateNotification`,
  `gateTimeoutNotification` and `statusNotification`; `approveCommand`/`rejectCommand` collapse
  the four literals in `decisionCards.ts` (`budgetCard`, `boundaryCard`, `gateCard`) plus the
  old inline pair in `notifications.ts`'s `gateNotification` into one pair of functions — grep
  confirms remaining bare `tldrx approve --run`/`tldrx reject --run` literals exist only in
  files outside this PR's stated scope (`runItems.ts`, `runNext.ts`, `openRuns.ts`,
  `waiting.ts`) — pre-existing, not part of the four this PR collapsed, not a regression.
- Docs: helpText and spec.md both say "waits for a signature and never produces one"; spec
  §2.18 table and prose documented the absent-when-nothing rule; EN/ES lockstep confirmed
  line-by-line across `driving.md`, `unattended-operation.md`, and `cli.md`. CHANGELOG bullets
  read true against the diff and sit under one `### Added` heading in `## 0.13.2 — unreleased`.

Minor (non-blocking): `WaitingGate.policy` is typed `GatePolicy | null` but
`pendingGate()`/`gatePolicyFor` never actually produce `null` in practice (`gatePolicyFor`
defaults absence to `"human"`) — harmless, just a wider type than the real domain.

Gates run: `bun run typecheck` (exit 0); `bun test test/notify-hook.test.ts
test/run-provenance-duration.test.ts` (46 pass, 0 fail); additionally
`test/decision-cards.test.ts test/story-widen.test.ts` (56 pass, 0 fail, covers the
`decisionCards.ts` refactor) and `test/gates.test.ts test/attended.test.ts` (92 pass, 0 fail,
both import `runAuto`) — all exit 0, all read on their own line.
