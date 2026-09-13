verdict: merge
reviewed-by: two separate sonnet reviewer sub-agents (neither wrote the code) — one at 47078c7, one at f54cbcb after the rebase; CHANGELOG union resolved by hand by tldr-experts-6d, Claude Opus 5
against: f54cbcb

## What this fixes

A wave runs its stories from one tip and merges them one after another, so every story
but the first merges from a base that is already behind — and its DoD proved a tree
without the sibling's work in it. The prose note telling the developer to rebase does
not make anything rebase: three real unattended runs hit this and a person fixed each
one by hand, the slowest costing about an hour and twenty minutes of wall clock (the
peer session's measurement of its own runs, not mine).

Build now measures the story branch against the epic tip immediately before the merge
and, when the epic has moved, merges the epic INTO the story in the story's own worktree
(never a rebase — the house rule) and re-runs the DoD on the result. A conflict blocks
the story naming the files, with `merge --abort` already run and nothing merged.

## The promise in the CHANGELOG, pinned rather than asserted

The change claims one extra DoD per story **only** when the epic moved. The implementer
was honest that one of its own mutations proved nothing — deleting the early return
reddens no test, because the rule is enforced by the HEAD-moved check and the early
return is only a saved git call. That honesty is why it was verified properly instead of
believed: the reviewer proved the guard is load-bearing (bypassing the real check reddens
3 of 4 executor cases), that an unmoved epic pays no second DoD, and that a moved one
pays exactly one — not one per wave, not one per attempt. A cost a CHANGELOG promises and
no test pins is a lie waiting for its moment.

## Two sessions, one file — the part only a rebase review can see

This branch and the peer session's #278 (`e31550a`) both touch
`src/core/facilitator/executors/build.ts`: theirs the refusal path inside `buildHalf`,
mine the merge path in `settleHalf`. Landing second, the question that matters is not
whether either change is right alone but whether they COMPOSE: #278 can now re-spawn a
developer once for a chained-line refusal, and this re-runs the DoD before merging. Two
DoD runs reachable for one story would make the promise above false with neither change
being wrong.

Traced, not assumed: each story is `settleHalf(await buildHalf(planned))` — strictly
sequential. The separator retry fires at most once and always resolves before `buildHalf`
returns; nothing re-enters `buildHalf` after `settleHalf` begins. The two block paths are
mutually exclusive branches of one linear function, each early-returning, so neither can
overwrite the other's `blocked_reason`. The pin still holds on the new base (32/32).

## Measured on the rebased tree

- **The rebase altered nothing but the CHANGELOG**: `git range-diff 6a53a76..47078c7
  e31550a..f54cbcb` shows one hunk, all CHANGELOG context. A rebase that silently edits
  code is the failure mode here, and it did not.
- **The union is clean**: the peer's #278 bullet byte-identical to `e31550a`'s, one
  `### Fixed` under `## 0.18.3 — unreleased`, and the dated `## 0.18.2` byte-identical.
- **No golden moved by this branch** — the moved prompt fixtures belong to `e31550a`
  alone, which the range-diff proves (§12).
- Mutations at the pre-rebase head, each reddening only its own case: never update the
  base (3 of 4 executor cases), a conflict that does not block (the conflict case), a DoD
  charged on an unmoved HEAD (the unmoved case).
- typecheck 0 · story-base 32 · build-golden 4 · build-parallel 19 · build-executor 163.

## Worth keeping, from the implementation

Choosing `merge(<story>)` as the sync commit's subject reddened a test that filters
`git log` for the string `merge(`. Commit subjects are read as data somewhere in this
repo. The subject is `sync(<story>)` and the spec says so; the reviewer grepped for other
subject- and linearity-sensitive assertions and found two, both green.

## Not verified, on the record

No live `tldrx run auto` reproduction — the evidence is fixture-level through the real
executor and real git. The field numbers above are the peer session's measurements of
its own runs and were not re-taken here. **#279** (a hand-fixed story cannot be merged
because `story reopen` spawns a developer with no new work) is NOT solved by this: this
change never re-dispatches a developer. The new pre-merge step is where that path will
plug in, and it is the next issue.
