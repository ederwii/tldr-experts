verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: d4a41f2

# fix/changelog-released-sections — re-review of the delta 6ddabee..d4a41f2

All three findings from the prior pass are fixed, and each is re-verified by direct attack
rather than by reading the diff.

1. **GitHub release notes for v0.14.0 now carry the moved bullets.** Measured:
   `gh release view v0.14.0 --json body --jq .body` — line 3 opens with
   `` - **`tldrx run auto --wait-gates <duration>` — the loop waits for a signature...` `` and
   line 41 with `` - **`run auto` now closes an `agent` gate itself...` ``. `diff` against the
   corrected local section shows the two byte-identical (only a leading blank line differs). The
   past-tense CHANGELOG claim is now true, not aspirational.

2. **The amendment mechanism now verifies a MOVE, not a label.** `amendment_violation()` in
   `scripts/release-check.sh` requires the tag's section to survive as an ordered subsequence
   (nothing deleted or reworded) and every added line to exist verbatim at the amendment's
   `<source-sha>`. Replayed the original attack in the worktree: injecting
   `- SNEAKY UNRELATED BULLET THAT SHOULD NOT BE HERE` into the amended `## 0.14.0` section now
   makes `bash scripts/release-check.sh --ci` exit 1, naming the exact line ("this added line
   exists nowhere in cfccc80:CHANGELOG.md"). Reworded a real tag line
   (`run auto` now closes an `agent` gate...) instead — exit 1, "DELETES or rewords a line the
   tag has," quoting it. Reverted both; a clean run of `--ci` on the untouched branch exits 0,
   printing both amendments as "verified as a move of lines present at cfccc80." An unknown
   source sha is refused (test present, not independently replayed this round — logic identical
   to the other two checks and covered by `test/release-gate-order.test.ts`).

3. **CHANGELOG.amendments now says four bullets for a528985, matching the commit.**
   `git show a528985 -- CHANGELOG.md | grep -c '^\+- \*\*'` → 4 (trainer `cd`s; rejected run
   records WHICH problems; `## Sources` as prose; `expert train` exits nonzero) — the amendments
   line names all four verbatim. The undercount from the prior pass is gone.

Gates: `bun run typecheck` exit 0. `bun test test/release-gate-order.test.ts` → 24 pass / 0 fail
(up from 21), exit 0. Worktree left clean at d4a41f2 after every injected attack was reverted.

No Important or Critical findings this round.
