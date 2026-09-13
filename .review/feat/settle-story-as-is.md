verdict: merge
reviewed-by: a separate sonnet reviewer sub-agent (it did not write the code); the implementer's own self-check is NOT counted as a review
against: 6a40700

## What this adds, and where it comes from

`tldrx story reopen <id> --as-is --note "…"` settles a story whose work is already
committed: the DoD, the reviewer and the merge run over the branch as it stands, with no
developer spawned.

It exists because of a decision I made. #271 was my review, three rounds, and I set the
hard requirement that work be measured **since the spawn**. That correctly closed "a
developer worked and was then refused a permission" and blindly opened this: work that
already exists, older than the spawn, is indistinguishable from a developer that did
nothing. A branch a person rebased by hand with a green DoD could not be merged at all.
This is not a workaround of #271 — it is the case #271 could not see, and its rule is
untouched.

## The two things I required, and what the reviewer did about them

**The refusal had to be structural, not advisory.** A red DoD or a tip that is not ahead
of its base refuses, and no flag may skip it — a verb that merges "as is" is exactly
where someone adds a force at 3 a.m. to unstick a run. The reviewer grepped the whole
diff for `force|skip|env`: the only hits are prose and an unrelated pre-existing sibling.
No bypass exists. Exit-code families were checked per refusal rather than in general
(§7): usage refusals family 1, the sequencing refusal family 2 alongside its siblings,
and the as-is checks going through the ordinary `block()` path like every other story
block.

**The record must not claim a developer delivered this.** `story.reopened` carries
`reason: as_is` with the actor and the note; `task.done` carries `as_is`/`as_is_by`/
`as_is_note`; the review log's developer line reads **none** and names the signer; and no
task row is written for a turn that never ran.

## The defect that would have made that record lie

The implementer found, in its own self-check, that the as-is signature was held per
invocation and leaked onto a REQUEUED DEVELOPER attempt — the next agent's work recorded
as signed by a person. It fixed and pinned it. Because that is exactly the failure the
feature exists to prevent, I asked the reviewer to rebuild the scenario rather than read
the fix: removing the one line that clears the signature makes the second attempt's
`task.done` carry `as_is: true` again, and the regression test reddens. Confirmed by
mutation, not by inspection.

Four further mutations, each reddening only its own cases: the routing, the ahead
refusal, the DoD refusal, and the record field.

## Measured

- `## 0.18.3` byte-identical to `5c45fc2`'s; one `### Added` under `## 0.19.0 —
  unreleased`; no README release-table row (one now would drift from `package.json` at
  0.18.3), with `test/public-surface-consistency.test.ts` green 17/17.
- **The version is right for the reason, not by habit**: this adds CLI surface, and
  `docs/RELEASING.md` makes a new command or flag a minor. The heading was created as
  0.19.0 from its first bullet rather than renamed later, after I had first told the
  implementer 0.18.4 and then corrected myself.
- EN and ES docs compared by content, not by "both files changed"; `helpText.ts` is the
  source and no generated page was hand-edited (a known trap here).
- No golden moved; typecheck 0.

## The naming judgement, which I think is right

`story done` was rejected in favour of `story reopen --as-is`: `done` names an OUTCOME a
person cannot sign — the DoD and the reviewer decide it — and a verb called `done` that
can end `blocked` lies in its own name.

## Non-blocking, and being filed as its own issue

`shipBody.ts`, `dashboard/model.ts` and `build/handoff.ts` carry no `as_is` awareness.
The handoff's per-story line for an as-is settlement does not say so in its headline; it
cites the review log, where the truth is. That follows the repo's citation convention, so
it is not a lie — but a person skimming the handoff or the dashboard without opening the
citation cannot tell an as-is settlement from a developer delivery, and that is one
hop away from the thing this feature exists to prevent. Filed separately rather than
widened into this branch (§1).

## Not verified

No live `tldrx run auto` exercise — the evidence is the fake-agent harness. And
`--prepare` on an as-is story refuses rather than settling: a scope decision the
implementer made and declared, judged coherent by the reviewer because the refusal names
the actor, points at the headless path and gives the command to undo the signature.
