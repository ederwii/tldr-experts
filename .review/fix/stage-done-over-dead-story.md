verdict: merge
reviewed-by: a separate sonnet reviewer sub-agent (it did not write the code)
against: 8154d36

## What this branch is, and what it is not

One line in `src/core/facilitator/executors/build.ts` (~:634-648): `blockingDependency`
is asked on every N, not only when `lanes > 1`. On the sequential path — the default,
and what `run auto` runs — a story whose `depends_on` blocked is now held back with a
reason instead of being attempted.

Most of #263 was already closed before this branch, and the implementer measured that
rather than assuming it. Clause by clause at `017dda8`: the stage reporting `done` over
a dead story is closed by #260's counting over every scheduled story and #210's
`storiesCondition`, which refuses to self-sign a Build gate while any story is
unfinished (the reviewer read `src/core/run/autoGate.ts:517-535` rather than taking the
claim); the story being left `todo` is deliberate and scoped out by the issue itself.
What still reproduced was the scheduler clause, and only sequentially.

## The finding that could have made this a defect, and how it was resolved

The 0.18.0 release notes record, about #260's frontier: *"`--parallel 1` is untouched on
purpose — a story whose dependency blocked is still attempted there, and changing that
would be a second change in the opposite direction."* This branch changes exactly that,
so the question put to the reviewer was not "is the new behaviour better" but "does the
change ADMIT it is reversing a decision on the record". A reversal that presents itself
as a bug fix is the defect, even when the new behaviour is right — the next person to
read the history must find both decisions and the reason, not one silently contradicting
the other.

It admits it. The commit body, the CHANGELOG entry and `docs/spec.md` §5 each name #260's
decision, quote its reasoning, and give the field measurement that overrides it: a story
died on its cap, was parked `todo`, and the next story built on top of it and reached
`done` on an epic branch the dead one never touched — an audit record lying in the
dangerous direction (§7). The released README row stays as it is, because released
sections are immutable and it is the correct historical record of what 0.18.0 decided.

I raised this as a possible silent reversal before the reviewer looked, on the strength
of the implementer's summary; the summary omitted it, the commit did not. The record
should say which of those two I had read.

## Measured, not asserted

- **Mutations, run by the reviewer**: restoring the `lanes === 1 ? null :` guard reddens
  exactly the one new test (156 pass / 1 fail); making `blockingDependency` walk every
  story instead of `depends_on` reddens both new tests plus 40 collateral cases. Tree
  clean afterwards.
- **No golden moved** — `test/build-golden.test.ts` run, not reasoned about (§12).
- **The collateral fixture edit.** `"a failed dod is written with its command and exit
  code"` used a fixture whose S2 depended on S1; under the new frontier S2 would never
  have run its dod, so the test would have kept passing for a different reason — the
  worst kind of green. It was given two independent stories, assertions untouched, and
  the reviewer confirmed it still proves what its name says. Necessary, not evasive.
- **Docs**: the `docs/spec.md` paragraph that said "N = 1 is unchanged" is now false and
  was corrected; `docs-site` was grepped and genuinely needed nothing.

## What stays open, named rather than absorbed

Two money clauses of #263 belong to the owner and are untouched: a Build invocation
re-spawning a parked story under an identical cap, and the absence of a sanctioned way
to raise ONE story's ceiling (`per_phase_usd` has no writer — #244). #277 widened the
ceiling but resolved neither. Every measurement here comes from the fake-agent harness;
no real `run auto` loop was re-run, and the implementer said so instead of implying
otherwise.
