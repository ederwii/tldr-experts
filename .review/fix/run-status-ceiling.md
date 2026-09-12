verdict: fixes required
reviewed-by: Claude Sonnet 5 (fresh pre-merge reviewer)
against: 9ec01ee

## Blocking

**#4 (replay), CONFIRMED, no corruption or concurrency needed — reproduces the exact
symptom class of #236 on a mainline path.** `tldrx replay`'s headline
(`renderReplay.ts:36`) prints `run.spent_usd` (run.yml's mirror — LIVE, re-derived
every `save()` per `RunFile.ts`'s own docstring) next to `run.ceiling_usd` (the same
mirror's ceiling — frozen at creation, since this diff). These are two different
freshnesses from the same file, and any run that gets `budget raise`d and then spends
past its original ceiling shows a contradictory headline.

Measured live via the real CLI, no test-only shortcuts: `run new --budget 10`,
`budget raise 01-what 5.00`, record one task costing `orig+2`, then `tldrx replay
<id>` prints:
```
Status: **pending** · $12.00 spent of $10.00 ceiling
```
This is the same "sentence that cannot be true" #236 was filed over, just spent-vs-
ceiling instead of left-vs-ceiling, and in a shipped user-facing command. Before this
diff, `budget raise` wrote the mirror's ceiling too, so in the common case (no
concurrent stale save) replay's ceiling tracked reality; after this diff removes that
write with no compensating change to `replay`, replay's ceiling is wrong on EVERY
raised run, unconditionally — a regression, not a pre-existing gap.

The CHANGELOG's justification ("`tldrx replay` narrates the document a run.yml IS")
does not hold: replay does not narrate a frozen document — it narrates one frozen
field (`ceiling_usd`) beside one live field (`spent_usd`) from the same file. Fix:
give `replay` the same budget.yml-with-mirror-fallback the dashboard already has
(`dashboard/model.ts:1241`'s `loaded.budget?.ceiling_usd ?? doc.ceiling_usd` pattern),
rather than leaving `RunDocument.ceiling_usd` untouched.

## Everything else checked and holds

1. **Rule question (§7):** DEFENSIBLE, not a v1 meaning change. Measured:
   `RunStore.ceilingsToWrite()` (`RunStore.ts:291`) already re-reads budget.yml's
   ceiling from disk on every save and money-decision code
   (`wouldExceed.ts`, `raiseBudget.ts`, `runNext.ts`, `budgetView.ts`) already takes
   `RunBudget` (budget.yml), never the run.yml mirror — the mirror was never an
   authority for a refusal or a brake. `rollUp` (`RunStore.ts:386`) has only ever
   touched `spent_usd`, never `ceiling_usd`; the mirror's ceiling value was written
   once, at creation, by `newRun.ts`, and only the (now-removed) `budget.ts:152`
   write ever touched it again — and that write was provably defeated by ordinary
   concurrency (confirmed: `RunStore.save()`'s `ceilingsToWrite` carries a stale
   loaded copy right back out on a hosted run's next save). Documenting it as "the
   creation figure" describes what it already was; the key stays, required, always
   written — no §1 format-shape violation.
2. **Readers outside `src/`:** none found. `grep -rl ceiling_usd` across `scripts/`,
   `docs-site/` (source, not `dist/`), and non-generated docs turns up only prose
   references and `test/`; no `hooks/` directory exists. CONFIRMED clean.
3. **Dashboard fallback:** CONFIRMED narrower symptom, lower severity than #4. When
   budget.yml is corrupted (not just stale) after a raise+spend, the run-list
   headline falls back to the frozen mirror ceiling while `spentUsd` stays live,
   producing `$70.00` spent `of $50.00` — spent exceeds the shown ceiling.
   Reproduced directly against `buildModel`. The per-phase budget PANEL does not
   repeat this: `toBudgetModel` returns `null` outright when budget.yml won't parse,
   so only the headline is affected, and only under file corruption (not the
   ordinary-concurrency trigger #236 was filed over). Worth a follow-up issue but
   not blocking on its own.
4. Covered above (blocking).
5. **Old runs / missing or corrupt budget.yml:** the four moved readers all go
   through `RunStore.find`, which already throws when budget.yml is absent
   (`RunStore.ts:78`) — pre-existing behavior, not a regression. The two readers
   deliberately left on the mirror (`replay`, `runSnapshot`'s tolerant path) exist
   precisely for the damaged-file case.
6. **Dropped write (`budget.ts:152`):** no test depended on the mirror being fresh
   except the one this diff updated in place (`budget-ux.test.ts`), and that
   updated assertion is a real inversion (asserts the mirror does NOT move), not a
   pass-for-the-wrong-reason.
7. **Tests, §8:** CONFIRMED both new invariant tests go RED on revert. Reverted
   `runStatus.ts`'s `ceiling_usd: budget.ceiling_usd` back to
   `run.budget.ceiling_usd` by hand and reran just the two touched files:
   `test/budget-ux.test.ts`'s new test failed (`Expected: 90, Received: 50`... via
   the resumability assertion) and `test/resumability.test.ts`'s new test failed
   (`Expected: 90, Received: 50`) — 2 fail / 66 pass, confirming both assertions
   compare against the invariant, not the constant that produced it. Restored the
   file afterward (worktree left clean).
8. **18385 → 18369 `expect()` calls despite +2 tests:** left UNEXPLAINED. I did not
   run the full `bun test` suite (per instructions) and have no cheap way to
   attribute the delta from the two touched files alone — both touched files
   together show 271 `expect()` calls passing, which does not by itself explain a
   repo-wide drop. Not asserting a mechanism I have not checked.

## What I ran

- `bun run typecheck` → exit 0.
- `bun test test/resumability.test.ts test/budget-ux.test.ts` → exit 0, 68 pass, 0
  fail, 271 expect() calls (each captured on its own line, no pipes).
- Same two files after manually reverting `runStatus.ts`'s fix line → exit 1, 66
  pass, 2 fail (both new #236 tests), confirming RED-on-revert.
- Ad hoc `bun test` probes (not part of the suite, deleted after use) against
  `buildModel`, `renderReplay`, and the real CLI (`run new` / `budget raise` /
  `replay`) to measure findings 2–5 directly rather than trust the diff's own
  comments.

Never ran the full `bun test` suite (would re-verify nothing new and costs ~10 min
per the task brief).
