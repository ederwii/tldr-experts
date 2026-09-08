verdict: pending review
reviewed-by: not yet reviewed
against: not yet reviewed

# fix/192-review-record — the branch that adds this gate

This branch WAS reviewed once, verdict `merge` with no findings over two passes, against
`9fb3dde` on the pre-rebase history. That record no longer stands, and it was withdrawn by hand
rather than carried forward: `origin/main` moved to `5a0f922` (#182 and #154 landed), the branch
was rebased onto it, and a rebase rewrites every commit — so `9fb3dde` is no longer an ancestor
of the head, and the ancestry half of this gate's own staleness check refuses it. Merging `main`
in instead would not have helped: that brings code in AFTER the review, which the moved-code half
refuses.

That is the rule working on its first real use, not a problem to engineer around. A stale verdict
left standing over a rebased diff is an audit record lying in the dangerous direction
(`AGENTS.md` §7) — and it would have been this gate's own first record doing it. **A rebase
costs a re-review.** If that proves too expensive in practice it is a design conversation for a
follow-up issue, not a reason to weaken the check now.

So the three lines above are the reviewer's to supply again, over the rebased diff. Until they
say `verdict: merge` with a sha whose code was actually read, `scripts/merge-wave.sh` refuses
this branch with exit 10 — the change dogfooding itself, twice.

When the fresh review lands, the first three lines become:

    verdict: merge
    reviewed-by: <the reviewing agent and its model>
    against: <the sha the reviewer read>

committed on this branch as its own last commit. That commit moves the head past the sha it
names, which is exactly the case the staleness rule is measured to allow — an ancestor sha with
no path outside `.review/` changed since — rather than a literal "the named sha equals the head",
which a self-referential record can never satisfy.
