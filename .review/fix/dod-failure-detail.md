verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: 06e51dd

## Round 1 (against 2bff264, base 404e8f4) — 2 Important, 2 Minor

- Important — CONFIRMED: `previousAttemptText`'s `hasPriorAttempt` fired for a story that
  blocked purely on DoD with zero review rounds, but `prompts.ts`'s `## Previous attempt`
  header unconditionally said "A reviewer read your last attempt … and asked for changes."
  Reproduced directly: a generated retry prompt asserted a review over a quoted log reading
  `Verdict: n-a · Reviewer: not recorded`.
- Important — CONFIRMED: `writeDodOutput` persists up to 16 KB of unfiltered raw command
  output under `tldrx-work/<run>/04-build/log/dod-output/`, and this repo's own
  `docs-site/concepts/files-as-state.md` says `tldrx-work/` is committed to git by design
  (`tldrx doctor`/`init` actively re-include it against accidental `.gitignore` shadowing).
  No redaction, no documented warning anywhere in the diff.
- Minor: `[src: <path>:1]` hardcoded line 1 despite the existing `lineOf()` contract
  ("never a guessed or constant line number").
- Minor: `FAILURE_RE` did not match bare lowercase `fail` — measured against a real `bun test`
  failure, whose own `(fail) <name>` summary line was not selected by the heuristic.

## Round 2 (against 06e51dd, base 57e4bcf — rebased onto #212/#210/#209/defaults)

All four round-1 findings addressed, each verified directly, not just read:

1. `PreviousAttemptKind`/`previousAttemptHeader()` in `prompts.ts`, chosen by DATA
   (`previousAttemptKind()` in build.ts) rather than by the mere presence of a log. Test
   `#211 · the previous-attempt header says which kind of attempt it was` pins both headers
   plus the DoD-reopen scenario asserting `"Your last attempt blocked on its Definition of
   Done"` and NOT `"A reviewer read your last attempt"` — green.
2. `tldrx-work/**/04-build/log/dod-output/` added to `GITIGNORE_IGNORES`
   (`ambientFootprint.ts`), positioned after `!tldrx-work/**` so it wins. Verified via
   `test/gitignore-shadow.test.ts`'s new case: real `git check-ignore` exits 0 on a fixture
   output file, `04-build/log/S1.md` stays tracked. Documented with the secrets rationale in
   spec.md §2.9, troubleshooting.md, both FAQ pages (EN/ES), and the CHANGELOG.
3. `output_line`/`outputLine` resolved via the repo's existing `lineOf()` against the actual
   written file text — citation now points at the excerpt's real line, not a constant `:1`.
   Test asserts the citation's line equals the FAIL line's own index in the kept file — green.
4. `\bfail\b` and `not found` added to `FAILURE_RE` — the latter fixes the #209 regression the
   implementer found on rebase (`absent_binary` going from `dodbin` to `""` because #209 reads
   the binary name off `tail`, which #211's narrowing had stopped preserving `command not
   found` lines for). `test/story-worktree-deps.test.ts`'s real end-to-end 127 scenario
   (`runNext` against a real missing worktree binary) still yields `BINARY_ABSENT_MARKER` — green.
5. Union with #209 checked directly in `outcome.ts`/`dodRunner.ts`: `binaryAbsentReason` still
   short-circuits before the excerpt/citation path, so `tree`/`absent_binary` and
   `detail`/`output_*` coexist without either overriding the other.

Verification run against 06e51dd:
- `bun run typecheck` → exit 0
- `bun test test/dod-failure-detail.test.ts test/story-worktree-deps.test.ts
  test/build-golden.test.ts test/build-executor.test.ts test/gitignore-shadow.test.ts` →
  182 pass, 0 fail, exit 0 (golden byte-identical)
- `bash scripts/release-check.sh --ci` → exit 0 (release check OK for 0.14.3; the dated 0.14.3
  section is untouched — this PR's bullet lives under the existing `## 0.15.0 — unreleased` /
  one `### Fixed` heading, no duplicate kind headings)
- `git merge-base --is-ancestor 57e4bcf HEAD` confirmed; worktree clean at 06e51dd.

No Important or Critical findings remain. Merge.
