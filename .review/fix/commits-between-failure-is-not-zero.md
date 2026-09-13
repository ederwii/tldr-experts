verdict: merge
reviewed-by: a separate sonnet reviewer sub-agent (it did not write the code); issue filed and evidence measured by tldr-experts-6d, Claude Opus 5, which is also the session recording this verdict
against: 9a50b8d

## What this fixes

`commitsBetween` answered `0` for a `rev-list` that FAILED, so a git call that could
not run and a true count of zero became the same number. `rederiveImplicitPlan`
(`build.ts` ~:410) read that zero as "nothing was built", fell past its `kept` guard
and DELETED the implicit plan. A failed git call destroyed work.

This is the highest-stakes item of its group and was pulled ahead of two others for
that reason: the rest leave a run stuck or mis-recorded; this one loses the plan. With
two real unattended loops live on a loaded machine, a `rev-list` failing under load or
a git lock is not a thought experiment.

## My standing in this review

I filed #273 and measured its evidence, so I am not a disinterested party to its close.
The code was written by an implementer and read by a reviewer that touched neither; what
follows is what that reviewer RAN, not what it accepted.

## The refactor nobody asked for, and why it was allowed

The implementer found `commitsAhead` byte-identical to `commitsBetween` but for its
return type, deleted it, and pointed its caller — `epicRelease.ts`, which is **#272's
fix, merged hours earlier** — at the now-`null`-safe `commitsBetween`. An unrequested
refactor over freshly merged safety code is where a silent regression hides, so it was
the first thing put to the reviewer, with three specific demands rather than an opinion:

- **#272's guard test must still pass for the SAME reason.** It does, and the proof is a
  mutation rather than a green tick: reverting the counter's failure path to `return 0`
  reddens #272's *"an epic git could NOT count against its base is KEPT"* **and** the new
  #273 test together. One mechanism, two call sites — which is exactly the claim the
  collapse makes, now demonstrated instead of asserted.
- **The recorded refusal string must be byte-identical.** `uncountedReason`'s output is
  unchanged; the reviewer read the new `uncountedCount()` composition against the old
  inline template rather than diffing line counts. A person reads that sentence; a moved
  character would have been a behaviour change (§12).
- **One derivation or two lookalikes?** Both callers want the identical contract — `null`
  means "could not count", the caller decides. Adjudicated as genuinely one.

## Measured, not asserted

- **The red test drives the DESTRUCTIVE path.** A unit test on the counter would neither
  have caught this bug nor proved it fixed. This one writes a real developer commit on a
  story worktree, deletes the epic ref so `rev-list` genuinely fails, runs the real
  `--discard-pending` path and asserts the plan survives unchanged. Removing the keep
  reproduces the original loss.
- **Every caller examined, not just the dangerous one.** `rederiveImplicitPlan` now keeps
  on `null`. The merge count in `BuildSession` routes a failed count into `mergedEarlier`,
  whose documented meaning already was "what it carried is not recoverable" — the reviewer
  checked `handoff.ts:39-55` and the three pre-existing `noteMerged(story, null)` sites
  rather than taking the claim; it was the caller I trusted least and it holds.
  `baseStateOf` keeps its `ahead`/`behind`/`state` outputs identical and carries the
  reason in a new additive field consumed only in memory.
- **Three mutations**, each reddening only its own test; tree clean after every round-trip.
- **No golden moved** — run, not reasoned about (§12).
- `## 0.18.2` is dated and byte-identical to `175e228`; the bullet sits under the existing
  `## 0.18.3 — unreleased` with one `### Fixed` group. `docs/spec.md`'s `--discard-pending`
  paragraph carried a "= 0" condition that this makes false; corrected and checked true.

## Not verified, on the record

No full-suite baseline count was taken at `175e228` (the branch-side 4614 is the measured
figure), and this was never reproduced in a real production run — the issue did not claim
one either; its evidence is the code path.
