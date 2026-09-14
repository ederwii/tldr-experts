verdict: merge
reviewed-by: independent pre-merge reviewer sub-agent (claude-sonnet-5), spawned by tldr-experts-6d; it did not write this code
against: a80c61f

# fix/provider-limit-is-not-a-failure — #296 (first half only)

## What was reviewed, and what this branch deliberately is NOT

The whole branch diff against `origin/main` = `c529506` (which already carries #295),
plus the commit body. Reviewed TWICE: first at `b62a3c2` on parent `bbe2793`, then
again here after the branch was rebased onto `c529506`. The rebase made it a
different diff and restaled the first record, so this one is written against the new
head (AGENTS.md §2).

**#296 has two halves and only the first is built here.** The record lied: a turn that
died against the account's usage limit was written down as
`claude exited 1 with is_error=true: success`, because `describe()` concatenated our
`is_error` with the provider's own `subtype`, which was the literal `"success"` — two
layers' verdicts on one line with nothing reconciling them, and the only
human-readable word on it was the wrong one (AGENTS.md §7, an audit record lying in
the dangerous direction). That half ships.

**The second half — classifying the limit and making `--until-done` wait — is
deliberately absent, and the absence is the design.** Nobody has seen the RAW result
document of a rate-limited turn; only the rendered line. A detector pinned to a
guessed signal does not fail loudly, it silently never fires, while the issue reads as
closed and the record goes on lying. Filed as **#298** with the exact capture list
that would unblock it. The reviewer was told not to report the omission as a finding,
and told instead to check that the branch stays honest about not knowing — which is
the thing that could actually go wrong here.

## Findings

**None**, across both reviews. The first review's two substantive checks and the
re-review's three are recorded below because "nothing found" is only worth anything if
you can see what was looked at.

### First review (at `b62a3c2`)

1. **Provider completeness — my concern, REFUTED with mechanism.** I suspected
   `SUCCESS_SUBTYPES` (a one-member set holding `"success"`) was Claude-shaped and
   would leave the same lie live on Codex (§10). It does not:
   `resolveCodexResultDoc` (`agentEvents.ts:126-165`) never sets `subtype` at all, so
   the branch is unreachable for Codex — and Codex's `is_error` is true only when
   `failure !== null`, which always lands a real sentence in `errors[0]`, which wins
   first. Codex was never exposed to this lie. The fix is Claude-specific by name, not
   provider-partial in the dangerous sense. Verified independently by the orchestrator
   at `agentEvents.ts:126-168`.
2. **`describe()` is reached only when `ok` is false — CONFIRMED, and the whole design
   rests on it.** `spawnAgent.ts:529` computes `ok`, `:540` calls `describe()` only via
   `ok ? null : describe(...)`. A succeeding turn never reaches it, so treating
   `subtype: "success"` as a contradiction inside it is sound by construction. If this
   were false, the fix would be wrong rather than merely incomplete — which is why it
   was verified rather than taken from the comment asserting it.
3. **`errors[0]` still wins — CONFIRMED.** A provider-named reason
   (`Reached maximum budget ($0.26)`) and a genuine `error_during_execution` subtype
   print exactly as before. Pinned by a test that passed before the fix, so it is a
   GUARD, not a proof, and is labelled as one.
4. **Nothing parses the string's content — CONFIRMED at that tree.**
5. **§8, assertions able to fail — CONFIRMED.** Exact-string `toBe` and explicit
   negative assertions; a regression to the old concatenation reddens them.

### Re-review (at `a80c61f`, after the rebase onto #295)

6. **The rebase introduced no code — CONFIRMED by diff-of-diffs.**
   `git diff bbe2793 b62a3c2` and `git diff c529506 a80c61f`, restricted to
   `spawnAgent.ts` and `test/agent-stream.test.ts`, are byte-identical. Only
   `CHANGELOG.md` differs, which is the conflict resolution.
7. **The CHANGELOG union is correct — CONFIRMED.** ONE `## 0.23.0 — unreleased`, ONE
   `### Fixed` under it, all three bullets alive (#295's two, #296's one), no surviving
   conflict marker, and every dated section from 0.22.0 down byte-identical to
   pre-rebase — §5 immutability holds.
8. **#295 and #296 do not interact — CONFIRMED, and this is the finding that mattered.**
   The first review's "nothing parses this string" was measured on a tree that did not
   yet contain #295's code, so it said nothing about this one and was re-run. Result:
   `reviewLedger.ts`'s `lastMerge.verdict` and the `n-a`/`error` check driving the new
   review-only case (`reviewLedger.ts:353-369`) read `task.done`'s `payload.verdict` —
   the Review enum tag — never `AgentOutcome.error`'s text. `reviewerFailed`
   (`review.ts:376`) hardcodes `verdict: "error"` and puts the `describe()` string only
   into a display-only `summary`. **One reader does pattern-match it**:
   `looksLikeSpawnError` (`review.ts:424`) tests `text.startsWith("claude exited ")`.
   #296 changes only what follows the colon, so that prefix is untouched and the path
   is unaffected — verified independently by the orchestrator by reading `:424-429`.
   Recorded explicitly because "no reader" would have been the wrong summary: there IS
   a reader, and the fix survives it for a specific reason.

## Evidence

- `bun run typecheck` → exit 0 (rebased tree).
- `bun test test/agent-stream.test.ts` → 42 pass, 0 fail, exit 0 (rebased tree,
  `TMPDIR=/tmp/bx` — a long `$TMPDIR` reddens `build-executor`'s "WRONG branch" case
  for reasons unrelated to any code change, gh #293).
- The full gate is deliberately not run here; `scripts/merge-wave.sh` re-runs every
  gate on the merged tree, which is the tree that matters.
