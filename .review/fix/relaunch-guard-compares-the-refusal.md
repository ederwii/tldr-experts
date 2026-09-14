verdict: merge
reviewed-by: independent pre-merge reviewer sub-agent (claude-sonnet-5), spawned by tldr-experts-6d; it did not write this code
against: 6c7f79a

# fix/relaunch-guard-compares-the-refusal — #297

## What was reviewed

The whole branch diff against `origin/main` = `ecd60f8` (which carries #281 and #280),
plus all three commit bodies. Reviewed **three times**, and the branch changed after
the first two — each round is recorded below, because the verdict is only worth what
the rounds behind it show.

## The defect

`--until-done`'s relaunch guard compared `outcome.lines[length - 1]` across attempts,
so a loop would not spend its budget on a refusal that repeats verbatim. But
`failStage` — and, it turned out, seven other refusal sites — ends with a string
literal with no interpolation. For those families the guard compared a constant to
itself: selectivity zero, fires on the SECOND stage death of any run, discards every
remaining relaunch. It failed in both directions at once — blind to the stuck case it
was built for, fatal to the progressing one.

## The three rounds

**Round 1 — `fixes required`, one finding.** The implementer signed seven producer
sites and reported the audit complete. It was not: `runNext.ts`'s `refused === true`
pass-through is a single door for eight more producers (`setAsideForeign`,
`refuseOnDirtyRepos`, `refuseOnForeignEpic`, `refuseOnRedBase`,
`refuseOnUnrunnableWorktree`, and three in `watch.ts`) and the diff had never touched
it. Concretely: `setAsideForeign`'s last line ends in `relaunchCommand(mode, runId)`,
constant for the whole loop, so two *different* dirty-repo refusals in one run share a
last line and are read as the same refusal. Verified at the source by the orchestrator
before being sent back. **A partial fix that reads as complete was the worst available
outcome here**, which is why the reviewer was asked for exactly this.

The fix was directed to the door, NOT to the eight producers: signing them one by one
puts the correction in eight places and the ninth added tomorrow is born blind — the
very failure this change removes — and it would have collided with a sibling session's
branches in `executors/build.ts`.

**Round 2 — `fixes required`, three findings, and the interesting one.** The
implementer reported, with the word *measured*, that `error` "is non-null and
distinguishing on six producers". The reading was accurate; the QUESTION was wrong.
It had asked "does `error` vary?" — the question the comparand must pass is "does it
distinguish two different faults on the SAME repo?", which is the case a loop actually
hits, because a run comes back to the same repo. Three failed it: `setAsideForeign`
(interpolates only the repo, never `outcome.reason`), `dirtyRepoRefusal`'s overlapping
branch (only the repo, no paths or story), and `foreignEpicRefusal` (one shared
`const error` per branch across four structurally different sub-cases).

**A true measurement of the wrong question reads exactly like a measurement of the
right one**, and the word `measured` is what stops the next reader from checking. That
is the transferable lesson of this branch and it is why this section exists.

**Round 3 — `merge`, nothing found.** All four sentences now carry the distinguishing
detail; the fourth was found by the implementer itself after being told to measure with
its question stated, and it confirmed `redBaseRefusal` blind (it named only
`failures[0]`, so two different sets of red base commands sharing their first failure
produced a byte-identical `error` while the lines differed). The reviewer verified that
measurement rather than inheriting it: `baseSha: ""` defeats only the sha-match check,
empty `checkedAt` only staleness, a missing `commandHash` only hash-freshness — no
other path is affected, so the method isolates what it claims.

## What the reviewer checked and confirmed

- The door is one derivation: `executorSignature(outcome)` reads
  `signature ?? error ?? undefined`, then `comparandOf`'s last-line fallback. The same
  expression was given to the sequencing `EXIT_USAGE` pass-through so the two doors
  cannot drift. The other `lines[length - 1]` reads are the ledger's separate
  `last_line` field and a notification string, not comparison — no §7 duplication.
- The fallback to the last line is right where nothing names a signature: for those
  reports (a throw's message, a missing input) the last line IS the reason, so a repeat
  there is real evidence, and the `--until-done` bound remains the backstop.
- `run.relaunched.comparand` is additive; nothing bumped that should not be (§7).
- The new tests drive the REAL pipeline (`next()`) and assert `NextOutcome.signature`,
  the exact value the loop compares — two dirty trees in one repo, an unclaimed branch
  versus one an open run claims, two stash failures in one repo. Both directions are
  pinned: different fault → different signature, same fault twice → byte-identical.
  One test also pins the instrument, asserting the two relaunch records' `last_line`
  are EQUAL, so the case really is the blind one.
- **The CHANGELOG bullet was read as a CLAIM against what the diff delivers.** An
  earlier draft said every executor refusal names what refused it while three did not;
  it now names the four corrected sentences and claims no universal coverage. A bullet
  that overpromises is this same defect, in the record.
- Rebase cleanliness, arithmetically: no `caps.ts` / `budgetView.ts` /
  `dependencyHold.ts` in the branch diff, and the three commits' per-file line counts
  sum exactly to the whole-branch diff — so no #280/#281 code leaked in.
- CHANGELOG after the rebase: ONE `## 0.24.0 — unreleased`, ONE `### Fixed`, three
  bullets (#281, #280, #297), no markers, and `git diff origin/main -- CHANGELOG.md`
  has ZERO content deletions — pure addition, so §5 immutability holds by construction
  rather than by inspection.

## Version

**Minor.** The orchestrator first called it a patch, reasoning from the CAUSE (a
comparison that never did what it claimed). The rule here is the EFFECT: a
`run auto --until-done` that used to stop at the second stage death now keeps
relaunching, and the stop/relaunch reason quoted in the ledger changed. Both are
visible to someone who already had something working.

## Evidence

- `bun run typecheck` → exit 0.
- `bun test test/run-auto-until-done.test.ts test/dod-preflight.test.ts test/build-foreign-work.test.ts test/epic-release.test.ts test/build-executor.test.ts`
  → 263 pass, 0 fail, exit 0 (`TMPDIR=/tmp/bx`; a long `$TMPDIR` reddens
  `build-executor`'s "WRONG branch" case for unrelated reasons, gh #293).
- The full gate is deliberately not run here; `scripts/merge-wave.sh` re-runs every
  gate on the merged tree, which is the tree that matters.
