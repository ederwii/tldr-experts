verdict: merge
reviewed-by: Claude Sonnet 5 (fresh pre-merge reviewer)
against: e0b2cfb

## Re-review of the blocking finding from the previous pass

The previous `against: 9ec01ee` record found `tldrx replay` pairing a LIVE
`spent_usd` with a frozen `ceiling_usd` from run.yml's mirror, reproducing #236's
symptom on a mainline path (`$12.00 spent of $10.00 ceiling` after an ordinary
raise, no corruption or concurrency). That finding is FIXED at `e0b2cfb`.

1. **One derivation, not two that coincide, CONFIRMED.** `replay/loadRun.ts`'s
   `loadRunResult` computes `withLiveCeiling` once (budget.yml's ceiling when it
   parses, the mirror only as a fallback) and both consumers read it from the
   SAME object: `replay/index.ts`'s `loadRun` calls `loadRunResult` and returns
   its `.run`; `dashboard/model.ts:1082` calls the identical `loadRunResult` and
   uses `loaded.run` (`doc`) at line ~1241 (`ceilingUsd: doc.ceiling_usd`) with no
   second resolution. Traced both call paths to the one function — not two
   parallel implementations that happen to agree today.
2. **Dashboard fallback when budget.yml won't parse: not silent, not invented.**
   `dashboard/model.ts` dropped its own `?? doc.ceiling_usd`, but the fallback
   didn't disappear — it moved into `loadRun.ts`'s single derivation, which still
   falls back to the mirror when `budget?.ceiling_usd` is null/undefined. The
   dashboard is not left without a ceiling on a damaged file; it still shows the
   creation figure, same as before, just from one place. Confirmed this is the
   documented, filed-as-#245 tradeoff, not a new silent zero.
3. **Re-ran my exact blocking scenario myself, real CLI, at e0b2cfb:**
   `run new --budget 10` → `budget raise 01-what 5.00` → one task costing
   `orig+2` → `tldrx replay <id>`. Measured:
   ```
   Status: **pending** · $12.00 spent of $15.00 ceiling
   ```
   ($15 = the raised budget.yml ceiling.) Before the fix this printed
   `$12.00 spent of $10.00 ceiling`. FIXED, my own measurement, not the author's.
4. **Swept RunFile.ts's other frozen/mirror fields myself.** `RunBudgetMirror`
   (`RunFile.ts:348-352`) has exactly three fields: `ceiling_usd` (now resolved
   live via `loadRun.ts`), `spent_usd` (always live, re-derived every save), and
   `per_agent_max_usd`. Grepped every reader of `per_agent_max_usd`/
   `perAgentMaxUsd` in `src/`: the one the dashboard panel displays
   (`dashboard/render.ts:1007` via `toBudgetModel`, `dashboard/model.ts:1439`)
   reads it from `loaded.budget` — a `BudgetDocument` parsed straight off
   budget.yml, a completely different type from `RunBudgetMirror` — never from
   the run.yml mirror. `toRunDocument` (`RunDocument.ts`) does not even project a
   `per_agent_max_usd` field out of run.yml at all, so there is no path from the
   mirror's copy to any renderer. Also checked other "frozen at a moment" fields
   in the file (`run.created` policy snapshot at gate-signing, `created_with`) —
   both are audit snapshots deliberately paired with their live counterpart to
   show the delta (`created_with` next to `last_written_by`), not accidental
   half-updates. Sweep holds: no second instance of the class found.
5. **`budget.ts:152` did not get the mirror write back.** Diffed
   `9ec01ee..e0b2cfb` for `src/cli/commands/budget.ts`: no change. Still
   `store.mutateBudget(() => outcome.budget)` only, comment intact.
6. **CHANGELOG no longer claims "replay narrates the document" as a rescue.**
   Diffed the entry: it now states run.yml's budget block is "half live," quotes
   the exact measured regression ($12/$10 after a $10→$30 raise), says the
   argument "does not rescue it when the document itself is mixed," and
   describes the one-derivation fix plus the #245 sweep. Text matches what was
   actually done.
7. **Tests, §8: RED-on-revert CONFIRMED, my own repro.** Hand-reverted
   `loadRun.ts`'s `withLiveCeiling` computation back to `const withLiveCeiling =
   run;` (i.e. always the mirror) and reran `test/resumability.test.ts` alone:
   exit 1, 2 fail / 43 pass. The new test failed exactly as declared —
   `Expected: 150, Received: 50` — plus the sibling test from the first pass
   also reddened (`Expected: 90, Received: 50`), confirming the two prior-green
   assertions on the raw on-disk mirror (`onDisk.ceiling_usd === created`,
   `onDisk.spent_usd === spend`) do capture the half-live block: they stayed
   green through this revert because they read the untouched mirror directly,
   only the resolved-ceiling assertions moved. Restored the file after
   (worktree left clean, confirmed via `git status`/`git diff --stat`).

## #245 audit

Read the filed issue. It faithfully describes what I measured as non-blocking in
the prior pass: same trigger (budget.yml damaged AND a raise), same measured
output (`$12.00 spent of $10.00 ceiling` via the CLI, `buildModel` returning
`spentUsd: 12, ceilingUsd: 10`), same root cause named (`RunStore.ts` rollUp
re-deriving `spent_usd` but not `ceiling_usd`), same affected surfaces (dashboard
headline via `render.ts:964`/`:1859`, replay's fallback path), and it correctly
scopes the fix as a judgement call (three options given, owner's call) rather
than silently deciding one for #236. Not under-described.

## What I ran

- `bun run typecheck` → exit 0 (checked on its own line, no pipe).
- `bun test test/resumability.test.ts test/budget-ux.test.ts` → exit 0, 69 pass,
  0 fail, 277 expect() calls.
- `test/resumability.test.ts` alone after hand-reverting `loadRun.ts`'s fix →
  exit 1, 2 fail / 43 pass, RED lines quoted above.
- Ad hoc CLI probe (not part of the suite, deleted after use): `run new` /
  `budget raise` / manual task-cost mutation / `replay` through the real
  `bin/tldrx.ts`, to measure point 3 myself rather than trust the author's or
  the CHANGELOG's number.

Never ran the full `bun test` suite (another agent is working in parallel and
load reddens the concurrency tests per the brief).
