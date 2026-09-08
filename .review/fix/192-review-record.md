verdict: pending review
reviewed-by: not yet reviewed
against: not yet reviewed

# fix/192-review-record — the branch that adds this gate

This file is the branch's own review record, in the shape `scripts/merge-wave.sh` now asserts
(`AGENTS.md` §2). It is deliberately NOT mergeable as it stands: the verdict, the reviewer and
the sha they read are the reviewer's to supply, and until they are written here the wave refuses
this branch with exit 10 — which is the change dogfooding itself.

When the review lands, the first three lines become:

    verdict: merge
    reviewed-by: <the reviewing agent and its model>
    against: <the sha the reviewer read>

committed on this branch as its own last commit. That commit moves the head past the sha it
names, which is exactly why the gate measures staleness as "no path outside `.review/` changed
since", not as "the named sha equals the head".
