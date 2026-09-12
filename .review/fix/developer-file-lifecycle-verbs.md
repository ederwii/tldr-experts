verdict: fixes required
reviewed-by: Claude Sonnet 5 (fresh pre-merge reviewer)
against: 7e6a724

## Important — CONFIRMED false positive in `permissionRefusal()` (risk 3)

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

Fix needed before merge: require the paired `tool_use` to be `Bash` **and** the `tool_result`
to carry `is_error === true` (both measured refusals — #209's and #261's own — are
`is_error: true`; nothing else on the developer's allowance can be denied for approval this
way). That alone would have refused the false positive above (`Read` is not `Bash`, and a
successful Read is not `is_error`). It does not need to solve #267 (the `cd &&` sentence
family) — that is correctly scoped out and already filed.

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
