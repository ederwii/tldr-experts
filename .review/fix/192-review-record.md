verdict: merge
reviewed-by: a fresh sub-agent that did not write this code, mid-tier model
against: bcbb696

# fix/192-review-record — the review record for the branch that adds the gate

Three passes, one reviewer, none of this code written by it. What was executed and what was
carried forward is spelled out below, because a record that blurs the two is worth less than no
record at all.

1. `6778fcf` — the gate itself. **Executed**: all four staleness attacks (code and record in one
   commit, `commit --amend`, `rebase -i edit` of the reviewed commit, `merge --no-ff` from main)
   and both force-push cases. Every one refused. The red-first was re-derived independently: the
   new `#192` block run against the OLD script fails 5 genuinely.
2. `6778fcf..9fb3dde` — the exit code moving from 2 to 10. **Executed**: the mutation, by the
   reviewer's own hand — `exit 10` -> `exit 2` on one line gives `expected exit 10, got 2`,
   `0 pass · 1 fail`, so the assertion pins the code rather than standing in for "non-zero". It
   re-derived that the merge-conflict `exit 2` is byte-identical to `6778fcf`, and that `10` was
   free on `origin/main` by its own `git cat-file blob` check.
3. `origin/main...bcbb696` — the rebase onto `5a0f922`. **Not a re-run of pass 1; carried
   forward, on a stated basis**: the reviewer diffed the branch's own three-dot content before
   and after (`93c916e...9fb3dde` against `origin/main...fix/192-review-record`) and found only
   `.review/fix/192-review-record.md` and `CHANGELOG.md` differ — the gate logic in
   `scripts/merge-wave.sh` and `test/merge-wave.test.ts` is **byte-identical**. The six attack
   scenarios therefore describe the same bytes they were run against. What it DID execute here:
   reading the CHANGELOG union (single `## 0.13.0`, one `### Added`, one `### Fixed`, no
   conflict markers, this bullet appended after #154's, and everything from `## 0.12.0` down
   byte-identical to `origin/main` — no released section altered), and both suites in the
   foreground: `bcbb696` 4196 pass / 0 fail / 156 files, `5a0f922` 4188 / 0 / 156, both exit 0.

**Findings: none, in any pass.**

It also caught a number: an earlier report of this branch said `git diff --name-only 93c916e
origin/main` was 34 paths. Re-measured with `wc -l`, it is **37** — the first figure was counted
off terminal output rather than measured, which is the error, not the arithmetic. The conclusion
is unchanged and re-measured here: zero of those 37 paths is `scripts/merge-wave.sh`, its test,
`AGENTS.md`, `CONTRIBUTING.md` or the maintain skill.

## A rebase costs a re-review, and this branch is the worked example

This record is the second one written for this branch. The first said `merge` against `9fb3dde`,
and it was withdrawn by hand when `origin/main` moved to `5a0f922` and the branch rebased onto
it: a rebase rewrites every commit, so `9fb3dde` stopped being an ancestor of the head and this
gate's own ancestry check refused its own record. Merging `main` in instead would have failed the
other half, which refuses code brought in after the review. Repointing the old verdict at the new
head would have been an audit record lying in the dangerous direction (`AGENTS.md` §7) — the gate
asserting a review of bytes nobody read. So it went back to `pending review` until this pass.

That is the rule working on its first real use, at a price worth naming: **a rebase costs a
re-review.** If that proves too expensive in practice it is a design conversation for a follow-up
issue, not a reason to weaken the check now.

Committing this record moves the head past `bcbb696`, the sha it names, and the only path that
changes is inside `.review/` — exactly the case the staleness rule is measured to allow, rather
than a literal "the named sha equals the head", which a self-referential record can never satisfy.
