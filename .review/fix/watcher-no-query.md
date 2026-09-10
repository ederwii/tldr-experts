verdict: merge
reviewed-by: fresh reviewer sub-agent, claude-sonnet-5, dispatched by session tldr-experts-4a
against: e3ecffc

## Round 1 (7437a54 vs base 404e8f4)

`bun run typecheck` exit 0. `bun test test/watch.test.ts test/watch-checklist.test.ts
test/watch-cli.test.ts test/watch-arm.test.ts` — 83 pass, 0 fail, exit 0.

No-src and unresolvable-src cases for `Query: none` measured directly (probes against a
real filesystem, not just the fixture's `/nowhere` root): a `[src: file:...]` to a
non-existent file is refused (`no such file: …`); `absent:` to a non-existent path
resolves `ok` (correct — that is the literal-absence case). `cardQuery`/`fenceLang`
cleanly deleted, no stale importer or test (grep). One renderer `renderCardQuery()`
used by checklist/`watch check`/`watch arm`. `watch check --execute` exits 0, prints
the reason, runs nothing; `watch arm` still arms and polls only `gh --version`/`gh pr
view` — no scheduler grew. Handoff's `**unobservable**` bullet cites `[src: <card
path>:1]`, which resolves; its own test runs `validateHandoff(...).ok === true`.
Docs/spec/CHANGELOG/docs-site EN+ES in lockstep.

**Important, CONFIRMED** — `watcherFile.ts`'s `Query`/`none` branch checked only that
the reason's `[src: …]` token *resolved*, never that the ref was `kind: "absent"` or
that `## Signal` was itself absent. Measured: a card with a live, resolvable `## Signal`
(`decidedStatus: "verified"`) plus `Query: none — could not be bothered to work it out
[src: api:src/Leaderboard.cs:3]` — citing the SAME emitting file, not an `absent:` ref —
validated cleanly (`ok: true`). This contradicted the feature's own stated intent
(`watchPrompt.ts`: "not a shortcut for a query you could not be bothered to work out"),
enforced only in prose. Verdict at that point: do not merge; fix listed precisely.

## Round 2 (7437a54 → e3ecffc)

Fix: the `none` branch now refuses unless `absentSignals.length > 0` AND every ref in
`query.src.refs` is `kind: "absent"` (`watcherFile.ts`, `QUERY_NONE_NOT_EARNED_ISSUE`).
Replayed the exact Important probe live against e3ecffc:

```
issues on Query: [{ path: "Query", kind: "shape",
  message: "`Query: none` is only for a card whose `## Signal` is itself `absent:` —
  this one names a real signal" }]
overall ok: false
```

Refused, as required. Two new RED tests in `test/watch.test.ts` cover both halves
(live Signal + `none`; `none` sourced to a real line instead of `absent:`) and both
match the probe scenario. Three fixtures (`watch-arm`, `watch-checklist`, `watch-cli`)
corrected to fixture the earned case (Signal `absent:`, status `draft`, `none` sourced
to the same `absent:` target) rather than the no-longer-valid shortcut shape.
`QUERY_NONE_NOT_EARNED_ISSUE` exported from `index.ts`. `watchPrompt.ts`, `templates/
watcher.md`, `docs/spec.md` and `CHANGELOG.md` all updated to say the rule is checked,
not advised.

`bun run typecheck` exit 0. `bun test test/watch.test.ts test/watch-checklist.test.ts
test/watch-cli.test.ts test/watch-arm.test.ts` — 85 pass, 0 fail, exit 0 (two more than
round 1, matching the two new tests).

Minor, not blocking: when the `none` reason's token has a parse error (e.g. an empty
token) rather than zero non-absent refs, both the parse-error issue and
`QUERY_NONE_NOT_EARNED_ISSUE` fire on the same line — redundant but not incorrect (the
card is refused either way). Not worth a fix-now.

No other findings. Merge.
