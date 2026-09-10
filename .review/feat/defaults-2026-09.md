verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 35f762d

## Round 1 (a15fbc5..bd13be4) — money semantics, verified clean

Per-agent cap at spawn stayed one attempt's estimate (`perAgentMax = max(perStage.values())`,
never multiplied by `attempts`, `src/core/run/newRun.ts:497-506`); no retroactive doubling
(`planBudget` runs only at `run new`, old `budget.yml`/`run.yml` parsed as literal numbers);
golden exactly 4 one-line `ceiling_usd` 8→16 diffs, stage share unchanged at $8; learn ch.8's
`$0.89` asserted against real command output, not typed; context-window nulls threaded
end-to-end (`DASHBOARD_MODEL_VERSION` untouched); `inputs_max_bytes`(256K) < `prompt_max_bytes`
(400K) invariant holds; docs EN/ES lockstep; `run auto --prompt-max-bytes/--max-reads` forward
with the documented flag-beats-stage-file precedence. `bun run typecheck` 0, targeted suite
(454 tests) 0 fail, `release-check.sh --ci` 0.

Found and reported as Important/Minor (not Critical — no overspend path):
1. `dashboard/model.ts` printed "attempt N of M" off the global `MAX_ATTEMPTS` constant for
   every run, wrong once a workspace writes `attempts:`.
2. `warn_at_pct` measured against the (now-doubled) raw phase ceiling, so `budget.warned` fired
   at ~2x the real dollars it used to for a run that never retries — undocumented.
3. `src/hooks/dod-gate.ts`'s own `DEFAULT_TIMEOUT_S = 900` (pre-existing, untouched by the
   branch) never opened a stage file; the gap to the new 7200 default widened from 900-vs-1800
   to 900-vs-7200.
4. `story reopen --for-fix`'s "attempt 1 of MAX_ATTEMPTS" text used the same global constant.
5. `budgetView.ts`/`budget-gate.ts` don't resolve `attempts`/`reviewerShare`, defaulting to 2 —
   verified by direct probe of `caps.ts` to be the SAFE (over-, not under-, reserving) direction
   for `attempts:1`, but undocumented.

## Round 2 (9730413..d4f0d9b) — all five addressed

Reviewed the branch's own diff only (excluded the `c33bc82` rebase's unrelated upstream
commits): 16 files, 352 insertions, 25 deletions.

1. **Fixed.** `RunModel.maxAttempts` (additive; `DASHBOARD_MODEL_VERSION` stays 3) is resolved
   per run via the new one-derivation `buildStageDefaults(root, scope)`
   (`src/core/run/workflowPreset.ts`), which finds the BUILD-phase stage by `phase:` and reads
   its `attempts`/`timeout_s`, tolerant (never throws) on an unreadable workflow. `render.ts`'s
   three `dash*` calls switched from `model.maxAttempts` to `run.maxAttempts`.
   `test/stage-defaults.test.ts` — "a run whose Build stage says `attempts: 3` renders `of 3`"
   — asserts `dashStoryArcs` output literally contains `"attempt 1 of 3"`. PASSED.
2. **Fixed.** `wouldExceed` gained a `warnBasis = ceiling / max(1, attempts)` and measures
   `warns`/`pct` against it, not the raw ceiling; `exceeds`/`remaining`/`on_exceed` untouched
   (the refusal still answers for the whole phase). `runNext.warnOnce` takes `spec.tuning.attempts`
   and divides the same way; the printed sentence now says "X% of one attempt's $Y share of its
   $Z ceiling". Owner decision dated 2026-09-09, documented in CHANGELOG and spec.md §2.11.
3. **Fixed.** `dod-gate.ts` now resolves story `timeout_s:` → `buildStageDefaults(...).timeoutS`
   → shipped default, deleting the private stale constant. `test/hooks.test.ts` replays exactly
   the scenario I'd have asked for: stage `timeout_s: 2`, a `sleep 30` dod command → the gate
   DENIES with "timed out after 2s" (would have ALLOWED under the old 900s constant). PASSED.
4. **Fixed.** `reopenStory.ts` resolves `attempts` via the same `buildStageDefaults` and prints
   the real number.
