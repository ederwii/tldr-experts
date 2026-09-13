verdict: merge
reviewed-by: a separate sonnet reviewer sub-agent (it did not write the code); the prose-only amend from 042290e to 79a1717 verified by tldr-experts-6d, Claude Opus 5
against: 79a1717

## What was reviewed

`ed5f571..042290e`, then the amend that answered the one blocking finding. The
amend touches `CHANGELOG.md` and comment lines in `src/core/build/caps.ts` and
nothing else — verified by diffing with every markdown and comment line excluded,
which came back empty.

## The one finding that blocked, and why it was not waved through

The branch claimed, in the CHANGELOG and again in `STORY_CAP_MULTIPLIER`'s doc
comment, that `3` is "the smallest multiplier that clears the gap the field record
shows". The reviewer did the arithmetic against that record instead of reading the
sentence: over the prices the planner writes today ($1.20–$4.00) the ceiling lands
at $4.00–$12.00, so the expensive end of the observed spread still dies on its cap.
The claim was false for exactly the case the issue was filed about.

The code was right; only the sentence describing it was wrong, which is the kind of
finding it is tempting to record as non-blocking. It went back because a comment and
a changelog that promise more than the number delivers are a record lying in the
dangerous direction (§7): whoever reads "clears the gap" will not re-measure, and
when a costly story dies anyway they will look for the defect somewhere else. What
shipped instead names the surviving failure as a formula — a story still dies
whenever its real cost exceeds `max(price × 3, $4.00)` — which is the number the
next person needs to calibrate this and precisely what the old sentence hid.

## What the reviewer measured rather than asserted

- **The arithmetic**, above, worked against the field distribution rather than
  accepted from the commit.
- **The half that actually carries the expensive end.** Traced, not assumed
  (`build.ts:1253-1345`): a developer that dies on its cap with work in its tree no
  longer parks the story — it goes to the DoD, green completes the story normally,
  red records the DoD failure AND the cap-death reason together. Without this the
  fix would be the original failure with better paperwork.
- **Three mutations, run**: the ceiling reduced to the bare price (12 failures),
  `diedOnCap` forced false (3), the work proof dropped (10) — each reddening only
  its own cases; file restored, `git status --porcelain` empty afterwards.
- **The load-bearing claim about runs already in flight**: the ceiling is derived at
  dispatch from the price as it sits on disk, and no path rewrites `budget.yml`, so
  a run planned by the older planner is covered the moment the binary changes. This
  is the reason the design is not a migration, and it was confirmed by grep rather
  than by argument.
- **The declared deviation.** The issue asked for `workspace.yml`; the implementer
  used `stage.yml` beside `attempts`, `reviewer_share` and `gate_signer_share`,
  arguing a second config path for one derivation is what §7 forbids. Adjudicated in
  its favour: same shape, same range-checked-not-clamped mechanism, and a `stage.yml`
  written before these keys still reads (`version: 1` grows, §7).
- **No field data in tracked files** (§7/#191): the observed dollar figures and run
  identifiers from the other session's private workspaces are absent; the planner
  guidance carries the shape only.

## Out of scope, on the record

A stage that still reports `done` over a story that died is **#263**, cited in the
commit and deliberately untouched here. The implementer was asked whether this
change closes part of it and answered that it plausibly does but that it did not
measure it — so nothing is claimed. That is the right answer and it is recorded as
the open question it is.

## Not blocking

The refusal of a multiplier below 1 was confirmed by name in `STAGE_TUNING_RANGES`
but its literal exit code was not driven through the CLI; it shares the validation
path of its pinned siblings (family 1, usage). No new gap — the same is true of
every sibling key.
