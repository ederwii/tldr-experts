verdict: merge
reviewed-by: a separate sonnet reviewer sub-agent (it did not write the code); the field-evidence gap in item 8(a) resolved afterwards by tldr-experts-6d with the peer session's run records
against: b74bc5e

## Two issues, one change, because they are one question

#244 and #289 both live in `caps.ts` and both ask: how much money is there, and who decides
when there is not enough. Doing them separately would have opened the same arithmetic twice.

**#244.** A `blocked_reason` told a person to raise the budget; they raised it; nothing moved;
each `reject --and-continue` bought exactly one more turn. The reason was not a broken
command — it was that `budget raise <phase>` moves the one knob that controls no spawn cap.

This is where an assumption of MINE was refuted before it could become the fix. I told the
peer session these were three copies of one number and to unify them behind a single source.
Their per-case measurement showed they are three knobs with three jobs: the stage's
`budget_usd` sets the price scale and the reviewer's remainder; `per_agent_max_usd` only
caps the developer from above; `phases[]` only feeds the economy refusal. Unifying them would
have fused things that are not the same. The fix is smaller and truer: `budget raise` gains
`--stage <id>` to move the knob that matters, additive like the rest of the verb, and a raise
that names no stage now SAYS that no spawn ceiling moved.

**#289.** A reviewer was spawned with $0.43, died before reading the diff, and its
`verdict: error` left the story in `review` and blocked its dependents. `REVIEWER_FLOOR_USD`
($1.00) already existed — and was itself the fix for an earlier failure of this shape — but
the floor yields to whatever is left in the stage, so a nearly-exhausted stage spawns a
reviewer that cannot work. The fix is not a bigger floor: it is deciding not to spawn.
The refusal happens BEFORE the spawn — no `agent.spawned`, no task row, $0 — and records
`verdict: "n-a"`, which already meant "no reviewer ran", instead of an opinion the reviewer
never formed. A death by budget is not a verdict (§7), the same shape as #271 and #277
rather than a third invention.

## Measured, not asserted

- **`reviewerCap`'s arithmetic is byte-identical** — diffed, only a comment added. The
  refusal is a new predicate over the same remainder, not a second copy of the number, which
  matters because that arithmetic is mirrored in `budget/remainingWork.ts` (§7).
- **One predicate, not four that agree**: `reviewStillOwed` is what the requeue rule, the
  ledger, `resumableReview` and the retro all call.
- **The refusal costs nothing**: asserted in the test by an empty `spawned` array and
  `reviewerCost === 0`, and confirmed by reading `refuseUnfundedReview`.
- **The new sentence cannot overstate**: "no spawn ceiling moved" prints only when no stage
  was named; a stage raise prints a different line.
- **Four mutations**, each reddening its own cases: the floor predicate flipped, the verdict
  swapped back to `error`, the stage write made a no-op, and the new sentence dropped. The
  implementer reported that its FIRST attempt at that last one stayed green because it left
  `--stage` in the string — a bad mutation it caught and redid, and the reviewer re-ran the
  corrected one.
- 0.20.0 byte-identical; one `### Fixed` under `## 0.21.0 — unreleased`; no README row;
  public-surface test green; EN/ES compared by content; no golden moved.

## The field evidence, chased rather than accepted

The implementer declared that #289's field figure of $0.43 does not reconstruct from the
numbers quoted in the issue (21.60 − 10.64 ⇒ a $1.00 floor), and reproduced the MECHANISM at
its own numbers instead of the field case. The reviewer independently confirmed the
inconsistency. That mattered: if $0.43 came from a different path, this fix would be closing
the issue with the wrong explanation.

Resolved with the peer session's own run records: the issue had miscited the figure. The
stage `budget_usd` was **10.80**, not 21.60 — the 21.60 was the phase ceiling, a different
knob. And the developer's `agent.result` carrying `cost_usd: 10.64` was written 55 seconds
AFTER the reviewer was spawned, so the remainder the floor actually saw was 10.80 − 10.37 =
**0.43**. The mechanism is the one fixed here. Confirmed from the other side too: with the
stage raised to 60, subsequent reviewers spawned at exactly the $1.00 floor.

## Known limits, named rather than absorbed

- **`economy: host-tokens` is not measured.** The refusal reads dollars, and a host-tokens
  stage still carries a `budget_usd`. The reviewer's code reading says this is the
  pre-existing floor's behaviour rather than something this change introduces, and the peer
  has no run in that economy today, so there is no evidence to file on. It stays a known
  limit until someone runs one.
- **Spend accounting lags the spawn decision** — visible in the resolution above: the
  reviewer's ceiling was decided against a spend figure that was still 55 seconds from being
  complete. It did not matter here (there was no money either way), and it is not filed
  because there is no case where it bites. It is the first mechanism to suspect if a spawn
  ceiling ever fails to square with what was spent.

## An instrument note, so nobody files it as a defect

The reviewer reported `test/build-executor.test.ts`'s "an epic worktree on the WRONG branch
is refused by name" as a pre-existing failure reproducing on `main`. It is not a defect: that
case fails when `$TMPDIR` is long, because the assertion reads a path the message truncates.
It was measured today by another implementer and is green under a short TMPDIR. It reproduced
on `main` because the same long TMPDIR was used for both runs — the instrument, not the tree.
