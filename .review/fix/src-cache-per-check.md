verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: acadea8

# fix/src-cache-per-check — reviewed against acadea8

## What was traced (all CONFIRMED, measured against the diff and the tree at acadea8)

- `refreshSrcIndexes()` (`src/core/text/srcToken.ts:1508`) clears exactly the six file-backed
  module-scope `Map`s (`lineCountCache`, `factsCache`, `questionsCache`, `graphCache`,
  `mapCache`, `urlCache`) — verified by reading their declarations (lines 708, 1311-1315) against
  the function body. `clearSrcCaches()` delegates to it and additionally clears `epicBlobCache`
  / `epicBlobReads` (git-blob memo), matching the claim.
- The single production invalidation call sits at the top of `toSrcContext`
  (`src/hooks/lib/workspace.ts:274-279`), before the returned object is built.
- Traced all 12 production call sites of `toSrcContext` (`run/checks.ts:107`,
  `facilitator/runNext.ts:1745`, `executors/watch.ts:179`, `watch/arm.ts:322`,
  `cli/commands/watch.ts:194`, `cli/commands/approve.ts:164`, `run/newRun.ts:332,372`,
  `training/runTraining.ts:465`, `training/rescoreExperts.ts:114`, `hooks/claim-sources.ts:48`):
  every one builds a fresh `SrcContext` locally and passes it down; none is stored on a
  session/class field and reused across stages or polls. `checkClaimSources` builds its `srcCtx`
  once, OUTSIDE its per-file loop — the intra-check memoisation the fix is supposed to preserve is
  intact. `watch/arm.ts:322`'s call is inside `merged()`, fired once at merge-detection, not once
  per poll iteration — no staleness there either. `resolveSrc`/`validateHandoff`/`validateCitations`
  take a `ctx` parameter and never call `toSrcContext` themselves, so no per-citation refresh loop
  exists anywhere (grepped `toSrcContext(` inside `srcToken.ts`/`handoff.ts`: zero hits).
- No second stale cache layer: `src/core/text/questions.ts`'s `new Map(pairs)` calls (lines 269,
  282) are function-local parsing helpers, not module scope; `src/core/facts/FactsStore.ts` has no
  module-scope cache at all.
- `hooks/claim-sources.ts` is a `#!/usr/bin/env bun` script (`await runHook(...)` at top level) —
  a fresh OS process per PreToolUse call, so its module caches start cold regardless of this fix;
  the added `refreshSrcIndexes()` call there costs nothing extra. For `run auto` (one warm process
  across stages), the added cost is one full facts.yml/questions.md re-read per check/gate
  invocation — a handful of times per run, not per citation — inferred negligible next to a paid
  LLM turn; not benchmarked.
- `questions lint` (`cli/commands/questions.ts`) imports neither `srcToken.ts` nor `toSrcContext`
  — it validates question-file structure only, never resolves `[src:]` citations, so it is
  genuinely outside this fix's scope rather than a coverage gap. The epic code-reviewer path
  (`src/core/build/*`, `executors/build.ts`) likewise never calls `toSrcContext`/`validateHandoff`
  — confirmed by grep, only a stale comment mentions it. `tldrx next --commit --check` runs the
  same `finishStage`/`runChecks` path as `--commit`, already covered.
- New test `test/src-cache-freshness.test.ts`: the freshness case writes real files, calls the
  real `FactsStore.update` writer, and asserts on the exact refusal strings the CHANGELOG/spec cite
  — confirmed `"no such question ${q} in this run's questions.md — declared: …"` is the real
  message at `srcToken.ts:839`. The memoisation-guard test deletes both backing files mid-context
  and asserts stale-but-correct answers — a real regression test for "don't over-refresh."
- CHANGELOG heading is exactly `## 0.14.2 — unreleased` directly above the dated `## 0.14.1 —
  2026-09-09`; `docs/spec.md`'s new paragraph sits inside `### 2.8` (993-1198), before `### 2.9`.
  `bash scripts/release-check.sh --ci` in the worktree: **exit 0**, "release check OK for 0.14.1",
  no released section altered.

## Minor (not blocking)

- **CHANGELOG.md, the #206 bullet under `## 0.14.2 — unreleased`**: "`clearSrcCaches()` had 20
  call sites, all in tests" is measured wrong. Counting actual invocations of `clearSrcCaches(`
  in the tree at base `59db2af` (before this branch): **28** call sites across **17** distinct
  test files (plus the one definition line in `srcToken.ts`, not a call). "All in tests" is
  correct; the number "20" is not. Cosmetic — does not affect the diagnosis or the fix — but
  worth a one-word correction (28, or "two dozen-plus") before release.

## Commands run (this session, targeted only, per instruction)

- `bun run typecheck` in the worktree — **exit 0**.
- `bun test test/src-cache-freshness.test.ts test/claim-sources.test.ts test/src-grammar.test.ts
  test/evidence.test.ts test/epic-citations.test.ts test/map-citations.test.ts
  test/watch-epic-citations.test.ts` — **123 pass, 0 fail, exit 0**.
- `bash scripts/release-check.sh --ci` — **exit 0**.

No Critical or Important findings. The fix does what it claims: it moves invalidation from
"never, outside tests" to "once per citation-context build," which is once per check/gate/hook
call in every production path traced, and it deliberately leaves the git-blob memo (a different,
immutable-content cache) alone.
