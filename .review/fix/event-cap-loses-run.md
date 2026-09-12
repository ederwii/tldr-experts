verdict: merge
reviewed-by: Claude Sonnet 5 (fresh pre-merge reviewer)
against: efb4b2f

Content reviewed in full against 4fef332 (four appends, the half-truth risk on
`outputs`, the exit-code family, the claim-persistence class, the golden and
the payload-cap tests). This pass covers ONLY the rebase delta after main
picked up #247 (f609176) and the branch was rebased on top:

- `git diff 4fef332 efb4b2f` restricted to the #248-owned files
  (Event.ts, runNext.ts, payload-cap.test.ts, fakeClaude.ts) is byte-identical
  patch content; the only difference anywhere is the base commit and one
  removed sentence in the commit MESSAGE ("#160 stays OPEN…"). No new code
  rode in on the rebase.
- CHANGELOG.md: exactly one `## 0.18.0 — unreleased`, exactly one `### Fixed`
  under it, 2 bullets (#247 then #248), zero conflict markers (grep for
  `<<<<<<<`/`=======`/`>>>>>>>` across CHANGELOG.md and docs/spec.md: no
  matches).
- docs/spec.md auto-merge: the two edits are in disjoint regions and both are
  present exactly once, intact, non-contradictory — #247's "The release is
  decided by conditions, never by status" at line ~2221 (its own event,
  `gate.requested` notification timing) and #248's `outputs_omitted` /
  `outputs_omitted_reason` table row plus the updated "refused whole"
  paragraph at ~1465-1482 (a different event, `agent.result`'s payload cap).
  Confirmed both against `git diff a61b166 afef5ff -- docs/spec.md` (#247's
  own change) and `git diff f609176 efb4b2f -- docs/spec.md` (#248's change
  applied on top of post-#247 main) — no overlap, nothing orphaned.
- Golden fixture: `git diff --stat f609176 HEAD -- test/fixtures/build/golden`
  → empty, exit 0.

Ran (own lines, exit codes captured directly):
- bun run typecheck → exit 0
- bun test test/payload-cap.test.ts test/build-golden.test.ts → 22 pass, 0
  fail, exit 0
