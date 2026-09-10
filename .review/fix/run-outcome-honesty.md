verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 66a7915

## Re-verification after rebase (66a7915, was 67697a3 on base 5215a37)

Branch rebased onto c33bc82 (release 0.14.3), landing on top of 404e8f4 (#164, foreign-work
aside). `git diff 5215a37..67697a3` vs `git diff c33bc82..66a7915` (both excluding CHANGELOG.md)
diffed against each other: the only non-identical hunks are line-number shifts from #164's
content landing earlier in shared files, plus exactly the two named unions —

1. `src/core/facilitator/runAuto.ts`: `finish()`'s `runEndNotification(...)` call gains a new
   `heldForeignWork()` argument (line 284) ahead of the outcome-line argument.
2. `src/core/notify/notifications.ts`: `runEndNotification` gains `note` (#164) as its 6th
   parameter, `outcome` (#210) shifted to 7th; `summary` is now
   `... spent by this loop.${delivered} ${lastLine}${note ? ' '+note : ''}`.
   `test/run-outcome.test.ts` was correspondingly updated to pass `null` for `note`.

Confirmed #164 not lost: `heldForeignWork()` (runAuto.ts:306) still feeds both `run.finished`
and `run.failed` via the single `finish()` call site used for every exit code (runAuto.ts:284).
`test/build-foreign-work.test.ts:430-438` (untouched by the rebase) still passes — it calls
`runEndNotification(ctx, 0, 0.1, "done", undefined, note)` positionally and asserts the summary
contains "foreign work NOT restored in app", and that omitting `note` leaves the summary
without "foreign work". Rendered both `note` and `outcome` together (ad hoc script) and got a
coherent sentence:

> `260909-x: the loop finished with exit 0 (ok), $1.78 spent by this loop. The run: nothing`
> `delivered: 0 of 3 stories; S1 — npm run test exited 127. run 260909-x is done foreign work`
> `NOT restored in app — stash cccccccccccc still holds notes.md — run` `` `git -C /w/app stash pop stash@{0}` ``

Ran `bun run typecheck` (exit 0) and
`bun test test/run-outcome.test.ts test/notify-hook.test.ts test/build-foreign-work.test.ts test/build-golden.test.ts`
→ 61 pass, 0 fail, exit 0. No new findings from the rebase; the Minor note below still stands.

## What was checked (original review, against 67697a3)

**Honesty of `outcome: delivered`.** Traced `deriveRunOutcome` (src/core/run/runOutcome.ts:227)
back to `buildProgress`'s story statuses. Confirmed at the code that sets a story `done`
(src/core/facilitator/executors/build.ts `reviewAndSettle`, lines 1213-1301): the merge into
the epic branch happens FIRST (`mergeIntoEpic`, line 1189); a failed merge calls `block()` and
the story settles `blocked`/never `done` (lines 1190-1196). `done` is reachable only after
`merge.ok === true`, DoD green, and reviewer `approve`. Every other route to `settle()`
(developer failure, reviewer error/fixlist/changes, open fix-now) explicitly passes a
non-`done` status. So `outcome: delivered` (all stories `done`) cannot be written while nothing
landed on the epic branch — CONFIRMED not a lie in the dangerous direction, and this invariant
predates the diff; the diff only reads it correctly.

**`partial` semantics.** `deriveRunOutcome`: `done === 0` → `nothing-delivered`; `done ===
total` → `delivered`; else → `partial`. A run with some `done` and the rest `todo`/`blocked`/
`review` correctly lands on `partial`, not `delivered`. CONFIRMED by reading the function body.

**`ship` exit family.** New refusal at src/core/run/ship.ts:206 uses `EXIT_USAGE` (family 1),
distinct from the sibling "no epic branch" refusal above it which still uses `EXIT_GATE_REFUSED`
(family 2, via the `refuse()` helper, ship.ts:1087-1089) — matches AGENTS.md §7's families and
the issue's own reading (comment explains why, in file). `--dry-run` parity is asserted by
`test/run-outcome.test.ts:240-256` and passed. Ordering matches the claim: the new block sits
AFTER the no-handoff check and BEFORE the pre-existing refusal logic that follows.

**Additive/tolerant records.** `RunFile.ts`'s `outcome?: RunOutcome` is optional with a tolerant
validator (kind-only required, counts/why checked only when present); `emitRunYaml.ts` emits it
only when set; `RunDocument.ts`'s reader keeps an unrecognized `kind` verbatim rather than
coercing it. `DASHBOARD_MODEL_VERSION` is untouched (grepped the diff — only comments mention
it, the constant itself doesn't change). Three (and only three) run-close sites write it
(`runNext.ts:1991`, `gates.ts:174`, `run.ts:474`), gated on `store.run.status === "done"` (gates/
runNext) or the cancel path; a `failed` run status is NOT one of the three, which is correct
because `isFinished()` (RunFile.ts:558) explicitly excludes `failed` — a failed stage leaves the
run open/retryable in this codebase's own model, not closed.

**Golden bytes.** All four diffs are exactly the claimed one-line changes: `gate.requested`
gains `stories` on three golden files, and `refused-events.txt` additionally gains
`blocked_story`/`blocked_reason` — no other line moved.

**Blocked-reason citation stripping.** `findingReason` (handoff.ts:383) strips only the bullet's
own TRAILING `[src: …]` token via `withoutSrcToken`, which parses from the end of the line. A
reason whose entire substance is a bare citation is structurally implausible given the
producers of `reason` text (merge-failure detail, reviewer summary, DoD refusal sentence) — all
prose. Not explicitly unit-tested as an edge case, but not a plausible real scenario either;
noting as Minor, not blocking.

**Everything else claimed** — autoGate.ts's `storiesCondition` reduced to a thin caller of the
shared leaf (byte-identical wording), the #203 deferred-notify closure capturing `stories`
before deferral (consistent), `decisionCards.ts`'s backward-compatible optional-param wrapper,
`shipBody.ts`'s Outcome header placed above `## What shipped`, `runStatus.ts`/`runItems.ts`
appending `outcome` (never inserting, preserving `--json` positional consumers), docs/spec.md
§2.2/§2.9/§2.18 and both guide pages updated with matching prose, EN/ES guides in lockstep
substance, helpText.ts's ship notes accurate against the actual refusal (exit code list
unchanged — `EXIT_USAGE` was already documented for `ship`), and the `settleFirstStory` test
fixture's `evidence: ["04-build/handoff.md:1"]` citing a path the same setup function creates
moments later (real, not fabricated) — all read and CONFIRMED matching the stated diff.

## Commands run

- `bun run typecheck` → exit 0
- `bun test test/run-outcome.test.ts test/ship.test.ts test/ship-multi-repo.test.ts test/build-golden.test.ts test/auto-gate-questions.test.ts test/notify-hook.test.ts test/map-citations.test.ts` → 131 pass, 0 fail, exit 0

## Findings

None Critical or Important.

- Minor (PLAUSIBLE, not blocking): `findingReason`'s citation-stripping is untested for a
  reason that is bare citation text with no prose; structurally near-impossible given real
  producers of the reason string, but a targeted unit test in `test/map-citations.test.ts` or
  `handoff.test.ts` would close the gap for a future refactor of the finding-line grammar.
