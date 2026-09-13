verdict: merge
reviewed-by: a separate sonnet reviewer sub-agent (two passes, it did not write the code); the prose deltas below verified by tldr-experts-6d, Claude Opus 5
against: c8a01cd

## What was reviewed

Two passes. The first read `b3e5fbf` (pre-rebase) and returned `merge` with two
hardenings marked optional; I made both mandatory, because the first of them was
this issue's own bug one level down: a ruleset in `evaluate` mode counted as a
requirement would have armed `--auto` and recorded "merges when its required
checks pass" over a rule that blocks nothing.

The second pass read `ff75481` (rebased onto `b605b4a`) as a delta plus rebase
check, and returned `merge`.

## What the reviewer measured, not asserted

- **Mutation isolation, run.** Each hardening broken alone reddens ONLY its own
  test (29/30 both times), no cross-over; file restored, `git status --porcelain`
  empty afterwards.
- **The `enforcement` question, adjudicated against the live REST documentation.**
  My instruction to the implementer was wrong and both the implementer and the
  reviewer said so with the source: GitHub does not return rules whose ruleset is
  `evaluate` or `disabled`, and the returned element carries no `enforcement`
  field, so "absent ⇒ could not tell" would have armed nothing in every real
  repository. What shipped — only a non-`active` value that actually arrives is
  discounted — is the correct reading.
- **Direction of every error path.** Rulesets: any non-zero exit is `unreadable`.
  Protection: only a 404 whose parsed body is `Branch not protected` means "none";
  every other 404 (branch gone, repo gone) is `unreadable`. Both land in the
  direction that arms NOTHING.
- **Rebase.** `b605b4a` is an ancestor; the peer's `### Added` bullet byte-identical
  at that point; no conflict markers.

## The prose deltas, and my own hand in them

A shipped document describing a fixed bug as live is a record lying (§7), so the
branch also carries the correction. The reviewer's whole-tree sweep named exactly
two surviving lines, both in `docs/guide/10-unattended-mode.md`; the peer session
owns `docs/` and ceded those files for this branch so behaviour and documentation
land in one merge instead of leaving a window where `main` says one thing and does
another.

I then found one the sweep's pattern did not cover and **I wrote that commit
myself** (`c8a01cd`): the peer's `### Added` bullet in this same 0.18.2 section
said the guide documents that `--ship merge` "merges at once" — true when written,
false in the release it ships in, contradicting the `### Fixed` bullet directly
below it. It is a parenthetical, it is someone else's bullet, and the peer is told
verbatim what changed.

So this record is not a pure outside verdict: I authored prose on the branch I am
recording. The code — every line of `ship.ts`, `shipPolicy.ts` and the tests — was
written by the implementer and read by a reviewer that touched neither.

## Not blocking, on the record

- A ruleset-derived `required_status_checks` has never been parsed against a real
  repository that has one; that shape comes from the REST schema and a fake
  transport. Named in the commit.
- Merge queues and organization policies the token cannot read are invisible to
  both probes. The gap is one-directional by design: an unseen requirement reads
  as "requires nothing" and therefore arms nothing — it can only cost a merge that
  was not armed, never cause one that should not have happened.