5. **Documented, not silently accepted.** Both call sites carry an explicit comment naming the
   gap and citing #214. Filed issue #214 verified open (`gh issue view 214`): correctly labelled
   `inferred`, names both call sites and `warnBasis`'s formula, states the two directions
   (`attempts:3` under-reserves/safe, `attempts:1` over-reserves/can spuriously refuse), and
   proposes two fix shapes. This is the correct outcome per AGENTS.md §1 (a measured/inferred
   deviation, named, not silently fixed or silently ignored).

## Verification this round

- `bun run typecheck` → exit 0
- `bun test test/stage-defaults.test.ts test/build-golden.test.ts test/gates.test.ts
  test/facilitator.test.ts test/run.test.ts test/hooks.test.ts test/story-reopen.test.ts
  test/dashboard.test.ts test/multi-run.test.ts test/review-handshake.test.ts
  test/public-surface-consistency.test.ts test/docs-cli-coverage.test.ts
  test/remaining-work.test.ts` → 517 pass, 0 fail, exit 0
  (deliberately excluded `test/dashboard-live.test.ts`/`test/dashboard-server.test.ts`: confirmed
  via `gh issue view 193`/`213` these are the fs.watch/SSE flakes under fseventsd load, unrelated
  to this change's `maxAttempts` diff, which is covered instead by `test/dashboard.test.ts` and
  the model-shape assertions in `test/stage-defaults.test.ts`)
- `bash scripts/release-check.sh --ci` → exit 0, "release check OK for 0.14.3", released sections
  untouched

No new Important/Critical findings this round. Verdict: merge.

## Round 3 (rebase e1f363b..35f762d, on top of #212/#210/#209) — re-verified after rebase

Branch rebased onto `e1f363b` (#212/#210/#209 landed on main); feat/fix/review commits kept a
linear single-parent history (`7de9f41`→`e519e2e`→`5b57d4a`), with one new top commit `35f762d`
resolving two post-rebase conflicts.

- **Diff-of-diffs.** `git diff c33bc82..d4f0d9b` vs `git diff e1f363b..35f762d`, excluding
  `CHANGELOG.md` and `test/dashboard-live.test.ts`: same 70 files touched (the only file-set
  difference is `.review/feat/defaults-2026-09.md`, present only in the new range because the old
  range's tip predates that commit — expected, not a rebase artifact). Per-file added/removed
  LINE CONTENT (ignoring line-number/blob-hash reflow from unrelated upstream edits to shared
  files, e.g. `docs/spec.md`, golden fixtures gaining #209's `tree` field) is byte-identical
  across all 70 files — 0 mismatches. `35f762d`'s own diff touches exactly `CHANGELOG.md` and
  `test/dashboard-live.test.ts`, nothing else (`git diff 5b57d4a..35f762d --stat`). Confirms the
  rebase carried this branch's own changes through unaltered.
- **(1) `test/dashboard-live.test.ts` byte pin — CONFIRMED.** At `e1f363b` (post-#210, pre this
  branch) the pin was already `121_997` (#210's `outcome:null`). This branch's own `maxAttempts`
  addition adds 10 bytes on top: `35f762d` re-measures the pin to `122_007` and the sha256
  alongside it. `bun test test/dashboard-live.test.ts` → 15 pass, 0 fail.
- **(2) CHANGELOG merge — CONFIRMED correct.** One `## 0.15.0 — unreleased` heading, one each of
  `### Added`/`### Changed`/`### Fixed` (no duplicate heading kind). `e1f363b`'s own section had
  8 bullets (`### Added`/`### Fixed` only); this branch's own (`d4f0d9b`) had 9 (adds
  `### Changed`); merged section has 17 — all 17 verified present verbatim by text match, none
  lost, none duplicated. Dated sections untouched: `bash scripts/release-check.sh --ci` → exit 0,
  "release check OK for 0.14.3".

Verification: `bun run typecheck` → exit 0; `bun test test/stage-defaults.test.ts
test/hooks.test.ts test/build-golden.test.ts test/dashboard-live.test.ts` → 115 pass, 0 fail,
exit 0; `release-check.sh --ci` → exit 0. No new Important/Critical findings. Verdict: merge.
