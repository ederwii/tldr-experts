verdict: merge
reviewed-by: Claude Sonnet 5 (fresh pre-merge reviewer)
against: a0360ef

## Second pass — delta only (7e6a724 → a0360ef)

The content below was reviewed against `7e6a724` and flagged the false positive as
Important / fixes required. That finding is FIXED in `a0360ef`, verified independently
in this pass (not taken on the author's word). Not re-reviewed this pass, per the
coordinator's instruction, because already confirmed against `7e6a724` and untouched by
this delta: grant amplitude, `stack-packs-prompt`, the golden, and #252's exit-4 /
non-interaction with the relaunch loop.

**The fix.** `permissionRefusal()` now checks a STRUCTURAL signal first —
`tool_result_meta: [{ id, non_execution_kind: "user-rejected" }]` on the `user` line —
and only falls back to the `requires approval` sentence when fenced to
`call?.name === "Bash" && block.is_error === true`. Read the code
(`src/core/facilitator/agentEvents.ts:476-515`): the structural check
(`if (!structural && !byPhrase) continue;`) is checked and returns before the phrase
fallback is even consulted for that block — it is genuinely primary, not a decoration
bolted onto the old logic.

**Reproduced myself, not taken on word:**
- Ran `bun test test/agent-stream.test.ts` (39 pass) — includes the exact false-positive
  case I found last pass (`Read` of `docs/spec.md`), now asserted `toBeNull()`.
- Mutation A: removed both the `call?.name === "Bash"` and `is_error === true` conditions
  from `byPhrase` → 3 tests went RED, including my original `docs/spec.md` case and a new
  "Bash command that ran and printed the sentence" case. Reverted; tree clean after.
- Mutation B: removed only `is_error === true` (kept the `Bash` check) → 1 test went RED
  (a successful `Bash` grep that prints the phrase). Reverted; tree clean after.
- Both mutations confirm the fence is load-bearing in both halves, exactly as claimed.

**#267's scope.** Checked `gh issue view 267` and its comments: a comment was posted
(2026-09-12T23:22:25Z, from this same pre-merge review) stating the structural signal
now catches the `cd && git rm` family too, and narrowing #267 to what remains
unmeasured — whether `non_execution_kind` is emitted on every refusal family/version, and
what the fallback should do on a host emitting neither. Issue stays open, correctly
narrowed rather than closed or left stale.

**`fakeTranscript.ts` (shared emitter, §8).** `FakeTool.rejected` is optional and
additive: when absent, the `user`-line object literal builds through the same keys in
the same order as before (the new fields are added only via
`...(tool.rejected === true ? {...} : {})` spreads with no effect when false/undefined).
`codexOutput` is a distinct function in the same file and is untouched by this diff — the
Codex fake does not share this code path, so its shape (no per-tool allowance) is
unaffected. `bun test test/build-golden.test.ts` (4 pass) and
`test/build-executor.test.ts` (139 pass) both green, which is the practical check that
no existing fixture/golden byte moved.

**Golden.** `grep -rln "allowedTools" test/fixtures/build/golden/` → no matches (exit 1),
same as last pass.

**Count.** `git diff --name-status 7e6a724..a0360ef` shows no new test file — only
`test/agent-stream.test.ts` modified. It constructs transcripts as plain strings, no
process spawning, and does not appear in `test/machine-load.test.ts`'s guard-row list —
consistent with needing no new row.

## What was run this pass

- `bun run typecheck` (no pipe) → exit 0.
- `bun test test/agent-stream.test.ts` → 39 pass, 0 fail.
- `bun test test/build-executor.test.ts` → 139 pass, 0 fail.
- `bun test test/build-golden.test.ts` → 4 pass, 0 fail.
- Two targeted mutations in `agentEvents.ts` (above), each reverted immediately;
  `git status --porcelain` clean before and after.
- No permission probes, no destructive commands, no processes killed.

## First pass (against 7e6a724) — kept for the record

## Important — CONFIRMED false positive in `permissionRefusal()` (risk 3), FIXED in a0360ef

`permissionRefusal()` (`src/core/facilitator/agentEvents.ts:401-455`) scans **every**
`tool_result` block in the developer's transcript for the substring `requires approval`,
regardless of which tool produced it and without checking `is_error`. It matches on
ordinary file content, not just a denial sentence.

CONFIRMED by running the function directly against a synthetic transcript: a legitimate
`Read` of `docs/spec.md` — which this very branch edits to include the prose "tool call
came back `This command requires approval`" (docs/spec.md:3392) — returns
`permissionRefusal() === "docs/spec.md"`, a false positive with no refusal anywhere in
the transcript:

```
permissionRefusal result: "docs/spec.md"
```

This branch's own diff plants the trigger phrase in files a developer routinely reads or
greps: `docs/spec.md:3392`, `CHANGELOG.md:730`, `docs-site/guides/unattended-operation.md:546`,
`docs-site/es/guides/unattended-operation.md:565`, `docs/guide/09-troubleshooting.md:358`, and
in source comments (`agentEvents.ts:409`, `build.ts:3597`, `fakeClaude.ts:78/94`,
`story-worktree-deps.test.ts:297`). A story that touches docs (an entirely ordinary story
shape) and reads/greps any of these will falsely trip the detector.

Consequence, per `buildHalf` (`build.ts:1216-1230`): the check runs and returns **before** the
DoD or commit step, so a developer that did real, correct work — and merely happened to
`Read`/`Grep` one of these files along the way — has that work discarded (`commit: null`),
the story is blocked on a fabricated `permission — docs/spec.md` reason (not even a real
shell command), and a human is paged for a wall that never existed. This is exactly the
"blocked mentiroso" direction risk 3 asked about, and it costs real completed work, not just
an unused attempt.

Fix requested: require the paired `tool_use` to be `Bash` **and** the `tool_result`
to carry `is_error === true` (both measured refusals — #209's and #261's own — are
`is_error: true`; nothing else on the developer's allowance can be denied for approval this
way). That alone would have refused the false positive above (`Read` is not `Bash`, and a
successful Read is not `is_error`). It does not need to solve #267 (the `cd &&` sentence
family) — that is correctly scoped out and already filed.

**Status: FIXED in `a0360ef`** — see "Second pass" above for independent verification
(reproduced the false positive's absence and both required mutations myself).

## Everything else checked — no other Important finding

1. **Grant amplitude (git rm -r -- .).** Confirmed by reading `developerTools()` and the
   commit/docs measurement: `Bash(git rm *)` alone lets `git rm -r -- .` through the CLI's
   permission layer. The worktree/checkout argument holds: `git rm` only removes **tracked**
   paths, so nothing untracked is destroyed by this verb, and every tracked removal is undone
   by the same `git checkout` that undoes an `Edit`. Cross-directory escape (`git -C <x> rm`,
   `cd <x> && git rm`) is refused by the CLI itself (the second with a different sentence,
   correctly filed as #267 rather than silently accepted). PLAUSIBLE-but-accepted residual: a
   story whose worktree happens to be a shared/wrong tree would be as exposed as `git add`/`git
   commit` already are today — not a new hole this diff opens.

2. **Detector matches host prose, §8.** CONFIRMED: `PERMISSION_REFUSAL_MARK` is Claude Code's
   own sentence, not tldrx's. The test (`test/build-executor.test.ts`, the `FAKE_BUILD_DENIED`
   case) asserts against the same literal string the fixture emits and the code matches —
   it does not prove the detector would survive the host changing that sentence; that gap is
   inherent to string-matching host output and is at least labeled in code comments as
   "MEASURED... a substring, because... agreeing on a whole sentence would be a guess." No
   silent-drift alarm exists, but this is disclosed, not asserted as robust — an acceptable,
   named risk (not the same defect as the false positive above).

3. **Coverage is honestly partial.** CONFIRMED: `gh issue view 267` exists, filed by this same
   line of work, and states plainly that the `cd <dir> && git rm` refusal (a different sentence)
   is NOT recorded by this change. The commit message says the same ("filed as #267"). Docs
   (`docs/spec.md`, `CHANGELOG.md`) describe only the `requires approval` case and do not
   overclaim full coverage. Honestly declared, not oversold.

4. **#252 exit 4 / relaunch.** CONFIRMED by reading `relaunchVerdict()`
   (`src/core/facilitator/runAuto.ts:319-358`): `EXIT_AWAITING_HUMAN` (4) is checked and refused
   for relaunch before any other branch, unconditionally on the reason text. The new
   `permission — <command>` block reuses the pre-existing `"blocked"` → gate-pending →
   `EXIT_AWAITING_HUMAN` path already used by install failures and merge conflicts
   (`runNext.ts`); nothing in this diff adds a new exit-code branch keyed on this reason. The
   new end-to-end test (`test/build-executor.test.ts`) asserts `outcome.code === 4` and it
   passed (measured below).

5. **`stack-packs-prompt` change.** CONFIRMED honest: the test asserts a literal, ordered list
   of the developer's non-base tools; the list genuinely grew by the three new git verbs, and
   the diff updates the literal with a comment citing #261. Not a golden being adjusted to
   force a green diff.

6. **Golden.** CONFIRMED: `grep -rn "allowedTools" test/fixtures/build/golden/` → no matches,
   exit 1. This diff cannot touch `test/build-golden.test.ts`'s frozen bytes.

7. **New tests, red-first (§8).**
   - Mutation A: removed the three new grant lines from `developerTools()` → the shape test
     ("the developer may remove and rename paths...") went RED as expected.
   - Mutation B: replaced `permissionBlockReason()`'s body with a generic `"blocked"` string →
     the end-to-end permission test went RED as expected (asserted `permission — ` substring
     missing).
   - The `git rm --` end-to-end test is correctly labeled a GUARD in its own comment and in
     the describe block; CONFIRMED it passes even with the three grant lines removed (the fake
     agent runs its own tool calls and is never shown a real permission prompt), so it proves
     nothing about the fix — only the RED shape test and the mutation-B test carry proof.

## What was run

- `bun run typecheck` (no pipe) → exit 0.
- `bun test test/build-executor.test.ts` → 139 pass, 0 fail (exit 0).
- `bun test test/stack-packs-prompt.test.ts test/story-worktree-deps.test.ts` → 32 pass, 0 fail
  (exit 0).
- Two targeted mutations (above), each reverted immediately after observing RED; working tree
  confirmed clean (`git status --porcelain`) before and after.
- No permission probes, no destructive commands, no processes killed.
